import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  InfoIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  UploadIcon,
} from 'lucide-react'
import { WorkspacePageHeader } from '~/components/WorkspacePageHeader'
import { ReadOnlyWorkspaceFiles } from '~/components/files/ReadOnlyWorkspaceFiles'
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
} from '~/components/files/fileSurfaceChrome'
import { SidebarInset } from '~/components/ui/sidebar'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { Input } from '~/components/ui/input'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '~/components/ui/menu'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '~/components/ui/empty'
import { Alert, AlertTitle, AlertDescription } from '~/components/ui/alert'
import { Spinner } from '~/components/ui/spinner'
import { usePrimaryEnvironmentId } from '~/state/environments'
import { useMediaQuery } from '~/hooks/useMediaQuery'
import { cn } from '~/lib/utils'
import { readAutoOpsHost } from './hostConfig'
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

/** T3 workspace shell and file surfaces; AutoOps supplies catalog ownership and scoped assignments. */
export function AutoOpsSkillLibraryPage() {
  const host = readAutoOpsHost()
  const narrow = useMediaQuery('max-md')
  const [catalog, setCatalog] = useState<SkillLibrary | null>(null)
  const [scope, setScope] = useState<Scope>('library')
  const [targetId, setTargetId] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [selectedVersionId, setSelectedVersionId] = useState('')
  const [mobileDetail, setMobileDetail] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [dialog, setDialog] = useState<OpenDialog>(null)
  const dialogReturnFocus = useRef<HTMLElement | null>(null)
  const menuTrigger = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void loadSkillLibrary(controller.signal)
      .then((next) => {
        setCatalog(next)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [refresh])

  const targets =
    scope === 'agent'
      ? (catalog?.agents ?? [])
      : scope === 'project'
        ? (catalog?.projects ?? [])
        : []
  const target = targets.find((entry) => entry.id === targetId) ?? targets[0]
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
  const finalFocus = () => dialogReturnFocus.current
  const openDialog = (next: OpenDialog, fromMenu = false) => {
    if (fromMenu) dialogReturnFocus.current = menuTrigger.current
    else if (document.activeElement instanceof HTMLElement)
      dialogReturnFocus.current = document.activeElement
    setError(null)
    setDialog(next)
  }
  const closeDialog = () => setDialog(null)
  const mutate = async (action: SkillLibraryAction, success: string) => {
    if (!catalog || busy) return false
    setBusy(true)
    setError(null)
    setNotice(null)
    return changeSkillLibrary(catalog.revision, action)
      .then((next) => {
        setCatalog(next)
        setNotice(success)
        if (action.action.startsWith('import-')) {
          const imported =
            'skillId' in action && action.skillId
              ? next.skills.find((entry) => entry.id === action.skillId)
              : next.skills.find((entry) => !catalog.skills.some((old) => old.id === entry.id))
          if (imported) {
            setScope('library')
            setQuery('')
            setSelectedId(imported.id)
            setSelectedVersionId(imported.latestVersionId)
            setMobileDetail(true)
          }
        }
        window.dispatchEvent(new Event('autoops:skill-library-changed'))
        return true
      })
      .catch(async (cause: unknown) => {
        setError(errorMessage(cause))
        await loadSkillLibrary()
          .then(setCatalog)
          .catch(() => {
            /* Preserve the last readable version and failed action. */
          })
        return false
      })
      .finally(() => setBusy(false))
  }
  const resetSelection = () => {
    setSelectedId('')
    setSelectedVersionId('')
    setMobileDetail(false)
    setQuery('')
  }
  const showList = !narrow || !mobileDetail || !selected
  const showDetail = !narrow || (mobileDetail && !!selected)
  const dialogProps = { busy, error, onClose: closeDialog, finalFocus, mutate }

  if (!host) return <SkillEmpty title="技能库不可用" description="请从 AutoOps 工作台进入。" />
  return (
    <SidebarInset
      className="h-dvh min-h-0 min-w-0 overflow-hidden overscroll-y-none"
      data-skill-library
      data-skill-library-revision={catalog?.revision}
    >
      <WorkspacePageHeader>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">技能</h1>
        <FileSurfaceAction
          label="刷新技能库"
          disabled={busy || loading}
          onPress={() => setRefresh((value) => value + 1)}
        >
          <RefreshCwIcon className={loading ? 'animate-spin' : undefined} />
        </FileSurfaceAction>
      </WorkspacePageHeader>
      <div
        className="flex shrink-0 flex-col gap-2 border-y border-border/60 px-3 py-2"
        aria-label="技能库工具栏"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ToggleGroup
            value={[scope]}
            variant="segmented"
            aria-label="技能管理范围"
            onValueChange={(values) => {
              const next = values[0]
              if (next === 'library' || next === 'agent' || next === 'project') {
                setScope(next)
                setTargetId('')
                resetSelection()
              }
            }}
          >
            {Object.entries(scopeNames).map(([value, name]) => (
              <Toggle key={value} value={value}>
                {name}
              </Toggle>
            ))}
          </ToggleGroup>
          <span className="flex-1" />
          {canManage ? (
            <Button
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
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {scope !== 'library' ? (
            <div className="w-40 min-w-0 shrink-0 sm:w-56">
              <Select
                value={target?.id ?? ''}
                disabled={!targets.length}
                onValueChange={(value) => {
                  if (typeof value === 'string') {
                    setTargetId(value)
                    resetSelection()
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="min-w-0"
                  aria-label={scope === 'agent' ? '技能范围助手' : '技能范围项目'}
                >
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
          <div className="min-w-0 flex-1 sm:max-w-80">
            <Input
              type="search"
              size="sm"
              aria-label="搜索技能"
              value={query}
              placeholder="搜索技能"
              onChange={(event) => {
                setQuery(event.currentTarget.value)
                setMobileDetail(false)
              }}
            />
          </div>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
            {visibleSkills.length} 项
          </span>
        </div>
      </div>
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
            onClick={() => setRefresh((value) => value + 1)}
          >
            重新加载
          </Button>
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground"
        >
          <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 wrap-anywhere">{notice}</span>
          <Button size="xs" variant="ghost" onClick={() => setNotice(null)}>
            关闭提示
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
          {showList ? (
            <aside
              className="flex min-h-0 min-w-0 flex-1 flex-col md:w-64 md:flex-none md:border-r md:border-border/60 lg:w-72"
              aria-label="技能列表"
            >
              <div className={FILE_SURFACE_SUBHEADER_CLASS}>
                <BookOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {scope === 'library' ? '中央技能库' : (target?.name ?? scopeNames[scope])}
                </span>
                <span className="text-xs text-muted-foreground">{visibleSkills.length}</span>
              </div>
              <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
                <div
                  ref={listRef}
                  className="flex flex-col divide-y divide-border/60"
                  onKeyDown={(event) => {
                    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                    const buttons = [
                      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        '[data-skill-row]',
                      ),
                    ]
                    const index = buttons.findIndex((button) => button === document.activeElement)
                    if (index < 0) return
                    event.preventDefault()
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? buttons.length - 1
                          : Math.max(
                              0,
                              Math.min(
                                buttons.length - 1,
                                index + (event.key === 'ArrowDown' ? 1 : -1),
                              ),
                            )
                    buttons[next]?.focus()
                  }}
                >
                  {visibleSkills.map((skill) => {
                    const currentAssignment = assignments.find(
                      (entry) => entry.skillId === skill.id,
                    )
                    const currentVersion = skillVersion(skill, currentAssignment?.versionId)
                    const status = !skill.enabled
                      ? '已停用'
                      : currentVersion?.readiness === 'restricted'
                        ? '未就绪'
                        : scope === 'library'
                          ? `${catalog.assignments.filter((entry) => entry.skillId === skill.id).length} 项分配`
                          : currentAssignment?.enabled
                            ? '已分配'
                            : '已停用'
                    return (
                      <Button
                        key={skill.id}
                        data-skill-row={skill.id}
                        size="sm-multiline"
                        variant="ghost"
                        className="h-auto min-w-0 justify-start rounded-none px-3 py-2.5 text-left pointer-coarse:after:inset-0"
                        aria-pressed={selected?.id === skill.id}
                        data-pressed={selected?.id === skill.id || undefined}
                        title={skill.displayName}
                        onClick={() => {
                          setSelectedId(skill.id)
                          setSelectedVersionId('')
                          setMobileDetail(true)
                        }}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm">
                              {skill.displayName}
                            </span>
                            <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
                              {status}
                            </span>
                          </span>
                          <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">
                            {skill.description || skill.name}
                          </span>
                        </span>
                      </Button>
                    )
                  })}
                </div>
                {!visibleSkills.length ? (
                  <SkillEmpty
                    title={
                      query ? '没有匹配的技能' : scope === 'library' ? '技能库为空' : '尚未分配技能'
                    }
                    description={
                      query
                        ? '换一个名称或关键词试试。'
                        : canManage
                          ? scope === 'library'
                            ? '导入 SKILL.md、ZIP 或公开 Git 技能包。'
                            : '从中央库添加技能，并选择固定版本与工作区范围。'
                          : '请联系管理员分配可用技能。'
                    }
                  />
                ) : null}
              </ScrollArea>
            </aside>
          ) : null}
          {showDetail ? (
            <section
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              aria-label="技能详情"
            >
              {selected && version ? (
                <>
                  <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {narrow ? (
                        <FileSurfaceAction
                          label="返回技能列表"
                          onPress={() => {
                            setMobileDetail(false)
                            requestAnimationFrame(() =>
                              listRef.current
                                ?.querySelector<HTMLButtonElement>(
                                  `[data-skill-row="${selected.id}"]`,
                                )
                                ?.focus(),
                            )
                          }}
                        >
                          <ArrowLeftIcon />
                        </FileSurfaceAction>
                      ) : null}
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
                      <Menu>
                        <MenuTrigger
                          ref={menuTrigger}
                          aria-label="技能操作"
                          render={<Button variant="ghost" size="icon-sm" />}
                        >
                          <MoreHorizontalIcon />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem
                            onClick={() => openDialog({ type: 'details', skill: selected }, true)}
                          >
                            <InfoIcon />
                            分配与版本详情
                          </MenuItem>
                          {canManage ? (
                            <>
                              <MenuItem
                                disabled={
                                  busy ||
                                  !selected.enabled ||
                                  !selected.versions.some((entry) => entry.readiness === 'ready')
                                }
                                onClick={() =>
                                  openDialog(
                                    {
                                      type: 'assign',
                                      skillId: selected.id,
                                      ...(assignment ? { assignment } : {}),
                                    },
                                    true,
                                  )
                                }
                              >
                                <PlusIcon />
                                {assignment ? '调整当前分配' : '分配技能'}
                              </MenuItem>
                              <MenuItem
                                disabled={busy}
                                onClick={() =>
                                  openDialog({ type: 'import', skill: selected }, true)
                                }
                              >
                                <UploadIcon />
                                导入新版本
                              </MenuItem>
                              <MenuItem
                                disabled={busy}
                                onClick={() =>
                                  void mutate(
                                    {
                                      action: 'verify',
                                      skillId: selected.id,
                                      versionId: version.id,
                                    },
                                    '版本文件已重新校验。',
                                  )
                                }
                              >
                                <RefreshCwIcon />
                                重新校验版本
                              </MenuItem>
                              <MenuSeparator />
                              <MenuItem
                                disabled={busy}
                                onClick={() =>
                                  void mutate(
                                    {
                                      action: 'set-enabled',
                                      skillId: selected.id,
                                      enabled: !selected.enabled,
                                    },
                                    selected.enabled
                                      ? '技能已停用，后续轮次不能再调用。'
                                      : '技能已启用，可在已授权范围使用。',
                                  )
                                }
                              >
                                {selected.enabled ? '停用技能' : '启用技能'}
                              </MenuItem>
                              <MenuItem
                                disabled={busy}
                                onClick={() =>
                                  openDialog({ type: 'delete', skill: selected }, true)
                                }
                              >
                                删除技能
                              </MenuItem>
                            </>
                          ) : null}
                        </MenuPopup>
                      </Menu>
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
                        尚未分配。在“技能操作”中分配给助手或项目后，可在对应对话中使用。
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
