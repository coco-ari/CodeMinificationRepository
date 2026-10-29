// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- 环境连接拥有同步持久事实；Node 驱动读取在本模块计时、取消并排空。
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as S from 'effect/Schema'
import * as C from '../../../autoops/contracts/environment-mcp.ts'
import type { WorkspaceCredentialVersionReference } from '../../../autoops/contracts/workspace-authoring.ts'
import { DirectoryId } from '../../../autoops/contracts/project-directory.ts'
import { openDatabase } from '../../../autoops/server/platform/database.ts'
import {
  CredentialError,
  type createProjectCredentialService,
  type GitCredential,
} from '../credentials.ts'
import { migrations } from './schema.ts'
import {
  actionsFor,
  EnvironmentMcpError,
  fail,
  resource,
  validateConfiguration,
  validateOperation,
} from './policy.ts'

export { EnvironmentMcpError } from './policy.ts'

export interface EnvironmentMcpScope {
  actorId: string
  projectId: string
  environmentId: string | null
  threadId: string
  runId: string
}
export interface EnvironmentMcpLimits {
  timeoutMs: number
  maxRows: number
  maxKeys: number
  maxBytes: number
}
export interface EnvironmentMcpDriverContext {
  signal: AbortSignal
  limits: Readonly<EnvironmentMcpLimits>
}
export interface EnvironmentMcpReadonlyDriver {
  // 驱动必须验证实际只读能力；MySQL 的语法与数据库只读限制不由工具名称替代。
  test(
    configuration: C.EnvironmentMcpConfiguration,
    credential: GitCredential | undefined,
    context: EnvironmentMcpDriverContext,
  ): Promise<{ actions: C.EnvironmentMcpAction[] }>
  execute(
    configuration: C.EnvironmentMcpConfiguration,
    operation: C.EnvironmentMcpOperation,
    credential: GitCredential | undefined,
    context: EnvironmentMcpDriverContext,
  ): Promise<{ data: unknown; truncated: boolean }>
  close(): void | Promise<void>
}
type Credentials = Pick<
  ReturnType<typeof createProjectCredentialService>,
  'referenceVersion' | 'withCredential'
>
interface Options {
  dataDir: string
  credentials: Credentials
  authorizeManage(actorId: string, projectId: string, environmentId: string): unknown
  authorizeQuery(actorId: string, projectId: string, environmentId: string | null): unknown
  drivers: Partial<Record<C.EnvironmentMcpConfiguration['type'], EnvironmentMcpReadonlyDriver>>
  timeoutMs?: number
}
interface FrozenConnection {
  id: string
  revision: number
  configuration: C.EnvironmentMcpConfiguration
  actions: C.EnvironmentMcpAction[]
  credentialVersion?: WorkspaceCredentialVersionReference
}
type Row = Record<string, string | number | bigint | null | Uint8Array>
const nativeId = S.String.check(
  S.isMinLength(1),
  S.isMaxLength(256),
  S.isPattern(/^[^\x00-\x1f\x7f]+$/),
)
const scopeSchema = S.Struct({
  actorId: DirectoryId,
  projectId: DirectoryId,
  environmentId: S.Union([DirectoryId, S.Null]),
  threadId: nativeId,
  runId: nativeId,
})
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
    )
  })
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const now = () => new Date().toISOString()
function decode<T extends S.ConstraintDecoder<unknown>>(schema: T, input: unknown): T['Type'] {
  try {
    return S.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)
  } catch {
    return fail(400, 'ENVIRONMENT_MCP_INPUT_INVALID', '环境连接字段、动作或长度无效')
  }
}
const safeDriverError = (cause: unknown) =>
  cause instanceof EnvironmentMcpError && /^[A-Z][A-Z0-9_]{0,79}$/.test(cause.code)
    ? new EnvironmentMcpError(
        Number.isInteger(cause.status) && cause.status >= 400 && cause.status <= 599
          ? cause.status
          : 502,
        cause.code,
        cause.message.slice(0, 300),
      )
    : new EnvironmentMcpError(
        502,
        'ENVIRONMENT_MCP_CONNECTION_FAILED',
        '连接读取失败，请核对环境配置和连接状态后重试',
      )
const errorValue = (cause: EnvironmentMcpError) => ({
  code: cause.code,
  message: cause.message.slice(0, 300),
})
function driverRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return operation().catch((cause) => {
      throw safeDriverError(cause)
    })
  } catch (cause) {
    throw safeDriverError(cause)
  }
}
const isAccessFailure = (cause: unknown): cause is { status: number } =>
  Boolean(
    cause &&
    typeof cause === 'object' &&
    'status' in cause &&
    [401, 403, 404].includes(Number(cause.status)),
  )

export function createEnvironmentMcp(options: Options) {
  const timeoutMs = options.timeoutMs ?? 10000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new TypeError('环境连接超时必须在 1 到 30000 毫秒之间')
  const limits: Readonly<EnvironmentMcpLimits> = Object.freeze({
    timeoutMs,
    maxRows: 200,
    maxKeys: 200,
    maxBytes: 262144,
  })
  const directory = join(options.dataDir, 'environment-mcp')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const database = openDatabase(join(directory, 'state.sqlite'), migrations)
  const { db, transaction } = database
  let accepting = true,
    closed = false
  let closing: Promise<void> | undefined
  const reads = new Map<
    symbol,
    {
      controller: AbortController
      work: Promise<unknown>
      project: string
      environment: string
      kind: 'test' | 'query'
    }
  >()
  const tests = new Map<
    string,
    { fingerprint: string; connectionId: string; work: Promise<C.EnvironmentMcpTestResult> }
  >()
  // 只读测试的未知结果不自治重放；原请求明确核对中断状态，重测使用新的请求标识。
  db.prepare("UPDATE mcp_receipts SET status='failed',error=? WHERE status='pending'").run(
    JSON.stringify({
      code: 'ENVIRONMENT_MCP_TEST_INTERRUPTED',
      message: '服务重启中断了连接测试，请发起新的测试请求',
    }),
  )
  function ensureAccepting() {
    if (!accepting || closed) fail(503, 'ENVIRONMENT_MCP_STOPPING', '环境连接服务正在停止接单')
  }
  function authorization(decision: unknown) {
    if (decision && typeof decision === 'object' && 'then' in decision) {
      void Promise.resolve(decision).catch(() => {})
      fail(503, 'ENVIRONMENT_MCP_AUTHORIZATION_INVALID', '环境连接授权必须同步返回当前裁决')
    }
    if (decision === false) fail(403, 'ENVIRONMENT_MCP_FORBIDDEN', '当前环境连接操作未授权')
  }
  function manage(projectId: string, environmentId: string, actorId: string) {
    ensureAccepting()
    decode(DirectoryId, projectId)
    decode(DirectoryId, environmentId)
    decode(DirectoryId, actorId)
    authorization(options.authorizeManage(actorId, projectId, environmentId))
  }
  function query(scope: EnvironmentMcpScope) {
    ensureAccepting()
    const fixed = decode(scopeSchema, scope)
    authorization(options.authorizeQuery(fixed.actorId, fixed.projectId, fixed.environmentId))
    return fixed
  }
  function connectionRow(project: string, environment: string, id: string) {
    return (
      db
        .prepare(
          'SELECT c.*,v.configuration,v.configuration_hash FROM mcp_connections c JOIN mcp_connection_versions v ON v.connection_id=c.id AND v.revision=c.revision WHERE c.id=? AND c.project_id=? AND c.environment_id=?',
        )
        .get(decode(DirectoryId, id), project, environment) ??
      fail(404, 'ENVIRONMENT_MCP_NOT_FOUND', '连接不存在或不属于当前环境')
    )
  }
  function activeRow(project: string, environment: string, id: string) {
    const row = connectionRow(project, environment, id)
    if (row.removed) fail(410, 'ENVIRONMENT_MCP_REMOVED', '环境连接已经移除')
    return row
  }
  const configurationOf = (row: Row) =>
    JSON.parse(String(row.configuration)) as C.EnvironmentMcpConfiguration
  function credential(
    actor: string,
    project: string,
    configuration: C.EnvironmentMcpConfiguration,
  ) {
    return configuration.credentialId
      ? options.credentials.referenceVersion(actor, project, configuration.credentialId)
      : undefined
  }
  function testFor(row: Row) {
    const value = db
      .prepare('SELECT * FROM mcp_connection_tests WHERE connection_id=? AND configuration_hash=?')
      .get(row.id!, row.configuration_hash!)
    return value
      ? {
          result: JSON.parse(String(value.result)) as C.EnvironmentMcpTestResult,
          credentialVersion: value.credential_version
            ? (JSON.parse(String(value.credential_version)) as WorkspaceCredentialVersionReference)
            : undefined,
        }
      : undefined
  }
  function view(row: Row): C.EnvironmentMcpConnection {
    const test = testFor(row)
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      environmentId: String(row.environment_id),
      revision: Number(row.revision),
      enabled: Boolean(row.enabled),
      removed: Boolean(row.removed),
      configuration: configurationOf(row),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(test ? { lastTest: test.result } : {}),
    }
  }
  function receiptRow(project: string, environment: string, actor: string, request: string) {
    return db
      .prepare(
        'SELECT * FROM mcp_receipts WHERE project_id=? AND environment_id=? AND actor_id=? AND request_id=?',
      )
      .get(project, environment, actor, request)
  }
  function receiptView(row: Row): C.EnvironmentMcpReceipt {
    return {
      status: String(row.status) as C.EnvironmentMcpReceipt['status'],
      ...(row.result
        ? {
            result: JSON.parse(String(row.result)) as
              C.EnvironmentMcpConnection | C.EnvironmentMcpTestResult | C.EnvironmentMcpDeletion,
          }
        : {}),
      ...(row.error
        ? { error: JSON.parse(String(row.error)) as { code: string; message: string } }
        : {}),
    }
  }
  function original(row: Row, fingerprint: string) {
    if (row.fingerprint !== fingerprint)
      fail(409, 'ENVIRONMENT_MCP_REQUEST_CONFLICT', '原请求已经固定其他连接操作或参数')
    const receipt = receiptView(row)
    if (receipt.status === 'failed') fail(409, receipt.error!.code, receipt.error!.message)
    if (receipt.status === 'pending')
      fail(409, 'ENVIRONMENT_MCP_TEST_PENDING', '原连接测试仍在执行，请核对原请求')
    return receipt.result!
  }
  function mutation<T extends C.EnvironmentMcpConnection | C.EnvironmentMcpDeletion>(
    project: string,
    environment: string,
    actor: string,
    command: C.EnvironmentMcpCommand,
    operation: string,
    id: string | null,
    input: unknown,
    run: () => T,
  ) {
    manage(project, environment, actor)
    const fingerprint = digest({ operation, id, input })
    return transaction.run(() => {
      const existing = receiptRow(project, environment, actor, command.requestId)
      if (existing) return original(existing, fingerprint) as T
      const result = run()
      db.prepare("INSERT INTO mcp_receipts VALUES(?,?,?,?,?,?,'completed',?,NULL)").run(
        project,
        environment,
        actor,
        command.requestId,
        fingerprint,
        operation,
        JSON.stringify(result),
      )
      if (operation !== 'remove')
        db.prepare(
          'INSERT INTO mcp_audit(project_id,environment_id,actor_id,request_id,operation,connection_id,revision,created_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          project,
          environment,
          actor,
          command.requestId,
          operation,
          result.id,
          result.revision,
          now(),
        )
      return result
    })
  }
  function checkRevision(row: Row, expected: number) {
    if (Number(row.revision) !== expected)
      fail(409, 'ENVIRONMENT_MCP_REVISION_CONFLICT', '环境连接已修改，请刷新后重新确认')
  }
  function nextVersion(
    row: Row,
    configuration: C.EnvironmentMcpConfiguration,
    actor: string,
    enabled: boolean,
    removed = false,
  ) {
    const revision = Number(row.revision) + 1,
      time = now()
    db.prepare('INSERT INTO mcp_connection_versions VALUES(?,?,?,?,?,?)').run(
      row.id!,
      revision,
      JSON.stringify(configuration),
      digest(configuration),
      actor,
      time,
    )
    db.prepare(
      'UPDATE mcp_connections SET revision=?,enabled=?,removed=?,updated_at=? WHERE id=?',
    ).run(revision, Number(enabled), Number(removed), time, row.id!)
    return view(connectionRow(String(row.project_id), String(row.environment_id), String(row.id)))
  }
  function requireVerification(
    row: Row,
    reference: WorkspaceCredentialVersionReference | undefined,
  ) {
    const tested = testFor(row)
    if (
      !tested ||
      tested.result.status !== 'passed' ||
      canonical(tested.credentialVersion ?? null) !== canonical(reference ?? null)
    )
      fail(409, 'ENVIRONMENT_MCP_TEST_REQUIRED', '此配置及凭证版本尚未通过只读能力测试')
    return tested.result.actions
  }
  async function readWork<T>(
    run: (context: EnvironmentMcpDriverContext) => Promise<T>,
    identity: { project: string; environment: string; kind: 'test' | 'query' },
    signal?: AbortSignal,
  ): Promise<T> {
    ensureAccepting()
    if (signal?.aborted)
      fail(
        499,
        'ENVIRONMENT_MCP_READ_INTERRUPTED',
        '读取已中断；已发出的远端请求结果仍按实际回执核对',
      )
    if (reads.size >= 2) fail(429, 'ENVIRONMENT_MCP_BUSY', '已有环境连接正在读取，请稍后重试')
    const controller = new AbortController(),
      key = Symbol('环境读取')
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return run({ signal: controller.signal, limits })
    })
    reads.set(key, { controller, work, ...identity })
    void work.finally(() => reads.delete(key)).catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    let interrupted: (() => void) | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          interrupted = () =>
            reject(
              new EnvironmentMcpError(
                499,
                'ENVIRONMENT_MCP_READ_INTERRUPTED',
                '读取已中断；已发出的远端请求结果仍按实际回执核对',
              ),
            )
          controller.signal.addEventListener('abort', interrupted, { once: true })
          timer = setTimeout(() => {
            reject(
              new EnvironmentMcpError(
                504,
                'ENVIRONMENT_MCP_TIMEOUT',
                '环境连接读取超时，未取得完整结果',
              ),
            )
            controller.abort()
          }, timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (interrupted) controller.signal.removeEventListener('abort', interrupted)
      signal?.removeEventListener('abort', abort)
    }
  }
  function driver(configuration: C.EnvironmentMcpConfiguration) {
    return (
      options.drivers[configuration.type] ??
      fail(503, 'ENVIRONMENT_MCP_DRIVER_UNAVAILABLE', '此类型的环境连接尚未接入真实读取能力')
    )
  }
  function withCredential<T>(
    actor: string,
    project: string,
    reference: WorkspaceCredentialVersionReference | undefined,
    operation: (value: GitCredential | undefined) => Promise<T>,
  ) {
    return reference
      ? options.credentials.withCredential(actor, project, reference, operation)
      : operation(undefined)
  }
  function runRow(scope: EnvironmentMcpScope) {
    const row = db
      .prepare('SELECT * FROM mcp_runs WHERE thread_id=? AND run_id=?')
      .get(scope.threadId, scope.runId)
    if (!row)
      fail(
        409,
        'ENVIRONMENT_MCP_RUN_MISSING',
        '本轮环境输入尚未在原生接单时固定，不能临时选择最新目标',
      )
    if (
      row.actor_id !== scope.actorId ||
      row.project_id !== scope.projectId ||
      row.environment_id !== scope.environmentId
    )
      fail(403, 'ENVIRONMENT_MCP_RUN_FORBIDDEN', '环境输入不属于本轮实际调用者和固定范围')
    return row
  }
  function runView(row: Row): C.EnvironmentMcpRunCatalog {
    const connections = JSON.parse(String(row.connections)) as FrozenConnection[]
    return {
      status: row.status as C.EnvironmentMcpRunCatalog['status'],
      threadId: String(row.thread_id),
      runId: String(row.run_id),
      projectId: String(row.project_id),
      environmentId: row.environment_id === null ? null : String(row.environment_id),
      capturedAt: String(row.captured_at),
      connections: connections.map((value) => resource(value)),
      unavailable: JSON.parse(String(row.unavailable)) as C.EnvironmentMcpRunCatalog['unavailable'],
    }
  }
  function currentConnection(scope: EnvironmentMcpScope, frozen: FrozenConnection) {
    query(scope)
    if (scope.environmentId === null)
      fail(403, 'ENVIRONMENT_MCP_ENVIRONMENT_REQUIRED', '本轮未选择环境，不能调用环境连接')
    const row = activeRow(scope.projectId, scope.environmentId, frozen.id)
    if (!row.enabled) fail(403, 'ENVIRONMENT_MCP_DISABLED', '环境连接已经停用')
    if (frozen.credentialVersion)
      options.credentials.referenceVersion(
        scope.actorId,
        scope.projectId,
        frozen.credentialVersion.credentialId,
      )
  }
  function purgeConnection(id: string) {
    for (const [key, running] of tests) {
      if (running.connectionId !== id) continue
      const [project, environment, actor, requestId] = JSON.parse(key) as string[]
      db.prepare('DELETE FROM mcp_receipts WHERE project_id=? AND environment_id=? AND actor_id=? AND request_id=?').run(project!, environment!, actor!, requestId!)
    }
    for (const table of ['mcp_connection_tests', 'mcp_connection_versions'])
      db.prepare(`DELETE FROM ${table} WHERE connection_id=?`).run(id)
    db.prepare('DELETE FROM mcp_audit WHERE connection_id=?').run(id)
    db.prepare(
      "DELETE FROM mcp_receipts WHERE json_extract(result,'$.id')=? OR json_extract(result,'$.connectionId')=?",
    ).run(id, id)
    for (const row of db.prepare('SELECT thread_id,run_id,connections FROM mcp_runs').all()) {
      const connections = JSON.parse(String(row.connections)) as FrozenConnection[]
      if (connections.some((value) => value.id === id))
        db.prepare('UPDATE mcp_runs SET connections=? WHERE thread_id=? AND run_id=?').run(
          JSON.stringify(connections.filter((value) => value.id !== id)),
          row.thread_id!,
          row.run_id!,
        )
    }
    db.prepare('DELETE FROM mcp_connections WHERE id=?').run(id)
  }
  const api = {
    removeCredentialConnections(project: string, credentialId: string) {
      transaction.run(() => {
        const rows = db
          .prepare(
            "SELECT c.id FROM mcp_connections c JOIN mcp_connection_versions v ON v.connection_id=c.id AND v.revision=c.revision WHERE c.project_id=? AND json_extract(v.configuration,'$.credentialId')=?",
          )
          .all(project, credentialId)
        for (const row of rows) purgeConnection(String(row.id))
      })
    },
    purgeScope(project: string, environment?: string) {
      transaction.run(() => {
        const where =
          environment === undefined ? 'project_id=?' : 'project_id=? AND environment_id=?'
        const args = environment === undefined ? [project] : [project, environment]
        for (const row of db.prepare(`SELECT id FROM mcp_connections WHERE ${where}`).all(...args))
          purgeConnection(String(row.id))
        for (const table of ['mcp_runs', 'mcp_receipts', 'mcp_audit'])
          db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...args)
      })
    },
    list(project: string, environment: string, actor: string) {
      manage(project, environment, actor)
      return db
        .prepare(
          'SELECT id FROM mcp_connections WHERE project_id=? AND environment_id=? AND removed=0 ORDER BY created_at,id',
        )
        .all(project, environment)
        .map((row) => view(connectionRow(project, environment, String(row.id))))
    },
    receipt(project: string, environment: string, requestId: string, actor: string) {
      manage(project, environment, actor)
      const row = receiptRow(project, environment, actor, decode(DirectoryId, requestId))
      return row ? receiptView(row) : null
    },
    save(
      project: string,
      environment: string,
      input: unknown,
      actor: string,
      id: string | null = null,
    ) {
      const command = decode(C.SaveEnvironmentMcp, input),
        configuration = validateConfiguration(command.value)
      return mutation(project, environment, actor, command, 'save', id, command, () => {
        if (configuration.credentialId) credential(actor, project, configuration)
        if (id !== null) {
          const current = activeRow(project, environment, id)
          checkRevision(current, command.expectedRevision)
          return nextVersion(current, configuration, actor, Boolean(current.enabled))
        }
        if (command.expectedRevision !== 0)
          fail(409, 'ENVIRONMENT_MCP_REVISION_CONFLICT', '新增环境连接的修订号必须为零')
        if (api.list(project, environment, actor).length >= 32)
          fail(409, 'ENVIRONMENT_MCP_LIMIT', '本环境连接数量已达到上限')
        const connectionId = randomUUID(),
          time = now()
        db.prepare('INSERT INTO mcp_connections VALUES(?,?,?,1,0,0,?,?)').run(
          connectionId,
          project,
          environment,
          time,
          time,
        )
        db.prepare('INSERT INTO mcp_connection_versions VALUES(?,1,?,?,?,?)').run(
          connectionId,
          JSON.stringify(configuration),
          digest(configuration),
          actor,
          time,
        )
        return view(connectionRow(project, environment, connectionId))
      })
    },
    setEnabled(project: string, environment: string, id: string, input: unknown, actor: string) {
      const command = decode(C.SetEnvironmentMcpEnabled, input)
      return mutation(project, environment, actor, command, 'enabled', id, command, () => {
        const current = activeRow(project, environment, id)
        checkRevision(current, command.expectedRevision)
        const configuration = configurationOf(current)
        if (command.enabled) requireVerification(current, credential(actor, project, configuration))
        return nextVersion(current, configuration, actor, command.enabled)
      })
    },
    remove(project: string, environment: string, id: string, input: unknown, actor: string) {
      const command = decode(C.EnvironmentMcpCommand, input)
      return mutation(project, environment, actor, command, 'remove', id, command, () => {
        const current = activeRow(project, environment, id)
        checkRevision(current, command.expectedRevision)
        const result: C.EnvironmentMcpDeletion = {
          id,
          projectId: project,
          environmentId: environment,
          revision: Number(current.revision) + 1,
          removed: true,
        }
        purgeConnection(id)
        return result
      })
    },
    async testConnection(
      project: string,
      environment: string,
      id: string,
      input: unknown,
      actor: string,
      signal?: AbortSignal,
    ): Promise<C.EnvironmentMcpTestResult> {
      manage(project, environment, actor)
      const command = decode(C.EnvironmentMcpCommand, input),
        fingerprint = digest({ operation: 'test', id, input: command })
      const key = canonical([project, environment, actor, command.requestId]),
        running = tests.get(key)
      if (running) {
        if (running.fingerprint !== fingerprint)
          fail(409, 'ENVIRONMENT_MCP_REQUEST_CONFLICT', '原请求已经固定其他连接测试参数')
        return running.work
      }
      const existing = receiptRow(project, environment, actor, command.requestId)
      if (existing) return original(existing, fingerprint) as C.EnvironmentMcpTestResult
      const current = activeRow(project, environment, id)
      checkRevision(current, command.expectedRevision)
      const configuration = configurationOf(current),
        reference = credential(actor, project, configuration),
        selected = driver(configuration)
      db.prepare("INSERT INTO mcp_receipts VALUES(?,?,?,?,?,?,'pending',NULL,NULL)").run(
        project,
        environment,
        actor,
        command.requestId,
        fingerprint,
        'test',
      )
      const work = (async () => {
        try {
          const result = await readWork(
            (context) =>
              withCredential(actor, project, reference, (secret) =>
                driverRead(() => selected.test(configuration, secret, context)),
              ),
            { project, environment, kind: 'test' },
            signal,
          )
          manage(project, environment, actor)
          const latest = activeRow(project, environment, id)
          checkRevision(latest, command.expectedRevision)
          if (
            canonical(credential(actor, project, configuration) ?? null) !==
            canonical(reference ?? null)
          )
            fail(409, 'ENVIRONMENT_MCP_CREDENTIAL_CHANGED', '凭证版本已变化，请重新测试')
          if (
            !Array.isArray(result.actions) ||
            result.actions.length === 0 ||
            new Set(result.actions).size !== result.actions.length ||
            result.actions.some((action) => !actionsFor[configuration.type].includes(action))
          )
            fail(502, 'ENVIRONMENT_MCP_VERIFICATION_INVALID', '连接未返回有效的固定只读能力证明')
          const value: C.EnvironmentMcpTestResult = {
            connectionId: id,
            revision: Number(current.revision),
            testedAt: now(),
            status: 'passed',
            actions: [...result.actions],
          }
          transaction.run(() => {
            db.prepare(
              'INSERT INTO mcp_connection_tests VALUES(?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET configuration_hash=excluded.configuration_hash,credential_version=excluded.credential_version,result=excluded.result',
            ).run(
              id,
              String(current.configuration_hash),
              reference ? JSON.stringify(reference) : null,
              JSON.stringify(value),
            )
            db.prepare(
              "UPDATE mcp_receipts SET status='completed',result=? WHERE project_id=? AND environment_id=? AND actor_id=? AND request_id=?",
            ).run(JSON.stringify(value), project, environment, actor, command.requestId)
          })
          return value
        } catch (cause) {
          const error =
            cause instanceof EnvironmentMcpError ||
            cause instanceof CredentialError ||
            isAccessFailure(cause)
              ? cause
              : safeDriverError(cause)
          const safe =
            error instanceof EnvironmentMcpError || error instanceof CredentialError
              ? errorValue(error)
              : {
                  code: 'ENVIRONMENT_MCP_ACCESS_CHANGED',
                  message: '测试期间授权发生变化，请重新核对原请求',
                }
          const value: C.EnvironmentMcpTestResult = {
            connectionId: id,
            revision: Number(current.revision),
            testedAt: now(),
            status: 'failed',
            actions: [],
            error: safe,
          }
          transaction.run(() => {
            if (!db.prepare('SELECT 1 FROM mcp_connections WHERE id=?').get(id)) {
              db.prepare('DELETE FROM mcp_receipts WHERE project_id=? AND environment_id=? AND actor_id=? AND request_id=?').run(project, environment, actor, command.requestId)
              return
            }
            const latest = connectionRow(project, environment, id)
            if (latest.revision === current.revision)
              db.prepare(
                'INSERT INTO mcp_connection_tests VALUES(?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET configuration_hash=excluded.configuration_hash,credential_version=excluded.credential_version,result=excluded.result',
              ).run(
                id,
                String(current.configuration_hash),
                reference ? JSON.stringify(reference) : null,
                JSON.stringify(value),
              )
            db.prepare(
              "UPDATE mcp_receipts SET status='failed',result=?,error=? WHERE project_id=? AND environment_id=? AND actor_id=? AND request_id=?",
            ).run(
              JSON.stringify(value),
              JSON.stringify(safe),
              project,
              environment,
              actor,
              command.requestId,
            )
          })
          throw error
        }
      })()
      tests.set(key, { fingerprint, connectionId: id, work })
      void work.finally(() => tests.delete(key)).catch(() => {})
      return work
    },
    prepareRun(input: EnvironmentMcpScope, inheritedRunId?: string): C.EnvironmentMcpRunCatalog {
      const scope = query(input)
      if (inheritedRunId !== undefined) decode(nativeId, inheritedRunId)
      const previous = db
        .prepare('SELECT 1 FROM mcp_runs WHERE thread_id=? AND run_id=?')
        .get(scope.threadId, scope.runId)
      if (previous) {
        const row = runRow(scope)
        if (row.inherited_run_id !== (inheritedRunId ?? null))
          fail(409, 'ENVIRONMENT_MCP_RUN_CONFLICT', '本轮已经固定其他环境输入来源')
        return runView(row)
      }
      return transaction.run(() => {
        const connections: FrozenConnection[] = [],
          unavailable: C.EnvironmentMcpRunCatalog['unavailable'] = []
        if (inheritedRunId !== undefined) {
          const original = db
            .prepare('SELECT * FROM mcp_runs WHERE thread_id=? AND run_id=?')
            .get(scope.threadId, inheritedRunId)
          if (!original)
            fail(
              409,
              'ENVIRONMENT_MCP_ORIGINAL_RUN_MISSING',
              '原轮环境输入不存在，不能改读最新连接',
            )
          if (
            original.project_id !== scope.projectId ||
            original.environment_id !== scope.environmentId
          )
            fail(403, 'ENVIRONMENT_MCP_RUN_FORBIDDEN', '原轮环境输入不属于本轮固定项目和环境')
          // 恢复沿用原配置与凭证版本，当前调用者仍在准备和每次实际读取时独立授权。
          connections.push(...(JSON.parse(String(original.connections)) as FrozenConnection[]))
          unavailable.push(
            ...(JSON.parse(
              String(original.unavailable),
            ) as C.EnvironmentMcpRunCatalog['unavailable']),
          )
        } else if (scope.environmentId !== null) {
          const rows = db
            .prepare(
              'SELECT id FROM mcp_connections WHERE project_id=? AND environment_id=? AND removed=0 AND enabled=1 ORDER BY created_at,id',
            )
            .all(scope.projectId, scope.environmentId)
          for (const value of rows) {
            const row = activeRow(scope.projectId, scope.environmentId, String(value.id)),
              configuration = configurationOf(row)
            try {
              const reference = credential(scope.actorId, scope.projectId, configuration)
              const actions = requireVerification(row, reference)
              driver(configuration)
              connections.push({
                id: String(row.id),
                revision: Number(row.revision),
                configuration,
                actions: [...actions],
                ...(reference ? { credentialVersion: reference } : {}),
              })
            } catch (cause) {
              // 缺少能力或凭证只影响该连接，不把未知授权失败伪装成空目录。
              if (!(
                (cause instanceof EnvironmentMcpError &&
                  ['ENVIRONMENT_MCP_TEST_REQUIRED', 'ENVIRONMENT_MCP_DRIVER_UNAVAILABLE'].includes(
                    cause.code,
                  )) ||
                (cause instanceof CredentialError &&
                  [
                    'CREDENTIAL_REVOKED',
                    'CREDENTIAL_NOT_FOUND',
                    'CREDENTIAL_VERSION_NOT_FOUND',
                  ].includes(cause.code))
              ))
                throw cause
              unavailable.push({
                id: String(row.id),
                name: configuration.name,
                ...errorValue(cause),
              })
            }
          }
        }
        query(scope)
        db.prepare("INSERT INTO mcp_runs VALUES(?,?,?,?,?,?,?,?,'active',?)").run(
          scope.threadId,
          scope.runId,
          scope.projectId,
          scope.environmentId,
          scope.actorId,
          now(),
          JSON.stringify(connections),
          JSON.stringify(unavailable),
          inheritedRunId ?? null,
        )
        return runView(runRow(scope))
      })
    },
    // 只供已登记原生新子轮引用的可信入口恢复原收据；不会选择当前目录或凭证版本。
    retainRunAfterNativeReference(input:EnvironmentMcpScope) {
      const scope=query(input)
      runRow(scope)
      db.prepare("UPDATE mcp_runs SET status='active' WHERE thread_id=? AND run_id=?").run(scope.threadId,scope.runId)
      return runView(runRow(scope))
    },
    readRun(scope: EnvironmentMcpScope) {
      query(scope)
      return runView(runRow(scope))
    },
    // 只由可信原生终态协调调用，不向 HTTP 或模型开放；释放事实不删除原输入收据。
    releaseRun(input: EnvironmentMcpScope) {
      if (closed) fail(503, 'ENVIRONMENT_MCP_STOPPING', '环境连接服务已经关闭')
      const scope = decode(scopeSchema, input)
      runRow(scope)
      db.prepare("UPDATE mcp_runs SET status='released' WHERE thread_id=? AND run_id=?").run(
        scope.threadId,
        scope.runId,
      )
      return runView(runRow(scope))
    },
    // 删除协调已经完成管理裁决；这里只返回所属模块的阻止事实，绝不返回连接配置。
    deletionReferences(
      projectId: string,
      environmentId?: string,
    ): Array<{ kind: string; count: number; message: string }> {
      if (closed) fail(503, 'ENVIRONMENT_MCP_STOPPING', '环境连接服务已经关闭')
      decode(DirectoryId, projectId)
      if (environmentId !== undefined) decode(DirectoryId, environmentId)
      const selection =
        environmentId === undefined ? 'project_id=?' : 'project_id=? AND environment_id=?'
      const parameters = environmentId === undefined ? [projectId] : [projectId, environmentId]
      const count = (table: string, condition: string) =>
        Number(
          db
            .prepare(`SELECT count(*) AS count FROM ${table} WHERE ${selection} AND ${condition}`)
            .get(...parameters)!.count,
        )
      const pendingTests = count('mcp_receipts', "operation='test' AND status='pending'")
      const activeReads = [...reads.values()].filter(
        (value) =>
          value.project === projectId &&
          (environmentId === undefined || value.environment === environmentId),
      )
      return [
        {
          kind: 'environment-mcp-connections',
          count: count('mcp_connections', 'removed=0'),
          message: '仍有未移除的环境连接',
        },
        {
          kind: 'environment-mcp-tests',
          count: Math.max(
            pendingTests,
            activeReads.filter((value) => value.kind === 'test').length,
          ),
          message: '仍有活动或结果待核对的环境连接测试',
        },
        {
          kind: 'environment-mcp-reads',
          count: activeReads.filter((value) => value.kind === 'query').length,
          message: '仍有环境连接读取等待真实回执',
        },
        {
          kind: 'environment-mcp-runs',
          count: count('mcp_runs', "status='active'"),
          message: '仍有未确认终态的问答环境输入',
        },
      ].filter((value) => value.count > 0)
    },
    async invoke(
      scope: EnvironmentMcpScope,
      input: unknown,
      signal?: AbortSignal,
    ): Promise<C.EnvironmentMcpQueryResult> {
      const fixed = query(scope),
        run = runRow(fixed)
      if (run.status === 'released')
        fail(410, 'ENVIRONMENT_MCP_RUN_RELEASED', '本轮已确认结束，环境输入已经释放')
      const operation = decode(C.EnvironmentMcpOperation, input),
        frozen = (JSON.parse(String(run.connections)) as FrozenConnection[]).find(
          (value) => value.id === operation.connectionId,
        )
      if (!frozen) fail(403, 'ENVIRONMENT_MCP_CONNECTION_FORBIDDEN', '连接不属于本轮固定的环境输入')
      if (!frozen.actions.includes(operation.action))
        fail(403, 'ENVIRONMENT_MCP_ACTION_FORBIDDEN', '此操作未通过本连接的只读能力测试')
      validateOperation(frozen.configuration, operation)
      currentConnection(fixed, frozen)
      const result = await readWork(
        (context) =>
          withCredential(fixed.actorId, fixed.projectId, frozen.credentialVersion, (secret) =>
            driverRead(() =>
              driver(frozen.configuration).execute(
                frozen.configuration,
                operation,
                secret,
                context,
              ),
            ),
          ),
        { project: fixed.projectId, environment: fixed.environmentId!, kind: 'query' },
        signal,
      )
      currentConnection(fixed, frozen)
      if (runRow(fixed).status === 'released')
        fail(410, 'ENVIRONMENT_MCP_RUN_RELEASED', '本轮已确认结束，迟到读取不再返回')
      let serialized: string
      try {
        serialized = JSON.stringify(result.data)
      } catch {
        return fail(502, 'ENVIRONMENT_MCP_RESULT_INVALID', '环境读取返回了无效数据')
      }
      if (typeof result.truncated !== 'boolean' || typeof serialized !== 'string')
        fail(502, 'ENVIRONMENT_MCP_RESULT_INVALID', '环境读取返回了无效数据')
      if (Buffer.byteLength(serialized) > limits.maxBytes)
        fail(502, 'ENVIRONMENT_MCP_RESULT_LIMIT', '环境读取结果超过字节上限，请缩小查询范围')
      return {
        source: 'environment_mcp',
        connectionId: frozen.id,
        connectionName: frozen.configuration.name,
        connectionType: frozen.configuration.type,
        connectionRevision: frozen.revision,
        projectId: fixed.projectId,
        environmentId: fixed.environmentId!,
        observedAt: now(),
        data: JSON.parse(serialized) as unknown,
        truncated: result.truncated,
      }
    },
    stopAccepting() {
      accepting = false
      for (const value of reads.values()) value.controller.abort()
    },
    async drain() {
      await Promise.allSettled([...reads.values()].map((value) => value.work))
      await Promise.allSettled([...tests.values()].map((value) => value.work))
    },
    close(): Promise<void> {
      if (closing) return closing
      api.stopAccepting()
      closing = (async () => {
        await api.drain()
        const results = await Promise.allSettled(
          [...new Set(Object.values(options.drivers))].map((value) =>
            Promise.resolve().then(() => value.close()),
          ),
        )
        closed = true
        database.close()
        const errors = results
          .filter((value) => value.status === 'rejected')
          .map((value) => value.reason)
        if (errors.length) throw new AggregateError(errors, '环境连接驱动关闭失败')
      })()
      return closing
    },
  }
  return api
}
export type EnvironmentMcp = ReturnType<typeof createEnvironmentMcp>
