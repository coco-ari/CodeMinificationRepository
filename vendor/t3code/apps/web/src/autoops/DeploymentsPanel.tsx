import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  FileTextIcon,
  HistoryIcon,
  PlusIcon,
  RefreshCwIcon,
  RocketIcon,
  RotateCcwIcon,
  ServerIcon,
  SettingsIcon,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '~/components/ui/collapsible'
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '~/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '~/components/ui/menu'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Spinner } from '~/components/ui/spinner'
import { Textarea } from '~/components/ui/textarea'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
} from '~/components/files/fileSurfaceChrome'
import { randomUUID } from '~/lib/utils'
import { readAutoOpsHost } from './hostConfig'
import type { WorkspaceRelease } from './workspaces'
import {
  createDeploymentTarget,
  deploymentStageLabel,
  deploymentStatusLabel,
  deploymentTaskFinished,
  DeploymentRequestError,
  loadDeploymentReleases,
  loadDeployments,
  loadDeploymentTask,
  submitDeployment,
  type DeploymentLog,
  type DeploymentOverview,
  type DeploymentRelease,
  type DeploymentSubmission,
  type DeploymentTarget,
  type DeploymentTargetSubmission,
  type DeploymentTask,
  type StaticDeploymentConfig,
} from './deployments'

type PendingSubmission =
  | { kind: 'task'; input: DeploymentSubmission }
  | { kind: 'target'; input: DeploymentTargetSubmission }
type Selection = { environmentId: string; targetId: string; taskId: string; showDetail?: boolean }
type DetailTab = 'logs' | 'history' | 'config'
type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  finalFocus: ComponentProps<typeof DialogPopup>['finalFocus']
}
const errorLabel = (error: unknown) =>
  error instanceof Error ? error.message : '操作未完成，请重试。'
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN')
const normalizeDirectory = (value: string | undefined) =>
  !value || value === '.' ? '.' : value.replace(/\/$/, '')
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
    showDetail: stored?.showDetail === true,
  }
}
function packageDirectory(release: WorkspaceRelease) {
  const manifest = release.manifest as {
    services?: Array<{ service: string; context?: { workingDirectory?: string } }>
  }
  return normalizeDirectory(
    manifest.services?.find((item) => item.service === 'frontend')?.context?.workingDirectory,
  )
}

/** Same T3 workspace split surface; deployment state belongs to the existing deployment core. */
export function DeploymentsPanel({
  projectId,
  packages,
}: {
  projectId: string
  packages: WorkspaceRelease[]
}) {
  const [selection, setSelection] = useState<Selection>(() => initialSelection(projectId))
  const [pending, setPending] = useState<PendingSubmission | null>(() =>
    readStored<PendingSubmission>(storageKey(projectId, 'pending')),
  )
  const [overview, setOverview] = useState<DeploymentOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [showDetail, setShowDetail] = useState(selection.showDetail === true)
  const [detailTab, setDetailTab] = useState<DetailTab>('logs')
  const [dialog, setDialog] = useState<'target' | 'deploy' | 'rollback' | null>(null)
  const [releases, setReleases] = useState<DeploymentRelease[]>([])
  const [releasesError, setReleasesError] = useState<string | null>(null)
  const [rollbackId, setRollbackId] = useState('')
  const submitGuard = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
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
  const server = overview?.servers.find((entry) => entry.id === target?.serverId)
  const online = !!server?.online && !server.revoked
  const staticReady = online && !!server?.capabilities?.includes('static-site-v1')
  const releaseDisabled = busy || !!pending || !!activeTask || !staticReady
  const running = overview?.tasks.some((task) => !deploymentTaskFinished(task)) ?? false

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await loadDeployments(
          projectId,
          selection.environmentId || undefined,
          controller.signal,
        )
        if (controller.signal.aborted) return
        setOverview(next)
        setLoadError(null)
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(errorLabel(cause))
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, running ? 1200 : 5000)
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [projectId, selection.environmentId, refresh, running])

  useEffect(() => {
    if (!overview) return
    try {
      saveStored(storageKey(projectId, 'selection'), {
        environmentId,
        targetId: target?.id ?? '',
        taskId,
        showDetail,
      })
    } catch {
      /* Reading remains usable without storage. */
    }
  }, [projectId, overview, environmentId, target?.id, taskId, showDetail])

  useEffect(() => {
    if (!target) {
      setReleases([])
      return
    }
    const controller = new AbortController()
    setReleases([])
    setReleasesError(null)
    void loadDeploymentReleases(projectId, target.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setReleases(result.releases)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setReleasesError(errorLabel(cause))
      })
    return () => controller.abort()
  }, [projectId, target?.id, target?.currentRelease?.id, refresh])

  const chooseEnvironment = (value: string) => {
    setSelection({ environmentId: value, targetId: '', taskId: '' })
    setOverview(null)
    setShowDetail(false)
  }
  const openDialog = (value: 'target' | 'deploy' | 'rollback', releaseId = '') => {
    setError(null)
    setRollbackId(releaseId)
    setDialog(value)
  }
  const perform = async (submission: PendingSubmission) => {
    if (submitGuard.current) return
    submitGuard.current = true
    setBusy(true)
    setError(null)
    // Persist the exact request before sending; unknown outcomes never produce a new request ID.
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
        setShowDetail(true)
      } else {
        const result = await createDeploymentTarget(projectId, submission.input)
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
        setShowDetail(true)
        setDetailTab('config')
      }
      setPending(null)
      try {
        saveStored(storageKey(projectId, 'pending'), null)
      } catch {
        /* Retrying the same accepted request stays idempotent. */
      }
      setDialog(null)
      setRefresh((value) => value + 1)
    } catch (cause) {
      if (cause instanceof DeploymentRequestError && !cause.uncertain) {
        setPending(null)
        try {
          saveStored(storageKey(projectId, 'pending'), null)
        } catch {
          /* No request was accepted. */
        }
      } else setDialog(null)
      setError(errorLabel(cause))
    }
    submitGuard.current = false
    setBusy(false)
  }
  const captureTrigger = (event: React.MouseEvent<HTMLElement>) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null
    if (button) returnFocus.current = button
  }
  const finalFocus = () => returnFocus.current

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="服务发布">
      <div
        className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5"
        onClickCapture={captureTrigger}
      >
        <div className="min-w-0 flex-1 sm:max-w-52">
          <Choice
            label="部署环境"
            value={environmentId}
            options={environments.length ? environments : (overview?.environments ?? [])}
            onChange={chooseEnvironment}
            disabled={busy || !!pending}
            placeholder="读取环境…"
          />
        </div>
        <span className="flex-1" />
        <FileSurfaceAction
          label="刷新部署状态"
          disabled={busy}
          onPress={() => setRefresh((value) => value + 1)}
        >
          <RefreshCwIcon />
        </FileSurfaceAction>
        <Button
          size="sm"
          variant="outline"
          disabled={!overview?.enabled || busy || !!pending || !overview.servers.length}
          onClick={() => openDialog('target')}
        >
          <PlusIcon />
          <span className="hidden sm:inline">添加前端服务</span>
          <span className="sm:hidden">添加服务</span>
        </Button>
      </div>
      {error || loadError || pending ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2">
          <Alert variant={pending ? 'warning' : 'error'}>
            <AlertTitle>{pending ? '有一项提交结果待核对' : '部署操作未完成'}</AlertTitle>
            <AlertDescription>
              {error ??
                loadError ??
                '上次连接中断，不能确定服务器是否已接受。重试会沿用原请求，避免重复部署。'}
            </AlertDescription>
            {pending ? (
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void perform(pending)}
              >
                {busy ? <Spinner size="sm" /> : <RefreshCwIcon />}核对并重试原请求
              </Button>
            ) : (
              <Button
                className="mt-2"
                size="xs"
                variant="outline"
                onClick={() => setRefresh((value) => value + 1)}
              >
                重新加载
              </Button>
            )}
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
            className={`${showDetail && target ? 'hidden md:flex' : 'flex'} min-h-0 min-w-0 flex-1 flex-col md:w-72 md:flex-none md:border-r md:border-border/60`}
            aria-label="部署服务列表"
          >
            <div className={FILE_SURFACE_SUBHEADER_CLASS}>
              <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">前端服务</span>
              <span className="text-xs text-muted-foreground">{targets.length}</span>
            </div>
            <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
              {targets.length ? (
                <div className="flex flex-col divide-y divide-border/60">
                  {targets.map((item) => {
                    const itemServer = overview.servers.find((entry) => entry.id === item.serverId)
                    const task = overview.tasks.find((entry) => entry.targetId === item.id)
                    return (
                      <Button
                        key={item.id}
                        size="sm-multiline"
                        variant="ghost"
                        className="min-h-14 min-w-0 justify-start rounded-none px-3 py-2.5 text-left"
                        aria-pressed={item.id === target?.id}
                        data-pressed={item.id === target?.id || undefined}
                        onClick={() => {
                          setSelection({ environmentId, targetId: item.id, taskId: '' })
                          setShowDetail(true)
                        }}
                      >
                        <ServerIcon className="shrink-0 self-start" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{item.name}</span>
                          <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
                            {itemServer?.name ?? '服务器不可用'} ·{' '}
                            {itemServer?.online
                              ? task
                                ? deploymentStatusLabel(task.status)
                                : item.currentRelease
                                  ? '已发布'
                                  : '未发布'
                              : '离线'}
                          </span>
                        </span>
                        {task && !deploymentTaskFinished(task) ? <Spinner size="sm" /> : null}
                      </Button>
                    )
                  })}
                </div>
              ) : (
                <DeploymentEmpty
                  title="还没有前端服务"
                  description="添加服务，配置构建目录和站点检查地址。"
                />
              )}
            </ScrollArea>
          </section>
          <section
            className={`${showDetail ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col overflow-hidden`}
            aria-label="部署详情"
          >
            {target ? (
              <>
                <div className={FILE_SURFACE_SUBHEADER_CLASS} onClickCapture={captureTrigger}>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="md:hidden"
                    aria-label="返回服务列表"
                    onClick={() => setShowDetail(false)}
                  >
                    <ArrowLeftIcon />
                  </Button>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium" title={target.name}>
                    {target.name}
                  </span>
                  <Menu>
                    <MenuTrigger
                      render={<Button size="icon-sm" variant="ghost" />}
                      aria-label="服务操作"
                    >
                      <SettingsIcon />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem onClick={() => setDetailTab('config')}>
                        <SettingsIcon />
                        查看部署配置
                      </MenuItem>
                      <MenuItem onClick={() => setDetailTab('history')}>
                        <HistoryIcon />
                        发布记录
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                  <Button
                    size="sm"
                    disabled={releaseDisabled || !frontendPackages.length}
                    onClick={() => openDialog('deploy')}
                  >
                    <RocketIcon />
                    发布
                  </Button>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {server?.name ?? '服务器不可用'} · {online ? '在线' : '离线'}
                  </span>
                  <span className="min-w-0 truncate">
                    当前版本：
                    {target.currentRelease?.revision?.slice(0, 12) ??
                      target.currentRelease?.id.slice(0, 8) ??
                      '尚未发布'}
                  </span>
                  {activeTask ? <span>{deploymentStageLabel(activeTask.stage)}中</span> : null}
                </div>
                {!frontendPackages.length ? (
                  <p className="shrink-0 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    还没有前端源码包，请在“源码包”中从内部固定版本生成。
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
                <div className="shrink-0 border-b border-border/60 px-3 py-1.5">
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
                </div>
                {detailTab === 'logs' ? (
                  <>
                    {targetTasks.length ? (
                      <div className="shrink-0 border-b border-border/60 px-3 py-2">
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
                    ) : null}
                    {taskId ? (
                      <DeploymentLogs
                        key={taskId}
                        projectId={projectId}
                        targetId={target.id}
                        taskId={taskId}
                        refresh={refresh}
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
                                  <Badge size="sm" variant="success">
                                    当前
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
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                releaseDisabled || release.current || release.available === false
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
          busy={busy || !!pending}
          error={error}
          onSubmit={(input) =>
            perform({ kind: 'target', input: { ...input, requestId: randomUUID() } })
          }
        />
      ) : null}
      {target ? (
        <ReleaseDialog
          key={`${dialog}:${target.id}:${rollbackId}`}
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
          action={dialog === 'rollback' ? 'rollback' : 'deploy'}
          busy={busy || !!pending}
          error={error}
          onSubmit={(input) =>
            perform({ kind: 'task', input: { ...input, requestId: randomUUID() } })
          }
        />
      ) : null}
    </div>
  )
}

function DeploymentEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function Choice({
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = '请选择',
}: {
  label: string
  value: string
  options: Array<{ id: string; name: string }>
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <Select
      value={value}
      disabled={disabled || !options.length}
      onValueChange={(next) => {
        if (typeof next === 'string') onChange(next)
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>
          <span className="truncate">
            {options.find((entry) => entry.id === value)?.name ?? placeholder}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((entry) => (
          <SelectItem key={entry.id} value={entry.id}>
            {entry.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  )
}

function ConfigurationDetails({ target }: { target: DeploymentTarget }) {
  const config = target.config
  return (
    <dl className="divide-y divide-border/60 px-3 text-sm">
      {[
        ['服务类型', '前端静态站点'],
        ['目标 ID', target.id],
        ['站点检查地址', config.health.url],
        ['构建镜像', config.buildImage],
        ['构建目录', normalizeDirectory(config.module)],
        ['产物目录（相对包根目录）', config.artifactPath],
        ['包管理器', `${config.packageManager} ${config.packageManagerVersion}`],
        ['构建脚本', config.buildScript],
        ['构建参数', config.buildArgs?.join(' ') || '无'],
        ['构建资源', `${config.build.cpus} CPU / ${config.build.memoryMb} MB`],
        ['检查响应包含', config.health.bodyIncludes || '未指定'],
        [
          '健康检查',
          `${config.health.timeoutSeconds} 秒内，每 ${config.health.intervalSeconds} 秒检查`,
        ],
      ].map(([label, value]) => (
        <div
          key={label}
          className="grid min-w-0 grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-3 py-2.5"
        >
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-all text-xs">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function DeploymentLogs({
  projectId,
  targetId,
  taskId,
  refresh,
}: {
  projectId: string
  targetId: string
  taskId: string
  refresh: number
}) {
  const [task, setTask] = useState<DeploymentTask | null>(null)
  const [logs, setLogs] = useState<DeploymentLog[]>([])
  const [error, setError] = useState<string | null>(null)
  const [following, setFollowing] = useState(true)
  const surface = useRef<HTMLDivElement | null>(null)
  const follow = useRef(true)
  const cursor = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await loadDeploymentTask(
          projectId,
          taskId,
          cursor.current,
          controller.signal,
        )
        if (controller.signal.aborted) return
        if (result.task.targetId !== targetId) {
          setError('该任务不属于当前服务，请从任务列表重新选择。')
          return
        }
        setTask(result.task)
        setLogs((previous) => [
          ...previous,
          ...result.logs.filter((entry) => entry.seq > (previous.at(-1)?.seq ?? 0)),
        ])
        cursor.current = Math.max(cursor.current, result.nextSeq - 1)
        setError(null)
        if (deploymentTaskFinished(result.task) && cursor.current >= (result.task.lastSeq ?? 0))
          return
        timer = setTimeout(poll, cursor.current < (result.task.lastSeq ?? 0) ? 100 : 1000)
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(errorLabel(cause))
          timer = setTimeout(poll, 3000)
        }
      }
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [projectId, targetId, taskId, refresh])
  useEffect(() => {
    const viewport = surface.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (!viewport) return
    const onScroll = () => {
      follow.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 32
      setFollowing(follow.current)
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const viewport = surface.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (viewport && follow.current) viewport.scrollTop = viewport.scrollHeight
  }, [logs.length])
  const latest = () => {
    follow.current = true
    setFollowing(true)
    const viewport = surface.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="任务日志">
      {task ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              size="sm"
              variant={
                task.status === 'succeeded'
                  ? 'success'
                  : ['failed', 'rolled_back', 'interrupted'].includes(task.status)
                    ? 'error'
                    : 'info'
              }
            >
              {deploymentStatusLabel(task.status)}
            </Badge>
            {!deploymentTaskFinished(task) ? (
              <>
                <Spinner size="sm" />
                <span>{deploymentStageLabel(task.stage)}</span>
              </>
            ) : null}
            <span className="min-w-0 truncate text-muted-foreground">
              {dateLabel(task.createdAt)}
            </span>
          </div>
          {task.stageHistory?.length ? (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
              {task.stageHistory.map((entry, index) => (
                <span key={`${entry.stage}:${index}`} className="inline-flex items-center gap-1">
                  {deploymentStageLabel(entry.stage)}
                </span>
              ))}
            </div>
          ) : null}
          <TaskOutcome task={task} />
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <Spinner size="sm" />
          正在读取执行记录…
        </div>
      )}
      {error ? (
        <p
          className="shrink-0 border-b border-border/60 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {error} 已保留当前日志，连接恢复后继续读取。
        </p>
      ) : null}
      <div ref={surface} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <ScrollArea
          contentSizing="viewport"
          radius="none"
          className="min-h-0 flex-1"
          viewportTabIndex={0}
        >
          <pre
            className="m-0 min-h-full whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-5"
            aria-label="部署增量日志"
          >
            {logs.length
              ? logs.map((entry) => (
                  <span key={entry.seq} className="block">
                    {entry.at ? `[${new Date(entry.at).toLocaleTimeString('zh-CN')}] ` : ''}
                    {entry.stage ? `[${deploymentStageLabel(entry.stage)}] ` : ''}
                    {entry.message}
                  </span>
                ))
              : task && deploymentTaskFinished(task)
                ? '该任务没有执行日志。'
                : '等待部署执行器返回日志…'}
          </pre>
        </ScrollArea>
        {!following ? (
          <Button
            size="sm"
            variant="outline"
            className="absolute bottom-3 right-3"
            onClick={latest}
          >
            <ArrowDownIcon />
            回到最新日志
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function TaskOutcome({ task }: { task: DeploymentTask }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const result = task.result
  const errors = [task.error, result?.error, result?.rollback?.error, result?.cleanupError].filter(
    (value): value is string => !!value,
  )
  const uniqueErrors = [...new Set(errors)]
  const rollbackLabel = result?.rollback
    ? {
        succeeded: '已恢复上一版本',
        failed: '自动恢复失败',
        unavailable: '没有可用的自动恢复版本',
      }[result.rollback.status]
    : null
  return (
    <>
      {uniqueErrors.length ? (
        <p className="mt-2 break-words text-destructive">
          {uniqueErrors[0]!.slice(0, 200)}
          {uniqueErrors[0]!.length > 200 ? '…' : ''}
        </p>
      ) : null}
      {rollbackLabel ? <p className="mt-1 text-muted-foreground">{rollbackLabel}</p> : null}
      {result?.cleanupError ? (
        <p className="mt-1 text-destructive">部署清理出现异常，请查看详情。</p>
      ) : null}
      {uniqueErrors.length ? (
        <Button
          ref={trigger}
          size="xs"
          variant="ghost"
          className="mt-1"
          onClick={() => setOpen(true)}
        >
          故障与恢复详情
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="sm:max-w-xl" finalFocus={() => trigger.current}>
          <DialogHeader>
            <DialogTitle>故障与恢复详情</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <dl className="space-y-4 text-sm">
              {[
                ['任务错误', task.error],
                ['原始失败原因', result?.error],
                ['自动恢复结果', rollbackLabel],
                ['自动恢复失败原因', result?.rollback?.error],
                ['清理异常', result?.cleanupError],
                ['恢复方式', result?.recoveryMethod],
              ]
                .filter((entry) => !!entry[1])
                .map(([label, value]) => (
                  <div key={label}>
                    <dt className="mb-1 text-xs text-muted-foreground">{label}</dt>
                    <dd className="whitespace-pre-wrap break-words">{value}</dd>
                  </div>
                ))}
            </dl>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  )
}

function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: (id: string) => ReactNode
  hint?: string
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function TargetDialog({
  overview,
  environmentId,
  defaultDirectory,
  busy,
  error,
  onSubmit,
  ...dialog
}: DialogProps & {
  overview: DeploymentOverview
  environmentId: string
  defaultDirectory: string
  busy: boolean
  error: string | null
  onSubmit: (input: Omit<DeploymentTargetSubmission, 'requestId'>) => Promise<void>
}) {
  const [name, setName] = useState('前端站点')
  const [buildArgsText, setBuildArgsText] = useState('')
  const [serverId, setServerId] = useState(
    overview.servers.find((entry) => entry.online && !entry.revoked)?.id ?? '',
  )
  const [config, setConfig] = useState<StaticDeploymentConfig>(() => ({
    kind: 'static',
    module: defaultDirectory,
    artifactPath: defaultDirectory === '.' ? 'dist' : `${defaultDirectory}/dist`,
    buildImage: 'node:24-bookworm-slim',
    packageManager: 'npm',
    packageManagerVersion: '10.9.9',
    buildScript: 'build',
    buildArgs: [],
    build: { cpus: 1, memoryMb: 1024 },
    health: { url: '', bodyIncludes: '', status: 200, timeoutSeconds: 180, intervalSeconds: 5 },
  }))
  const setField = <K extends keyof StaticDeploymentConfig>(
    key: K,
    value: StaticDeploymentConfig[K],
  ) => setConfig((previous) => ({ ...previous, [key]: value }))
  return (
    <Dialog open={dialog.open} onOpenChange={dialog.onOpenChange}>
      <DialogPopup className="sm:max-w-xl" finalFocus={dialog.finalFocus}>
        <form
          className="flex min-h-0 flex-col"
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
            )
              event.preventDefault()
          }}
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && name.trim() && serverId && config.health.url)
              void onSubmit({ name: name.trim(), environmentId, serverId, config })
          }}
        >
          <DialogHeader>
            <DialogTitle>添加前端服务</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Field label="服务名称">
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onValueChange={setName}
                  required
                  disabled={busy}
                  maxLength={100}
                />
              )}
            </Field>
            <Field label="部署服务器">
              {() => (
                <Choice
                  label="部署服务器"
                  value={serverId}
                  options={overview.servers
                    .filter((entry) => !entry.revoked)
                    .map((entry) => ({
                      id: entry.id,
                      name: `${entry.name} · ${entry.online ? '在线' : '离线'}`,
                    }))}
                  onChange={setServerId}
                  disabled={busy}
                />
              )}
            </Field>
            <Field
              label="站点检查地址"
              hint="填写部署服务器能访问的站点根地址；发布后会核对版本标识和首页。"
            >
              {(id) => (
                <Input
                  id={id}
                  type="url"
                  required
                  value={config.health.url}
                  onValueChange={(value) => setField('health', { ...config.health, url: value })}
                  placeholder="http://服务器地址/"
                  disabled={busy}
                />
              )}
            </Field>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Field label="构建目录" hint="相对源码包根目录，必须与所选包的构建上下文一致。">
                {(id) => (
                  <Input
                    id={id}
                    value={config.module}
                    onValueChange={(value) => setField('module', value)}
                    required
                    disabled={busy}
                  />
                )}
              </Field>
              <Field label="产物目录" hint="相对源码包根目录，例如 frontend/dist。">
                {(id) => (
                  <Input
                    id={id}
                    value={config.artifactPath}
                    onValueChange={(value) => setField('artifactPath', value)}
                    required
                    disabled={busy}
                  />
                )}
              </Field>
            </div>
            <Field label="构建镜像">
              {(id) => (
                <Input
                  id={id}
                  value={config.buildImage}
                  onValueChange={(value) => setField('buildImage', value)}
                  required
                  disabled={busy}
                />
              )}
            </Field>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Field label="包管理器">
                {() => (
                  <Choice
                    label="包管理器"
                    value={config.packageManager}
                    options={[
                      { id: 'npm', name: 'npm' },
                      { id: 'pnpm', name: 'pnpm' },
                    ]}
                    onChange={(value) => {
                      if (value === 'npm' || value === 'pnpm')
                        setConfig((previous) => ({
                          ...previous,
                          packageManager: value,
                          packageManagerVersion: value === 'npm' ? '10.9.9' : '10.11.0',
                        }))
                    }}
                    disabled={busy}
                  />
                )}
              </Field>
              <Field label="包管理器版本">
                {(id) => (
                  <Input
                    id={id}
                    value={config.packageManagerVersion}
                    onValueChange={(value) => setField('packageManagerVersion', value)}
                    required
                    disabled={busy}
                    pattern="[0-9]+\.[0-9]+\.[0-9]+"
                  />
                )}
              </Field>
            </div>
            <Field
              label="构建脚本"
              hint="package.json 中的脚本名称，例如 build；不填写 Shell 命令。"
            >
              {(id) => (
                <Input
                  id={id}
                  value={config.buildScript}
                  onValueChange={(value) => setField('buildScript', value)}
                  required
                  disabled={busy}
                />
              )}
            </Field>
            <Field label="检查响应包含（可选）">
              {(id) => (
                <Input
                  id={id}
                  value={config.health.bodyIncludes}
                  onValueChange={(value) =>
                    setField('health', { ...config.health, bodyIncludes: value })
                  }
                  disabled={busy}
                  maxLength={1024}
                />
              )}
            </Field>
            <Collapsible disabled={busy}>
              <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" />}>
                更多构建与检查配置
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="space-y-4 pt-3">
                  <Field label="构建附加参数" hint="每行一个参数，传给构建脚本。">
                    {(id) => (
                      <Textarea
                        id={id}
                        value={buildArgsText}
                        onChange={(event) => {
                          const value = event.target.value
                          setBuildArgsText(value)
                          setField(
                            'buildArgs',
                            value
                              .split('\n')
                              .map((line) => line.trim())
                              .filter(Boolean),
                          )
                        }}
                        disabled={busy}
                      />
                    )}
                  </Field>
                  <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                    <Field label="构建 CPU">
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min={0.1}
                          max={32}
                          step={0.1}
                          required
                          value={String(config.build.cpus)}
                          onValueChange={(value) =>
                            setField('build', { ...config.build, cpus: Number(value) })
                          }
                          disabled={busy}
                        />
                      )}
                    </Field>
                    <Field label="构建内存（MB）">
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min={256}
                          max={65536}
                          step={1}
                          required
                          value={String(config.build.memoryMb)}
                          onValueChange={(value) =>
                            setField('build', { ...config.build, memoryMb: Number(value) })
                          }
                          disabled={busy}
                        />
                      )}
                    </Field>
                    <Field label="检查超时（秒）">
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min={10}
                          max={900}
                          step={1}
                          required
                          value={String(config.health.timeoutSeconds)}
                          onValueChange={(value) =>
                            setField('health', { ...config.health, timeoutSeconds: Number(value) })
                          }
                          disabled={busy}
                        />
                      )}
                    </Field>
                    <Field label="检查间隔（秒）">
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min={2}
                          max={60}
                          step={1}
                          required
                          value={String(config.health.intervalSeconds)}
                          onValueChange={(value) =>
                            setField('health', { ...config.health, intervalSeconds: Number(value) })
                          }
                          disabled={busy}
                        />
                      )}
                    </Field>
                  </div>
                </div>
              </CollapsiblePanel>
            </Collapsible>
            <p className="text-xs text-muted-foreground">
              保存后，需由运维按目标 ID 配置已有 Nginx 的目录映射，并确认站点检查地址可访问。平台不会自动修改 Nginx。
            </p>
            {error ? (
              <Alert variant="error" role="alert">
                {error}
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => dialog.onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={busy || !name.trim() || !serverId || !environmentId || !config.health.url}
            >
              {busy ? <Spinner size="sm" /> : <PlusIcon />}添加服务
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

function ReleaseDialog({
  target: liveTarget,
  serverName,
  environmentName,
  packages,
  releases,
  rollbackId,
  action,
  busy,
  error,
  onSubmit,
  ...dialog
}: DialogProps & {
  target: DeploymentTarget
  serverName: string
  environmentName: string
  packages: WorkspaceRelease[]
  releases: DeploymentRelease[]
  rollbackId: string
  action: 'deploy' | 'rollback'
  busy: boolean
  error: string | null
  onSubmit: (input: Omit<DeploymentSubmission, 'requestId'>) => Promise<void>
}) {
  // Confirm exactly the configuration shown when this dialog opened. A server
  // change yields a conflict instead of silently accepting a different snapshot.
  const [target] = useState(liveTarget)
  const compatible = packages.filter(
    (entry) => packageDirectory(entry) === normalizeDirectory(target.config.module),
  )
  const [packageId, setPackageId] = useState(compatible[0]?.id ?? '')
  const selectedPackage = compatible.find((entry) => entry.id === packageId)
  const selectedRelease = releases.find((entry) => entry.id === rollbackId)
  const zip = selectedPackage?.services.find((entry) => entry.service === 'frontend')
  const unavailable =
    busy ||
    (action === 'deploy'
      ? !selectedPackage
      : !selectedRelease || selectedRelease.current || selectedRelease.available === false)
  return (
    <Dialog open={dialog.open} onOpenChange={dialog.onOpenChange}>
      <DialogPopup className="sm:max-w-xl" finalFocus={dialog.finalFocus}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            if (!unavailable)
              void onSubmit({
                targetId: target.id,
                action,
                service: 'frontend',
                configKey: target.configKey,
                ...(action === 'deploy' ? { packageId } : { releaseId: rollbackId }),
              })
          }}
        >
          <DialogHeader>
            <DialogTitle>{action === 'deploy' ? '确认发布' : '确认回退'}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">服务</dt>
              <dd className="min-w-0 break-words">{target.name}</dd>
              <dt className="text-muted-foreground">环境</dt>
              <dd>{environmentName}</dd>
              <dt className="text-muted-foreground">服务器</dt>
              <dd className="min-w-0 break-words">{serverName}</dd>
              <dt className="text-muted-foreground">构建目录</dt>
              <dd className="break-all font-mono">{normalizeDirectory(target.config.module)}</dd>
            </dl>
            {action === 'deploy' ? (
              <>
                <Field label="前端源码包">
                  {() => (
                    <Choice
                      label="发布源码包"
                      value={packageId}
                      options={compatible.map((entry) => ({
                        id: entry.id,
                        name: `${entry.name} · ${dateLabel(entry.createdAt)}`,
                      }))}
                      onChange={setPackageId}
                      disabled={busy}
                      placeholder="没有匹配构建目录的前端源码包"
                    />
                  )}
                </Field>
                {!compatible.length ? (
                  <Alert variant="warning">
                    没有与该目标构建目录匹配的前端源码包。请先生成对应源码包，或为其构建目录添加目标。
                  </Alert>
                ) : null}
                {selectedPackage ? (
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <p className="break-all">来源版本：{selectedPackage.sourceVersionId}</p>
                    <p className="break-all font-mono">SHA-256：{zip?.sha256}</p>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="break-all text-sm">
                将恢复版本 {selectedRelease?.revision?.slice(0, 12) ?? selectedRelease?.id}{' '}
                及其历史配置，随后执行健康检查。
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {action === 'deploy'
                ? '本次使用固定源码包和配置快照。构建完成后切换站点；健康检查失败时由部署执行器尝试恢复上一版本。'
                : '回退通过原部署执行器完成；若本机产物已清理，会尝试从历史源码包重建。'}
            </p>
            {error ? (
              <Alert variant="error" role="alert">
                {error}
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => dialog.onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={unavailable}>
              {busy ? (
                <Spinner size="sm" />
              ) : action === 'deploy' ? (
                <RocketIcon />
              ) : (
                <RotateCcwIcon />
              )}
              {action === 'deploy' ? '确认发布' : '确认回退'}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
