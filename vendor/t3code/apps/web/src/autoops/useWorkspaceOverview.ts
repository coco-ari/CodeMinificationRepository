import { useCallback, useEffect, useRef, useState } from 'react'
import { isAutoOpsAccessError } from './apiClient'
import { loadWorkspaces, type WorkspaceOverview } from './workspaces'

const hasActiveTasks = (overview: WorkspaceOverview | null) =>
  overview?.tasks.some((task) => task.status === 'queued' || task.status === 'running') ?? false

/** 工作区和源码包共享读取生命周期，页面离开只取消读取，不取消已提交的业务任务。 */
export function useWorkspaceOverview(projectId: string) {
  const snapshot = useRef<{ projectId: string; overview: WorkspaceOverview | null }>({ projectId, overview: null })
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{
    projectId: string
    overview: WorkspaceOverview | null
    error: string | null
  }>({ projectId, overview: null, error: null })
  const refreshOverview = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let latest = snapshot.current.projectId === projectId ? snapshot.current.overview : null
    const read = async () => {
      try {
        const next = await loadWorkspaces(projectId, controller.signal)
        if (controller.signal.aborted) return
        latest = next
        snapshot.current = { projectId, overview: next }
        setState({ projectId, overview: next, error: null })
        if (hasActiveTasks(next)) timer = setTimeout(() => void read(), 1200)
      } catch (cause) {
        if (controller.signal.aborted) return
        if (isAutoOpsAccessError(cause)) {
          latest = null
          snapshot.current = { projectId, overview: null }
        }
        setState((current) => ({
          projectId,
          overview: isAutoOpsAccessError(cause) || current.projectId !== projectId ? null : current.overview,
          error: cause instanceof Error ? cause.message : '读取工作区失败，请重试。',
        }))
        if (hasActiveTasks(latest)) timer = setTimeout(() => void read(), 5000)
      }
    }
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [projectId, revision])
  return {
    overview: state.projectId === projectId ? state.overview : null,
    loadError: state.projectId === projectId ? state.error : null,
    refreshOverview,
  }
}
