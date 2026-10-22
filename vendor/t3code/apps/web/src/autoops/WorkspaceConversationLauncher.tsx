import { useEffect, useRef } from 'react'
import { scopeProjectRef } from '@t3tools/client-runtime/environment'
import { readProjects } from '~/state/entities'
import { useNewThreadHandler } from '~/hooks/useHandleNewThread'
import { toastManager } from '~/components/ui/toast'
import { readAutoOpsHost, readAutoOpsThreadScope, setAutoOpsThreadScope } from './hostConfig'
import { loadWorkspaces } from './workspaces'

export function WorkspaceConversationLauncher() {
  const createThread = useNewThreadHandler()
  const pending = useRef(false)
  useEffect(() => {
    const launch = (event:Event) => {
      const detail = (event as CustomEvent<{projectId:string;workspaceType:string;workspaceVersionId:string}>).detail
      if (!detail || pending.current || typeof detail.projectId !== 'string' || typeof detail.workspaceVersionId !== 'string') return
      const project = readProjects().find((entry) => entry.id === detail.projectId)
      if (!readAutoOpsHost() || !project) return
      pending.current = true
      void (async () => {
        const overview = await loadWorkspaces(detail.projectId)
        const version = [...overview.internalVersions, ...overview.externalVersions].find((entry) => entry.id === detail.workspaceVersionId && entry.type === detail.workspaceType && entry.status === 'published')
        if (!version) throw new Error('此工作区版本尚不可用于对话。')
        // Upstream creates a clean composer; only model preferences are carried.
        const created = await createThread(scopeProjectRef(project.environmentId, project.id), {envMode:'local', forceNew:true})
        if (!created) return
        const initial = readAutoOpsThreadScope(created.threadId, project.id)
        if (initial) setAutoOpsThreadScope(created.threadId, {...initial, workspaceType:version.type, workspaceVersionId:version.id})
      })().catch((error:unknown) => toastManager.add({type:'error', title:'无法新建工作区对话', description:error instanceof Error ? error.message : '请重试。'})).finally(() => { pending.current = false })
    }
    window.addEventListener('autoops:new-workspace-thread', launch)
    return () => window.removeEventListener('autoops:new-workspace-thread', launch)
  }, [createThread])
  return null
}
