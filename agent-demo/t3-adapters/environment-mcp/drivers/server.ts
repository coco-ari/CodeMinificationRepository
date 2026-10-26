// @effect-diagnostics nodeBuiltinImport:off -- SSH指纹与SFTP真实路径在外部协议适配边界核验。
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import ssh2, { type Client, type SFTPWrapper, type Stats } from 'ssh2'
import type * as C from '../../../../autoops/contracts/environment-mcp.ts'
import type { GitCredential } from '../../credentials.ts'
import type { EnvironmentMcpDriverContext, EnvironmentMcpReadonlyDriver } from '../index.ts'
import { validateConfiguration, validateOperation } from '../policy.ts'
import { driverFailure, driverLifetime, interrupted } from './lifetime.ts'

type ServerConfig = Extract<C.EnvironmentMcpConfiguration, { type: 'server' }>
type Options = { client?: () => Client }
const deniedPath = () => {
  throw driverFailure(
    'ENVIRONMENT_MCP_PATH_FORBIDDEN',
    '文件真实路径、链接或类型不符合此环境的只读范围',
    403,
  )
}
const inside = (path: string, root: string) =>
  path === root || root === '/' || path.startsWith(root + '/')
const safePath = (path: string) =>
  path.startsWith('/') &&
  !/[\x00-\x1f\x7f\\]/.test(path) &&
  posix.normalize(path) === path &&
  !path.split('/').some((part) => part === '.' || part === '..')
const remote = <T>(run: (callback: (error: Error | undefined | null, value: T) => void) => void) =>
  new Promise<T>((resolve, reject) =>
    run((error, value) => (error ? reject(error) : resolve(value))),
  )

async function checkedPath(sftp: SFTPWrapper, configuration: ServerConfig, path: string) {
  if (!safePath(path)) return deniedPath()
  const root = configuration.readPaths
    .filter((root) => inside(path, root))
    .sort((a, b) => b.length - a.length)[0]
  if (!root) return deniedPath()
  // 每个路径分量都拒绝链接，避免登记目录中的链接越过管理员定义的边界。
  const parts = path.split('/').filter(Boolean)
  let prefix = ''
  for (const part of parts) {
    prefix += '/' + part
    const info = await remote<Stats>((callback) => sftp.lstat(prefix, callback))
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return deniedPath()
  }
  const realRoot = await remote<string>((callback) => sftp.realpath(root, callback))
  const real = await remote<string>((callback) => sftp.realpath(path, callback))
  if (realRoot !== root || real !== path || !inside(real, realRoot)) return deniedPath()
  return real
}

export function createServerReadonlyDriver(options: Options = {}): EnvironmentMcpReadonlyDriver {
  const lifetime = driverLifetime()
  async function run(
    configuration: C.EnvironmentMcpConfiguration,
    credential: GitCredential | undefined,
    context: EnvironmentMcpDriverContext,
    action: (client: Client, signal: AbortSignal) => Promise<{ data: unknown; truncated: boolean }>,
  ) {
    validateConfiguration(configuration)
    if (configuration.type !== 'server' || !credential?.username)
      throw driverFailure(
        'ENVIRONMENT_MCP_CREDENTIAL_REQUIRED',
        '服务器连接需要项目中的只读账号凭证',
        400,
      )
    return lifetime.run(context, async (signal) => {
      const client = options.client?.() ?? new ssh2.Client()
      const destroy = () => client.destroy()
      client.on('error', () => {})
      let hostVerified = false,
        hostChecked = false
      const ready = new Promise<void>((resolve, reject) => {
        client.once('ready', resolve)
        client.once('error', (error) =>
          reject(
            hostChecked && !hostVerified
              ? driverFailure(
                  'ENVIRONMENT_MCP_HOST_KEY_MISMATCH',
                  '服务器主机指纹不匹配，未发送读取请求',
                  403,
                )
              : error,
          ),
        )
        client.once('close', () =>
          reject(driverFailure('ENVIRONMENT_MCP_CONNECTION_FAILED', '服务器连接在读取完成前断开')),
        )
      })
      try {
        client.connect({
          host: configuration.host,
          port: configuration.port,
          username: credential.username,
          password: credential.password,
          readyTimeout: context.limits.timeoutMs,
          tryKeyboard: false,
          keepaliveInterval: 0,
          agentForward: false,
          hostVerifier: (key: Buffer) => {
            hostChecked = true
            hostVerified =
              'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '') ===
              configuration.hostKeySha256.replace(/=+$/, '')
            return hostVerified
          },
        })
        await interrupted(signal, ready, destroy)
        if (!hostVerified)
          throw driverFailure(
            'ENVIRONMENT_MCP_HOST_KEY_MISMATCH',
            '服务器主机指纹不匹配，未发送读取请求',
            403,
          )
        return await interrupted(signal, action(client, signal), destroy)
      } finally {
        destroy()
      }
    })
  }
  async function command(client: Client, text: string, maximum: number) {
    return new Promise<{ data: string; truncated: boolean }>((resolve, reject) => {
      client.exec(text, { pty: false }, (error, stream) => {
        if (error) {
          reject(error)
          return
        }
        const chunks: Buffer[] = []
        let size = 0,
          failed = false
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maximum) {
            failed = true
            stream.close()
            reject(
              driverFailure('ENVIRONMENT_MCP_RESULT_TOO_LARGE', '服务器状态超过本次读取上限', 413),
            )
          } else chunks.push(chunk)
        })
        stream.stderr.on('data', () => {
          /* 远端错误原文可能包含路径或秘密，不转发。 */
        })
        stream.once('error', reject)
        stream.once('close', (code: number | undefined) => {
          if (failed) return
          if (code !== 0)
            reject(
              driverFailure(
                'ENVIRONMENT_MCP_READ_FAILED',
                '服务器未提供所请求的只读状态，请核对只读账号能力',
              ),
            )
          else resolve({ data: Buffer.concat(chunks).toString('utf8'), truncated: false })
        })
      })
    })
  }
  const snapshot = (client: Client, maximum: number) =>
    command(client, 'LC_ALL=C /usr/bin/uptime', maximum)
  async function sftpFor(client: Client) {
    return remote<SFTPWrapper>((callback) => client.sftp(callback))
  }
  return {
    async test(configuration, credential, context) {
      if (configuration.type !== 'server')
        throw driverFailure('ENVIRONMENT_MCP_ACTION_FORBIDDEN', '此连接不是服务器', 403)
      await run(configuration, credential, context, async (client) => {
        const result = await snapshot(client, Math.min(4096, context.limits.maxBytes))
        if (configuration.readPaths.length) {
          const sftp = await sftpFor(client)
          try {
            for (const path of configuration.readPaths) {
              await checkedPath(sftp, configuration, path)
              const stats = await remote<Stats>((callback) => sftp.lstat(path, callback))
              if (stats.isDirectory()) {
                const handle = await remote<Buffer>((callback) => sftp.opendir(path, callback))
                try {
                  await remote((callback) => sftp.readdir(handle, callback))
                } finally {
                  await remote((callback) =>
                    sftp.close(handle, (error) => callback(error, undefined)),
                  )
                }
              } else {
                const handle = await remote<Buffer>((callback) => sftp.open(path, 'r', callback))
                try {
                  await remote((callback) => sftp.read(handle, Buffer.alloc(1), 0, 1, 0, callback))
                } finally {
                  await remote((callback) =>
                    sftp.close(handle, (error) => callback(error, undefined)),
                  )
                }
              }
            }
          } finally {
            sftp.end()
          }
        }
        for (const unit of configuration.serviceUnits)
          await command(
            client,
            `LC_ALL=C /usr/bin/systemctl --no-pager show --property=Id,LoadState,ActiveState,SubState,Result -- '${unit}'`,
            Math.min(8192, context.limits.maxBytes),
          )
        return result
      })
      const actions: C.EnvironmentMcpAction[] = ['server.snapshot']
      if (configuration.serviceUnits.length) actions.push('server.service')
      if (configuration.readPaths.length) actions.push('server.read')
      return { actions }
    },
    async execute(configuration, operation, credential, context) {
      validateOperation(configuration, operation)
      if (configuration.type !== 'server')
        throw driverFailure('ENVIRONMENT_MCP_ACTION_FORBIDDEN', '此连接不是服务器', 403)
      return run(configuration, credential, context, async (client, signal) => {
        if (operation.action === 'server.snapshot')
          return snapshot(client, Math.min(4096, context.limits.maxBytes))
        if (operation.action === 'server.service') {
          if (!/^[A-Za-z0-9_@.:-]+\.(?:service|socket|timer|target)$/.test(operation.unit))
            throw driverFailure('ENVIRONMENT_MCP_SCOPE_FORBIDDEN', '服务单元格式无效', 403)
          return command(
            client,
            `LC_ALL=C /usr/bin/systemctl --no-pager show --property=Id,LoadState,ActiveState,SubState,Result -- '${operation.unit}'`,
            Math.min(8192, context.limits.maxBytes),
          )
        }
        if (operation.action !== 'server.read')
          throw driverFailure('ENVIRONMENT_MCP_ACTION_FORBIDDEN', '不支持此服务器操作', 403)
        const sftp = await sftpFor(client)
        let handle: Buffer | undefined
        try {
          const path = await checkedPath(sftp, configuration, operation.path)
          handle = await remote<Buffer>((callback) => sftp.open(path, 'r', callback))
          const info = await remote<Stats>((callback) => sftp.fstat(handle!, callback))
          if (!info.isFile()) return deniedPath()
          const maximum = Math.min(operation.maxBytes, Math.floor(context.limits.maxBytes / 8))
          const buffer = Buffer.alloc(maximum)
          let count = 0
          while (count < maximum) {
            signal.throwIfAborted()
            const read = await new Promise<number>((resolve, reject) =>
              sftp.read(
                handle!,
                buffer,
                count,
                maximum - count,
                operation.offset + count,
                (error, bytes) => (error ? reject(error) : resolve(bytes)),
              ),
            )
            if (!read) break
            count += read
          }
          await checkedPath(sftp, configuration, operation.path)
          const final = await remote<Stats>((callback) => sftp.fstat(handle!, callback))
          if (!final.isFile() || final.size !== info.size || final.mtime !== info.mtime)
            throw driverFailure(
              'ENVIRONMENT_MCP_FILE_CHANGED',
              '文件读取期间发生变化，请重新读取',
              409,
            )
          const content = buffer.subarray(0, count)
          let encoding = 'utf8',
            value: string
          try {
            value = new TextDecoder('utf-8', { fatal: true }).decode(content)
          } catch {
            encoding = 'base64'
            value = content.toString('base64')
          }
          return {
            data: {
              path: operation.path,
              offset: operation.offset,
              size: info.size,
              bytes: count,
              encoding,
              content: value,
            },
            truncated: operation.offset + count < info.size,
          }
        } finally {
          if (handle && !signal.aborted)
            await remote((callback) =>
              sftp.close(handle!, (error) => callback(error, undefined)),
            ).catch(() => {})
          sftp.end()
        }
      })
    },
    close: () => lifetime.close(),
  }
}
