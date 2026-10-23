import { useEffect, useState } from 'react'
import { ScopeReadError } from './ScopeReadError'
import { autoOpsProjectHref } from './projectNavigation'
import { autoOpsAreaAvailable } from './projectNavigation.logic'
import { useNavigate } from '@tanstack/react-router'
import { FolderGit2Icon, ShieldCheckIcon } from 'lucide-react'
import { MenuItem } from '~/components/ui/menu'
import { readAutoOpsHost, readAutoOpsThreadScope, type AutoOpsThreadScope } from './hostConfig'
import { loadWorkspaces, type WorkspaceVersion } from './workspaces'
import { ScopeComposerChoice, availableWorkspaceVersions } from './scopeSelection'
// 保留原公开入口，现有调用方可以逐步转向共享选择器。
export { ScopeComposerChoice, availableWorkspaceVersions } from './scopeSelection'

export function WorkspaceScopeControl({ threadId, projectId, scope, locked, disabled, onChange, onInitialize }: {
  threadId: string
  projectId: string
  scope: AutoOpsThreadScope
  locked: boolean
  disabled: boolean
  onChange: (version: WorkspaceVersion) => void
  onInitialize: (scope: AutoOpsThreadScope) => void
}) {
  const host = readAutoOpsHost()
  const project = host?.projects.find((entry) => entry.id === projectId)
  const canRead = autoOpsAreaAvailable('workspaces', host, projectId)
  const navigate = useNavigate()
  const [loaded, setVersions] = useState<{ projectId: string; versions: WorkspaceVersion[] } | null>(null)
  const versions = canRead && loaded?.projectId === projectId ? loaded.versions : []
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setVersions(null)
    if (!canRead) {
      setLoading(false)
      setError('当前项目没有工作区读取权限。')
      return
    }
    const controller = new AbortController()
    setLoading(true)
    void loadWorkspaces(projectId, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setVersions({ projectId, versions: availableWorkspaceVersions(projectId, result) }); setLoading(false); setError(null)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) { setLoading(false); setError(cause instanceof Error ? cause.message : '无法读取工作区') }
    })
    return () => controller.abort()
  }, [projectId, attempt, canRead])
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
  return <><ScopeComposerChoice
    label="对话工作区" summary={summary} icon={scope.workspaceType === 'external' ? ShieldCheckIcon : FolderGit2Icon}
    value={scope.workspaceVersionId ?? ''} locked={locked} disabled={disabled || loading}
    options={versions.map((version) => ({ value: version.id, label: `${version.type === 'internal' ? '内部原始' : '外部脱敏'} · ${version.name}` }))}
    onChange={(id) => { const version = versions.find((entry) => entry.id === id); if (version) onChange(version) }}
    footer={<>
      {error ? <MenuItem onClick={() => setAttempt((value) => value + 1)}>读取失败，点击重试</MenuItem> : !versions.length ? <MenuItem disabled>{project?.membership?.workspaceAccess === 'external' ? '请等待项目管理员发布外部版本' : '请先创建可用工作区版本'}</MenuItem> : null}
      {canRead ? <MenuItem onClick={() => void navigate({ href: autoOpsProjectHref('workspaces', projectId) })}>{project?.capabilities?.['workspace.manage'] === true ? '管理工作区' : '查看工作区'}</MenuItem> : null}
    </>}
  />
    {locked && error ? <ScopeReadError label="工作区读取失败" error={error} busy={loading} onRetry={() => setAttempt((value) => value + 1)} /> : null}
  </>
}
