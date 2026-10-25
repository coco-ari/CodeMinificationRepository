import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'

function fixture(t, role = 'developer') {
  const sessionDb = new DatabaseSync(':memory:'), bindingDb = new DatabaseSync(':memory:')
  t.after(() => { sessionDb.close(); bindingDb.close() })
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('role-session').digest('hex'), 'operator', 'csrf', Date.now() + 60_000)
  const member = { userId: 'operator', role, workspaceAccess: role === 'external' ? 'external' : 'internal', environmentIds: role === 'external' ? [] : ['test', 'production'], environmentRoles: {}, canAdjustChat: false, status: 'active' }
  const user = { id: 'operator', name: '当前调用者', kind: 'internal', role: 'member', status: 'active' }
  const project = { id: 'project', name: '项目', memberIds: ['operator'], memberships: [member], environments: [{ id: 'test', name: '同名' }, { id: 'production', name: '同名' }], resources: [], documents: [] }
  const catalog = { users: [user], projects: [project, { ...structuredClone(project), id: 'other', memberIds: [], memberships: [] }], agents: [{ id: 'helper', projectIds: ['project'] }] }
  const access = createAutoOpsAccess({ sessionDb, bindingDb, catalog, deploymentEnabled: () => true })
  const principal = access.authenticateCookie('demo_session=role-session')
  return { access, member, user, project, principal }
}

test('开发项目角色保留资料维护，测试运维不能拼接生产发布或反授项目管理', t => {
  const f = fixture(t)
  f.member.environmentRoles = { test: 'release_operator', production: 'reader' }
  f.access.requireWorkspaceActor('operator', 'project')
  f.access.requireDeploymentActor('operator', 'project', 'test')
  assert.throws(() => f.access.requireDeploymentActor('operator', 'project', 'production'), { code: 'DEPLOYMENT_ACTION_FORBIDDEN' })
  assert.throws(() => f.access.requireProjectAction(f.principal, 'project', 'project.members.manage'), { code: 'PROJECT_ACTION_FORBIDDEN' })
  assert.throws(() => f.access.requireCredentialActor('operator', 'project', 'credential.manage'), { code: 'PROJECT_ACTION_FORBIDDEN' })
  assert.throws(() => f.access.requireDeploymentAction(f.principal, 'other', 'publish', 'test'), { code: 'PROJECT_NOT_FOUND' })
})

test('环境显式只读覆盖项目运维，新增环境和角色调整不扩大原范围', t => {
  const f = fixture(t, 'release_operator')
  f.member.environmentRoles = { production: 'reader' }
  f.access.requireDeploymentActor('operator', 'project', 'test')
  assert.throws(() => f.access.requireDeploymentActor('operator', 'project', 'production'), { code: 'DEPLOYMENT_ACTION_FORBIDDEN' })
  assert.throws(() => f.access.requireWorkspaceActor('operator', 'project'), { code: 'WORKSPACE_MANAGEMENT_FORBIDDEN' })
  f.project.environments.push({ id: 'new', name: '新增' })
  assert.throws(() => f.access.requireEnvironment(f.principal, 'project', 'new'), { code: 'ENVIRONMENT_FORBIDDEN' })
  f.member.environmentRoles.test = 'reader'
  assert.throws(() => f.access.requireDeploymentActor('operator', 'project', 'test'), { code: 'DEPLOYMENT_ACTION_FORBIDDEN' })
})

test('环境运维仅维护该环境部署位置，不能修改跨环境服务、节点或源码保留', t => {
  const f = fixture(t, 'release_operator')
  f.access.requireDeploymentAction(f.principal, 'project', 'configure', 'test')
  for (const action of ['configure', 'service.configure', 'source.clear', 'server.create', 'server.bind', 'server.unbind', 'server.admin'])
    assert.throws(() => f.access.requireDeploymentAction(f.principal, 'project', action), { code: 'DEPLOYMENT_ACTION_FORBIDDEN' })
  f.access.requireDeploymentAction(f.principal, 'project', 'source.download', 'test')
})

test('只读与外部角色的能力由同一裁决生成，伪造调整权和环境覆盖不提权', t => {
  const f = fixture(t, 'reader')
  assert.equal(f.access.projectCapabilities(f.principal, 'project')['deployment.read'], true)
  assert.equal(f.access.projectCapabilities(f.principal, 'project')['deployment.execute'], false)
  assert.equal(f.access.projectCapabilities(f.principal, 'project')['chat.configure'], false)
  f.member.canAdjustChat = true
  f.access.requireProjectAction(f.principal, 'project', 'chat.configure')
  assert.throws(() => f.access.requireProjectAction(f.principal, 'project', 'project.manage'), { code: 'PROJECT_ACTION_FORBIDDEN' })
  f.member.environmentRoles = { test: 'project_admin' }
  assert.throws(() => f.access.requireMembership(f.principal, 'project'), { code: 'PROJECT_NOT_FOUND' })
})

test('外部账号不能通过内部角色或环境绑定获得内部数据', t => {
  const f = fixture(t, 'external')
  f.user.kind = 'external'
  assert.equal(f.access.projectCapabilities(f.principal, 'project')['deployment.read'], false)
  assert.throws(() => f.access.requireWorkspace(f.principal, 'project', 'internal'), { code: 'WORKSPACE_FORBIDDEN' })
  f.member.role = 'reader'
  assert.throws(() => f.access.requireMembership(f.principal, 'project'), { code: 'PROJECT_NOT_FOUND' })
})

test('待管理员分配的存量成员保留资料和问答，不启用新增部署与 MCP 授权', t => {
  const f = fixture(t, 'reader')
  f.member.authorizationPending = true
  f.access.requireWorkspaceReader('operator', 'project')
  f.access.requireProjectAction(f.principal, 'project', 'chat.use')
  assert.equal(f.access.projectCapabilities(f.principal, 'project')['deployment.read'], false)
  assert.throws(() => f.access.requireDeploymentAction(f.principal, 'project', 'read', 'test'), { code: 'AUTHORIZATION_PENDING' })
  assert.throws(() => f.access.requireEnvironmentQuery(f.principal, 'project', 'test'), { code: 'AUTHORIZATION_PENDING' })
})

test('无环境项目和外部成员可以保存及恢复问答，不自动绑定测试环境', t => {
  const f = fixture(t, 'external')
  const input = { projectId: 'project', environmentId: null, agentId: 'helper', workspaceType: 'external', visibility: 'private', threadId: 'no-environment' }
  const saved = f.access.reserveThread(f.principal, input)
  assert.equal(saved.environmentId, null)
  assert.equal(f.access.getThreadBinding(input.threadId).environmentId, null)
  assert.deepEqual(f.access.bootstrap(f.principal).projects[0].environments, [])
  assert.throws(() => f.access.reserveThread(f.principal, { ...input, threadId: 'forged', environmentId: 'test' }), { code: 'ENVIRONMENT_FORBIDDEN' })
  f.access.beginThreadSubmission(f.principal, input.threadId, 'original-command')
  assert.equal(f.access.beginThreadSubmission(f.principal, input.threadId, 'original-command').scopeState, 'submitting')
  f.access.finishThreadSubmission(input.threadId, 'original-command', true)
  assert.equal(f.access.requireThread(f.principal, input.threadId).environmentId, null)
})
