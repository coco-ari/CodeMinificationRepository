import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectAccess } from '../agent-demo/t3-adapters/project-access.mjs'
import { handleDeploymentRequest } from '../agent-demo/t3-adapters/deployment-http.mjs'

function fixture() {
  const member = {
    userId: 'manager',
    workspaceAccess: 'internal',
    role: 'project_admin',
    environmentIds: ['test'],
    status: 'active',
  }
  const project = {
    id: 'project',
    memberIds: ['manager'],
    memberships: [member],
    environments: [{ id: 'test' }, { id: 'production' }],
  }
  const user = { id: 'manager', role: 'member', status: 'active' }
  const catalog = { projects: [project], users: [user] }
  const fail = (status, code, message) => {
    throw Object.assign(new Error(message), { status, code })
  }
  const policy = createProjectAccess({ catalog, fail, deploymentEnabled: () => true })
  const principal = { id: user.id, displayName: '项目管理者', role: 'admin' }
  const access = {
    requireProject(actor, id) {
      policy.membershipForUser(actor.id, id)
      return project
    },
    requireWorkspaceManager(actor, id) {
      return policy.requireWorkspaceManagerForUser(actor.id, id)
    },
    requireEnvironment(actor, id, environmentId) {
      return policy.requireDeploymentAction(actor.id, id, 'read', environmentId)
    },
    requireDeploymentAction(actor, id, action, environmentId) {
      return policy.requireDeploymentAction(actor.id, id, action, environmentId)
    },
  }
  const file = { bytes: Buffer.from('固定源码档案'), name: 'source.zip', mime: 'application/zip' }
  const store = {
    ensureProject: async () => {},
    targetScope: () => ({ environmentId: 'test' }),
    overview: () => ({ servers: [{ id: 'bound-server' }] }),
    availableServers: projectId => { assert.equal(projectId, 'project'); return [{ id: 'approved-server' }] },
    releaseSource: async () => file,
  }
  const request = (suffix, method = 'GET', input) =>
    handleDeploymentRequest({
      access,
      store,
      principal,
      method,
      input,
      url: new URL(suffix.startsWith('/api/v1/') ? `http://localhost${suffix}` : `http://localhost/autoops/projects/project/deployments${suffix}`),
    })
  return { user, member, principal, store, file, request }
}

test('项目管理者只列本项目准入节点，不能伪装平台管理员管理全局节点', async () => {
  const f = fixture()
  const result = await f.request('/servers?environmentId=test')
  assert.deepEqual(result.body, {
    servers: [{ id: 'bound-server' }],
    availableServers: [{ id: 'approved-server' }],
    canAdmin: false,
    canBind: true,
  })
  await assert.rejects(
    f.request('/servers/global-server/revoke', 'POST', { actor: { id: 'admin' } }),
    { status: 403, code: 'DEPLOYMENT_SERVER_ADMIN_REQUIRED' },
  )
  f.user.role = 'admin'
  const platformProjectNodes = (await f.request('/servers?environmentId=test')).body
  assert.equal(platformProjectNodes.canAdmin, false)
  assert.deepEqual(platformProjectNodes.availableServers, [
    { id: 'approved-server' },
  ])
  f.user.role = 'member'
  f.member.role = 'reader'
  await assert.rejects(f.request('/servers?environmentId=production'), {
    status: 403,
    code: 'ENVIRONMENT_FORBIDDEN',
  })
})

test('源码下载传输固定档案，异步读取期间撤权不返回文件或元数据', async () => {
  const f = fixture(),
    path = '/targets/target/releases/release/source'
  f.member.role = 'release_operator'
  assert.deepEqual((await f.request(path)).file, f.file)
  assert.deepEqual((await f.request(`${path}?metadata=1`)).body, {
    name: f.file.name,
    size: f.file.bytes.length,
  })
  f.store.releaseSource = async () => {
    f.member.environmentIds = []
    return f.file
  }
  await assert.rejects(f.request(path), { status: 403, code: 'ENVIRONMENT_FORBIDDEN' })
  f.member.environmentIds = ['test']
  await assert.rejects(f.request(`${path}?metadata=1`), {
    status: 403,
    code: 'ENVIRONMENT_FORBIDDEN',
  })
})

test('历史清理使用当前可信操作者与目标环境，伪造正文不能改变归属', async () => {
  const f = fixture()
  let persisted
  f.store.clearReleaseSource = async (projectId, targetId, releaseId, input) => {
    persisted = { projectId, targetId, releaseId, input }
    return { ok: true }
  }
  const path = '/targets/target/releases/release/source'
  assert.equal(
    (await f.request(path, 'DELETE', { requestId: 'original-request', actor: { id: 'attacker' } }))
      .status,
    200,
  )
  assert.deepEqual(persisted, {
    projectId: 'project',
    targetId: 'target',
    releaseId: 'release',
    input: { requestId: 'original-request', actor: { id: 'manager', displayName: '项目管理者' } },
  })
  f.member.status = 'disabled'
  await assert.rejects(f.request(path, 'DELETE', { requestId: 'original-request' }), {
    status: 404,
    code: 'PROJECT_NOT_FOUND',
  })
})

test('原请求查询按原动作和环境重新授权，未知结果不冒充失败', async () => {
  const f = fixture()
  f.member.role = 'release_operator'
  f.store.requestReceipt = (projectId, id, actor) => {
    assert.equal(projectId, 'project'); assert.equal(actor.id, 'manager')
    return { requestId: id, state: 'accepted', action: 'publish', operation: 'task', environmentId: 'test', actorId: 'manager', result: { task: { id: 'original-task' } } }
  }
  const path = '/api/v1/projects/project/deployments/requests/original-request'
  const result = (await f.request(path)).body
  assert.equal(result.state, 'accepted')
  assert.equal(result.result.task.id, 'original-task')
  assert.equal(result.action, undefined); assert.equal(result.actorId, undefined)
  f.member.role = 'reader'
  await assert.rejects(f.request(path), { status: 403 })
  f.store.requestReceipt = (_project, requestId) => ({ requestId, state: 'not_observed' })
  assert.deepEqual((await f.request(path)).body, { requestId: 'original-request', state: 'not_observed' })
})

test('环境移除入口校验配置权限并覆盖伪造操作人，不授予共享服务管理权', async () => {
  const f = fixture()
  f.member.role = 'release_operator'
  let writes = 0
  f.store.removeEnvironmentService = async (projectId, serviceId, environmentId, input) => {
    writes++; assert.equal(projectId, 'project'); assert.equal(serviceId, 'service'); assert.equal(environmentId, 'test')
    assert.deepEqual(input.actor, { id: 'manager', displayName: '项目管理者' })
    return { deleted: true, id: serviceId, environmentId }
  }
  const path = '/api/v1/projects/project/environments/test/deployment-services/service'
  assert.equal((await f.request(path, 'DELETE', { requestId: 'original', configKey: 'key', actor: { id: 'admin' } })).status, 200)
  f.member.role = 'reader'
  await assert.rejects(f.request(path, 'DELETE', {}), { status: 403 })
  assert.equal(writes, 1)
  f.member.role = 'release_operator'
  await assert.rejects(f.request('/services', 'POST', { name: '伪造共享服务' }), { status: 403 })
})
