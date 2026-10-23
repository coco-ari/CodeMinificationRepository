import { useWorkspaceOverview } from './useWorkspaceOverview'
import { useWorkspaceTaskSubmission } from './useWorkspaceTaskSubmission'
import {
  ModuleHeader,
  ModuleSidebar,
  ModuleSidebarItem,
  ModuleSidebarEmpty,
} from './ModuleWorkspace'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownToLineIcon,
  FileJsonIcon,
  HistoryIcon,
  PackageIcon,
  RefreshCwIcon,
} from 'lucide-react'
import { SidebarInset } from '~/components/ui/sidebar'
import { Button } from '~/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from '~/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Spinner } from '~/components/ui/spinner'
import { ReadOnlySourcePreview } from '~/components/files/AttachmentFilePreview'
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
} from '~/components/files/fileSurfaceChrome'
import { readAutoOpsHost } from './hostConfig'
import { useAutoOpsProjectId } from './projectNavigation'
import { DeploymentsPanel } from './DeploymentsPanel'
import { WorkspacePackagesDialog, WorkspaceTasksDialog, WorkspaceSubmissionNotice } from './WorkspaceActions'
import {
  cancelWorkspaceTask,
  workspacePackageUrl,
  type WorkspaceRelease,
  type WorkspaceTask,
  type WorkspaceVersion,
} from './workspaces'

const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN')
const sizeLabel = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`
const taskActive = (task: WorkspaceTask) => task.status === 'queued' || task.status === 'running'
const storageKey = (projectId: string, key: string) =>
  `autoops:deployments:${readAutoOpsHost()?.principal.id ?? ''}:${projectId}:${key}`
function readSelection(projectId: string, key: string) {
  try {
    return sessionStorage.getItem(storageKey(projectId, key))
  } catch {
    return null
  }
}
function saveSelection(projectId: string, key: string, value: string) {
  try {
    sessionStorage.setItem(storageKey(projectId, key), value)
  } catch {
    /* 浏览器存储不可用时仍可查看当前页面。 */
  }
}

export function AutoOpsDeploymentsPage() {
  const projectId = useAutoOpsProjectId()
  const project = readAutoOpsHost()?.projects.find((entry) => entry.id === projectId)
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const sourceVersionId =
    search.sourceVersionId === undefined
      ? undefined
      : typeof search.sourceVersionId === 'string' && search.sourceVersionId
        ? search.sourceVersionId
        : null
  const manager = project?.capabilities?.['deployment.read'] === true
  return (
    <SidebarInset
      className="h-dvh min-h-0 min-w-0 overflow-hidden overscroll-y-none"
      aria-label="项目部署"
      data-testid="deployments-page"
    >
      {!project || !manager ? (
        <>
          <ModuleHeader title="部署发布" />
          <ModuleSidebar label="部署服务">
            <ModuleSidebarEmpty>项目不可用或无权访问。</ModuleSidebarEmpty>
          </ModuleSidebar>
        </>
      ) : null}
      {project && manager ? (
        <ProjectDeployments
          key={`${readAutoOpsHost()?.principal.id}:${projectId}`}
          projectId={projectId}
          requestedSourceVersionId={sourceVersionId}
        />
      ) : (
        <div className="flex min-h-0 flex-1" data-testid="project-unavailable">
          <DeploymentEmpty
            title="项目不可用或无权访问"
            description="部署与原始源码包仅向内部项目管理者开放。"
          />
        </div>
      )}
    </SidebarInset>
  )
}

function ProjectDeployments({
  projectId,
  requestedSourceVersionId,
}: {
  projectId: string
  requestedSourceVersionId: string | null | undefined
}) {
  const navigate = useNavigate()
  const canManage = readAutoOpsHost()?.projects.find((project) => project.id === projectId)?.capabilities?.['workspace.manage'] === true
  const [view, setView] = useState<'services' | 'packages'>(() =>
    requestedSourceVersionId !== undefined || readSelection(projectId, 'view') === 'packages'
      ? 'packages'
      : 'services',
  )
  const { overview, loadError, refreshOverview } = useWorkspaceOverview(projectId)
  const [actionError, setError] = useState<string | null>(null)
  const [mutationBusy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<'packages' | 'tasks' | null>(null)
  const [sourceId, setSourceId] = useState(() => readSelection(projectId, 'package-source') ?? '')
  const [fixedSourceId, setFixedSourceId] = useState<string | null>(null)
  const [handledSource, setHandledSource] = useState<string | null | undefined>(undefined)
  const [followTaskId, setFollowTaskId] = useState<string | null>(null)
  const submission = useWorkspaceTaskSubmission(projectId, (task) => {
    setFollowTaskId(task.id)
    setDialog(null)
    refreshOverview()
  })
  const busy = mutationBusy || submission.busy
  const error = submission.error ?? actionError ?? loadError
  const submissionNotice = <WorkspaceSubmissionNotice label={submission.pendingLabel} retryAvailable={submission.retryAvailable && canManage} busy={busy} onCheck={submission.check} onRetry={submission.retry} />
  const [selectedPackageId, setSelectedPackageId] = useState(
    () => readSelection(projectId, 'package') ?? '',
  )
  const returnFocus = useRef<HTMLElement | null>(null)
  const generateTrigger = useRef<HTMLButtonElement | null>(null)
  const running = overview?.tasks.some(taskActive) ?? false
  const tasks = overview?.tasks.filter((task) => task.type === 'packages') ?? []
  const activeTasks = tasks.filter(taskActive)
  const taskLabel = activeTasks.length ? `${activeTasks.length} 个源码包任务执行中` : '任务记录'
  const internal = overview?.internalVersions ?? []
  const source = internal.find((version) => version.id === sourceId) ?? internal[0]
  const fixedSource = internal.find((version) => version.id === fixedSourceId)
  useEffect(() => {
    saveSelection(projectId, 'view', view)
  }, [projectId, view])
  useEffect(() => {
    if (source) saveSelection(projectId, 'package-source', source.id)
  }, [projectId, source])
  useEffect(() => {
    if (selectedPackageId) saveSelection(projectId, 'package', selectedPackageId)
  }, [projectId, selectedPackageId])
  useEffect(() => {
    if (
      !overview ||
      requestedSourceVersionId === undefined ||
      handledSource === requestedSourceVersionId
    )
      return
    setHandledSource(requestedSourceVersionId)
    const requested = internal.find(
      (version) => version.id === requestedSourceVersionId && version.status === 'published',
    )
    setView('packages')
    if (requested) {
      setSourceId(requested.id)
      setFixedSourceId(requested.id)
      returnFocus.current = generateTrigger.current
      setDialog('packages')
    } else setError('指定内部版本不可用或无权访问，未自动改用其他来源。')
    // Consume the one-shot intent, so closing or refreshing never reopens it.
    void navigate({
      to: '/deployments',
      search: { projectId: ProjectId.make(projectId) },
      replace: true,
    })
  }, [overview, requestedSourceVersionId, handledSource, internal, navigate, projectId])
  useEffect(() => {
    const task = overview?.tasks.find((entry) => entry.id === followTaskId)
    if (!task || taskActive(task)) return
    if (task.status === 'completed' && task.releaseId) {
      setSelectedPackageId(task.releaseId)
      setView('packages')
    }
    setFollowTaskId(null)
  }, [overview, followTaskId])
  const mutate = async (action: () => Promise<WorkspaceTask>) => {
    setBusy(true)
    setError(null)
    return action()
      .then(async (task) => {
        setFollowTaskId(task.id)
        refreshOverview()
        return true
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : '源码包操作未完成，请重试。')
        return false
      })
      .finally(() => setBusy(false))
  }
  const changeDialog = (open: boolean) => {
    if (!open) {
      setDialog(null)
      setFixedSourceId(null)
    }
  }
  const capturePackageAction = (event: React.MouseEvent<HTMLElement>) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null
    if (button) returnFocus.current = button
  }
  const navigation = (
    <div className="space-y-1" aria-label="部署分类">
      <ModuleSidebarItem
        label="服务发布"
        selected={view === 'services'}
        onClick={() => setView('services')}
      />
      <ModuleSidebarItem
        label="源码包"
        icon={PackageIcon}
        selected={view === 'packages'}
        onClick={() => setView('packages')}
      />
    </div>
  )
  const packageActions = (
    <div className="flex items-center gap-1" onClickCapture={capturePackageAction}>
      <FileSurfaceAction
        label="刷新源码包"
        disabled={busy}
        onPress={() => refreshOverview()}
      >
        <RefreshCwIcon />
      </FileSurfaceAction>
      <FileSurfaceAction
        label={`源码包${taskLabel}`}
        disabled={!tasks.length}
        onPress={() => {
          setError(null)
          setDialog('tasks')
        }}
      >
        {activeTasks.length ? <Spinner size="sm" /> : <HistoryIcon />}
      </FileSurfaceAction>
      <Button
        ref={generateTrigger}
        size="sm"
        variant="outline"
        disabled={!canManage || !overview || busy || running || !internal.length}
        onClick={() => {
          setError(null)
          setFixedSourceId(null)
          setDialog('packages')
        }}
      >
        <PackageIcon />
        <span className="hidden sm:inline">生成部署包</span>
        <span className="sm:hidden">生成包</span>
      </Button>
    </div>
  )
  const servicePackageActions = (
    <div className="flex items-center gap-1" onClickCapture={capturePackageAction}>
      <FileSurfaceAction
        label={`源码包${taskLabel}`}
        disabled={!tasks.length}
        onPress={() => {
          setError(null)
          setDialog('tasks')
        }}
      >
        {activeTasks.length ? <Spinner size="sm" /> : <HistoryIcon />}
      </FileSurfaceAction>
      <Button
        ref={generateTrigger}
        size="sm"
        variant="outline"
        disabled={!canManage || !overview || busy || running || !internal.length}
        onClick={() => {
          setError(null)
          setFixedSourceId(null)
          setDialog('packages')
        }}
      >
        <PackageIcon />
        <span className="hidden sm:inline">生成部署包</span>
        <span className="sm:hidden">生成包</span>
      </Button>
    </div>
  )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {view === 'packages' ? (
        <>
          <ModuleHeader title="源码包" actions={packageActions} />
          {!overview?.releases.length ? (
            <ModuleSidebar label="部署交付" header={navigation}>
              <ModuleSidebarEmpty>
                {overview ? '还没有部署包。' : '正在读取源码包…'}
              </ModuleSidebarEmpty>
            </ModuleSidebar>
          ) : null}
        </>
      ) : null}
      {error && !dialog ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2">
          <Alert variant="error">
            <AlertTitle>源码包操作未完成</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Button
            className="mt-2"
            size="xs"
            variant="outline"
            onClick={() => refreshOverview()}
          >
            重新加载
          </Button>
        </div>
      ) : null}
      {!dialog && submission.pendingLabel ? <div className="shrink-0 border-b border-border/60 px-3 py-2">{submissionNotice}</div> : null}
      {view === 'services' ? (
        <DeploymentsPanel
          key={`${readAutoOpsHost()?.principal.id}:${projectId}`}
          projectId={projectId}
          packages={overview?.releases ?? []}
          navigation={navigation}
          packageActions={servicePackageActions}
          onRefreshPackages={() => refreshOverview()}
        />
      ) : !overview ? (
        error ? null : (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" />
            正在读取源码包…
          </div>
        )
      ) : (
        <WorkspacePackages
          projectId={projectId}
          releases={overview.releases}
          versions={internal}
          selectedId={selectedPackageId}
          onSelect={setSelectedPackageId}
          navigation={navigation}
        />
      )}
      <WorkspacePackagesDialog
        open={dialog === 'packages'}
        onOpenChange={changeDialog}
        finalFocus={() => returnFocus.current}
        disabled={!canManage || !overview || busy || running || !internal.length}
        internalVersions={fixedSource ? [fixedSource] : internal}
        initialSourceId={fixedSource?.id ?? source?.id}
        submissionNotice={submissionNotice}
        error={error}
        onGenerate={(id, services, contexts) => {
          setSourceId(id)
          return canManage ? submission.submit({ type: 'packages', sourceVersionId: id, services, contexts }) : Promise.resolve(false)
        }}
      />
      <WorkspaceTasksDialog
        open={dialog === 'tasks'}
        onOpenChange={changeDialog}
        finalFocus={() => returnFocus.current}
        tasks={tasks}
        busy={busy || !canManage}
        error={error}
        onCancel={(id) => mutate(() => cancelWorkspaceTask(projectId, id))}
      />
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
function WorkspacePackages({
  projectId,
  releases,
  versions,
  selectedId,
  onSelect,
  navigation,
}: {
  projectId: string
  releases: WorkspaceRelease[]
  versions: WorkspaceVersion[]
  selectedId: string
  onSelect: (id: string) => void
  navigation: ReactNode
}) {
  const [manifestOpen, setManifestOpen] = useState(false)
  const manifestTrigger = useRef<HTMLButtonElement | null>(null)
  const selected = releases.find((release) => release.id === selectedId) ?? releases[0]
  useEffect(() => {
    if (selected && selected.id !== selectedId) onSelect(selected.id)
  }, [selected, selectedId, onSelect])
  if (!selected)
    return (
      <DeploymentEmpty
        title="还没有部署包"
        description="选择内部版本，按需生成前端、后端或两者的源码包。"
      />
    )
  const sourceName =
    versions.find((version) => version.id === selected.sourceVersionId)?.name ??
    selected.sourceVersionId
  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" aria-label="部署交付">
      <ModuleSidebar label="部署交付" header={navigation}>
        <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
          <div className="px-[var(--sidebar-content-inset)]">
            {releases.map((release) => (
              <ModuleSidebarItem
                key={release.id}
                label={release.name}
                icon={PackageIcon}
                description={dateLabel(release.createdAt)}
                selected={release.id === selected.id}
                onClick={() => onSelect(release.id)}
              />
            ))}
          </div>
        </ScrollArea>
        <div className="flex shrink-0 flex-col gap-2 border-t border-border/60 px-3 py-3">
          <p className="truncate text-xs text-muted-foreground" title={sourceName}>
            来源：{sourceName}
          </p>
          <Button
            size="sm"
            variant="ghost"
            render={
              <Link
                to="/workspaces"
                search={{
                  projectId: ProjectId.make(projectId),
                  versionId: selected.sourceVersionId,
                }}
              />
            }
          >
            查看工作区来源
          </Button>
          {selected.services.map((service) => (
            <div key={service.service} className="flex min-w-0 items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="min-w-0 flex-1"
                render={
                  <a href={workspacePackageUrl(projectId, selected.id, service.service)} download />
                }
              >
                <ArrowDownToLineIcon />
                {service.service === 'frontend' ? '下载前端 ZIP' : '下载后端 ZIP'}
              </Button>
              <span className="shrink-0 text-xs text-muted-foreground">
                {sizeLabel(service.size)}
              </span>
            </div>
          ))}
          <Button
            ref={manifestTrigger}
            size="sm"
            variant="ghost"
            onClick={() => setManifestOpen(true)}
          >
            <FileJsonIcon />
            查看交付清单
          </Button>
        </div>
      </ModuleSidebar>
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        aria-label="交付清单预览"
      >
        <ManifestPreview key={selected.id} projectId={projectId} release={selected} />
      </section>
      <Dialog open={manifestOpen} onOpenChange={setManifestOpen}>
        <DialogPopup
          finalFocus={() => manifestTrigger.current}
          className="h-[min(48rem,90dvh)] max-w-4xl gap-0"
        >
          <DialogHeader>
            <DialogTitle>交付清单</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ManifestPreview key={selected.id} projectId={projectId} release={selected} />
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  )
}
function ManifestPreview({ projectId, release }: { projectId: string; release: WorkspaceRelease }) {
  return (
    <>
      <div className={FILE_SURFACE_SUBHEADER_CLASS}>
        <FileJsonIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs">manifest.json</span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="下载交付清单"
          render={<a href={workspacePackageUrl(projectId, release.id, 'manifest')} download />}
        >
          <ArrowDownToLineIcon />
        </Button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <ReadOnlySourcePreview
          name="manifest.json"
          text={JSON.stringify(release.manifest, null, 2)}
        />
      </div>
    </>
  )
}
