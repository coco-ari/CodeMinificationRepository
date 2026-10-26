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

test('同actor只读原收据含严格意图与范围，环境及成员结果固定，重开不新增审计或收据', t => {
  const f = fixture(t)
  const commands = [
    ['create-receipt', null, f.directory.create('creator', project('create-receipt')), 'project.create', project('create-receipt')],
    ['save-receipt', null, f.directory.saveProject('creator', 'existing', { requestId: 'save-receipt', expectedRevision: 1, value: { name: '已保存配置', description: '原意图' } }), 'project.save', { requestId: 'save-receipt', expectedRevision: 1, value: { name: '已保存配置', description: '原意图' } }],
  ]
  const envCommand = { requestId: 'new-env-receipt', expectedRevision: 0, value: { name: '新环境原意图' } }
  const environment = f.directory.saveEnvironment('creator', 'existing', null, envCommand)
  commands.push(['new-env-receipt', null, environment, 'environment.save:new', envCommand])
  const rename = { requestId: 'rename-env-receipt', expectedRevision: 1, value: { name: '更新环境' } }
  commands.push(['rename-env-receipt', environment.id, f.directory.saveEnvironment('creator', 'existing', environment.id, rename), 'environment.save:' + environment.id, rename])
  const member = assignment('member-receipt', { role: 'developer' })
  commands.push(['member-receipt', null, f.directory.saveMember('creator', 'existing', member), 'member.save:member', member])
  const db = new DatabaseSync(join(f.dataDir, 'project-directory', 'state.sqlite'))
  try {
    const counts = () => ['directory_receipts', 'directory_audit', 'directory_deletions'].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
    const before = counts()
    for (const [requestId, environmentId, result, operation, command] of commands) {
      const receipt = f.directory.receipt('creator', requestId)
      assert.deepEqual(receipt.publicIntent, { expectedRevision: command.expectedRevision, value: command.value })
      assert.equal(receipt.actorId, 'creator');assert.equal(receipt.requestId, requestId);assert.equal(receipt.operation, operation)
      assert.equal(receipt.environmentId, environmentId);assert.equal(receipt.state, 'completed');assert.equal(receipt.available, true)
      assert.deepEqual(receipt.result, result)
      assert.equal(receipt.projectId, operation === 'project.create' ? result.id : 'existing')
      assert.equal(receipt.nativeSynchronization, operation.startsWith('project.') ? 'unverified' : 'not-required')
      assert.equal(f.directory.receipt('admin', requestId), null, '平台管理员也不能读取他人原收据')
    }
    assert.deepEqual(counts(), before)
    const original = f.directory.receipt('creator', 'create-receipt')
    f.directory.close();f.open()
    assert.deepEqual(f.directory.receipt('creator', 'create-receipt'), original)
    assert.equal(f.directory.receipt('creator', 'missing'), null)
    assert.throws(() => f.directory.receipt('creator', '../forged'), { code: 'PROJECT_INPUT_INVALID' })
  } finally { db.close() }
})

test('当前撤权仅保留本人原保存事实和提交意图，不返回项目或成员详情；账号停用拒绝全部收据', t => {
  const f = fixture(t), original = assignment('accepted-member', { role: 'developer' })
  f.directory.saveMember('creator', 'existing', original)
  f.directory.saveMember('admin', 'existing', { ...assignment('another-admin-receipt', { userId: 'admin', role: 'project_admin', environmentIds: [] }), expectedRevision: 0 })
  f.directory.saveMember('admin', 'existing', assignment('revoke-receipt-actor', { userId: 'creator', role: 'reader', environmentIds: [] }))
  const receipt = f.directory.receipt('creator', original.requestId)
  assert.equal(receipt.saved, true);assert.equal(receipt.available, false);assert.equal(receipt.state, 'completed')
  assert.deepEqual(receipt.publicIntent, { expectedRevision: original.expectedRevision, value: original.value })
  assert.equal(Object.hasOwn(receipt, 'result'), false)
  f.users.find(user => user.id === 'creator').status = 'disabled'
  assert.throws(() => f.directory.receipt('creator', original.requestId), { code: 'PROJECT_ACTOR_FORBIDDEN' })
})

test('删除收据只读区分pending、blocked、实际deleted，墓碑原actor仍得到最小事实', t => {
  const f = fixture(t), created = f.directory.create('creator', project('empty-receipt-project'))
  const command = { requestId: 'delete-receipt-project', expectedRevision: 1 }
  f.directory.beginProjectDeletion('creator', created.id, command, () => [])
  assert.equal(f.directory.receipt('creator', command.requestId).state, 'pending')
  assert.equal(f.directory.receipt('creator', command.requestId).result, undefined)
  f.directory.blockProjectDeletion('creator', created.id, command, [{ kind: 'native-threads', count: 1, message: '仍有私有及归档会话' }])
  const blocked = f.directory.receipt('creator', command.requestId)
  assert.equal(blocked.state, 'blocked');assert.equal(blocked.available, true);assert.equal(blocked.blockers.length, 1)
  const remove = { requestId: 'actual-delete-receipt-project', expectedRevision: 3 }
  f.directory.beginProjectDeletion('creator', created.id, remove, () => [])
  f.directory.completeProjectDeletion('creator', created.id, remove)
  const receipt = f.directory.receipt('creator', remove.requestId)
  assert.equal(receipt.state, 'completed');assert.equal(receipt.available, false)
  assert.deepEqual(receipt.result, { deleted: true, projectId: created.id })
  assert.equal(f.directory.receipt('admin', remove.requestId), null)
  const environment = f.directory.saveEnvironment('creator', 'existing', null, { requestId: 'empty-env-receipt', expectedRevision: 0, value: { name: '待删除环境' } })
  f.directory.deleteEnvironment('creator', 'existing', environment.id, { requestId: 'delete-env-receipt', expectedRevision: 1 }, () => [])
  const envReceipt = f.directory.receipt('creator', 'delete-env-receipt')
  assert.equal(envReceipt.environmentId, environment.id);assert.equal(envReceipt.operation, 'environment.delete')
  assert.deepEqual(envReceipt.publicIntent, { expectedRevision: 1 })
  assert.deepEqual(envReceipt.result, { deleted: true, projectId: 'existing', environmentId: environment.id })
})

test('损坏或注入的原参数/结果拒绝恢复，不返回秘密或以空收据掩盖损坏', t => {
  const f = fixture(t), command = project('corrupt-receipt'), created = f.directory.create('creator', command)
  const db = new DatabaseSync(join(f.dataDir, 'project-directory', 'state.sqlite'))
  try {
    db.prepare('UPDATE directory_receipts SET payload=? WHERE request_id=?').run(JSON.stringify({ ...command, secret: 'fictional-never-return' }), command.requestId)
    assert.throws(() => f.directory.receipt('creator', command.requestId), { code: 'PROJECT_RECEIPT_INVALID', status: 503 })
    db.prepare('UPDATE directory_receipts SET payload=?,result=? WHERE request_id=?').run(JSON.stringify(command), JSON.stringify({ ...created, id: 'another-project' }), command.requestId)
    assert.throws(() => f.directory.receipt('creator', command.requestId), { code: 'PROJECT_RECEIPT_INVALID', status: 503 })
    assert.equal(f.directory.receipt('admin', command.requestId), null)
  } finally { db.close() }
})
