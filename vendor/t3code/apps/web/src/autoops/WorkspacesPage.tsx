import { useEffect, useRef, useState } from 'react'
import { HistoryIcon, MoreHorizontalIcon, RefreshCwIcon, ClockIcon } from 'lucide-react'
import { SidebarInset } from '~/components/ui/sidebar'
import { Button } from '~/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '~/components/ui/menu'
import { toastManager } from '~/components/ui/toast'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Spinner } from '~/components/ui/spinner'
import { FileSurfaceAction } from '~/components/files/fileSurfaceChrome'
import { ModuleHeader, ModuleSidebar } from './ModuleWorkspace'
import { WorkspaceAuthoring, type WorkspaceSection } from './WorkspaceAuthoringPanel'
import { WorkspaceUpdateDialog } from './WorkspaceUpdateDialog'
import { WorkspaceFileBrowser } from './WorkspaceFileBrowser'
import { readSelection, saveSelection } from './workspaceViewState'
import { useWorkspaceOverview } from './useWorkspaceOverview'
import { useWorkspaceTaskSubmission } from './useWorkspaceTaskSubmission'
import { readAutoOpsHost } from './hostConfig'
import { useAutoOpsProjectId } from './projectNavigation'
import { workspaceFailureMessage } from './workspaceFeedback'
import { WorkspaceTasksDialog, WorkspaceSubmissionNotice } from './WorkspaceActions'
import { cancelWorkspaceTask, type WorkspaceTask } from './workspaces'

const taskActive = (task: WorkspaceTask) => task.status === 'queued' || task.status === 'running'
type Dialog = 'tasks' | 'updates' | null
export function AutoOpsWorkspacesPage() {
  const projectId = useAutoOpsProjectId()
  const host = readAutoOpsHost()
  const project = host?.projects.find((entry) => entry.id === projectId)
  return (
    <SidebarInset
      className="h-dvh min-h-0 min-w-0 overflow-hidden overscroll-y-none"
      aria-label="项目工作区"
      data-testid="workspace-page"
    >
      {project?.capabilities?.['workspace.read'] === true ? (
        <ProjectWorkspaces key={`${host?.principal.id}:${projectId}`} projectId={projectId} />
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
function ProjectWorkspaces({ projectId }: { projectId: string }) {
  const project = readAutoOpsHost()?.projects.find((entry) => entry.id === projectId)
  const manager = project?.capabilities?.['workspace.manage'] === true
  const canUpdateExternal =
    manager && project?.capabilities?.['workspace.external.publish'] === true
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
  const menuFocus = useRef<HTMLButtonElement | null>(null)
  const [followTaskId, setFollowTaskId] = useState<string | null>(null)
  const submission = useWorkspaceTaskSubmission(projectId, (task) => {
    setFollowTaskId(task.id)
    refreshOverview()
  })
  const tasks = overview?.tasks ?? []
  const internalTasks = tasks.filter((task) => task.type === 'sync' || task.type === 'import')
  const running = tasks.some(
    (task) =>
      taskActive(task) &&
      (tab === 'external'
        ? task.type === 'external'
        : ['sync', 'snapshot', 'import'].includes(task.type)),
  )
  const busy = mutationBusy || submission.busy
  const current = overview?.externalVersions.find((version) => version.status === 'published')
  const currentExternalTask = tasks.find((task) => task.type === 'external')
  useEffect(() => {
    const task = tasks.find((entry) => entry.id === followTaskId)
    if (!task || taskActive(task)) return
    if (task.status === 'completed') {
      const excluded =
        overview?.externalVersions.find((version) => version.id === task.versionId)?.report
          ?.excludedFiles.length ?? 0
      toastManager.add({
        type: 'success',
        title: task.type === 'external' ? '外部工作区已更新' : '源码同步成功',
        ...(excluded ? { description: `已排除 ${excluded} 个无法按文本规则处理的文件。` } : {}),
      })
    } else setError(workspaceFailureMessage(task.failureCode, task.error ?? '操作失败，请重试。'))
    setFollowTaskId(null)
  }, [tasks, followTaskId, overview])
  const navigation = (
    <ToggleGroup
      aria-label="工作区分类"
      variant="segmented"
      value={[externalOnly ? 'external' : tab]}
      onValueChange={(value) => {
        const next = value[0]
        if ((next !== 'internal' && next !== 'external') || (externalOnly && next !== 'external'))
          return
        saveSelection(`${projectId}:tab`, next)
        setTab(next)
        setDialog(null)
        setError(null)
      }}
    >
      {!externalOnly ? <Toggle value="internal">内部工作区</Toggle> : null}
      <Toggle value="external">外部工作区</Toggle>
    </ToggleGroup>
  )
  const taskError =
    tab === 'external' && currentExternalTask?.status === 'failed'
      ? currentExternalTask.error
      : null
  const combinedError = error ?? submission.error ?? loadError ?? taskError
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
        <div className="shrink-0 border-b px-3 py-2">
          <WorkspaceSubmissionNotice
            label={submission.pendingLabel}
            paused={submission.recoveryPaused}
            retryAvailable={submission.retryAvailable && manager}
            busy={busy}
            onCheck={submission.check}
            onRetry={submission.retry}
          />
        </div>
      ) : null}
      {!externalOnly && tab === 'internal' ? (
        <WorkspaceAuthoring
          projectId={projectId}
          manager={manager}
          section={section}
          navigation={navigation}
          menuTriggerRef={menuFocus}
          menuItems={
            manager ? (
              <>
                <MenuItem onClick={() => setDialog('updates')}>
                  <ClockIcon />
                  更新设置
                </MenuItem>
                <MenuItem onClick={() => setDialog('tasks')}>
                  {running ? <Spinner size="sm" /> : <HistoryIcon />}
                  {running ? '任务执行中' : '任务记录'}
                </MenuItem>
              </>
            ) : null
          }
          taskRevision={internalTasks.map((task) => `${task.id}:${task.status}`).join(':')}
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
            detail="外部工作区"
            actions={
              <>
                {!current ? (
                  <FileSurfaceAction label="刷新工作区" disabled={busy} onPress={refreshOverview}>
                    <RefreshCwIcon />
                  </FileSurfaceAction>
                ) : null}
                {canUpdateExternal ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || running || !overview}
                      onClick={() => {
                        setError(null)
                        void submission.submit({ type: 'external' })
                      }}
                    >
                      {busy || running ? (
                        <>
                          <Spinner size="sm" />
                          正在更新…
                        </>
                      ) : (
                        '更新外部工作区'
                      )}
                    </Button>
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            ref={menuFocus}
                            size="icon-sm"
                            variant="ghost"
                            aria-label="外部工作区操作"
                          />
                        }
                      >
                        <MoreHorizontalIcon />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem onClick={() => setDialog('updates')}>
                          <ClockIcon />
                          更新设置与脱敏规则
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </>
                ) : null}
              </>
            }
          />
          {!overview ? (
            combinedError ? null : (
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            )
          ) : current ? (
            <WorkspaceFileBrowser
              projectId={projectId}
              version={{ ...current, name: '外部工作区' }}
              onRefresh={refreshOverview}
            />
          ) : (
            <WorkspaceEmpty
              title="还没有外部工作区"
              description={
                canUpdateExternal
                  ? '更新后即可查看按脱敏规则处理的当前内部资料。'
                  : '管理员更新外部工作区后即可阅读。'
              }
            />
          )}
        </>
      )}
      {manager ? (
        <>
          <WorkspaceUpdateDialog
            projectId={projectId}
            scope={tab}
            open={dialog === 'updates'}
            onOpenChange={(value) => {
              if (!value) setDialog(null)
            }}
            finalFocus={() => menuFocus.current}
            onChanged={refreshOverview}
            onAccessDenied={(cause) => {
              setError(cause instanceof Error ? cause.message : '工作区维护权限已撤回')
              refreshOverview()
            }}
          />
          {tab === 'internal' ? (
            <WorkspaceTasksDialog
              open={dialog === 'tasks'}
              onOpenChange={(value) => {
                if (!value) setDialog(null)
              }}
              finalFocus={() => menuFocus.current}
              tasks={internalTasks}
              busy={busy}
              error={combinedError}
              onCancel={async (id) => {
                if (busy) return false
                setBusy(true)
                try {
                  await cancelWorkspaceTask(projectId, id)
                  refreshOverview()
                  return true
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : '操作失败，请重试。')
                  return false
                } finally {
                  setBusy(false)
                }
              }}
            />
          ) : null}
        </>
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
