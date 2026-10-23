import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { serve } from '@hono/node-server'
import { createAutoOps, migrations } from '../server/app.ts'
import { openDatabase } from '../server/platform/database.ts'
import { readConfig } from '../server/platform/config.ts'
import * as C from '../contracts/index.ts'
import * as S from 'effect/Schema'

const origin = 'http://127.0.0.1:28900'
const password = '测试专用密码-不用于真实环境-2026'
const account = (
  username: string,
  kind: 'internal' | 'external' = 'internal',
  platformAdmin = false,
) => ({ username, name: username, password, kind, platformAdmin })
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoops-foundation-')),
    file = path.join(directory, 'test.sqlite')
  let now = Date.now()
  const options = {
    databaseFile: file,
    publicOrigin: origin,
    secureCookie: false,
    runtime: { now: () => now, id: randomUUID },
  }
  let system = createAutoOps(options)
  t.after(async () => {
    system.close()
    await rm(directory, { recursive: true, force: true })
  })
  const admin = await system.identity.initialize(account('admin', 'internal', true))
  return {
    file,
    admin,
    get system() {
      return system
    },
    advance: (ms: number) => {
      now += ms
    },
    restart: () => {
      system.close()
      system = createAutoOps(options)
    },
  }
}
interface Session {
  cookie: string
  csrfToken: string
  user: C.User
}
async function login(system: ReturnType<typeof createAutoOps>, username: string): Promise<Session> {
  const response = await system.app.request(origin + '/api/v1/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(response.status, 200)
  const result = S.decodeUnknownSync(C.LoginResult)(await response.json())
  const cookie = response.headers.get('set-cookie')!
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /SameSite=Strict/i)
  return { cookie: cookie.split(';')[0]!, csrfToken: result.csrfToken, user: result.user }
}
async function request(
  system: ReturnType<typeof createAutoOps>,
  session: Session,
  method: string,
  url: string,
  body?: unknown,
  key = randomUUID(),
) {
  return system.app.request(origin + '/api/v1' + url, {
    method,
    headers: {
      Origin: origin,
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrfToken,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('真实 HTTP 合同：账号、项目、环境、成员与授权闭环', async (t) => {
  const f = await fixture(t),
    s = f.system,
    admin = await login(s, 'admin')
  const created = await request(s, admin, 'POST', '/accounts', account('developer'))
  assert.equal(created.status, 201)
  const member = S.decodeUnknownSync(C.User)(await created.json())
  assert.equal('password' in member, false)
  const developer = await login(s, 'developer')
  assert.equal((await request(s, developer, 'GET', '/accounts')).status, 403)
  const accounts = await request(s, admin, 'GET', '/accounts')
  const directory = (await accounts.json()) as { items: C.User[] }
  assert.equal(directory.items.length, 2)
  assert(directory.items.every((item) => !('passwordHash' in item) && !('password' in item)))
  const key = randomUUID(),
    input = { name: '第一项目', description: '' }
  const p = await request(s, developer, 'POST', '/projects', input, key)
  assert.equal(p.status, 201)
  const project = S.decodeUnknownSync(C.Project)(await p.json())
  const replay = await request(s, developer, 'POST', '/projects', input, key)
  assert.equal(((await replay.json()) as C.Project).id, project.id)
  assert.equal(
    (await request(s, developer, 'POST', '/projects', { ...input, name: '不同参数' }, key)).status,
    409,
  )
  assert.equal((await request(s, admin, 'POST', '/projects', input, key)).status, 409)
  const envResponse = await request(s, developer, 'POST', `/projects/${project.id}/environments`, {
    name: '测试',
  })
  assert.equal(envResponse.status, 201)
  const env = S.decodeUnknownSync(C.Environment)(await envResponse.json())
  assert.equal(
    (await request(s, developer, 'POST', `/projects/${project.id}/environments`, { name: '测试' }))
      .status,
    409,
  )
  const external = s.identity.create(f.admin.id, account('partner', 'external'))
  const outsider = await external,
    partner = await login(s, 'partner')
  assert.equal((await request(s, partner, 'POST', '/projects', input)).status, 403)
  assert.equal((await request(s, partner, 'GET', `/projects/${project.id}`)).status, 403)
  assert.equal(
    (
      await request(s, developer, 'POST', `/projects/${project.id}/members`, {
        userId: outsider.id,
      })
    ).status,
    204,
  )
  const assigned = await request(s, developer, 'POST', `/projects/${project.id}/grants`, {
    userId: outsider.id,
    role: 'external',
    environmentId: env.id,
  })
  assert.equal(assigned.status, 201)
  const grant = S.decodeUnknownSync(C.Grant)(await assigned.json())
  assert.equal((await request(s, partner, 'GET', `/projects/${project.id}`)).status, 200)
  assert.equal(
    (
      await request(s, partner, 'POST', `/projects/${project.id}/members`, {
        userId: admin.user.id,
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await request(s, developer, 'POST', `/projects/${project.id}/grants`, {
        userId: outsider.id,
        role: 'project_admin',
        environmentId: null,
      })
    ).status,
    400,
  )
  const caps = await request(
    s,
    partner,
    'GET',
    `/projects/${project.id}/capabilities?environmentId=${env.id}`,
  )
  const projected = (await caps.json()) as { actions: C.Action[] }
  assert(projected.actions.includes('environment.read'))
  assert(!projected.actions.includes('deployment.execute'))
  assert(!projected.actions.includes('workspace.read'))
  assert.equal(
    (await request(s, developer, 'DELETE', `/projects/${project.id}/grants/${grant.id}`)).status,
    204,
  )
  assert.equal((await request(s, partner, 'GET', `/projects/${project.id}`)).status, 403)
  const audit = await request(s, developer, 'GET', `/projects/${project.id}/audit`)
  assert.equal(audit.status, 200)
  assert(((await audit.json()) as { items: unknown[] }).items.length >= 5)
  assert.equal(
    (await request(s, developer, 'DELETE', `/projects/${project.id}/members/${member.id}`)).status,
    409,
  )
})

test('入口不能伪造身份，CSRF、来源及错误合同生效', async (t) => {
  const f = await fixture(t),
    s = f.system,
    admin = await login(s, 'admin')
  const noOrigin = await s.app.request(origin + '/api/v1/projects', {
    method: 'POST',
    headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(noOrigin.status, 403)
  const noCsrf = await s.app.request(origin + '/api/v1/projects', {
    method: 'POST',
    headers: { Origin: origin, Cookie: admin.cookie, 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(noCsrf.status, 403)
  assert.equal(
    (await s.app.request(origin + '/api/v1/projects', { headers: { 'X-User-Id': f.admin.id } }))
      .status,
    401,
  )
  const forged = await request(s, admin, 'POST', '/projects', {
    name: '伪造',
    description: '',
    platformAdmin: true,
    userId: f.admin.id,
  })
  assert.equal(forged.status, 400)
  const error = S.decodeUnknownSync(C.ApiError)(await forged.json())
  assert.equal(error.error.code, 'INVALID_INPUT')
  assert(error.error.requestId)
  const malformed = await s.app.request(origin + '/api/v1/projects', {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: admin.cookie,
      'X-CSRF-Token': admin.csrfToken,
      'Content-Type': 'application/json',
    },
    body: '{',
  })
  assert.equal(malformed.status, 400)
  const refreshed = await request(s, admin, 'GET', '/session')
  assert.equal(
    S.decodeUnknownSync(C.LoginResult)(await refreshed.json()).csrfToken,
    admin.csrfToken,
  )
})

test('跨项目、环境隔离及新增环境不扩权', async (t) => {
  const f = await fixture(t),
    s = f.system,
    user = await s.identity.create(f.admin.id, account('operator'))
  const p = s.projects.create(f.admin.id, { name: '项目一', description: '' }, randomUUID())
  const other = s.projects.create(f.admin.id, { name: '项目二', description: '' }, randomUUID())
  const a = s.projects.addEnvironment(f.admin.id, p.id, { name: '测试' }, randomUUID())
  const b = s.projects.addEnvironment(f.admin.id, p.id, { name: '生产' }, randomUUID())
  const foreign = s.projects.addEnvironment(f.admin.id, other.id, { name: '测试' }, randomUUID())
  s.projects.addMember(f.admin.id, p.id, { userId: user.id })
  s.access.assign(f.admin.id, p.id, {
    userId: user.id,
    role: 'release_operator',
    environmentId: a.id,
  })
  s.access.assign(f.admin.id, p.id, { userId: user.id, role: 'reader', environmentId: b.id })
  assert.equal(
    s.access.allows(user.id, 'deployment.execute', { projectId: p.id, environmentId: a.id }),
    true,
  )
  assert.equal(
    s.access.allows(user.id, 'deployment.execute', { projectId: p.id, environmentId: b.id }),
    false,
  )
  assert.equal(
    s.access.allows(user.id, 'environment.read', { projectId: p.id, environmentId: foreign.id }),
    false,
  )
  assert.throws(() =>
    s.access.assign(f.admin.id, p.id, {
      userId: user.id,
      role: 'reader',
      environmentId: foreign.id,
    }),
  )
  const c = s.projects.addEnvironment(f.admin.id, p.id, { name: '新增' }, randomUUID())
  assert.equal(
    s.access.allows(user.id, 'environment.read', { projectId: p.id, environmentId: c.id }),
    false,
  )
  assert.deepEqual(
    new Set(s.projects.environments(user.id, p.id).items.map((e) => e.id)),
    new Set([a.id, b.id]),
  )
  const session = await login(s, 'operator')
  s.projects.removeMember(f.admin.id, p.id, user.id)
  assert.equal((await request(s, session, 'GET', `/projects/${p.id}`)).status, 403)
  assert.deepEqual(s.projects.list(user.id).items, [])
})

test('持久化重启、账号停用、密码重置及会话到期', async (t) => {
  const f = await fixture(t),
    user = await f.system.identity.create(f.admin.id, account('reader'))
  const session = await login(f.system, 'reader')
  const project = f.system.projects.create(
    user.id,
    { name: '持久项目', description: '' },
    randomUUID(),
  )
  f.restart()
  assert.equal((await request(f.system, session, 'GET', `/projects/${project.id}`)).status, 200)
  f.system.identity.setEnabled(f.admin.id, user.id, { enabled: false })
  assert.equal((await request(f.system, session, 'GET', '/session')).status, 401)
  f.system.identity.setEnabled(f.admin.id, user.id, { enabled: true })
  assert.equal((await request(f.system, session, 'GET', '/session')).status, 401)
  const second = await login(f.system, 'reader')
  await f.system.identity.resetPassword(f.admin.id, user.id, { newPassword: password + '新' })
  assert.equal((await request(f.system, second, 'GET', '/session')).status, 401)
  const admin = await login(f.system, 'admin')
  f.advance(12 * 60 * 60 * 1000 + 1)
  assert.equal((await request(f.system, admin, 'GET', '/session')).status, 401)
  assert.throws(() => f.system.identity.setEnabled(f.admin.id, f.admin.id, { enabled: false }))
  await assert.rejects(() => f.system.identity.initialize(account('another', 'internal', true)))
})

test('幂等重试仍检查当前权限，自助改密及注销立即失效', async (t) => {
  const f = await fixture(t),
    s = f.system
  const user = await s.identity.create(f.admin.id, account('creator'))
  const session = await login(s, 'creator'),
    key = randomUUID(),
    input = { name: '移交项目', description: '内部信息' }
  const p = s.projects.create(user.id, input, key)
  s.projects.addMember(user.id, p.id, { userId: f.admin.id })
  s.access.assign(user.id, p.id, { userId: f.admin.id, role: 'project_admin', environmentId: null })
  s.projects.removeMember(f.admin.id, p.id, user.id)
  assert.equal((await request(s, session, 'POST', '/projects', input, key)).status, 403)
  assert.equal(
    (
      await request(s, session, 'PUT', '/session/password', {
        currentPassword: '错误密码',
        newPassword: password + '新',
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await request(s, session, 'PUT', '/session/password', {
        currentPassword: password,
        newPassword: password + '新',
      })
    ).status,
    204,
  )
  assert.equal((await request(s, session, 'GET', '/session')).status, 401)
  const admin = await login(s, 'admin')
  assert.equal((await request(s, admin, 'POST', '/logout')).status, 204)
  assert.equal((await request(s, admin, 'GET', '/session')).status, 401)
})

test('事务开启失败不破坏后续事务，嵌套失败只回滚保存点', () => {
  const storage = openDatabase(':memory:', [
    { version: 1, name: '事务测试', sql: 'CREATE TABLE example (id INTEGER PRIMARY KEY) STRICT;' },
  ])
  try {
    storage.db.exec('BEGIN IMMEDIATE')
    assert.throws(() => storage.transaction.run(() => 1))
    storage.db.exec('ROLLBACK')
    storage.transaction.run(() => {
      storage.db.prepare('INSERT INTO example VALUES(1)').run()
      assert.throws(() =>
        storage.transaction.run(() => {
          storage.db.prepare('INSERT INTO example VALUES(2)').run()
          throw new Error('故障注入')
        }),
      )
      storage.db.prepare('INSERT INTO example VALUES(3)').run()
    })
    assert.deepEqual(
      storage.db
        .prepare('SELECT id FROM example ORDER BY id')
        .all()
        .map((row) => row.id),
      [1, 3],
    )
  } finally {
    storage.close()
  }
})

test('并发密码计算有界且限流后可以恢复', async (t) => {
  const f = await fixture(t)
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      f.system.identity.login({ username: `unknown${i}`, password }),
    ),
  )
  assert.equal(
    results.filter(
      (result) =>
        result.status === 'rejected' && (result.reason as { code: string }).code === 'RATE_LIMITED',
    ).length,
    12,
  )
  await assert.rejects(() => f.system.identity.login({ username: 'afterburst', password }), {
    code: 'UNAUTHENTICATED',
  })
})

test('必要审计失败回滚项目、成员、授权和幂等收据', async (t) => {
  const f = await fixture(t),
    db = new DatabaseSync(f.file)
  try {
    db.exec(
      "CREATE TRIGGER block_project_audit BEFORE INSERT ON audit_events WHEN NEW.action='project.create' BEGIN SELECT RAISE(ABORT,'故障注入'); END;",
    )
    assert.throws(() =>
      f.system.projects.create(f.admin.id, { name: '应回滚', description: '' }, randomUUID()),
    )
    for (const table of ['projects', 'project_members', 'access_grants', 'project_commands'])
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0)
    db.exec('DROP TRIGGER block_project_audit')
  } finally {
    db.close()
  }
  assert(
    f.system.projects.create(f.admin.id, { name: '恢复后成功', description: '' }, randomUUID()).id,
  )
})

test('升级校验、失败回滚及历史数据库拒绝', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoops-migrations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'schema.sqlite')
  openDatabase(file, migrations).close()
  assert.throws(
    () =>
      openDatabase(file, [
        { ...migrations[0]!, sql: migrations[0]!.sql + '\n-- 修改已应用升级' },
        ...migrations.slice(1),
      ]),
    /升级/,
  )
  assert.throws(() => openDatabase(file, migrations.slice(0, 2)), /未知/)
  const broken = path.join(directory, 'broken.sqlite')
  assert.throws(() =>
    openDatabase(broken, [migrations[0]!, { version: 2, name: '故障', sql: 'THIS IS NOT SQL' }]),
  )
  const db = new DatabaseSync(broken)
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n, 0)
  db.close()
  const legacy = path.join(directory, 'legacy.sqlite'),
    old = new DatabaseSync(legacy)
  old.exec('CREATE TABLE application_state (id INTEGER PRIMARY KEY,value TEXT)')
  old.close()
  assert.throws(() => openDatabase(legacy, migrations), /拒绝自动迁移/)
})

test('登录限流与运行配置拒绝不安全的默认外部来源', async (t) => {
  const f = await fixture(t)
  for (let i = 0; i < 10; i++)
    await assert.rejects(
      () => f.system.identity.login({ username: 'missing', password: '错误密码' }),
      { code: 'UNAUTHENTICATED' },
    )
  await assert.rejects(
    () => f.system.identity.login({ username: 'missing', password: '错误密码' }),
    { code: 'RATE_LIMITED' },
  )
  f.advance(61_000)
  await assert.rejects(
    () => f.system.identity.login({ username: 'missing', password: '错误密码' }),
    { code: 'UNAUTHENTICATED' },
  )
  assert.throws(() => readConfig({ AUTOOPS_PORT: '0' }))
  assert.throws(() => readConfig({ AUTOOPS_PUBLIC_ORIGIN: 'http://example.com' }))
  assert.equal(readConfig({ AUTOOPS_PUBLIC_ORIGIN: 'https://example.com' }).secureCookie, true)
})

test('Node HTTP 适配器真实监听并返回就绪与认证错误', async (t) => {
  const f = await fixture(t)
  const server = serve({ fetch: f.system.app.fetch, hostname: '127.0.0.1', port: 0 })
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  )
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  assert.equal((await fetch(base + '/health/ready')).status, 200)
  assert.equal((await fetch(base + '/api/v1/projects')).status, 401)
})
