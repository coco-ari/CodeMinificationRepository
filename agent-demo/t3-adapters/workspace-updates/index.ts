// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- 独立 Node 资料所有者管理 SQLite 收据和可释放的到期唤醒，不依赖 T3 Effect 宿主。
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SQLInputValue } from 'node:sqlite'
import { decodeContract } from '../../../autoops/contracts/index.ts'
import {
  SaveWorkspaceUpdate,
  RunWorkspaceUpdate,
  type WorkspaceUpdateOverview,
  type WorkspaceUpdatePlan,
  type WorkspaceUpdateRun,
  type WorkspaceUpdateScope,
} from '../../../autoops/contracts/workspace-updates.ts'
import type { WorkspaceTask } from '../../../autoops/contracts/workspaces.ts'
import { openWorkspaceUpdateDatabase } from './storage.ts'

type Row = Record<string, SQLInputValue>
export interface WorkspaceUpdateCommand {
  requestId: string
  expectedRevision: number
  rules?: Array<{ find: string; replace: string }>
}
export interface WorkspaceUpdateSources {
  revision: number
  sourceIds: string[]
  fingerprint: string
  names?: Record<string, string>
}
export interface WorkspaceUpdateReceipt {
  task?: WorkspaceTask
  capture?: { resolution: 'pending' | 'resolved' | 'failed'; resolutionError?: { code: string } }
  versionStatus?: 'published' | 'pending_review' | 'failed'
}
export interface WorkspaceUpdatePorts {
  authorize(
    actorId: string,
    projectId: string,
    scope: WorkspaceUpdateScope,
    action: 'read' | 'manage',
  ): void
  sources(projectId: string, actorId: string): WorkspaceUpdateSources
  busy(projectId: string, scope: WorkspaceUpdateScope, actorId: string): boolean
  start(
    projectId: string,
    scope: WorkspaceUpdateScope,
    input: WorkspaceUpdateCommand,
    actorId: string,
    signal: AbortSignal,
  ): Promise<WorkspaceTask>
  receipt(
    projectId: string,
    scope: WorkspaceUpdateScope,
    requestId: string,
    actorId: string,
  ): WorkspaceUpdateReceipt
  settled?(
    projectId: string,
    scope: WorkspaceUpdateScope,
    requestId: string,
    taskId: string,
  ): WorkspaceUpdateReceipt | null
}

export class WorkspaceUpdateError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new WorkspaceUpdateError(status, code, message)
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const asText = (row: Row, key: string) => String(row[key])
const terminal = (task: WorkspaceTask) =>
  ['completed', 'failed', 'interrupted'].includes(task.status)
const errorCode = (error: unknown) =>
  error &&
  typeof error === 'object' &&
  'code' in error &&
  typeof error.code === 'string' &&
  /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code
    : 'WORKSPACE_UPDATE_UNAVAILABLE'
const errorStatus = (error: unknown) =>
  error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status
    : 503
const messages: Record<string, string> = {
  WORKSPACE_UPDATE_PERMISSION_REVOKED: '更新配置者已失去工作区维护权限，请由有权限的管理者重新设置',
  WORKSPACE_UPDATE_SOURCE_WITHDRAWN: '更新来源已移除，请重新核对更新设置',
  WORKSPACE_UPDATE_SOURCE_CHANGED: '来源在更新准备期间发生变化，请核对原任务和当前资料',
  WORKSPACE_UPDATE_UNKNOWN: '原更新结果尚未核实，保留原请求并等待核对',
  WORKSPACE_UPDATE_FAILED: '资料更新失败，保留上次有效内容',
  WORKSPACE_UPDATE_REJECTED: '资料更新未被接受，请核对权限及来源后重试',
}
const safeError = (code: string) => ({
  code,
  message: messages[code] ?? messages.WORKSPACE_UPDATE_FAILED!,
})
function synchronous<T>(value: T): T {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
    void Promise.resolve(value).catch(() => {})
    fail(503, 'WORKSPACE_UPDATE_PORT_INVALID', '资料更新的授权与收据查询必须同步返回当前事实')
  }
  return value
}

// 定时器只负责到期唤醒；耗时工作和结果仍属于现有工作区任务，不建立第二份任务队列。
export function createWorkspaceUpdates({
  dataDir,
  ports,
  now = Date.now,
  pollMs = 30_000,
  onError = () => {},
}: {
  dataDir: string
  ports: WorkspaceUpdatePorts
  now?: () => number
  pollMs?: number
  onError?: (event: { event: string; code: string }) => void
}) {
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 60_000)
    fail(500, 'WORKSPACE_UPDATE_POLL_INVALID', '资料更新检查间隔无效')
  const directory = join(dataDir, 'workspace-updates')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const database = openWorkspaceUpdateDatabase(join(directory, 'state.sqlite'))
  const { db, transaction } = database
  const works = new Map<string, { controller: AbortController; work: Promise<WorkspaceTask> }>()
  let stopping = false
  let closed = false
  let ticking: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const time = () => new Date(now()).toISOString()
  function ensureAccepting() {
    if (stopping) fail(503, 'WORKSPACE_UPDATE_STOPPING', '资料更新正在停止接单')
  }
  function requireAccess(
    project: string,
    actor: string,
    scope: WorkspaceUpdateScope,
    action: 'read' | 'manage',
  ) {
    if (closed) fail(503, 'WORKSPACE_UPDATE_STOPPING', '资料更新已经关闭')
    if (scope !== 'internal' && scope !== 'external')
      fail(400, 'WORKSPACE_UPDATE_SCOPE_INVALID', '资料更新范围无效')
    synchronous(ports.authorize(actor, project, scope, action))
  }
  const planRow = (project: string, scope: WorkspaceUpdateScope) =>
    db
      .prepare('SELECT * FROM workspace_update_plans WHERE project_id=? AND scope=?')
      .get(project, scope)
  const runRow = (project: string, requestId: string) =>
    db
      .prepare('SELECT * FROM workspace_update_runs WHERE project_id=? AND request_id=?')
      .get(project, requestId)
  function authorizeSaved(row: Row) {
    try {
      synchronous(
        ports.authorize(
          asText(row, 'actor_id'),
          asText(row, 'project_id'),
          asText(row, 'scope') as WorkspaceUpdateScope,
          'manage',
        ),
      )
    } catch (error) {
      // 隐藏已撤回项目的授权端口可返回 404；仅此授权边界把它视为失效，普通收据 404 保留未知。
      if ([401, 403, 404].includes(errorStatus(error)))
        pause(
          asText(row, 'project_id'),
          asText(row, 'scope') as WorkspaceUpdateScope,
          'WORKSPACE_UPDATE_PERMISSION_REVOKED',
          asText(row, 'actor_id'),
        )
      throw error
    }
  }
  function pause(project: string, scope: WorkspaceUpdateScope, code: string, actor: string) {
    db.prepare(
      'UPDATE workspace_update_plans SET enabled=0,next_run_at=NULL,paused_code=?,revision=revision+1,updated_at=? WHERE project_id=? AND scope=? AND actor_id=? AND enabled=1',
    ).run(code, time(), project, scope, actor)
  }
  function configuredSources(row: Row, current: WorkspaceUpdateSources) {
    const configured = JSON.parse(asText(row, 'source_ids')) as string[]
    if (configured.some((id) => !current.sourceIds.includes(id))) {
      pause(
        asText(row, 'project_id'),
        asText(row, 'scope') as WorkspaceUpdateScope,
        'WORKSPACE_UPDATE_SOURCE_WITHDRAWN',
        asText(row, 'actor_id'),
      )
      fail(409, 'WORKSPACE_UPDATE_SOURCE_WITHDRAWN', messages.WORKSPACE_UPDATE_SOURCE_WITHDRAWN!)
    }
    // 当前更新入口一次捕获全部已配置来源；新增来源也须管理者在设置中明确确认。
    if (current.sourceIds.some((id) => !configured.includes(id))) {
      pause(
        asText(row, 'project_id'),
        asText(row, 'scope') as WorkspaceUpdateScope,
        'WORKSPACE_UPDATE_SOURCE_WITHDRAWN',
        asText(row, 'actor_id'),
      )
      fail(409, 'WORKSPACE_UPDATE_SOURCE_WITHDRAWN', '更新来源已经变化，请重新核对更新设置')
    }
  }
  function publicRun(row: Row, includeTask: boolean): WorkspaceUpdateRun {
    let task: WorkspaceTask | undefined
    if (includeTask) {
      const receipt = synchronous(
        ports.receipt(
          asText(row, 'project_id'),
          asText(row, 'scope') as WorkspaceUpdateScope,
          asText(row, 'request_id'),
          asText(row, 'actor_id'),
        ),
      )
      task = receipt.task
    }
    return {
      requestId: asText(row, 'request_id'),
      actorId: asText(row, 'actor_id'),
      kind: asText(row, 'kind') as WorkspaceUpdateRun['kind'],
      acceptedAt: asText(row, 'accepted_at'),
      ...(row.finished_at ? { finishedAt: asText(row, 'finished_at') } : {}),
      ...(row.outcome
        ? { outcome: asText(row, 'outcome') as NonNullable<WorkspaceUpdateRun['outcome']> }
        : {}),
      ...(row.error_code ? { error: safeError(asText(row, 'error_code')) } : {}),
      ...(task ? { task } : {}),
    }
  }
  function publicPlan(row: Row, withRuns = true): WorkspaceUpdatePlan {
    const project = asText(row, 'project_id'),
      scope = asText(row, 'scope') as WorkspaceUpdateScope
    const current = withRuns
      ? db
          .prepare(
            'SELECT * FROM workspace_update_runs WHERE project_id=? AND scope=? AND finished_at IS NULL',
          )
          .get(project, scope)
      : undefined
    const last = withRuns
      ? db
          .prepare(
            'SELECT * FROM workspace_update_runs WHERE project_id=? AND scope=? AND finished_at IS NOT NULL ORDER BY accepted_at DESC,rowid DESC LIMIT 1',
          )
          .get(project, scope)
      : undefined
    return {
      projectId: project,
      scope,
      revision: Number(row.revision),
      actorId: asText(row, 'actor_id'),
      enabled: row.enabled === 1,
      intervalMinutes: Number(row.interval_minutes),
      timezone: asText(row, 'timezone'),
      sourceIds: JSON.parse(asText(row, 'source_ids')) as string[],
      updatedAt: asText(row, 'updated_at'),
      nextRunAt: row.next_run_at === null ? null : new Date(Number(row.next_run_at)).toISOString(),
      ...(row.paused_code ? { pausedReason: safeError(asText(row, 'paused_code')) } : {}),
      // 返回计划不借用原配置者的权限读取其私有输入；任务只返回当前调用者可读的公开摘要。
      ...(current ? { currentRun: publicRun(current, false) } : {}),
      ...(last ? { lastRun: publicRun(last, false) } : {}),
    }
  }
  function finish(
    row: Row,
    outcome: NonNullable<WorkspaceUpdateRun['outcome']>,
    code?: string,
    taskId?: string,
  ) {
    db.prepare(
      'UPDATE workspace_update_runs SET finished_at=?,outcome=?,error_code=?,task_id=COALESCE(?,task_id) WHERE project_id=? AND request_id=? AND finished_at IS NULL',
    ).run(
      time(),
      outcome,
      code ?? null,
      taskId ?? null,
      asText(row, 'project_id'),
      asText(row, 'request_id'),
    )
  }
  function reconcile(row: Row): WorkspaceUpdateReceipt {
    try {
      authorizeSaved(row)
    } catch (error) {
      // 已接受任务的精确绑定可用于只读终态核对；撤权不抹去事实，也不授予任何新执行权限。
      if ([401, 403, 404].includes(errorStatus(error)) && row.task_id && ports.settled) {
        const fixed = synchronous(
          ports.settled(
            asText(row, 'project_id'),
            asText(row, 'scope') as WorkspaceUpdateScope,
            asText(row, 'request_id'),
            asText(row, 'task_id'),
          ),
        )
        if (fixed?.task && matchesTask(row, fixed.task) && terminal(fixed.task)) {
          applyReceipt(row, fixed)
          return fixed
        }
      }
      throw error
    }
    const receipt = synchronous(
      ports.receipt(
        asText(row, 'project_id'),
        asText(row, 'scope') as WorkspaceUpdateScope,
        asText(row, 'request_id'),
        asText(row, 'actor_id'),
      ),
    )
    authorizeSaved(row)
    if (receipt.task && !matchesTask(row, receipt.task))
      fail(503, 'WORKSPACE_UPDATE_RECEIPT_MISMATCH', '原更新任务身份无法核实，保留原请求等待核对')
    applyReceipt(row, receipt)
    return receipt
  }
  function matchesTask(row: Row, task: WorkspaceTask) {
    return (
      task.requestId === row.request_id &&
      task.type === (row.scope === 'internal' ? 'sync' : 'external') &&
      (!row.task_id || row.task_id === task.id)
    )
  }
  function applyReceipt(row: Row, receipt: WorkspaceUpdateReceipt) {
    if (receipt.task && terminal(receipt.task)) {
      const task = receipt.task
      finish(
        row,
        task.status === 'completed'
          ? receipt.versionStatus === 'pending_review'
            ? 'pending_review'
            : 'completed'
          : 'failed',
        task.status === 'completed' ? undefined : 'WORKSPACE_UPDATE_FAILED',
        task.id,
      )
    } else if (!receipt.task && receipt.capture?.resolution === 'failed') {
      finish(row, 'failed', 'WORKSPACE_UPDATE_FAILED')
    }
  }
  function claim(
    project: string,
    scope: WorkspaceUpdateScope,
    input: WorkspaceUpdateCommand,
    actor: string,
    kind: WorkspaceUpdateRun['kind'],
    fingerprint: string,
  ) {
    return transaction.run(() => {
      const existing = runRow(project, input.requestId)
      if (existing) {
        if (
          existing.actor_id !== actor ||
          existing.scope !== scope ||
          existing.fingerprint !== fingerprint
        )
          fail(409, 'WORKSPACE_UPDATE_REQUEST_CONFLICT', '原请求已用于其他资料更新')
        return existing
      }
      if (
        db
          .prepare('SELECT 1 FROM workspace_update_receipts WHERE project_id=? AND request_id=?')
          .get(project, input.requestId)
      )
        fail(409, 'WORKSPACE_UPDATE_REQUEST_CONFLICT', '原请求已用于更新设置')
      if (
        db
          .prepare(
            'SELECT 1 FROM workspace_update_runs WHERE project_id=? AND scope=? AND finished_at IS NULL',
          )
          .get(project, scope) ||
        synchronous(ports.busy(project, scope, actor))
      )
        fail(409, 'WORKSPACE_UPDATE_BUSY', '此工作区已有更新，请等待原任务核实完成')
      db.prepare(
        'INSERT INTO workspace_update_runs(project_id,scope,request_id,actor_id,kind,fingerprint,expected_revision,accepted_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        project,
        scope,
        input.requestId,
        actor,
        kind,
        fingerprint,
        input.expectedRevision,
        time(),
      )
      return runRow(project, input.requestId)!
    })
  }
  async function dispatch(
    project: string,
    scope: WorkspaceUpdateScope,
    input: WorkspaceUpdateCommand,
    actor: string,
    kind: WorkspaceUpdateRun['kind'],
    sources?: WorkspaceUpdateSources,
    requestFingerprint?: string,
  ): Promise<WorkspaceTask> {
    ensureAccepting()
    requireAccess(project, actor, scope, 'manage')
    if (
      !input.requestId ||
      input.requestId.length > 160 ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      fail(400, 'WORKSPACE_UPDATE_REQUEST_INVALID', '资料更新请求无效')
    const key = JSON.stringify([project, input.requestId]),
      fingerprint = requestFingerprint ?? digest({ scope, input })
    const working = works.get(key)
    if (working) {
      const saved = runRow(project, input.requestId)!
      if (saved.actor_id !== actor || saved.scope !== scope || saved.fingerprint !== fingerprint)
        fail(409, 'WORKSPACE_UPDATE_REQUEST_CONFLICT', '原请求已用于其他资料更新')
      return working.work
    }
    const previous = runRow(project, input.requestId)
    if (!previous) {
      const active = db
        .prepare(
          'SELECT * FROM workspace_update_runs WHERE project_id=? AND scope=? AND finished_at IS NULL',
        )
        .get(project, scope)
      if (active) {
        try {
          reconcile(active)
        } catch (error) {
          report(error)
        }
      }
    }
    const row = claim(project, scope, input, actor, kind, fingerprint)
    if (previous) {
      const receipt = reconcile(row)
      if (receipt.task) return receipt.task
      const reconciled = runRow(project, input.requestId)!
      fail(
        reconciled.finished_at ? 422 : 503,
        reconciled.finished_at ? asText(reconciled, 'error_code') : 'WORKSPACE_UPDATE_UNKNOWN',
        reconciled.finished_at
          ? messages.WORKSPACE_UPDATE_FAILED!
          : messages.WORKSPACE_UPDATE_UNKNOWN!,
      )
    }
    const controller = new AbortController()
    let dispatched = false
    const work = Promise.resolve()
      .then(async () => {
        controller.signal.throwIfAborted()
        requireAccess(project, actor, scope, 'manage')
        const before = synchronous(ports.sources(project, actor))
        if (
          before.revision !== input.expectedRevision ||
          (sources && before.fingerprint !== sources.fingerprint)
        )
          fail(409, 'WORKSPACE_UPDATE_SOURCE_CHANGED', messages.WORKSPACE_UPDATE_SOURCE_CHANGED!)
        dispatched = true
        const task = await ports.start(project, scope, input, actor, controller.signal)
        if (!matchesTask(row, task))
          fail(503, 'WORKSPACE_UPDATE_RECEIPT_MISMATCH', '更新返回的任务身份无法核实，请核对原请求')
        db.prepare(
          'UPDATE workspace_update_runs SET task_id=? WHERE project_id=? AND request_id=?',
        ).run(task.id, project, input.requestId)
        // 结果已发出时仍按原请求核对；撤权或配置改变不能把迟到结果当作当前授权成功。
        requireAccess(project, actor, scope, 'manage')
        const after = synchronous(ports.sources(project, actor))
        if (before.fingerprint !== after.fingerprint)
          fail(409, 'WORKSPACE_UPDATE_SOURCE_CHANGED', messages.WORKSPACE_UPDATE_SOURCE_CHANGED!)
        reconcile(runRow(project, input.requestId)!)
        return task
      })
      .catch((error: unknown) => {
        // 真实任务或准备收据优先；超时、断线、关闭及读取失败均不证明操作未发生。
        let receipt: WorkspaceUpdateReceipt | undefined
        try {
          receipt = reconcile(runRow(project, input.requestId)!)
        } catch {}
        if (
          !dispatched ||
          (receipt !== undefined &&
            !receipt.task &&
            !receipt.capture &&
            !runRow(project, input.requestId)?.task_id &&
            errorStatus(error) >= 400 &&
            errorStatus(error) < 500)
        )
          finish(
            row,
            'rejected',
            errorCode(error) === 'WORKSPACE_UPDATE_SOURCE_CHANGED'
              ? 'WORKSPACE_UPDATE_SOURCE_CHANGED'
              : 'WORKSPACE_UPDATE_REJECTED',
          )
        else if (!receipt?.task && receipt?.capture?.resolution !== 'failed')
          db.prepare(
            'UPDATE workspace_update_runs SET error_code=? WHERE project_id=? AND request_id=? AND finished_at IS NULL',
          ).run('WORKSPACE_UPDATE_UNKNOWN', project, input.requestId)
        throw error
      })
    works.set(key, { controller, work })
    void work.finally(() => works.delete(key)).catch(() => {})
    return work
  }
  function report(error: unknown) {
    try {
      onError({ event: 'workspace.update.check_failed', code: errorCode(error) })
    } catch {}
  }
  async function check() {
    const running = db
      .prepare(
        'SELECT * FROM workspace_update_runs WHERE finished_at IS NULL ORDER BY accepted_at LIMIT 100',
      )
      .all()
    for (const row of running) {
      if (stopping) return
      try {
        reconcile(row)
      } catch (error) {
        report(error)
      }
    }
    const due = db
      .prepare(
        'SELECT * FROM workspace_update_plans WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 100',
      )
      .all(now())
    for (const row of due) {
      if (stopping) return
      const project = asText(row, 'project_id'),
        scope = asText(row, 'scope') as WorkspaceUpdateScope,
        actor = asText(row, 'actor_id')
      try {
        authorizeSaved(row)
        const sources = synchronous(ports.sources(project, actor))
        configuredSources(row, sources)
        if (
          db
            .prepare(
              'SELECT 1 FROM workspace_update_runs WHERE project_id=? AND scope=? AND finished_at IS NULL',
            )
            .get(project, scope) ||
          synchronous(ports.busy(project, scope, actor))
        )
          continue
        // 关闭期间及一次到期检查中最多两项准备；超期只合并成一次，不追补离线期间的每个时段。
        if (works.size >= 2) continue
        const requestId = `workspace_update_${randomUUID()}`
        const promise = dispatch(
          project,
          scope,
          { requestId, expectedRevision: sources.revision },
          actor,
          'scheduled',
          sources,
        )
        db.prepare(
          'UPDATE workspace_update_plans SET next_run_at=? WHERE project_id=? AND scope=? AND enabled=1 AND revision=?',
        ).run(now() + Number(row.interval_minutes) * 60_000, project, scope, Number(row.revision))
        void promise.catch(report)
      } catch (error) {
        report(error)
      }
    }
  }
  function tick() {
    ensureAccepting()
    if (ticking) return ticking
    ticking = check().finally(() => {
      ticking = undefined
    })
    return ticking
  }
  function arm() {
    if (timer || stopping) return
    timer = setTimeout(() => {
      timer = undefined
      void tick().catch(report).finally(arm)
    }, pollMs)
    timer.unref()
  }
  const api = {
    deletionReferences(project: string, environmentId?: string) {
      if (environmentId !== undefined) return []
      const row = db
        .prepare(
          'SELECT COUNT(*) AS count FROM workspace_update_runs WHERE project_id=? AND finished_at IS NULL',
        )
        .get(project)!
      return Number(row.count)
        ? [
            {
              kind: 'workspace-update-requests',
              count: Number(row.count),
              message: '工作区仍有活动或结果待核查的更新请求',
            },
          ]
        : []
    },
    overview(project: string, actor: string): WorkspaceUpdateOverview {
      requireAccess(project, actor, 'internal', 'read')
      const sources = synchronous(ports.sources(project, actor))
      const internal = planRow(project, 'internal'),
        external = planRow(project, 'external')
      return {
        internal: internal ? publicPlan(internal) : null,
        external: external ? publicPlan(external) : null,
        sources: sources.sourceIds.map((id) => ({ id, name: sources.names?.[id] ?? id })),
      }
    },
    save(
      project: string,
      scope: WorkspaceUpdateScope,
      unknownInput: unknown,
      actor: string,
    ): WorkspaceUpdatePlan {
      ensureAccepting()
      requireAccess(project, actor, scope, 'manage')
      let input: SaveWorkspaceUpdate
      try {
        input = decodeContract(SaveWorkspaceUpdate, unknownInput)
      } catch {
        return fail(
          400,
          'WORKSPACE_UPDATE_SETTINGS_INVALID',
          '请填写有效周期、时区和来源，不接受操作人或权限字段',
        )
      }
      try {
        new Intl.DateTimeFormat('zh-CN', { timeZone: input.value.timezone }).format(now())
      } catch {
        return fail(400, 'WORKSPACE_UPDATE_TIMEZONE_INVALID', '请选择有效时区')
      }
      const { sourceIds } = input.value
      if (new Set(sourceIds).size !== sourceIds.length)
        fail(400, 'WORKSPACE_UPDATE_SETTINGS_INVALID', '更新来源不能重复')
      const fingerprint = digest({ scope, input })
      return transaction.run(() => {
        requireAccess(project, actor, scope, 'manage')
        const previous = db
          .prepare('SELECT * FROM workspace_update_receipts WHERE project_id=? AND request_id=?')
          .get(project, input.requestId)
        if (previous) {
          if (
            previous.actor_id !== actor ||
            previous.scope !== scope ||
            previous.fingerprint !== fingerprint
          )
            fail(409, 'WORKSPACE_UPDATE_REQUEST_CONFLICT', '原请求已用于其他更新设置')
          return JSON.parse(asText(previous, 'result')) as WorkspaceUpdatePlan
        }
        if (runRow(project, input.requestId))
          fail(409, 'WORKSPACE_UPDATE_REQUEST_CONFLICT', '原请求已经用于资料更新')
        const current = synchronous(ports.sources(project, actor))
        if (
          sourceIds.length !== current.sourceIds.length ||
          sourceIds.some((id) => !current.sourceIds.includes(id))
        )
          fail(409, 'WORKSPACE_UPDATE_SOURCE_CHANGED', '请刷新并确认当前工作区全部更新来源')
        const old = planRow(project, scope)
        if (Number(old?.revision ?? 0) !== input.expectedRevision)
          fail(409, 'WORKSPACE_UPDATE_REVISION_CONFLICT', '更新设置已经改变，请刷新后重新确认')
        const revision = input.expectedRevision + 1,
          stamp = time()
        db.prepare(
          'INSERT INTO workspace_update_plans VALUES(?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(project_id,scope) DO UPDATE SET revision=excluded.revision,actor_id=excluded.actor_id,enabled=excluded.enabled,interval_minutes=excluded.interval_minutes,timezone=excluded.timezone,source_ids=excluded.source_ids,updated_at=excluded.updated_at,next_run_at=excluded.next_run_at,paused_code=NULL',
        ).run(
          project,
          scope,
          revision,
          actor,
          input.value.enabled ? 1 : 0,
          input.value.intervalMinutes,
          input.value.timezone,
          JSON.stringify(sourceIds),
          stamp,
          input.value.enabled ? now() + input.value.intervalMinutes * 60_000 : null,
        )
        const result = publicPlan(planRow(project, scope)!, false)
        db.prepare('INSERT INTO workspace_update_receipts VALUES(?,?,?,?,?,?)').run(
          project,
          input.requestId,
          actor,
          scope,
          fingerprint,
          JSON.stringify(result),
        )
        db.prepare(
          'INSERT INTO workspace_update_audit(project_id,scope,actor_id,request_id,revision,enabled,created_at) VALUES(?,?,?,?,?,?,?)',
        ).run(project, scope, actor, input.requestId, revision, input.value.enabled ? 1 : 0, stamp)
        return result
      })
    },
    receipt(project: string, requestId: string, actor: string) {
      requireAccess(project, actor, 'internal', 'manage')
      const config = db
        .prepare('SELECT * FROM workspace_update_receipts WHERE project_id=? AND request_id=?')
        .get(project, requestId)
      if (config && config.actor_id === actor) {
        requireAccess(project, actor, asText(config, 'scope') as WorkspaceUpdateScope, 'manage')
        return {
          kind: 'settings' as const,
          result: JSON.parse(asText(config, 'result')) as WorkspaceUpdatePlan,
        }
      }
      const row = runRow(project, requestId)
      if (!row || row.actor_id !== actor)
        return fail(404, 'WORKSPACE_UPDATE_RECEIPT_NOT_FOUND', '原资料更新请求不存在或无权访问')
      requireAccess(project, actor, asText(row, 'scope') as WorkspaceUpdateScope, 'manage')
      reconcile(row)
      return { kind: 'update' as const, result: publicRun(runRow(project, requestId)!, true) }
    },
    async manual(
      project: string,
      scope: WorkspaceUpdateScope,
      unknownInput: unknown,
      actor: string,
    ) {
      ensureAccepting()
      requireAccess(project, actor, scope, 'manage')
      let input: RunWorkspaceUpdate
      try {
        input = decodeContract(RunWorkspaceUpdate, unknownInput)
      } catch {
        return fail(
          400,
          'WORKSPACE_UPDATE_REQUEST_INVALID',
          '资料更新请求无效，不接受操作人或权限字段',
        )
      }
      if (scope === 'internal' && input.rules)
        fail(400, 'WORKSPACE_UPDATE_REQUEST_INVALID', '内部同步不接受外部替换规则')
      const previous = runRow(project, input.requestId)
      const expectedRevision =
        input.expectedRevision ??
        (previous
          ? Number(previous.expected_revision)
          : synchronous(ports.sources(project, actor)).revision)
      return dispatch(
        project,
        scope,
        {
          requestId: input.requestId,
          expectedRevision,
          ...(input.rules ? { rules: input.rules.map((value) => ({ ...value })) } : {}),
        },
        actor,
        'manual',
        undefined,
        digest({ scope, input }),
      )
    },
    tick,
    start() {
      ensureAccepting()
      arm()
      return tick()
    },
    stopAccepting() {
      stopping = true
      if (timer) clearTimeout(timer)
      timer = undefined
      for (const { controller } of works.values()) controller.abort()
    },
    async drain() {
      await ticking?.catch(report)
      await Promise.allSettled([...works.values()].map(({ work }) => work))
    },
    close() {
      api.stopAccepting()
      closing ??= api.drain().then(() => {
        closed = true
        database.close()
      })
      return closing
    },
  }
  return api
}
export type WorkspaceUpdates = ReturnType<typeof createWorkspaceUpdates>
