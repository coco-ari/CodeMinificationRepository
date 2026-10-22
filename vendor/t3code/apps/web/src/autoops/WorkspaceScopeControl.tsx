import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { FolderGit2Icon, ShieldCheckIcon, type LucideIcon } from 'lucide-react'
import { ComposerControl, ComposerControlChevron } from '~/components/chat/ComposerControl'
import { ComposerContextLabel } from '~/components/ComposerContextLabel'
import { useComposerMenuProps } from '~/components/chat/composerEventScope'
import { Menu, MenuTrigger, MenuPopup, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuItem } from '~/components/ui/menu'
import { Tooltip, TooltipTrigger, TooltipPopup } from '~/components/ui/tooltip'
import { readAutoOpsHost, readAutoOpsThreadScope, type AutoOpsThreadScope } from './hostConfig'
import { loadWorkspaces, type WorkspaceOverview, type WorkspaceVersion } from './workspaces'

export function availableWorkspaceVersions(projectId: string, overview: WorkspaceOverview): WorkspaceVersion[] {
  const membership = readAutoOpsHost()?.projects.find((project) => project.id === projectId)?.membership
  return [...(membership?.workspaceAccess === 'external' ? [] : overview.internalVersions), ...overview.externalVersions]
    .filter((version) => version.status === 'published')
}

export function ScopeComposerChoice({ label, summary, icon: Icon, value, options, locked, disabled, onChange, footer }: {
  label: string
  summary: string
  icon: LucideIcon
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  locked: boolean
  disabled: boolean
  onChange: (value: string) => void
  footer?: ReactNode
}) {
  const floating = useComposerMenuProps()
  const content = <><Icon className="size-3 shrink-0" /><ComposerContextLabel>{summary}</ComposerContextLabel></>
  if (locked) return <Tooltip><TooltipTrigger render={<span
    aria-label={label} aria-description={summary}
    className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
    data-composer-context-control data-autoops-scope-locked="true"
  >{content}</span>} /><TooltipPopup>{summary} · 首条消息已接受，切换范围请新建对话。</TooltipPopup></Tooltip>
  return <Menu>
    <Tooltip><TooltipTrigger render={<MenuTrigger
      render={<ComposerControl size="xs" />} aria-label={label} aria-description={summary} disabled={disabled} data-composer-context-control
    >{content}<ComposerControlChevron size="xs" /></MenuTrigger>} /><TooltipPopup>{summary}</TooltipPopup></Tooltip>
    <MenuPopup side="top" align="start" {...floating}>
      <MenuGroup><MenuGroupLabel>{label}</MenuGroupLabel><MenuRadioGroup value={value} onValueChange={onChange}>{options.map((option) => <MenuRadioItem key={option.value} value={option.value} closeOnClick>{option.label}</MenuRadioItem>)}</MenuRadioGroup></MenuGroup>
      {footer ? <><MenuSeparator />{footer}</> : null}
    </MenuPopup>
  </Menu>
}

export function WorkspaceScopeControl({ threadId, projectId, scope, locked, disabled, onChange, onInitialize }: {
  threadId: string
  projectId: string
  scope: AutoOpsThreadScope
  locked: boolean
  disabled: boolean
  onChange: (version: WorkspaceVersion) => void
  onInitialize: (scope: AutoOpsThreadScope) => void
}) {
  const project = readAutoOpsHost()?.projects.find((entry) => entry.id === projectId)
  const navigate = useNavigate()
  const [versions, setVersions] = useState<WorkspaceVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void loadWorkspaces(projectId, controller.signal).then((result) => {
      setVersions(availableWorkspaceVersions(projectId, result)); setLoading(false); setError(null)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) { setLoading(false); setError(cause instanceof Error ? cause.message : '无法读取工作区') }
    })
    return () => controller.abort()
  }, [projectId, attempt])
  useEffect(() => {
    if (locked || disabled || loading || error) return
    const current = readAutoOpsThreadScope(threadId, projectId)
    if (!current || versions.some((version) => version.id === current.workspaceVersionId)) return
    const type = project?.membership?.workspaceAccess === 'external' ? 'external' : current.workspaceType ?? 'internal'
    const initial = versions.find((version) => version.type === type)
    if (initial) onInitialize({ ...current, workspaceType: initial.type, workspaceVersionId: initial.id })
  }, [threadId, projectId, project, versions, loading, error, locked, disabled, onInitialize])
  const selected = versions.find((version) => version.id === scope.workspaceVersionId)
  const summary = selected ? `${selected.type === 'internal' ? '内部' : '外部'} · ${selected.name}`
    : scope.workspaceVersionId ? `${scope.workspaceType === 'external' ? '外部脱敏' : '内部原始'} · 固定版本`
    : loading ? '正在读取工作区…' : project?.membership?.workspaceAccess === 'external' ? '暂无已发布外部版本' : '选择工作区'
  return <ScopeComposerChoice
    label="对话工作区" summary={summary} icon={scope.workspaceType === 'external' ? ShieldCheckIcon : FolderGit2Icon}
    value={scope.workspaceVersionId ?? ''} locked={locked} disabled={disabled || loading}
    options={versions.map((version) => ({ value: version.id, label: `${version.type === 'internal' ? '内部原始' : '外部脱敏'} · ${version.name}` }))}
    onChange={(id) => { const version = versions.find((entry) => entry.id === id); if (version) onChange(version) }}
    footer={<>
      {error ? <MenuItem onClick={() => setAttempt((value) => value + 1)}>读取失败，点击重试</MenuItem> : !versions.length ? <MenuItem disabled>{project?.membership?.workspaceAccess === 'external' ? '请等待项目管理员发布外部版本' : '请先创建可用工作区版本'}</MenuItem> : null}
      {project?.membership?.workspaceAccess !== 'external' ? <MenuItem onClick={() => void navigate({ to: '/workspaces' })}>{project?.membership?.role === 'member' ? '查看工作区' : '管理工作区'}</MenuItem> : null}
    </>}
  />
}
