import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import {
  HistoryIcon,
  InfoIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import { SidebarInset } from '~/components/ui/sidebar'
import { Button } from '~/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '~/components/ui/menu'
import { toastManager } from '~/components/ui/toast'
import { workspaceFailureMessage } from './workspaceFeedback'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Spinner } from '~/components/ui/spinner'
import { FileSurfaceAction } from '~/components/files/fileSurfaceChrome'
import { ModuleHeader, ModuleSidebar } from './ModuleWorkspace'
import { WorkspaceAuthoring, type WorkspaceSection } from './WorkspaceAuthoringPanel'
import { WorkspaceFileBrowser } from './WorkspaceFileBrowser'
import { readSelection, saveSelection } from './workspaceViewState'
import { useWorkspaceOverview } from './useWorkspaceOverview'
import { useWorkspaceTaskSubmission } from './useWorkspaceTaskSubmission'
import { readAutoOpsHost } from './hostConfig'
import { useAutoOpsProjectId } from './projectNavigation'
import {
  ExternalWorkspaceDialog,
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

const taskActive = (task: WorkspaceTask) => task.status === 'queued' || task.status === 'running'
type Dialog = 'external' | 'tasks' | 'review' | 'detail' | null
export function AutoOpsWorkspacesPage() {
  const projectId = useAutoOpsProjectId()
  const host = readAutoOpsHost()
  const project = host?.projects.find((entry) => entry.id === projectId)
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const historicalId =
    search.versionId === undefined
      ? undefined
      : typeof search.versionId === 'string'
        ? search.versionId
        : ''
  return (
    <SidebarInset
      className="h-dvh min-h-0 min-w-0 overflow-hidden overscroll-y-none"
      aria-label="项目工作区"
      data-testid="workspace-page"
    >
      {project?.capabilities?.['workspace.read'] === true ? (
        <ProjectWorkspaces
          key={`${host?.principal.id}:${projectId}:${historicalId ?? 'current'}`}
          projectId={projectId}
          historicalId={historicalId}
        />
      ) : (
        <>
          <ModuleHeader title="工作区" />
          <WorkspaceEmpty
            title="项目不可用或无权访问"
            description="请通过项目导航选择有权访问的项目。"
          />
        </>
      )}
    </SidebarInset>
  )
}
function ProjectWorkspaces({
  projectId,
  historicalId,
}: {
  projectId: string
  historicalId: string | undefined
}) {
  const navigate = useNavigate()
  const project = readAutoOpsHost()?.projects.find((entry) => entry.id === projectId)
  const manager = project?.capabilities?.['workspace.manage'] === true
  const externalOnly = project?.membership?.workspaceAccess === 'external'
  const [tab, setTab] = useState<'internal' | 'external'>(
    externalOnly || readSelection(`${projectId}:tab`) === 'external' ? 'external' : 'internal',
  )
  const [section, setSection] = useState<WorkspaceSection>(
    readSelection(`${projectId}:section`) === 'sources' ? 'sources' : 'current',
  )
  const { overview, loadError, refreshOverview } = useWorkspaceOverview(projectId)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [mutationBusy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewReview, setPreviewReview] = useState(false)
  const dialogFocus = useRef<HTMLElement | null>(null)
  const externalMenuFocus = useRef<HTMLButtonElement | null>(null)
  const [followTaskId, setFollowTaskId] = useState<string | null>(null)
  const submission = useWorkspaceTaskSubmission(projectId, (task) => {
    setFollowTaskId(task.id)
    setDialog(null)
    refreshOverview()
  })
  const tasks = (overview?.tasks ?? []).filter((task) => task.type !== 'packages')
  const running = tasks.some(taskActive)
  const busy = mutationBusy || submission.busy
  const taskRevision = tasks.map((task) => `${task.id}:${task.status}`).join(':')
  const latestPublished = overview?.externalVersions.find(
    (version) => version.status === 'published',
  )
  const pendingReview = manager
    ? overview?.externalVersions.find((version) => version.status === 'pending_review')
    : undefined
  const historical =
    historicalId !== undefined
      ? [...(overview?.internalVersions ?? []), ...(overview?.externalVersions ?? [])].find(
          (version) =>
            version.id === historicalId &&
            (!externalOnly || (version.type === 'external' && version.status === 'published')),
        )
      : undefined
  const current =
    historicalId !== undefined
      ? historical
      : previewReview && pendingReview
        ? pendingReview
        : latestPublished
  const open = (next: Dialog) => {
    dialogFocus.current =
      next === 'external'
        ? externalMenuFocus.current
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
    setError(null)
    setDialog(next)
  }
  const returnCurrent = () =>
    void navigate({
      to: '/workspaces',
      search: { projectId: ProjectId.make(projectId) },
      replace: true,
    })
  useEffect(() => {
    const task = tasks.find((entry) => entry.id === followTaskId)
    if (!task || taskActive(task)) return
    if (task.status === 'completed') {
      toastManager.add({
        type: 'success',
        title: task.type === 'external' ? '外部资料已生成，请复核发布' : '源码同步成功',
      })
      if (task.type === 'external') {
        setTab('external')
        setPreviewReview(true)
      }
    } else {
      setError(workspaceFailureMessage(task.failureCode, task.error ?? '操作失败，请重试。'))
    }
    setFollowTaskId(null)
  }, [tasks, followTaskId])
  const mutate = async (operation: () => Promise<WorkspaceTask | WorkspaceVersion>) => {
    if (busy) return false
    setBusy(true)
    setError(null)
    try {
      await operation()
      refreshOverview()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。')
      return false
    } finally {
      setBusy(false)
    }
  }
  const navigation = (
    <ToggleGroup
      aria-label="工作区分类"
      variant="segmented"
      value={[externalOnly ? 'external' : tab]}
      onValueChange={(value) => {
        const next = value[0]
        if (next !== 'internal' && next !== 'external') return
        if (externalOnly && next !== 'external') return
        saveSelection(`${projectId}:tab`, next)
        setTab(next)
        setPreviewReview(false)
        if (historicalId !== undefined) returnCurrent()
      }}
    >
      {!externalOnly ? <Toggle value="internal">内部工作区</Toggle> : null}
      <Toggle value="external">外部工作区</Toggle>
    </ToggleGroup>
  )
  const taskLabel = running ? '任务执行中' : '任务记录'
  const actions = (
    <>
      {manager ? (
        <FileSurfaceAction label={taskLabel} onPress={() => open('tasks')}>
          {running ? <Spinner size="sm" /> : <HistoryIcon />}
        </FileSurfaceAction>
      ) : null}
      <FileSurfaceAction
        label="新建对话"
        disabled={tab === 'external' && !latestPublished}
        onPress={() =>
          startWorkspaceConversation(
            projectId,
            externalOnly ? 'external' : (historical?.type ?? tab),
          )
        }
      >
        <MessageSquarePlusIcon />
      </FileSurfaceAction>
    </>
  )
  const notice = (
    <WorkspaceSubmissionNotice
      label={submission.pendingLabel}
      paused={submission.recoveryPaused}
      retryAvailable={submission.retryAvailable && manager}
      busy={busy}
      onCheck={submission.check}
      onRetry={submission.retry}
    />
  )
  const combinedError = error ?? submission.error ?? loadError
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {combinedError && !dialog ? (
        <div className="shrink-0 border-b px-3 py-2">
          <Alert variant="error">
            <AlertTitle>工作区操作未完成</AlertTitle>
            <AlertDescription>{combinedError}</AlertDescription>
          </Alert>
          {loadError ? (
            <Button size="xs" variant="outline" className="mt-2" onClick={refreshOverview}>
              重试
            </Button>
          ) : null}
        </div>
      ) : null}
      {!dialog && submission.pendingLabel ? (
        <div className="shrink-0 border-b px-3 py-2">{notice}</div>
      ) : null}
      {!externalOnly && tab === 'internal' && historicalId === undefined ? (
        <WorkspaceAuthoring
          projectId={projectId}
          manager={manager}
          section={section}
          navigation={navigation}
          actions={actions}
          taskRevision={taskRevision}
          taskActive={running}
          onSection={(next) => {
            saveSelection(`${projectId}:section`, next)
            setSection(next)
          }}
          onAccepted={(receipt) => {
            if ('task' in receipt) {
              setError(null)
              setFollowTaskId(receipt.task.id)
              refreshOverview()
            }
          }}
        />
      ) : (
        <>
          <ModuleSidebar label="工作区" header={navigation}>
            {null}
          </ModuleSidebar>
          <ModuleHeader
            title="工作区"
            detail={historicalId !== undefined ? '历史资料' : '外部工作区'}
            actions={
              <>
                {actions}
                <FileSurfaceAction label="刷新工作区" disabled={busy} onPress={refreshOverview}>
                  <RefreshCwIcon />
                </FileSurfaceAction>
              </>
            }
          />
          <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {historicalId !== undefined
                ? (current?.name ?? '历史资料')
                : previewReview && pendingReview
                  ? '待复核内容'
                  : latestPublished
                    ? '当前已发布内容'
                    : '尚未发布外部内容'}
            </span>
            {historicalId !== undefined ? (
              <Button size="sm" variant="outline" onClick={returnCurrent}>
                返回当前工作区
              </Button>
            ) : (
              <>
                {manager ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || running || !overview}
                    onClick={() => {
                      setError(null)
                      if (pendingReview) {
                        setPreviewReview(true)
                        open('review')
                      } else void submission.submit({ type: 'external', rules: [] })
                    }}
                  >
                    {busy || running
                      ? '正在处理…'
                      : pendingReview
                        ? '复核并发布'
                        : '更新外部工作区'}
                  </Button>
                ) : null}
                {manager ? (
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          ref={externalMenuFocus}
                          size="icon-sm"
                          variant="ghost"
                          aria-label="外部工作区操作"
                        />
                      }
                    >
                      <MoreHorizontalIcon />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      {pendingReview ? (
                        <MenuItem onClick={() => setPreviewReview(!previewReview)}>
                          {previewReview ? '查看已发布内容' : '查看待复核内容'}
                        </MenuItem>
                      ) : null}
                      {pendingReview ? (
                        <MenuItem
                          disabled={busy || running}
                          onClick={() => {
                            setError(null)
                            void submission.submit({ type: 'external', rules: [] })
                          }}
                        >
                          重新生成
                        </MenuItem>
                      ) : null}
                      <MenuItem
                        disabled={busy || running || !overview}
                        onClick={() => open('external')}
                      >
                        自定义脱敏
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                ) : null}
                {manager && current?.report && current.status !== 'pending_review' ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => open('review')}>
                    <ShieldCheckIcon />
                    脱敏检查
                  </Button>
                ) : null}
              </>
            )}
            {current ? (
              <FileSurfaceAction label="来源详情" onPress={() => open('detail')}>
                <InfoIcon />
              </FileSurfaceAction>
            ) : null}
          </div>
          {!overview ? (
            combinedError ? null : (
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            )
          ) : current ? (
            <WorkspaceFileBrowser
              key={`files:${current.id}`}
              projectId={projectId}
              version={current}
            />
          ) : (
            <WorkspaceEmpty
              title={
                historicalId !== undefined ? '指定历史资料不可用或无权访问' : '还没有外部工作区'
              }
              description={
                historicalId !== undefined
                  ? '不会自动改用其他来源。可返回当前工作区继续查看。'
                  : '管理员从当前工作区生成外部资料，复核发布后即可阅读和用于对话。'
              }
            />
          )}
        </>
      )}
      {manager ? (
        <>
          <ExternalWorkspaceDialog
            open={dialog === 'external'}
            onOpenChange={(value) => {
              if (!value) setDialog(null)
            }}
            finalFocus={() => dialogFocus.current}
            disabled={busy || running || !overview}
            submissionNotice={notice}
            error={combinedError}
            onGenerate={(rules) => submission.submit({ type: 'external', rules })}
          />
          <WorkspaceTasksDialog
            open={dialog === 'tasks'}
            onOpenChange={(value) => {
              if (!value) setDialog(null)
            }}
            finalFocus={() => dialogFocus.current}
            tasks={tasks}
            busy={busy}
            error={combinedError}
            onCancel={(id) => mutate(() => cancelWorkspaceTask(projectId, id))}
          />
          <WorkspaceReviewDialog
            open={dialog === 'review'}
            onOpenChange={(value) => {
              if (!value) setDialog(null)
            }}
            finalFocus={() => dialogFocus.current}
            projectId={projectId}
            version={current}
            busy={busy}
            error={combinedError}
            onPublish={(confirmed, excluded) =>
              current
                ? mutate(() => publishWorkspace(projectId, current.id, confirmed, excluded))
                : Promise.resolve(false)
            }
          />
        </>
      ) : null}
      {current ? (
        <WorkspaceVersionDialog
          open={dialog === 'detail'}
          onOpenChange={(value) => {
            if (!value) setDialog(null)
          }}
          finalFocus={() => dialogFocus.current}
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
