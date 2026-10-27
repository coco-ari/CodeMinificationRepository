import { useEffect, useRef } from 'react'
import { scopeProjectRef } from '@t3tools/client-runtime/environment'
import { readProjects } from '~/state/entities'
import { useNewThreadHandler } from '~/hooks/useHandleNewThread'
import { toastManager } from '~/components/ui/toast'
import { readAutoOpsHost, readAutoOpsThreadScope, setAutoOpsThreadScope } from './hostConfig'
import { availableWorkspaceScopes } from './scopeSelection'

export function WorkspaceConversationLauncher() {
  const createThread = useNewThreadHandler()
  const pending = useRef(false)
  useEffect(() => {
    const launch = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; workspaceType: string }>).detail
      if (
        !detail ||
        pending.current ||
        typeof detail.projectId !== 'string' ||
        (detail.workspaceType !== 'internal' && detail.workspaceType !== 'external')
      )
        return
      if (!readAutoOpsHost()) return
      const project = readProjects().find((entry) => entry.id === detail.projectId)
      if (!project) {
        toastManager.add({
          type: 'error',
          title: '无法新建工作区对话',
          description: '对话服务尚未就绪，请稍后重试。',
        })
        return
      }
      pending.current = true
      void (async () => {
        if (
          !availableWorkspaceScopes(detail.projectId).some(
            (entry) => entry.value === detail.workspaceType,
          )
        )
          throw new Error('当前项目没有此工作区读取权限。')
        // 复用原生新草稿，只携带模型偏好；业务输入由每次运行独立捕获。
        const created = await createThread(scopeProjectRef(project.environmentId, project.id), {
          envMode: 'local',
          forceNew: true,
        })
        if (!created) return
        const initial = readAutoOpsThreadScope(created.threadId, project.id)
        if (initial)
          setAutoOpsThreadScope(created.threadId, {
            ...initial,
            workspaceType: detail.workspaceType as 'internal' | 'external',
            workspaceVersionId: undefined,
          })
      })()
        .catch((error: unknown) =>
          toastManager.add({
            type: 'error',
            title: '无法新建工作区对话',
            description: error instanceof Error ? error.message : '请重试。',
          }),
        )
        .finally(() => {
          pending.current = false
        })
    }
    window.addEventListener('autoops:new-workspace-thread', launch)
    return () => window.removeEventListener('autoops:new-workspace-thread', launch)
  }, [createThread])
  return null
}
