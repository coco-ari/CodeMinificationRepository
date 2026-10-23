import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'

test('独立入口从空库初始化并通过真实 HTTP 登录', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoops-entrypoints-'))
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const origin = `http://127.0.0.1:${port}`,
    password = `测试-${randomUUID()}`
  const env = {
    ...process.env,
    AUTOOPS_DATA_DIR: directory,
    AUTOOPS_HOST: '127.0.0.1',
    AUTOOPS_PORT: String(port),
    AUTOOPS_PUBLIC_ORIGIN: origin,
    AUTOOPS_ADMIN_USERNAME: 'owner',
    AUTOOPS_ADMIN_NAME: '初始管理员',
    AUTOOPS_ADMIN_PASSWORD: password,
  }
  let child
  let stopped
  try {
    const initialize = () =>
      spawnSync(process.execPath, ['autoops/server/initialize.ts'], {
        cwd: root,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      })
    const first = initialize()
    assert.equal(first.status, 0, first.stderr)
    assert(!first.stdout.includes(password) && !first.stderr.includes(password))
    assert.equal(initialize().status, 1)
    delete env.AUTOOPS_ADMIN_PASSWORD
    child = spawn(process.execPath, ['autoops/server/start.ts'], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    stopped = new Promise((resolve) => child.once('close', resolve))
    await new Promise((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(() => reject(new Error('服务启动超时')), 10_000)
      const done = () => clearTimeout(timeout)
      child.once('error', (error) => {
        done()
        reject(error)
      })
      child.once('exit', () => {
        done()
        reject(new Error('服务提前退出'))
      })
      child.stdout.on('data', (data) => {
        output += data.toString()
        if (output.includes('autoops.ready')) {
          done()
          resolve()
        }
      })
      child.stderr.resume()
    })
    assert.equal((await fetch(origin + '/health/ready')).status, 200)
    const login = await fetch(origin + '/api/v1/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password }),
    })
    assert.equal(login.status, 200)
    assert.equal((await login.json()).user.platformAdmin, true)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    assert.equal(
      (await fetch(origin + '/api/v1/accounts', { headers: { Cookie: cookie } })).status,
      200,
    )
  } finally {
    if (child) {
      child.kill()
      await stopped
    }
    await rm(directory, { recursive: true, force: true })
  }
})
