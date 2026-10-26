import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import {
  createMysqlReadonlyDriver,
  validateReadonlySql,
} from '../agent-demo/t3-adapters/environment-mcp/drivers/mysql.ts'
import { createRedisReadonlyDriver } from '../agent-demo/t3-adapters/environment-mcp/drivers/redis.ts'
import { createServerReadonlyDriver } from '../agent-demo/t3-adapters/environment-mcp/drivers/server.ts'
const credential = { username: 'readonly-test', password: 'isolated-secret-never-log' }
const context = (signal = new AbortController().signal, limits = {}) => ({
  signal,
  limits: { timeoutMs: 1000, maxRows: 3, maxKeys: 3, maxBytes: 16384, ...limits },
})
const mysqlConfig = {
  type: 'mysql',
  name: '隔离只读库',
  host: 'isolated.invalid',
  port: 3306,
  credentialId: 'isolated-credential',
  database: 'app',
  tls: 'required',
}
const redisConfig = {
  type: 'redis',
  name: '隔离Redis',
  host: 'isolated.invalid',
  port: 6379,
  database: 2,
  tls: 'required',
  keyPatterns: ['app:*'],
}
function mysqlFixture({
  grants = [
    'GRANT USAGE ON *.* TO `readonly-test`@`%`',
    'GRANT SELECT, SHOW VIEW ON `app`.* TO `readonly-test`@`%`',
  ],
  readOnly = 1,
  rows = [{ id: 1 }],
  fail = false,
  wait = false,
} = {}) {
  const commands = [],
    connections = [],
    options = []
  let markRead
  const reading = new Promise((resolve) => {
    markRead = resolve
  })
  const connect = (value) => {
    options.push(value)
    const connection = new EventEmitter()
    connection.destroyed = 0
    connection.connect = (callback) => queueMicrotask(() => callback(null))
    connection.destroy = () => {
      connection.destroyed++
    }
    connection.query = (input, params) => {
      commands.push({ sql: input.sql, params })
      if (input.sql.startsWith('SELECT * FROM (')) markRead()
      const result = input.sql.startsWith('SHOW GRANTS')
        ? grants.map((value) => ({ grant: value }))
        : input.sql.startsWith('SELECT DATABASE()')
          ? [{ databaseName: 'app', readOnly }]
          : input.sql.startsWith('SELECT')
            ? rows
            : []
      return {
        stream: () =>
          fail
            ? new Readable({
                objectMode: true,
                read() {
                  this.destroy(new Error(credential.password))
                },
              })
            : wait && input.sql.startsWith('SELECT * FROM')
              ? new Readable({ objectMode: true, read() {} })
              : Readable.from(result, { objectMode: true }),
      }
    }
    connection.execute = connection.query
    connections.push(connection)
    return connection
  }
  return { connect, commands, connections, options, reading }
}

test('MySQL AST允许库内聚合和绑定参数，拒绝写、多语句、跨库、锁、变量及副作用函数', () => {
  assert.match(
    validateReadonlySql(
      'SELECT name, COUNT(*) AS count FROM app.logs WHERE id > ? GROUP BY name',
      'app',
    ),
    /SELECT/,
  )
  for (const sql of [
    'DELETE FROM logs',
    'SELECT 1; SELECT 2',
    'SELECT * FROM other.logs',
    'SELECT * FROM logs FOR UPDATE',
    'SELECT 1 INTO @x',
    'SELECT SLEEP(10)',
    'SELECT GET_LOCK("x", 1)',
    'SELECT LOAD_FILE("/etc/passwd")',
    'SELECT my_schema.custom_function()',
    'WITH RECURSIVE n AS (SELECT 1) SELECT * FROM n',
    'SELECT @secret',
  ])
    assert.throws(() => validateReadonlySql(sql, 'app'), { code: 'ENVIRONMENT_MCP_SQL_FORBIDDEN' })
  const normalized = validateReadonlySql('SELECT 1 /* ignored */', 'app')
  assert.equal(normalized.includes('ignored'), false)
})

test('MySQL真实只读能力检查与数据读取共用独立只读事务、目标库和有限流式返回', async () => {
  const f = mysqlFixture({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] }),
    driver = createMysqlReadonlyDriver({ connect: f.connect })
  const result = await driver.execute(
    mysqlConfig,
    {
      connectionId: 'mysql',
      action: 'mysql.query',
      sql: 'SELECT * FROM logs WHERE id > ?',
      params: [0],
    },
    credential,
    context(),
  )
  assert.deepEqual(result, { data: [{ id: 1 }, { id: 2 }, { id: 3 }], truncated: true })
  assert.equal(f.options[0].database, 'app')
  assert.equal(f.options[0].multipleStatements, false)
  assert.equal(f.options[0].ssl.rejectUnauthorized, true)
  assert.ok(f.commands.some((command) => command.sql === 'START TRANSACTION READ ONLY'))
  assert.ok(
    f.commands.some((command) => command.sql.startsWith('SET SESSION MAX_EXECUTION_TIME = ')),
  )
  assert.ok(
    f.commands.some(
      (command) => command.sql.startsWith('SELECT * FROM (SELECT') && command.params[0] === 0,
    ),
  )
  assert.ok(f.connections[0].destroyed > 0)
  const capabilities = await driver.test(mysqlConfig, credential, context())
  assert.ok(capabilities.actions.includes('mysql.query'))
  assert.ok(f.commands.some((command) => command.sql.includes('information_schema.TABLES')))
  await driver.close()
})

test('MySQL写账号、不可核验角色与未生效只读事务均拒绝，数据库异常不回传秘密', async () => {
  for (const args of [
    { grants: ['GRANT ALL PRIVILEGES ON `app`.* TO `x`@`%`'] },
    { grants: ['GRANT `reader_role`@`%` TO `x`@`%`'] },
    { readOnly: 0 },
    { fail: true },
  ]) {
    const f = mysqlFixture(args),
      driver = createMysqlReadonlyDriver({ connect: f.connect })
    await assert.rejects(driver.test(mysqlConfig, credential, context()), (error) => {
      assert.equal(error.message.includes(credential.password), false)
      return [
        'ENVIRONMENT_MCP_READONLY_ACCOUNT_REQUIRED',
        'ENVIRONMENT_MCP_READONLY_UNAVAILABLE',
        'ENVIRONMENT_MCP_CONNECTION_FAILED',
      ].includes(error.code)
    })
    assert.equal(
      f.commands.some((command) => command.sql.startsWith('SELECT * FROM (')),
      false,
    )
    await driver.close()
  }
})

test('MySQL取消与关闭销毁本次连接并排空，关闭后不重连', async () => {
  const f = mysqlFixture({ wait: true }),
    driver = createMysqlReadonlyDriver({ connect: f.connect }),
    controller = new AbortController()
  const work = driver.execute(
    mysqlConfig,
    { connectionId: 'mysql', action: 'mysql.query', sql: 'SELECT * FROM logs' },
    credential,
    context(controller.signal),
  )
  await f.reading
  controller.abort()
  await assert.rejects(work, { code: 'ENVIRONMENT_MCP_READ_INTERRUPTED' })
  assert.ok(f.connections[0].destroyed > 0)
  await driver.close()
  await assert.rejects(driver.test(mysqlConfig, credential, context()), {
    code: 'ENVIRONMENT_MCP_DRIVER_CLOSED',
  })
  assert.equal(f.connections.length, 1)
})

function redisFixture({ fail = false, wait = false } = {}) {
  const commands = [],
    options = [],
    clients = []
  let markCommand
  const firstCommand = new Promise((resolve) => {
    markCommand = resolve
  })
  const connect = (value) => {
    options.push(value)
    const client = new EventEmitter()
    client.destroyed = 0
    client.connect = async () => {}
    client.destroy = () => {
      client.destroyed++
    }
    client.sendCommand = async (args) => {
      commands.push(args)
      markCommand()
      if (fail) throw new Error(credential.password)
      if (wait) return new Promise(() => {})
      if (args[0] === 'SCAN')
        return args[1] === '0'
          ? ['19', ['app:one', 'app:two', 'private:deny']]
          : ['0', ['app:three']]
      if (args[0] === 'TYPE') return 'string'
      if (args[0] === 'TTL') return 60
      if (args[0] === 'STRLEN') return 5
      if (args[0] === 'GETRANGE') return 'hello'
      throw new Error('隔离测试不接受未声明命令')
    }
    clients.push(client)
    return client
  }
  return { connect, commands, options, clients, firstCommand }
}

test('Redis只发送结构化只读命令，绑定数据库、TLS和Key范围，不重连', async () => {
  const f = redisFixture(),
    driver = createRedisReadonlyDriver({ connect: f.connect })
  const result = await driver.execute(
    redisConfig,
    { connectionId: 'redis', action: 'redis.read', key: 'app:one' },
    credential,
    context(),
  )
  assert.equal(result.data.value, 'hello')
  assert.equal(f.options[0].database, 2)
  assert.equal(f.options[0].socket.reconnectStrategy, false)
  assert.equal(f.options[0].socket.rejectUnauthorized, true)
  assert.equal(f.options[0].disableOfflineQueue, true)
  assert.equal(f.options[0].maintNotifications, 'disabled')
  await assert.rejects(
    driver.execute(
      redisConfig,
      { connectionId: 'redis', action: 'redis.read', key: 'private:deny' },
      credential,
      context(),
    ),
    { code: 'ENVIRONMENT_MCP_SCOPE_FORBIDDEN' },
  )
  await driver.test(redisConfig, credential, context())
  assert.ok(f.commands.some((args) => args[0] === 'SCAN'))
  assert.ok(f.commands.some((args) => args[0] === 'TTL'))
  assert.ok(
    f.commands.every((args) => ['TYPE', 'STRLEN', 'GETRANGE', 'SCAN', 'TTL'].includes(args[0])),
  )
  assert.ok(f.clients.every((client) => client.destroyed > 0))
  await driver.close()
})

test('Redis分页游标仅属于当前连接和范围，不能猜测、跨连接或过期后恢复', async () => {
  const f = redisFixture()
  let now = 1000
  const driver = createRedisReadonlyDriver({ connect: f.connect, now: () => now })
  const operation = {
    connectionId: 'redis',
    action: 'redis.scan',
    pattern: 'app:*',
    cursor: '0',
    limit: 1,
  }
  const first = await driver.execute(redisConfig, operation, credential, context())
  assert.deepEqual(first.data.keys, ['app:one'])
  assert.match(first.data.cursor, /^\d+$/)
  assert.notEqual(first.data.cursor, '19')
  await assert.rejects(
    driver.execute(redisConfig, { ...operation, cursor: '19' }, credential, context()),
    { code: 'ENVIRONMENT_MCP_CURSOR_INVALID' },
  )
  await assert.rejects(
    driver.execute(
      redisConfig,
      { ...operation, connectionId: 'other', cursor: first.data.cursor },
      credential,
      context(),
    ),
    { code: 'ENVIRONMENT_MCP_CURSOR_INVALID' },
  )
  const second = await driver.execute(
    redisConfig,
    { ...operation, cursor: first.data.cursor },
    credential,
    context(),
  )
  assert.deepEqual(second.data.keys, ['app:two'])
  const final = await driver.execute(
    redisConfig,
    { ...operation, cursor: second.data.cursor },
    credential,
    context(),
  )
  assert.deepEqual(final.data, { keys: ['app:three'], cursor: '0' })
  now += 300001
  await assert.rejects(
    driver.execute(redisConfig, { ...operation, cursor: first.data.cursor }, credential, context()),
    { code: 'ENVIRONMENT_MCP_CURSOR_INVALID' },
  )
  await driver.close()
})

test('Redis错误脱敏、取消与关闭均释放连接，不自动恢复命令', async () => {
  const f = redisFixture({ fail: true }),
    driver = createRedisReadonlyDriver({ connect: f.connect })
  await assert.rejects(
    driver.test(redisConfig, credential, context()),
    (error) =>
      !error.message.includes(credential.password) &&
      error.code === 'ENVIRONMENT_MCP_CONNECTION_FAILED',
  )
  await driver.close()
  const hanging = redisFixture({ wait: true }),
    interrupted = createRedisReadonlyDriver({ connect: hanging.connect })
  const work = interrupted.test(redisConfig, credential, context())
  await hanging.firstCommand
  await interrupted.close()
  await assert.rejects(work, { code: 'ENVIRONMENT_MCP_READ_INTERRUPTED' })
  assert.ok(hanging.clients[0].destroyed > 0)
})

const hostKey = Buffer.from('isolated-host-key')
const serverConfig = {
  type: 'server',
  name: '隔离服务器',
  host: 'isolated.invalid',
  port: 22,
  credentialId: 'credential',
  hostKeySha256:
    'SHA256:' + createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, ''),
  readPaths: ['/data'],
  serviceUnits: ['app.service'],
}
function serverFixture({
  symlink = false,
  special = false,
  wrongHost = false,
  fail = false,
  wait = false,
} = {}) {
  let markCommand
  const firstCommand = new Promise((resolve) => {
    markCommand = resolve
  })
  const clients = [],
    commands = [],
    paths = [],
    files = Buffer.from('hello isolated file')
  const stat = (path = '/data/log') => ({
    size: files.length,
    mtime: 1000,
    isFile: () => path !== '/data' && !special,
    isDirectory: () => path === '/data',
    isSymbolicLink: () => symlink && path === '/data/log',
  })
  const sftp = {
    lstat(path, callback) {
      paths.push(path)
      queueMicrotask(() => callback(null, stat(path)))
    },
    realpath(path, callback) {
      queueMicrotask(() => callback(null, path))
    },
    open(path, flags, callback) {
      assert.equal(flags, 'r')
      queueMicrotask(() => callback(null, Buffer.from(path)))
    },
    opendir(path, callback) {
      queueMicrotask(() => callback(null, Buffer.from(path)))
    },
    readdir(_handle, callback) {
      queueMicrotask(() => callback(null, []))
    },
    fstat(_handle, callback) {
      queueMicrotask(() => callback(null, stat()))
    },
    read(_handle, buffer, offset, length, position, callback) {
      const bytes = files.copy(buffer, offset, position, position + length)
      queueMicrotask(() => callback(null, bytes, buffer))
    },
    close(_handle, callback) {
      queueMicrotask(() => callback(null))
    },
    end() {},
  }
  const client = () => {
    const connection = new EventEmitter()
    connection.destroyed = 0
    connection.connect = (options) => {
      queueMicrotask(() => {
        if (fail) connection.emit('error', new Error(credential.password))
        else if (!options.hostVerifier(wrongHost ? Buffer.from('another-host') : hostKey))
          connection.emit('error', new Error('host key rejected'))
        else connection.emit('ready')
      })
      return connection
    }
    connection.destroy = () => {
      connection.destroyed++
      connection.emit('close')
    }
    connection.sftp = (callback) => queueMicrotask(() => callback(null, sftp))
    connection.exec = (command, _options, callback) => {
      commands.push(command)
      markCommand()
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.close = () => stream.emit('close', 0)
      callback(null, stream)
      if (wait) return
      queueMicrotask(() => {
        stream.emit('data', Buffer.from('active'))
        stream.emit('close', 0)
      })
    }
    clients.push(connection)
    return connection
  }
  return { client, clients, commands, paths, firstCommand }
}

test('SSH指纹匹配后真实只读能力检查与SFTP有界读取，服务仅使用固定命令', async () => {
  const f = serverFixture(),
    driver = createServerReadonlyDriver({ client: f.client })
  assert.ok(
    (await driver.test(serverConfig, credential, context())).actions.includes('server.read'),
  )
  const result = await driver.execute(
    serverConfig,
    { connectionId: 'server', action: 'server.read', path: '/data/log', offset: 6, maxBytes: 8 },
    credential,
    context(),
  )
  assert.equal(result.data.content, 'isolated')
  assert.equal(result.truncated, true)
  await driver.execute(
    serverConfig,
    { connectionId: 'server', action: 'server.service', unit: 'app.service' },
    credential,
    context(),
  )
  assert.ok(
    f.commands.every(
      (command) =>
        command === 'LC_ALL=C /usr/bin/uptime' ||
        command ===
          "LC_ALL=C /usr/bin/systemctl --no-pager show --property=Id,LoadState,ActiveState,SubState,Result -- 'app.service'",
    ),
  )
  assert.ok(f.clients.every((client) => client.destroyed > 0))
  await driver.close()
})

test('SSH拒绝路径穿越、符号链接、特殊文件、未准入服务与错误指纹，异常不泄露秘密', async () => {
  for (const args of [{ symlink: true }, { special: true }, { wrongHost: true }, { fail: true }]) {
    const f = serverFixture(args),
      driver = createServerReadonlyDriver({ client: f.client })
    await assert.rejects(
      driver.execute(
        serverConfig,
        {
          connectionId: 'server',
          action: 'server.read',
          path: '/data/log',
          offset: 0,
          maxBytes: 8,
        },
        credential,
        context(),
      ),
      (error) => {
        assert.equal(error.message.includes(credential.password), false)
        return [
          'ENVIRONMENT_MCP_PATH_FORBIDDEN',
          'ENVIRONMENT_MCP_CONNECTION_FAILED',
          'ENVIRONMENT_MCP_HOST_KEY_MISMATCH',
        ].includes(error.code)
      },
    )
    if (args.wrongHost) assert.equal(f.commands.length, 0)
    await driver.close()
  }
  const f = serverFixture(),
    driver = createServerReadonlyDriver({ client: f.client })
  await assert.rejects(
    driver.execute(
      serverConfig,
      {
        connectionId: 'server',
        action: 'server.read',
        path: '/data/../private',
        offset: 0,
        maxBytes: 8,
      },
      credential,
      context(),
    ),
    { code: 'ENVIRONMENT_MCP_SCOPE_FORBIDDEN' },
  )
  await assert.rejects(
    driver.execute(
      serverConfig,
      { connectionId: 'server', action: 'server.service', unit: 'other.service' },
      credential,
      context(),
    ),
    { code: 'ENVIRONMENT_MCP_SCOPE_FORBIDDEN' },
  )
  assert.equal(f.clients.length, 0)
  await driver.close()
})

test('SSH连接关闭期间取消已发出的只读请求，排空后不重新连接', async () => {
  const f = serverFixture({ wait: true }),
    driver = createServerReadonlyDriver({ client: f.client })
  const work = driver.execute(
    serverConfig,
    { connectionId: 'server', action: 'server.snapshot' },
    credential,
    context(),
  )
  await f.firstCommand
  await driver.close()
  await assert.rejects(work, { code: 'ENVIRONMENT_MCP_READ_INTERRUPTED' })
  assert.ok(f.clients[0].destroyed > 0)
  await assert.rejects(driver.test(serverConfig, credential, context()), {
    code: 'ENVIRONMENT_MCP_DRIVER_CLOSED',
  })
  assert.equal(f.clients.length, 1)
})

test('驱动读取尚未取得SDK连接时关闭，不再创建连接或自动恢复', async () => {
  const f = mysqlFixture(),
    driver = createMysqlReadonlyDriver({ connect: f.connect })
  const work = driver.test(mysqlConfig, credential, context())
  await driver.close()
  await assert.rejects(work, { code: 'ENVIRONMENT_MCP_READ_INTERRUPTED' })
  assert.equal(f.connections.length, 0)
})

test('Redis集合返回有限元数据，不通过无界成员或字段读取突破预算', async () => {
  const seen = []
  const driver = createRedisReadonlyDriver({
    connect: () => ({
      on() {},
      async connect() {},
      destroy() {},
      async sendCommand(args) {
        seen.push(args)
        if (args[0] === 'TYPE') return 'hash'
        if (args[0] === 'HSTRLEN') return 1000000000
        if (args[0] === 'HLEN') return 4
        throw new Error('不允许请求完整字段内容')
      },
    }),
  })
  const result = await driver.execute(
    redisConfig,
    { connectionId: 'redis', action: 'redis.read', key: 'app:one', field: 'large' },
    credential,
    context(),
  )
  assert.equal(result.data.byteLength, 1000000000)
  assert.equal(result.data.value, undefined)
  assert.match(result.data.message, /尚未开放字段内容读取/)
  assert.deepEqual(
    seen.map((args) => args[0]),
    ['TYPE', 'HSTRLEN'],
  )
  const metadata = await driver.execute(
    redisConfig,
    { connectionId: 'redis', action: 'redis.read', key: 'app:one' },
    credential,
    context(),
  )
  assert.equal(metadata.data.message, '哈希仅返回数量；指定字段可查看长度')
  assert.equal(metadata.data.count, 4)
  await driver.close()
})
