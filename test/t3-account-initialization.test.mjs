import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeAccounts } from '../agent-demo/t3-adapters/accounts/index.ts'
import { users } from '../agent-demo/fixtures.mjs'

const password = 'stdin-only-initial-password-20261026'
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'account-init-cli-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const run = (input, args = []) => spawnSync(process.execPath, ['scripts/initialize-runtime-accounts.mjs', ...args], {
    cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, DATA_DIR: directory },
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 15000,
  })
  return { directory, path: join(directory, 'demo.sqlite'), run }
}
const snapshot = path => {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM sessions ORDER BY token').all())).digest('hex') }
  finally { db.close() }
}

test('实际CLI新安装仅从stdin显式初始化，不输出密码且不能重复初始化或误接管', async t => {
  const f = fixture(t)
  const input = { username: 'initial.owner', name: '初始化管理员', kind: 'internal', platformAdmin: true, password }
  const result = f.run(input)
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.initialized, true)
  assert.equal(output.count, 1)
  assert.equal(result.stdout.includes(password), false)
  assert.equal(result.stderr.includes(password), false)
  assert.notEqual(f.run(input).status, 0)
  assert.notEqual(f.run({ password }, ['--adopt-existing']).status, 0)
  const owner = createRuntimeAccounts({ databasePath: f.path })
  t.after(() => owner.close())
  assert.equal((await owner.login({ username: input.username, password })).user.id, output.userIds[0])
  assert.equal(owner.users().length, 1)
})

test('实际CLI按原四ID显式接管旧安装一次，原sessions逐字不变，重启不重写旧密码', async t => {
  const f = fixture(t)
  const db = new DatabaseSync(f.path)
  db.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('original-hashed-token', 'u-lin', 'original-csrf', Date.now() + 60000)
  db.close()
  const before = snapshot(f.path)
  const missing = f.run({}, ['--adopt-existing'])
  assert.notEqual(missing.status, 0)
  assert.equal(snapshot(f.path), before)
  const result = f.run({ password }, ['--adopt-existing'])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.userIds.sort(), users.map(user => user.id).sort())
  assert.equal(output.count, 4)
  assert.equal(snapshot(f.path), before)
  assert.equal(result.stdout.includes(password), false)
  assert.equal(result.stderr.includes(password), false)
  assert.equal(f.run({ password: 'cannot-replace-original' }, ['--adopt-existing']).status, 0)
  assert.equal(snapshot(f.path), before)
  const owner = createRuntimeAccounts({ databasePath: f.path })
  t.after(() => owner.close())
  assert.equal((await owner.login({ username: 'admin', password })).user.id, 'u-admin')
  await assert.rejects(owner.login({ username: 'admin', password: 'cannot-replace-original' }), { code: 'BAD_CREDENTIALS' })
})

test('实际CLI拒绝fresh误接管、缺原配置、畸形/超限JSON，错误不暴露秘密', t => {
  const f = fixture(t)
  const adopt = f.run({ password }, ['--adopt-existing'])
  assert.notEqual(adopt.status, 0)
  assert.equal(existsSync(f.path), false)
  for (const value of ['{"password":"' + password, ' '.repeat(17000), { password, unexpected: true }]) {
    const result = f.run(value, ['--adopt-existing'])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout.includes(password), false)
    assert.equal(result.stderr.includes(password), false)
  }
})

test('显式初始化的新安装实际Worker组合根从持久账号启动且无Demo项目或隐式成员', async t => {
  const f = fixture(t)
  const result = f.run({ username: 'fresh.owner', name: '新安装管理员', password, kind: 'internal', platformAdmin: true })
  assert.equal(result.status, 0, result.stderr)
  const initialized = JSON.parse(result.stdout)
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {createBusinessRuntime} from './agent-demo/t3-adapters/business-runtime.mjs';
    import {configuredAutoOpsProjectDirectory} from './agent-demo/t3-adapters/access.mjs';
    const runtime=createBusinessRuntime();
    try {
      await runtime.initialize();
      const directory=configuredAutoOpsProjectDirectory();
      assert.deepEqual(directory.catalog.projects,[]);
      assert.equal(directory.catalog.users.length,1);
      assert.equal(directory.catalog.users[0].id,process.env.EXPECTED_ACCOUNT_ID);
      console.log(JSON.stringify({persistentAccount:true,demoProjects:false}));
    } finally {await runtime.close()}
  `], { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, AUTOOPS_T3_DATA_DIR: f.directory, AUTOOPS_DEPLOYMENT_ENABLED: '0', AUTOOPS_T3_MODEL: 'fresh-test-model', EXPECTED_ACCOUNT_ID: initialized.userIds[0] }, encoding: 'utf8', timeout: 15000 })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { persistentAccount: true, demoProjects: false })
})
