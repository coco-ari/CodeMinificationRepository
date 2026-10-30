import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useBlocker, useNavigate, useSearch } from '@tanstack/react-router'
import {
  PlusIcon,
  RefreshCwIcon,
  MoreHorizontalIcon,
  ServerIcon,
  SettingsIcon,
  HistoryIcon,
  PackageIcon,
} from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from '~/components/ui/dialog'
import { Menu, MenuTrigger, MenuPopup, MenuItem } from '~/components/ui/menu'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Spinner } from '~/components/ui/spinner'
import { randomUUID } from '~/lib/utils'
import {
  ModuleHeader,
  ModuleSidebar,
  ModuleSidebarItem,
  ModuleSidebarEmpty,
} from './ModuleWorkspace'
import { readAutoOpsHost } from './hostConfig'
import { AutoOpsRequestError } from './apiClient'
import type { WorkspaceRelease } from './workspaces'
import type { ProjectRepositoryConnection } from './workspaceAuthoring'
import { createDeploymentRepositoryQueries } from './deployment/repositoryQueries'
import {
  loadDeployments,
  loadDeploymentReleases,
  loadDeploymentRequest,
  saveDeploymentService,
  saveDeploymentServiceSource,
  createDeploymentTarget,
  updateDeploymentTarget,
  submitDeployment,
  removeDeploymentConfiguration,
  removeEnvironmentDeploymentService,
  DeploymentRequestError,
  type DeploymentOverview,
  type DeploymentService,
  type DeploymentTarget,
  type DeploymentRelease,
  type DeploymentSubmission,
  type DeploymentRequestReceipt,
  deploymentStatusLabel,
} from './deployments'
import {
  Choice,
  DeploymentEmpty,
  DeploymentLogs,
  DeploymentHistory,
  DeploymentServers,
  ServiceDialog,
  ServiceSourceDialog,
  TargetDialog,
  ReleaseDialog,
  ConfigurationDetails,
  DeploymentReleaseIdentity,
  deriveDeploymentRuntimeStatus,
  errorLabel,
  DeploymentRuntimeSummary,
  RepositorySetupNotice,
  DeploymentRevisionPicker,
  type DeploymentCandidate,
  deploymentHref,
  deploymentNavigation,
  type DeploymentNavigation,
  nodePageHref,
} from './deployment'

type PackageActions = {
  generateDisabled: boolean
  tasksDisabled: boolean
  tasksLabel: string
  tasksActive: boolean
  onGenerate: (trigger: HTMLElement | null) => void
  onTasks: (trigger: HTMLElement | null) => void
}
type Props = {
  projectId: string
  packages: WorkspaceRelease[]
  sources: ProjectRepositoryConnection[]
  sourcesError: string | null
  navigation: ReactNode
  packageActions: PackageActions | null
  onRefreshPackages: () => void
  onShowPackages?: () => void
}
type Pending = {
  requestId: string
  kind: 'service' | 'source' | 'target' | 'task' | 'delete' | 'remove'
  environmentId: string
  serviceId?: string | undefined
  targetId?: string | undefined
  nextStep?: 1 | 2 | 3
}
type Confirmation =
  | { kind: 'publish'; target: DeploymentTarget; candidate: DeploymentCandidate }
  | {
      kind: 'delete-service' | 'delete-target' | 'remove'
      service: DeploymentService
      target?: DeploymentTarget
      configKey: string
    }
const keyFor = (projectId: string, suffix: string) =>
  `autoops:deployments:${readAutoOpsHost()?.principal.id ?? ''}:${projectId}:${suffix}`
function saved<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}
function remember(key: string, value: unknown) {
  try {
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}
const statusOf = (cause: unknown) =>
  cause instanceof DeploymentRequestError || cause instanceof AutoOpsRequestError
    ? cause.status
    : undefined

/** 浏览上下文属于路由，配置草稿属于表单，执行结果始终来自现有部署模块。 */
export function DeploymentsPanel({
  projectId,
  packages,
  sources,
  sourcesError,
  packageActions,
  onRefreshPackages,
  onShowPackages,
}: Props) {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as DeploymentNavigation & {
    deploymentEnvironmentId?: string
  }
  const route = deploymentNavigation({ ...search, environmentId: search.deploymentEnvironmentId })
  const project = readAutoOpsHost()?.projects.find((row) => row.id === projectId)
  const environments =
    project?.environments.filter(
      (row) => !project.membership || project.membership.environmentIds.includes(row.id),
    ) ?? []
  const [last] = useState(() => saved<DeploymentNavigation>(keyFor(projectId, 'selection')))
  const environmentId =
    route.environmentId ??
    route.nodeEnvironmentId ??
    (environments.some((row) => row.id === last?.environmentId)
      ? last!.environmentId!
      : (environments[0]?.id ?? ''))
  const tab = route.tab ?? 'publish'
  const step = route.setupStep
  const host = readAutoOpsHost()
  const repositoryScope = JSON.stringify([
    host?.principal.id,
    host?.csrfToken,
    projectId,
    environmentId,
    project?.capabilities,
    project?.membership,
    sources.map((row) => [row.id, row.url, row.credentialId]),
  ])
  const repositoryQueries = useMemo(
    () => createDeploymentRepositoryQueries(projectId),
    [projectId, repositoryScope],
  )
  useEffect(() => () => repositoryQueries.dispose(), [repositoryQueries])
  const [overview, setOverview] = useState<DeploymentOverview | null>(null)
  const [catalog, setCatalog] = useState<DeploymentService[]>([])
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resumeRemoval, setResumeRemoval] = useState<{
    requestId: string
    intent: NonNullable<DeploymentRequestReceipt['publicIntent']>
  } | null>(null)
  const [requests, setRequests] = useState<Pending[]>(() => {
    const stored = saved<unknown>(keyFor(projectId, 'pending'))
    const items = Array.isArray(stored) ? stored : stored ? [stored] : []
    const values: Pending[] = []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const input =
        row.input && typeof row.input === 'object' ? (row.input as Record<string, unknown>) : {}
      const scope =
        row.scope && typeof row.scope === 'object' ? (row.scope as Record<string, unknown>) : {}
      const requestId = row.requestId ?? input.requestId
      const kind = row.kind === 'target-update' ? 'target' : row.kind
      if (
        typeof requestId !== 'string' ||
        !['service', 'source', 'target', 'task', 'delete', 'remove'].includes(String(kind))
      )
        continue
      const env = row.environmentId ?? scope.environmentId ?? input.environmentId
      const service = row.serviceId ?? scope.serviceId ?? input.serviceId
      const target = row.targetId ?? input.targetId
      values.push({
        requestId,
        kind: kind as Pending['kind'],
        environmentId: typeof env === 'string' ? env : environmentId,
        ...(typeof service === 'string' ? { serviceId: service } : {}),
        ...(typeof target === 'string' ? { targetId: target } : {}),
        ...([1, 2, 3].includes(Number(row.nextStep))
          ? { nextStep: Number(row.nextStep) as 1 | 2 | 3 }
          : {}),
      })
    }
    // 旧页面曾保存完整输入，升级时仅保留查询原收据所需的定位标识。
    remember(keyFor(projectId, 'pending'), values.length ? values : null)
    return values
  })
  const [dirty, setDirty] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [dialog, setDialog] = useState<'servers' | 'package' | 'restart' | 'rollback' | null>(
    route.nodeEnvironmentId ? 'servers' : null,
  )
  const [rollbackId, setRollbackId] = useState('')
  const [releases, setReleases] = useState<DeploymentRelease[]>([])
  const [releasesError, setReleasesError] = useState<string | null>(null)
  const [draft, setDraft] = useState<DeploymentNavigation | null>(() =>
    saved(keyFor(projectId, 'setup')),
  )
  const [existingId, setExistingId] = useState('')
  const scopeDenied = useRef(false)
  const scopeAbort = useRef<AbortController | null>(null)
  const revokeScope = useCallback((cause: unknown) => {
    repositoryQueries.clear()
    scopeDenied.current = true
    scopeAbort.current?.abort()
    setOverview(null)
    setCatalog([])
    setReleases([])
    setConfirmation(null)
    setDialog(null)
    setLoadError(errorLabel(cause))
    setError(errorLabel(cause))
  }, [repositoryQueries])
  const requestGuard = useRef(false)
  const autoChecked = useRef(new Set<string>())
  const allowNavigation = useRef(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const context = useRef('')
  const identity = `${readAutoOpsHost()?.principal.id}:${projectId}:${environmentId}:${route.serviceId ?? ''}:${route.targetId ?? ''}:${step ?? ''}`
  context.current = identity
  const blocker = useBlocker({
    shouldBlockFn: () => !allowNavigation.current && (busy || dirty),
    enableBeforeUnload: busy || dirty,
    withResolver: true,
  })
  const change = (patch: Partial<DeploymentNavigation>, replace = false) =>
    void navigate({
      href: deploymentHref(projectId, {
        environmentId,
        ...route,
        ...patch,
        nodeEnvironmentId: undefined,
      }),
      replace,
    })
  const permits = overview?.capabilities?.environments[environmentId]
  useEffect(() => {
    if (permits && !permits.read) repositoryQueries.clear()
  }, [permits?.read, repositoryQueries])
  const manage = overview?.capabilities?.serviceManage === true
  const configure = permits?.configure === true
  const services = permits?.read ? (overview?.services ?? []) : []
  const serviceId = route.serviceId ?? (step ? '' : (services[0]?.id ?? ''))
  const service =
    services.find((row) => row.id === serviceId) ??
    (step ? catalog.find((row) => row.id === serviceId) : undefined)
  const targets =
    overview?.targets.filter(
      (row) => row.serviceId === service?.id && row.environmentId === environmentId,
    ) ?? []
  const target = route.targetId ? targets.find((row) => row.id === route.targetId) : targets[0]
  const source = overview?.serviceSources?.find(
    (row) => row.serviceId === service?.id && row.environmentId === environmentId,
  )
  const tasks = overview?.tasks.filter((row) => row.targetId === target?.id) ?? []
  const activeTask = tasks.find(
    (row) => !['succeeded', 'failed', 'rolled_back', 'interrupted'].includes(row.status),
  )
  const taskId = route.taskId ?? activeTask?.id ?? ''
  const server = overview?.servers.find(
    (row) => row.id === target?.serverId && row.environmentId === environmentId,
  )
  const online = !!server?.online && !server.revoked
  const executorReady =
    online && (target?.config.kind === 'java' || server?.capabilities?.includes('static-site-v1'))
  const pending = requests.find((row) =>
    row.kind === 'service' && row.serviceId
      ? row.serviceId === serviceId
      : row.environmentId === environmentId &&
        (!row.serviceId
          ? row.kind !== 'service' || serviceId === 'new'
          : row.serviceId === serviceId),
  )
  const disabled = busy || !!pending
  const publishDisabled = disabled || !permits?.publish || !executorReady || !!activeTask
  const runtime = target ? deriveDeploymentRuntimeStatus(target, tasks) : null
  const reload = useCallback(() => setRefresh((n) => n + 1), [])

  useEffect(() => {
    allowNavigation.current = false
    setDirty(false)
    setConfirmation(null)
    setError(null)
    setExistingId('')
  }, [identity])
  useEffect(() => {
    if (!environmentId) {
      setOverview(null)
      return
    }
    const controller = new AbortController()
    scopeDenied.current = false
    scopeAbort.current = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    let reading = false
    let forbidden = false
    setOverview(null)
    setCatalog([])
    setLoadError(null)
    const poll = async () => {
      if (reading || document.hidden || controller.signal.aborted || scopeDenied.current) return
      reading = true
      try {
        const value = await loadDeployments(projectId, environmentId, controller.signal)
        if (!controller.signal.aborted && !scopeDenied.current) {
          setOverview(value)
          setLoadError(null)
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setLoadError(errorLabel(cause))
          if ([401, 403, 404].includes(statusOf(cause) ?? 0)) {
            repositoryQueries.clear()
            forbidden = true
            setOverview(null)
            setCatalog([])
          }
        }
      } finally {
        reading = false
        if (!controller.signal.aborted && !document.hidden && !forbidden)
          timer = setTimeout(poll, 3000)
      }
    }
    const visibility = () => {
      clearTimeout(timer)
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [projectId, environmentId, refresh, repositoryQueries])
  useEffect(() => {
    if (!step || !configure) return
    const controller = new AbortController()
    setCatalogError(null)
    void loadDeployments(projectId, environmentId, controller.signal, true)
      .then((value) => {
        if (!controller.signal.aborted && !scopeDenied.current)
          setCatalog(value.availableServices ?? [])
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setCatalogError(errorLabel(cause))
      })
    return () => controller.abort()
  }, [projectId, environmentId, step, configure, refresh])
  useEffect(() => {
    if (!target || (tab !== 'history' && dialog !== 'rollback')) return
    const controller = new AbortController()
    setReleasesError(null)
    void loadDeploymentReleases(projectId, target.id, controller.signal, { offset: 0, limit: 20 })
      .then((value) => {
        if (!controller.signal.aborted && !scopeDenied.current) setReleases(value.releases)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          if ([401, 403, 404].includes(statusOf(cause) ?? 0)) revokeScope(cause)
          else setReleasesError(errorLabel(cause))
        }
      })
    return () => controller.abort()
  }, [projectId, target?.id, tab, dialog, refresh])
  useEffect(() => {
    if (!overview || !environmentId) return
    remember(keyFor(projectId, 'selection'), {
      environmentId,
      serviceId: service?.id,
      targetId: target?.id,
      tab,
      taskId: route.taskId,
    })
    if (step) {
      const value = {
        environmentId,
        serviceId: route.serviceId,
        targetId: route.targetId,
        setupStep: step,
      }
      setDraft(value)
      remember(keyFor(projectId, 'setup'), value)
    }
  }, [
    projectId,
    environmentId,
    service?.id,
    target?.id,
    tab,
    step,
    route.serviceId,
    route.targetId,
    route.taskId,
    !!overview,
  ])

  function accepted(meta: Pending, result: unknown, origin: string) {
    const value = result as
      | {
          service?: DeploymentService
          source?: { serviceId: string }
          target?: DeploymentTarget
          task?: { id: string; targetId: string }
          id?: string
          serviceId?: string
        }
      | undefined
    const id =
      value?.service?.id ??
      value?.source?.serviceId ??
      value?.target?.serviceId ??
      (meta.kind === 'service' ? value?.id : undefined) ??
      (value?.task
        ? overview?.targets.find((row) => row.id === value.task!.targetId)?.serviceId
        : undefined) ??
      meta.serviceId
    setRequests((old) => {
      const remaining = old.filter((row) => row.requestId !== meta.requestId)
      remember(keyFor(projectId, 'pending'), remaining.length ? remaining : null)
      return remaining
    })
    if (meta.kind === 'target') {
      setDraft(null)
      remember(keyFor(projectId, 'setup'), null)
    }
    if (
      context.current === origin &&
      meta.environmentId === environmentId &&
      (!meta.serviceId || !route.serviceId || meta.serviceId === route.serviceId)
    ) {
      setDirty(false)
      allowNavigation.current = true
      setConfirmation(null)
      setDialog(null)
      change({
        environmentId: meta.environmentId,
        serviceId:
          (meta.kind === 'delete' && !meta.targetId) || meta.kind === 'remove' ? undefined : id,
        targetId:
          meta.kind === 'delete'
            ? undefined
            : (value?.target?.id ??
              (meta.kind === 'target' && typeof result === 'string' ? result : meta.targetId)),
        taskId: value?.task?.id,
        setupStep: meta.nextStep,
        tab: meta.kind === 'target' || meta.kind === 'task' ? 'publish' : tab,
      })
    }
    reload()
  }
  async function run(
    meta: Omit<Pending, 'requestId'>,
    work: (requestId: string) => Promise<unknown>,
  ) {
    if (requestGuard.current || pending) return
    const command = { ...meta, requestId: randomUUID() }
    const nextRequests = [...requests, command]
    if (!remember(keyFor(projectId, 'pending'), nextRequests)) {
      setError('无法保存本次请求的恢复标识，请允许浏览器存储后重试。')
      return
    }
    requestGuard.current = true
    setBusy(true)
    setError(null)
    setRequests(nextRequests)
    const origin = context.current
    try {
      accepted(command, await work(command.requestId), origin)
    } catch (cause) {
      const uncertain =
        cause instanceof DeploymentRequestError || cause instanceof AutoOpsRequestError
          ? cause.uncertain
          : true
      if (!uncertain && command.kind !== 'remove')
        setRequests((old) => {
          const remaining = old.filter((row) => row.requestId !== command.requestId)
          remember(keyFor(projectId, 'pending'), remaining.length ? remaining : null)
          return remaining
        })
      if (!uncertain && command.kind === 'remove') {
        const receipt = await loadDeploymentRequest(projectId, command.requestId).catch(() => null)
        if (receipt?.state === 'not_observed')
          setRequests((old) => {
            const remaining = old.filter((row) => row.requestId !== command.requestId)
            remember(keyFor(projectId, 'pending'), remaining.length ? remaining : null)
            return remaining
          })
      }
      setError(errorLabel(cause))
      if ([401, 403].includes(statusOf(cause) ?? 0)) revokeScope(cause)
    } finally {
      requestGuard.current = false
      setBusy(false)
    }
  }
  async function checkResult() {
    if (!pending || busy) return
    setBusy(true)
    setError(null)
    const origin = context.current
    try {
      const receipt: DeploymentRequestReceipt = await loadDeploymentRequest(
        projectId,
        pending.requestId,
      )
      if (
        receipt.state === 'completed' ||
        (receipt.state === 'accepted' && receipt.operation === 'task')
      )
        accepted(pending, receipt.result, origin)
      else {
        if (
          receipt.state === 'accepted' &&
          receipt.operation === 'remove-environment-service' &&
          receipt.publicIntent
        )
          setResumeRemoval({ requestId: pending.requestId, intent: receipt.publicIntent })
        setError(
          receipt.state === 'not_observed'
            ? '尚未观察到原请求结果，请稍后再次核对；没有创建新的请求。'
            : '原操作已接受，清理尚未完成；可核对结果或继续原移除操作。',
        )
      }
    } catch (cause) {
      setError(errorLabel(cause))
      if ([401, 403].includes(statusOf(cause) ?? 0)) revokeScope(cause)
    } finally {
      setBusy(false)
    }
  }
  async function continueRemoval() {
    if (!pending || resumeRemoval?.requestId !== pending.requestId || requestGuard.current) return
    const origin = context.current
    requestGuard.current = true
    setBusy(true)
    setError(null)
    try {
      const { intent } = resumeRemoval
      const result = await removeEnvironmentDeploymentService(
        projectId,
        intent.environmentId,
        intent.serviceId,
        { requestId: pending.requestId, configKey: intent.configKey },
      )
      accepted(pending, result, origin)
      setResumeRemoval(null)
    } catch (cause) {
      setError(errorLabel(cause))
      if ([401, 403].includes(statusOf(cause) ?? 0)) revokeScope(cause)
    } finally {
      requestGuard.current = false
      setBusy(false)
    }
  }
  useEffect(() => {
    if (pending && !busy && !autoChecked.current.has(pending.requestId)) {
      autoChecked.current.add(pending.requestId)
      void checkResult()
    }
  }, [pending?.requestId, busy])
  function setup(next: 1 | 2 | 3, id = service?.id, position = target?.id) {
    change({ serviceId: id, targetId: position, setupStep: next, taskId: undefined, tab: 'config' })
  }
  const closeSetup = () => change({ setupStep: undefined, tab: 'config' })
  const finalFocus = () =>
    returnFocus.current?.isConnected ? returnFocus.current : trigger.current
  const canRead = permits?.read === true
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      aria-label="服务发布"
      onClickCapture={(event) => {
        const button = event.target instanceof Element ? event.target.closest('button') : null
        if (button && event.currentTarget.contains(button) && !confirmation && !dialog)
          returnFocus.current = button
      }}
    >
      <ModuleSidebar
        label="部署服务"
        search={{ value: query, onChange: setQuery, label: '搜索服务' }}
        actions={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="添加服务"
            disabled={!configure || disabled}
            onClick={() => setup(1, 'new', 'new')}
          >
            <PlusIcon />
          </Button>
        }
      >
        <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
          <div className="px-[var(--sidebar-content-inset)]">
            {services
              .filter((row) => row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
              .map((row) => (
                <ModuleSidebarItem
                  key={row.id}
                  label={row.name}
                  icon={ServerIcon}
                  selected={row.id === service?.id}
                  description={
                    overview?.configuration?.[`${environmentId}:${row.id}`]?.missing.length
                      ? '待完成配置'
                      : `${overview?.targets.filter((position) => position.serviceId === row.id).length ?? 0} 个部署位置`
                  }
                  onClick={() =>
                    change({
                      serviceId: row.id,
                      targetId: undefined,
                      taskId: undefined,
                      setupStep: undefined,
                      tab: 'publish',
                    })
                  }
                />
              ))}
            {!services.length ? (
              <ModuleSidebarEmpty>
                {loadError
                  ? '读取服务失败，可在主区重试。'
                  : overview
                    ? '当前环境还没有服务。'
                    : '正在读取服务…'}
              </ModuleSidebarEmpty>
            ) : services.every(
                (row) => !row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
              ) ? (
              <ModuleSidebarEmpty>没有匹配的服务。</ModuleSidebarEmpty>
            ) : null}
            {draft?.environmentId === environmentId && configure ? (
              <ModuleSidebarItem
                label="继续配置"
                description={
                  catalog.find((row) => row.id === draft.serviceId)?.name ?? '未完成的服务配置'
                }
                selected={!!step}
                icon={SettingsIcon}
                onClick={() => change(draft)}
              />
            ) : null}
          </div>
        </ScrollArea>
      </ModuleSidebar>
      <ModuleHeader
        title="部署发布"
        detail={service?.name}
        actions={
          <>
            {taskId && tab === 'publish' ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!!activeTask}
                onClick={() => change({ taskId: undefined, tab: 'publish' })}
              >
                选择其他提交
              </Button>
            ) : null}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="刷新部署状态"
              disabled={busy || dirty}
              onClick={() => {
                reload()
                onRefreshPackages()
              }}
            >
              <RefreshCwIcon />
            </Button>
            <Button
              ref={trigger}
              size="icon-sm"
              variant="ghost"
              aria-label="管理部署节点"
              disabled={!overview?.enabled}
              onClick={() => setDialog('servers')}
            >
              <ServerIcon />
            </Button>
            <Menu>
              <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="服务操作" />}>
                <MoreHorizontalIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                {configure ? (
                  <MenuItem disabled={disabled} onClick={() => setup(1, 'new', 'new')}>
                    添加服务
                  </MenuItem>
                ) : null}
                {service && configure ? (
                  <MenuItem disabled={disabled} onClick={() => setup(3, service.id, 'new')}>
                    添加部署位置
                  </MenuItem>
                ) : null}
                {target?.config.kind === 'java' && permits?.restart ? (
                  <MenuItem
                    disabled={disabled || !online || !target.currentRelease || !!activeTask}
                    onClick={() => setDialog('restart')}
                  >
                    重启当前版本
                  </MenuItem>
                ) : null}
                {target && permits?.publish ? (
                  <MenuItem disabled={publishDisabled} onClick={() => setDialog('package')}>
                    使用已有源码包发布
                  </MenuItem>
                ) : null}
                {onShowPackages ? <MenuItem onClick={onShowPackages}>源码包</MenuItem> : null}
                {packageActions ? (
                  <>
                    <MenuItem
                      disabled={packageActions.tasksDisabled}
                      onClick={() => packageActions.onTasks(trigger.current)}
                    >
                      <HistoryIcon />
                      {packageActions.tasksLabel}
                    </MenuItem>
                    <MenuItem
                      disabled={packageActions.generateDisabled}
                      onClick={() => packageActions.onGenerate(trigger.current)}
                    >
                      <PackageIcon />
                      生成部署包
                    </MenuItem>
                  </>
                ) : null}
                {target && configure ? (
                  <MenuItem
                    variant="destructive"
                    disabled={disabled}
                    onClick={() =>
                      setConfirmation({
                        kind: 'delete-target',
                        service: service!,
                        target,
                        configKey: target.configKey,
                      })
                    }
                  >
                    删除当前部署位置
                  </MenuItem>
                ) : null}
                {service &&
                configure &&
                overview?.configuration?.[`${environmentId}:${service.id}`] ? (
                  <MenuItem
                    variant="destructive"
                    disabled={disabled}
                    onClick={() =>
                      setConfirmation({
                        kind: 'remove',
                        service,
                        configKey:
                          overview.configuration![`${environmentId}:${service.id}`]!.configKey,
                      })
                    }
                  >
                    移除此环境的服务配置
                  </MenuItem>
                ) : null}
                {service && manage ? (
                  <MenuItem
                    variant="destructive"
                    disabled={disabled}
                    onClick={() =>
                      setConfirmation({
                        kind: 'delete-service',
                        service,
                        configKey: service.configKey,
                      })
                    }
                  >
                    删除项目共享服务
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          </>
        }
      />
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2"
        data-deployment-toolbar=""
      >
        <div className="w-44 min-w-0">
          <Choice
            label="部署环境"
            value={environmentId}
            options={environments}
            placeholder="没有可用环境"
            onChange={(value) =>
              change({
                environmentId: value,
                serviceId: undefined,
                targetId: undefined,
                taskId: undefined,
                setupStep: undefined,
                tab: 'publish',
              })
            }
          />
        </div>
        {targets.length > 1 ? (
          <div className="w-44 min-w-0">
            <Choice
              label="部署位置"
              value={target?.id ?? ''}
              options={targets.map((row) => ({
                id: row.id,
                name: overview?.servers.find((node) => node.id === row.serverId)?.name ?? row.name,
              }))}
              onChange={(value) =>
                change({ targetId: value, taskId: undefined, setupStep: undefined })
              }
            />
          </div>
        ) : server ? (
          <span className="truncate text-xs text-muted-foreground">
            {server.name} · {online ? '在线' : '离线'}
          </span>
        ) : null}
        {!step && service ? (
          <ToggleGroup
            aria-label="部署详情分类"
            variant="segmented"
            value={[tab]}
            onValueChange={(value) => {
              if (value[0] === 'publish' || value[0] === 'history' || value[0] === 'config')
                change({ tab: value[0], taskId: undefined })
            }}
          >
            <Toggle value="publish">发布</Toggle>
            <Toggle value="history">发布记录</Toggle>
            <Toggle value="config">配置</Toggle>
          </ToggleGroup>
        ) : null}
      </div>
      {target && !step ? (
        <DeploymentRuntimeSummary
          target={target}
          tasks={tasks}
          serverName={server?.name ?? '节点不可用'}
          online={online}
          onTask={(id) => change({ taskId: id, tab: 'publish' })}
        />
      ) : null}
      {!step && !taskId && tab === 'publish' && overview && !sourcesError && !sources.length ? (
        <div className="shrink-0 border-b p-3">
          <RepositorySetupNotice projectId={projectId} disabled={disabled} />
        </div>
      ) : null}
      {requests.some((row) => row !== pending) ? (
        <div className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
          其他范围有待确认操作。
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              const row = requests.find((row) => row !== pending)!
              change({
                environmentId: row.environmentId,
                serviceId: row.serviceId ?? 'new',
                targetId: row.targetId,
                setupStep: row.kind === 'service' ? 1 : undefined,
                tab: 'publish',
              })
            }}
          >
            查看待确认操作
          </Button>
        </div>
      ) : null}
      {error || loadError || pending ? (
        <div className="shrink-0 border-b border-border/60 p-3">
          <Alert variant={error || loadError ? 'error' : 'info'}>
            <AlertTitle>
              {pending ? '有一项操作结果待核对' : error ? '部署操作未完成' : '部署状态读取失败'}
            </AlertTitle>
            <AlertDescription>
              {error ?? loadError ?? '正在确认原请求结果。'}
              {pending ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void checkResult()}
                  >
                    检查操作结果
                  </Button>
                  {resumeRemoval?.requestId === pending.requestId && configure ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void continueRemoval()}
                    >
                      继续原移除操作
                    </Button>
                  ) : null}
                </div>
              ) : loadError ? (
                <Button size="xs" variant="outline" className="mt-2 self-start" onClick={reload}>
                  重新加载
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {blocker.status === 'blocked' ? (
        <div className="shrink-0 border-b p-3">
          <Alert variant="info">
            <AlertDescription>
              {busy ? '正在保存，请等待本次操作完成。' : '有尚未保存的修改。'}
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => blocker.reset()}>
                  继续编辑
                </Button>
                {!busy ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDirty(false)
                      blocker.proceed()
                    }}
                  >
                    放弃修改
                  </Button>
                ) : null}
              </div>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {!environmentId ? (
        <DeploymentEmpty
          title="没有可用部署环境"
          description="请由项目管理员创建环境并分配访问范围。"
        />
      ) : !overview ? (
        loadError ? null : (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" />
            正在读取环境服务…
          </div>
        )
      ) : !overview.enabled ? (
        <DeploymentEmpty title="部署服务尚未启用" description="请由平台管理员检查部署服务配置。" />
      ) : !canRead ? (
        <DeploymentEmpty title="无权访问此环境部署" description="请选择其他获授权的环境。" />
      ) : step ? (
        <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
          <div className="mx-auto max-w-3xl py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4">
              <ol className="flex flex-wrap gap-2" aria-label="服务配置步骤">
                {(['服务信息', '当前环境源码', '部署配置'] as const).map((label, index) => (
                  <li key={label}>
                    <Button
                      size="sm"
                      variant={step === index + 1 ? 'secondary' : 'ghost'}
                      disabled={disabled || (index > 0 && !service) || (index === 2 && !source)}
                      onClick={() => setup((index + 1) as 1 | 2 | 3, service?.id, target?.id)}
                    >
                      {index + 1}. {label}
                    </Button>
                  </li>
                ))}
              </ol>
              <Button size="sm" variant="ghost" disabled={busy} onClick={closeSetup}>
                返回服务
              </Button>
            </div>
            <p className="px-4 py-3 text-xs text-muted-foreground">
              每步分别保存，可随时继续。配置保存后不会自动发布。
            </p>
            {!configure ? (
              <DeploymentEmpty
                title="无权修改部署配置"
                description="此环境只允许查看，请联系项目管理员。"
              />
            ) : (
              <>
                {catalogError ? (
                  <Alert variant="error">
                    <AlertDescription>
                      {catalogError}
                      <Button size="xs" onClick={reload}>
                        重新读取服务目录
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {step === 1 ? (
                  <>
                    {!service ? (
                      <div className="space-y-3 px-4 pb-4">
                        <Choice
                          label="复用项目已有服务"
                          value={existingId}
                          options={catalog.map((row) => ({ id: row.id, name: row.name }))}
                          onChange={setExistingId}
                          placeholder="选择项目已有服务"
                        />
                        <Button
                          variant="outline"
                          disabled={!existingId || disabled}
                          onClick={() => setup(2, existingId, 'new')}
                        >
                          使用已有服务并继续
                        </Button>
                      </div>
                    ) : null}
                    {manage && (service || !route.serviceId || route.serviceId === 'new') ? (
                      <ServiceDialog
                        key={`service:${service?.id ?? 'new'}`}
                        open
                        embedded
                        onDirty={setDirty}
                        onOpenChange={(open) => {
                          if (!open) closeSetup()
                        }}
                        finalFocus={finalFocus}
                        service={service}
                        kindLocked={service?.hasTargets === true}
                        busy={disabled}
                        error={error}
                        onSubmit={(input) =>
                          run(
                            { kind: 'service', environmentId, serviceId: service?.id, nextStep: 2 },
                            (id) => saveDeploymentService(projectId, { ...input, requestId: id }),
                          )
                        }
                      />
                    ) : service ? (
                      <div className="space-y-3 p-4">
                        <p>
                          {service.name} · {service.kind === 'java' ? 'Java / Maven' : '静态站点'}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          共享服务信息由项目管理员维护。构建目录：{service.module || '.'}
                        </p>
                        <Button onClick={() => setup(2)}>下一步：当前环境源码</Button>
                      </div>
                    ) : (
                      <p className="p-4 text-sm text-muted-foreground">
                        {manage
                          ? '正在读取共享服务信息…'
                          : '新建共享服务由项目管理员维护，请选择已有服务。'}
                      </p>
                    )}
                  </>
                ) : step === 2 && service ? (
                  <ServiceSourceDialog
                    key={`source:${environmentId}:${service.id}`}
                    open
                    embedded
                    onDirty={setDirty}
                    onOpenChange={(open) => {
                      if (!open) closeSetup()
                    }}
                    finalFocus={finalFocus}
                    projectId={projectId}
                    onAccessDenied={revokeScope}
                    service={service}
                    environmentName={
                      environments.find((row) => row.id === environmentId)?.name ?? environmentId
                    }
                    sources={sources}
                    source={source}
                    busy={disabled || !!sourcesError}
                    error={error ?? sourcesError}
                    onSubmit={(input) =>
                      run(
                        { kind: 'source', environmentId, serviceId: service.id, nextStep: 3 },
                        (id) =>
                          saveDeploymentServiceSource(projectId, service.id, environmentId, {
                            ...input,
                            requestId: id,
                          }),
                      )
                    }
                  />
                ) : step === 3 && service ? (
                  <>
                    {!overview.servers.length ? (
                      <div className="space-y-3 p-4">
                        <p className="text-sm">当前环境没有已绑定的部署节点。</p>
                        {permits.nodeBind ? (
                          <Button variant="outline" onClick={() => setDialog('servers')}>
                            绑定部署节点
                          </Button>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            节点绑定由项目管理员维护。
                          </p>
                        )}
                      </div>
                    ) : (
                      <TargetDialog
                        key={`target:${service.id}:${target?.id ?? 'new'}`}
                        open
                        embedded
                        onDirty={setDirty}
                        onOpenChange={(open) => {
                          if (!open) closeSetup()
                        }}
                        finalFocus={finalFocus}
                        projectId={projectId}
                        onAccessDenied={revokeScope}
                        overview={overview}
                        service={service}
                        environmentId={environmentId}
                        target={target}
                        busy={disabled}
                        error={error}
                        onSubmit={(input) =>
                          run({ kind: 'target', environmentId, serviceId: service.id }, (id) =>
                            createDeploymentTarget(projectId, { ...input, requestId: id }),
                          )
                        }
                        onUpdate={(input) =>
                          target
                            ? run(
                                {
                                  kind: 'target',
                                  environmentId,
                                  serviceId: service.id,
                                  targetId: target.id,
                                },
                                (id) =>
                                  updateDeploymentTarget(projectId, target.id, {
                                    ...input,
                                    requestId: id,
                                  }),
                              )
                            : Promise.resolve()
                        }
                      />
                    )}
                  </>
                ) : (
                  <DeploymentEmpty
                    title="服务信息尚未读取"
                    description="请选择已有服务或完成第一步。"
                  />
                )}
              </>
            )}
          </div>
        </ScrollArea>
      ) : !service ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
          <DeploymentEmpty
            title={route.serviceId ? '服务不存在或无权访问' : '当前环境还没有服务'}
            description={
              configure
                ? '添加服务，配置源码和部署位置后即可发布。'
                : '服务配置由项目管理员或本环境发布运维维护。'
            }
          />
          {configure ? (
            <Button onClick={() => setup(1, 'new', 'new')}>
              <PlusIcon />
              添加服务
            </Button>
          ) : null}
        </div>
      ) : tab === 'config' ? (
        <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
          <div className="space-y-4 p-4">
            <section className="space-y-2 border-b pb-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">共享服务信息</h2>
                {manage ? (
                  <Button size="sm" variant="outline" disabled={disabled} onClick={() => setup(1)}>
                    编辑服务信息
                  </Button>
                ) : null}
              </div>
              <p className="text-sm">
                {service.name} · {service.kind === 'java' ? 'Java / Maven' : '静态站点'} ·{' '}
                {service.module || '.'}
              </p>
            </section>
            <section className="space-y-2 border-b pb-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">当前环境源码</h2>
                {configure ? (
                  <Button size="sm" variant="outline" disabled={disabled} onClick={() => setup(2)}>
                    编辑环境源码
                  </Button>
                ) : null}
              </div>
              {source ? (
                source.sources.map((row) => (
                  <p key={row.sourceId} className="break-all text-sm">
                    {sources.find((repo) => repo.id === row.sourceId)?.name ?? '仓库不可用'} ·{' '}
                    {row.ref || '默认分支'} · {row.mountPath}
                  </p>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">尚未配置发布来源。</p>
              )}
            </section>
            {target ? (
              <>
                {target.config.kind === 'static' ? (
                  <section className="space-y-2 border-b pb-4">
                    <h2 className="text-sm font-medium">Nginx 目录映射</h2>
                    <p className="text-sm">节点：{server?.name ?? '不可用'}</p>
                    <code className="block break-all text-xs">
                      {target.staticServingPath ??
                        `节点尚未报告静态根目录；目标子目录为 ${target.id}/current`}
                    </code>
                    <p className="text-xs text-muted-foreground">
                      由运维将已有 Nginx 映射到上述 Agent
                      发布目录；容器部署时核对宿主机卷映射。平台通过版本标记及站点响应验证本次发布。
                    </p>
                  </section>
                ) : null}
                <ConfigurationDetails
                  target={target}
                  editAction={
                    configure ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => setup(3)}
                      >
                        编辑部署配置
                      </Button>
                    ) : undefined
                  }
                />
                {target.currentRelease?.config ? (
                  <ConfigurationDetails
                    title="当前运行配置"
                    target={{ ...target, config: target.currentRelease.config }}
                  />
                ) : null}
              </>
            ) : (
              <div className="space-y-3">
                <p className="text-sm">尚未配置部署位置。</p>
                {configure ? (
                  <Button disabled={disabled || !source} onClick={() => setup(3)}>
                    继续配置部署位置
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </ScrollArea>
      ) : tab === 'history' && target ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b p-3">
            <Choice
              label="查看部署任务"
              value=""
              placeholder="查看发布、重启或失败任务的日志"
              options={tasks.map((row) => ({
                id: row.id,
                name: `${new Date(row.createdAt).toLocaleString('zh-CN')} · ${deploymentStatusLabel(row.status)}`,
              }))}
              onChange={(value) => change({ taskId: value, tab: 'publish' })}
            />
          </div>
          <DeploymentHistory
            projectId={projectId}
            target={target}
            releases={releases}
            error={releasesError}
            disabled={disabled || !permits.rollback || !online || !!activeTask}
            mutationDisabled={disabled || !permits.sourceClear}
            allowCurrentRelease={runtime?.state === 'uncertain'}
            onAccessDenied={revokeScope}
            onRollback={(release) => {
              setReleases((old) => [release, ...old.filter((row) => row.id !== release.id)])
              setRollbackId(release.id)
              setDialog('rollback')
            }}
          />
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {taskId && target ? (
            <>
              <DeploymentLogs
                key={taskId}
                projectId={projectId}
                targetId={target.id}
                taskId={taskId}
                taskPicker={
                  <Choice
                    label="部署任务"
                    value={taskId}
                    options={tasks.map((row) => ({
                      id: row.id,
                      name: `${new Date(row.createdAt).toLocaleString('zh-CN')} · ${deploymentStatusLabel(row.status)}`,
                    }))}
                    onChange={(value) => change({ taskId: value })}
                  />
                }
                refresh={refresh}
                onAccessDenied={revokeScope}
              />
            </>
          ) : (
            <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
              {!source || !target ? (
                <div className="space-y-3 p-4">
                  <p className="text-sm">
                    {!source ? '请先配置当前环境的发布源码。' : '请先配置部署位置。'}
                  </p>
                  {configure ? (
                    <Button onClick={() => setup(!source ? 2 : 3)}>继续配置</Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      请联系本环境发布运维或项目管理员。
                    </p>
                  )}
                </div>
              ) : (
                <>
                  {!online ? (
                    <p className="px-4 pt-3 text-sm text-destructive">
                      节点离线，恢复连接后可发布。
                    </p>
                  ) : !executorReady ? (
                    <p className="px-4 pt-3 text-sm text-destructive">
                      节点尚未上报所需部署能力，请由平台管理员升级 Agent。
                    </p>
                  ) : null}
                  {!permits.publish ? (
                    <p className="px-4 pt-3 text-sm text-muted-foreground">
                      当前环境为只读，不能执行发布。
                    </p>
                  ) : null}
                  {sourcesError ? (
                    <Alert variant="error">
                      <AlertDescription>{sourcesError}</AlertDescription>
                    </Alert>
                  ) : (
                    <DeploymentRevisionPicker
                      key={`${projectId}:${environmentId}:${service.id}:${source.configKey}`}
                      projectId={projectId}
                      queries={repositoryQueries}
                      source={source}
                      repositories={sources}
                      currentCommits={
                        target.currentRelease?.sourceIdentity?.repositories?.map(
                          (row) => row.commit,
                        ) ?? []
                      }
                      onAccessDenied={revokeScope}
                      disabled={publishDisabled}
                      onPublish={(candidate) =>
                        setConfirmation({
                          kind: 'publish',
                          target: structuredClone(target),
                          candidate,
                        })
                      }
                    />
                  )}
                </>
              )}
            </ScrollArea>
          )}
        </div>
      )}
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null)
        }}
      >
        <DialogPopup finalFocus={finalFocus}>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.kind === 'publish'
                ? '确认发布'
                : confirmation?.kind === 'delete-service'
                  ? '删除项目共享服务'
                  : confirmation?.kind === 'remove'
                    ? '移除此环境的服务配置'
                    : '删除当前部署位置'}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {confirmation?.kind === 'publish' ? (
              <div className="space-y-2 text-sm">
                <p>服务：{confirmation.target.name}</p>
                <p>环境：{environments.find((row) => row.id === environmentId)?.name}</p>
                <p>节点：{server?.name}</p>
                {confirmation.candidate.sourceRefs?.map((row) => (
                  <p key={row.sourceId} className="break-all">
                    {sources.find((repo) => repo.id === row.sourceId)?.name} ·{' '}
                    {row.ref || '完整提交'}
                    <br />
                    <code>{row.commit}</code>
                  </p>
                ))}
                <p>构建目录：{confirmation.target.config.module || '.'}</p>
                <p>产物：{confirmation.target.config.artifactPath}</p>
                <p>本次采用已保存的下次发布配置，健康检查通过后确认运行版本。</p>
                <details>
                  <summary className="cursor-pointer">查看本次采用的配置</summary>
                  <ConfigurationDetails title="本次固定配置" target={confirmation.target} />
                </details>
              </div>
            ) : (
              <p className="text-sm">
                {confirmation?.service.name}：
                {confirmation?.kind === 'delete-service'
                  ? '将删除项目所有环境下该服务的配置、任务和版本记录。'
                  : confirmation?.kind === 'remove'
                    ? '将删除当前环境下该服务的源码配置、部署位置、任务及版本记录；共享服务和其他环境保留。'
                    : '将删除此部署位置及其任务和版本记录。'}
                独立节点和远端已运行程序保留，删除管理记录不会卸载程序。
              </p>
            )}
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
              取消
            </Button>
            <Button
              variant={confirmation?.kind === 'publish' ? 'default' : 'destructive'}
              disabled={disabled || !confirmation}
              onClick={() => {
                if (!confirmation) return
                const current = confirmation
                if (current.kind === 'publish')
                  void run(
                    {
                      kind: 'task',
                      environmentId,
                      serviceId: current.target.serviceId,
                      targetId: current.target.id,
                    },
                    (id) =>
                      submitDeployment(projectId, {
                        ...current.candidate,
                        targetId: current.target.id,
                        action: 'deploy',
                        service: current.target.config.kind === 'java' ? 'backend' : 'frontend',
                        configKey: current.target.configKey,
                        requestId: id,
                      }),
                  )
                else if (current.kind === 'remove')
                  void run({ kind: 'remove', environmentId, serviceId: current.service.id }, (id) =>
                    removeEnvironmentDeploymentService(
                      projectId,
                      environmentId,
                      current.service.id,
                      { configKey: current.configKey, requestId: id },
                    ),
                  )
                else
                  void run(
                    {
                      kind: 'delete',
                      environmentId,
                      serviceId: current.service.id,
                      targetId: current.target?.id,
                    },
                    (id) =>
                      removeDeploymentConfiguration(
                        projectId,
                        current.kind === 'delete-service' ? 'service' : 'target',
                        current.kind === 'delete-service' ? current.service.id : current.target!.id,
                        {
                          configKey: current.configKey,
                          requestId: id,
                          ...(current.kind === 'delete-target' ? { environmentId } : {}),
                        },
                      ),
                  )
              }}
            >
              {busy ? <Spinner size="sm" /> : null}
              {confirmation?.kind === 'publish' ? '确认发布' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {target ? (
        <ReleaseDialog
          key={`${dialog}:${target.id}:${rollbackId}`}
          projectId={projectId}
          open={dialog === 'package' || dialog === 'restart' || dialog === 'rollback'}
          onOpenChange={(open) => {
            if (!open && !busy) setDialog(null)
          }}
          finalFocus={finalFocus}
          target={target}
          serverName={server?.name ?? '节点不可用'}
          environmentName={
            environments.find((row) => row.id === environmentId)?.name ?? environmentId
          }
          packages={packages}
          sources={[]}
          releases={releases}
          rollbackId={rollbackId}
          action={dialog === 'restart' ? 'restart' : dialog === 'rollback' ? 'rollback' : 'deploy'}
          allowCurrentRelease={runtime?.state === 'uncertain'}
          busy={disabled}
          error={error}
          onSubmit={(input) =>
            run(
              { kind: 'task', environmentId, serviceId: target.serviceId, targetId: target.id },
              (id) => submitDeployment(projectId, { ...input, requestId: id }),
            )
          }
        />
      ) : null}
      <DeploymentServers
        projectId={projectId}
        environmentId={environmentId}
        open={dialog === 'servers'}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
        finalFocus={finalFocus}
        onChanged={reload}
        onAccessDenied={revokeScope}
        onManageNodes={(serverId) =>
          void navigate({
            href: nodePageHref({
              from: 'deployments',
              projectId,
              environmentId,
              ...(serverId
                ? { nodeId: serverId, nodeView: 'details', nodeSection: 'storage' }
                : {}),
            }),
          })
        }
      />
    </div>
  )
}
