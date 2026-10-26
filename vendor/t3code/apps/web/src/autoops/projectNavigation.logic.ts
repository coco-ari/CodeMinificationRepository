import type { ProjectCapabilities } from '../../../../../../autoops/contracts/runtime.ts'
/** One module definition feeds navigation, route identity and the shared shell. */
export const AUTOOPS_AREAS = [
  { id: 'chat', label: '问答', icon: 'message', path: '/', scope: 'project', common: true, enabled: 'hosted', read: 'authenticated', manage: 'server', sidebar: true },
  { id: 'workspaces', label: '工作区', icon: 'folder', path: '/workspaces', scope: 'project', common: true, enabled: 'hosted', read: 'authenticated', manage: 'server', sidebar: true },
  { id: 'deployments', label: '部署', icon: 'rocket', path: '/deployments', scope: 'project', common: true, enabled: 'hosted', read: 'deployment.read', manage: 'server', sidebar: true },
  { id: 'projects', label: '项目管理', icon: 'folderSettings', path: '/projects', scope: 'global', common: false, enabled: 'hosted', read: 'authenticated', manage: 'server', sidebar: true },
  { id: 'devices', label: '我的电脑', icon: 'laptop', path: '/devices', scope: 'global', common: false, enabled: 'customer-agents', read: 'owner', manage: 'owner', sidebar: true },
  { id: 'skills', label: '技能库', icon: 'sparkles', path: '/skills', scope: 'global', common: true, enabled: 'hosted', read: 'authenticated', manage: 'server', sidebar: true },
] as const

export type AutoOpsArea = typeof AUTOOPS_AREAS[number]['id']

export interface NavigationHost {
  readonly principal: { readonly id: string }
  readonly customerAgentsEnabled?: boolean
  readonly projects: ReadonlyArray<{
    readonly id: string
    readonly capabilities?: Readonly<ProjectCapabilities>
    readonly membership?: { readonly workspaceAccess: string; readonly role: string }
    readonly agents?: ReadonlyArray<{ readonly id: string }>
  }>
}

/** 导航与深链共用注册表及服务端能力，不在前端重新推导角色权限。 */
export function autoOpsAreaAvailable(areaId: AutoOpsArea, host: NavigationHost | undefined, projectId = ''): boolean {
  if (!host?.principal.id) return false
  const area = AUTOOPS_AREAS.find((entry) => entry.id === areaId)
  if (!area || (area.enabled === 'customer-agents' && host.customerAgentsEnabled !== true)) return false
  if (area.scope === 'global') return true
  const project = host.projects.find((entry) => entry.id === projectId)
  if (!project) return false
  if (area.read === 'deployment.read') return project.capabilities?.['deployment.read'] === true
  if (areaId === 'workspaces') return project.capabilities?.['workspace.read'] === true
  return true
}

export type RouteProjectSelection =
  | { readonly status: 'absent' }
  | { readonly status: 'selected'; readonly projectId: string }
  | { readonly status: 'invalid' }

type NavigationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

interface NativeThreadIdentity {
  readonly projectId: string
  readonly deletedAt: unknown
  readonly archivedAt: unknown
}

/** Archiving removes a recent-chat destination, not its real project identity. */
export function resolveAutoOpsNativeThreadProjectId(
  shell: NativeThreadIdentity | null | undefined,
  detail: NativeThreadIdentity | null | undefined,
  purpose: 'context' | 'recent' = 'context',
): string {
  const identity = shell ?? detail
  if (!identity || !identity.projectId || identity.deletedAt !== null) return ''
  if (shell && detail && (shell.projectId !== detail.projectId || detail.deletedAt !== null)) return ''
  if (purpose === 'recent' && (identity.archivedAt !== null || (detail && detail.archivedAt !== null))) return ''
  return identity.projectId
}

/** An explicit invalid scope must never silently select another project. */
export function resolveAutoOpsRouteProjectId(
  search: unknown,
  projects: ReadonlyArray<{ readonly id: string }>,
): RouteProjectSelection {
  let values: unknown[]
  if (search instanceof URLSearchParams) {
    values = search.getAll('projectId')
  } else if (typeof search === 'string' || search instanceof URL) {
    try {
      const url = new URL(String(search), 'https://autoops.invalid/')
      const route = url.hash.startsWith('#/')
        ? new URL(url.hash.slice(1), 'https://autoops.invalid/')
        : url
      values = route.searchParams.getAll('projectId')
    } catch {
      return { status: 'invalid' }
    }
  } else if (search && typeof search === 'object' && Object.hasOwn(search, 'projectId')) {
    values = [(search as Record<string, unknown>).projectId]
  } else {
    return { status: 'absent' }
  }
  if (values.length === 0) return { status: 'absent' }
  const value = values[0]
  return values.length === 1 && typeof value === 'string' &&
    projects.some((project) => project.id === value)
    ? { status: 'selected', projectId: value }
    : { status: 'invalid' }
}

export function autoOpsAreaFromPath(pathname: string): AutoOpsArea {
  return AUTOOPS_AREAS.find((area) => area.path !== '/' &&
    (pathname === area.path || pathname.startsWith(`${area.path}/`)))?.id ?? 'chat'
}

const CONTROL_ROUTES = new Set([
  'settings', 'projects', 'workspaces', 'deployments', 'skills', 'devices', 'usage', 'pull-requests',
  'connect', 'connect-agent', 'pair', 'welcome', 'new', 'api', 'autoops',
])

/** A project change keeps only global skill browsing, never a resource or pending action. */
function skillNavigationSearch(search: unknown, host: NavigationHost): URLSearchParams {
  let params: URLSearchParams
  if (search instanceof URLSearchParams) params = search
  else if (typeof search === 'string' || search instanceof URL) {
    try { params = new URL(String(search), 'https://autoops.invalid/').searchParams }
    catch { return new URLSearchParams() }
  } else {
    params = new URLSearchParams()
    if (search && typeof search === 'object') {
      for (const key of ['skillView', 'agentId'] as const) {
        const value = (search as Record<string, unknown>)[key]
        if (typeof value === 'string') params.set(key, value)
      }
    }
  }
  const result = new URLSearchParams()
  const views = params.getAll('skillView')
  const view = views.length === 1 ? views[0] : undefined
  if (view !== 'library' && view !== 'agent' && view !== 'project') return result
  result.set('skillView', view)
  const agents = params.getAll('agentId')
  const agentId = agents.length === 1 ? agents[0] : undefined
  if (view === 'agent' && agentId && host.projects.some((project) =>
    project.agents?.some((agent) => agent.id === agentId))) result.set('agentId', agentId)
  return result
}

/** Keep only a native chat pathname; never restore saved query commands or external URLs. */
export function normalizeAutoOpsChatHref(href: unknown): string | null {
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//') ||
    /[\\\s\u0000-\u001f\u007f]/u.test(href)) return null
  const pathname = href.split(/[?#]/u, 1)[0]!.replace(/\/$/u, '')
  const segments = pathname.slice(1).split('/')
  if (segments.length !== 2) return null
  let parts: string[]
  try { parts = segments.map(decodeURIComponent) } catch { return null }
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\/\s?#\u0000-\u001f\u007f]/u.test(part))) return null
  if (CONTROL_ROUTES.has(parts[0]!)) return null
  return `/${parts.map(encodeURIComponent).join('/')}`
}

export function createAutoOpsProjectNavigation(options: {
  readonly readHost: () => NavigationHost | undefined
  readonly readStorage: () => NavigationStorage | undefined
  readonly readRouteSearch: () => unknown
  /** null means a non-chat page; empty means an unresolved native chat route. */
  readonly readNativeProjectId?: () => string | null
  /** Re-check current native entities; persisted project claims alone are insufficient. */
  readonly ownsChatHref: (projectId: string, href: string) => boolean
}) {
  let principalId: string | undefined
  let selectedId = ''
  const remembered = new Map<string, string>()
  const listeners = new Set<() => void>()
  const key = (userId: string, suffix: string) =>
    `autoops:project-navigation:${encodeURIComponent(userId)}:${suffix}`
  const readStored = (storageKey: string) => {
    try { return options.readStorage()?.getItem(storageKey) ?? null } catch { return null }
  }
  const writeStored = (storageKey: string, value: string) => {
    try { options.readStorage()?.setItem(storageKey, value) } catch { /* In-memory navigation remains usable. */ }
  }
  const removeStored = (storageKey: string) => {
    try { options.readStorage()?.removeItem(storageKey) } catch { /* Storage may be disabled. */ }
  }
  const hostNow = () => {
    const host = options.readHost()
    if (host?.principal.id !== principalId) {
      principalId = host?.principal.id
      selectedId = ''
      remembered.clear()
    }
    return host
  }
  const allowed = (host: NavigationHost, id: string) => host.projects.some((project) => project.id === id)
  const selectionKey = (host: NavigationHost) => key(host.principal.id, 'project')
  const chatKey = (host: NavigationHost, id: string) => key(host.principal.id, `chat:${encodeURIComponent(id)}`)

  const readProjectId = (
    search: unknown = options.readRouteSearch(),
    nativeProjectId: string | null = options.readNativeProjectId?.() ?? null,
  ): string => {
    const host = hostNow()
    if (!host) return ''
    if (nativeProjectId !== null) return allowed(host, nativeProjectId) ? nativeProjectId : ''
    const explicit = resolveAutoOpsRouteProjectId(search, host.projects)
    if (explicit.status === 'invalid') return ''
    if (explicit.status === 'selected') return explicit.projectId
    if (allowed(host, selectedId)) return selectedId
    const stored = readStored(selectionKey(host))
    if (stored && allowed(host, stored)) return stored
    if (stored) removeStored(selectionKey(host))
    return host.projects[0]?.id ?? ''
  }

  return {
    readProjectId,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    selectProject(id: string) {
      const host = hostNow()
      if (!host) return
      if (!allowed(host, id)) throw new Error('当前项目不可用或无权访问。')
      selectedId = id
      writeStored(selectionKey(host), id)
      for (const listener of listeners) listener()
    },
    rememberChatLocation(projectId: string, href: string) {
      const host = hostNow()
      const normalized = normalizeAutoOpsChatHref(href)
      if (!host || !allowed(host, projectId) || !normalized || !options.ownsChatHref(projectId, normalized)) return
      remembered.set(projectId, normalized)
      writeStored(chatKey(host, projectId), normalized)
    },
    projectHref(area: AutoOpsArea, projectId: string, search?: unknown): string {
      const host = hostNow()
      if (!host) return '/'
      if (!allowed(host, projectId)) throw new Error('当前项目不可用或无权访问。')
      const params = new URLSearchParams({ projectId })
      if (area === 'skills') {
        for (const [key, value] of skillNavigationSearch(search, host)) params.set(key, value)
      }
      const query = params.toString()
      if (area !== 'chat') return `/${area}?${query}`
      const storageKey = chatKey(host, projectId)
      const candidate = remembered.get(projectId) ?? readStored(storageKey)
      const normalized = normalizeAutoOpsChatHref(candidate)
      if (normalized && options.ownsChatHref(projectId, normalized)) {
        remembered.set(projectId, normalized)
        return normalized
      }
      remembered.delete(projectId)
      // A native snapshot can still be loading. Keep a syntactically valid saved path
      // for a later ownership check, but never navigate to it before that succeeds.
      if (candidate && !normalized) removeStored(storageKey)
      return `/?${query}`
    },
  }
}
