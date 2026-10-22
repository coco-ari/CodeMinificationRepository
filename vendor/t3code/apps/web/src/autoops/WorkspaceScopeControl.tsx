import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'
import { readAutoOpsThreadScope, setAutoOpsThreadScope } from './hostConfig'
import { useAutoOpsThreadScope } from './useThreadScope'
import { loadWorkspaces, type WorkspaceVersion } from './workspaces'

export function WorkspaceScopeControl({threadId, projectId, isDraft}: {threadId:string;projectId:string;isDraft:boolean}) {
  const subscribed = useAutoOpsThreadScope(threadId)
  const scope = subscribed ?? readAutoOpsThreadScope(threadId, projectId)
  const [versions, setVersions] = useState<WorkspaceVersion[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void loadWorkspaces(projectId, controller.signal).then((result) => {
      const available = [...result.internalVersions, ...result.externalVersions].filter((version) => version.status === 'published')
      setVersions(available)
      const current = readAutoOpsThreadScope(threadId, projectId)
      if (isDraft && current && !current.workspaceVersionId) {
        const initial = available.find((version) => version.type === 'internal')
        if (initial) setAutoOpsThreadScope(threadId, {...current, workspaceType:initial.type, workspaceVersionId:initial.id})
      }
      setError(null)
    }).catch((cause:unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法读取工作区')
    })
    return () => controller.abort()
  }, [threadId, projectId, isDraft])
  if (!scope) return null
  const selected = versions.find((version) => version.id === scope.workspaceVersionId)
  const label = selected ? `${selected.type === 'internal' ? '内部' : '外部'} · ${selected.name}` : scope.workspaceType ? `${scope.workspaceType === 'internal' ? '内部原始' : '外部脱敏'} · 固定版本` : '原有项目资料'
  return <>
    {error ? <span role="alert" className="text-destructive">{error}</span> : isDraft ? (
      <Select value={scope.workspaceVersionId ?? ''} disabled={!versions.length} onValueChange={(value) => {
        const version = versions.find((entry) => entry.id === value)
        if (version) setAutoOpsThreadScope(threadId, {...scope, workspaceType:version.type, workspaceVersionId:version.id})
      }}>
        <SelectTrigger size="xs" variant="ghost" aria-label="对话工作区"><SelectValue>{selected ? label : '正在读取工作区…'}</SelectValue></SelectTrigger>
        <SelectPopup>{versions.map((version) => <SelectItem key={version.id} value={version.id}>{version.type === 'internal' ? '内部原始' : '外部脱敏'} · {version.name}</SelectItem>)}</SelectPopup>
      </Select>
    ) : <span aria-label="固定工作区" className="text-muted-foreground">{label}</span>}
    <Link to="/workspaces" className="text-muted-foreground underline-offset-4 hover:underline">管理工作区</Link>
  </>
}
