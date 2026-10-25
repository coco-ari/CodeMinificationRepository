import {
  ModuleHeader,
  ModuleSidebar,
  ModuleSidebarItem,
  ModuleSidebarEmpty,
} from './ModuleWorkspace'
import { DeploymentSourceDetails } from './deployment'
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
  RotateCcwIcon,
  ServerIcon,
  SettingsIcon,
} from 'lucide-react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '~/components/ui/menu'
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '~/components/ui/popover'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Spinner } from '~/components/ui/spinner'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import { FileSurfaceAction } from '~/components/files/fileSurfaceChrome'
import { randomUUID } from '~/lib/utils'
import { readAutoOpsHost } from './hostConfig'
import type { WorkspaceRelease } from './workspaces'
import {
  createDeploymentTarget,
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
} from './deployments'
import {
  DeploymentLogs,
  TargetDialog,
  ReleaseDialog,
  ConfigurationDetails,
  Choice,
  DeploymentEmpty,
  dateLabel,
  errorLabel,
  packageDirectory,
  deriveDeploymentRuntimeStatus,
} from './deployment'

type PendingSubmission =
  | { kind: 'task'; input: DeploymentSubmission }
  | { kind: 'target'; input: DeploymentTargetSubmission }
type Selection = { environmentId: string; targetId: string; taskId: string }
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
    targetId: stored?.targetId ?? '',
    taskId: stored?.taskId ?? '',
  }
}

/** 只协调服务选择与幂等提交；日志、表单和配置各自拥有独立展示职责。 */
export function DeploymentsPanel({
  projectId,
  packages,
  navigation,
  packageActions,
  onRefreshPackages,
}: {
  projectId: string
  packages: WorkspaceRelease[]
  navigation: ReactNode
  packageActions: PackageActions | null
  onRefreshPackages: () => void
}) {
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
  const [dialog, setDialog] = useState<'target' | 'deploy' | 'rollback' | null>(null)
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
  const frontendPackages = packages.filter((entry) =>
    entry.services.some((item) => item.service === 'frontend'),
  )
  const environments = projectEnvironments(projectId)
  const environmentId = overview?.environments.some((entry) => entry.id === selection.environmentId)
    ? selection.environmentId
    : (overview?.environments[0]?.id ?? selection.environmentId)
  const targets =
    overview?.targets.filter(
      (target) => !environmentId || target.environmentId === environmentId,
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
  const staticReady = online && !!server?.capabilities?.includes('static-site-v1')
  const releaseDisabled =
    accessDenied || !canExecute || busy || !!pending || !!activeTask || !staticReady
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
        targetId: target?.id ?? '',
        taskId,
      })
    } catch {
      /* 浏览器存储不可用时仍允许阅读。 */
    }
  }, [projectId, overview, environmentId, target?.id, taskId])

  useEffect(() => {
    if (!target || accessDenied) {
      setReleases([])
      return
    }
    const controller = new AbortController()
    setReleases([])
    setReleasesError(null)
    void loadDeploymentReleases(projectId, target.id, controller.signal)
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
    setSelection({ environmentId: value, targetId: '', taskId: '' })
    setOverview(null)
  }
  const openDialog = (value: 'target' | 'deploy' | 'rollback', releaseId = '') => {
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
        setSelection({ environmentId, targetId: result.task.targetId, taskId: result.task.id })
        setDetailTab('logs')
      } else {
        const result = await createDeploymentTarget(projectId, submission.input)
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
            aria-label="添加前端服务"
            disabled={
              accessDenied ||
              !canExecute ||
              !overview?.enabled ||
              busy ||
              !!pending ||
              !overview.servers.length
            }
            onClick={() => openDialog('target')}
          >
            <PlusIcon />
          </Button>
        }
        header={
          <>
            {navigation}
            <div className="pt-2">
              <Choice
                label="部署环境"
                value={environmentId}
                options={environments.length ? environments : (overview?.environments ?? [])}
                onChange={chooseEnvironment}
                disabled={accessDenied || busy || !!pending}
                placeholder="读取环境…"
              />
            </div>
          </>
        }
      >
        <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
          <div className="px-[var(--sidebar-content-inset)]">
            {targets
              .filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
              .map((item) => {
                const itemServer = overview?.servers.find((entry) => entry.id === item.serverId)
                const task = overview?.tasks.find((entry) => entry.targetId === item.id)
                return (
                  <ModuleSidebarItem
                    key={item.id}
                    label={item.name}
                    icon={ServerIcon}
                    selected={item.id === target?.id}
                    description={`${itemServer?.name ?? '服务器不可用'} · ${!itemServer?.online ? '离线' : task ? deploymentStatusLabel(task.status) : item.currentRelease ? '已发布' : '未发布'}`}
                    onClick={() => {
                      setSelection({ environmentId, targetId: item.id, taskId: '' })
                    }}
                  />
                )
              })}
            {!targets.length ? (
              <ModuleSidebarEmpty>
                {accessDenied
                  ? '部署访问已停止，请重新加载核对权限。'
                  : overview
                    ? '当前环境还没有服务。'
                    : '正在读取服务…'}
              </ModuleSidebarEmpty>
            ) : null}
            {targets.length > 0 &&
            !targets.some((item) =>
              item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            ) ? (
              <ModuleSidebarEmpty>没有匹配的服务。</ModuleSidebarEmpty>
            ) : null}
          </div>
        </ScrollArea>
      </ModuleSidebar>
      <ModuleHeader
        title="部署发布"
        detail={target?.name}
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
            <Button
              size="sm"
              disabled={releaseDisabled || !frontendPackages.length || !target}
              onClick={() => openDialog('deploy')}
            >
              <RocketIcon />
              发布
            </Button>
          </>
        }
      />
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
      ) : !overview.servers.length ? (
        <DeploymentEmpty
          title="还没有可用的部署服务器"
          description="请先为该项目和环境接入部署服务器，再添加前端服务。源码包可以继续生成和下载。"
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <section
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            aria-label="部署详情"
          >
            {target ? (
              <>
                {!frontendPackages.length ? (
                  <p className="shrink-0 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    还没有前端源码包，请在“源码包”中选择 Git 来源生成。
                  </p>
                ) : !online ? (
                  <p className="shrink-0 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    部署服务器离线，恢复连接后可发布。
                  </p>
                ) : !staticReady ? (
                  <p className="shrink-0 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    该服务器尚未上报静态站点部署能力，请先完成部署执行器升级。
                  </p>
                ) : null}
                <div
                  className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-3 py-2"
                  data-deployment-toolbar=""
                >
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
                      <PopoverTrigger render={<Button size="sm" variant="ghost" />}>
                        <InfoIcon />
                        运行信息
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
                    <p className="basis-full text-xs text-muted-foreground">
                      {runtimeStatus.message}
                    </p>
                  ) : null}
                </div>
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
                                name: `${dateLabel(task.createdAt)} · ${task.action === 'rollback' ? '回退' : '发布'} · ${deploymentStatusLabel(task.status)}`,
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
                        description="选择已有的前端源码包发布后，可在这里查看真实执行日志。"
                      />
                    )}
                  </>
                ) : detailTab === 'history' ? (
                  <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
                    {releasesError ? (
                      <p className="p-3 text-sm text-destructive" role="alert">
                        {releasesError}
                      </p>
                    ) : releases.length ? (
                      <div className="divide-y divide-border/60">
                        {releases.map((release) => (
                          <div
                            key={release.id}
                            className="flex min-w-0 items-center gap-3 px-3 py-3"
                            onClickCapture={captureTrigger}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex min-w-0 items-center gap-2 text-sm">
                                <span className="truncate font-mono">
                                  {release.revision?.slice(0, 12) ?? release.id.slice(0, 8)}
                                </span>
                                {release.current ? (
                                  <Badge size="sm" variant="secondary">
                                    上次确认
                                  </Badge>
                                ) : null}
                              </span>
                              <time className="mt-0.5 block text-xs text-muted-foreground">
                                {dateLabel(release.createdAt)}
                              </time>
                              {release.available === false ? (
                                <span className="block text-xs text-muted-foreground">
                                  该版本目前不可恢复
                                </span>
                              ) : null}
                              {release.available !== false &&
                              release.archiveStatus &&
                              release.archiveStatus !== 'available' ? (
                                <span className="block text-xs text-muted-foreground">
                                  中心源码档案不可用；回退需目标服务器仍保留本机版本。
                                </span>
                              ) : null}
                            </span>
                            {release.sourceIdentity ? (
                              <DeploymentSourceDetails source={release.sourceIdentity} />
                            ) : null}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                releaseDisabled ||
                                (release.current && runtimeStatus?.state !== 'uncertain') ||
                                release.available === false
                              }
                              onClick={() => openDialog('rollback', release.id)}
                            >
                              <RotateCcwIcon />
                              回退
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <DeploymentEmpty
                        title="还没有发布记录"
                        description="成功部署后，记录会绑定源码包和历史配置，可按版本回退。"
                      />
                    )}
                  </ScrollArea>
                ) : (
                  <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
                    <ConfigurationDetails target={target} />
                  </ScrollArea>
                )}
              </>
            ) : (
              <DeploymentEmpty
                title="选择前端服务"
                description="查看发布版本、执行日志和部署配置。"
              />
            )}
          </section>
        </div>
      )}
      {overview ? (
        <TargetDialog
          key={`target:${dialog === 'target'}`}
          open={dialog === 'target'}
          onOpenChange={(open) => {
            if (!open && !busy) setDialog(null)
          }}
          finalFocus={finalFocus}
          overview={overview}
          environmentId={environmentId}
          defaultDirectory={
            frontendPackages[0] ? packageDirectory(frontendPackages[0]) : 'frontend'
          }
          busy={busy || !!pending || !canExecute}
          error={error}
          onSubmit={(input) =>
            perform({ kind: 'target', input: { ...input, requestId: randomUUID() } })
          }
        />
      ) : null}
      {target ? (
        <ReleaseDialog
          key={`${dialog}:${target.id}:${rollbackId}`}
          projectId={projectId}
          open={dialog === 'deploy' || dialog === 'rollback'}
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
          packages={frontendPackages}
          releases={releases}
          rollbackId={rollbackId}
          allowCurrentRelease={runtimeStatus?.state === 'uncertain'}
          action={dialog === 'rollback' ? 'rollback' : 'deploy'}
          busy={busy || !!pending || !canExecute}
          error={error}
          onSubmit={(input) =>
            perform({ kind: 'task', input: { ...input, requestId: randomUUID() } })
          }
        />
      ) : null}
    </div>
  )
}
