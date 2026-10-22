import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftIcon,
  InfoIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
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
import { InputGroup, InputGroupAddon, InputGroupInput } from '~/components/ui/input-group'
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '~/components/ui/popover'
import { toastManager } from '~/components/ui/toast'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
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
  changeSkillLibrary,
  loadSkillLibrary,
  skillFileSource,
  skillSourceName,
  skillVersion,
  skillVersionName,
  type LibrarySkill,
  type SkillAssignment,
  type SkillLibrary,
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
const scopeNames = { library: '中央技能库', agent: '助手技能', project: '项目技能' } as const
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。'

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

/** The shared project shell owns navigation; the library retains its global assignment semantics. */
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
    // Persisted view state becomes explicit so project switching and browser history agree.
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
  const [catalog, setCatalog] = useState<SkillLibrary | null>(null)
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
      /* The current page remains usable without storage. */
    }
  }, [host.principal.id, projectId, scope, agentId, query])
  const [selectedId, setSelectedId] = useState('')
  const [selectedVersionId, setSelectedVersionId] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingTarget, setPendingTarget] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [dialog, setDialog] = useState<OpenDialog>(null)
  const [assignmentPopoverSkillId, setAssignmentPopoverSkillId] = useState<string | null>(null)
  const [successNotice, setSuccessNotice] = useState<string | null>(null)
  const dialogReturnFocus = useRef<HTMLElement | null>(null)
  const libraryActionRef = useRef<HTMLButtonElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const gridPosition = useRef({ top: 0, skillId: '' })
  const mutationLock = useRef(false)
  const requestGeneration = useRef(0)
  const refreshPending = useRef(true)

  // Publish after the active editor closes, so a toast cannot become the top
  // dismissable layer while the user is still selecting assignment targets.
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
    const controller = new AbortController()
    const generation = ++requestGeneration.current
    refreshPending.current = true
    setLoading(true)
    void loadSkillLibrary(controller.signal)
      .then((next) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return
        setCatalog(next)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && generation === requestGeneration.current)
          setError(errorMessage(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === requestGeneration.current) {
          refreshPending.current = false
          setLoading(false)
        }
      })
    return () => {
      controller.abort()
      // An accepted write keeps its original target, but must not navigate a later page.
      ++requestGeneration.current
    }
  }, [refresh])
  const refreshLibrary = () => {
    if (mutationLock.current || refreshPending.current) return
    refreshPending.current = true
    setLoading(true)
    setRefresh((value) => value + 1)
  }
  useEffect(() => {
    const changed = () => {
      // This page applies its own mutation response directly. A write finishing
      // on an earlier page must invalidate this page's possibly older catalogue.
      if (mutationLock.current) return
      refreshPending.current = true
      setLoading(true)
      setRefresh((value) => value + 1)
    }
    window.addEventListener('autoops:skill-library-changed', changed)
    return () => window.removeEventListener('autoops:skill-library-changed', changed)
  }, [])

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
    // Revoking the active scope can remove its card without an onOpenChange.
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
  const selectedAssignments = selected
    ? (catalog?.assignments.filter((entry) => entry.skillId === selected.id) ?? [])
    : []
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
    if (next?.type !== 'details' && (mutationLock.current || refreshPending.current)) return
    if (trigger) dialogReturnFocus.current = trigger
    else if (document.activeElement instanceof HTMLElement)
      dialogReturnFocus.current = document.activeElement
    setError(null)
    setDialog(next)
  }
  const closeDialog = () => setDialog(null)
  const mutate = async (action: SkillLibraryAction, success: string) => {
    if (!catalog || mutationLock.current || refreshPending.current) return false
    mutationLock.current = true
    const generation = ++requestGeneration.current
    setBusy(true)
    setError(null)
    setSuccessNotice(null)
    return changeSkillLibrary(catalog.revision, action)
      .then((next) => {
        window.dispatchEvent(new Event('autoops:skill-library-changed'))
        if (generation !== requestGeneration.current) return false
        setCatalog(next)
        setSuccessNotice(success)
        if (action.action.startsWith('import-')) {
          const imported =
            'skillId' in action && action.skillId
              ? next.skills.find((entry) => entry.id === action.skillId)
              : next.skills.find((entry) => !catalog.skills.some((old) => old.id === entry.id))
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
      })
      .catch(async (cause: unknown) => {
        if (generation !== requestGeneration.current) return false
        setError(errorMessage(cause))
        await loadSkillLibrary()
          .then((next) => {
            if (generation === requestGeneration.current) setCatalog(next)
          })
          .catch(() => {
            /* Preserve the last readable version and failed action. */
          })
        return false
      })
      .finally(() => {
        mutationLock.current = false
        setBusy(false)
      })
  }
  const toggleTarget = (skill: LibrarySkill, type: SkillTargetType, id: string) => {
    if (!catalog || !catalog.canManage || mutationLock.current || refreshPending.current) return
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
        ? `已取消“${name}”的单独分配。${type === 'project' ? '该项目将沿用助手设置。' : '现有项目单独分配不变。'}`
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
            skill.enabled ? '技能已停用，后续轮次不能再调用。' : '技能已启用，可在已授权范围使用。',
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
      <h1 className="sr-only">技能库</h1>
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
              <WorkspacePageContainer width="wide" className="gap-4">
                <div
                  className="flex min-w-0 flex-wrap items-center gap-2"
                  aria-label="技能库工具栏"
                >
                  <ToggleGroup
                    value={[scope]}
                    variant="segmented"
                    aria-label="技能管理范围"
                    onValueChange={(values) => {
                      const next = values[0]
                      if (next === 'library' || next === 'agent' || next === 'project') {
                        selectView(next)
                      }
                    }}
                  >
                    {Object.entries(scopeNames).map(([value, name]) => (
                      <Toggle key={value} value={value}>
                        {name}
                      </Toggle>
                    ))}
                  </ToggleGroup>
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
                  <div className="flex min-w-0 flex-1 basis-48 items-center gap-1 sm:ml-auto sm:max-w-72">
                    <InputGroup>
                      <InputGroupAddon>
                        <SearchIcon aria-hidden />
                      </InputGroupAddon>
                      <InputGroupInput
                        type="search"
                        size="sm"
                        aria-label="搜索技能"
                        value={query}
                        placeholder="搜索技能"
                        onChange={(event) => {
                          setQuery(event.currentTarget.value)
                          setDetailOpen(false)
                        }}
                      />
                      <InputGroupAddon align="inline-end">
                        <span
                          className="text-xs text-muted-foreground"
                          aria-label={`${visibleSkills.length} 项技能`}
                        >
                          {visibleSkills.length}
                        </span>
                      </InputGroupAddon>
                    </InputGroup>
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
                          <p>
                            中央库与助手分配在全局管理；项目技能跟随顶部当前项目。卡片上的项目按钮用于明确分配目标。
                          </p>
                          <p>
                            点击助手或项目即可分配，再点取消。新分配使用当前最新版本，仅用于内部工作区；未就绪版本不能分配。
                          </p>
                          <p>
                            项目未单独分配时沿用助手设置。取消项目的单独分配后，会恢复这层继承。
                          </p>
                          <p>
                            版本、来源和外部工作区范围，可从技能菜单的“分配与版本详情”查看和调整。
                          </p>
                        </div>
                      </PopoverPopup>
                    </Popover>
                  </div>
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
                            : '可从中央技能库的卡片直接分配给助手或项目。'
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
                      <h2
                        className="min-w-0 flex-1 truncate text-sm font-medium"
                        title={selected.displayName}
                      >
                        {selected.displayName}
                      </h2>
                      <Badge
                        size="sm"
                        variant={
                          !selected.enabled
                            ? 'outline'
                            : version.readiness === 'ready'
                              ? 'success'
                              : 'warning'
                        }
                      >
                        {!selected.enabled
                          ? '已停用'
                          : version.readiness === 'ready'
                            ? '可分配'
                            : '未就绪'}
                      </Badge>
                      {actions(selected, version, assignment)}
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
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
                      <span className="hidden shrink-0 text-xs text-muted-foreground xl:block">
                        {skillSourceName(version.source)} · {version.fileCount} 个文件
                      </span>
                    </div>
                    {version.readiness === 'restricted' ? (
                      <p role="status" className="text-xs text-warning-foreground wrap-anywhere">
                        运行条件未满足：{version.reason ?? '当前运行器无法执行此技能。'}{' '}
                        可以查看文件，完成适配后重新导入。
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
                    ) : selectedAssignments.length === 0 &&
                      selected.enabled &&
                      version.readiness === 'ready' ? (
                      <p className="text-xs text-muted-foreground">
                        尚未分配。返回技能库后，点击卡片上的助手或项目即可分配。
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
