import { useEffect, useState } from 'react'
import { readAutoOpsHost, readAutoOpsThreadScope, type AutoOpsThreadScope } from './hostConfig'

import { loadSkillContext, type SkillContext } from './skillLibrary'

/** 客户端执行目标不读取平台技能目录，即使草稿仍携带切换前的平台范围。 */
export function autoOpsSkillContextRequestKey(
  gatewayBasePath: string | undefined,
  threadId: string | null,
  selection: AutoOpsThreadScope | undefined,
) {
  if (
    !gatewayBasePath ||
    !selection ||
    !threadId ||
    selection.executionBinding?.kind === 'customer'
  )
    return null
  const query = new URLSearchParams()
  if (selection.scopeLocked || selection.scopeState === 'locked') query.set('threadId', threadId)
  else {
    query.set('projectId', selection.projectId)
    query.set('agentId', selection.agentId)
    query.set('environmentId', selection.environmentId)
    if (selection.workspaceType) query.set('workspaceType', selection.workspaceType)
    if (selection.workspaceVersionId) query.set('workspaceVersionId', selection.workspaceVersionId)
  }
  return `${gatewayBasePath}/autoops/skill-library/context?${query}`
}

/** 在调用 T3 原生技能扫描器前确认服务器授权范围。 */
export function useAutoOpsSkillContext(
  threadId: string | null,
  projectId: string | undefined,
  scope: AutoOpsThreadScope | undefined,
) {
  const host = readAutoOpsHost()
  const selection =
    scope ?? (threadId && projectId ? readAutoOpsThreadScope(threadId, projectId) : undefined)
  const requestKey = autoOpsSkillContextRequestKey(host?.gatewayBasePath, threadId, selection)
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{
    key: string
    revision: number
    context: SkillContext | null
    error: string | null
  } | null>(null)
  useEffect(() => {
    const changed = () => setRevision((value) => value + 1)
    window.addEventListener('autoops:skill-library-changed', changed)
    window.addEventListener('focus', changed)
    return () => {
      window.removeEventListener('autoops:skill-library-changed', changed)
      window.removeEventListener('focus', changed)
    }
  }, [])
  useEffect(() => {
    if (!requestKey) return
    const controller = new AbortController()
    void loadSkillContext(requestKey, controller.signal)
      .then((context) => {
        if (!controller.signal.aborted)
          setResult({ key: requestKey, revision, context, error: null })
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setResult({
            key: requestKey,
            revision,
            context: null,
            error: cause instanceof Error ? cause.message : '无法读取当前技能范围',
          })
      })
    return () => controller.abort()
  }, [requestKey, revision])
  // 新范围读取完成前不复用上一范围的技能目录。
  return result?.key === requestKey && result.revision === revision ? result : null
}
