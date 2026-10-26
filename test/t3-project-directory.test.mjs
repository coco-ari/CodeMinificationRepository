import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'
import { createProjectDirectory } from '../agent-demo/t3-adapters/project-directory/index.ts'

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'project-directory-'))
  const sessionDb = new DatabaseSync(':memory:'), bindingDb = new DatabaseSync(':memory:')
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  const users = [{ id: 'admin', name: '管理员', role: 'admin' }, { id: 'creator', name: '内部成员', role: 'member' }, { id: 'member', name: '待分配成员', role: 'member' }, { id: 'outside', name: '外部成员', role: 'member', kind: 'external' }]
  const seed = { users, agents: [], projects: [{ id: 'existing', name: '存量项目', memberIds: ['creator', 'member'], documents: [], resources: [], environments: [{ id: 'test', name: '测试' }, { id: 'production', name: '生产' }], memberships: [
    { userId: 'creator', role: 'project_admin', status: 'active', environmentIds: [], canAdjustChat: true },
    { userId: 'member', role: 'reader', status: 'active', environmentIds: ['test'], canAdjustChat: true, authorizationPending: true },
  ] }] }
  let access, directory
  const open = () => {
    directory = createProjectDirectory({ dataDir, seed, authorize: (...args) => access.requireProjectActionForActor(...args) })
    access = createAutoOpsAccess({ sessionDb, bindingDb, catalog: directory.catalog, deploymentEnabled: () => true })
    return { directory, access }
  }
  open()
  t.after(() => { directory.close(); sessionDb.close(); bindingDb.close(); rmSync(dataDir, { recursive: true, force: true }) })
  return { users, seed, dataDir, open, get access() { return access }, get directory() { return directory } }
}
const project = requestId => ({ requestId, expectedRevision: 0, value: { name: '新项目', description: '保留说明' } })
const assignment = (requestId, value = {}) => ({ requestId, expectedRevision: 1, value: { userId: 'member', role: 'reader', status: 'active', environmentIds: ['test'], environmentRoles: {}, canAdjustChat: true, ...value } })

test('一次导入存量身份和待分配状态，重开不会用夹具覆盖已保存配置', t => {
  const f = fixture(t)
  assert.equal(f.directory.settings('creator', 'existing').members.find(row => row.userId === 'member').authorizationPending, true)
  assert.throws(() => f.access.requireDeploymentActionForActor('member', 'existing', 'read'), { code: 'AUTHORIZATION_PENDING' })
  f.directory.saveProject('creator', 'existing', { requestId: 'rename', expectedRevision: 1, value: { name: '已修改项目', description: '已保存' } })
  f.directory.close()
  f.seed.projects[0].name = '旧文档和夹具不能覆盖'
  f.open()
  assert.equal(f.directory.settings('creator', 'existing').project.name, '已修改项目')
  assert.equal(f.directory.settings('creator', 'existing').members.find(row => row.userId === 'member').authorizationPending, true)
})

test('内部成员幂等创建空项目并成为管理员，外部和伪造字段被拒绝', t => {
  const f = fixture(t), created = f.directory.create('creator', project('create'))
  assert.deepEqual(created.environments, [])
  assert.equal(f.access.requireProjectActionForActor('creator', created.id, 'project.manage').role, 'project_admin')
  assert.deepEqual(f.directory.create('creator', project('create')), created)
  assert.equal(f.directory.list('creator').length, 2)
  assert.throws(() => f.directory.create('outside', project('external')), { code: 'PROJECT_CREATE_FORBIDDEN' })
  assert.throws(() => f.directory.create('creator', { ...project('forged'), role: 'admin' }), { code: 'PROJECT_INPUT_INVALID' })
  assert.throws(() => f.directory.create('creator', { ...project('create'), value: { name: '别的项目', description: '' } }), { code: 'PROJECT_REQUEST_CONFLICT' })
})

test('新增环境不自动分配普通成员，显式环境角色保存后即时覆盖项目角色', t => {
  const f = fixture(t)
  const env = f.directory.saveEnvironment('creator', 'existing', null, { requestId: 'new-env', expectedRevision: 0, value: { name: '生产同名环境' } })
  assert.throws(() => f.access.requireDeploymentActionForActor('member', 'existing', 'read', env.id), { code: 'AUTHORIZATION_PENDING' })
  f.directory.saveMember('creator', 'existing', assignment('allocate', { role: 'release_operator', environmentIds: ['test', 'production'], environmentRoles: { production: 'reader' } }))
  f.access.requireDeploymentActionForActor('member', 'existing', 'publish', 'test')
  assert.throws(() => f.access.requireDeploymentActionForActor('member', 'existing', 'publish', 'production'), { code: 'DEPLOYMENT_ACTION_FORBIDDEN' })
  assert.throws(() => f.access.requireDeploymentActionForActor('member', 'existing', 'read', env.id), { code: 'ENVIRONMENT_FORBIDDEN' })
  assert.deepEqual(f.directory.list('member')[0].environments.map(row => row.id), ['test', 'production'])
})

test('成员配置拒绝跨项目环境、伪造角色、外部提权和越权写，保留原配置', t => {
  const f = fixture(t)
  for (const value of [{ environmentIds: ['foreign'] }, { environmentRoles: { production: 'release_operator' } }, { role: 'admin' }, { userId: 'outside', role: 'reader' }, { role: 'external', environmentIds: ['test'] }])
    assert.throws(() => f.directory.saveMember('creator', 'existing', assignment('bad', value)))
  assert.throws(() => f.directory.saveMember('member', 'existing', assignment('denied')), { code: 'AUTHORIZATION_PENDING' })
  assert.equal(f.directory.settings('creator', 'existing').members.find(row => row.userId === 'member').revision, 1)
  assert.throws(() => f.directory.saveEnvironment('member', 'existing', null, { requestId: 'env-denied', expectedRevision: 0, value: { name: '越权' } }), { code: 'AUTHORIZATION_PENDING' })
})

test('原请求保存结果可核对，冲突不覆盖；撤权后旧请求不能绕过当前授权', t => {
  const f = fixture(t), input = assignment('original', { role: 'developer' })
  const saved = f.directory.saveMember('creator', 'existing', input)
  assert.deepEqual(f.directory.saveMember('creator', 'existing', input), saved)
  assert.throws(() => f.directory.saveMember('creator', 'existing', assignment('stale')), { code: 'PROJECT_REVISION_CONFLICT' })
  f.directory.saveMember('admin', 'existing', { ...assignment('second-admin', { userId: 'admin', role: 'project_admin', environmentIds: [] }), expectedRevision: 0 })
  f.directory.saveMember('admin', 'existing', assignment('revoke', { userId: 'creator', role: 'reader' }))
  assert.throws(() => f.directory.saveMember('creator', 'existing', input), { code: 'PROJECT_ACTION_FORBIDDEN' })
})

test('最后一名项目管理员不能移除；停用成员即时撤销动作且重开保持', t => {
  const f = fixture(t)
  assert.throws(() => f.directory.saveMember('creator', 'existing', assignment('last', { userId: 'creator', role: 'reader' })), { code: 'PROJECT_LAST_ADMIN' })
  f.directory.saveMember('creator', 'existing', assignment('disabled', { status: 'disabled' }))
  assert.throws(() => f.access.requireProjectActionForActor('member', 'existing', 'chat.use'), { code: 'PROJECT_NOT_FOUND' })
  f.directory.close(); f.open()
  assert.throws(() => f.access.requireProjectActionForActor('member', 'existing', 'chat.use'), { code: 'PROJECT_NOT_FOUND' })
})

test('审计失败回滚项目、管理员与收据，不用部分成功配置继续启动', t => {
  const f = fixture(t), db = new DatabaseSync(join(f.dataDir, 'project-directory', 'state.sqlite'))
  try {
    db.exec("CREATE TRIGGER directory_audit_fail BEFORE INSERT ON directory_audit BEGIN SELECT RAISE(ABORT, 'isolated audit failure'); END")
    assert.throws(() => f.directory.create('creator', project('audit-failure')), /isolated audit failure/)
    assert.equal(f.directory.list('creator').length, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM directory_receipts').get().n, 0)
    db.exec('DROP TRIGGER directory_audit_fail')
    assert.equal(f.directory.create('creator', project('audit-failure')).name, '新项目')
  } finally { db.close() }
})

test('无有效默认助手时不能保存新的受限授权，原待分配边界不变', t => {
  const f = fixture(t)
  assert.throws(() => f.directory.saveMember('creator', 'existing', assignment('no-default', { canAdjustChat: false })), { code: 'PROJECT_DEFAULT_ASSISTANT_REQUIRED' })
  assert.equal(f.directory.settings('creator', 'existing').members.find(row => row.userId === 'member').authorizationPending, true)
})
