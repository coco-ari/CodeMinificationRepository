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
  readonly runtimeMode: 'approval-required'
  readonly productProfile?: { readonly id: 't3-demo-full-v1' | 'project-assistant-lite-v1' }
  readonly clientSettingsOverrides?: Readonly<Partial<ClientSettings>>
  readonly projects: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly environments: ReadonlyArray<{ readonly id: string; readonly name: string }>
    readonly agents: ReadonlyArray<{ readonly id: string; readonly name: string }>
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
    turnConfiguration: () => ({
      ...(input.modelSelectionEnabled ? {} : { modelSelection: {
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

export interface AutoOpsThreadScope {
  projectId: string
  environmentId: string
  agentId: string
  visibility: 'private' | 'project'
  compatibilityReadOnly?: boolean
  continuationVerified?: boolean
  nativeThreadId?: string
  nativeParentThreadId?: string
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
  for (const listener of scopeListeners) listener()
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
          project?.environments.some((entry) => entry.id === candidate.environmentId) &&
          project.agents.some((entry) => entry.id === candidate.agentId)
        )
          selected = candidate
      }
    } catch {
      /* Removed authorization is rejected by setAutoOpsThreadScope. */
    }
  }
  if (selected) return selected
  const project = activeHost?.projects.find((entry) => entry.id === projectId)
  if (!project?.environments[0] || !project.agents[0]) return undefined
  return {
    projectId,
    environmentId: project.environments[0].id,
    agentId: project.agents[0].id,
    visibility: 'private',
  }
}
export function setAutoOpsThreadScope(threadId: string, scope: AutoOpsThreadScope): void {
  const project = activeHost?.projects.find((entry) => entry.id === scope.projectId)
  if (
    !project?.environments.some((entry) => entry.id === scope.environmentId) ||
    !project.agents.some((entry) => entry.id === scope.agentId)
  )
    throw new Error('Unavailable conversation scope.')
  publishThreadScope(threadId, scope)
  if (typeof window !== 'undefined') {
    try {
      autoOpsStorage(window.localStorage).setItem(`thread-scope:${threadId}`, JSON.stringify(scope))
    } catch {}
  }
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
    projectId: source.projectId,
    environmentId: source.environmentId,
    agentId: source.agentId,
    visibility: 'private',
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
    throw new Error('Select an authorized project, environment and agent before starting.')
  const response = await fetch(`${host.gatewayBasePath}/autoops/thread-bindings`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Demo-CSRF': host.csrfToken },
    body: JSON.stringify({ threadId, ...scope }),
  })
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Please sign in again.'
        : 'The conversation scope could not be authorized.',
    )
}

export async function loadAutoOpsThreadScope(
  threadId: string,
  signal?: AbortSignal,
): Promise<AutoOpsThreadScope> {
  if (!activeHost) throw new Error('AutoOps is not connected.')
  const response = await fetch(
    `${activeHost.gatewayBasePath}/autoops/thread-bindings/${encodeURIComponent(threadId)}`,
    { credentials: 'same-origin', ...(signal ? { signal } : {}) },
  )
  if (!response.ok) throw new Error('Conversation access is unavailable.')
  const result = (await response.json()) as { binding: AutoOpsThreadScope }
  publishThreadScope(threadId, result.binding)
  return result.binding
}
