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
    availableServers: () => [{ id: 'global-server' }],
    releaseSource: async () => file,
  }
  const request = (suffix, method = 'GET', input) =>
    handleDeploymentRequest({
      access,
      store,
      principal,
      method,
      input,
      url: new URL(`http://localhost/autoops/projects/project/deployments${suffix}`),
    })
  return { user, member, principal, store, file, request }
}

test('项目管理者不能伪装平台管理员枚举或修改共享节点', async () => {
  const f = fixture()
  const result = await f.request('/servers?environmentId=test')
  assert.deepEqual(result.body, {
    servers: [{ id: 'bound-server' }],
    availableServers: [],
    canAdmin: false,
  })
  await assert.rejects(
    f.request('/servers/global-server/revoke', 'POST', { actor: { id: 'admin' } }),
    { status: 403, code: 'DEPLOYMENT_SERVER_ADMIN_REQUIRED' },
  )
  f.user.role = 'admin'
  assert.deepEqual((await f.request('/servers?environmentId=test')).body.availableServers, [
    { id: 'global-server' },
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
