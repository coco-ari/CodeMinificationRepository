import type * as C from '../../../autoops/contracts/environment-mcp.ts'

export class EnvironmentMcpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'EnvironmentMcpError'
    this.status = status
    this.code = code
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new EnvironmentMcpError(status, code, message)
}
export const actionsFor: Readonly<
  Record<C.EnvironmentMcpConfiguration['type'], readonly C.EnvironmentMcpAction[]>
> = {
  server: ['server.snapshot', 'server.service', 'server.read'],
  mysql: ['mysql.tables', 'mysql.describe', 'mysql.query', 'mysql.explain'],
  redis: ['redis.scan', 'redis.read', 'redis.ttl'],
}
const control = /[\x00-\x1f\x7f]/
const absolutePath = (value: string) =>
  value.startsWith('/') &&
  !control.test(value) &&
  !value.includes('\\') &&
  value.split('/').every((part) => part !== '.' && part !== '..') &&
  (value === '/' || !value.endsWith('/'))
export function validateConfiguration(value: C.EnvironmentMcpConfiguration) {
  if (
    value.name !== value.name.trim() ||
    control.test(value.name) ||
    value.host !== value.host.trim() ||
    /[\s/@?#\\]/.test(value.host) ||
    control.test(value.host)
  )
    fail(400, 'ENVIRONMENT_MCP_CONFIGURATION_INVALID', '连接名称或主机格式无效，不接受 URL 或命令')
  if (value.type === 'server') {
    if (
      value.readPaths.some((path) => !absolutePath(path)) ||
      new Set(value.readPaths).size !== value.readPaths.length ||
      value.serviceUnits.some(
        (unit) => !/^[A-Za-z0-9_@.:-]+\.(?:service|socket|timer|target)$/.test(unit),
      ) ||
      new Set(value.serviceUnits).size !== value.serviceUnits.length
    )
      fail(400, 'ENVIRONMENT_MCP_SCOPE_INVALID', '请明确设置不含路径穿越的读取目录及服务单元')
  } else if (value.type === 'mysql') {
    if (value.database !== value.database.trim() || control.test(value.database))
      fail(400, 'ENVIRONMENT_MCP_SCOPE_INVALID', '请选择一个有效数据库')
  } else if (
    new Set(value.keyPatterns).size !== value.keyPatterns.length ||
    value.keyPatterns.some((pattern) => control.test(pattern))
  ) {
    fail(400, 'ENVIRONMENT_MCP_SCOPE_INVALID', 'Redis Key 范围无效或重复')
  }
  return value
}
export function redisKeyAllowed(pattern: string, key: string) {
  // 只支持 * 和 ?；有限回退避免连续通配符造成正则指数回溯，并按 Unicode 字符匹配。
  const rule = Array.from(pattern),
    value = Array.from(key)
  let p = 0,
    k = 0,
    star = -1,
    retry = 0
  while (k < value.length) {
    if (rule[p] === '?' || rule[p] === value[k]) {
      p++
      k++
    } else if (rule[p] === '*') {
      star = p++
      retry = k
    } else if (star !== -1) {
      p = star + 1
      k = ++retry
    } else return false
  }
  while (rule[p] === '*') p++
  return p === rule.length
}
export function validateOperation(
  configuration: C.EnvironmentMcpConfiguration,
  operation: C.EnvironmentMcpOperation,
) {
  if (!actionsFor[configuration.type].includes(operation.action))
    fail(403, 'ENVIRONMENT_MCP_ACTION_FORBIDDEN', '连接不支持此只读操作')
  if (configuration.type === 'server') {
    if (
      operation.action === 'server.read' &&
      (!absolutePath(operation.path) ||
        !configuration.readPaths.some(
          (path) =>
            path === '/' || operation.path === path || operation.path.startsWith(path + '/'),
        ))
    )
      fail(403, 'ENVIRONMENT_MCP_SCOPE_FORBIDDEN', '文件不在本环境连接的读取范围内')
    if (
      operation.action === 'server.service' &&
      !configuration.serviceUnits.includes(operation.unit)
    )
      fail(403, 'ENVIRONMENT_MCP_SCOPE_FORBIDDEN', '服务不在本环境连接的读取范围内')
  }
  if (configuration.type === 'redis') {
    if (operation.action === 'redis.scan' && !configuration.keyPatterns.includes(operation.pattern))
      fail(403, 'ENVIRONMENT_MCP_SCOPE_FORBIDDEN', '扫描范围未在此环境连接中配置')
    if (
      (operation.action === 'redis.read' || operation.action === 'redis.ttl') &&
      !configuration.keyPatterns.some((pattern) => redisKeyAllowed(pattern, operation.key))
    )
      fail(403, 'ENVIRONMENT_MCP_SCOPE_FORBIDDEN', 'Key 不在本环境连接的读取范围内')
  }
  if (
    (operation.action === 'mysql.query' || operation.action === 'mysql.explain') &&
    (operation.sql.includes('\0') ||
      operation.params?.some((value) => typeof value === 'number' && !Number.isFinite(value)) ||
      operation.params?.some(
        (value) => typeof value === 'string' && new TextEncoder().encode(value).byteLength > 65536,
      ))
  )
    fail(400, 'ENVIRONMENT_MCP_OPERATION_INVALID', '查询参数无效或超过长度限制')
  return operation
}
export function resource(value: {
  id: string
  revision: number
  configuration: C.EnvironmentMcpConfiguration
  actions: C.EnvironmentMcpAction[]
}): C.EnvironmentMcpResource {
  const config = value.configuration
  return {
    id: value.id,
    name: config.name,
    type: config.type,
    revision: value.revision,
    actions: [...value.actions],
    scope:
      config.type === 'server'
        ? { readPaths: [...config.readPaths], serviceUnits: [...config.serviceUnits] }
        : config.type === 'mysql'
          ? { database: config.database }
          : { database: config.database, keyPatterns: [...config.keyPatterns] },
  }
}
