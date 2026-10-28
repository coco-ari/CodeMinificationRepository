import { useState, type ReactNode } from 'react'
import { CheckIcon, CircleAlertIcon, FolderIcon, PlusIcon, SparklesIcon } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '~/components/ui/popover'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Spinner } from '~/components/ui/spinner'
import { Toggle } from '~/components/ui/toggle'
import {
  skillVersion,
  type LibrarySkill,
  type SkillAssignment,
  type SkillLibrary,
  type SkillTargetType,
} from './skillLibrary'

export const skillTargetKey = (skillId: string, type: SkillTargetType, id: string) =>
  `${skillId}:${type}:${id}`

export function skillQuickAssignmentAllowed(skill: LibrarySkill, assignment?: SkillAssignment) {
  if (assignment?.enabled) return true
  const version = assignment
    ? skill.versions.find((entry) => entry.id === assignment.versionId)
    : skillVersion(skill)
  return skill.enabled && version?.readiness === 'ready'
}

type CardProps = {
  skill: LibrarySkill
  catalog: SkillLibrary
  projectId: string
  busy: boolean
  pendingTarget: string | null
  actions: ReactNode
  onOpen: () => void
  onProjectOpenChange: (open: boolean) => void
  onToggle: (skill: LibrarySkill, type: SkillTargetType, id: string) => void
}

/** 复用 T3 目录卡片，保留 Skills Manager 的就地分配操作。 */
export function SkillLibraryCard({
  skill,
  catalog,
  projectId,
  busy,
  pendingTarget,
  actions,
  onOpen,
  onProjectOpenChange,
  onToggle,
}: CardProps) {
  const version = skillVersion(skill)
  const assignments = catalog.assignments.filter((entry) => entry.skillId === skill.id)
  const projectAssignments = assignments.filter((entry) => entry.targetType === 'project')
  const currentProject = catalog.projects.find((project) => project.id === projectId)
  const otherAssignmentCount = projectAssignments.filter(
    (entry) => entry.targetId !== projectId,
  ).length
  const [projectQuery, setProjectQuery] = useState('')
  const projects = catalog.projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(projectQuery.toLocaleLowerCase().trim()),
  )
  const target = (type: SkillTargetType, entry: { id: string; name: string }, expanded = false) => {
    const assignment = assignments.find(
      (item) => item.targetType === type && item.targetId === entry.id,
    )
    return (
      <SkillTargetButton
        key={entry.id}
        skill={skill}
        type={type}
        target={entry}
        assignment={assignment}
        expanded={expanded}
        busy={busy}
        canManage={catalog.canManage}
        pending={pendingTarget === skillTargetKey(skill.id, type, entry.id)}
        onToggle={() => onToggle(skill, type, entry.id)}
      />
    )
  }
  return (
    <article
      data-skill-card={skill.id}
      className="group flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/60 p-3 transition-colors hover:bg-accent/20"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground"
          aria-hidden="true"
        >
          <SparklesIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="min-w-0">
            <button
              type="button"
              data-skill-row={skill.id}
              className="w-full min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card pointer-coarse:min-h-11"
              title={skill.displayName}
              onClick={onOpen}
            >
              {skill.displayName}
            </button>
          </h2>
          <p className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground wrap-anywhere">
            {skill.description || '尚未提供skill描述。'}
          </p>
        </div>
        {actions}
      </div>
      {!skill.enabled || version?.readiness === 'restricted' ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {!skill.enabled ? (
            <Badge size="sm" variant="outline">
              已停用
            </Badge>
          ) : null}
          {version?.readiness === 'restricted' ? (
            <Popover>
              <PopoverTrigger render={<Button variant="ghost" size="xs" />}>
                <CircleAlertIcon />
                {skill.versions.length > 1 ? '最新版本未就绪' : '未就绪'}
              </PopoverTrigger>
              <PopoverPopup width="md" padding="compact" align="start" touchBackdrop>
                <div className="space-y-2">
                  <PopoverTitle>运行条件未满足</PopoverTitle>
                  <p className="text-xs leading-relaxed text-muted-foreground wrap-anywhere">
                    {version.reason ?? '当前执行环境无法使用此skill。'}
                  </p>
                </div>
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
      ) : null}
      <div className="mt-auto grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 border-t border-border/60 pt-2">
        <span className="pt-1.5 text-xs text-muted-foreground pointer-coarse:pt-3.5">助手</span>
        <div
          className="flex min-w-0 flex-wrap items-center gap-1"
          role="group"
          aria-label="助手分配"
        >
          {catalog.agents.map((agent) => target('agent', agent))}
          {!catalog.agents.length ? (
            <span className="text-xs text-muted-foreground">没有可用助手</span>
          ) : null}
        </div>
        <span className="pt-1.5 text-xs text-muted-foreground pointer-coarse:pt-3.5">项目</span>
        <div
          className="flex min-w-0 flex-wrap items-center gap-1"
          role="group"
          aria-label="项目分配摘要"
        >
          {currentProject ? target('project', currentProject) : null}
          <Popover
            onOpenChange={(open) => {
              onProjectOpenChange(open)
              if (!open) setProjectQuery('')
            }}
          >
            <PopoverTrigger
              aria-label={`项目分配：${skill.displayName}`}
              render={<Button variant="ghost" size="xs" />}
            >
              <FolderIcon />
              {currentProject ? '更多项目' : '选择项目'}
              {otherAssignmentCount > 0 ? ` · ${otherAssignmentCount}` : ''}
            </PopoverTrigger>
            <PopoverPopup width="md" padding="compact" align="end" touchBackdrop>
              <div className="space-y-2">
                <PopoverTitle>项目分配</PopoverTitle>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  点击分配，再点取消。未单独分配的项目沿用助手设置。
                </p>
                <Input
                  size="sm"
                  type="search"
                  aria-label="搜索分配项目"
                  placeholder="搜索项目"
                  value={projectQuery}
                  onChange={(event) => setProjectQuery(event.currentTarget.value)}
                />
                <ScrollArea contentSizing="viewport" className="max-h-72" radius="none">
                  <div className="flex min-w-0 flex-col gap-1" aria-label="项目分配列表">
                    {projects.map((project) => target('project', project, true))}
                    {!projects.length ? (
                      <p className="py-3 text-center text-xs text-muted-foreground">
                        没有匹配的项目
                      </p>
                    ) : null}
                  </div>
                </ScrollArea>
              </div>
            </PopoverPopup>
          </Popover>
        </div>
      </div>
    </article>
  )
}

function SkillTargetButton({
  skill,
  type,
  target,
  assignment,
  expanded,
  busy,
  canManage,
  pending,
  onToggle,
}: {
  skill: LibrarySkill
  type: SkillTargetType
  target: { id: string; name: string }
  assignment: SkillAssignment | undefined
  expanded: boolean
  busy: boolean
  canManage: boolean
  pending: boolean
  onToggle: () => void
}) {
  const active = assignment?.enabled === true
  const allowed = skillQuickAssignmentAllowed(skill, assignment)
  const workspaceNames = assignment?.workspaceTypes
    .map((value) => (value === 'internal' ? '内部' : '外部'))
    .join('、')
  const state = active
    ? `${workspaceNames} · ${assignment.versionId.slice(0, 8)}`
    : assignment
      ? '已单独停用'
      : type === 'project'
        ? '沿用助手设置'
        : '尚未分配'
  const hint = !canManage
    ? '当前账号无管理权限'
    : !allowed
      ? !skill.enabled
        ? '请先启用skill'
        : '此版本尚未满足运行条件'
      : active
        ? '再次点击取消单独分配'
        : assignment
          ? '点击恢复原版本与原工作区范围'
          : '点击分配最新版本，仅内部工作区'
  const targetProps = {
    'data-skill-target-type': type,
    'data-skill-target-id': target.id,
    'aria-label': `${target.name}：${state}`,
    'aria-busy': pending,
    disabled: busy || !canManage || !allowed,
    title: `${target.name} · ${state}。${hint}`,
  }
  const indicator = pending ? <Spinner size="sm" /> : active ? <CheckIcon /> : <PlusIcon />
  return expanded ? (
    <Button
      {...targetProps}
      size="sm-multiline"
      variant={active ? 'secondary' : 'ghost'}
      className="w-full min-w-0 max-w-full justify-start text-left pointer-coarse:min-h-11 pointer-coarse:after:inset-0"
      aria-pressed={active}
      onClick={onToggle}
    >
      {indicator}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">{target.name}</span>
        <span className="block truncate text-[11px] font-normal text-muted-foreground">
          {state}
        </span>
      </span>
    </Button>
  ) : (
    <Toggle
      {...targetProps}
      size="compact"
      variant="ghost"
      className="min-w-0 max-w-full justify-start pointer-coarse:min-h-11 pointer-coarse:after:inset-0"
      pressed={active}
      onPressedChange={onToggle}
    >
      {indicator}
      <span className="min-w-0 truncate">
        {target.name}
        {assignment && !active ? ' · 已停用' : ''}
      </span>
    </Toggle>
  )
}
