import type { AssistantDirectory } from '../../../../../../autoops/contracts/assistants.ts'
import type { ProjectCapabilities } from '../../../../../../autoops/contracts/runtime.ts'
import type { ProjectRole } from '../../../../../../autoops/contracts/project-access.ts'
import { ClientSettingsPatch, type ClientSettings } from '@t3tools/contracts/settings'
import * as Schema from 'effect/Schema'
// 在 T3 状态初始化前保存已认证的宿主快照；独立 T3 客户端保持原有行为。
export interface AutoOpsT3Bootstrap {
  readonly principal: { readonly id: string; readonly displayName: string }
  readonly gatewayBasePath: string
  readonly csrfToken: string
  /** 保留协议字段名；允许模型选择时，此值仅为默认模型。 */
  readonly fixedModel: { readonly instanceId: string; readonly model: string; readonly reasoningEffort?: import('../../../../../../autoops/contracts/assistants.ts').QuestionConfiguration['model']['reasoningEffort'] }
  readonly canCreateProject?: boolean
  readonly canManageDeploymentNodes?: boolean
  readonly canManageAccounts?: boolean
  readonly modelSelectionEnabled?: boolean
  readonly customerAgentsEnabled?: boolean
  readonly assistantDirectoryEnabled?: boolean
  readonly runtimeMode: 'approval-required'
  readonly productProfile?: { readonly id: 't3-demo-full-v1' | 'project-assistant-lite-v1' }
  readonly clientSettingsOverrides?: Readonly<Partial<ClientSettings>>
  readonly projects: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly environments: ReadonlyArray<{ readonly id: string; readonly name: string }>
    readonly assistants?: AssistantDirectory
    readonly agents: ReadonlyArray<{ readonly id: string; readonly name: string }>
    readonly capabilities?: Readonly<ProjectCapabilities>
    readonly membership?: {
      readonly workspaceAccess: 'internal' | 'external'
      readonly role: ProjectRole
      readonly canAdjustChat?: boolean
      readonly authorizationPending?: boolean
      readonly environmentIds: ReadonlyArray<string>
    }
  }>
  readonly initialRoute?: { readonly environmentId: string; readonly threadId: string }
  readonly capabilities: Readonly<Record<string, unknown>>
}

export interface AutoOpsHost extends AutoOpsT3Bootstrap {
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
}

let activeHost: AutoOpsHost | undefined
const hostListeners = new Set<() => void>()
export const subscribeAutoOpsHost = (listener: () => void) => {
  hostListeners.add(listener)
  return () => {
    hostListeners.delete(listener)
  }
}

export function installAutoOpsHostSnapshot(input: AutoOpsT3Bootstrap, origin: string): AutoOpsHost {
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
    // 切换用户必须重新加载文档，清除原用户的单例状态、草稿和连接。
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
  if (
    input.productProfile &&
    !['t3-demo-full-v1', 'project-assistant-lite-v1'].includes(input.productProfile.id)
  ) {
    throw new Error('不支持当前产品配置，请更新页面后重试。')
  }
  const clientSettingsOverrides =
    input.clientSettingsOverrides === undefined
      ? undefined
      : Schema.decodeUnknownSync(ClientSettingsPatch)(input.clientSettingsOverrides)
  const host: AutoOpsHost = {
    ...input,
    ...(clientSettingsOverrides === undefined ? {} : { clientSettingsOverrides }),
    httpBaseUrl: base.href,
    wsBaseUrl: socket.href,
  }
  activeHost = host
  for (const listener of hostListeners) listener()
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
      /* 存储不可用时，T3 保留当前内存偏好。 */
    }
  }
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
/** 仅包装当前用户的存储视图，clear() 只清理当前用户的数据。 */
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
