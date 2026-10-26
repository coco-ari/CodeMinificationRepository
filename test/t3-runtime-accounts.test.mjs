import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { users as legacyUsers } from '../agent-demo/fixtures.mjs'
import { createRuntimeAccounts } from '../agent-demo/t3-adapters/accounts/index.ts'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'
import { createProjectDirectory } from '../agent-demo/t3-adapters/project-directory/index.ts'
import { authorizeAutoOpsRpc } from '../agent-demo/t3-adapters/rpc-policy.mjs'
import { projects, agents } from '../agent-demo/fixtures.mjs'

const oldPassword = '隔离测试原密码-20261026'
const nextPassword = '隔离测试新密码-20261026'
const hash = value => createHash('sha256').update(value).digest('hex')
function fixture(t, { legacy = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-accounts-'))
  const path = join(directory, 'demo.sqlite')
  if (legacy) {
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER); CREATE TABLE conversations(id TEXT PRIMARY KEY,body TEXT)')
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash('original-cookie'), 'u-admin', 'original-csrf', Date.now() + 600000)
    db.prepare('INSERT INTO conversations VALUES(?,?)').run('original-thread', '{"ownerId":"u-admin"}')
    db.close()
  }
  let owner = createRuntimeAccounts({ databasePath: path, legacyUsers, legacyPassword: oldPassword })
  t.after(async () => { await owner.close(); rmSync(directory, { recursive: true, force: true }) })
  return {
    directory, path,
    get owner() { return owner },
    async reopen() { await owner.close(); owner = createRuntimeAccounts({ databasePath: path, legacyUsers, legacyPassword: '不能覆盖已有密码' }); return owner },
  }
}
const create = (owner, value = {}) => owner.create('u-admin', {
  requestId: randomUUID(),
  value: { username: 'isolated.member', name: '隔离内部成员', password: nextPassword, kind: 'internal', platformAdmin: false, ...value },
})

test('原安装导入四个原身份一次，原cookie和CSRF保留，新建真实账号可重启后正常登录', async t => {
  const f = fixture(t)
  assert.deepEqual(f.owner.users().map(user => user.id).sort(), legacyUsers.map(user => user.id).sort())
  assert.equal(f.owner.session(hash('original-cookie')).uid, 'u-admin')
  assert.equal(f.owner.session(hash('original-cookie')).csrf, 'original-csrf')
  const account = await create(f.owner)
  assert.equal(account.revision, 1)
  assert.equal(account.platformAdmin, false)
  const logged = await f.owner.login({ username: account.username, password: nextPassword })
  assert.equal(f.owner.session(hash(logged.token)).uid, account.id)
  await f.reopen()
  assert.equal((await f.owner.login({ username: account.username, password: nextPassword })).user.id, account.id)
  assert.equal(f.owner.session(hash('original-cookie')).uid, 'u-admin')
  const db = new DatabaseSync(f.path, { readOnly: true })
  assert.equal(db.prepare('SELECT body FROM conversations WHERE id=?').get('original-thread').body, '{"ownerId":"u-admin"}')
  db.close()
})

test('新安装不预置Demo账号或通用密码，只允许显式一次性初始化内部管理员', async t => {
  const f = fixture(t, { legacy: false })
  assert.throws(() => f.owner.users(), { code: 'ACCOUNT_INITIALIZATION_REQUIRED' })
  await assert.rejects(f.owner.login({ username: 'admin', password: oldPassword }), { code: 'ACCOUNT_INITIALIZATION_REQUIRED' })
  await assert.rejects(f.owner.initialize({ username: 'owner', name: '负责人', password: nextPassword, kind: 'external', platformAdmin: true }), { code: 'ACCOUNT_INITIALIZATION_CONFLICT' })
  const own = await f.owner.initialize({ username: 'owner', name: '负责人', password: nextPassword, kind: 'internal', platformAdmin: true })
  assert.deepEqual(f.owner.users().map(value => value.id), [own.id])
  await assert.rejects(f.owner.initialize({ username: 'another', name: '第二管理员', password: nextPassword, kind: 'internal', platformAdmin: true }), { code: 'ACCOUNT_INITIALIZATION_CONFLICT' })
  assert.equal((await f.owner.login({ username: 'owner', password: nextPassword })).user.id, own.id)
})

test('非平台管理员与外部账号不能管理账号，字段篡改/外部管理员/短密码都不写入', async t => {
  const { owner } = fixture(t)
  for (const actor of ['u-lin', 'u-guest']) {
    assert.throws(() => owner.list(actor), { code: 'ACCOUNT_FORBIDDEN' })
    await assert.rejects(owner.create(actor, { requestId: randomUUID(), value: {} }), { code: 'ACCOUNT_FORBIDDEN' })
    await assert.rejects(owner.resetPassword(actor, 'u-admin', {}), { code: 'ACCOUNT_FORBIDDEN' })
    assert.throws(() => owner.setEnabled(actor, 'u-admin', {}), { code: 'ACCOUNT_FORBIDDEN' })
  }
  await assert.rejects(create(owner, { kind: 'external', platformAdmin: true }), { code: 'ACCOUNT_INPUT_INVALID' })
  await assert.rejects(create(owner, { password: 'short' }), { code: 'ACCOUNT_INPUT_INVALID' })
  await assert.rejects(create(owner, { actorId: 'u-admin' }), { code: 'ACCOUNT_INPUT_INVALID' })
  assert.equal(owner.list('u-admin').items.length, 4)
})

test('创建原请求跨重启恢复同一账号，参数篡改冲突，原receipt没有密码且他人不可见', async t => {
  const f = fixture(t)
  const command = { requestId: randomUUID(), value: { username: 'request.member', name: '原请求成员', password: nextPassword, kind: 'internal', platformAdmin: false } }
  const saved = await f.owner.create('u-admin', command)
  await f.reopen()
  assert.deepEqual(await f.owner.create('u-admin', command), saved)
  await assert.rejects(f.owner.create('u-admin', { ...command, value: { ...command.value, password: oldPassword } }), { code: 'ACCOUNT_REQUEST_CONFLICT' })
  const receipt = f.owner.receipt('u-admin', command.requestId)
  assert.equal(receipt.targetId, saved.id)
  assert.deepEqual(receipt.result, saved)
  assert.equal(f.owner.receipt('u-lin', command.requestId), null)
  assert.equal(JSON.stringify(receipt).includes(nextPassword), false)
  const db = new DatabaseSync(f.path, { readOnly: true })
  const raw = JSON.stringify(db.prepare('SELECT * FROM runtime_account_requests').all())
  assert.equal(raw.includes(nextPassword), false)
  assert.equal(raw.includes(oldPassword), false)
  db.close()
})

test('用户名唯一、原修订冲突和最后有效管理员保护都保持现有会话', async t => {
  const { owner } = fixture(t)
  await assert.rejects(create(owner, { username: 'admin' }), { code: 'ACCOUNT_USERNAME_EXISTS' })
  assert.throws(() => owner.setEnabled('u-admin', 'u-admin', { requestId: randomUUID(), expectedRevision: 1, value: { enabled: false } }), { code: 'ACCOUNT_LAST_ADMIN' })
  assert.throws(() => owner.setEnabled('u-admin', 'u-lin', { requestId: randomUUID(), expectedRevision: 4, value: { enabled: false } }), { code: 'ACCOUNT_REVISION_CONFLICT' })
  assert.equal(owner.session(hash('original-cookie')).uid, 'u-admin')
  assert.equal(owner.list('u-admin').items.find(value => value.id === 'u-lin').revision, 1)
})

test('停用同事务撤销全部原cookie及native绑定，重新启用不恢复旧session', async t => {
  const f = fixture(t)
  const logged = await f.owner.login({ username: 'lin', password: oldPassword })
  const sessions = new DatabaseSync(f.path, { readOnly: true }), bindings = new DatabaseSync(':memory:')
  initializeAutoOpsAccessSchema(bindings)
  const catalog = { get users() { return f.owner.users() }, projects: structuredClone(projects), agents: structuredClone(agents) }
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, catalog })
  t.after(() => { bindings.close(); sessions.close() })
  const principal = access.authenticateCookie('demo_session=' + logged.token)
  access.recordNativeSession(principal, 'native-original')
  assert.equal(access.principalForNativeSession('native-original').id, 'u-lin')
  const command = { requestId: randomUUID(), expectedRevision: 1, value: { enabled: false } }
  const disabled = f.owner.setEnabled('u-admin', 'u-lin', command)
  assert.equal(disabled.enabled, false)
  assert.throws(() => access.refresh(principal), { code: 'UNAUTHENTICATED' })
  assert.throws(() => access.principalForNativeSession('native-original'), { code: 'UNAUTHENTICATED' })
  assert.throws(() => access.requireProjectActionForActor('u-lin', 'p-autoops', 'chat.use'), { code: 'PROJECT_NOT_FOUND' })
  assert.deepEqual(f.owner.setEnabled('u-admin', 'u-lin', command), disabled)
  f.owner.setEnabled('u-admin', 'u-lin', { requestId: randomUUID(), expectedRevision: disabled.revision, value: { enabled: true } })
  assert.throws(() => f.owner.session(hash(logged.token)), { code: 'UNAUTHENTICATED' })
  assert.equal((await f.owner.login({ username: 'lin', password: oldPassword })).user.id, 'u-lin')
})

test('本人改密原请求可在新密码登录后GET恢复，原密码和原全部session失效', async t => {
  const { owner } = fixture(t)
  const first = await owner.login({ username: 'lin', password: oldPassword })
  const second = await owner.login({ username: 'lin', password: oldPassword })
  const command = { requestId: randomUUID(), expectedRevision: 1, value: { currentPassword: oldPassword, newPassword: nextPassword } }
  const saved = await owner.changePassword('u-lin', command)
  assert.deepEqual(saved, { userId: 'u-lin', revision: 2, sessionsRevoked: true, loginPath: '/' })
  for (const token of [first.token, second.token]) assert.throws(() => owner.session(hash(token)), { code: 'UNAUTHENTICATED' })
  await assert.rejects(owner.login({ username: 'lin', password: oldPassword }), { code: 'BAD_CREDENTIALS' })
  assert.equal((await owner.login({ username: 'lin', password: nextPassword })).user.id, 'u-lin')
  assert.deepEqual(owner.receipt('u-lin', command.requestId).result, saved)
  assert.deepEqual(await owner.changePassword('u-lin', command), saved)
  assert.equal(owner.own('u-lin').account.revision, 2)
})

test('当前密码错误不变更密码/收据/会话，管理员重置保留身份和项目pending', async t => {
  const f = fixture(t)
  const logged = await f.owner.login({ username: 'lin', password: oldPassword })
  await assert.rejects(f.owner.changePassword('u-lin', { requestId: randomUUID(), expectedRevision: 1, value: { currentPassword: 'wrong', newPassword: nextPassword } }), { code: 'ACCOUNT_PASSWORD_INVALID' })
  assert.equal(f.owner.session(hash(logged.token)).uid, 'u-lin')
  const result = await f.owner.resetPassword('u-admin', 'u-lin', { requestId: randomUUID(), expectedRevision: 1, value: { newPassword: nextPassword } })
  assert.equal(result.userId, 'u-lin')
  assert.throws(() => f.owner.session(hash(logged.token)), { code: 'UNAUTHENTICATED' })
  await assert.rejects(f.owner.login({ username: 'lin', password: oldPassword }), { code: 'BAD_CREDENTIALS' })
  assert.equal((await f.owner.login({ username: 'lin', password: nextPassword })).user.id, 'u-lin')
  assert.equal(projects[0].memberships.find(member => member.userId === 'u-lin').authorizationPending, true)
})

test('密码计算期间原session被撤销，公开HTTP守卫阻止迟到创建写入', async t => {
  const { owner } = fixture(t)
  let current = true
  const work = owner.create('u-admin', { requestId: randomUUID(), value: { username: 'late.member', name: '迟到成员', password: nextPassword, kind: 'internal', platformAdmin: false } }, () => {
    if (!current) throw Object.assign(new Error('原会话撤销'), { code: 'UNAUTHENTICATED', status: 401 })
  })
  current = false
  await assert.rejects(work, { code: 'UNAUTHENTICATED' })
  assert.equal(owner.list('u-admin').items.some(value => value.username === 'late.member'), false)
})

test('审计落盘失败回滚密码与原session，不出现成功密码却未撤销会话', async t => {
  const f = fixture(t)
  const logged = await f.owner.login({ username: 'lin', password: oldPassword })
  const db = new DatabaseSync(f.path)
  db.exec("CREATE TRIGGER reject_account_audit BEFORE INSERT ON runtime_account_audit BEGIN SELECT RAISE(ABORT,'fixture audit unavailable'); END")
  await assert.rejects(f.owner.resetPassword('u-admin', 'u-lin', { requestId: randomUUID(), expectedRevision: 1, value: { newPassword: nextPassword } }), /fixture audit unavailable/)
  assert.equal(f.owner.session(hash(logged.token)).uid, 'u-lin')
  assert.equal((await f.owner.login({ username: 'lin', password: oldPassword })).user.id, 'u-lin')
  db.exec('DROP TRIGGER reject_account_audit'); db.close()
})

test('项目目录实时读取同一账号事实，新账号无默认项目环境权限，停用不再是候选', async t => {
  const f = fixture(t)
  const owner = f.owner
  const directory = createProjectDirectory({ dataDir: f.directory,
    seed: { get users() { return owner.users() }, projects: structuredClone(projects), agents: structuredClone(agents) },
    authorize: () => ({ role: 'project_admin' }),
  })
  t.after(() => directory.close())
  const created = await create(owner)
  assert.ok(directory.settings('u-admin', 'p-autoops').candidates.some(value => value.id === created.id))
  assert.equal(directory.catalog.projects.some(project => project.memberships.some(member => member.userId === created.id)), false)
  owner.setEnabled('u-admin', created.id, { requestId: randomUUID(), expectedRevision: 1, value: { enabled: false } })
  assert.equal(directory.settings('u-admin', 'p-autoops').candidates.some(value => value.id === created.id), false)
  assert.equal(directory.settings('u-admin', 'p-autoops').members.find(value => value.userId === 'u-lin').authorizationPending, true)
})

test('升级记录损坏拒绝启动且不覆盖原会话，关闭排空并拒绝迟到新写', async t => {
  const f = fixture(t)
  const work = create(f.owner, { username: 'closing.member' })
  const closing = f.owner.close()
  await assert.rejects(work, { code: 'ACCOUNT_STOPPING' })
  await closing
  await f.reopen()
  assert.equal(f.owner.list('u-admin').items.length, 4)
  await f.owner.close()
  const db = new DatabaseSync(f.path)
  db.prepare('UPDATE runtime_account_schema_migrations SET checksum=?').run('changed-by-fixture')
  db.close()
  assert.throws(() => createRuntimeAccounts({ databasePath: f.path, legacyUsers, legacyPassword: oldPassword }), { code: 'ACCOUNT_SCHEMA_INVALID' })
  const readonly = new DatabaseSync(f.path, { readOnly: true })
  assert.equal(readonly.prepare('SELECT uid FROM sessions WHERE token=?').get(hash('original-cookie')).uid, 'u-admin')
  readonly.close()
})

test('账号停用阻止原RPC、MCP工具及仅持actorId的后台新调用，不能借旧绑定继续', async t => {
  const f = fixture(t)
  const secondAdmin = await create(f.owner, { username: 'second.admin', platformAdmin: true })
  const sessions = new DatabaseSync(f.path, { readOnly: true }), bindings = new DatabaseSync(':memory:')
  initializeAutoOpsAccessSchema(bindings)
  t.after(() => { sessions.close(); bindings.close() })
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, catalog: { get users() { return f.owner.users() }, projects: structuredClone(projects), agents: structuredClone(agents) } })
  const principal = access.authenticateCookie('demo_session=original-cookie')
  access.bindThread(principal, { threadId: 'original-private', projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'private', workspaceType: 'internal' })
  authorizeAutoOpsRpc(access, principal, 'orchestration.getThreadProjection', { threadId: 'original-private' })
  assert.equal(access.requireToolThread('original-private').actorId, 'u-admin')
  f.owner.setEnabled(secondAdmin.id, 'u-admin', { requestId: randomUUID(), expectedRevision: 1, value: { enabled: false } })
  assert.throws(() => authorizeAutoOpsRpc(access, principal, 'orchestration.getThreadProjection', { threadId: 'original-private' }), { code: 'UNAUTHENTICATED' })
  assert.throws(() => access.requireToolThread('original-private'), { code: 'THREAD_SCOPE_REVOKED' })
  assert.throws(() => access.requireWorkspaceActor('u-admin', 'p-autoops'), { code: 'PROJECT_NOT_FOUND' })
  assert.throws(() => access.requireEnvironmentQueryForActor('u-admin', 'p-autoops', 'env-test'), { code: 'PROJECT_NOT_FOUND' })
})

test('本人重复启用不撤销原session，最后管理员的两个并发停用最多成功一个', async t => {
  const f = fixture(t)
  const noop = f.owner.setEnabled('u-admin', 'u-admin', { requestId: randomUUID(), expectedRevision: 1, value: { enabled: true } })
  assert.equal(noop.revision, 1)
  assert.equal(f.owner.session(hash('original-cookie')).uid, 'u-admin')
  const second = await create(f.owner, { username: 'another.admin', platformAdmin: true })
  const results = await Promise.allSettled([
    Promise.resolve().then(() => f.owner.setEnabled('u-admin', second.id, { requestId: randomUUID(), expectedRevision: 1, value: { enabled: false } })),
    Promise.resolve().then(() => f.owner.setEnabled('u-admin', 'u-admin', { requestId: randomUUID(), expectedRevision: 1, value: { enabled: false } })),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const failed = results.find(result => result.status === 'rejected')
  assert.equal(failed.reason.code, 'ACCOUNT_LAST_ADMIN')
  assert.equal(f.owner.list('u-admin').items.filter(value => value.platformAdmin && value.enabled).length, 1)
})

test('数据库原请求不能成为绕过scrypt成本的密码猜测校验器', async t => {
  const f = fixture(t)
  const command = { requestId: randomUUID(), value: { username: 'password.proof', name: '密码证明测试', password: nextPassword, kind: 'internal', platformAdmin: false } }
  await f.owner.create('u-admin', command)
  const db = new DatabaseSync(f.path, { readOnly: true })
  const metadata = db.prepare('SELECT * FROM runtime_account_metadata WHERE id=1').get()
  const receipt = db.prepare('SELECT * FROM runtime_account_requests WHERE request_id=?').get(command.requestId)
  const guessed = metadata.request_key ? ['wrong-password', nextPassword].find(password =>
    createHmac('sha256', String(metadata.request_key)).update(JSON.stringify(['create', '', { ...command, value: { ...command.value, password } }])).digest('hex') === receipt.fingerprint,
  ) : undefined
  db.close()
  assert.equal(guessed, undefined, '原请求泄露了可用同库密钥快速校验的密码证明')
})

test('两个实际SQLite所有者并发同一原请求只创建一个账号，秘密不同仍明确冲突', async t => {
  const f = fixture(t)
  const other = createRuntimeAccounts({ databasePath: f.path })
  t.after(() => other.close())
  const command = { requestId: randomUUID(), value: { username: 'same.request', name: '并发原请求', password: nextPassword, kind: 'internal', platformAdmin: false } }
  const repeated = await Promise.all([f.owner.create('u-admin', command), other.create('u-admin', command)])
  assert.equal(repeated[0].id, repeated[1].id)
  assert.equal(f.owner.list('u-admin').items.filter(value => value.username === command.value.username).length, 1)
  const different = { ...command, requestId: randomUUID(), value: { ...command.value, username: 'different.secret' } }
  const conflicting = await Promise.allSettled([
    f.owner.create('u-admin', different),
    other.create('u-admin', { ...different, value: { ...different.value, password: oldPassword } }),
  ])
  assert.equal(conflicting.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(conflicting.find(value => value.status === 'rejected').reason.code, 'ACCOUNT_REQUEST_CONFLICT')
  assert.equal(f.owner.list('u-admin').items.filter(value => value.username === different.value.username).length, 1)
})

test('改密原收据同时复核原密码与新密码，后续改密不把最新hash套入旧收据', async t => {
  const { owner } = fixture(t)
  const command = { requestId: randomUUID(), expectedRevision: 1, value: { currentPassword: oldPassword, newPassword: nextPassword } }
  const original = await owner.changePassword('u-lin', command)
  await owner.resetPassword('u-admin', 'u-lin', { requestId: randomUUID(), expectedRevision: 2, value: { newPassword: nextPassword + '-later' } })
  assert.deepEqual(await owner.changePassword('u-lin', command), original)
  await assert.rejects(owner.changePassword('u-lin', { ...command, value: { ...command.value, currentPassword: nextPassword } }), { code: 'ACCOUNT_REQUEST_CONFLICT' })
  await assert.rejects(owner.changePassword('u-lin', { ...command, value: { ...command.value, newPassword: nextPassword + '-later' } }), { code: 'ACCOUNT_REQUEST_CONFLICT' })
  assert.equal(owner.own('u-lin').account.revision, 3)
})
