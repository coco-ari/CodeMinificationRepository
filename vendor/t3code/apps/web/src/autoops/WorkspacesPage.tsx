import {
  WorkspaceAuthoring,
  WorkspaceAuthoringNavigation,
  type WorkspaceSection,
} from './WorkspaceAuthoringPanel'
import { WorkspaceFileBrowser } from './WorkspaceFileBrowser'
import { readSelection, saveSelection } from './workspaceViewState'
import { useWorkspaceOverview } from './useWorkspaceOverview'
import { useWorkspaceTaskSubmission } from './useWorkspaceTaskSubmission'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { useEffect, useRef, useState } from 'react'
import {
  GitBranchIcon,
  HistoryIcon,
  InfoIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  RocketIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import {
  ModuleHeader,
  ModuleSidebar,
  ModuleSidebarItem,
  ModuleSidebarEmpty,
} from './ModuleWorkspace'
import { ScrollArea } from '~/components/ui/scroll-area'
import { SidebarInset } from '~/components/ui/sidebar'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '~/components/ui/menu'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Spinner } from '~/components/ui/spinner'
import { readAutoOpsHost } from './hostConfig'
import { useAutoOpsProjectId } from './projectNavigation'
import { FileSurfaceAction } from '~/components/files/fileSurfaceChrome'
import {
  ExternalWorkspaceDialog,
  WorkspaceImportDialog,
  WorkspaceReviewDialog,
  WorkspaceTasksDialog,
  WorkspaceVersionDialog,
  WorkspaceSubmissionNotice,
} from './WorkspaceActions'
import {
  cancelWorkspaceTask,
  publishWorkspace,
  startWorkspaceConversation,
  type WorkspaceTask,
  type WorkspaceVersion,
} from './workspaces'

const tabs = [
  { id: 'internal', name: '内部工作区' },
  { id: 'external', name: '外部工作区' },
] as const
type Tab = (typeof tabs)[number]['id']
type WorkspaceDialog = 'import' | 'external' | 'version' | 'tasks' | 'review' | null
const sizeLabel = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`
const errorLabel = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。'
const taskActive = (task: WorkspaceTask) => task.status === 'queued' || task.status === 'running'
export function AutoOpsWorkspacesPage() {
  const projectId = useAutoOpsProjectId()
  const project = readAutoOpsHost()?.projects.find((entry) => entry.id === projectId)
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const versionId =
    search.versionId === undefined
      ? undefined
      : typeof search.versionId === 'string' && search.versionId
        ? search.versionId
        : null
  return (
    <SidebarInset
      className="h-dvh min-h-0 min-w-0 overflow-hidden overscroll-y-none"
      aria-label="项目工作区"
      data-testid="workspace-page"
    >
      {!project || project.capabilities?.['workspace.read'] !== true ? (
        <>
          <ModuleHeader title="工作区" />
          <ModuleSidebar label="工作区版本">
            <ModuleSidebarEmpty>请先选择有权访问的项目。</ModuleSidebarEmpty>
          </ModuleSidebar>
        </>
      ) : null}
      {project?.capabilities?.['workspace.read'] === true ? (
        <ProjectWorkspaces
          key={`${readAutoOpsHost()?.principal.id}:${projectId}:${versionId === undefined ? 'remembered' : versionId === null ? 'invalid' : versionId}`}
          projectId={projectId}
          requestedVersionId={versionId}
        />
      ) : (
        <div className="flex min-h-0 flex-1" data-testid="project-unavailable">
          <WorkspaceEmpty
            title="项目不可用或无权访问"
            description="请通过项目导航选择有权访问的项目。"
          />
        </div>
      )}
    </SidebarInset>
  )
}

function ProjectWorkspaces({
  projectId,
  requestedVersionId,
}: {
  projectId: string
  requestedVersionId: string | null | undefined
}) {
  const navigate = useNavigate()
  const membership = readAutoOpsHost()?.projects.find(
    (project) => project.id === projectId,
  )?.membership
  const manager =
    readAutoOpsHost()?.projects.find((project) => project.id === projectId)?.capabilities?.[
      'workspace.manage'
    ] === true
  const externalOnly = membership?.workspaceAccess === 'external'
  const [section, setSection] = useState<WorkspaceSection>(() => {
    if (externalOnly || requestedVersionId !== undefined) return 'versions'
    const saved = readSelection(`${projectId}:section`)
    return saved === 'sources' || saved === 'versions' ? saved : 'current'
  })
  const chooseSection = (next: WorkspaceSection) => {
    saveSelection(`${projectId}:section`, next)
    setSection(next)
    if (requestedVersionId !== undefined && next !== 'versions')
      void navigate({
        to: '/workspaces',
        search: { projectId: ProjectId.make(projectId) },
        replace: true,
      })
  }
  const [versionQuery, setVersionQuery] = useState('')
  const [selectedTab, setTab] = useState<Tab>(() =>
    externalOnly || readSelection(`${projectId}:tab`) === 'external' ? 'external' : 'internal',
  )
  const tab = externalOnly ? 'external' : selectedTab
  const availableTabs = tabs.filter((item) => !externalOnly || item.id === 'external')
  const { overview, loadError, refreshOverview } = useWorkspaceOverview(projectId)
  const [actionError, setError] = useState<string | null>(null)
  const [mutationBusy, setBusy] = useState(false)
  const [selectedInternal, setSelectedInternal] = useState(
    () => readSelection(`${projectId}:internal-version`) ?? '',
  )
  const [selectedExternal, setSelectedExternal] = useState(
    () => readSelection(`${projectId}:external-version`) ?? '',
  )
  const [requestApplied, setRequestApplied] = useState(requestedVersionId === undefined)
  const [invalidVersion, setInvalidVersion] = useState(requestedVersionId === null)
  const [dialog, setDialog] = useState<WorkspaceDialog>(null)
  const dialogReturnFocus = useRef<HTMLElement | null>(null)
  const menuTrigger = useRef<HTMLButtonElement | null>(null)
  const [followTaskId, setFollowTaskId] = useState<string | null>(null)
  const submission = useWorkspaceTaskSubmission(projectId, (task) => {
    setFollowTaskId(task.id)
    setDialog(null)
    refreshOverview()
  })
  const busy = mutationBusy || submission.busy
  const error = submission.error ?? actionError ?? loadError
  const submissionNotice = (
    <WorkspaceSubmissionNotice
      label={submission.pendingLabel}
      retryAvailable={submission.retryAvailable && manager}
      busy={busy}
      onCheck={submission.check}
      onRetry={submission.retry}
    />
  )
  const running = overview?.tasks.some(taskActive) ?? false
  useEffect(() => {
    saveSelection(`${projectId}:tab`, tab)
  }, [projectId, tab])
  useEffect(() => {
    if (!overview || requestApplied) return
    const version = [...overview.internalVersions, ...overview.externalVersions].find(
      (entry) =>
        entry.id === requestedVersionId &&
        (!externalOnly || (entry.type === 'external' && entry.status === 'published')),
    )
    if (version) {
      setTab(version.type)
      if (version.type === 'internal') setSelectedInternal(version.id)
      else setSelectedExternal(version.id)
    } else setInvalidVersion(true)
    setRequestApplied(true)
  }, [overview, requestApplied, requestedVersionId, externalOnly])
  useEffect(() => {
    const task = overview?.tasks.find((entry) => entry.id === followTaskId)
    if (!task || taskActive(task)) return
    if (task.versionId && task.status === 'completed') {
      if (task.type === 'import' || task.type === 'snapshot') setSelectedInternal(task.versionId)
      if (task.type === 'external') setSelectedExternal(task.versionId)
      setInvalidVersion(false)
    }
    setFollowTaskId(null)
  }, [overview, followTaskId])
  const internal = overview?.internalVersions ?? []
  const external = (overview?.externalVersions ?? []).filter(
    (version) => manager || version.status === 'published',
  )
  const currentInternal = internal.find((version) => version.id === selectedInternal) ?? internal[0]
  const currentExternal = external.find((version) => version.id === selectedExternal) ?? external[0]
  const current =
    requestApplied && !invalidVersion
      ? tab === 'internal'
        ? currentInternal
        : currentExternal
      : undefined
  const versions = tab === 'internal' ? internal : external
  useEffect(() => {
    if (requestApplied && !invalidVersion && currentInternal)
      saveSelection(`${projectId}:internal-version`, currentInternal.id)
  }, [projectId, requestApplied, invalidVersion, currentInternal])
  useEffect(() => {
    if (requestApplied && !invalidVersion && currentExternal)
      saveSelection(`${projectId}:external-version`, currentExternal.id)
  }, [projectId, requestApplied, invalidVersion, currentExternal])
  const tasks = (overview?.tasks ?? [])
    .filter((task) => task.type !== 'packages')
    .map((task) =>
      task.versionId &&
      overview?.externalVersions.some(
        (version) => version.id === task.versionId && version.status === 'published',
      )
        ? { ...task, message: '检查已完成，外部工作区版本已发布' }
        : task,
    )
  const activeTasks = tasks.filter(taskActive)
  const failedTasks = tasks.filter(
    (task) => task.status === 'failed' || task.status === 'interrupted',
  )
  const taskLabel = activeTasks.length
    ? `${activeTasks.length} 个任务执行中`
    : failedTasks.length
      ? `任务记录（${failedTasks.length} 项异常）`
      : '任务记录'
  const actionDisabled = !overview || busy || running
  const openDialog = (next: WorkspaceDialog, fromMenu = false) => {
    if (fromMenu) dialogReturnFocus.current = menuTrigger.current
    setError(null)
    setDialog(next)
  }
  const restoreDialogFocus = () => dialogReturnFocus.current
  const dialogChange = (open: boolean) => {
    if (!open) setDialog(null)
  }
  const primaryLabel = tab === 'internal' ? '导入仓库' : '生成外部版本'
  const primaryDialog = tab === 'internal' ? 'import' : 'external'
  const primaryDisabled =
    actionDisabled ||
    (tab === 'internal' ? overview?.import?.supported === false : !internal.length)
  const chooseVersion = (id: string) => {
    saveSelection(`${projectId}:section`, 'versions')
    setInvalidVersion(false)
    if (tab === 'internal') setSelectedInternal(id)
    else setSelectedExternal(id)
    void navigate({
      to: '/workspaces',
      search: { projectId: ProjectId.make(projectId), versionId: id },
      replace: true,
    })
  }
  const mutate = async (action: () => Promise<WorkspaceTask | WorkspaceVersion>) => {
    setBusy(true)
    setError(null)
    return action()
      .then(async (result) => {
        if ('stage' in result) setFollowTaskId(result.id)
        refreshOverview()
        return true
      })
      .catch((cause: unknown) => {
        setError(errorLabel(cause))
        return false
      })
      .finally(() => setBusy(false))
  }
  const sourceLink =
    current && manager && tab === 'internal' && current.status === 'published' ? (
      <Link
        to="/deployments"
        search={{ projectId: ProjectId.make(projectId), sourceVersionId: current.id }}
      >
        从此版本部署
      </Link>
    ) : null
  if (!externalOnly && section !== 'versions')
    return (
      <WorkspaceAuthoring
        projectId={projectId}
        section={section}
        manager={manager}
        onSection={chooseSection}
        onAccepted={(receipt) => {
          if ('task' in receipt) {
            setFollowTaskId(receipt.task.id)
            setTab('internal')
            chooseSection('versions')
            refreshOverview()
          }
        }}
      />
    )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ModuleSidebar
        label="固定版本"
        search={{ value: versionQuery, onChange: setVersionQuery, label: '搜索工作区版本' }}
        header={
          <>
            {!externalOnly ? (
              <WorkspaceAuthoringNavigation section="versions" onChange={chooseSection} />
            ) : null}
            <ToggleGroup
              aria-label="工作区分类"
              variant="segmented"
              value={[tab]}
              onValueChange={(value) => {
                const next = value[0]
                if (next === 'internal' || next === 'external') {
                  saveSelection(`${projectId}:tab`, next)
                  setTab(next)
                  setInvalidVersion(false)
                  if (requestedVersionId !== undefined)
                    void navigate({
                      to: '/workspaces',
                      search: { projectId: ProjectId.make(projectId) },
                      replace: true,
                    })
                }
              }}
            >
              {availableTabs.map((item) => (
                <Toggle key={item.id} value={item.id}>
                  {item.name}
                </Toggle>
              ))}
            </ToggleGroup>
          </>
        }
      >
        <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
          <div className="px-[var(--sidebar-content-inset)]">
            {versions
              .filter((version) =>
                version.name.toLocaleLowerCase().includes(versionQuery.toLocaleLowerCase()),
              )
              .map((version) => (
                <ModuleSidebarItem
                  key={version.id}
                  label={version.name}
                  icon={tab === 'internal' ? GitBranchIcon : ShieldCheckIcon}
                  description={`${version.fileCount} 个文件 · ${version.status === 'published' ? '可用' : version.status === 'pending_review' ? '待复核' : '失败'}`}
                  selected={version.id === current?.id}
                  onClick={() => chooseVersion(version.id)}
                />
              ))}
            {!versions.length ? (
              <ModuleSidebarEmpty>
                {overview ? '当前区域还没有工作区版本。' : '正在读取工作区…'}
              </ModuleSidebarEmpty>
            ) : null}
            {versions.length > 0 &&
            !versions.some((version) =>
              version.name.toLocaleLowerCase().includes(versionQuery.toLocaleLowerCase()),
            ) ? (
              <ModuleSidebarEmpty>没有匹配的版本。</ModuleSidebarEmpty>
            ) : null}
          </div>
        </ScrollArea>
      </ModuleSidebar>
      <div
        className="shrink-0"
        aria-label="工作区工具栏"
        onClickCapture={(event) => {
          const button = event.target instanceof Element ? event.target.closest('button') : null
          if (button) dialogReturnFocus.current = button
        }}
      >
        <ModuleHeader
          title="工作区"
          detail={current?.name}
          actions={
            <FileSurfaceAction label="刷新工作区" disabled={busy} onPress={() => refreshOverview()}>
              <RefreshCwIcon />
            </FileSurfaceAction>
          }
        ></ModuleHeader>
        <div className="flex min-h-10 min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
          <span className="truncate text-xs text-muted-foreground">
            {tab === 'internal' ? '内部工作区' : '外部工作区'}
          </span>
          {current ? (
            <Badge
              size="sm"
              variant={
                current.status === 'published'
                  ? 'success'
                  : current.status === 'pending_review'
                    ? 'warning'
                    : 'error'
              }
            >
              {current.status === 'published'
                ? '可用'
                : current.status === 'pending_review'
                  ? '待复核'
                  : '失败'}
            </Badge>
          ) : null}
          {current ? (
            <span className="hidden min-w-0 truncate text-xs text-muted-foreground lg:block">
              {current.fileCount} 个文件 · {sizeLabel(current.byteLength)}
            </span>
          ) : null}
          <span className="hidden flex-1 sm:block" />
          <div className="hidden shrink-0 items-center gap-1 xl:flex">
            {manager ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={primaryDisabled}
                onClick={() => openDialog(primaryDialog)}
              >
                {tab === 'internal' ? <GitBranchIcon /> : <ShieldCheckIcon />}
                {primaryLabel}
              </Button>
            ) : null}
            {manager && tab === 'external' && current?.report ? (
              <Button
                size="sm"
                variant={current.status === 'pending_review' ? 'warning-outline' : 'ghost'}
                disabled={busy}
                onClick={() => openDialog('review')}
              >
                <ShieldCheckIcon />
                {current.status === 'pending_review' ? '复核并发布' : '脱敏检查'}
              </Button>
            ) : null}
            {sourceLink ? (
              <Button size="sm" variant="ghost" render={sourceLink}>
                <RocketIcon />
                从此版本部署
              </Button>
            ) : null}
            {current ? (
              <FileSurfaceAction label="版本详情" onPress={() => openDialog('version')}>
                <InfoIcon />
              </FileSurfaceAction>
            ) : null}
            {manager ? (
              <FileSurfaceAction
                label={taskLabel}
                disabled={!tasks.length}
                onPress={() => openDialog('tasks')}
              >
                {activeTasks.length ? (
                  <Spinner size="sm" />
                ) : (
                  <HistoryIcon className={failedTasks.length ? 'text-destructive' : undefined} />
                )}
              </FileSurfaceAction>
            ) : null}
          </div>
          {current ? (
            <Button
              size="sm"
              variant="outline"
              aria-label="新建对话"
              disabled={current.status !== 'published'}
              onClick={() => startWorkspaceConversation(projectId, current)}
            >
              <MessageSquarePlusIcon />
              <span className="hidden sm:inline">新建对话</span>
              <span className="sm:hidden">对话</span>
            </Button>
          ) : null}
          {manager || current ? (
            <Menu>
              <MenuTrigger
                ref={menuTrigger}
                aria-label="工作区操作"
                title={manager ? taskLabel : undefined}
                render={<Button size="icon-sm" variant="ghost" className="xl:hidden" />}
              >
                {activeTasks.length ? (
                  <Spinner size="sm" />
                ) : (
                  <MoreHorizontalIcon
                    className={failedTasks.length ? 'text-destructive' : undefined}
                  />
                )}
              </MenuTrigger>
              <MenuPopup align="end">
                {manager ? (
                  <MenuItem
                    disabled={primaryDisabled}
                    onClick={() => openDialog(primaryDialog, true)}
                  >
                    {tab === 'internal' ? <GitBranchIcon /> : <ShieldCheckIcon />}
                    {primaryLabel}
                  </MenuItem>
                ) : null}
                {manager && tab === 'external' && current?.report ? (
                  <MenuItem disabled={busy} onClick={() => openDialog('review', true)}>
                    <ShieldCheckIcon />
                    {current.status === 'pending_review' ? '复核并发布' : '脱敏检查'}
                  </MenuItem>
                ) : null}
                {sourceLink ? (
                  <MenuItem render={sourceLink}>
                    <RocketIcon />
                    从此版本部署
                  </MenuItem>
                ) : null}
                {current ? (
                  <MenuItem onClick={() => openDialog('version', true)}>
                    <InfoIcon />
                    版本详情
                  </MenuItem>
                ) : null}
                {manager ? (
                  <>
                    <MenuSeparator />
                    <MenuItem disabled={!tasks.length} onClick={() => openDialog('tasks', true)}>
                      {activeTasks.length ? <Spinner size="sm" /> : <HistoryIcon />}
                      {taskLabel}
                    </MenuItem>
                  </>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>
      {error && !dialog ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2">
          <Alert variant="error">
            <AlertTitle>工作区操作未完成</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Button className="mt-2" size="xs" variant="outline" onClick={() => refreshOverview()}>
            重新加载
          </Button>
        </div>
      ) : null}
      {overview?.tasks.some((task) => task.type === 'packages' && taskActive(task)) ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
          源码包正在生成，可在{' '}
          <Link
            className="underline underline-offset-2"
            to="/deployments"
            search={{ projectId: ProjectId.make(projectId) }}
          >
            部署
          </Link>{' '}
          中查看任务。
        </div>
      ) : null}
      {!dialog && submission.pendingLabel ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2">{submissionNotice}</div>
      ) : null}
      {!overview || !requestApplied ? (
        error ? null : (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" />
            正在读取工作区…
          </div>
        )
      ) : invalidVersion ? (
        <WorkspaceEmpty
          title="指定版本不可用或无权访问"
          description="请选择有权访问的工作区版本；不会自动改用其他来源。"
        />
      ) : current ? (
        <WorkspaceFileBrowser key={`files:${current.id}`} projectId={projectId} version={current} />
      ) : (
        <WorkspaceEmpty
          title={tab === 'internal' ? '还没有内部工作区' : '还没有外部工作区'}
          description={
            tab === 'internal'
              ? '导入 HTTPS Git 仓库，保存原始源码、文档和原型的固定版本。'
              : '从内部固定版本生成，检查完成后再发布给外部对话使用。'
          }
        />
      )}
      {manager ? (
        <>
          <WorkspaceImportDialog
            open={dialog === 'import'}
            onOpenChange={dialogChange}
            finalFocus={restoreDialogFocus}
            disabled={actionDisabled || overview?.import?.supported === false}
            limits={overview?.import}
            submissionNotice={submissionNotice}
            error={error}
            onImport={(url, branch) =>
              submission.submit({ type: 'import', repositoryUrl: url, branch })
            }
          />
          <ExternalWorkspaceDialog
            open={dialog === 'external'}
            onOpenChange={dialogChange}
            finalFocus={restoreDialogFocus}
            disabled={actionDisabled}
            internalVersions={internal}
            initialSourceId={currentInternal?.id}
            submissionNotice={submissionNotice}
            error={error}
            onGenerate={(sourceId, rules) =>
              submission.submit({ type: 'external', sourceVersionId: sourceId, rules })
            }
          />
          <WorkspaceTasksDialog
            open={dialog === 'tasks'}
            onOpenChange={dialogChange}
            finalFocus={restoreDialogFocus}
            tasks={tasks}
            busy={busy}
            error={error}
            onCancel={(id) => mutate(() => cancelWorkspaceTask(projectId, id))}
          />
          {currentExternal ? (
            <WorkspaceReviewDialog
              key={currentExternal.id}
              open={dialog === 'review'}
              onOpenChange={dialogChange}
              finalFocus={restoreDialogFocus}
              projectId={projectId}
              version={currentExternal}
              busy={busy}
              error={error}
              onPublish={(confirmed, excluded) =>
                mutate(() => publishWorkspace(projectId, currentExternal.id, confirmed, excluded))
              }
            />
          ) : null}
        </>
      ) : null}
      {current ? (
        <WorkspaceVersionDialog
          open={dialog === 'version'}
          onOpenChange={dialogChange}
          finalFocus={restoreDialogFocus}
          version={current}
        />
      ) : null}
    </div>
  )
}

function WorkspaceEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
