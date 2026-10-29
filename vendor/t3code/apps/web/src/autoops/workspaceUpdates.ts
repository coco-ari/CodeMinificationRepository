import { randomUUID } from '~/lib/utils'
import { decodeContract } from '../../../../../../autoops/contracts/index.ts'
import { SaveWorkspaceUpdate } from '../../../../../../autoops/contracts/workspace-updates.ts'
import type {
  WorkspaceUpdateOverview,
  WorkspaceUpdatePlan,
  WorkspaceUpdateScope,
  WorkspaceUpdateSettings,
} from '../../../../../../autoops/contracts/workspace-updates.ts'
import { autoOpsRequest, AutoOpsRequestError } from './apiClient'
import { autoOpsStorageKey, readAutoOpsHost } from './hostSnapshot'

export type {
  WorkspaceUpdateOverview,
  WorkspaceUpdatePlan,
  WorkspaceUpdateScope,
  WorkspaceUpdateSettings,
}
export interface PendingWorkspaceUpdate {
  version: 1
  actorId: string
  projectId: string
  scope: WorkspaceUpdateScope
  input: SaveWorkspaceUpdate
}
export type WorkspaceUpdateWriteResult = WorkspaceUpdatePlan | { saved: true; available: false }
const path = (project: string) =>
  `/api/v1/projects/${encodeURIComponent(project)}/workspace/updates`
const pendingKey = (project: string, scope: WorkspaceUpdateScope) =>
  autoOpsStorageKey(`workspace-update:pending:${encodeURIComponent(project)}:${scope}`)
function actor() {
  const id = readAutoOpsHost()?.principal.id
  if (!id) throw new AutoOpsRequestError('登录上下文不可用，请重新登录。', 'HOST_UNAVAILABLE', 401)
  return id
}
function invalid() {
  return new AutoOpsRequestError(
    '原更新设置记录无法核实，请保留原请求并恢复连接。',
    'WORKSPACE_UPDATE_PENDING_INVALID',
    undefined,
    true,
  )
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function fixedPending(
  value: unknown,
  project: string,
  scope: WorkspaceUpdateScope,
): PendingWorkspaceUpdate {
  const entry = record(value)
  if (
    Object.keys(entry).some(
      (key) => !['version', 'actorId', 'projectId', 'scope', 'input'].includes(key),
    ) ||
    entry.version !== 1 ||
    entry.actorId !== actor() ||
    entry.projectId !== project ||
    entry.scope !== scope
  )
    throw invalid()
  try {
    return {
      version: 1,
      actorId: entry.actorId as string,
      projectId: project,
      scope,
      input: decodeContract(SaveWorkspaceUpdate, entry.input),
    }
  } catch {
    throw invalid()
  }
}
export function readPendingWorkspaceUpdate(
  project: string,
  scope: WorkspaceUpdateScope,
): PendingWorkspaceUpdate | null {
  const saved = window.sessionStorage.getItem(pendingKey(project, scope))
  if (saved === null) return null
  try {
    return fixedPending(JSON.parse(saved), project, scope)
  } catch {
    throw invalid()
  }
}
export function prepareWorkspaceUpdate(
  project: string,
  scope: WorkspaceUpdateScope,
  expectedRevision: number,
  value: WorkspaceUpdateSettings,
): PendingWorkspaceUpdate {
  if (readPendingWorkspaceUpdate(project, scope))
    throw new AutoOpsRequestError('请先核对上一次更新设置。', 'WORKSPACE_UPDATE_PENDING', 409)
  let input: SaveWorkspaceUpdate
  try {
    input = decodeContract(SaveWorkspaceUpdate, {
      requestId: randomUUID(),
      expectedRevision,
      value,
    })
  } catch {
    throw new AutoOpsRequestError(
      '请填写有效周期、时区并确认更新来源。',
      'WORKSPACE_UPDATE_SETTINGS_INVALID',
      400,
    )
  }
  const pending = { version: 1 as const, actorId: actor(), projectId: project, scope, input }
  window.sessionStorage.setItem(pendingKey(project, scope), JSON.stringify(pending))
  return pending
}
function clear(pending: PendingWorkspaceUpdate) {
  if (actor() !== pending.actorId) throw new DOMException('登录上下文已经改变', 'AbortError')
  const current = readPendingWorkspaceUpdate(pending.projectId, pending.scope)
  if (current?.input.requestId === pending.input.requestId)
    window.sessionStorage.removeItem(pendingKey(pending.projectId, pending.scope))
}
function checkedResult(
  pending: PendingWorkspaceUpdate,
  value: unknown,
): WorkspaceUpdateWriteResult {
  const result = record(value)
  if (result.saved === true && result.available === false) return { saved: true, available: false }
  const wanted = pending.input.value
  if (
    result.projectId !== pending.projectId ||
    result.scope !== pending.scope ||
    result.actorId !== pending.actorId ||
    result.revision !== pending.input.expectedRevision + 1 ||
    result.enabled !== wanted.enabled ||
    result.intervalMinutes !== wanted.intervalMinutes ||
    result.timezone !== wanted.timezone ||
    !Array.isArray(result.sourceIds) ||
    JSON.stringify(result.sourceIds) !== JSON.stringify(wanted.sourceIds) ||
    typeof result.updatedAt !== 'string' ||
    (wanted.enabled && typeof result.nextRunAt !== 'string') ||
    (!wanted.enabled && result.nextRunAt !== null)
  )
    throw invalid()
  return value as WorkspaceUpdatePlan
}
export const loadWorkspaceUpdates = (project: string, signal?: AbortSignal) =>
  autoOpsRequest<WorkspaceUpdateOverview>(path(project), {
    label: '更新设置',
    ...(signal ? { signal } : {}),
  })
export async function submitWorkspaceUpdate(
  pending: PendingWorkspaceUpdate,
  signal?: AbortSignal,
): Promise<WorkspaceUpdateWriteResult> {
  const fixed = fixedPending(pending, pending.projectId, pending.scope)
  try {
    const response = await autoOpsRequest<unknown>(`${path(fixed.projectId)}/${fixed.scope}`, {
      label: '更新设置',
      body: fixed.input,
      ...(signal ? { signal } : {}),
    })
    const result = checkedResult(fixed, response)
    clear(fixed)
    return result
  } catch (cause) {
    if (cause instanceof AutoOpsRequestError && !cause.uncertain) clear(fixed)
    throw cause
  }
}
export async function recoverWorkspaceUpdate(
  pending: PendingWorkspaceUpdate,
  signal?: AbortSignal,
): Promise<{ status: 'missing' } | { status: 'completed'; result: WorkspaceUpdateWriteResult }> {
  const fixed = fixedPending(pending, pending.projectId, pending.scope)
  try {
    const receipt = await autoOpsRequest<{ kind: 'settings'; result: unknown }>(
      `${path(fixed.projectId)}/requests/${encodeURIComponent(fixed.input.requestId)}`,
      { label: '更新设置原收据', ...(signal ? { signal } : {}) },
    )
    if (receipt.kind !== 'settings') throw invalid()
    const result = checkedResult(fixed, receipt.result)
    clear(fixed)
    return { status: 'completed', result }
  } catch (cause) {
    if (cause instanceof AutoOpsRequestError) {
      if (cause.status === 404 && cause.code === 'WORKSPACE_UPDATE_RECEIPT_NOT_FOUND')
        return { status: 'missing' }
      if ([401, 403, 404].includes(cause.status ?? 0)) clear(fixed)
    }
    throw cause
  }
}

export const removeWorkspaceUpdate = (
  projectId: string,
  scope: WorkspaceUpdateScope,
  input: { requestId: string; expectedRevision: number },
) =>
  autoOpsRequest<{ deleted: true }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/workspace/updates/${scope}`,
    { method: 'DELETE', body: input, label: '更新计划' },
  )
