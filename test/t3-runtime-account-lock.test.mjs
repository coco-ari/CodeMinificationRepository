import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { users } from '../agent-demo/fixtures.mjs'
import { createRuntimeAccounts } from '../agent-demo/t3-adapters/accounts/index.ts'

for (const journal of ['DELETE', 'WAL']) test(`${journal}已有安装短暂写锁在首次journal切换前应用等待预算，保留原业务`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'account-startup-lock-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'demo.sqlite'), before = new DatabaseSync(path)
  before.exec(`PRAGMA journal_mode=${journal}; CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER); CREATE TABLE conversations(id TEXT PRIMARY KEY,body TEXT);`)
  before.prepare('INSERT INTO conversations VALUES(?,?)').run('original', 'original-business-sentinel')
  before.close()
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');process.send('ready');
    setTimeout(()=>{db.exec('COMMIT');db.close();process.disconnect()},300);
  `, path], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited })
  await once(child, 'message')
  const owner = createRuntimeAccounts({ databasePath: path, legacyUsers: users, legacyPassword: 'isolated-lock-password' })
  await owner.close()
  await exited
  const after = new DatabaseSync(path, { readOnly: true })
  assert.equal(after.prepare('SELECT body FROM conversations WHERE id=?').get('original').body, 'original-business-sentinel')
  after.close()
})

test('等待另一进程写事务时仅注销调用者会话，不能继续停用目标或记录成功收据', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'account-enable-session-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'demo.sqlite')
  const owner = createRuntimeAccounts({ databasePath: path })
  t.after(() => owner.close())
  const password = 'isolated-enable-session-password'
  const admin = await owner.initialize({ username: 'lock.admin', name: '隔离管理员', password, kind: 'internal', platformAdmin: true })
  const target = await owner.create(admin.id, { requestId: randomUUID(), value: { username: 'lock.member', name: '隔离成员', password, kind: 'internal', platformAdmin: false } })
  const login = await owner.login({ username: admin.username, password })
  const sessionHash = createHash('sha256').update(login.token).digest('hex')
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.send('ready');
    setTimeout(()=>{db.prepare('DELETE FROM sessions WHERE token=?').run(process.argv[2]);db.exec('COMMIT');db.close();process.disconnect()},300);
  `, path, sessionHash], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited })
  await once(child, 'message')
  owner.session(sessionHash)
  const requestId = randomUUID()
  assert.throws(() => owner.setEnabled(admin.id, target.id, {
    requestId, expectedRevision: 1, value: { enabled: false },
  }, () => owner.session(sessionHash)), { code: 'UNAUTHENTICATED' })
  await exited
  assert.equal(owner.active(admin.id).enabled, true)
  assert.equal(owner.active(target.id).revision, 1)
  assert.equal(owner.receipt(admin.id, requestId), null)
})
