import { useState, type ReactNode } from 'react'
import { CheckIcon, FolderIcon, PlusIcon } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '~/components/ui/popover'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Spinner } from '~/components/ui/spinner'
import { cn } from '~/lib/utils'
import {
  skillSourceName,
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
  busy: boolean
  pendingTarget: string | null
  actions: ReactNode
  onOpen: () => void
  onToggle: (skill: LibrarySkill, type: SkillTargetType, id: string) => void
}

/** T3 theme-result cards with Skills Manager's direct target toggles. */
export function SkillLibraryCard({
  skill,
  catalog,
  busy,
  pendingTarget,
  actions,
  onOpen,
  onToggle,
}: CardProps) {
  const version = skillVersion(skill)
  const assignments = catalog.assignments.filter((entry) => entry.skillId === skill.id)
  const projectAssignments = assignments.filter((entry) => entry.targetType === 'project')
  const shownProjects =
    catalog.projects.length <= 3
      ? catalog.projects
      : catalog.projects
          .filter((project) => projectAssignments.some((entry) => entry.targetId === project.id))
          .slice(0, 3)
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
      <div className="flex min-w-0 items-start gap-2">
        <h2 className="min-w-0 flex-1">
          <Button
            data-skill-row={skill.id}
            variant="link"
            size="sm-multiline"
            className="w-full min-w-0 justify-start px-0 py-0 text-left pointer-coarse:after:inset-0"
            title={skill.displayName}
            onClick={onOpen}
          >
            <span className="line-clamp-2 min-w-0 text-sm font-medium wrap-anywhere">
              {skill.displayName}
            </span>
          </Button>
        </h2>
        {actions}
      </div>
      <p className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground wrap-anywhere">
        {skill.description || '尚未提供技能描述。'}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Badge
          size="sm"
          variant={
            !skill.enabled ? 'outline' : version?.readiness === 'ready' ? 'success' : 'warning'
          }
        >
          {!skill.enabled
            ? '已停用'
            : version?.readiness === 'ready'
              ? '可分配'
              : skill.versions.length > 1
                ? '最新版本未就绪'
                : '未就绪'}
        </Badge>
        {version ? <span>{skillSourceName(version.source)}</span> : null}
        <Button variant="link" size="xs" className="ml-auto shrink-0" onClick={onOpen}>
          查看文件
        </Button>
      </div>
      {version?.readiness === 'restricted' ? (
        <p
          className="line-clamp-2 text-xs text-warning-foreground wrap-anywhere"
          title={version.reason ?? undefined}
        >
          {skill.versions.length > 1 ? '最新版本运行条件未满足：' : '运行条件未满足：'}
          {version.reason ?? '当前运行器无法执行此技能。'}
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          新分配：{version?.id.slice(0, 8) ?? '无可用版本'} · 仅内部工作区
        </p>
      )}
      <div className="mt-auto space-y-3 border-t border-border/60 pt-3">
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">助手</span>
          <div className="flex min-w-0 flex-wrap gap-1.5" aria-label="助手分配">
            {catalog.agents.map((agent) => target('agent', agent))}
            {!catalog.agents.length ? (
              <span className="text-xs text-muted-foreground">没有可用助手</span>
            ) : null}
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">项目</span>
            <Popover
              onOpenChange={(open) => {
                if (!open) setProjectQuery('')
              }}
            >
              <PopoverTrigger
                aria-label={`项目分配：${skill.displayName}`}
                render={<Button variant="ghost" size="xs" />}
              >
                <FolderIcon />
                选择项目
              </PopoverTrigger>
              <PopoverPopup width="md" padding="compact" align="end" touchBackdrop>
                <div className="space-y-2">
                  <PopoverTitle>项目分配</PopoverTitle>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    勾选为单独分配。取消项目分配后，沿用助手设置。
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
          <div className="flex min-w-0 flex-wrap gap-1.5" aria-label="项目分配摘要">
            {shownProjects.map((project) => target('project', project))}
            {!shownProjects.length ? (
              <span className="text-xs text-muted-foreground">尚未单独分配，沿用助手设置</span>
            ) : null}
            {projectAssignments.length > shownProjects.length ? (
              <span className="self-center text-xs text-muted-foreground">
                另有 {projectAssignments.length - shownProjects.length} 项
              </span>
            ) : null}
          </div>
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
        ? '请先启用技能'
        : '此版本尚未满足运行条件'
      : active
        ? '再次点击取消单独分配'
        : assignment
          ? '点击恢复原版本与原工作区范围'
          : '点击分配展示版本，仅内部工作区'
  return (
    <Button
      size={expanded ? 'sm-multiline' : 'xs'}
      variant={active ? 'secondary' : expanded ? 'ghost' : 'outline'}
      className={cn(
        'min-w-0 max-w-full justify-start pointer-coarse:min-h-11 pointer-coarse:after:inset-0',
        expanded && 'w-full text-left',
      )}
      data-skill-target-type={type}
      data-skill-target-id={target.id}
      aria-label={`${target.name}：${state}`}
      aria-pressed={active}
      aria-busy={pending}
      disabled={busy || !canManage || !allowed}
      title={`${target.name} · ${state}。${hint}`}
      onClick={onToggle}
    >
      {pending ? <Spinner size="sm" /> : active ? <CheckIcon /> : <PlusIcon />}
      {expanded ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs">{target.name}</span>
          <span className="block truncate text-[11px] font-normal text-muted-foreground">
            {state}
          </span>
        </span>
      ) : (
        <span className="min-w-0 truncate">
          {target.name}
          {assignment && !active ? ' · 已停用' : ''}
        </span>
      )}
    </Button>
  )
}
