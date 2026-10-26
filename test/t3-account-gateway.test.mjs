import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createRuntimeAccounts } from '../agent-demo/t3-adapters/accounts/index.ts'

const password = '隔离网关测试密码20261026'
async function start(t, directory) {
  // 仅启动实际登录网关，不启动 Worker、浏览器、模型或部署 Agent。
  const child = spawn(process.execPath, ['agent-demo/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATA_DIR: directory, AGENT_DEMO_ENGINE: 't3', AUTOOPS_DEPLOYMENT_ENABLED: '0', PORT: '0', HOST: '127.0.0.1', DEMO_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exit = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exit })
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('隔离登录网关启动超时')), 10000)
    const ready = () => {
      const found = output.match(/Agent Demo listening (\{[^\n]+?\});/)
      if (found) { clearTimeout(timer); resolve('http://127.0.0.1:' + JSON.parse(found[1]).port) }
    }
    child.stdout.on('data', ready)
    child.once('exit', code => { clearTimeout(timer); reject(Object.assign(new Error('隔离网关未启动'), { code, detail: errors })) })
  })
  return { child, origin, output: () => output, errors: () => errors }
}

test('实际T3网关新安装在旧DDL前拒绝Demo导入，明确初始化后只用新账号密码登录', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'account-gateway-fresh-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const child = spawn(process.execPath, ['agent-demo/server.mjs'], { cwd: new URL('..', import.meta.url), env: {
    ...process.env, DATA_DIR: directory, AGENT_DEMO_ENGINE: 't3', AUTOOPS_DEPLOYMENT_ENABLED: '0', PORT: '0', DEMO_PASSWORD: password,
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  const [code] = await once(child, 'exit')
  assert.notEqual(code, 0)
  assert.match(errors, /ACCOUNT_INITIALIZATION_REQUIRED/)
  const owner = createRuntimeAccounts({ databasePath: join(directory, 'demo.sqlite') })
  const initialized = await owner.initialize({ username: 'actual.owner', name: '初始化负责人', password, kind: 'internal', platformAdmin: true })
  t.after(() => owner.close())
  const gateway = await start(t, directory)
  const login = body => fetch(gateway.origin + '/api/agent-demo/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await login({ username: 'admin', password })).status, 401)
  const response = await login({ username: 'actual.owner', password })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).user.id, initialized.id)
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  assert.deepEqual(owner.list(initialized.id).items.map(item => item.id), [initialized.id])
})

test('实际T3登录动态使用同一账号所有者，创建/重置/停用后cookie立即按真实状态拒绝', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'account-gateway-current-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const owner = createRuntimeAccounts({ databasePath: join(directory, 'demo.sqlite') })
  const admin = await owner.initialize({ username: 'actual.owner', name: '负责人', password, kind: 'internal', platformAdmin: true })
  t.after(() => owner.close())
  const member = await owner.create(admin.id, { requestId: randomUUID(), value: { username: 'actual.member', name: '真实登录测试成员', password, kind: 'internal', platformAdmin: false } })
  const gateway = await start(t, directory)
  const login = async supplied => {
    const response = await fetch(gateway.origin + '/api/agent-demo/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: member.username, password: supplied }) })
    return { response, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const original = await login(password)
  assert.equal(original.response.status, 200)
  assert.equal(original.body.user.id, member.id)
  await owner.resetPassword(admin.id, member.id, { requestId: randomUUID(), expectedRevision: 1, value: { newPassword: password + '-changed' } })
  const denied = await fetch(gateway.origin + '/api/agent-demo/logout', { method: 'POST', headers: { cookie: original.cookie, 'x-demo-csrf': original.body.csrf, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(denied.status, 401)
  assert.equal((await login(password)).response.status, 401)
  const changed = await login(password + '-changed')
  assert.equal(changed.response.status, 200)
  owner.setEnabled(admin.id, member.id, { requestId: randomUUID(), expectedRevision: 2, value: { enabled: false } })
  assert.equal((await login(password + '-changed')).response.status, 401)
  const db = new DatabaseSync(join(directory, 'demo.sqlite'), { readOnly: true })
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE uid=?').get(member.id).n, 0)
  db.close()
})

test('实际Gateway并发密码派生的既有限额返回429，不能映射为generic500', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'account-gateway-limit-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const owner = createRuntimeAccounts({ databasePath: join(directory, 'demo.sqlite') })
  await owner.initialize({ username: 'actual.owner', name: '负责人', password, kind: 'internal', platformAdmin: true })
  t.after(() => owner.close())
  const gateway = await start(t, directory)
  const results = await Promise.all(Array.from({ length: 9 }, async (_, index) => {
    const response = await fetch(gateway.origin + '/api/agent-demo/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'missing.' + index, password }) })
    return { status: response.status, body: await response.json() }
  }))
  assert.ok(results.some(value => value.status === 429 && value.body.code === 'RATE_LIMITED'))
  assert.ok(results.every(value => value.status === 401 || value.status === 429))
})
