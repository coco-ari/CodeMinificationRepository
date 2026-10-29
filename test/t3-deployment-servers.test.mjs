import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RepositoryService } from '../src/service.mjs'
import { DeploymentService } from '../src/deployment.mjs'
import { createDeploymentServers, deploymentServerDto } from '../agent-demo/t3-adapters/deployment-servers.mjs'

const mutation = (input) => ({ ...input, requestId: randomUUID(), actor: { id: 'isolated-admin' } })
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 't3-server-adapter-'))
  const repository = new RepositoryService({ directory, builder: { initialize: async () => {}, build: async () => assert.fail('隔离测试不能构建远程源码') } })
  await repository.initialize()
  const deployment = new DeploymentService(repository, { publicOrigin: 'https://deploy.example.invalid' })
  await deployment.initialize(); await deployment.projects.initialize()
  for (const id of ['p-one', 'p-other']) await deployment.projects.ensureProject({ id, name: id, environments: [{ id: 'env-test', name: '测试' }] })
  t.after(async () => { await deployment.close(); await repository.store.close(); await rm(directory, { recursive: true, force: true }) })
  return { deployment, servers: createDeploymentServers({ deployment }) }
}

test('旧项目节点登记只能恢复原收据，共享绑定仍须明确项目准入', async (t) => {
  const { servers, deployment } = await fixture(t), input = mutation({ name: '共享节点', environmentId: 'env-test' })
  await assert.rejects(servers.createServer('p-one', input), {status:410,code:'DEPLOYMENT_NODE_ROUTE_RETIRED'})
  const created = await deployment.projects.createServer('p-one', input)
  assert.equal(deployment.projects.globalNodeCatalog(mutation({})).projectAccess.find(entry => entry.projectId === 'p-one').revision, 2)
  assert.match(created.installCommand, /curl -fsS --proto '=https' --tlsv1\.2 'https:\/\/deploy\.example\.invalid\/agent\/install\.sh'/)
  assert.equal(typeof created.registrationToken, 'string')
  const repeated = await servers.createServer('p-one', input)
  assert.equal(repeated.server.id, created.server.id)
  assert.equal(repeated.registrationToken, null)
  assert.equal(repeated.installCommand, undefined)
  assert.equal(deployment.projects.globalNodeCatalog(mutation({})).projectAccess.find(entry => entry.projectId === 'p-one').revision, 2)
  assert.equal(servers.availableServers('p-one').length, 1)
  assert.throws(() => servers.server('p-other', created.server.id), { status: 404 })
  await deployment.projects.setServerAccess('p-other', mutation({ serverId: created.server.id, allowed: true, expectedRevision: 1 }))
  const binding = mutation({ serverId: created.server.id, environmentId: 'env-test' })
  assert.equal((await servers.bindServer('p-other', binding)).id, created.server.id)
  assert.equal((await servers.bindServer('p-other', binding)).id, created.server.id)
  await servers.unbindServer('p-other', mutation(binding))
  assert.throws(() => servers.server('p-other', created.server.id), { status: 404 })
  assert.equal(servers.server('p-one', created.server.id).id, created.server.id)
})

test('项目全局操作只保留已接受收据，不接受新存储策略、撤销和删除', async (t) => {
  const { servers, deployment } = await fixture(t), { server } = await deployment.projects.createServer('p-one', mutation({ name: '隔离节点', environmentId: 'env-test' }))
  for (const operation of [() => servers.revokeServer('p-other', server.id, mutation({})), () => servers.deleteServer('p-other', server.id, mutation({})), () => servers.saveStoragePolicy('p-other', server.id, mutation({ expectedRevision: 1, retainedVersions: 3, buildCacheGiB: 4 }))]) await assert.rejects(operation, { status: 410 })
  await assert.rejects(deployment.projects.deleteServer('p-one', server.id, mutation({})), { status: 409 })
  const policy = mutation({ expectedRevision: 1, retainedVersions: 3, buildCacheGiB: 4 })
  await assert.rejects(servers.saveStoragePolicy('p-one', server.id, policy), {status:410})
  const updated = deploymentServerDto(await deployment.projects.saveStoragePolicy('p-one', server.id, policy))
  assert.deepEqual(updated.storagePolicy, { revision: 2, retainedVersions: 3, buildCacheGiB: 4 })
  assert.deepEqual(await servers.saveStoragePolicy('p-one', server.id, policy), updated)
  await assert.rejects(servers.saveStoragePolicy('p-one', server.id, mutation({ ...policy, retainedVersions: 4 })), { status: 410 })
  await assert.rejects(servers.saveStoragePolicy('p-one', server.id, { ...policy, retainedVersions: 4 }), { status: 409 })
  const revoke = mutation({}), remove = mutation({})
  await assert.rejects(servers.revokeServer('p-one', server.id, revoke), {status:410})
  await deployment.projects.revokeServer('p-one', server.id, revoke)
  await servers.revokeServer('p-one', server.id, revoke)
  assert.equal(servers.server('p-one', server.id).revoked, true)
  await assert.rejects(servers.deleteServer('p-one', server.id, remove), {status:410})
  await deployment.projects.deleteServer('p-one', server.id, remove)
  assert.deepEqual(await servers.deleteServer('p-one', server.id, remove), { ok: true })
  await assert.rejects(servers.deleteServer('p-one', server.id, { ...remove, actor: { id: 'other-admin' } }), { status: 409 })
  assert.equal(servers.availableServers('p-one').length, 0)
})

test('节点快照保留主机指标，但不透出其他项目、任务、容器或存储报告明细', () => {
  const secret = '不属于当前项目', time = '2026-10-25T00:00:00.000Z'
  const dto = deploymentServerDto({ id: 's-one', name: '共享节点', online: true, lastSeenAt: time, registeredAt: time, capabilities: ['storage-policy-v1'], tokenHash: secret, activeTaskId: secret, containers: [{ name: secret }], metrics: { cpuPercent: 12, memory: { used: 1, total: 4, secret }, disk: { used: 2, total: 8 }, centerRttMs: 25, secret }, storagePolicy: { revision: 2, retainedVersions: 3, buildCacheGiB: 4, secret }, storageState: 'failed', storageStatus: { revision: 2, state: 'failed', checkedAt: time, targets: [{ targetId: secret }], errors: [secret], cache: { bytes: 1, limitBytes: 2, reclaimedBytes: 3, withinLimit: true, builder: secret } } }, 'env-test')
  assert.equal(dto.metrics.centerRttMs, 25)
  assert.equal(dto.metrics.cpuPercent, 12)
  assert.equal(dto.lastSeenAt, time)
  assert.equal(dto.storageStatus.state, 'failed')
  assert.equal(dto.storageStatus.cache.reclaimedBytes, 3)
  assert.doesNotMatch(JSON.stringify(dto), /不属于当前项目|tokenHash|activeTaskId|containers|targetId|builder/)
  const invalid = deploymentServerDto({ id: 's', name: '节点', metrics: { cpuPercent: NaN, memory: { used: -1, total: Infinity }, centerRttMs: '1' }, storageState: 'invented' })
  assert.equal(invalid.metrics.cpuPercent, null)
  assert.deepEqual(invalid.metrics.memory, { used: null, total: null })
  assert.equal(invalid.storageState, 'unsupported')
})
