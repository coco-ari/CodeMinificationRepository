import mysql, { type Connection, type ConnectionOptions } from 'mysql2'
import sqlParser from 'node-sql-parser'
import type * as C from '../../../../autoops/contracts/environment-mcp.ts'
import type { GitCredential } from '../../credentials.ts'
import type { EnvironmentMcpDriverContext, EnvironmentMcpReadonlyDriver } from '../index.ts'
import { validateConfiguration, validateOperation } from '../policy.ts'
import { driverFailure, driverLifetime, interrupted } from './lifetime.ts'

const parser = new sqlParser.Parser()
const pureFunctions = new Set([
  'ABS',
  'CEIL',
  'CEILING',
  'FLOOR',
  'ROUND',
  'TRUNCATE',
  'MOD',
  'POWER',
  'LENGTH',
  'CHAR_LENGTH',
  'LOWER',
  'UPPER',
  'TRIM',
  'LTRIM',
  'RTRIM',
  'SUBSTRING',
  'SUBSTR',
  'LEFT',
  'RIGHT',
  'CONCAT',
  'CONCAT_WS',
  'REPLACE',
  'COALESCE',
  'IFNULL',
  'NULLIF',
  'IF',
  'DATE',
  'YEAR',
  'MONTH',
  'DAY',
  'HOUR',
  'MINUTE',
  'SECOND',
  'DATE_FORMAT',
  'DATEDIFF',
  'JSON_EXTRACT',
  'JSON_UNQUOTE',
  'JSON_TYPE',
  'JSON_LENGTH',
  'NOW',
  'CURRENT_DATE',
  'CURRENT_TIMESTAMP',
])
const expressions = new Set([
  'select',
  'column_ref',
  'number',
  'string',
  'single_quote_string',
  'double_quote_string',
  'bool',
  'null',
  'binary_expr',
  'unary_expr',
  'expr_list',
  'origin',
  'aggr_func',
  'function',
  'star',
  'case',
  'when',
  'cast',
  'datatype',
  'interval',
  'extract',
  'default',
])
const denySql = () => {
  throw driverFailure(
    'ENVIRONMENT_MCP_SQL_FORBIDDEN',
    '仅支持当前数据库内不含锁、变量、写入或副作用函数的单条 SELECT',
    403,
  )
}

/** 只执行经解析后重新生成的白名单语法，注释及未识别的原文不会送入数据库。 */
export function validateReadonlySql(sql: string, database: string) {
  let ast: unknown
  try {
    ast = parser.astify(sql, { database: 'MySQL' })
  } catch {
    return denySql()
  }
  if (Array.isArray(ast)) {
    if (ast.length !== 1) return denySql()
    ast = ast[0]
  }
  if (!ast || typeof ast !== 'object' || (ast as { type?: string }).type !== 'select')
    return denySql()
  const visit = (value: unknown, depth = 0) => {
    if (depth > 64) return denySql()
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (!value || typeof value !== 'object') return
    const node = value as Record<string, unknown>
    if (typeof node.type === 'string' && !expressions.has(node.type)) return denySql()
    if (typeof node.db === 'string' && node.db !== database) return denySql()
    if (node.type === 'select') {
      for (const key of ['with', 'options', 'locking_read', 'window', 'procedure'])
        if (node[key] != null) return denySql()
      if (
        node.into &&
        Object.entries(node.into).some(([key, item]) => key !== 'position' || item != null)
      )
        return denySql()
    }
    if (node.type === 'function') {
      const parts = (node.name as { name?: Array<{ value?: string }> } | undefined)?.name
      if (parts?.length !== 1 || !pureFunctions.has(parts[0]?.value?.toUpperCase() ?? ''))
        return denySql()
    }
    if (
      node.type === 'aggr_func' &&
      !['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].includes(String(node.name).toUpperCase())
    )
      return denySql()
    if (node.type === 'origin' && node.value !== '?') return denySql()
    for (const [key, item] of Object.entries(node)) {
      if (key === 'into' && node.type === 'select') continue
      visit(item, depth + 1)
    }
  }
  visit(ast)
  try {
    return parser.sqlify(ast as Parameters<typeof parser.sqlify>[0], { database: 'MySQL' })
  } catch {
    return denySql()
  }
}

function verifyGrants(rows: unknown[], database: string) {
  let selected = false
  for (const row of rows) {
    if (!row || typeof row !== 'object') return denySql()
    for (const grant of Object.values(row)) {
      if (typeof grant !== 'string') return denySql()
      const match = /^GRANT (.+?) ON (.+?) TO /i.exec(grant)
      if (!match || /WITH GRANT OPTION/i.test(grant))
        throw driverFailure(
          'ENVIRONMENT_MCP_READONLY_ACCOUNT_REQUIRED',
          '请使用直接授予目标数据库 SELECT 的独立只读账号，不支持写权限或角色继承',
          403,
        )
      const privileges = match[1]!.split(',').map((value) => value.trim().toUpperCase())
      if (privileges.some((value) => !['USAGE', 'SELECT', 'SHOW VIEW'].includes(value)))
        throw driverFailure(
          'ENVIRONMENT_MCP_READONLY_ACCOUNT_REQUIRED',
          '连接账号具有非只读权限，请改用独立只读账号',
          403,
        )
      const target = match[2]!.replace(/`((?:``|[^`])*)`/g, (_whole, value: string) =>
        value.replace(/``/g, '`'),
      )
      if (privileges.includes('SELECT')) {
        if (!target.startsWith(database + '.'))
          throw driverFailure(
            'ENVIRONMENT_MCP_DATABASE_FORBIDDEN',
            '只读账号的读取授权必须限定于当前数据库',
            403,
          )
        selected = true
      }
    }
  }
  if (!selected)
    throw driverFailure(
      'ENVIRONMENT_MCP_READONLY_ACCOUNT_REQUIRED',
      '账号未获目标数据库的 SELECT 权限',
      403,
    )
}

type Options = { connect?: (options: ConnectionOptions) => Connection }
export function createMysqlReadonlyDriver(options: Options = {}): EnvironmentMcpReadonlyDriver {
  const lifetime = driverLifetime()
  async function run(
    configuration: C.EnvironmentMcpConfiguration,
    credential: GitCredential | undefined,
    context: EnvironmentMcpDriverContext,
    action: (
      query: (
        sql: string,
        params?: readonly (string | number | boolean | null)[],
      ) => Promise<{ rows: unknown[]; truncated: boolean }>,
    ) => Promise<{ data: unknown; truncated: boolean }>,
  ) {
    validateConfiguration(configuration)
    if (configuration.type !== 'mysql' || !credential?.username)
      throw driverFailure(
        'ENVIRONMENT_MCP_CREDENTIAL_REQUIRED',
        'MySQL 连接需要项目中的只读账号凭证',
        400,
      )
    return lifetime.run(context, async (signal) => {
      const connection = (options.connect ?? mysql.createConnection)({
        host: configuration.host,
        port: configuration.port,
        user: credential.username,
        password: credential.password,
        database: configuration.database,
        connectTimeout: context.limits.timeoutMs,
        multipleStatements: false,
        enableKeepAlive: false,
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
        flags: ['-LOCAL_FILES'],
        ...(configuration.tls === 'required'
          ? { ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2' } }
          : {}),
      })
      const destroy = () => connection.destroy()
      connection.on('error', () => {})
      const query = (sql: string, params: readonly (string | number | boolean | null)[] = []) =>
        interrupted(
          signal,
          new Promise<{ rows: unknown[]; truncated: boolean }>((resolve, reject) => {
            const rows: unknown[] = []
            let bytes = 2,
              settled = false
            // 二进制绑定不依赖服务器 sql_mode 的字符串转义规则。
            const request = params.length
              ? connection.execute({ sql, timeout: context.limits.timeoutMs }, [...params])
              : connection.query({ sql, timeout: context.limits.timeoutMs })
            const stream = request.stream({ highWaterMark: 1 })
            stream.on('data', (row: unknown) => {
              if (settled) return
              const text = JSON.stringify(row, (_key, value: unknown) =>
                typeof value === 'bigint' ? value.toString() : value,
              )
              bytes += Buffer.byteLength(text) + 1
              if (rows.length >= context.limits.maxRows || bytes > context.limits.maxBytes) {
                settled = true
                resolve({ rows, truncated: true })
                destroy()
              } else rows.push(JSON.parse(text))
            })
            stream.once('error', (error) => {
              if (!settled) {
                settled = true
                reject(error)
              }
            })
            stream.once('end', () => {
              if (!settled) {
                settled = true
                resolve({ rows, truncated: false })
              }
            })
          }),
          destroy,
        )
      try {
        await interrupted(
          signal,
          new Promise<void>((resolve, reject) =>
            connection.connect((error) => (error ? reject(error) : resolve())),
          ),
          destroy,
        )
        const grants = await query('SHOW GRANTS FOR CURRENT_USER()')
        if (grants.truncated)
          throw driverFailure(
            'ENVIRONMENT_MCP_READONLY_ACCOUNT_REQUIRED',
            '账号授权过多，无法完整核验只读权限',
            403,
          )
        verifyGrants(grants.rows, configuration.database)
        await query(
          `SET SESSION MAX_EXECUTION_TIME = ${Math.max(1, Math.min(30000, Math.floor(context.limits.timeoutMs)))}`,
        )
        await query('SET SESSION TRANSACTION READ ONLY')
        await query('START TRANSACTION READ ONLY')
        const check = await query(
          'SELECT DATABASE() AS databaseName, @@transaction_read_only AS readOnly',
        )
        const fact = check.rows[0] as { databaseName?: unknown; readOnly?: unknown } | undefined
        if (fact?.databaseName !== configuration.database || Number(fact.readOnly) !== 1)
          throw driverFailure(
            'ENVIRONMENT_MCP_READONLY_UNAVAILABLE',
            '数据库未确认目标库或只读事务，已停止查询',
            403,
          )
        return await action(query)
      } finally {
        destroy()
      }
    })
  }
  const tables = (database: string, maximum: number) => ({
    sql: 'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT ?',
    params: [database, maximum],
  })
  return {
    async test(configuration, credential, context) {
      await run(configuration, credential, context, async (query) => {
        if (configuration.type !== 'mysql') return denySql()
        const read = tables(configuration.database, context.limits.maxRows + 1)
        const result = await query(read.sql, read.params)
        return { data: result.rows, truncated: result.truncated }
      })
      return { actions: ['mysql.tables', 'mysql.describe', 'mysql.query', 'mysql.explain'] }
    },
    async execute(configuration, operation, credential, context) {
      validateOperation(configuration, operation)
      const sql =
        operation.action === 'mysql.query' || operation.action === 'mysql.explain'
          ? validateReadonlySql(
              operation.sql,
              configuration.type === 'mysql' ? configuration.database : '',
            )
          : undefined
      return run(configuration, credential, context, async (query) => {
        if (configuration.type !== 'mysql') return denySql()
        let result: { rows: unknown[]; truncated: boolean }
        if (operation.action === 'mysql.tables') {
          const read = tables(configuration.database, context.limits.maxRows + 1)
          result = await query(read.sql, read.params)
        } else if (operation.action === 'mysql.describe') {
          if (!/^[^\x00-\x1f\x7f]+$/.test(operation.table)) return denySql()
          result = await query(
            'SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS columnKey FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT ?',
            [configuration.database, operation.table, context.limits.maxRows + 1],
          )
        } else if (operation.action === 'mysql.explain') {
          result = await query('EXPLAIN FORMAT=JSON ' + sql!, operation.params)
        } else if (operation.action === 'mysql.query') {
          result = await query(
            `SELECT * FROM (${sql!}) AS autoops_read LIMIT ${context.limits.maxRows + 1}`,
            operation.params,
          )
        } else return denySql()
        return { data: result.rows, truncated: result.truncated }
      })
    },
    close: () => lifetime.close(),
  }
}
