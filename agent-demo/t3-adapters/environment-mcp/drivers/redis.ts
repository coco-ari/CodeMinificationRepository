// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Redis适配拥有短期游标身份与到期时间，不改写业务时钟。
import { createHash, randomBytes } from 'node:crypto'
import { createClient, type RedisClientOptions } from 'redis'
import type * as C from '../../../../autoops/contracts/environment-mcp.ts'
import type { GitCredential } from '../../credentials.ts'
import type { EnvironmentMcpDriverContext, EnvironmentMcpReadonlyDriver } from '../index.ts'
import {
  redisKeyAllowed as keyMatches,
  validateConfiguration,
  validateOperation,
} from '../policy.ts'
import { driverFailure, driverLifetime, interrupted } from './lifetime.ts'

type RedisTransport = {
  on(event: 'error', listener: (error: unknown) => void): unknown
  connect(): Promise<unknown>
  sendCommand(command: string[]): Promise<unknown>
  destroy(): unknown
}
type Options = { connect?: (options: RedisClientOptions) => RedisTransport; now?: () => number }
const decode = (value: unknown) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value))

const wirePattern = (value: string) => value.replace(/[\[\]\\]/g, '\\$&')

export function createRedisReadonlyDriver(options: Options = {}): EnvironmentMcpReadonlyDriver {
  const lifetime = driverLifetime(),
    now = options.now ?? Date.now
  const cursors = new Map<
    string,
    { scope: string; cursor: string; pending: string[]; expires: number }
  >()
  const expire = () => {
    for (const [id, record] of cursors) if (record.expires <= now()) cursors.delete(id)
  }
  const invalidCursor = () => {
    throw driverFailure(
      'ENVIRONMENT_MCP_CURSOR_INVALID',
      '扫描游标未知、过期或不属于此连接范围，请从 0 重新扫描',
      409,
    )
  }
  function cursorToken(scope: string, cursor: string, pending: string[]) {
    if (cursor === '0' && !pending.length) return '0'
    expire()
    if (cursors.size >= 32) cursors.delete(cursors.keys().next().value!)
    const id = BigInt('0x' + randomBytes(16).toString('hex')).toString()
    cursors.set(id, { scope, cursor, pending, expires: now() + 300_000 })
    return id
  }
  async function run(
    configuration: C.EnvironmentMcpConfiguration,
    credential: GitCredential | undefined,
    context: EnvironmentMcpDriverContext,
    action: (
      command: (args: string[]) => Promise<unknown>,
      signal: AbortSignal,
    ) => Promise<{ data: unknown; truncated: boolean }>,
  ) {
    validateConfiguration(configuration)
    if (configuration.type !== 'redis')
      throw driverFailure('ENVIRONMENT_MCP_ACTION_FORBIDDEN', '此连接不是 Redis', 403)
    return lifetime.run(context, async (signal) => {
      const client = (options.connect ?? ((value: RedisClientOptions) => createClient(value)))({
        socket: {
          host: configuration.host,
          port: configuration.port,
          connectTimeout: context.limits.timeoutMs,
          reconnectStrategy: false,
          ...(configuration.tls === 'required'
            ? { tls: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' }
            : {}),
        },
        database: configuration.database,
        disableOfflineQueue: true,
        commandsQueueMaxLength: 2,
        maintNotifications: 'disabled',
        disableClientInfo: true,
        ...(credential
          ? {
              ...(credential.username ? { username: credential.username } : {}),
              password: credential.password,
            }
          : {}),
      })
      client.on('error', () => {})
      const destroy = () => {
        try {
          client.destroy()
        } catch {
          /* 连接失败后重复释放仍可完成排空。 */
        }
      }
      try {
        await interrupted(signal, client.connect(), destroy)
        const command = (args: string[]) => interrupted(signal, client.sendCommand(args), destroy)
        return await action(command, signal)
      } finally {
        destroy()
      }
    })
  }
  async function scan(
    configuration: Extract<C.EnvironmentMcpConfiguration, { type: 'redis' }>,
    operation: Extract<C.EnvironmentMcpOperation, { action: 'redis.scan' }>,
    credential: GitCredential | undefined,
    context: EnvironmentMcpDriverContext,
    command: (args: string[]) => Promise<unknown>,
  ) {
    expire()
    const scope = createHash('sha256')
      .update(
        JSON.stringify([operation.connectionId, configuration, credential, operation.pattern]),
      )
      .digest('hex')
    const record =
      operation.cursor === '0'
        ? { scope, cursor: '0', pending: [] as string[], expires: 0 }
        : cursors.get(operation.cursor)
    if (!record || record.scope !== scope || (record.expires !== 0 && record.expires <= now()))
      return invalidCursor()
    const maximum = Math.min(operation.limit, context.limits.maxKeys)
    let pending = record.pending,
      remote = record.cursor
    if (!pending.length) {
      const result = await command([
        'SCAN',
        remote,
        'MATCH',
        wirePattern(operation.pattern),
        'COUNT',
        String(maximum),
      ])
      if (
        !Array.isArray(result) ||
        !Array.isArray(result[1]) ||
        !/^\d{1,128}$/.test(decode(result[0]))
      )
        throw driverFailure('ENVIRONMENT_MCP_RESPONSE_INVALID', 'Redis 扫描返回格式无效')
      remote = decode(result[0])
      pending = result[1].map(decode).filter((key) => keyMatches(operation.pattern, key))
      if (pending.length > context.limits.maxKeys || pending.some((key) => key.length > 1024))
        throw driverFailure(
          'ENVIRONMENT_MCP_RESULT_TOO_LARGE',
          '本次扫描结果过大，请缩小已配置的 Key 范围后重试',
          413,
        )
    }
    const keys = pending.slice(0, maximum),
      remaining = pending.slice(maximum)
    if (Buffer.byteLength(JSON.stringify(keys)) > Math.min(32768, context.limits.maxBytes / 2))
      throw driverFailure(
        'ENVIRONMENT_MCP_RESULT_TOO_LARGE',
        '扫描 Key 列表超过返回上限，请缩小范围',
        413,
      )
    return {
      data: { keys, cursor: cursorToken(scope, remote, remaining) },
      truncated: remaining.length > 0,
    }
  }
  return {
    async test(configuration, credential, context) {
      if (configuration.type !== 'redis')
        throw driverFailure('ENVIRONMENT_MCP_ACTION_FORBIDDEN', '此连接不是 Redis', 403)
      await run(configuration, credential, context, async (command) => {
        // 空范围也实际调用读取命令，不把 SCAN 或登录成功当作内容读取能力。
        const result = await command([
          'SCAN',
          '0',
          'MATCH',
          wirePattern(configuration.keyPatterns[0]!),
          'COUNT',
          '1',
        ])
        if (!Array.isArray(result) || !Array.isArray(result[1]))
          throw driverFailure('ENVIRONMENT_MCP_RESPONSE_INVALID', 'Redis 未提供预期只读能力')
        const found = result[1]
          .map(decode)
          .find((value) => configuration.keyPatterns.some((pattern) => keyMatches(pattern, value)))
        const key =
          found ??
          (configuration.keyPatterns[0]!.replace(/\*/g, '').replace(/\?/g, 'x') ||
            'autoops_read_probe')
        if (!configuration.keyPatterns.some((pattern) => keyMatches(pattern, key)))
          throw driverFailure(
            'ENVIRONMENT_MCP_SCOPE_FORBIDDEN',
            '无法在配置范围内执行只读能力检查',
            403,
          )
        const type = decode(await command(['TYPE', key]))
        await command(['TTL', key])
        if (type === 'string' || type === 'none') await command(['GETRANGE', key, '0', '0'])
        else if (type === 'hash') await command(['HLEN', key])
        else if (type === 'list') await command(['LLEN', key])
        else if (type === 'set') await command(['SCARD', key])
        else if (type === 'zset') await command(['ZCARD', key])
        else
          throw driverFailure(
            'ENVIRONMENT_MCP_READ_UNAVAILABLE',
            '此类型尚未提供有界内容或元数据读取',
            403,
          )
        return { data: null, truncated: false }
      })
      return { actions: ['redis.scan', 'redis.read', 'redis.ttl'] }
    },
    async execute(configuration, operation, credential, context) {
      validateOperation(configuration, operation)
      if (configuration.type !== 'redis')
        throw driverFailure('ENVIRONMENT_MCP_ACTION_FORBIDDEN', '此连接不是 Redis', 403)
      return run(configuration, credential, context, async (command) => {
        if (operation.action === 'redis.scan')
          return scan(configuration, operation, credential, context, command)
        if (operation.action === 'redis.ttl')
          return { data: { ttl: Number(await command(['TTL', operation.key])) }, truncated: false }
        if (operation.action !== 'redis.read')
          throw driverFailure('ENVIRONMENT_MCP_ACTION_FORBIDDEN', '不支持此 Redis 操作', 403)
        const type = decode(await command(['TYPE', operation.key]))
        let data: unknown,
          truncated = false
        const maximum = Math.max(1, Math.floor(context.limits.maxBytes / 8))
        if (type === 'none') data = { type, value: null }
        else if (type === 'string') {
          const size = Number(await command(['STRLEN', operation.key]))
          const value = decode(await command(['GETRANGE', operation.key, '0', String(maximum - 1)]))
          data = { type, value, byteLength: size }
          truncated = size > maximum
        } else if (type === 'hash' && operation.field !== undefined) {
          const size = Number(await command(['HSTRLEN', operation.key, operation.field]))
          data = {
            type,
            field: operation.field,
            byteLength: size,
            message: '此类型仅返回有界元数据，尚未开放字段内容读取',
          }
        } else if (type === 'hash')
          data = {
            type,
            count: Number(await command(['HLEN', operation.key])),
            message: '哈希仅返回数量；指定字段可查看长度',
          }
        else if (type === 'list')
          data = {
            type,
            count: Number(await command(['LLEN', operation.key])),
            message: '列表仅返回数量，不展开无界成员',
          }
        else if (type === 'set')
          data = {
            type,
            count: Number(await command(['SCARD', operation.key])),
            message: '集合仅返回数量，不展开无界成员',
          }
        else if (type === 'zset')
          data = {
            type,
            count: Number(await command(['ZCARD', operation.key])),
            message: '有序集合仅返回数量，不展开无界成员',
          }
        else data = { type, message: '此数据类型尚未开放内容读取' }
        if (Buffer.byteLength(JSON.stringify(data)) > context.limits.maxBytes)
          throw driverFailure(
            'ENVIRONMENT_MCP_RESULT_TOO_LARGE',
            'Redis 内容超过本次读取上限，未返回部分字段',
            413,
          )
        return { data, truncated }
      })
    },
    async close() {
      cursors.clear()
      await lifetime.close()
    },
  }
}
