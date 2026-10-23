import type { ProjectCapabilities } from '../../../../../../autoops/contracts/runtime.ts'
import { ProviderInstanceId } from '@t3tools/contracts'
import { ClientSettingsPatch, type ClientSettings } from '@t3tools/contracts/settings'
import * as Schema from 'effect/Schema'
import { installClientHostIntegration } from '@t3tools/client-runtime/host-integration'
// AutoOps supplies identity before any T3 store is imported. Existing T3
// standalone clients and tests retain their original behavior without a host.
export interface AutoOpsT3Bootstrap {
  readonly principal: { readonly id: string; readonly displayName: string }
  readonly gatewayBasePath: string
  readonly csrfToken: string
  /** Legacy wire name: the default model when modelSelectionEnabled is true. */
  readonly fixedModel: { readonly instanceId: string; readonly model: string }
  readonly modelSelectionEnabled?: boolean
  readonly customerAgentsEnabled?: boolean
  readonly runtimeMode: 'approval-required'
  readonly productProfile?: { readonly id: 't3-demo-full-v1' | 'project-assistant-lite-v1' }
  readonly clientSettingsOverrides?: Readonly<Partial<ClientSettings>>
  readonly projects: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly environments: ReadonlyArray<{ readonly id: string; readonly name: string }>
    readonly agents: ReadonlyArray<{ readonly id: string; readonly name: string }>
    readonly capabilities?: Readonly<ProjectCapabilities>
    readonly membership?: {
      readonly workspaceAccess: 'internal' | 'external'
      readonly role: 'manager' | 'member'
      readonly environmentIds: ReadonlyArray<string>
    }
  }>
  readonly initialRoute?: { readonly environmentId: string; readonly threadId: string }
  readonly capabilities: Readonly<Record<string, unknown>>
}

interface AutoOpsHost extends AutoOpsT3Bootstrap {
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
}

let activeHost: AutoOpsHost | undefined

export function installAutoOpsHost(input: AutoOpsT3Bootstrap, origin: string): AutoOpsHost {
  if (!input.principal?.id || typeof input.principal.id !== 'string') {
    throw new Error('Missing authenticated AutoOps identity.')
  }
  const base = new URL(input.gatewayBasePath, origin)
  if (
    base.origin !== origin ||
    !input.gatewayBasePath.startsWith('/') ||
    input.gatewayBasePath.startsWith('//') ||
    base.pathname !== input.gatewayBasePath ||
    base.pathname === '/' ||
    base.search ||
    base.hash
  ) {
    throw new Error('Invalid same-origin AutoOps gateway.')
  }
  if (activeHost && activeHost.principal.id !== input.principal.id) {
    // A full document reload discards singleton atoms, drafts and open streams.
    throw new Error('Reload the page before changing the authenticated user.')
  }
  base.pathname = base.pathname.replace(/\/$/, '')
  const socket = new URL(base)
  socket.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  socket.pathname += '/ws'
  if (
    !input.fixedModel?.model ||
    input.fixedModel.instanceId !== 'codex' ||
    input.runtimeMode !== 'approval-required'
  ) {
    throw new Error('The configured project agent is unavailable.')
  }
  if (input.productProfile && !['t3-demo-full-v1', 'project-assistant-lite-v1'].includes(input.productProfile.id)) {
    throw new Error('不支持当前产品配置，请更新页面后重试。')
  }
  const clientSettingsOverrides = input.clientSettingsOverrides === undefined
    ? undefined
    : Schema.decodeUnknownSync(ClientSettingsPatch)(input.clientSettingsOverrides)
  const host: AutoOpsHost = {
    ...input,
    ...(clientSettingsOverrides === undefined ? {} : { clientSettingsOverrides }),
    httpBaseUrl: base.href,
    wsBaseUrl: socket.href,
  }
  activeHost = host
  if (typeof document !== 'undefined') document.documentElement.dataset.autoopsT3 = ''
  if (typeof window !== 'undefined') {
    try {
      const storage = autoOpsStorage(window.localStorage)
      if (storage.getItem('t3code:theme') === null) {
        storage.setItem('t3code:theme', 'light')
        storage.setItem('t3code:theme-appearance-mode', 'light')
        storage.setItem('t3code:theme-follow-system', 'false')
      }
    } catch {
      /* Storage may be unavailable; T3 keeps its in-memory preference. */
    }
  }
  installClientHostIntegration({
    beforeThreadLaunch: authorizeThreadLaunch,
    turnConfiguration: (context) => ({
      ...((input.modelSelectionEnabled || (context && pendingScopes.get(context.threadId)?.executionBinding?.kind === 'customer')) ? {} : { modelSelection: {
        ...input.fixedModel,
        instanceId: ProviderInstanceId.make(input.fixedModel.instanceId),
      } }),
      runtimeMode: input.runtimeMode,
    }),
  })
  return host
}

export function readAutoOpsHost(): AutoOpsHost | undefined {
  return activeHost
}

export function autoOpsStorageKey(key: string): string {
  if (!activeHost) return key
  const prefix = `autoops:t3:${encodeURIComponent(activeHost.principal.id)}:`
  return key.startsWith(prefix) ? key : prefix + key
}

const scopedStorages = new WeakMap<Storage, Storage>()
/** A scoped view, never a global Storage monkey patch. clear() removes only this user. */
export function autoOpsStorage(storage: Storage): Storage {
  if (!activeHost) return storage
  const existing = scopedStorages.get(storage)
  if (existing) return existing
  const prefix = autoOpsStorageKey('')
  const keys = () =>
    Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => key !== null && key.startsWith(prefix),
    )
  const scoped: Storage = {
    get length() {
      return keys().length
    },
    key(index) {
      return keys()[index]?.slice(prefix.length) ?? null
    },
    getItem(key) {
      return storage.getItem(autoOpsStorageKey(key))
    },
    setItem(key, value) {
      storage.setItem(autoOpsStorageKey(key), value)
    },
    removeItem(key) {
      storage.removeItem(autoOpsStorageKey(key))
    },
    clear() {
      for (const key of keys()) storage.removeItem(key)
    },
  }
  scopedStorages.set(storage, scoped)
  return scoped
}

export type AutoOpsExecutionBinding = { kind: 'platform' } | { kind: 'customer'; deviceId: string; registeredWorkspaceId: string; workspaceBindingRevision: number; runtimeId: 'codex' }
export interface AutoOpsThreadScope {
  executionBinding?: AutoOpsExecutionBinding
  projectId: string
  environmentId: string
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
    try { autoOpsStorage(window.localStorage).setItem(`thread-scope:${threadId}`, JSON.stringify(scope)) } catch {}
  }
  for (const listener of scopeListeners) listener()
}
function sameExecutionBinding(left: AutoOpsExecutionBinding | undefined, right: AutoOpsExecutionBinding | undefined) {
  if (left?.kind !== 'customer') return right?.kind !== 'customer'
  return right?.kind === 'customer' && left.deviceId === right.deviceId &&
    left.registeredWorkspaceId === right.registeredWorkspaceId &&
    left.workspaceBindingRevision === right.workspaceBindingRevision && left.runtimeId === right.runtimeId
}
export function sameAutoOpsThreadScope(left: AutoOpsThreadScope, right: AutoOpsThreadScope) {
  return left.projectId === right.projectId && left.environmentId === right.environmentId &&
    left.agentId === right.agentId && left.visibility === right.visibility &&
    (left.workspaceType ?? null) === (right.workspaceType ?? null) &&
    (left.workspaceVersionId ?? null) === (right.workspaceVersionId ?? null) &&
    sameExecutionBinding(left.executionBinding, right.executionBinding)
}
function scopeAllowed(scope: AutoOpsThreadScope, project: AutoOpsT3Bootstrap['projects'][number]) {
  return project.environments.some((entry) => entry.id === scope.environmentId) &&
    project.agents.some((entry) => entry.id === scope.agentId) &&
    (!project.membership || project.membership.environmentIds.includes(scope.environmentId)) &&
    (scope.executionBinding?.kind === 'customer'
      ? scope.visibility === 'private' && scope.agentId === 'a-project' && !scope.workspaceType && !scope.workspaceVersionId
      : project.membership?.workspaceAccess !== 'external' || scope.workspaceType === 'external')
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
        const project = activeHost?.projects.find((entry) => entry.id === projectId)
        if (
          candidate.projectId === projectId &&
          project && scopeAllowed(candidate, project)
        )
          selected = candidate
      }
    } catch {
      /* Removed authorization is rejected by setAutoOpsThreadScope. */
    }
  }
  const project = activeHost?.projects.find((entry) => entry.id === projectId)
  if (selected && project && scopeAllowed(selected, project)) return selected
  const environment = project?.environments.find((entry) => !project.membership || project.membership.environmentIds.includes(entry.id))
  if (!project || !environment || !project.agents[0]) return undefined
  return {
    projectId,
    environmentId: environment.id,
    agentId: project.agents[0].id,
    visibility: 'private',
    ...(project.membership?.workspaceAccess === 'external' ? { workspaceType: 'external' as const } : {}),
  }
}
export function setAutoOpsThreadScope(threadId: string, scope: AutoOpsThreadScope): void {
  const project = activeHost?.projects.find((entry) => entry.id === scope.projectId)
  if (
    !project || !scopeAllowed(scope, project)
  )
    throw new Error('当前成员无权使用所选工作区、环境或助手。')
  const current = pendingScopes.get(threadId)
  if (current && (current.scopeLocked || current.scopeState === 'submitting') && !sameAutoOpsThreadScope(current, scope))
    throw new Error(current.scopeLocked ? '对话范围已固定，请新建对话切换。' : '正在确认本次提交，暂时不能切换对话范围。')
  publishThreadScope(threadId, scope)
}

/** Derive business scope from current server authority, never a project's first environment. */
export async function inheritAutoOpsThreadScope(
  sourceThreadId: string,
  nextThreadId: string,
  projectId: string,
): Promise<void> {
  if (!activeHost) return
  const source = await loadAutoOpsThreadScope(sourceThreadId)
  if (source.projectId !== projectId || source.compatibilityReadOnly || source.nativeParentThreadId)
    throw new Error('The source conversation cannot start an implementation thread.')
  setAutoOpsThreadScope(nextThreadId, {
    ...(source.executionBinding ? {executionBinding:source.executionBinding} : {}),
    projectId: source.projectId,
    environmentId: source.environmentId,
    agentId: source.agentId,
    visibility: 'private',
    ...(source.workspaceType ? {workspaceType: source.workspaceType, workspaceVersionId: source.workspaceVersionId} : {}),
  })
}
async function authorizeThreadLaunch({
  threadId,
  projectId,
}: {
  threadId: string
  projectId: string
}): Promise<void> {
  const host = activeHost
  if (!host) return
  const scope = readAutoOpsThreadScope(threadId, projectId)
  if (!scope)
    throw new Error('请先选择有权使用的项目、环境和助手。')
  await reserveAutoOpsThreadScope(threadId, scope)
}

export async function reserveAutoOpsThreadScope(threadId: string, desired: AutoOpsThreadScope): Promise<AutoOpsThreadScope> {
  const host = activeHost
  if (!host) throw new Error('项目工作台未连接。')
  const project = host.projects.find((entry) => entry.id === desired.projectId)
  if (!project || !scopeAllowed(desired, project)) throw new Error('当前成员无权使用所选工作区、环境或助手。')
  const previous = await fetch(`${host.gatewayBasePath}/autoops/thread-bindings/${encodeURIComponent(threadId)}`, { credentials: 'same-origin' })
    .catch(() => { throw new Error('无法确认前次发送状态，请恢复连接后重试。') })
  if (previous.ok) {
    const { binding } = await previous.json() as { binding: AutoOpsThreadScope }
    publishThreadScope(threadId, binding)
    if (binding.scopeLocked || binding.scopeState === 'locked') {
      if (!sameAutoOpsThreadScope(binding, desired)) throw new Error('前次发送已被接受，对话范围已固定。请新建对话切换。')
      return binding
    }
    if (binding.scopeState === 'submitting') throw new Error('正在确认前次发送结果，请稍后重试；对话范围暂时不能修改。')
  } else if (previous.status !== 404) {
    throw new Error(previous.status === 401 ? '请重新登录。' : '无法确认前次发送状态，请恢复连接后重试。')
  }
  const response = await fetch(`${host.gatewayBasePath}/autoops/thread-bindings`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Demo-CSRF': host.csrfToken },
    body: JSON.stringify({ threadId, projectId: desired.projectId, environmentId: desired.environmentId,
      agentId: desired.agentId, visibility: desired.visibility,
      ...(desired.executionBinding ? {executionBinding:desired.executionBinding} : {}),
      ...(desired.workspaceType ? { workspaceType: desired.workspaceType, workspaceVersionId: desired.workspaceVersionId } : {}) }),
  }).catch(() => { throw new Error('未收到本次发送的确认，请恢复连接后重试。') })
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? '请重新登录。'
        : ((await response.json().catch(() => ({}))) as {error?:string}).error ?? '无法授权此会话的工作区，请重新选择版本。',
    )
  const result = (await response.json()) as {binding: AutoOpsThreadScope}
  publishThreadScope(threadId, result.binding)
  return result.binding
}

export async function loadAutoOpsThreadScope(
  threadId: string,
  signal?: AbortSignal,
): Promise<AutoOpsThreadScope> {
  const binding = await findAutoOpsThreadScope(threadId, signal)
  if (!binding) throw new Error('对话范围尚未保存。')
  return binding
}

export async function findAutoOpsThreadScope(threadId: string, signal?: AbortSignal): Promise<AutoOpsThreadScope | null> {
  if (!activeHost) throw new Error('项目工作台未连接。')
  const response = await fetch(
    `${activeHost.gatewayBasePath}/autoops/thread-bindings/${encodeURIComponent(threadId)}`,
    { credentials: 'same-origin', ...(signal ? { signal } : {}) },
  ).catch(() => { throw new Error('无法确认对话范围，请恢复连接后重试。') })
  if (response.status === 404) {
    const current = pendingScopes.get(threadId)
    if (current?.scopeState === 'submitting' && current.scopeLocked !== true)
      publishThreadScope(threadId, { ...current, scopeState: 'draft', scopeLocked: false })
    return null
  }
  if (!response.ok) throw new Error('无法确认对话范围，请恢复连接后重试。')
  const result = (await response.json()) as { binding: AutoOpsThreadScope }
  publishThreadScope(threadId, result.binding)
  return result.binding
}
