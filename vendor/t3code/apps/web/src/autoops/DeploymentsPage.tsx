import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLineIcon,
  FileJsonIcon,
  HistoryIcon,
  PackageIcon,
  RefreshCwIcon,
} from 'lucide-react'
import { SidebarInset } from '~/components/ui/sidebar'
import { Button } from '~/components/ui/button'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
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
import { randomUUID } from '~/lib/utils'
import { readAutoOpsHost } from './hostConfig'
import { useAutoOpsProjectId } from './projectNavigation'
import { DeploymentsPanel } from './DeploymentsPanel'
import { WorkspacePackagesDialog, WorkspaceTasksDialog } from './WorkspaceActions'
import {
  cancelWorkspaceTask,
  generateWorkspacePackages,
  loadWorkspaces,
  workspacePackageUrl,
  type WorkspaceOverview,
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
    /* Viewing stays usable without persistence. */
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
  const manager =
    project?.membership?.workspaceAccess === 'internal' && project.membership.role === 'manager'
  return (
    <SidebarInset
      className="h-dvh min-h-0 min-w-0 overflow-hidden overscroll-y-none"
      aria-label="项目部署"
      data-testid="deployments-page"
    >
      <h1 className="sr-only">部署发布</h1>
      {project && manager ? (
        <ProjectDeployments
          key={projectId}
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
  const [view, setView] = useState<'services' | 'packages'>(() =>
    requestedSourceVersionId !== undefined || readSelection(projectId, 'view') === 'packages'
      ? 'packages'
      : 'services',
  )
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<'packages' | 'tasks' | null>(null)
  const [sourceId, setSourceId] = useState(() => readSelection(projectId, 'package-source') ?? '')
  const [fixedSourceId, setFixedSourceId] = useState<string | null>(null)
  const [handledSource, setHandledSource] = useState<string | null | undefined>(undefined)
  const [followTaskId, setFollowTaskId] = useState<string | null>(null)
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
    const controller = new AbortController()
    void loadWorkspaces(projectId, controller.signal)
      .then((next) => {
        setOverview(next)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '读取源码包失败，请重试。')
      })
    return () => controller.abort()
  }, [projectId, refresh])
  useEffect(() => {
    if (!running) return
    const timer = window.setTimeout(() => setRefresh((value) => value + 1), 1200)
    return () => window.clearTimeout(timer)
  }, [running, overview, refresh])
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
    void navigate({ to: '/deployments', search: { projectId: ProjectId.make(projectId) }, replace: true })
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
        setOverview(await loadWorkspaces(projectId))
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
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-y border-border/60 px-3 py-1.5"
        aria-label="部署工具栏"
        onClickCapture={(event) => {
          const button = event.target instanceof Element ? event.target.closest('button') : null
          if (button) returnFocus.current = button
        }}
      >
        <ToggleGroup
          aria-label="部署分类"
          variant="segmented"
          value={[view]}
          onValueChange={(value) => {
            if (value[0] === 'services' || value[0] === 'packages') setView(value[0])
          }}
        >
          <Toggle value="services">服务发布</Toggle>
          <Toggle value="packages">源码包</Toggle>
        </ToggleGroup>
        <span className="flex-1" />
        <FileSurfaceAction
          label="刷新源码包"
          disabled={busy}
          onPress={() => setRefresh((value) => value + 1)}
        >
          <RefreshCwIcon />
        </FileSurfaceAction>
        <FileSurfaceAction
          label={taskLabel}
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
          disabled={!overview || busy || running || !internal.length}
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
            onClick={() => setRefresh((value) => value + 1)}
          >
            重新加载
          </Button>
        </div>
      ) : null}
      {view === 'services' ? (
        <DeploymentsPanel
          key={projectId}
          projectId={projectId}
          packages={overview?.releases ?? []}
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
        />
      )}
      <WorkspacePackagesDialog
        open={dialog === 'packages'}
        onOpenChange={changeDialog}
        finalFocus={() => returnFocus.current}
        disabled={!overview || busy || running || !internal.length}
        internalVersions={fixedSource ? [fixedSource] : internal}
        initialSourceId={fixedSource?.id ?? source?.id}
        error={error}
        onGenerate={(id, services) => {
          setSourceId(id)
          return mutate(() => generateWorkspacePackages(projectId, id, services, randomUUID()))
        }}
      />
      <WorkspaceTasksDialog
        open={dialog === 'tasks'}
        onOpenChange={changeDialog}
        finalFocus={() => returnFocus.current}
        tasks={tasks}
        busy={busy}
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
}: {
  projectId: string
  releases: WorkspaceRelease[]
  versions: WorkspaceVersion[]
  selectedId: string
  onSelect: (id: string) => void
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:w-80 md:flex-none md:border-r md:border-border/60">
        <div className={FILE_SURFACE_SUBHEADER_CLASS}>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">交付记录</span>
        </div>
        <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
          <div className="flex flex-col divide-y divide-border/60">
            {releases.map((release) => (
              <Button
                key={release.id}
                size="sm-multiline"
                variant="ghost"
                className="h-auto min-w-0 justify-start rounded-none px-3 py-2.5 text-left"
                aria-pressed={release.id === selected.id}
                data-pressed={release.id === selected.id || undefined}
                onClick={() => onSelect(release.id)}
              >
                <PackageIcon className="self-start" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{release.name}</span>
                  <time
                    dateTime={release.createdAt}
                    className="mt-1 block truncate text-xs font-normal text-muted-foreground"
                  >
                    {dateLabel(release.createdAt)}
                  </time>
                </span>
              </Button>
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
              <Link to="/workspaces" search={{ projectId: ProjectId.make(projectId), versionId: selected.sourceVersionId }} />
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
            className="md:hidden"
            onClick={() => setManifestOpen(true)}
          >
            <FileJsonIcon />
            查看交付清单
          </Button>
        </div>
      </div>
      <section
        className="hidden min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex"
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
