import { useSkillLibraryCatalog } from './useSkillLibraryCatalog'
import {
  ModuleHeader,
  ModuleSidebar,
  ModuleSidebarItem,
  ModuleSidebarEmpty,
} from './ModuleWorkspace'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftIcon,
  BotIcon,
  FolderGit2Icon,
  LibraryIcon,
  InfoIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  UploadIcon,
} from 'lucide-react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { useAutoOpsProjectId } from './projectNavigation'
import { WorkspacePageContainer } from '~/components/WorkspacePageContainer'
import { ReadOnlyWorkspaceFiles } from '~/components/files/ReadOnlyWorkspaceFiles'
import { FileSurfaceAction } from '~/components/files/fileSurfaceChrome'
import { SidebarInset } from '~/components/ui/sidebar'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '~/components/ui/popover'
import { toastManager } from '~/components/ui/toast'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '~/components/ui/menu'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '~/components/ui/empty'
import { Alert, AlertTitle, AlertDescription } from '~/components/ui/alert'
import { Spinner } from '~/components/ui/spinner'
import { usePrimaryEnvironmentId } from '~/state/environments'
import { cn } from '~/lib/utils'
import { readAutoOpsHost } from './hostConfig'
import { SkillLibraryCard, skillQuickAssignmentAllowed, skillTargetKey } from './SkillLibraryCard'
import {
  SkillImportDialog,
  SkillAssignmentDialog,
  SkillDetailsDialog,
  SkillDeleteDialog,
} from './SkillLibraryDialogs'
import {
  skillFileSource,
  skillVersion,
  skillVersionName,
  type LibrarySkill,
  type SkillAssignment,
  type SkillLibraryAction,
  type SkillTargetType,
  type SkillVersion,
} from './skillLibrary'

type Scope = 'library' | 'agent' | 'project'
type OpenDialog =
  | { type: 'import'; skill?: LibrarySkill }
  | { type: 'assign'; skillId?: string; assignment?: SkillAssignment }
  | { type: 'details' | 'delete'; skill: LibrarySkill }
  | null
const scopeNames = { library: '全部技能', agent: '助手分配', project: '项目分配' } as const
const scopeIcons = { library: LibraryIcon, agent: BotIcon, project: FolderGit2Icon } as const

const viewStorageKey = (principalId: string, projectId: string) =>
  `autoops:skill-library-view:${encodeURIComponent(principalId)}:${encodeURIComponent(projectId)}`
function readView(
  principalId: string,
  projectId: string,
): { scope?: Scope; agentId?: string; query?: string } {
  try {
    const value = JSON.parse(sessionStorage.getItem(viewStorageKey(principalId, projectId)) ?? '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** 公共项目框架负责导航，技能库保留全局分配语义。 */
export function AutoOpsSkillLibraryPage() {
  const host = readAutoOpsHost()
  const projectId = useAutoOpsProjectId()
  const search = useSearch({ from: '/_chat/skills' })
  const navigate = useNavigate()
  const project = host?.projects.find((entry) => entry.id === projectId)
  const saved = readView(host?.principal.id ?? '', projectId)
  const requestedScope = search.skillView ?? saved.scope
  const scope: Scope =
    requestedScope === 'agent' || requestedScope === 'project' ? requestedScope : 'library'
  const agentId =
    typeof (search.agentId ?? saved.agentId) === 'string'
      ? (search.agentId ?? saved.agentId ?? '')
      : ''
  useEffect(() => {
    if (!host || !project || search.skillView !== undefined) return
    // 把保存的视图同步到路由，保证项目切换与浏览历史一致。
    void navigate({
      to: '/skills',
      replace: true,
      search: {
        projectId: ProjectId.make(projectId),
        skillView: scope,
        ...(scope === 'agent' && agentId ? { agentId } : {}),
      },
    })
  }, [host, project, search.skillView, projectId, scope, agentId, navigate])
  if (!host || !project)
    return (
      <SidebarInset
        className="h-dvh min-h-0 min-w-0 overflow-hidden"
        data-testid="skill-project-unavailable"
      >
        <ModuleHeader title="技能库" />
        <ModuleSidebar label="技能管理">
          <ModuleSidebarEmpty>请先选择有权访问的项目。</ModuleSidebarEmpty>
        </ModuleSidebar>
        <SkillEmpty title="项目不可用或无权访问" description="请通过顶部导航选择有权访问的项目。" />
      </SidebarInset>
    )
  const selectView = (view: Scope, selectedAgentId = '') => {
    void navigate({
      to: '/skills',
      search: {
        projectId: ProjectId.make(projectId),
        skillView: view,
        ...(view === 'agent' && selectedAgentId ? { agentId: selectedAgentId } : {}),
      },
    })
  }
  return (
    <SkillLibraryContent
      key={`${host.principal.id}:${projectId}:${scope}:${agentId}`}
      projectId={projectId}
      projectName={project.name}
      scope={scope}
      agentId={agentId}
      selectView={selectView}
    />
  )
}

function SkillLibraryContent({
  projectId,
  projectName,
  scope,
  agentId,
  selectView,
}: {
  projectId: string
  projectName: string
  scope: Scope
  agentId: string
  selectView: (scope: Scope, agentId?: string) => void
}) {
  const host = readAutoOpsHost()!
  const {
    catalog,
    error,
    accessDenied,
    busy,
    loading,
    refreshLibrary,
    isUpdating,
    mutate: mutateCatalog,
    clearError,
  } = useSkillLibraryCatalog()
  const [query, setQuery] = useState(() => {
    const saved = readView(host.principal.id, projectId)
    return saved.scope === scope && typeof saved.query === 'string' ? saved.query : ''
  })
  useEffect(() => {
    try {
      sessionStorage.setItem(
        viewStorageKey(host.principal.id, projectId),
        JSON.stringify({ scope, agentId, query }),
      )
    } catch {
      /* 存储不可用时，当前页面仍可使用。 */
    }
  }, [host.principal.id, projectId, scope, agentId, query])
  const [selectedId, setSelectedId] = useState('')
  const [selectedVersionId, setSelectedVersionId] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)
  const [pendingTarget, setPendingTarget] = useState<string | null>(null)
  const [dialog, setDialog] = useState<OpenDialog>(null)
  const [assignmentPopoverSkillId, setAssignmentPopoverSkillId] = useState<string | null>(null)
  const [successNotice, setSuccessNotice] = useState<string | null>(null)
  const dialogReturnFocus = useRef<HTMLElement | null>(null)
  const libraryActionRef = useRef<HTMLButtonElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const gridPosition = useRef({ top: 0, skillId: '' })

  // 编辑器关闭后再显示成功提示，避免提示层干扰用户继续选择分配目标。
  useEffect(() => {
    if (!successNotice || dialog || assignmentPopoverSkillId) return
    toastManager.add({
      id: 'autoops-skill-library-update',
      type: 'success',
      title: successNotice,
      timeout: 4000,
      data: { hideCopyButton: true },
    })
    setSuccessNotice(null)
  }, [successNotice, dialog, assignmentPopoverSkillId])

  useEffect(() => {
    if (accessDenied) setDialog(null)
  }, [accessDenied])

  const targets =
    scope === 'agent'
      ? (catalog?.agents ?? [])
      : scope === 'project'
        ? (catalog?.projects ?? [])
        : []
  const target =
    scope === 'project'
      ? targets.find((entry) => entry.id === projectId)
      : (targets.find((entry) => entry.id === agentId) ?? (!agentId ? targets[0] : undefined))
  const assignments =
    catalog?.assignments.filter(
      (entry) => entry.targetType === scope && entry.targetId === target?.id,
    ) ?? []
  const visibleSkills = (catalog?.skills ?? []).filter(
    (skill) =>
      (scope === 'library' || assignments.some((entry) => entry.skillId === skill.id)) &&
      `${skill.displayName} ${skill.name} ${skill.description}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase().trim()),
  )
  const assignmentPopoverCardVisible =
    !detailOpen && visibleSkills.some((skill) => skill.id === assignmentPopoverSkillId)
  useEffect(() => {
    if (!assignmentPopoverSkillId || assignmentPopoverCardVisible) return
    // 撤销当前范围时，卡片可能直接消失，需同时关闭浮层并恢复焦点。
    setAssignmentPopoverSkillId(null)
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return
      const nextCard = gridRef.current?.querySelector<HTMLButtonElement>('[data-skill-row]')
      if (nextCard?.getClientRects().length) nextCard.focus({ preventScroll: true })
      else libraryActionRef.current?.focus({ preventScroll: true })
    })
  }, [assignmentPopoverSkillId, assignmentPopoverCardVisible])
  const selected = visibleSkills.find((entry) => entry.id === selectedId) ?? visibleSkills[0]
  const assignment = selected
    ? assignments.find((entry) => entry.skillId === selected.id)
    : undefined
  const version = selected
    ? skillVersion(selected, selectedVersionId || assignment?.versionId)
    : undefined
  const selectedDialogSkill =
    dialog && 'skill' in dialog && dialog.skill
      ? (catalog?.skills.find((entry) => entry.id === dialog.skill?.id) ?? dialog.skill)
      : undefined
  const canManage = catalog?.canManage === true
  const finalFocus = () =>
    dialogReturnFocus.current?.isConnected && dialogReturnFocus.current.getClientRects().length
      ? dialogReturnFocus.current
      : libraryActionRef.current
  const openDialog = (next: OpenDialog, trigger?: HTMLElement | null) => {
    if (next?.type !== 'details' && isUpdating()) return
    if (trigger) dialogReturnFocus.current = trigger
    else if (document.activeElement instanceof HTMLElement)
      dialogReturnFocus.current = document.activeElement
    clearError()
    setDialog(next)
  }
  const closeDialog = () => setDialog(null)
  const mutate = async (action: SkillLibraryAction, success: string) => {
    setSuccessNotice(null)
    const result = await mutateCatalog(action)
    if (!result) return false
    setSuccessNotice(success)
    if (action.action.startsWith('import-')) {
      const imported =
        'skillId' in action && action.skillId
          ? result.next.skills.find((entry) => entry.id === action.skillId)
          : result.next.skills.find(
              (entry) => !result.previous.skills.some((old) => old.id === entry.id),
            )
      if (imported) {
        if (scope !== 'library') selectView('library')
        setQuery('')
        setSelectedId(imported.id)
        setSelectedVersionId(imported.latestVersionId)
        if (!('skillId' in action && action.skillId)) setDetailOpen(false)
      }
    }
    if (action.action === 'delete' && action.skillId === selectedId) setDetailOpen(false)
    return true
  }
  const toggleTarget = (skill: LibrarySkill, type: SkillTargetType, id: string) => {
    if (!catalog || !catalog.canManage || isUpdating()) return
    const existing = catalog.assignments.find(
      (entry) => entry.skillId === skill.id && entry.targetType === type && entry.targetId === id,
    )
    if (!skillQuickAssignmentAllowed(skill, existing)) return
    const nextVersion = skillVersion(skill, existing?.versionId)
    if (!nextVersion) return
    const name =
      (type === 'agent' ? catalog.agents : catalog.projects).find((entry) => entry.id === id)
        ?.name ?? id
    const action: SkillLibraryAction = existing?.enabled
      ? { action: 'unassign', assignmentId: existing.id }
      : {
          action: 'assign',
          skillId: skill.id,
          targetType: type,
          targetId: id,
          versionId: existing?.versionId ?? nextVersion.id,
          workspaceTypes: existing?.workspaceTypes ?? ['internal'],
          enabled: true,
        }
    setPendingTarget(skillTargetKey(skill.id, type, id))
    void mutate(
      action,
      existing?.enabled
        ? `已取消“${name}”的分配${type === 'project' ? '，沿用助手设置' : ''}。`
        : existing
          ? `已恢复“${name}”的分配，沿用原版本与工作区范围。`
          : `已分配给“${name}”，仅用于内部工作区。`,
    ).finally(() => setPendingTarget(null))
  }
  const openFiles = (skill: LibrarySkill) => {
    const viewport = gridRef.current?.closest('[data-slot="scroll-area-viewport"]')
    gridPosition.current = { top: viewport?.scrollTop ?? 0, skillId: skill.id }
    setSelectedId(skill.id)
    setSelectedVersionId('')
    setDetailOpen(true)
  }
  const returnToLibrary = () => {
    setDetailOpen(false)
    requestAnimationFrame(() => {
      const viewport = gridRef.current?.closest('[data-slot="scroll-area-viewport"]')
      if (viewport) viewport.scrollTop = gridPosition.current.top
      gridRef.current
        ?.querySelector<HTMLButtonElement>(`[data-skill-row="${gridPosition.current.skillId}"]`)
        ?.focus({ preventScroll: true })
    })
  }
  const showDetail = detailOpen && !!selected
  const actions = (
    skill: LibrarySkill,
    currentVersion = skillVersion(skill),
    currentAssignment?: SkillAssignment,
  ) => (
    <SkillActions
      skill={skill}
      version={currentVersion}
      assignment={currentAssignment}
      busy={busy || loading}
      canManage={canManage}
      onAction={(action, trigger) => {
        if (action === 'details' || action === 'delete' || action === 'import')
          openDialog({ type: action, skill }, trigger)
        else if (action === 'assign')
          openDialog(
            {
              type: 'assign',
              skillId: skill.id,
              ...(currentAssignment ? { assignment: currentAssignment } : {}),
            },
            trigger,
          )
        else if (action === 'verify' && currentVersion)
          void mutate(
            { action: 'verify', skillId: skill.id, versionId: currentVersion.id },
            '版本文件已重新校验。',
          )
        else if (action === 'toggle')
          void mutate(
            { action: 'set-enabled', skillId: skill.id, enabled: !skill.enabled },
            skill.enabled ? '技能已停用。' : '技能已启用。',
          )
      }}
    />
  )
  const dialogProps = { busy: busy || loading, error, onClose: closeDialog, finalFocus, mutate }

  if (!host) return <SkillEmpty title="技能库不可用" description="请从 AutoOps 工作台进入。" />
  return (
    <SidebarInset
      className="h-dvh min-h-0 min-w-0 overflow-hidden overscroll-y-none"
      data-skill-library
      data-skill-library-revision={catalog?.revision}
    >
      <ModuleHeader
        title="技能库"
        detail={showDetail && selected ? selected.displayName : scopeNames[scope]}
        actions={
          <>
            {showDetail && selected ? actions(selected, version, assignment) : null}
            {!showDetail && canManage ? (
              <Button
                ref={libraryActionRef}
                size="sm"
                variant="outline"
                disabled={busy || loading || (scope !== 'library' && !target)}
                onClick={() =>
                  openDialog(scope === 'library' ? { type: 'import' } : { type: 'assign' })
                }
              >
                {scope === 'library' ? <UploadIcon /> : <PlusIcon />}
                {scope === 'library' ? '导入技能' : '添加技能'}
              </Button>
            ) : null}
            <FileSurfaceAction
              label="刷新技能库"
              disabled={busy || loading}
              onPress={refreshLibrary}
            >
              <RefreshCwIcon className={loading ? 'animate-spin' : undefined} />
            </FileSurfaceAction>
          </>
        }
      />
      <ModuleSidebar
        label="技能管理"
        search={{
          value: query,
          label: '搜索技能',
          onChange: (value) => {
            setQuery(value)
            setDetailOpen(false)
          },
        }}
      >
        <div className="space-y-1 px-[var(--sidebar-content-inset)]">
          {Object.entries(scopeNames).map(([value, name]) => (
            <ModuleSidebarItem
              key={value}
              label={name}
              icon={scopeIcons[value as Scope]}
              selected={scope === value}
              onClick={() => selectView(value as Scope)}
            />
          ))}
        </div>
      </ModuleSidebar>
      {error && !dialog ? (
        <div className="shrink-0 border-b border-border/60 p-3">
          <Alert variant="error">
            <AlertTitle>技能库操作未完成</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Button
            className="mt-2"
            variant="outline"
            size="xs"
            disabled={busy || loading}
            onClick={refreshLibrary}
          >
            重新加载
          </Button>
        </div>
      ) : null}
      {!catalog ? (
        !loading ? (
          <SkillEmpty title="无法读取技能库" description="请重新加载后再试。" />
        ) : (
          <div
            role="status"
            className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <Spinner size="sm" />
            正在读取技能库…
          </div>
        )
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div
            className={cn('flex min-h-0 min-w-0 flex-1 flex-col', showDetail && 'hidden')}
            aria-label="技能列表"
          >
            <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
              <WorkspacePageContainer width="wide" className="gap-3">
                <div
                  className="flex min-w-0 flex-wrap items-center gap-2"
                  aria-label="技能库工具栏"
                >
                  {scope === 'agent' ? (
                    <div className="w-40 min-w-0 max-w-full">
                      <Select
                        value={target?.id ?? ''}
                        disabled={!targets.length}
                        onValueChange={(value) => {
                          if (typeof value === 'string') {
                            selectView('agent', value)
                          }
                        }}
                      >
                        <SelectTrigger size="sm" className="min-w-0" aria-label="技能范围助手">
                          <SelectValue>{target?.name ?? '没有可用目标'}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          {targets.map((entry) => (
                            <SelectItem key={entry.id} value={entry.id}>
                              {entry.name}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                  ) : null}
                  <span
                    className="min-w-0 max-w-48 truncate text-xs text-muted-foreground"
                    title={scope === 'project' ? projectName : undefined}
                  >
                    {scope === 'project' ? projectName : '全局共享'}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <span
                      className="text-xs text-muted-foreground"
                      aria-label={`${visibleSkills.length} 项技能`}
                    >
                      {visibleSkills.length} 项技能
                    </span>
                    <Popover>
                      <PopoverTrigger
                        aria-label="技能分配说明"
                        render={<Button size="icon-sm" variant="ghost-muted" />}
                      >
                        <InfoIcon />
                      </PopoverTrigger>
                      <PopoverPopup width="md" padding="compact" align="end" touchBackdrop>
                        <PopoverTitle>技能分配</PopoverTitle>
                        <div className="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">
                          <p>技能库与助手分配全局共享，项目分配跟随顶部当前项目。</p>
                          <p>
                            点击助手或项目即可分配，再点取消。新分配使用最新版本，仅限内部工作区；未就绪版本不能分配。
                          </p>
                          <p>项目未单独分配时沿用助手设置。</p>
                          <p>版本、来源和外部范围在技能菜单中查看或调整。</p>
                        </div>
                      </PopoverPopup>
                    </Popover>
                  </div>
                </div>
                <div ref={gridRef} className="grid content-start gap-2 md:grid-cols-2">
                  {visibleSkills.map((skill) => {
                    const currentAssignment = assignments.find(
                      (entry) => entry.skillId === skill.id,
                    )
                    return (
                      <SkillLibraryCard
                        key={skill.id}
                        skill={skill}
                        catalog={catalog}
                        projectId={projectId}
                        busy={busy || loading}
                        pendingTarget={pendingTarget}
                        actions={actions(
                          skill,
                          skillVersion(skill, currentAssignment?.versionId),
                          currentAssignment,
                        )}
                        onOpen={() => openFiles(skill)}
                        onProjectOpenChange={(open) =>
                          setAssignmentPopoverSkillId((previous) =>
                            open ? skill.id : previous === skill.id ? null : previous,
                          )
                        }
                        onToggle={toggleTarget}
                      />
                    )
                  })}
                </div>
                {!visibleSkills.length ? (
                  <SkillEmpty
                    title={
                      query
                        ? '没有匹配的技能'
                        : scope === 'library'
                          ? '技能库为空'
                          : '尚未单独分配技能'
                    }
                    description={
                      query
                        ? '换一个名称或关键词试试。'
                        : canManage
                          ? scope === 'library'
                            ? '导入 SKILL.md、ZIP 或公开 Git 技能包。'
                            : '可从全部技能的卡片直接分配给助手或项目。'
                          : '请联系管理员分配可用技能。'
                    }
                  />
                ) : null}
              </WorkspacePageContainer>
            </ScrollArea>
          </div>
          {showDetail ? (
            <section
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              aria-label="技能详情"
            >
              {selected && version ? (
                <>
                  <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <FileSurfaceAction label="返回技能库" onPress={returnToLibrary}>
                        <ArrowLeftIcon />
                      </FileSurfaceAction>
                      <div className="min-w-0 flex-1 sm:max-w-80">
                        <Select
                          value={version.id}
                          onValueChange={(value) => {
                            if (typeof value === 'string') setSelectedVersionId(value)
                          }}
                        >
                          <SelectTrigger size="sm" aria-label="查看技能版本" className="min-w-0">
                            <SelectValue>{skillVersionName(version)}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            {selected.versions.map((entry) => (
                              <SelectItem value={entry.id} key={entry.id}>
                                {skillVersionName(entry)}
                                {entry.id === selected.latestVersionId ? ' · 最新' : ''}
                                {entry.id === assignment?.versionId ? ' · 当前分配' : ''}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </div>
                      {!selected.enabled || version.readiness !== 'ready' ? (
                        <Badge size="sm" variant={!selected.enabled ? 'outline' : 'warning'}>
                          {!selected.enabled ? '已停用' : '未就绪'}
                        </Badge>
                      ) : null}
                    </div>
                    {version.readiness === 'restricted' ? (
                      <p role="status" className="text-xs text-warning-foreground wrap-anywhere">
                        运行条件未满足：{version.reason ?? '当前运行器无法执行此技能。'}{' '}
                        可以查看文件。
                      </p>
                    ) : null}
                    {assignment ? (
                      <p className="text-xs text-muted-foreground">
                        当前分配：
                        {assignment.workspaceTypes
                          .map((type) => (type === 'internal' ? '内部工作区' : '外部工作区'))
                          .join('、')}
                        {version.id !== assignment.versionId
                          ? ' · 正在预览其他版本，当前分配未改变'
                          : ''}
                      </p>
                    ) : null}
                  </div>
                  <SkillFiles
                    key={`${selected.id}:${version.id}`}
                    skill={selected}
                    version={version}
                  />
                </>
              ) : (
                <SkillEmpty
                  title="选择技能查看文件"
                  description="技能的说明、参考资料与资源按原目录显示。"
                />
              )}
            </section>
          ) : null}
        </div>
      )}
      {dialog?.type === 'import' ? (
        <SkillImportDialog
          {...dialogProps}
          {...(selectedDialogSkill ? { skill: selectedDialogSkill } : {})}
        />
      ) : null}
      {dialog?.type === 'assign' && catalog ? (
        <SkillAssignmentDialog
          {...dialogProps}
          catalog={catalog}
          {...(dialog.skillId ? { initialSkillId: dialog.skillId } : {})}
          {...(dialog.assignment ? { assignment: dialog.assignment } : {})}
          {...(scope !== 'library'
            ? { initialTargetType: scope, ...(target ? { initialTargetId: target.id } : {}) }
            : {})}
        />
      ) : null}
      {dialog?.type === 'details' && selectedDialogSkill && catalog ? (
        <SkillDetailsDialog
          {...dialogProps}
          skill={selectedDialogSkill}
          catalog={catalog}
          onEdit={(entry) => setDialog({ type: 'assign', assignment: entry })}
        />
      ) : null}
      {dialog?.type === 'delete' && selectedDialogSkill && catalog ? (
        <SkillDeleteDialog
          {...dialogProps}
          skill={selectedDialogSkill}
          assignedCount={
            catalog.assignments.filter((entry) => entry.skillId === selectedDialogSkill.id).length
          }
        />
      ) : null}
    </SidebarInset>
  )
}

type SkillAction = 'details' | 'assign' | 'import' | 'verify' | 'toggle' | 'delete'
function SkillActions({
  skill,
  version,
  assignment,
  busy,
  canManage,
  onAction,
}: {
  skill: LibrarySkill
  version: SkillVersion | undefined
  assignment: SkillAssignment | undefined
  busy: boolean
  canManage: boolean
  onAction: (action: SkillAction, trigger: HTMLElement | null) => void
}) {
  const trigger = useRef<HTMLButtonElement | null>(null)
  return (
    <Menu>
      <MenuTrigger
        ref={trigger}
        aria-label="技能操作"
        render={<Button variant="ghost" size="icon-sm" />}
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => onAction('details', trigger.current)}>
          <InfoIcon />
          分配与版本详情
        </MenuItem>
        {canManage ? (
          <>
            <MenuItem
              disabled={
                busy ||
                !skill.enabled ||
                !skill.versions.some((entry) => entry.readiness === 'ready')
              }
              onClick={() => onAction('assign', trigger.current)}
            >
              <PlusIcon />
              {assignment ? '调整当前分配' : '分配技能'}
            </MenuItem>
            <MenuItem disabled={busy} onClick={() => onAction('import', trigger.current)}>
              <UploadIcon />
              导入新版本
            </MenuItem>
            <MenuItem
              disabled={busy || !version}
              onClick={() => onAction('verify', trigger.current)}
            >
              <RefreshCwIcon />
              重新校验版本
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={busy} onClick={() => onAction('toggle', trigger.current)}>
              {skill.enabled ? '停用技能' : '启用技能'}
            </MenuItem>
            <MenuItem disabled={busy} onClick={() => onAction('delete', trigger.current)}>
              删除技能
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  )
}

function SkillEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
function SkillFiles({ skill, version }: { skill: LibrarySkill; version: SkillVersion }) {
  const environmentId = usePrimaryEnvironmentId()
  const source = useMemo(() => skillFileSource(skill, version), [skill, version])
  const [selected, setSelected] = useState<string | null>('SKILL.md')
  const [trail, setTrail] = useState<string | undefined>(undefined)
  if (!environmentId)
    return <SkillEmpty title="文件连接不可用" description="重新连接工作台后可查看技能文件。" />
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 overflow-hidden')}>
      <ReadOnlyWorkspaceFiles
        environmentId={environmentId}
        cwd={source.id}
        projectName={skill.displayName}
        relativePath={selected}
        source={source}
        folderTrail={trail}
        onOpenFile={(path) => {
          setSelected(path)
          setTrail(undefined)
        }}
        onNavigateFolder={(path, nextTrail) => {
          setSelected(path || null)
          setTrail(nextTrail)
        }}
      />
    </div>
  )
}
