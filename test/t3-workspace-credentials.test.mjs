import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, chmod, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createProjectCredentialService } from '../agent-demo/t3-adapters/credentials.ts'

const input = (requestId = 'create-1') => ({ requestId, name: '专用测试凭证', username: 'fixture-user', password: 'fixture-secret-only' })
async function fixture(t, authorize = () => true) {
  const root = await mkdtemp(path.join(tmpdir(), 'autoops-credentials-test-'))
  const options = { databasePath: path.join(root, 'credentials.sqlite'), keyPath: path.join(root, 'master.key'), initializeKeyIfNew: true, authorize }
  let service = createProjectCredentialService(options)
  t.after(async () => { service.stopAccepting(); await service.drain(); service.close(); await rm(root, { recursive: true, force: true }) })
  return { root, options, get service() { return service }, reopen() { service.stopAccepting(); service.close(); service = createProjectCredentialService(options); return service } }
}
const code = value => error => error?.code === value

test('凭证秘密加密保存，公开元数据与请求收据永不含用户名和秘密，重启仍可使用固定版本', async t => {
  const f = await fixture(t), created = f.service.create('actor-a', 'project-a', input())
  assert.equal(created.version, 1); assert.equal(created.revision, 1)
  const reference = f.service.referenceVersion('actor-a', 'project-a', created.id)
  assert.equal(await f.service.withCredential('actor-a', 'project-a', reference, credential => credential.password === input().password), true)
  assert.equal(JSON.stringify(f.service.list('actor-a', 'project-a')).includes('fixture-'), false)
  assert.deepEqual(f.service.receipt('actor-a', 'project-a', 'create-1'), created)
  assert.equal(f.service.receipt('actor-b', 'project-a', 'create-1'), null)
  assert.equal(f.service.receipt('actor-a', 'project-b', 'create-1'), null)
  const db = new DatabaseSync(f.options.databasePath)
  const saved = JSON.stringify(db.prepare('SELECT * FROM credential_versions').all())
  assert.equal(saved.includes(input().username), false); assert.equal(saved.includes(input().password), false)
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM credential_audit').all()).includes('fixture-'), false)
  db.close()
  f.reopen()
  assert.equal(await f.service.withCredential('actor-a', 'project-a', reference, credential => credential.password === input().password), true)
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.options.keyPath)).mode & 0o077, 0)
    assert.equal((await stat(f.options.databasePath)).mode & 0o077, 0)
  }
})

test('同请求严格幂等，冲突请求与旧修订号拒绝，替换不改变任务已固定秘密', async t => {
  const f = await fixture(t), first = f.service.create('actor-a', 'project-a', input())
  assert.deepEqual(f.service.create('actor-a', 'project-a', input()), first)
  assert.throws(() => f.service.create('actor-a', 'project-a', { ...input(), password: 'other-fixture-token' }), code('CREDENTIAL_REQUEST_CONFLICT'))
  const reference = f.service.referenceVersion('actor-a', 'project-a', first.id)
  const replacement = { requestId: 'replace-1', expectedRevision: 1, username: 'replacement-user', password: 'replacement-token' }
  const second = f.service.replace('actor-a', 'project-a', first.id, replacement)
  assert.equal(second.version, 2); assert.equal(second.revision, 2)
  assert.deepEqual(f.service.replace('actor-a', 'project-a', first.id, replacement), second)
  assert.throws(() => f.service.replace('actor-a', 'project-a', first.id, { ...replacement, requestId: 'replace-2' }), code('CREDENTIAL_REVISION_CONFLICT'))
  assert.equal(await f.service.withCredential('actor-a', 'project-a', reference, credential => credential.password === input().password), true)
  const current = f.service.referenceVersion('actor-a', 'project-a', first.id)
  assert.equal(await f.service.withCredential('actor-a', 'project-a', current, credential => credential.password === 'replacement-token'), true)
  assert.equal(f.service.list('actor-a', 'project-a').length, 1)
})

test('撤销后所有历史版本和新引用均拒绝；撤销重试保持原收据', async t => {
  const f = await fixture(t), first = f.service.create('actor-a', 'project-a', input())
  const reference = f.service.referenceVersion('actor-a', 'project-a', first.id)
  const revoked = f.service.revoke('actor-a', 'project-a', first.id, { requestId: 'revoke-1', expectedRevision: 1 })
  assert.equal(revoked.revoked, true)
  assert.deepEqual(f.service.revoke('actor-a', 'project-a', first.id, { requestId: 'revoke-1', expectedRevision: 1 }), revoked)
  assert.throws(() => f.service.referenceVersion('actor-a', 'project-a', first.id), code('CREDENTIAL_REVOKED'))
  await assert.rejects(async () => f.service.withCredential('actor-a', 'project-a', reference, () => assert.fail()), code('CREDENTIAL_REVOKED'))
  assert.throws(() => f.service.replace('actor-a', 'project-a', first.id, { ...input('replace-after-revoke'), expectedRevision: 2 }), code('CREDENTIAL_REVOKED'))
})

test('管理和使用分别重查授权，跨项目引用与篡改固定版本拒绝，幂等重试不能绕过撤权', async t => {
  let use = true, manage = true
  const actions = []
  const f = await fixture(t, (actor, project, action) => { actions.push([actor, project, action]); return action === 'credential.use' ? use : manage })
  const created = f.service.create('actor-a', 'project-a', input()), reference = f.service.referenceVersion('actor-a', 'project-a', created.id)
  manage = false
  assert.throws(() => f.service.create('actor-a', 'project-a', input()), code('CREDENTIAL_FORBIDDEN'))
  assert.equal(await f.service.withCredential('actor-a', 'project-a', reference, value => Boolean(value.password)), true)
  await assert.rejects(f.service.withCredential('actor-a', 'project-b', reference, () => assert.fail()), code('CREDENTIAL_SCOPE_MISMATCH'))
  await assert.rejects(f.service.withCredential('actor-a', 'project-a', { ...reference, version: 99 }, () => assert.fail()), code('CREDENTIAL_VERSION_NOT_FOUND'))
  use = false
  assert.throws(() => f.service.referenceVersion('actor-a', 'project-a', created.id), code('CREDENTIAL_FORBIDDEN'))
  await assert.rejects(async () => f.service.withCredential('actor-a', 'project-a', reference, () => assert.fail()), code('CREDENTIAL_FORBIDDEN'))
  assert.ok(actions.some(value => value[2] === 'credential.use')); assert.ok(actions.some(value => value[2] === 'credential.manage'))
})

test('必要操作事实写入失败时凭证、版本和幂等收据一起回滚', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.options.databasePath)
  db.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON credential_audit BEGIN SELECT RAISE(ABORT, '模拟审计存储失败'); END;")
  assert.throws(() => f.service.create('actor-a', 'project-a', input()))
  assert.deepEqual(f.service.list('actor-a', 'project-a'), [])
  assert.equal(f.service.receipt('actor-a', 'project-a', 'create-1'), null)
  assert.equal(db.prepare('SELECT count(*) AS total FROM credential_versions').get().total, 0)
  db.exec('DROP TRIGGER fixture_audit_failure'); db.close()
  assert.equal(f.service.create('actor-a', 'project-a', input()).version, 1)
})

test('宿主停止接单后拒绝新调用，等待在途取密回调完成再关闭数据库', async t => {
  const f = await fixture(t), record = f.service.create('actor-a', 'project-a', input()), reference = f.service.referenceVersion('actor-a', 'project-a', record.id)
  let finish, seen
  const operation = f.service.withCredential('actor-a', 'project-a', reference, credential => { seen = credential; return new Promise(resolve => { finish = resolve }) })
  assert.equal(seen.password, input().password)
  f.service.stopAccepting()
  assert.throws(() => f.service.list('actor-a', 'project-a'), code('CREDENTIAL_SERVICE_STOPPING'))
  assert.throws(() => f.service.close(), code('CREDENTIAL_SERVICE_BUSY'))
  let drained = false
  const draining = f.service.drain().then(() => { drained = true })
  await Promise.resolve(); assert.equal(drained, false)
  finish('finished'); assert.equal(await operation, 'finished'); await draining
  assert.equal(seen.password, ''); assert.equal(seen.username, '')
  f.service.close(); f.service.close()
})

test('误接异步授权端口时拒绝取密且消费异步拒绝，不放宽裁决', async t => {
  const f = await fixture(t, () => Promise.reject(new Error('测试异步授权拒绝')))
  assert.throws(() => f.service.create('actor-a', 'project-a', input()), code('CREDENTIAL_AUTHORIZATION_INVALID'))
  await new Promise(resolve => setImmediate(resolve))
})

test('已有库丢失或错配密钥必须拒绝，不能自动重建；宽松权限密钥拒绝', async t => {
  const f = await fixture(t), original = await readFile(f.options.keyPath)
  f.service.create('actor-a', 'project-a', input()); f.service.stopAccepting(); f.service.close()
  await rm(f.options.keyPath)
  assert.throws(() => createProjectCredentialService(f.options), code('CREDENTIAL_KEY_MISSING'))
  assert.equal(existsSync(f.options.keyPath), false)
  await writeFile(f.options.keyPath, Buffer.alloc(32, 7), { mode: 0o600 })
  assert.throws(() => createProjectCredentialService(f.options), code('CREDENTIAL_KEY_MISMATCH'))
  await writeFile(f.options.keyPath, original)
  if (process.platform !== 'win32') {
    await chmod(f.options.keyPath, 0o644)
    assert.throws(() => createProjectCredentialService(f.options), code('CREDENTIAL_KEY_INVALID'))
    await chmod(f.options.keyPath, 0o600)
  }
  const restored = createProjectCredentialService(f.options); restored.close()
})
