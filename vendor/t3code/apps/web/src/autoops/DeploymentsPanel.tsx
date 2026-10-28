import {
  ModuleHeader,
  ModuleSidebar,
  ModuleSidebarItem,
  ModuleSidebarEmpty,
} from './ModuleWorkspace'
import { DeploymentSourceDetails, DeploymentReleaseIdentity, RepositorySetupNotice } from './deployment'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  FileTextIcon,
  HistoryIcon,
  InfoIcon,
  MoreHorizontalIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  RocketIcon,
  ServerIcon,
  SettingsIcon,
} from 'lucide-react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '~/components/ui/menu'
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '~/components/ui/popover'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Spinner } from '~/components/ui/spinner'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import { FileSurfaceAction } from '~/components/files/fileSurfaceChrome'
import { useMediaQuery } from '~/hooks/useMediaQuery'
import { randomUUID } from '~/lib/utils'
import { readAutoOpsHost } from './hostConfig'
import type { WorkspaceRelease } from './workspaces'
import type { ProjectRepositoryConnection } from './workspaceAuthoring'
import {
  createDeploymentTarget,
  saveDeploymentService,
  saveDeploymentServiceSource,
  updateDeploymentTarget,
  deploymentStatusLabel,
  deploymentTaskFinished,
  DeploymentRequestError,
  isDeploymentAccessError,
  loadDeploymentReleases,
  loadDeployments,
  submitDeployment,
  type DeploymentOverview,
  type DeploymentRelease,
  type DeploymentSubmission,
  type DeploymentTargetSubmission,
  type DeploymentServiceSubmission,
  type DeploymentServiceSourceSubmission,
  type DeploymentTargetUpdate,
} from './deployments'
import {
  DeploymentLogs,
  DeploymentHistory,
  DeploymentServers,
  TargetDialog,
  ServiceDialog,
  ServiceSourceDialog,
  ReleaseDialog,
  ConfigurationDetails,
  Choice,
  DeploymentEmpty,
  dateLabel,
  errorLabel,
  deriveDeploymentRuntimeStatus,
  deploymentObservationLabel,
} from './deployment'

type PendingSubmission =
  | {
      kind: 'task'
      input: DeploymentSubmission
      scope?: { environmentId: string; serviceId: string }
    }
  | { kind: 'target'; input: DeploymentTargetSubmission }
  | { kind: 'target-update'; targetId: string; input: DeploymentTargetUpdate }
  | { kind: 'service'; input: DeploymentServiceSubmission }
  | {
      kind: 'source'
      serviceId: string
      environmentId: string
      input: DeploymentServiceSourceSubmission
    }
type Selection = { serviceId?: string; environmentId: string; targetId: string; taskId: string }
type DetailTab = 'logs' | 'history' | 'config'
type PackageActions = {
  generateDisabled: boolean
  tasksDisabled: boolean
  tasksLabel: string
  tasksActive: boolean
  onGenerate: (trigger: HTMLElement | null) => void
  onTasks: (trigger: HTMLElement | null) => void
}

const storageKey = (projectId: string, suffix: string) =>
  `autoops:deployments:${readAutoOpsHost()?.principal.id ?? ''}:${projectId}:${suffix}`
function readStored<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}
function saveStored(key: string, value: unknown) {
  if (value === null) sessionStorage.removeItem(key)
  else sessionStorage.setItem(key, JSON.stringify(value))
}
function projectEnvironments(projectId: string) {
  const project = readAutoOpsHost()?.projects.find((entry) => entry.id === projectId)
  return (
    project?.environments.filter(
      (entry) => !project.membership || project.membership.environmentIds.includes(entry.id),
    ) ?? []
  )
}
function initialSelection(projectId: string): Selection {
  const stored = readStored<Selection>(storageKey(projectId, 'selection'))
  const environments = projectEnvironments(projectId)
  return {
    environmentId: environments.some((entry) => entry.id === stored?.environmentId)
      ? stored!.environmentId
      : (environments[0]?.id ?? ''),
    serviceId: stored?.serviceId ?? '',
    targetId: stored?.targetId ?? '',
    taskId: stored?.taskId ?? '',
  }
}

/** 只协调服务选择与幂等提交；日志、表单和配置各自拥有独立展示职责。 */
export function DeploymentsPanel({
  projectId,
  packages,
  sources,
  sourcesError,
  navigation,
  packageActions,
  onRefreshPackages,
}: {
  projectId: string
  packages: WorkspaceRelease[]
  sources: ProjectRepositoryConnection[]
  sourcesError: string | null
  navigation: ReactNode
  packageActions: PackageActions | null
  onRefreshPackages: () => void
}) {
  const wideToolbar = useMediaQuery('sm')
  const canExecute =
    readAutoOpsHost()?.projects.find((project) => project.id === projectId)?.capabilities?.[
      'deployment.execute'
    ] === true
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<Selection>(() => initialSelection(projectId))
  const [pending, setPending] = useState<PendingSubmission | null>(() =>
    readStored<PendingSubmission>(storageKey(projectId, 'pending')),
  )
  const [overview, setOverview] = useState<DeploymentOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [accessDenied, setAccessDenied] = useState(false)
  const accessDeniedRef = useRef(false)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>('logs')
  const [dialog, setDialog] = useState<
    | 'service'
    | 'service-edit'
    | 'source'
    | 'servers'
    | 'target'
    | 'target-edit'
    | 'deploy'
    | 'rollback'
    | 'restart'
    | null
  >(null)
  const [releases, setReleases] = useState<DeploymentRelease[]>([])
  const [releasesError, setReleasesError] = useState<string | null>(null)
  const [rollbackId, setRollbackId] = useState('')
  const submitGuard = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const moreTrigger = useRef<HTMLButtonElement | null>(null)
  const revokeAccess = useCallback((cause: unknown) => {
    // 撤权立即清除展示数据；原始提交收据保留，恢复权限后仍使用同一请求标识核对。
    accessDeniedRef.current = true
    setAccessDenied(true)
    setOverview(null)
    setReleases([])
    setReleasesError(null)
    setDialog(null)
    setError(null)
    setLoadError(errorLabel(cause))
  }, [])
  const reload = () => {
    accessDeniedRef.current = false
    setAccessDenied(false)
    setRefresh((value) => value + 1)
  }
  const environments = projectEnvironments(projectId)
  const environmentId = overview?.environments.some((entry) => entry.id === selection.environmentId)
    ? selection.environmentId
    : (overview?.environments[0]?.id ?? selection.environmentId)
  const services = overview?.services ?? []
  const selectedTarget = overview?.targets.find((entry) => entry.id === selection.targetId)
  const service =
    services.find((entry) => entry.id === (selection.serviceId || selectedTarget?.serviceId)) ??
    services[0]
  const defaultSource = overview?.serviceSources?.find(
    (entry) => entry.serviceId === service?.id && entry.environmentId === environmentId,
  )
  const packageService = service?.kind === 'java' ? 'backend' : 'frontend'
  const servicePackages = packages.filter((entry) =>
    entry.services.some((item) => item.service === packageService),
  )
  const targets =
    overview?.targets.filter(
      (entry) => entry.serviceId === service?.id && entry.environmentId === environmentId,
    ) ?? []
  const target = targets.find((entry) => entry.id === selection.targetId) ?? targets[0]
  const targetTasks = overview?.tasks.filter((task) => task.targetId === target?.id) ?? []
  const taskId =
    selection.targetId === target?.id && selection.taskId
      ? selection.taskId
      : (targetTasks[0]?.id ?? '')
  const activeTask = targetTasks.find((task) => !deploymentTaskFinished(task))
  const runtimeStatus = target ? deriveDeploymentRuntimeStatus(target, targetTasks) : null
  const server = overview?.servers.find((entry) => entry.id === target?.serverId)
  const online = !!server?.online && !server.revoked
  const executorReady =
    online && (target?.config.kind === 'java' || !!server?.capabilities?.includes('static-site-v1'))
  const releaseDisabled =
    accessDenied || !canExecute || busy || !!pending || !!activeTask || !executorReady
  const running = overview?.tasks.some((task) => !deploymentTaskFinished(task)) ?? false

  useEffect(() => {
    if (accessDenied) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await loadDeployments(
          projectId,
          selection.environmentId || undefined,
          controller.signal,
        )
        if (controller.signal.aborted || accessDeniedRef.current) return
        setOverview(next)
        setLoadError(null)
      } catch (cause) {
        if (controller.signal.aborted || accessDeniedRef.current) return
        if (isDeploymentAccessError(cause)) {
          revokeAccess(cause)
          return
        }
        setLoadError(errorLabel(cause))
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, running ? 1200 : 5000)
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [projectId, selection.environmentId, refresh, running, accessDenied, revokeAccess])

  useEffect(() => {
    if (!overview) return
    try {
      saveStored(storageKey(projectId, 'selection'), {
        environmentId,
        serviceId: service?.id ?? '',
        targetId: target?.id ?? '',
        taskId,
      })
    } catch {
      /* 浏览器存储不可用时仍允许阅读。 */
    }
  }, [projectId, overview, environmentId, service?.id, target?.id, taskId])

  useEffect(() => {
    if (!target || accessDenied) {
      setReleases([])
      return
    }
    const controller = new AbortController()
    setReleases([])
    setReleasesError(null)
    void loadDeploymentReleases(projectId, target.id, controller.signal, { offset: 0, limit: 20 })
      .then((result) => {
        if (!controller.signal.aborted && !accessDeniedRef.current) setReleases(result.releases)
      })
      .catch((cause) => {
        if (controller.signal.aborted || accessDeniedRef.current) return
        if (isDeploymentAccessError(cause)) revokeAccess(cause)
        else setReleasesError(errorLabel(cause))
      })
    return () => controller.abort()
  }, [projectId, target?.id, target?.currentRelease?.id, refresh, accessDenied, revokeAccess])

  const chooseEnvironment = (value: string) => {
    setSelection({ environmentId: value, serviceId: service?.id ?? '', targetId: '', taskId: '' })
    setOverview(null)
  }
  const openDialog = (value: NonNullable<typeof dialog>, releaseId = '') => {
    if (accessDeniedRef.current) return
    setError(null)
    setRollbackId(releaseId)
    setDialog(value)
  }
  const perform = async (submission: PendingSubmission) => {
    if (accessDeniedRef.current || !overview || !canExecute || submitGuard.current) return
    submitGuard.current = true
    setBusy(true)
    setError(null)
    // 先保存准确请求再发送；结果未知时必须继续使用原请求标识。
    try {
      saveStored(storageKey(projectId, 'pending'), submission)
    } catch {
      setError('无法保存本次请求的恢复信息，请允许浏览器存储后重试。')
      submitGuard.current = false
      setBusy(false)
      return
    }
    setPending(submission)
    try {
      if (submission.kind === 'task') {
        const result = await submitDeployment(projectId, submission.input)
        if (accessDeniedRef.current) return
        setOverview((previous) =>
          previous
            ? {
                ...previous,
                tasks: [
                  result.task,
                  ...previous.tasks.filter((entry) => entry.id !== result.task.id),
                ],
              }
            : previous,
        )
        const acceptedTarget = overview.targets.find((entry) => entry.id === result.task.targetId)
        setSelection({
          environmentId:
            result.task.environmentId ??
            acceptedTarget?.environmentId ??
            submission.scope?.environmentId ??
            environmentId,
          serviceId: acceptedTarget?.serviceId ?? submission.scope?.serviceId ?? '',
          targetId: result.task.targetId,
          taskId: result.task.id,
        })
        setDetailTab('logs')
      } else if (submission.kind === 'source') {
        const result = await saveDeploymentServiceSource(
          projectId,
          submission.serviceId,
          submission.environmentId,
          submission.input,
        )
        if (accessDeniedRef.current) return
        setOverview((previous) =>
          previous
            ? {
                ...previous,
                serviceSources: [
                  result.source,
                  ...(previous.serviceSources ?? []).filter(
                    (entry) =>
                      entry.serviceId !== result.source.serviceId ||
                      entry.environmentId !== result.source.environmentId,
                  ),
                ],
              }
            : previous,
        )
      } else if (submission.kind === 'service') {
        const result = await saveDeploymentService(projectId, submission.input)
        if (accessDeniedRef.current) return
        setOverview((previous) =>
          previous
            ? {
                ...previous,
                services: [
                  result.service,
                  ...previous.services.filter((entry) => entry.id !== result.service.id),
                ],
              }
            : previous,
        )
        setSelection({ environmentId, serviceId: result.service.id, targetId: '', taskId: '' })
        setDetailTab('config')
      } else {
        const result =
          submission.kind === 'target-update'
            ? await updateDeploymentTarget(projectId, submission.targetId, submission.input)
            : await createDeploymentTarget(projectId, submission.input)
        if (accessDeniedRef.current) return
        setOverview((previous) =>
          previous
            ? {
                ...previous,
                targets: [
                  result.target,
                  ...previous.targets.filter((entry) => entry.id !== result.target.id),
                ],
              }
            : previous,
        )
        setSelection({
          environmentId: result.target.environmentId,
          serviceId: result.target.serviceId,
          targetId: result.target.id,
          taskId: '',
        })

        setDetailTab('config')
      }
      setPending(null)
      try {
        saveStored(storageKey(projectId, 'pending'), null)
      } catch {
        /* 已接受的请求沿用原标识，重新核对仍保持幂等。 */
      }
      setDialog(null)
      setRefresh((value) => value + 1)
    } catch (cause) {
      if (isDeploymentAccessError(cause)) {
        revokeAccess(cause)
        return
      }
      if (accessDeniedRef.current) return
      if (cause instanceof DeploymentRequestError && !cause.uncertain) {
        setPending(null)
        try {
          saveStored(storageKey(projectId, 'pending'), null)
        } catch {
          /* 服务端明确拒绝了此次请求。 */
        }
      } else setDialog(null)
      setError(errorLabel(cause))
    } finally {
      submitGuard.current = false
      setBusy(false)
    }
  }
  const captureTrigger = (event: React.MouseEvent<HTMLElement>) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null
    // Portal 中的取消和关闭点击不能覆盖弹窗打开前的页面触发器。
    if (button && event.currentTarget.contains(button)) returnFocus.current = button
  }
  const finalFocus = () => returnFocus.current

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      aria-label="服务发布"
      onClickCapture={captureTrigger}
    >
      <ModuleSidebar
        label="部署服务"
        search={{ value: query, onChange: setQuery, label: '搜索服务' }}
        actions={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="添加服务"
            disabled={accessDenied || !canExecute || !overview?.enabled || busy || !!pending}
            onClick={() => openDialog('service')}
          >
            <PlusIcon />
          </Button>
        }
        header={navigation}
      >
        <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
          <div className="px-[var(--sidebar-content-inset)]">
            {services
              .filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
              .map((item) => {
                const locations =
                  overview?.targets.filter(
                    (entry) => entry.serviceId === item.id && entry.environmentId === environmentId,
                  ) ?? []
                return (
                  <ModuleSidebarItem
                    key={item.id}
                    label={item.name}
                    icon={ServerIcon}
                    selected={item.id === service?.id}
                    description={`${item.kind === 'java' ? 'Java / Maven' : '静态站点'} · ${locations.length ? `${locations.length} 个部署位置` : '未配置部署位置'}`}
                    onClick={() =>
                      setSelection({ environmentId, serviceId: item.id, targetId: '', taskId: '' })
                    }
                  />
                )
              })}
            {!services.length ? (
              <ModuleSidebarEmpty>
                {accessDenied
                  ? '部署访问已停止，请重新加载核对权限。'
                  : overview
                    ? '还没有部署服务。'
                    : '正在读取服务…'}
              </ModuleSidebarEmpty>
            ) : null}
            {services.length > 0 &&
            !services.some((item) =>
              item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            ) ? (
              <ModuleSidebarEmpty>没有匹配的服务。</ModuleSidebarEmpty>
            ) : null}
          </div>
        </ScrollArea>
      </ModuleSidebar>
      <ModuleHeader
        title="部署发布"
        detail={service?.name}
        actions={
          <>
            <div className="hidden items-center gap-1 sm:flex">
              <FileSurfaceAction
                label="刷新部署状态"
                disabled={busy}
                onPress={() => {
                  reload()
                  onRefreshPackages()
                }}
              >
                <RefreshCwIcon />
              </FileSurfaceAction>
              <FileSurfaceAction
                label="管理部署节点"
                disabled={accessDenied || !overview?.enabled || busy}
                onPress={() => openDialog('servers')}
              >
                <ServerIcon />
              </FileSurfaceAction>
              {packageActions ? (
                <>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={packageActions.tasksLabel}
                    title={packageActions.tasksLabel}
                    disabled={packageActions.tasksDisabled}
                    onClick={(event) => packageActions.onTasks(event.currentTarget)}
                  >
                    {packageActions.tasksActive ? <Spinner size="sm" /> : <HistoryIcon />}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={packageActions.generateDisabled}
                    onClick={(event) => packageActions.onGenerate(event.currentTarget)}
                  >
                    <PackageIcon />
                    生成部署包
                  </Button>
                </>
              ) : null}
            </div>
            <div className="sm:hidden">
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      ref={moreTrigger}
                      size="icon-sm"
                      variant="ghost"
                      aria-label="部署更多操作"
                    />
                  }
                >
                  {packageActions?.tasksActive ? <Spinner size="sm" /> : <MoreHorizontalIcon />}
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    disabled={busy}
                    onClick={() => {
                      reload()
                      onRefreshPackages()
                    }}
                  >
                    <RefreshCwIcon />
                    刷新部署状态
                  </MenuItem>
                  <MenuItem
                    disabled={accessDenied || !overview?.enabled || busy}
                    onClick={() => openDialog('servers')}
                  >
                    <ServerIcon />
                    管理部署节点
                  </MenuItem>
                  {packageActions ? (
                    <>
                      <MenuItem
                        disabled={packageActions.tasksDisabled}
                        onClick={() => packageActions.onTasks(moreTrigger.current)}
                      >
                        {packageActions.tasksActive ? <Spinner size="sm" /> : <HistoryIcon />}
                        {packageActions.tasksLabel}
                      </MenuItem>
                      <MenuItem
                        disabled={packageActions.generateDisabled}
                        onClick={() => packageActions.onGenerate(moreTrigger.current)}
                      >
                        <PackageIcon />
                        生成部署包
                      </MenuItem>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            </div>
            {service ? (
              <Menu>
                <MenuTrigger
                  render={<Button size="icon-sm" variant="ghost" aria-label="服务操作" />}
                >
                  <MoreHorizontalIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    disabled={accessDenied || !canExecute || busy || !!pending}
                    onClick={() => openDialog('service-edit')}
                  >
                    <SettingsIcon />
                    编辑服务
                  </MenuItem>
                  <MenuItem
                    disabled={
                      accessDenied ||
                      !canExecute ||
                      busy ||
                      !!pending ||
                      !sources.length ||
                      !!sourcesError
                    }
                    onClick={() => openDialog('source')}
                  >
                    <PackageIcon />
                    默认发布来源
                  </MenuItem>
                  <MenuItem
                    disabled={
                      accessDenied ||
                      !canExecute ||
                      busy ||
                      !!pending ||
                      !overview?.servers.some(
                        (entry) => entry.environmentId === environmentId && !entry.revoked,
                      )
                    }
                    onClick={() => openDialog('target')}
                  >
                    <PlusIcon />
                    添加部署位置
                  </MenuItem>
                  {target?.config.kind === 'java' ? (
                    <MenuItem
                      disabled={releaseDisabled || !target.currentRelease}
                      onClick={() => openDialog('restart')}
                    >
                      <RefreshCwIcon />
                      重启服务
                    </MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            ) : null}
            <Button
              size="sm"
              disabled={releaseDisabled || (!servicePackages.length && !sources.length) || !target}
              onClick={() => openDialog('deploy')}
            >
              <RocketIcon />
              发布
            </Button>
          </>
        }
      />
      <div
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-3 py-2"
        data-deployment-toolbar=""
      >
        <div className="flex min-w-0 basis-80 grow items-center gap-2 sm:basis-auto sm:grow-0">
          <div className="min-w-0 flex-1 space-y-1 sm:w-52 sm:flex-none">
            <span className="block text-xs text-muted-foreground">部署环境</span>
            <Choice
              label="部署环境"
              value={environmentId}
              options={environments.length ? environments : (overview?.environments ?? [])}
              onChange={chooseEnvironment}
              disabled={accessDenied || busy || !!pending}
              placeholder="读取环境…"
            />
          </div>
          {target && overview ? (
            <div className="min-w-0 flex-1 space-y-1 sm:w-52 sm:flex-none">
              <span className="block text-xs text-muted-foreground">部署位置</span>
              <Choice
                label="部署位置"
                value={target.id}
                options={targets.map((entry) => ({
                  id: entry.id,
                  name:
                    overview.servers.find((node) => node.id === entry.serverId)?.name ?? entry.name,
                }))}
                onChange={(value) =>
                  setSelection({
                    environmentId,
                    serviceId: service?.id ?? '',
                    targetId: value,
                    taskId: '',
                  })
                }
                disabled={busy || !!pending}
              />
            </div>
          ) : null}
        </div>
        {target && overview ? (
          <>
            <ToggleGroup
              aria-label="部署详情分类"
              variant="segmented"
              value={[detailTab]}
              onValueChange={(value) => {
                if (value[0] === 'logs' || value[0] === 'history' || value[0] === 'config')
                  setDetailTab(value[0])
              }}
            >
              <Toggle value="logs">
                <FileTextIcon />
                任务日志
              </Toggle>
              <Toggle value="history">
                <HistoryIcon />
                发布记录
              </Toggle>
              <Toggle value="config">
                <SettingsIcon />
                配置
              </Toggle>
            </ToggleGroup>
            <div className="ml-auto shrink-0">
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      size={wideToolbar ? 'sm' : 'icon-sm'}
                      variant="ghost"
                      aria-label="运行信息"
                      title="运行信息"
                    />
                  }
                >
                  <InfoIcon />
                  {wideToolbar ? '运行信息' : null}
                </PopoverTrigger>
                <PopoverPopup width="md" padding="compact" align="end" touchBackdrop>
                  <div className="space-y-3" aria-label="部署运行记录">
                    <PopoverTitle>运行信息</PopoverTitle>
                    <dl className="space-y-3 text-sm">
                      <div>
                        <dt className="text-xs text-muted-foreground">部署服务器</dt>
                        <dd className="break-words">{server?.name ?? '服务器不可用'}</dd>
                        <dd className="text-xs text-muted-foreground">
                          执行器{online ? '在线' : '离线'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">最近观测</dt>
                        <dd className="break-words">{deploymentObservationLabel(target)}</dd>
                        <dd className="text-xs text-muted-foreground">
                          {target.lastObservedAt
                            ? `观测时间：${dateLabel(target.lastObservedAt)}`
                            : '尚无观测时间'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">上次确认版本</dt>
                        <dd className="break-all font-mono text-xs">
                          {runtimeStatus?.confirmedRelease?.revision ??
                            runtimeStatus?.confirmedRelease?.id ??
                            '尚无成功记录'}
                        </dd>
                      </div>
                    </dl>
                    {target.currentRelease?.sourceIdentity ? (
                      <DeploymentSourceDetails
                        source={target.currentRelease.sourceIdentity}
                        label="查看已确认版本来源"
                      />
                    ) : null}
                  </div>
                </PopoverPopup>
              </Popover>
            </div>
            {target.observation &&
            target.observationStale === false &&
            (target.observation.health === 'unhealthy' ||
              (target.currentRelease &&
                (target.observation.exists === false ||
                  target.observation.managed === false ||
                  ['exited', 'dead'].includes(target.observation.status)))) ? (
              <Alert variant="error" className="basis-full">
                <AlertDescription>{deploymentObservationLabel(target)}</AlertDescription>
              </Alert>
            ) : null}
            {runtimeStatus?.confirmedRelease ? (
              <div role="region" aria-label="已确认部署版本" className="flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="shrink-0 text-muted-foreground">上次确认版本</span>
                <DeploymentReleaseIdentity release={runtimeStatus.confirmedRelease} limit={1} />
                {runtimeStatus.confirmedRelease.sourceIdentity ? <DeploymentSourceDetails source={runtimeStatus.confirmedRelease.sourceIdentity} label="版本来源" /> : null}
              </div>
            ) : null}
            {runtimeStatus?.state === 'uncertain' ? (
              <Alert variant="warning" className="basis-full">
                <AlertTitle>运行状态待核对</AlertTitle>
                <AlertDescription>
                  <p>{runtimeStatus.message}</p>
                </AlertDescription>
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label="查看待核对任务"
                    onClick={() => {
                      setDetailTab('logs')
                      setSelection({
                        environmentId,
                        targetId: target.id,
                        taskId: runtimeStatus.attentionTaskId ?? '',
                      })
                    }}
                  >
                    查看任务
                  </Button>
                </AlertAction>
              </Alert>
            ) : runtimeStatus?.state === 'updating' ? (
              <p className="basis-full text-xs text-muted-foreground">{runtimeStatus.message}</p>
            ) : null}
          </>
        ) : null}
      </div>
      {overview && !accessDenied && !sourcesError && !sources.length && !packages.length ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2">
          <RepositorySetupNotice projectId={projectId} disabled={busy || !!pending} />
        </div>
      ) : null}
      {error || loadError || pending ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2">
          <Alert variant={pending ? 'warning' : 'error'}>
            <AlertTitle>{pending ? '有一项提交结果待核对' : '部署操作未完成'}</AlertTitle>
            <AlertDescription>
              <p>
                {error ??
                  loadError ??
                  '上次连接中断，不能确定服务器是否已接受。重试会沿用原请求，避免重复部署。'}
              </p>
              {pending ? (
                <Button
                  className="self-start"
                  size="sm"
                  variant="outline"
                  disabled={accessDenied || !overview || busy || !canExecute}
                  onClick={() => void perform(pending)}
                >
                  {busy ? <Spinner size="sm" /> : <RefreshCwIcon />}核对并重试原请求
                </Button>
              ) : (
                <Button className="self-start" size="xs" variant="outline" onClick={reload}>
                  重新加载
                </Button>
              )}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {!overview ? (
        loadError ? (
          <DeploymentEmpty
            title="部署服务暂不可用"
            description="重新加载可再次获取服务器和任务状态。"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" />
            正在读取部署服务…
          </div>
        )
      ) : !overview.enabled ? (
        <DeploymentEmpty
          title="部署服务尚未接入"
          description="接入部署服务后，可将固定源码包发布到测试环境。已有源码包仍可下载。"
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <section
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            aria-label="部署详情"
          >
            {target ? (
              <>
                {!servicePackages.length && !sources.length ? (
                  <p className="shrink-0 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    {service?.kind === 'java'
                      ? '还没有后端源码包，请在“源码包”中选择 Git 来源生成。'
                      : '还没有前端源码包，请在“源码包”中选择 Git 来源生成。'}
                  </p>
                ) : !online ? (
                  <p className="shrink-0 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    部署服务器离线，恢复连接后可发布。
                  </p>
                ) : !executorReady ? (
                  <p className="shrink-0 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    该服务器尚未上报静态站点部署能力，请先完成部署执行器升级。
                  </p>
                ) : null}
                {detailTab === 'logs' ? (
                  <>
                    {taskId ? (
                      <DeploymentLogs
                        key={taskId}
                        projectId={projectId}
                        targetId={target.id}
                        taskId={taskId}
                        taskPicker={
                          <div
                            className="min-w-0 max-w-full basis-72"
                            data-deployment-task-picker=""
                          >
                            <Choice
                              label="部署任务"
                              value={taskId}
                              options={targetTasks.map((task) => ({
                                id: task.id,
                                name: `${dateLabel(task.createdAt)} · ${task.action === 'rollback' ? '回退' : task.action === 'restart' ? '重启' : '发布'} · ${deploymentStatusLabel(task.status)}`,
                              }))}
                              placeholder="恢复所选任务…"
                              onChange={(value) =>
                                setSelection({ environmentId, targetId: target.id, taskId: value })
                              }
                            />
                          </div>
                        }
                        refresh={refresh}
                        onAccessDenied={revokeAccess}
                      />
                    ) : (
                      <DeploymentEmpty
                        title="还没有发布任务"
                        description="发布后，可在这里查看真实执行日志。"
                      />
                    )}
                  </>
                ) : detailTab === 'history' ? (
                  <DeploymentHistory
                    projectId={projectId}
                    target={target}
                    releases={releases}
                    error={releasesError}
                    disabled={releaseDisabled}
                    mutationDisabled={
                      accessDenied || !canExecute || busy || !!pending || !!activeTask
                    }
                    allowCurrentRelease={runtimeStatus?.state === 'uncertain'}
                    onAccessDenied={revokeAccess}
                    onRollback={(release) => {
                      setReleases((previous) => [
                        release,
                        ...previous.filter((entry) => entry.id !== release.id),
                      ])
                      openDialog('rollback', release.id)
                    }}
                  />
                ) : (
                  <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
                    <ConfigurationDetails
                      target={target}
                      editAction={
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            accessDenied || !canExecute || busy || !!pending || !!activeTask
                          }
                          onClick={() => openDialog('target-edit')}
                        >
                          <SettingsIcon />
                          编辑配置
                        </Button>
                      }
                    />
                  </ScrollArea>
                )}
              </>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4">
                <p className="text-sm text-muted-foreground">
                  {service ? '当前环境还没有部署位置。' : '添加服务后配置部署位置。'}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    accessDenied ||
                    !canExecute ||
                    busy ||
                    !!pending ||
                    (service
                      ? !overview.servers.some(
                          (entry) => entry.environmentId === environmentId && !entry.revoked,
                        )
                      : false)
                  }
                  onClick={() => openDialog(service ? 'target' : 'service')}
                >
                  <PlusIcon />
                  {service ? '添加部署位置' : '添加服务'}
                </Button>
                {service &&
                !overview.servers.some(
                  (entry) => entry.environmentId === environmentId && !entry.revoked,
                ) ? (
                  <p className="text-xs text-muted-foreground">请先接入当前环境的部署服务器。</p>
                ) : null}
              </div>
            )}
          </section>
        </div>
      )}
      <DeploymentServers
        projectId={projectId}
        environmentId={environmentId}
        open={dialog === 'servers'}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
        finalFocus={finalFocus}
        onAccessDenied={revokeAccess}
        onChanged={reload}
      />
      {overview ? (
        <ServiceDialog
          key={`service:${dialog}:${service?.id ?? ''}`}
          open={dialog === 'service' || dialog === 'service-edit'}
          onOpenChange={(open) => {
            if (!open && !busy) setDialog(null)
          }}
          finalFocus={finalFocus}
          service={dialog === 'service-edit' ? service : undefined}
          kindLocked={
            dialog === 'service-edit' &&
            overview.targets.some((entry) => entry.serviceId === service?.id)
          }
          busy={busy || !!pending || !canExecute}
          error={error}
          onSubmit={(input) =>
            perform({ kind: 'service', input: { ...input, requestId: randomUUID() } })
          }
        />
      ) : null}
      {service ? (
        <ServiceSourceDialog
          projectId={projectId}
          onAccessDenied={revokeAccess}
          key={`source:${dialog}:${service.id}:${environmentId}`}
          open={dialog === 'source'}
          onOpenChange={(open) => {
            if (!open && !busy) setDialog(null)
          }}
          finalFocus={finalFocus}
          service={service}
          sources={sources}
          source={defaultSource}
          environmentName={
            overview?.environments.find((entry) => entry.id === environmentId)?.name ??
            environmentId
          }
          busy={busy || !!pending || !canExecute}
          error={error ?? sourcesError}
          onSubmit={(input) =>
            perform({
              kind: 'source',
              serviceId: service.id,
              environmentId,
              input: { ...input, requestId: randomUUID() },
            })
          }
        />
      ) : null}
      {overview && service ? (
        <TargetDialog
          projectId={projectId}
          onAccessDenied={revokeAccess}
          key={`target:${dialog}:${service.id}:${target?.id ?? ''}`}
          open={dialog === 'target' || dialog === 'target-edit'}
          onOpenChange={(open) => {
            if (!open && !busy) setDialog(null)
          }}
          finalFocus={finalFocus}
          overview={overview}
          service={service}
          target={dialog === 'target-edit' ? target : undefined}
          environmentId={environmentId}
          busy={busy || !!pending || !canExecute}
          error={error}
          onSubmit={(input) =>
            perform({ kind: 'target', input: { ...input, requestId: randomUUID() } })
          }
          onUpdate={(input) =>
            target
              ? perform({
                  kind: 'target-update',
                  targetId: target.id,
                  input: { ...input, requestId: randomUUID() },
                })
              : Promise.resolve()
          }
        />
      ) : null}
      {target ? (
        <ReleaseDialog
          key={`${dialog}:${target.id}:${rollbackId}`}
          projectId={projectId}
          open={dialog === 'deploy' || dialog === 'rollback' || dialog === 'restart'}
          onOpenChange={(open) => {
            if (!open && !busy) setDialog(null)
          }}
          finalFocus={finalFocus}
          target={target}
          serverName={server?.name ?? '服务器不可用'}
          environmentName={
            overview?.environments.find((entry) => entry.id === environmentId)?.name ??
            environmentId
          }
          packages={servicePackages}
          sources={sources}
          defaultSource={defaultSource}
          sourcesError={sourcesError}
          onAccessDenied={revokeAccess}
          releases={releases}
          rollbackId={rollbackId}
          allowCurrentRelease={runtimeStatus?.state === 'uncertain'}
          action={dialog === 'rollback' ? 'rollback' : dialog === 'restart' ? 'restart' : 'deploy'}
          busy={busy || !!pending || !canExecute}
          error={error}
          onSubmit={(input) =>
            perform({
              kind: 'task',
              scope: { environmentId: target.environmentId, serviceId: target.serviceId },
              input: { ...input, requestId: randomUUID() },
            })
          }
        />
      ) : null}
    </div>
  )
}
