import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { createProjectCredentialService } from '../credentials.ts'
import { createEnvironmentMcp } from './index.ts'

const project = 'project-one',
  environment = 'env-test',
  actor = 'admin'
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'autoops-environment-mcp-'))
  const permission = { manage: true, query: true, credential: true }
  const authorize = (kind, user, p, env) => {
    if (
      p !== project ||
      ![environment, 'env-prod', null].includes(env) ||
      (kind === 'manage' && (user !== actor || !permission.manage)) ||
      (kind === 'query' && (!['admin', 'reader', 'other'].includes(user) || !permission.query))
    )
      throw Object.assign(new Error('当前操作者无权访问此环境'), {
        status: 403,
        code: 'TEST_ENVIRONMENT_FORBIDDEN',
      })
  }
  const credentials = createProjectCredentialService({
    databasePath: join(dataDir, 'credentials.sqlite'),
    keyPath: join(dataDir, 'credential.key'),
    initializeKeyIfNew: true,
    authorize(user, p, action) {
      if (
        !permission.credential ||
        p !== project ||
        (action === 'credential.manage' && user !== actor)
      )
        throw Object.assign(new Error('凭证操作未授权'), {
          status: 403,
          code: 'TEST_CREDENTIAL_FORBIDDEN',
        })
    },
  })
  const credential = credentials.create(actor, project, {
    requestId: 'credential-create',
    name: '隔离凭证',
    username: 'fixture-user',
    password: 'fixture-secret-not-real',
  })
  const control = {
    test: undefined,
    execute: undefined,
    testFailure: undefined,
    result: { data: { value: '真实端口结果' }, truncated: false },
  }
  const calls = { test: [], execute: [], close: 0 }
  const driver = {
    async test(configuration, secret, context) {
      calls.test.push({
        configuration: structuredClone(configuration),
        username: secret?.username,
        password: secret?.password,
        context,
      })
      if (control.test) await control.test(configuration, context)
      if (control.testFailure) throw control.testFailure
      return {
        actions:
          configuration.type === 'server'
            ? ['server.snapshot', 'server.service', 'server.read']
            : configuration.type === 'mysql'
              ? ['mysql.tables', 'mysql.describe', 'mysql.query', 'mysql.explain']
              : ['redis.scan', 'redis.read', 'redis.ttl'],
      }
    },
    async execute(configuration, operation, secret, context) {
      calls.execute.push({
        configuration: structuredClone(configuration),
        operation: structuredClone(operation),
        password: secret?.password,
        context,
      })
      if (control.execute) await control.execute(configuration, operation, context)
      return control.result
    },
    async close() {
      calls.close++
    },
  }
  const settings = {
    dataDir,
    credentials,
    drivers: { server: driver, mysql: driver, redis: driver },
    authorizeManage: (user, p, env) => authorize('manage', user, p, env),
    authorizeQuery: (user, p, env) => authorize('query', user, p, env),
    ...options,
  }
  let service = createEnvironmentMcp(settings),
    sequence = 0
  const request = (expectedRevision) => ({ requestId: `request-${++sequence}`, expectedRevision })
  const config = (type = 'mysql') =>
    type === 'mysql'
      ? {
          type,
          name: '环境数据库',
          host: 'mysql.fixture.invalid',
          port: 3306,
          database: 'business',
          tls: 'required',
          credentialId: credential.id,
        }
      : type === 'server'
        ? {
            type,
            name: '环境服务器',
            host: 'server.fixture.invalid',
            port: 22,
            credentialId: credential.id,
            hostKeySha256: `SHA256:${'a'.repeat(43)}`,
            readPaths: ['/srv/project/logs'],
            serviceUnits: ['project.service'],
          }
        : {
            type,
            name: '环境缓存',
            host: 'redis.fixture.invalid',
            port: 6379,
            database: 0,
            tls: 'disabled',
            keyPatterns: ['project:*'],
            credentialId: credential.id,
          }
  const ready = async (type = 'mysql') => {
    const value = service.save(project, environment, { ...request(0), value: config(type) }, actor)
    await service.testConnection(project, environment, value.id, request(value.revision), actor)
    return service.setEnabled(
      project,
      environment,
      value.id,
      { ...request(value.revision), enabled: true },
      actor,
    )
  }
  const scope = (runId = 'run-one', user = 'reader', env = environment) => ({
    actorId: user,
    projectId: project,
    environmentId: env,
    threadId: 'thread-one',
    runId,
  })
  t.after(async () => {
    await service.close()
    await credentials.drain()
    credentials.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return {
    dataDir,
    permission,
    credentials,
    credential,
    control,
    calls,
    request,
    config,
    ready,
    scope,
    get service() {
      return service
    },
    async reopen() {
      await service.close()
      service = createEnvironmentMcp(settings)
      return service
    },
  }
}

test('环境唯一归属、配置修订及原请求收据使用真实 SQLite，不接受正文身份和秘密字段', async (t) => {
  const f = await fixture(t),
    command = { ...f.request(0), value: f.config() }
  const value = f.service.save(project, environment, command, actor)
  assert.equal(value.enabled, false)
  assert.deepEqual(f.service.save(project, environment, command, actor), value)
  assert.equal(f.service.list(project, environment, actor).length, 1)
  assert.throws(
    () =>
      f.service.save(
        project,
        environment,
        { ...command, value: { ...command.value, database: 'changed' } },
        actor,
      ),
    { code: 'ENVIRONMENT_MCP_REQUEST_CONFLICT' },
  )
  assert.throws(
    () =>
      f.service.save(
        project,
        environment,
        { ...f.request(0), value: f.config(), actorId: 'admin' },
        actor,
      ),
    { code: 'ENVIRONMENT_MCP_INPUT_INVALID' },
  )
  assert.throws(
    () =>
      f.service.save(
        project,
        environment,
        { ...f.request(0), value: { ...f.config(), password: 'never-store-this' } },
        actor,
      ),
    { code: 'ENVIRONMENT_MCP_INPUT_INVALID' },
  )
  assert.throws(() => f.service.list(project, environment, 'reader'), {
    code: 'TEST_ENVIRONMENT_FORBIDDEN',
  })
  assert.throws(
    () =>
      f.service.save(project, 'env-prod', { ...f.request(1), value: f.config() }, actor, value.id),
    { code: 'ENVIRONMENT_MCP_NOT_FOUND' },
  )
  assert.throws(
    () =>
      f.service.save(
        project,
        environment,
        { ...f.request(0), value: { ...f.config(), host: 'https://invalid/' } },
        actor,
      ),
    { code: 'ENVIRONMENT_MCP_CONFIGURATION_INVALID' },
  )
  assert.throws(
    () =>
      f.service.save(project, environment, { ...f.request(0), value: f.config() }, actor, value.id),
    { code: 'ENVIRONMENT_MCP_REVISION_CONFLICT' },
  )
  const updated = f.service.save(
    project,
    environment,
    { ...f.request(1), value: { ...f.config(), name: '新名称' } },
    actor,
    value.id,
  )
  assert.equal(updated.revision, 2)
  assert.deepEqual(f.service.receipt(project, environment, command.requestId, actor).result, value)
  f.permission.manage = false
  assert.throws(() => f.service.save(project, environment, command, actor), {
    code: 'TEST_ENVIRONMENT_FORBIDDEN',
  })
})

test('启用必须验证同配置及凭证版本，失败原请求不重新联网且不保存原始驱动错误', async (t) => {
  const f = await fixture(t),
    value = f.service.save(project, environment, { ...f.request(0), value: f.config() }, actor)
  assert.throws(
    () =>
      f.service.setEnabled(
        project,
        environment,
        value.id,
        { ...f.request(1), enabled: true },
        actor,
      ),
    { code: 'ENVIRONMENT_MCP_TEST_REQUIRED' },
  )
  const command = f.request(1)
  f.control.testFailure = new Error('password=fixture-secret-not-real and private-driver-object')
  await assert.rejects(f.service.testConnection(project, environment, value.id, command, actor), {
    code: 'ENVIRONMENT_MCP_CONNECTION_FAILED',
  })
  const receipt = f.service.receipt(project, environment, command.requestId, actor)
  assert.equal(receipt.status, 'failed')
  assert.ok(!JSON.stringify(receipt).includes('fixture-secret-not-real'))
  await assert.rejects(f.service.testConnection(project, environment, value.id, command, actor), {
    code: 'ENVIRONMENT_MCP_CONNECTION_FAILED',
  })
  assert.equal(f.calls.test.length, 1)
  f.control.testFailure = undefined
  await f.service.testConnection(project, environment, value.id, f.request(1), actor)
  f.credentials.replace(actor, project, f.credential.id, {
    requestId: 'credential-replace',
    expectedRevision: 1,
    username: 'fixture-user',
    password: 'second-secret-not-real',
  })
  assert.throws(
    () =>
      f.service.setEnabled(
        project,
        environment,
        value.id,
        { ...f.request(1), enabled: true },
        actor,
      ),
    { code: 'ENVIRONMENT_MCP_TEST_REQUIRED' },
  )
  await f.service.testConnection(project, environment, value.id, f.request(1), actor)
  assert.equal(
    f.service.setEnabled(project, environment, value.id, { ...f.request(1), enabled: true }, actor)
      .enabled,
    true,
  )
  const bytes = await readFile(join(f.dataDir, 'environment-mcp', 'state.sqlite'))
  assert.ok(!bytes.includes(Buffer.from('fixture-secret-not-real')))
})

test('新轮固定连接及凭证版本，编辑仅影响新轮，目录不返回地址和凭证引用', async (t) => {
  const f = await fixture(t),
    value = await f.ready(),
    firstScope = f.scope(),
    first = f.service.prepareRun(firstScope)
  assert.equal(first.connections[0].revision, 2)
  assert.ok(!JSON.stringify(first).includes('fixture.invalid'))
  assert.ok(!JSON.stringify(first).includes(f.credential.id))
  const changed = f.service.save(
    project,
    environment,
    { ...f.request(2), value: { ...f.config(), host: 'next.fixture.invalid', database: 'next' } },
    actor,
    value.id,
  )
  f.credentials.replace(actor, project, f.credential.id, {
    requestId: 'rotate-after-first',
    expectedRevision: 1,
    username: 'fixture-user',
    password: 'new-secret-not-real',
  })
  await f.service.testConnection(project, environment, value.id, f.request(changed.revision), actor)
  const nextScope = f.scope('run-two'),
    next = f.service.prepareRun(nextScope)
  assert.equal(next.connections[0].revision, 3)
  assert.deepEqual(f.service.prepareRun(firstScope), first)
  const operation = { connectionId: value.id, action: 'mysql.query', sql: 'SELECT 1' }
  const oldResult = await f.service.invoke(firstScope, operation),
    newResult = await f.service.invoke(nextScope, operation)
  assert.equal(oldResult.source, 'environment_mcp')
  assert.equal(oldResult.connectionRevision, 2)
  assert.equal(newResult.connectionRevision, 3)
  assert.deepEqual(
    f.calls.execute.map((call) => [call.configuration.database, call.password]),
    [
      ['business', 'fixture-secret-not-real'],
      ['next', 'new-secret-not-real'],
    ],
  )
  await f.reopen()
  assert.deepEqual(f.service.readRun(firstScope), first)
  await f.service.invoke(firstScope, operation)
  assert.equal(f.calls.execute.at(-1).configuration.database, 'business')
})

test('无环境轮次持久为空，不自动选环境，真实调用者及轮次范围不得替换', async (t) => {
  const f = await fixture(t),
    scope = f.scope('no-environment', 'reader', null)
  const empty = f.service.prepareRun(scope),
    value = await f.ready()
  assert.equal(empty.environmentId, null)
  assert.deepEqual(empty.connections, [])
  assert.deepEqual(f.service.prepareRun(scope), empty)
  await assert.rejects(
    f.service.invoke(scope, { connectionId: value.id, action: 'mysql.tables' }),
    { code: 'ENVIRONMENT_MCP_CONNECTION_FORBIDDEN' },
  )
  assert.throws(() => f.service.readRun({ ...scope, environmentId: environment }), {
    code: 'ENVIRONMENT_MCP_RUN_FORBIDDEN',
  })
  assert.throws(() => f.service.readRun({ ...scope, actorId: 'other' }), {
    code: 'ENVIRONMENT_MCP_RUN_FORBIDDEN',
  })
  await assert.rejects(
    f.service.invoke(f.scope('not-prepared'), { connectionId: value.id, action: 'mysql.tables' }),
    { code: 'ENVIRONMENT_MCP_RUN_MISSING' },
  )
  assert.equal(f.calls.execute.length, 0)
})

test('停用、撤销凭证及移除拒绝旧轮新调用；删除清理历史配置', async (t) => {
  const f = await fixture(t),
    value = await f.ready(),
    scope = f.scope(),
    operation = { connectionId: value.id, action: 'mysql.tables' }
  f.service.prepareRun(scope)
  const disabledCommand = { ...f.request(2), enabled: false },
    disabled = f.service.setEnabled(project, environment, value.id, disabledCommand, actor)
  await assert.rejects(f.service.invoke(scope, operation), { code: 'ENVIRONMENT_MCP_DISABLED' })
  const enabled = f.service.setEnabled(
    project,
    environment,
    value.id,
    { ...f.request(disabled.revision), enabled: true },
    actor,
  )
  f.credentials.revoke(actor, project, f.credential.id, {
    requestId: 'revoke-credential',
    expectedRevision: 1,
  })
  await assert.rejects(f.service.invoke(scope, operation), { code: 'CREDENTIAL_REVOKED' })
  const removed = f.service.remove(
    project,
    environment,
    value.id,
    f.request(enabled.revision),
    actor,
  )
  assert.equal(removed.removed, true)
  await assert.rejects(f.service.invoke(scope, operation), {
    code: 'ENVIRONMENT_MCP_CONNECTION_FORBIDDEN',
  })
  assert.throws(() => f.service.setEnabled(project, environment, value.id, disabledCommand, actor))
  const db = new DatabaseSync(join(f.dataDir, 'environment-mcp', 'state.sqlite'), {
    readOnly: true,
  })
  try {
    for (const table of [
      'mcp_connections',
      'mcp_connection_versions',
      'mcp_connection_tests',
      'mcp_audit',
    ])
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table)
    const receipts = db.prepare('SELECT result FROM mcp_receipts').all()
    assert.equal(receipts.length, 1)
    assert.deepEqual(JSON.parse(receipts[0].result), removed)
    assert.equal(JSON.stringify(receipts).includes('mysql.fixture.invalid'), false)
  } finally {
    db.close()
  }
  assert.equal(f.calls.execute.length, 0)
})

test('读取期间撤权或停用拒绝迟到结果，不声称远端已经停止', async (t) => {
  const f = await fixture(t),
    value = await f.ready(),
    scope = f.scope(),
    operation = { connectionId: value.id, action: 'mysql.tables' }
  f.service.prepareRun(scope)
  let entered = deferred(),
    release = deferred()
  f.control.execute = () => {
    entered.resolve()
    return release.promise
  }
  const denied = f.service.invoke(scope, operation)
  await entered.promise
  f.permission.query = false
  release.resolve()
  await assert.rejects(denied, { code: 'TEST_ENVIRONMENT_FORBIDDEN' })
  f.permission.query = true
  entered = deferred()
  release = deferred()
  const disabled = f.service.invoke(scope, operation)
  await entered.promise
  f.service.setEnabled(project, environment, value.id, { ...f.request(2), enabled: false }, actor)
  release.resolve()
  await assert.rejects(disabled, { code: 'ENVIRONMENT_MCP_DISABLED' })
  assert.equal(f.calls.execute.length, 2)
})

test('测试期间修改配置或凭证不把旧测试证明应用到新配置', async (t) => {
  const f = await fixture(t),
    value = f.service.save(project, environment, { ...f.request(0), value: f.config() }, actor)
  let entered = deferred(),
    release = deferred()
  f.control.test = () => {
    entered.resolve()
    return release.promise
  }
  const original = f.service.testConnection(project, environment, value.id, f.request(1), actor)
  await entered.promise
  f.service.save(
    project,
    environment,
    { ...f.request(1), value: { ...f.config(), database: 'new' } },
    actor,
    value.id,
  )
  release.resolve()
  await assert.rejects(original, { code: 'ENVIRONMENT_MCP_REVISION_CONFLICT' })
  assert.equal(f.service.list(project, environment, actor)[0].lastTest, undefined)
  entered = deferred()
  release = deferred()
  const rotated = f.service.testConnection(project, environment, value.id, f.request(2), actor)
  await entered.promise
  f.credentials.replace(actor, project, f.credential.id, {
    requestId: 'during-test-rotate',
    expectedRevision: 1,
    username: 'fixture-user',
    password: 'new-secret-not-real',
  })
  release.resolve()
  await assert.rejects(rotated, { code: 'ENVIRONMENT_MCP_CREDENTIAL_CHANGED' })
})

test('固定只读动作与 Server/Redis 范围在驱动前拒绝越界和字段篡改', async (t) => {
  const f = await fixture(t),
    server = await f.ready('server'),
    redis = await f.ready('redis'),
    scope = f.scope()
  f.service.prepareRun(scope)
  for (const operation of [
    { connectionId: server.id, action: 'server.execute', command: 'touch /tmp/no' },
    { connectionId: server.id, action: 'server.snapshot', actorId: 'admin' },
    { connectionId: redis.id, action: 'redis.write', key: 'project:x', value: 'no' },
  ])
    await assert.rejects(f.service.invoke(scope, operation), {
      code: 'ENVIRONMENT_MCP_INPUT_INVALID',
    })
  for (const operation of [
    {
      connectionId: server.id,
      action: 'server.read',
      path: '/etc/passwd',
      offset: 0,
      maxBytes: 100,
    },
    {
      connectionId: server.id,
      action: 'server.read',
      path: '/srv/project/logs/../secret',
      offset: 0,
      maxBytes: 100,
    },
    { connectionId: server.id, action: 'server.service', unit: 'foreign.service' },
    { connectionId: redis.id, action: 'redis.scan', pattern: '*', cursor: '0', limit: 10 },
    { connectionId: redis.id, action: 'redis.read', key: 'other:x' },
  ])
    await assert.rejects(f.service.invoke(scope, operation), {
      code: 'ENVIRONMENT_MCP_SCOPE_FORBIDDEN',
    })
  assert.equal(f.calls.execute.length, 0)
  await f.service.invoke(scope, {
    connectionId: server.id,
    action: 'server.read',
    path: '/srv/project/logs/app.log',
    offset: 0,
    maxBytes: 100,
  })
  await f.service.invoke(scope, {
    connectionId: redis.id,
    action: 'redis.read',
    key: 'project:one',
  })
  assert.equal(f.calls.execute.length, 2)
})

test('超时和取消保留未结束读取的并发及排空责任，结果上限不伪装为完整数据', async (t) => {
  const f = await fixture(t, { timeoutMs: 30 }),
    value = await f.ready(),
    scope = f.scope()
  f.service.prepareRun(scope)
  const gate = deferred(),
    entered = deferred()
  f.control.execute = (_configuration, _operation, context) => {
    entered.resolve(context)
    return gate.promise
  }
  const reading = f.service.invoke(scope, { connectionId: value.id, action: 'mysql.tables' })
  const context = await entered.promise
  await assert.rejects(reading, { code: 'ENVIRONMENT_MCP_TIMEOUT' })
  assert.equal(context.signal.aborted, true)
  let drained = false
  const drain = f.service.drain().then(() => {
    drained = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(drained, false)
  gate.resolve()
  await drain
  f.control.execute = undefined
  f.control.result = { data: 'x'.repeat(262145), truncated: false }
  await assert.rejects(
    f.service.invoke(scope, { connectionId: value.id, action: 'mysql.tables' }),
    { code: 'ENVIRONMENT_MCP_RESULT_LIMIT' },
  )
  f.control.result = { data: { count: 1 }, truncated: true }
  assert.equal(
    (await f.service.invoke(scope, { connectionId: value.id, action: 'mysql.tables' })).truncated,
    true,
  )
})

test('相同测试请求合并且篡改拒绝，重启后未知测试明确中断不自动重发', async (t) => {
  const f = await fixture(t),
    value = f.service.save(project, environment, { ...f.request(0), value: f.config() }, actor)
  const entered = deferred(),
    gate = deferred(),
    command = f.request(1)
  f.control.test = () => {
    entered.resolve()
    return gate.promise
  }
  const first = f.service.testConnection(project, environment, value.id, command, actor)
  await entered.promise
  const repeated = f.service.testConnection(project, environment, value.id, command, actor)
  await assert.rejects(
    f.service.testConnection(
      project,
      environment,
      value.id,
      { ...command, expectedRevision: 2 },
      actor,
    ),
    { code: 'ENVIRONMENT_MCP_REQUEST_CONFLICT' },
  )
  gate.resolve()
  assert.deepEqual(await first, await repeated)
  assert.equal(f.calls.test.length, 1)
  const database = new DatabaseSync(join(f.dataDir, 'environment-mcp', 'state.sqlite'))
  database
    .prepare("UPDATE mcp_receipts SET status='pending',result=NULL,error=NULL WHERE request_id=?")
    .run(command.requestId)
  database.close()
  await f.reopen()
  assert.equal(
    f.service.receipt(project, environment, command.requestId, actor).error.code,
    'ENVIRONMENT_MCP_TEST_INTERRUPTED',
  )
  await assert.rejects(f.service.testConnection(project, environment, value.id, command, actor), {
    code: 'ENVIRONMENT_MCP_TEST_INTERRUPTED',
  })
  assert.equal(f.calls.test.length, 1)
})

test('缺少真实驱动时拒绝测试，配置不被伪造为可用', async (t) => {
  const f = await fixture(t, { drivers: {} }),
    value = f.service.save(project, environment, { ...f.request(0), value: f.config() }, actor)
  await assert.rejects(
    f.service.testConnection(project, environment, value.id, f.request(1), actor),
    { code: 'ENVIRONMENT_MCP_DRIVER_UNAVAILABLE' },
  )
  assert.equal(f.service.list(project, environment, actor)[0].enabled, false)
  assert.throws(
    () =>
      f.service.setEnabled(
        project,
        environment,
        value.id,
        { ...f.request(1), enabled: true },
        actor,
      ),
    { code: 'ENVIRONMENT_MCP_TEST_REQUIRED' },
  )
})

test('驱动不能提供未登记的写入能力证明', async (t) => {
  const driver = {
    test: async () => ({ actions: ['mysql.query', 'mysql.write'] }),
    execute: async () => {
      throw Error('不执行')
    },
    close() {},
  }
  const f = await fixture(t, { drivers: { mysql: driver } }),
    value = f.service.save(project, environment, { ...f.request(0), value: f.config() }, actor)
  await assert.rejects(
    f.service.testConnection(project, environment, value.id, f.request(1), actor),
    { code: 'ENVIRONMENT_MCP_VERIFICATION_INVALID' },
  )
  assert.equal(f.service.list(project, environment, actor)[0].lastTest.status, 'failed')
})

test('测试期间撤权返回真实授权拒绝，持久收据不包含原授权异常细节', async (t) => {
  const f = await fixture(t),
    value = f.service.save(project, environment, { ...f.request(0), value: f.config() }, actor)
  const entered = deferred(),
    gate = deferred(),
    command = f.request(1)
  f.control.test = () => {
    entered.resolve()
    return gate.promise
  }
  const testing = f.service.testConnection(project, environment, value.id, command, actor)
  await entered.promise
  f.permission.manage = false
  gate.resolve()
  await assert.rejects(testing, { code: 'TEST_ENVIRONMENT_FORBIDDEN', status: 403 })
  f.permission.manage = true
  assert.equal(
    f.service.receipt(project, environment, command.requestId, actor).error.code,
    'ENVIRONMENT_MCP_ACCESS_CHANGED',
  )
})

test('单个撤销凭证的连接明确不可用，不关闭同环境其他可用连接', async (t) => {
  const f = await fixture(t),
    mysql = await f.ready('mysql')
  const redisConfig = { ...f.config('redis') }
  delete redisConfig.credentialId
  const redis = f.service.save(project, environment, { ...f.request(0), value: redisConfig }, actor)
  await f.service.testConnection(project, environment, redis.id, f.request(1), actor)
  f.service.setEnabled(project, environment, redis.id, { ...f.request(1), enabled: true }, actor)
  f.credentials.revoke(actor, project, f.credential.id, {
    requestId: 'revoke-one-resource',
    expectedRevision: 1,
  })
  const catalog = f.service.prepareRun(f.scope())
  assert.deepEqual(
    catalog.connections.map((value) => value.id),
    [redis.id],
  )
  assert.equal(catalog.unavailable[0].id, mysql.id)
  assert.equal(catalog.unavailable[0].code, 'CREDENTIAL_REVOKED')
})

test('删除引用摘要只暴露阻止原因，停用连接与未知测试阻止，终态释放后历史不永久阻止', async (t) => {
  const f = await fixture(t),
    value = await f.ready(),
    scope = f.scope()
  assert.deepEqual(f.service.deletionReferences(project), [
    { kind: 'environment-mcp-connections', count: 1, message: '仍有未移除的环境连接' },
  ])
  f.service.prepareRun(scope)
  const disabled = f.service.setEnabled(
    project,
    environment,
    value.id,
    { ...f.request(2), enabled: false },
    actor,
  )
  assert.equal(
    f.service
      .deletionReferences(project, environment)
      .some((value) => value.kind === 'environment-mcp-connections'),
    true,
  )
  f.service.remove(project, environment, value.id, f.request(disabled.revision), actor)
  assert.deepEqual(
    f.service.deletionReferences(project, environment).map((value) => value.kind),
    ['environment-mcp-runs'],
  )
  f.service.releaseRun(scope)
  assert.equal(f.service.readRun(scope).status, 'released')
  assert.deepEqual(f.service.deletionReferences(project, environment), [])
  await assert.rejects(
    f.service.invoke(scope, { connectionId: value.id, action: 'mysql.tables' }),
    { code: 'ENVIRONMENT_MCP_RUN_RELEASED' },
  )
  assert.deepEqual(f.service.deletionReferences('another-project'), [])
})

test('恢复先固定原轮连接和旧凭证，新调用者仍查当前授权，原输入缺失不补最新', async (t) => {
  const f = await fixture(t),
    value = await f.ready(),
    original = f.scope()
  f.service.prepareRun(original)
  f.service.releaseRun(original)
  f.service.save(
    project,
    environment,
    { ...f.request(2), value: { ...f.config(), database: 'next-database' } },
    actor,
    value.id,
  )
  await f.service.testConnection(project, environment, value.id, f.request(3), actor)
  const restored = f.scope('restore-run', 'other')
  const fixed = f.service.prepareRun(restored, original.runId)
  assert.equal(fixed.connections[0].scope.database, 'business')
  assert.equal(fixed.connections[0].revision, 2)
  await f.service.invoke(restored, {
    connectionId: value.id,
    action: 'mysql.query',
    sql: 'SELECT 1',
  })
  assert.equal(f.calls.execute.at(-1).configuration.database, 'business')
  assert.throws(() => f.service.prepareRun(f.scope('missing-original'), 'absent'), {
    code: 'ENVIRONMENT_MCP_ORIGINAL_RUN_MISSING',
  })
  assert.throws(() => f.service.prepareRun(restored, 'another-original'), {
    code: 'ENVIRONMENT_MCP_RUN_CONFLICT',
  })
  assert.throws(
    () =>
      f.service.prepareRun(
        { ...restored, runId: 'other-environment', environmentId: 'env-prod' },
        original.runId,
      ),
    { code: 'ENVIRONMENT_MCP_RUN_FORBIDDEN' },
  )
  f.permission.query = false
  assert.throws(() => f.service.prepareRun(f.scope('revoked-restore', 'other'), original.runId), {
    code: 'TEST_ENVIRONMENT_FORBIDDEN',
  })
})

test('已取消输入返回稳定中断，关闭先等底层读取收尾再关闭驱动', async (t) => {
  const f = await fixture(t),
    value = await f.ready(),
    scope = f.scope(),
    operation = { connectionId: value.id, action: 'mysql.tables' }
  f.service.prepareRun(scope)
  const canceled = new AbortController()
  canceled.abort()
  await assert.rejects(f.service.invoke(scope, operation, canceled.signal), {
    code: 'ENVIRONMENT_MCP_READ_INTERRUPTED',
    status: 499,
  })
  const entered = deferred(),
    gate = deferred()
  f.control.execute = (_configuration, _operation, context) => {
    entered.resolve(context)
    return gate.promise
  }
  const reading = f.service.invoke(scope, operation)
  const context = await entered.promise
  const interrupted = assert.rejects(reading, { code: 'ENVIRONMENT_MCP_READ_INTERRUPTED' })
  let finished = false
  const closing = f.service.close().then(() => {
    finished = true
  })
  await interrupted
  assert.equal(context.signal.aborted, true)
  assert.equal(finished, false)
  assert.equal(f.calls.close, 0)
  assert.ok(
    f.service
      .deletionReferences(project, environment)
      .some((value) => value.kind === 'environment-mcp-reads'),
  )
  gate.resolve()
  await closing
  assert.equal(f.calls.close, 1)
  assert.throws(() => f.service.deletionReferences(project), { code: 'ENVIRONMENT_MCP_STOPPING' })
})

test('测试超时后仍未取得底层回执时，移除连接不能绕过删除引用保护', async (t) => {
  const f = await fixture(t, { timeoutMs: 20 }),
    value = f.service.save(project, environment, { ...f.request(0), value: f.config() }, actor)
  const entered = deferred(),
    gate = deferred()
  f.control.test = () => {
    entered.resolve()
    return gate.promise
  }
  const testing = f.service.testConnection(project, environment, value.id, f.request(1), actor)
  await entered.promise
  await assert.rejects(testing, { code: 'ENVIRONMENT_MCP_TIMEOUT' })
  f.service.remove(project, environment, value.id, f.request(1), actor)
  f.permission.manage = false
  assert.deepEqual(
    f.service.deletionReferences(project, environment).map((value) => value.kind),
    ['environment-mcp-tests'],
  )
  gate.resolve()
  await f.service.drain()
  assert.deepEqual(f.service.deletionReferences(project, environment), [])
})

test('Redis 复杂通配符及长 Key 的越界校验有界完成，不阻塞问答进程', () => {
  const policy = new URL('./policy.ts', import.meta.url).href
  const script = `import {validateOperation} from ${JSON.stringify(policy)};
    const configuration={type:'redis',keyPatterns:['*a'.repeat(100)+'b']};
    try{validateOperation(configuration,{action:'redis.read',key:'a'.repeat(1024)})}
    catch(error){if(error.code==='ENVIRONMENT_MCP_SCOPE_FORBIDDEN')process.exit(0);throw error}
    process.exit(1)`
  // 子进程预算使回归本身也有界，不让错误的匹配器挂住整个测试进程。
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 1000 })
})

test('必要审计失败时配置与原请求收据一起回滚，异步授权误接明确拒绝', async (t) => {
  const f = await fixture(t),
    command = { ...f.request(0), value: f.config() }
  const database = new DatabaseSync(join(f.dataDir, 'environment-mcp', 'state.sqlite'))
  database.exec(
    "CREATE TRIGGER fail_mcp_audit BEFORE INSERT ON mcp_audit BEGIN SELECT RAISE(ABORT,'隔离审计写入故障'); END",
  )
  assert.throws(() => f.service.save(project, environment, command, actor), /隔离审计写入故障/)
  assert.deepEqual(f.service.list(project, environment, actor), [])
  assert.equal(f.service.receipt(project, environment, command.requestId, actor), null)
  database.exec('DROP TRIGGER fail_mcp_audit')
  database.close()
  assert.equal(f.service.save(project, environment, command, actor).revision, 1)
  const invalid = await fixture(t, {
    authorizeManage: () => Promise.reject(new Error('异步拒绝不应泄露')),
  })
  assert.throws(
    () =>
      invalid.service.save(
        project,
        environment,
        { ...invalid.request(0), value: invalid.config() },
        actor,
      ),
    { code: 'ENVIRONMENT_MCP_AUTHORIZATION_INVALID' },
  )
  await new Promise((resolve) => setImmediate(resolve))
})


test('连接测试期间删除后，迟到结果不能重建测试或配置记录', async (t) => {
  const f = await fixture(t)
  const value = f.service.save(project, environment, { ...f.request(0), value: f.config() }, actor)
  const entered = deferred(), gate = deferred()
  f.control.test = () => { entered.resolve(); return gate.promise }
  const testing = f.service.testConnection(project, environment, value.id, f.request(1), actor)
  const rejected = assert.rejects(testing)
  await entered.promise
  f.service.remove(project, environment, value.id, f.request(1), actor)
  gate.resolve()
  await rejected
  await f.service.drain()
  assert.deepEqual(f.service.list(project, environment, actor), [])
  assert.deepEqual(f.service.deletionReferences(project, environment), [])
})
