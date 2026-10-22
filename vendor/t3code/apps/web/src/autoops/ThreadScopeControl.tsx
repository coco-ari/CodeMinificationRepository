import { useEffect, useState } from 'react'
import { WorkspaceScopeControl } from './WorkspaceScopeControl'
import { useAutoOpsThreadScope } from './useThreadScope'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'
import {
  loadAutoOpsThreadScope,
  readAutoOpsHost,
  readAutoOpsThreadScope,
  setAutoOpsThreadScope,
  type AutoOpsThreadScope,
} from './hostConfig'

/** Business scope is the only extra row; the timeline/composer remain upstream. */
export function AutoOpsThreadScopeControl({
  threadId,
  projectId,
  isDraft,
}: {
  threadId: string
  projectId: string
  isDraft: boolean
}) {
  const host = readAutoOpsHost()
  const knownScope = useAutoOpsThreadScope(threadId)
  const [, refresh] = useState(0)
  const [loadedThread, setLoadedThread] = useState<string | null>(null)
  const [failedThread, setFailedThread] = useState<string | null>(null)
  useEffect(() => {
    if (!host) return
    if (isDraft) {
      const scope = readAutoOpsThreadScope(threadId, projectId)
      if (scope) setAutoOpsThreadScope(threadId, scope)
      return
    }
    const controller = new AbortController()
    void loadAutoOpsThreadScope(threadId, controller.signal)
      .then(() => {
        setLoadedThread(threadId)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailedThread(threadId)
      })
    return () => controller.abort()
  }, [host, threadId, projectId, isDraft])
  if (!host) return null
  if (!isDraft && failedThread === threadId)
    return (
      <div role="alert" className="px-4 py-2 text-sm text-destructive">
        无法读取此会话的项目权限。
      </div>
    )
  if (!isDraft && loadedThread !== threadId)
    return (
      <div className="px-4 py-2 text-xs text-muted-foreground" role="status">
        正在读取会话范围…
      </div>
    )
  const project = host.projects.find((entry) => entry.id === projectId)
  const scope = knownScope ?? readAutoOpsThreadScope(threadId, projectId)
  if (!project || !scope)
    return (
      <div role="alert" className="px-4 py-2 text-sm text-destructive">
        此项目没有可用的环境或 Agent。
      </div>
    )
  const change = (patch: Partial<AutoOpsThreadScope>) => {
    setAutoOpsThreadScope(threadId, { ...scope, ...patch })
    refresh((value) => value + 1)
  }
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-xs"
      data-autoops-thread-scope
    >
      <span className="text-muted-foreground">{project.name}</span>
      {scope.nativeParentThreadId ? (
        <span role="status" className="text-muted-foreground">
          此子任务由父会话控制，可在这里查看执行过程。
        </span>
      ) : null}
      {scope.compatibilityReadOnly ? (
        <span role="status" className="text-muted-foreground">
          此历史对话仅支持查看。
        </span>
      ) : null}
      {!isDraft || project.environments.length === 1 ? (
        <span className="text-muted-foreground" aria-label="运行环境">
          {project.environments.find((entry) => entry.id === scope.environmentId)?.name}
        </span>
      ) : <Select
        value={scope.environmentId}
        disabled={!isDraft}
        onValueChange={(value) => {
          if (typeof value === 'string') change({ environmentId: value })
        }}
      >
        <SelectTrigger size="xs" variant="ghost" aria-label="运行环境">
          <SelectValue>
            {project.environments.find((entry) => entry.id === scope.environmentId)?.name}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {project.environments.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>}
      {!isDraft || project.agents.length === 1 ? (
        <span className="text-muted-foreground" aria-label="项目 Agent">
          {project.agents.find((entry) => entry.id === scope.agentId)?.name}
        </span>
      ) : <Select
        value={scope.agentId}
        disabled={!isDraft || project.agents.length === 1}
        onValueChange={(value) => {
          if (typeof value === 'string') change({ agentId: value })
        }}
      >
        <SelectTrigger size="xs" variant="ghost" aria-label="项目 Agent">
          <SelectValue>
            {project.agents.find((entry) => entry.id === scope.agentId)?.name}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {project.agents.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>}
      {!isDraft ? (
        <span className="text-muted-foreground" aria-label="会话可见范围">
          {scope.visibility === 'private' ? '仅自己' : '项目共享'}
        </span>
      ) : <Select
        value={scope.visibility}
        disabled={!isDraft}
        onValueChange={(value) => {
          if (value === 'private' || value === 'project') change({ visibility: value })
        }}
      >
        <SelectTrigger size="xs" variant="ghost" aria-label="会话可见范围">
          <SelectValue>{scope.visibility === 'private' ? '仅自己' : '项目共享'}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="private">仅自己</SelectItem>
          <SelectItem value="project">项目共享</SelectItem>
        </SelectPopup>
      </Select>}
      <WorkspaceScopeControl threadId={threadId} projectId={projectId} isDraft={isDraft} />
    </div>
  )
}
