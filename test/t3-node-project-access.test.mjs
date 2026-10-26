import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RepositoryService } from '../src/service.mjs'
import { DeploymentService } from '../src/deployment.mjs'

const command = (value) => ({ ...value, requestId: randomUUID(), actor: { id: 'platform-admin' } })
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'autoops-node-access-'))
  const repository = new RepositoryService({
    directory: dataDir,
    builder: {
      initialize: async () => {},
      build: async () => assert.fail('节点授权测试不能构建源码'),
    },
  })
  await repository.initialize()
  const authorizations = []
  const deployment = new DeploymentService(repository, {
    authorizeProjectMutation(value) {
      authorizations.push(value)
      if (
        (value.projectId === null || ['server.create', 'server.admin'].includes(value.action)) &&
        value.actor?.id !== 'platform-admin'
      )
        throw Object.assign(new Error('需要平台节点管理权限'), { status: 403 })
    },
  })
  await deployment.initialize()
  await deployment.projects.initialize()
  for (const id of ['one', 'two'])
    await deployment.projects.ensureProject({
      id,
      name: id,
      environments: [{ id: 'test', name: '测试' }],
    })
  t.after(async () => {
    await deployment.close()
    await repository.store.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { repository, deployment, projects: deployment.projects, authorizations, dataDir }
}

test('全局节点独立登记且不自动分配，平台准入后项目管理员才能绑定', async (t) => {
  const f = await fixture(t),
    input = command({ name: '全局节点' })
  const created = await f.projects.createGlobalServer(input)
  assert.equal(typeof created.registrationToken, 'string')
  assert.equal((await f.projects.createGlobalServer(input)).registrationToken, null)
  assert.deepEqual(f.projects.availableServers('one'), [])
  assert.deepEqual(f.projects.snapshot('one').mapping.servers, [])
  const bind = command({ serverId: created.server.id, environmentId: 'test' })
  bind.actor.id = 'project-admin'
  await assert.rejects(f.projects.bindServer('one', bind), {
    status: 403,
    code: 'DEPLOYMENT_SERVER_ACCESS_REVOKED',
  })
  const grant = command({ serverId: created.server.id, allowed: true, expectedRevision: 1 })
  await f.projects.setServerAccess('one', grant)
  assert.deepEqual(await f.projects.setServerAccess('one', grant), {
    projectId: 'one',
    serverId: created.server.id,
    allowed: true, revision: 2,
  })
  assert.equal(f.projects.availableServers('one')[0].id, created.server.id)
  await assert.rejects(f.projects.setServerAccess('one', { ...grant, requestId: randomUUID(), allowed: false }), { status: 409, code: 'DEPLOYMENT_SERVER_ACCESS_CHANGED' })
  assert.equal(f.projects.availableServers('one')[0].id, created.server.id)
  assert.deepEqual(f.projects.availableServers('two'), [])
  assert.equal(
    (await f.projects.bindServer('one', { ...bind, requestId: randomUUID() })).id,
    created.server.id,
  )
  await assert.rejects(f.projects.bindServer('two', { ...bind, requestId: randomUUID() }), {
    status: 403,
  })
  await assert.rejects(
    f.projects.setServerAccess('two', {
      ...grant,
      requestId: randomUUID(),
      actor: { id: 'project-admin' },
    }),
    { status: 403 },
  )
  await assert.rejects(
    f.projects.createGlobalServer({
      ...input,
      requestId: randomUUID(),
      actor: { id: 'project-admin' },
    }),
    { status: 403 },
  )
  assert.throws(() => f.projects.globalNodeCatalog({ actor: { id: 'project-admin' } }), {
    status: 403,
  })
  const ledger = f.repository.store.state.autoopsDeploymentBindings.nodeMutationRequests
  assert(!JSON.stringify(ledger).includes(created.registrationToken))
})

test('准入撤回拒绝新绑定与后台领取，原绑定收据仍可核对，解绑不改变全局接入', async (t) => {
  const f = await fixture(t),
    created = await f.projects.createGlobalServer(command({ name: '可撤回准入' }))
  await f.projects.setServerAccess('one', command({ serverId: created.server.id, allowed: true, expectedRevision: 1 }))
  const input = command({ serverId: created.server.id, environmentId: 'test' })
  input.actor.id = 'project-admin'
  await f.projects.bindServer('one', input)
  await f.projects.setServerAccess('one', command({ serverId: created.server.id, allowed: false, expectedRevision: 2 }))
  assert.equal((await f.projects.bindServer('one', input)).id, created.server.id)
  await assert.rejects(f.projects.bindServer('one', { ...input, requestId: randomUUID() }), {
    status: 403,
  })
  assert.throws(() => f.projects.requireServerUse('one', created.server.id), { status: 403 })
  const map = f.projects.snapshot('one').mapping
  assert.throws(
    () =>
      f.projects.claimScope(
        {
          actor: { id: 'project-admin' },
          applicationId: map.applicationId,
          serverId: created.server.id,
        },
        {
          applicationId: map.applicationId,
          environmentId: map.environments[0].legacyEnvironmentId,
        },
      ),
    { status: 403 },
  )
  await f.projects.unbindServer('one', { ...input, requestId: randomUUID() })
  assert.equal(f.projects.globalNodeCatalog(command({})).servers[0].revoked, false)
})

test('全局删除沿用原收据保持同一事实，撤销和删除清理准入且不重建节点', async (t) => {
  const f = await fixture(t),
    created = await f.projects.createGlobalServer(command({ name: '删除验证' }))
  await f.projects.setServerAccess('one', command({ serverId: created.server.id, allowed: true, expectedRevision: 1 }))
  await assert.rejects(f.projects.mutateGlobalServer(created.server.id, 'delete', command({})), {
    status: 409,
  })
  await f.projects.mutateGlobalServer(created.server.id, 'revoke', command({}))
  const remove = command({})
  await f.projects.mutateGlobalServer(created.server.id, 'delete', remove)
  assert.deepEqual(await f.projects.mutateGlobalServer(created.server.id, 'delete', remove), {
    ok: true,
  })
  await f.projects.initialize()
  assert.deepEqual(f.projects.availableServers('one'), [])
  assert.deepEqual(f.projects.globalNodeCatalog(command({})).servers, [])
  assert.equal(f.projects.globalNodeCatalog(command({})).projectAccess.find(entry => entry.projectId === 'one').revision, 3)
  await assert.rejects(
    f.projects.mutateGlobalServer(created.server.id, 'delete', {
      ...remove,
      actor: { id: 'another-admin' },
    }),
    { status: 403 },
  )
})

test('存量节点准入升级只继承已有绑定，不扩大到其他项目或全局未绑定节点', async (t) => {
  const f = await fixture(t)
  const existing = await f.projects.createServer(
    'one',
    command({ name: '既有绑定', environmentId: 'test' }),
  )
  await f.projects.createGlobalServer(command({ name: '未分配节点' }))
  await f.repository.store.change((state) => {
    delete state.autoopsDeploymentBindings.nodeAccessVersion
    delete state.autoopsDeploymentBindings.nodeMutationRequests
    for (const map of state.autoopsDeploymentBindings.projects) { delete map.allowedServerIds; delete map.nodeAccessRevision }
  })
  await f.projects.initialize()
  const first = structuredClone(f.repository.store.state.autoopsDeploymentBindings)
  assert.deepEqual(
    f.projects.availableServers('one').map((server) => server.id),
    [existing.server.id],
  )
  assert.deepEqual(f.projects.availableServers('two'), [])
  assert.equal(f.projects.snapshot('one').mapping.servers[0].serverId, existing.server.id)
  await f.projects.initialize()
  assert.deepEqual(f.repository.store.state.autoopsDeploymentBindings, first)
})

test('缺少版本或未知版本的节点准入拒绝初始化，不覆盖已存授权与收据', async (t) => {
  const f = await fixture(t)
  const created = await f.projects.createGlobalServer(command({ name: '不能覆盖的节点' }))
  await f.projects.setServerAccess('one', command({ serverId: created.server.id, allowed: true, expectedRevision: 1 }))
  for (const version of [undefined, 99]) {
    await f.repository.store.change((state) => {
      if (version === undefined) delete state.autoopsDeploymentBindings.nodeAccessVersion
      else state.autoopsDeploymentBindings.nodeAccessVersion = version
    })
    const previous = structuredClone(f.repository.store.state.autoopsDeploymentBindings)
    await assert.rejects(f.projects.initialize(), /节点准入/)
    assert.deepEqual(f.repository.store.state.autoopsDeploymentBindings, previous)
  }
})
