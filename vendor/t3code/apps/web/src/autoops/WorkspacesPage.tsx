import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLineIcon, FileJsonIcon, GitBranchIcon, HistoryIcon, InfoIcon, MessageSquarePlusIcon, MoreHorizontalIcon, PackageIcon, RefreshCwIcon, ShieldCheckIcon } from 'lucide-react'
import { WorkspacePageHeader } from '~/components/WorkspacePageHeader'
import { SidebarInset } from '~/components/ui/sidebar'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '~/components/ui/menu'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from '~/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Spinner } from '~/components/ui/spinner'
import { randomUUID } from '~/lib/utils'
import { readAutoOpsHost } from './hostConfig'
import { DeploymentsPanel } from './DeploymentsPanel'
import { ReadOnlyWorkspaceFiles } from '~/components/files/ReadOnlyWorkspaceFiles'
import { ReadOnlySourcePreview } from '~/components/files/AttachmentFilePreview'
import { FILE_SURFACE_SUBHEADER_CLASS, FileSurfaceAction } from '~/components/files/fileSurfaceChrome'
import type { ReadOnlyFileSource } from '~/components/files/readOnlyFileSource'
import { usePrimaryEnvironmentId } from '~/state/environments'
import {
  ExternalWorkspaceDialog, WorkspaceImportDialog, WorkspacePackagesDialog,
  WorkspaceReviewDialog, WorkspaceTasksDialog, WorkspaceVersionDialog,
} from './WorkspaceActions'
import {
  cancelWorkspaceTask, generateExternalWorkspace, generateWorkspacePackages,
  importWorkspaceRepository, loadWorkspaces, loadWorkspaceTree, loadWorkspaceFileMetadata, searchWorkspaceFiles,
  publishWorkspace, startWorkspaceConversation, workspaceFileDownloadUrl, workspacePackageUrl,
  type WorkspaceOverview, type WorkspaceRelease, type WorkspaceTask, type WorkspaceVersion,
} from './workspaces'

const tabs = [{ id: 'internal', name: '内部工作区' }, { id: 'external', name: '外部工作区' }, { id: 'packages', name: '部署发布' }] as const
type Tab = typeof tabs[number]['id']
type WorkspaceDialog = 'import' | 'external' | 'packages' | 'version' | 'tasks' | 'review' | null
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN')
const sizeLabel = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
const errorLabel = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。'
const taskActive = (task: WorkspaceTask) => task.status === 'queued' || task.status === 'running'
const selectionKey = (key: string) => `autoops:workspaces:${readAutoOpsHost()?.principal.id ?? ''}:${key}`
function readSelection(key: string) {
  try { return sessionStorage.getItem(selectionKey(key)) } catch { return null }
}
function saveSelection(key: string, value: string) {
  try { sessionStorage.setItem(selectionKey(key), value) } catch { /* Navigation remains usable without browser storage. */ }
}

export function AutoOpsWorkspacesPage() {
  const host = readAutoOpsHost()
  const [projectId, setProjectId] = useState(() => {
    const stored = readSelection('project')
    return host?.projects.find((project) => project.id === stored)?.id ?? host?.projects[0]?.id ?? ''
  })
  useEffect(() => { if (projectId) saveSelection('project', projectId) }, [projectId])
  if (!host || !projectId) return <Empty><EmptyHeader><EmptyTitle>没有可用的项目工作区</EmptyTitle></EmptyHeader></Empty>
  return (
    <SidebarInset className="h-dvh min-h-0 min-w-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">工作区</h1>
        <div className="max-w-52 min-w-0">
          <Select value={projectId} onValueChange={(value) => { if (typeof value === 'string') setProjectId(value) }}>
            <SelectTrigger size="sm" aria-label="工作区项目"><SelectValue><span className="truncate">{host.projects.find((project) => project.id === projectId)?.name}</span></SelectValue></SelectTrigger>
            <SelectPopup>{host.projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectPopup>
          </Select>
        </div>
      </WorkspacePageHeader>
      <ProjectWorkspaces key={projectId} projectId={projectId} />
    </SidebarInset>
  )
}

function ProjectWorkspaces({ projectId }: { projectId: string }) {
  const membership = readAutoOpsHost()?.projects.find((project) => project.id === projectId)?.membership
  const manager = membership?.workspaceAccess === 'internal' && membership.role === 'manager'
  const externalOnly = membership?.workspaceAccess === 'external'
  const [selectedTab, setTab] = useState<Tab>(() => {
    const stored = readSelection(`${projectId}:tab`)
    return externalOnly ? 'external' : stored === 'external' || stored === 'packages' ? stored : 'internal'
  })
  const [deploymentView, setDeploymentView] = useState<'services' | 'packages'>(() => readSelection(`${projectId}:deployment-view`) === 'packages' ? 'packages' : 'services')
  const tab = externalOnly ? 'external' : !manager && selectedTab === 'packages' ? 'internal' : selectedTab
  const availableTabs = tabs.filter((item) => externalOnly ? item.id === 'external' : manager || item.id !== 'packages')
  useEffect(() => { saveSelection(`${projectId}:tab`, tab) }, [projectId, tab])
  useEffect(() => { saveSelection(`${projectId}:deployment-view`, deploymentView) }, [projectId, deploymentView])
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [selectedInternal, setSelectedInternal] = useState('')
  const [selectedExternal, setSelectedExternal] = useState('')
  const [dialog, setDialog] = useState<WorkspaceDialog>(null)
  const dialogReturnFocus = useRef<HTMLElement | null>(null)
  const menuTrigger = useRef<HTMLButtonElement | null>(null)
  const [followTaskId, setFollowTaskId] = useState<string | null>(null)
  const running = overview?.tasks.some(taskActive) ?? false

  useEffect(() => {
    const controller = new AbortController()
    void loadWorkspaces(projectId, controller.signal).then((next) => {
      setOverview(next)
      setError(null)
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorLabel(cause)) })
    return () => controller.abort()
  }, [projectId, refresh])

  useEffect(() => {
    if (!running) return
    const timer = window.setTimeout(() => setRefresh((value) => value + 1), 1200)
    return () => window.clearTimeout(timer)
  }, [running, overview, refresh])

  useEffect(() => {
    const task = overview?.tasks.find((entry) => entry.id === followTaskId)
    if (!task || taskActive(task)) return
    if (task.versionId && task.status === 'completed') {
      if (task.type === 'import') setSelectedInternal(task.versionId)
      if (task.type === 'external') setSelectedExternal(task.versionId)
    }
    setFollowTaskId(null)
  }, [overview, followTaskId])

  const mutate = async (action: () => Promise<WorkspaceTask | WorkspaceVersion>) => {
    setBusy(true)
    setError(null)
    return action().then(async (result) => {
      if ('stage' in result) setFollowTaskId(result.id)
      const next = await loadWorkspaces(projectId)
      setOverview(next)
      return true
    }).catch((cause: unknown) => {
      setError(errorLabel(cause))
      return false
    }).finally(() => setBusy(false))
  }

  const internal = overview?.internalVersions ?? []
  const external = (overview?.externalVersions ?? []).filter((version) => manager || version.status === 'published')
  const currentInternal = internal.find((version) => version.id === selectedInternal) ?? internal[0]
  const currentExternal = external.find((version) => version.id === selectedExternal) ?? external[0]
  const current = tab === 'internal' ? currentInternal : tab === 'external' ? currentExternal : undefined
  const versions = tab === 'internal' ? internal : external
  const tasks = (overview?.tasks ?? []).map((task) => task.versionId && overview?.externalVersions.some((version) => version.id === task.versionId && version.status === 'published') ? { ...task, message: '检查已完成，外部工作区版本已发布' } : task)
  const activeTasks = tasks.filter(taskActive)
  const failedTasks = tasks.filter((task) => task.status === 'failed' || task.status === 'interrupted')
  const taskLabel = activeTasks.length ? `${activeTasks.length} 个任务执行中` : failedTasks.length ? `任务记录（${failedTasks.length} 项异常）` : '任务记录'
  const actionDisabled = !overview || busy || running
  const openDialog = (next: WorkspaceDialog, fromMenu = false) => {
    if (fromMenu) dialogReturnFocus.current = menuTrigger.current
    setError(null)
    setDialog(next)
  }
  const restoreDialogFocus = () => dialogReturnFocus.current
  const dialogChange = (open: boolean) => { if (!open) setDialog(null) }
  const primaryLabel = tab === 'internal' ? '导入仓库' : tab === 'external' ? '生成外部版本' : '生成部署包'
  const primaryDialog = tab === 'internal' ? 'import' : tab === 'external' ? 'external' : 'packages'
  const primaryDisabled = actionDisabled || (tab === 'internal' ? overview?.import?.supported === false : !internal.length)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col border-y border-border/60" aria-label="工作区工具栏" onClickCapture={(event) => {
        const button = event.target instanceof Element ? event.target.closest('button') : null
        if (button) dialogReturnFocus.current = button
      }}>
        <div className="flex min-w-0 items-center gap-2 px-3 py-1.5">
          <ToggleGroup aria-label="工作区分类" variant="segmented" value={[tab]} onValueChange={(value) => {
            const next = value[0]
            if (next === 'internal' || next === 'external' || next === 'packages') setTab(next)
          }}>{availableTabs.map((item) => <Toggle key={item.id} value={item.id}>{item.name}</Toggle>)}</ToggleGroup>
          <span className="flex-1" />
          <FileSurfaceAction label="刷新工作区" disabled={busy} onPress={() => setRefresh((value) => value + 1)}><RefreshCwIcon /></FileSurfaceAction>
        </div>
        <div className="flex min-w-0 items-center gap-2 px-3 pb-2">
          {tab !== 'packages' ? <>
            <div className="min-w-0 flex-1 sm:max-w-72"><VersionPicker versions={versions} selected={current} onChange={tab === 'internal' ? setSelectedInternal : setSelectedExternal} label={tab === 'internal' ? '内部版本' : '外部版本'} /></div>
            {current ? <Badge size="sm" variant={current.status === 'published' ? 'success' : current.status === 'pending_review' ? 'warning' : 'error'}>{current.status === 'published' ? '可用' : current.status === 'pending_review' ? '待复核' : '失败'}</Badge> : null}
            {current ? <span className="hidden min-w-0 truncate text-xs text-muted-foreground lg:block">{current.fileCount} 个文件 · {sizeLabel(current.byteLength)}</span> : null}
          </> : <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{overview ? `${overview.releases.length} 次交付` : '部署发布'}</span>}
          <span className="hidden flex-1 sm:block" />
          <div className="hidden shrink-0 items-center gap-1 xl:flex">
            {manager ? <Button size="sm" variant="ghost" disabled={primaryDisabled} onClick={() => openDialog(primaryDialog)}>{tab === 'internal' ? <GitBranchIcon /> : tab === 'external' ? <ShieldCheckIcon /> : <PackageIcon />}{primaryLabel}</Button> : null}
            {manager && tab === 'external' && current?.report ? <Button size="sm" variant={current.status === 'pending_review' ? 'warning-outline' : 'ghost'} disabled={busy} onClick={() => openDialog('review')}><ShieldCheckIcon />{current.status === 'pending_review' ? '复核并发布' : '脱敏检查'}</Button> : null}
            {current ? <FileSurfaceAction label="版本详情" onPress={() => openDialog('version')}><InfoIcon /></FileSurfaceAction> : null}
            {manager ? <FileSurfaceAction label={taskLabel} disabled={!tasks.length} onPress={() => openDialog('tasks')}>{activeTasks.length ? <Spinner size="sm" /> : <HistoryIcon className={failedTasks.length ? 'text-destructive' : undefined} />}</FileSurfaceAction> : null}
          </div>
          {current ? <Button size="sm" variant="outline" aria-label="新建对话" disabled={current.status !== 'published'} onClick={() => startWorkspaceConversation(projectId, current)}><MessageSquarePlusIcon /><span className="hidden sm:inline">新建对话</span><span className="sm:hidden">对话</span></Button> : null}
          {manager || current ? <Menu>
            <MenuTrigger ref={menuTrigger} aria-label="工作区操作" title={manager ? taskLabel : undefined} render={<Button size="icon-sm" variant="ghost" className="xl:hidden" />}>{activeTasks.length ? <Spinner size="sm" /> : <MoreHorizontalIcon className={failedTasks.length ? 'text-destructive' : undefined} />}</MenuTrigger>
            <MenuPopup align="end">
              {manager ? <MenuItem disabled={primaryDisabled} onClick={() => openDialog(primaryDialog, true)}>{tab === 'internal' ? <GitBranchIcon /> : tab === 'external' ? <ShieldCheckIcon /> : <PackageIcon />}{primaryLabel}</MenuItem> : null}
              {manager && tab === 'external' && current?.report ? <MenuItem disabled={busy} onClick={() => openDialog('review', true)}><ShieldCheckIcon />{current.status === 'pending_review' ? '复核并发布' : '脱敏检查'}</MenuItem> : null}
              {current ? <MenuItem onClick={() => openDialog('version', true)}><InfoIcon />版本详情</MenuItem> : null}
              {manager ? <><MenuSeparator /><MenuItem disabled={!tasks.length} onClick={() => openDialog('tasks', true)}>{activeTasks.length ? <Spinner size="sm" /> : <HistoryIcon />}{taskLabel}</MenuItem></> : null}
            </MenuPopup>
          </Menu> : null}
        </div>
      </div>
      {error && !dialog ? <div className="shrink-0 border-b border-border/60 px-3 py-2"><Alert variant="error"><AlertTitle>工作区操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert><Button className="mt-2" size="xs" variant="outline" onClick={() => setRefresh((value) => value + 1)}>重新加载</Button></div> : null}
      {!overview ? error ? null : <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner size="sm" />正在读取工作区…</div> : tab === 'packages' ? <>
        <div className="shrink-0 border-b border-border/60 px-3 py-1.5"><ToggleGroup aria-label="部署发布分类" variant="segmented" value={[deploymentView]} onValueChange={(value) => { if (value[0] === 'services' || value[0] === 'packages') setDeploymentView(value[0]) }}><Toggle value="services">服务发布</Toggle><Toggle value="packages">源码包</Toggle></ToggleGroup></div>
        {deploymentView === 'services' ? <DeploymentsPanel key={`deployments:${projectId}`} projectId={projectId} packages={overview.releases} /> : <WorkspaceReleases projectId={projectId} releases={overview.releases} versions={internal} />}
      </> : current ? <FileBrowser key={`files:${current.id}`} projectId={projectId} version={current} /> : <WorkspaceEmpty title={tab === 'internal' ? '还没有内部工作区' : '还没有外部工作区'} description={tab === 'internal' ? '导入 HTTPS Git 仓库，保存原始源码、文档和原型的固定版本。' : '从内部固定版本生成，检查完成后再发布给外部对话使用。'} />}
      {manager ? <>
        <WorkspaceImportDialog open={dialog === 'import'} onOpenChange={dialogChange} finalFocus={restoreDialogFocus} disabled={actionDisabled || overview?.import?.supported === false} limits={overview?.import} error={error} onImport={(url, branch) => mutate(() => importWorkspaceRepository(projectId, url, branch, randomUUID()))} />
        <ExternalWorkspaceDialog open={dialog === 'external'} onOpenChange={dialogChange} finalFocus={restoreDialogFocus} disabled={actionDisabled} internalVersions={internal} initialSourceId={currentInternal?.id} error={error} onGenerate={(sourceId, rules) => mutate(() => generateExternalWorkspace(projectId, sourceId, rules, randomUUID()))} />
        <WorkspacePackagesDialog open={dialog === 'packages'} onOpenChange={dialogChange} finalFocus={restoreDialogFocus} disabled={actionDisabled} internalVersions={internal} initialSourceId={currentInternal?.id} error={error} onGenerate={(sourceId, services) => mutate(() => generateWorkspacePackages(projectId, sourceId, services, randomUUID()))} />
        <WorkspaceTasksDialog open={dialog === 'tasks'} onOpenChange={dialogChange} finalFocus={restoreDialogFocus} tasks={tasks} busy={busy} error={error} onCancel={(id) => mutate(() => cancelWorkspaceTask(projectId, id))} />
        {currentExternal ? <WorkspaceReviewDialog key={currentExternal.id} open={dialog === 'review'} onOpenChange={dialogChange} finalFocus={restoreDialogFocus} projectId={projectId} version={currentExternal} busy={busy} error={error} onPublish={(confirmed, excluded) => mutate(() => publishWorkspace(projectId, currentExternal.id, confirmed, excluded))} /> : null}
      </> : null}
      {current ? <WorkspaceVersionDialog open={dialog === 'version'} onOpenChange={dialogChange} finalFocus={restoreDialogFocus} version={current} /> : null}
    </div>
  )
}

function WorkspaceEmpty({ title, description }: { title: string; description: string }) {
  return <Empty size="compact"><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>
}

function VersionPicker({ versions, selected, onChange, label }: { versions: WorkspaceVersion[]; selected: WorkspaceVersion | undefined; onChange: (id: string) => void; label: string }) {
  return <Select value={selected?.id ?? ''} disabled={!versions.length} onValueChange={(value) => { if (typeof value === 'string') onChange(value) }}><SelectTrigger size="sm" aria-label={label}><SelectValue><span className="truncate">{selected?.name ?? '暂无可用版本'}</span></SelectValue></SelectTrigger><SelectPopup>{versions.map((version) => <SelectItem value={version.id} key={version.id}>{version.name}{version.status === 'pending_review' ? ' · 待复核' : version.status === 'failed' ? ' · 失败' : ''}{version.isExample ? ' · 示例项目' : ''}</SelectItem>)}</SelectPopup></Select>
}

function FileBrowser({ projectId, version }: { projectId: string; version: WorkspaceVersion }) {
  const environmentId = usePrimaryEnvironmentId()
  const [selected, setSelected] = useState<string | null>(null)
  const [trail, setTrail] = useState<string | undefined>(undefined)
  const source = useMemo<ReadOnlyFileSource>(() => ({
    id: `management:${projectId}:${version.id}`,
    allowReferences: false,
    mentionPath: (path) => `autoops/${projectId}/workspaces/${version.id}/${path}`,
    list: (directory) => loadWorkspaceTree(projectId, version.id, directory),
    search: (query, limit) => searchWorkspaceFiles(projectId, version.id, query, limit),
    async metadata(path) {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      const directory = await loadWorkspaceTree(projectId, version.id, parent)
      const entry = directory.entries.find((item) => item.path === path)
      if (entry?.kind === 'directory') return { kind: 'directory' as const }
      const metadata = await loadWorkspaceFileMetadata(projectId, version.id, path)
      return { kind: 'file' as const, name: metadata.name, mimeType: metadata.mime, sizeBytes: metadata.size, url: workspaceFileDownloadUrl(projectId, version.id, path) }
    },
  }), [projectId, version.id])
  if (!environmentId) return <WorkspaceEmpty title="文件连接不可用" description="请重新连接工作台后重试。" />
  return <section className="flex min-h-0 min-w-0 flex-1 overflow-hidden" aria-label={`${version.name} 文件浏览`}>
    <ReadOnlyWorkspaceFiles environmentId={environmentId} cwd={source.id} projectName={version.name} relativePath={selected} source={source}
      folderTrail={trail} onOpenFile={(path) => { setSelected(path); setTrail(undefined) }}
      onNavigateFolder={(path, nextTrail) => { setSelected(path || null); setTrail(nextTrail) }}
    />
  </section>
}

function WorkspaceReleases({ projectId, releases, versions }: { projectId: string; releases: WorkspaceRelease[]; versions: WorkspaceVersion[] }) {
  const [selectedId, setSelectedId] = useState('')
  const [manifestOpen, setManifestOpen] = useState(false)
  const manifestTrigger = useRef<HTMLButtonElement | null>(null)
  const selected = releases.find((release) => release.id === selectedId) ?? releases[0]
  if (!selected) return <WorkspaceEmpty title="还没有部署包" description="选择内部版本，按需生成前端、后端或两者的源码包。" />
  const sourceName = versions.find((version) => version.id === selected.sourceVersionId)?.name ?? selected.sourceVersionId
  return <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" aria-label="部署交付">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col md:w-80 md:flex-none md:border-r md:border-border/60">
      <div className={FILE_SURFACE_SUBHEADER_CLASS}><span className="min-w-0 flex-1 truncate text-xs font-medium">交付记录</span></div>
      <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
        <div className="flex flex-col divide-y divide-border/60">{releases.map((release) => <Button key={release.id} size="sm-multiline" variant="ghost" className="h-auto min-w-0 justify-start rounded-none px-3 py-2.5 text-left" aria-pressed={release.id === selected.id} data-pressed={release.id === selected.id || undefined} onClick={() => setSelectedId(release.id)}>
          <PackageIcon className="self-start" /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{release.name}</span><time dateTime={release.createdAt} className="mt-1 block truncate text-xs font-normal text-muted-foreground">{dateLabel(release.createdAt)}</time></span>
        </Button>)}</div>
      </ScrollArea>
      <div className="flex shrink-0 flex-col gap-2 border-t border-border/60 px-3 py-3">
        <p className="truncate text-xs text-muted-foreground" title={sourceName}>来源：{sourceName}</p>
        {selected.services.map((service) => <div key={service.service} className="flex min-w-0 items-center gap-2"><Button size="sm" variant="outline" className="min-w-0 flex-1" render={<a href={workspacePackageUrl(projectId, selected.id, service.service)} download />}><ArrowDownToLineIcon />{service.service === 'frontend' ? '下载前端 ZIP' : '下载后端 ZIP'}</Button><span className="shrink-0 text-xs text-muted-foreground">{sizeLabel(service.size)}</span></div>)}
        <Button ref={manifestTrigger} size="sm" variant="ghost" className="md:hidden" onClick={() => setManifestOpen(true)}><FileJsonIcon />查看交付清单</Button>
      </div>
    </div>
    <section className="hidden min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex" aria-label="交付清单预览">
      <ManifestPreview key={selected.id} projectId={projectId} release={selected} />
    </section>
    <Dialog open={manifestOpen} onOpenChange={setManifestOpen}><DialogPopup finalFocus={() => manifestTrigger.current} className="h-[min(48rem,90dvh)] max-w-4xl gap-0"><DialogHeader><DialogTitle>交付清单</DialogTitle></DialogHeader><div className="flex min-h-0 flex-1 flex-col overflow-hidden"><ManifestPreview key={selected.id} projectId={projectId} release={selected} /></div></DialogPopup></Dialog>
  </div>
}

function ManifestPreview({ projectId, release }: { projectId: string; release: WorkspaceRelease }) {
  return <><div className={FILE_SURFACE_SUBHEADER_CLASS}><FileJsonIcon className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-xs">manifest.json</span><Button size="icon-sm" variant="ghost" aria-label="下载交付清单" render={<a href={workspacePackageUrl(projectId, release.id, 'manifest')} download />}><ArrowDownToLineIcon /></Button></div><div className="flex min-h-0 min-w-0 flex-1 overflow-hidden"><ReadOnlySourcePreview name="manifest.json" text={JSON.stringify(release.manifest, null, 2)} /></div></>
}
