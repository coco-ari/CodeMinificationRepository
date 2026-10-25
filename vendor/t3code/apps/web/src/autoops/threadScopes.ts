import { autoOpsRequest, AutoOpsRequestError } from './apiClient'
import { autoOpsStorage, readAutoOpsHost, type AutoOpsT3Bootstrap } from './hostSnapshot'

export type AutoOpsExecutionBinding =
  | { kind: 'platform' }
  | {
      kind: 'customer'
      deviceId: string
      registeredWorkspaceId: string
      workspaceBindingRevision: number
      runtimeId: 'codex'
    }
export interface AutoOpsThreadScope {
  executionBinding?: AutoOpsExecutionBinding
  projectId: string
  environmentId: string | null
  agentId: string
  visibility: 'private' | 'project'
  workspaceType?: 'internal' | 'external' | undefined
  workspaceVersionId?: string | undefined
  compatibilityReadOnly?: boolean
  continuationVerified?: boolean
  nativeThreadId?: string
  nativeParentThreadId?: string
  scopeState?: 'draft' | 'submitting' | 'locked'
  scopeLocked?: boolean
}
const pendingScopes = new Map<string, AutoOpsThreadScope>()
const scopeListeners = new Set<() => void>()
export function subscribeAutoOpsThreadScopes(listener: () => void) {
  scopeListeners.add(listener)
  return () => {
    scopeListeners.delete(listener)
  }
}
export function readKnownAutoOpsThreadScope(threadId: string) {
  return pendingScopes.get(threadId)
}
function publishThreadScope(threadId: string, scope: AutoOpsThreadScope) {
  pendingScopes.set(threadId, scope)
  if (typeof window !== 'undefined') {
    try {
      autoOpsStorage(window.localStorage).setItem(`thread-scope:${threadId}`, JSON.stringify(scope))
    } catch {}
  }
  for (const listener of scopeListeners) listener()
}
function sameExecutionBinding(
  left: AutoOpsExecutionBinding | undefined,
  right: AutoOpsExecutionBinding | undefined,
) {
  if (left?.kind !== 'customer') return right?.kind !== 'customer'
  return (
    right?.kind === 'customer' &&
    left.deviceId === right.deviceId &&
    left.registeredWorkspaceId === right.registeredWorkspaceId &&
    left.workspaceBindingRevision === right.workspaceBindingRevision &&
    left.runtimeId === right.runtimeId
  )
}
export function sameAutoOpsThreadScope(left: AutoOpsThreadScope, right: AutoOpsThreadScope) {
  return (
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId &&
    left.agentId === right.agentId &&
    left.visibility === right.visibility &&
    (left.workspaceType ?? null) === (right.workspaceType ?? null) &&
    (left.workspaceVersionId ?? null) === (right.workspaceVersionId ?? null) &&
    sameExecutionBinding(left.executionBinding, right.executionBinding)
  )
}
function scopeAllowed(scope: AutoOpsThreadScope, project: AutoOpsT3Bootstrap['projects'][number]) {
  const savedCustomer = scope.executionBinding?.kind === 'customer' && scope.scopeState !== undefined
  return (
    (savedCustomer || scope.environmentId === null || project.environments.some((entry) => entry.id === scope.environmentId)) &&
    project.agents.some((entry) => entry.id === scope.agentId) &&
    (savedCustomer || scope.environmentId === null || !project.membership || project.membership.environmentIds.includes(scope.environmentId)) &&
    (scope.executionBinding?.kind === 'customer'
      ? scope.visibility === 'private' &&
        scope.agentId === 'a-project' &&
        !scope.workspaceType &&
        !scope.workspaceVersionId
      : project.membership?.workspaceAccess !== 'external' || scope.workspaceType === 'external')
  )
}
export function readAutoOpsThreadScope(
  threadId: string,
  projectId: string,
): AutoOpsThreadScope | undefined {
  let selected = pendingScopes.get(threadId)
  if (!selected && typeof window !== 'undefined') {
    try {
      const saved = autoOpsStorage(window.localStorage).getItem(`thread-scope:${threadId}`)
      if (saved) {
        const candidate = JSON.parse(saved) as AutoOpsThreadScope
        const project = readAutoOpsHost()?.projects.find((entry) => entry.id === projectId)
        if (candidate.projectId === projectId && project && scopeAllowed(candidate, project))
          selected = candidate
      }
    } catch {
      /* 已撤销的权限由 setAutoOpsThreadScope 拒绝。 */
    }
  }
  const project = readAutoOpsHost()?.projects.find((entry) => entry.id === projectId)
  if (selected && project && scopeAllowed(selected, project)) return selected
  const environment = project?.environments.find(
    (entry) => !project.membership || project.membership.environmentIds.includes(entry.id),
  )
  if (!project || !project.agents[0]) return undefined
  return {
    projectId,
    environmentId: environment?.id ?? null,
    agentId: project.agents[0].id,
    visibility: 'private',
    workspaceType: project.membership?.workspaceAccess === 'external' ? 'external' : 'internal',
  }
}
export function setAutoOpsThreadScope(threadId: string, scope: AutoOpsThreadScope): void {
  const project = readAutoOpsHost()?.projects.find((entry) => entry.id === scope.projectId)
  if (!project || !scopeAllowed(scope, project))
    throw new Error('当前成员无权使用所选工作区、环境或助手。')
  const current = pendingScopes.get(threadId)
  if (
    current &&
    (current.scopeLocked || current.scopeState === 'submitting') &&
    !sameAutoOpsThreadScope(current, scope)
  )
    throw new Error(
      current.scopeLocked
        ? '对话范围已固定，请新建对话切换。'
        : '正在确认本次提交，暂时不能切换对话范围。',
    )
  publishThreadScope(threadId, scope)
}

/** 从服务器确认的源会话继承业务范围，保留真实环境与助手。 */
export async function inheritAutoOpsThreadScope(
  sourceThreadId: string,
  nextThreadId: string,
  projectId: string,
): Promise<void> {
  if (!readAutoOpsHost()) return
  const source = await loadAutoOpsThreadScope(sourceThreadId)
  if (source.projectId !== projectId || source.compatibilityReadOnly || source.nativeParentThreadId)
    throw new Error('The source conversation cannot start an implementation thread.')
  setAutoOpsThreadScope(nextThreadId, {
    ...(source.executionBinding ? { executionBinding: source.executionBinding } : {}),
    projectId: source.projectId,
    environmentId: source.environmentId,
    agentId: source.agentId,
    visibility: 'private',
    ...(source.workspaceType ? { workspaceType: source.workspaceType } : {}),
  })
}
export async function authorizeThreadLaunch({
  threadId,
  projectId,
}: {
  threadId: string
  projectId: string
}): Promise<void> {
  const host = readAutoOpsHost()
  if (!host) return
  const scope = readAutoOpsThreadScope(threadId, projectId)
  if (!scope) throw new Error('请先选择有权使用的项目、环境和助手。')
  await reserveAutoOpsThreadScope(threadId, scope)
}

export async function reserveAutoOpsThreadScope(
  threadId: string,
  desired: AutoOpsThreadScope,
): Promise<AutoOpsThreadScope> {
  const host = readAutoOpsHost()
  if (!host) throw new Error('项目工作台未连接。')
  const project = host.projects.find((entry) => entry.id === desired.projectId)
  if (!project || !scopeAllowed(desired, project))
    throw new Error('当前成员无权使用所选工作区、环境或助手。')
  // 先核对服务器收据；读取失败时不创建新预约，也不自动重发写请求。
  const previous = await requestThreadBinding(threadId, '无法确认前次发送状态')
  if (previous) {
    publishThreadScope(threadId, previous)
    if (previous.scopeLocked || previous.scopeState === 'locked') {
      if (!sameAutoOpsThreadScope(previous, desired))
        throw new Error('前次发送已被接受，对话范围已固定。请新建对话切换。')
      return previous
    }
    if (previous.scopeState === 'submitting')
      throw new Error('正在确认前次发送结果，请稍后重试；对话范围暂时不能修改。')
  }
  const result = await autoOpsRequest<{ binding: AutoOpsThreadScope }>('/autoops/thread-bindings', {
    label: '无法授权此会话的工作区',
    body: {
      threadId,
      projectId: desired.projectId,
      environmentId: desired.environmentId,
      agentId: desired.agentId,
      visibility: desired.visibility,
      ...(desired.executionBinding ? { executionBinding: desired.executionBinding } : {}),
      ...(desired.workspaceType
        ? { workspaceType: desired.workspaceType, workspaceVersionId: desired.workspaceVersionId }
        : {}),
    },
  })
  const binding = requireThreadBinding(result, true)
  publishThreadScope(threadId, binding)
  return binding
}

export async function loadAutoOpsThreadScope(
  threadId: string,
  signal?: AbortSignal,
): Promise<AutoOpsThreadScope> {
  const binding = await findAutoOpsThreadScope(threadId, signal)
  if (!binding) throw new Error('对话范围尚未保存。')
  return binding
}

/** 不把异常响应当作不存在的预约，避免在收据未知时继续写入。 */
function requireThreadBinding(
  result: { binding?: AutoOpsThreadScope },
  mutation: boolean,
): AutoOpsThreadScope {
  const binding = result.binding
  if (
    !binding ||
    typeof binding.projectId !== 'string' ||
    !binding.projectId ||
    (binding.environmentId !== null && (typeof binding.environmentId !== 'string' || !binding.environmentId)) ||
    typeof binding.agentId !== 'string' ||
    !binding.agentId ||
    (binding.visibility !== 'private' && binding.visibility !== 'project')
  ) {
    throw new AutoOpsRequestError(
      mutation
        ? '本次发送的确认信息不完整，请先核对会话状态。'
        : '无法确认前次发送状态，请恢复连接后重试。',
      'INVALID_RESPONSE',
      200,
      mutation,
    )
  }
  return binding
}

/** 缺失收据与读取失败分开处理，保留统一客户端的状态码、取消和未知提交语义。 */
async function requestThreadBinding(
  threadId: string,
  label: string,
  signal?: AbortSignal,
): Promise<AutoOpsThreadScope | null> {
  try {
    const result = await autoOpsRequest<{ binding: AutoOpsThreadScope }>(
      `/autoops/thread-bindings/${encodeURIComponent(threadId)}`,
      { label, ...(signal ? { signal } : {}) },
    )
    return requireThreadBinding(result, false)
  } catch (cause) {
    if (cause instanceof AutoOpsRequestError && cause.status === 404) return null
    throw cause
  }
}

export async function findAutoOpsThreadScope(
  threadId: string,
  signal?: AbortSignal,
): Promise<AutoOpsThreadScope | null> {
  const binding = await requestThreadBinding(threadId, '无法确认对话范围', signal)
  if (!binding) {
    const current = pendingScopes.get(threadId)
    if (current?.scopeState === 'submitting' && current.scopeLocked !== true)
      publishThreadScope(threadId, { ...current, scopeState: 'draft', scopeLocked: false })
    return null
  }
  publishThreadScope(threadId, binding)
  return binding
}
