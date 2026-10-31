import { useState, type ReactNode } from 'react'
import { BotIcon, CircleAlertIcon, SparklesIcon } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '~/components/ui/popover'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Spinner } from '~/components/ui/spinner'
import { Toggle } from '~/components/ui/toggle'
import {
  skillVersion,
  skillScopeNames,
  GLOBAL_SKILL_TARGET,
  inheritedSkillAssignment,
  canManageSkillScope,
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
  mode?: 'project' | 'global' | 'all'
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
/** 复用 T3 目录卡片与原生菜单，只显示当前项目的三级启用范围。 */
export function SkillLibraryCard({
  skill,
  mode = 'all',
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
  const [query, setQuery] = useState('')
  const assistants = catalog.assistants.filter(
    (entry) => entry.projectId === projectId && entry.executionKind === 'platform',
  )
  const filtered = assistants.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
  )
  const inherited = inheritedSkillAssignment(catalog, skill.id, 'assistant', projectId)
  const assignedCount = catalog.assignments.filter(
    (entry) =>
      entry.skillId === skill.id &&
      entry.targetType === 'assistant' &&
      entry.projectId === projectId &&
      entry.enabled &&
      assistants.some((item) => item.id === entry.targetId),
  ).length
  const target = (type: SkillTargetType, id: string, name: string) => {
    const assignment = catalog.assignments.find(
      (entry) =>
        entry.skillId === skill.id &&
        entry.targetType === type &&
        entry.targetId === id &&
        (type !== 'assistant' || entry.projectId === projectId),
    )
    const parent = inheritedSkillAssignment(catalog, skill.id, type, projectId)
    const active = skill.enabled && !!(parent || assignment?.enabled)
    const state = !skill.enabled
      ? 'skill 已停用'
      : parent
        ? `已继承 · ${skillScopeNames[parent.targetType]}`
        : active
          ? '已启用'
          : '未启用'
    const canManage = canManageSkillScope(catalog, type, projectId)
    const pending = pendingTarget === skillTargetKey(skill.id, type, id)
    return (
      <Toggle
        key={id}
        size="compact"
        variant="ghost"
        data-skill-target-type={type}
        data-skill-target-id={id}
        className="min-w-0 max-w-full justify-start pointer-coarse:min-h-11 pointer-coarse:after:inset-0"
        pressed={active}
        aria-label={`${name}：${state}`}
        aria-busy={pending}
        title={`${name} · ${state}${parent ? '；关闭上层后可单独设置' : !canManage ? '；当前账号无管理权限' : ''}`}
        disabled={busy || !!parent || !canManage || !skillQuickAssignmentAllowed(skill, assignment)}
        onPressedChange={() => onToggle(skill, type, id)}
      >
        {pending ? <Spinner size="sm" /> : null}
        <span className="min-w-0 truncate">{name}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground">
          {parent ? '已继承' : active ? '已启用' : '未启用'}
        </span>
      </Toggle>
    )
  }
  return (
    <article
      data-skill-card={skill.id}
      className="group flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/60 p-3 transition-colors hover:bg-accent/20"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
          aria-hidden="true"
        >
          <SparklesIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="min-w-0">
            <button
              type="button"
              data-skill-row={skill.id}
              className="w-full min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11"
              title={skill.displayName}
              onClick={onOpen}
            >
              {skill.displayName}
            </button>
          </h2>
          <p className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground wrap-anywhere">
            {skill.description || '尚未提供 skill 描述。'}
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
                <PopoverTitle>运行条件未满足</PopoverTitle>
                <p className="mt-2 text-xs text-muted-foreground wrap-anywhere">
                  {version.reason ?? '当前执行环境无法使用此 skill。'}
                </p>
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
      ) : null}
      <div
        className="mt-auto flex min-w-0 flex-wrap items-center gap-1 border-t border-border/60 pt-2"
        role="group"
        aria-label="skill 启用范围"
      >
        {mode !== 'project' ? (
          target('global', GLOBAL_SKILL_TARGET, '所有项目')
        ) : inherited?.targetType === 'global' && skill.enabled ? (
          <span className="px-1 text-xs text-muted-foreground">已继承所有项目</span>
        ) : null}
        {mode !== 'global' ? target('project', projectId, '当前项目') : null}
        {mode !== 'global' ? (
          <Popover
            onOpenChange={(open) => {
              onProjectOpenChange(open)
              if (!open) setQuery('')
            }}
          >
            <PopoverTrigger
              aria-label={`指定助手：${skill.displayName}`}
              render={<Button size="xs" variant="ghost" />}
            >
              <BotIcon />
              指定助手
              {inherited && skill.enabled
                ? ' · 已继承'
                : assignedCount
                  ? ` · ${assignedCount}`
                  : ''}
            </PopoverTrigger>
            <PopoverPopup width="md" padding="compact" align="end" touchBackdrop>
              <div className="space-y-2">
                <PopoverTitle>当前项目的助手</PopoverTitle>
                {inherited && skill.enabled ? (
                  <p className="text-xs text-muted-foreground">
                    已继承“{skillScopeNames[inherited.targetType]}”，无需重复开启。
                  </p>
                ) : null}
                <Input
                  size="sm"
                  type="search"
                  aria-label="搜索指定助手"
                  placeholder="搜索助手"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
                <ScrollArea className="max-h-72" radius="none">
                  <div className="flex min-w-0 flex-col gap-1" aria-label="指定助手列表">
                    {filtered.map((entry) => target('assistant', entry.id, entry.name))}
                    {!filtered.length ? (
                      <p className="py-3 text-center text-xs text-muted-foreground">
                        {assistants.length ? '没有匹配的助手' : '当前项目没有启用的助手'}
                      </p>
                    ) : null}
                  </div>
                </ScrollArea>
              </div>
            </PopoverPopup>
          </Popover>
        ) : null}
      </div>
    </article>
  )
}
