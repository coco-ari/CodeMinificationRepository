import { useEffect, useRef, useState } from 'react'
import { isAutoOpsAccessError } from './apiClient'
import {
  changeSkillLibrary,
  loadSkillLibrary,
  type SkillLibrary,
  type SkillLibraryAction,
} from './skillLibrary'

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。'

/** skill目录的数据生命周期；选中项、对话框、焦点和导航仍由页面负责。 */
export function useSkillLibraryCatalog(projectId?: string) {
  const [catalog, setCatalog] = useState<SkillLibrary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accessDenied, setAccessDenied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const mutationLock = useRef(false)
  const requestGeneration = useRef(0)
  const refreshPending = useRef(true)
  const activeRead = useRef<AbortController | null>(null)

  const rejectAccess = (cause: unknown) => {
    setCatalog(null)
    setAccessDenied(true)
    setError(errorMessage(cause))
  }

  useEffect(() => {
    const controller = new AbortController()
    activeRead.current = controller
    const generation = ++requestGeneration.current
    refreshPending.current = true
    setLoading(true)
    void loadSkillLibrary(controller.signal, projectId)
      .then((next) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return
        setCatalog(next)
        setAccessDenied(false)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return
        if (isAutoOpsAccessError(cause)) rejectAccess(cause)
        else setError(errorMessage(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === requestGeneration.current) {
          refreshPending.current = false
          setLoading(false)
        }
      })
    return () => {
      controller.abort()
      // 已接受的写入继续执行，但旧页面不能覆盖后来页面的状态或导航。
      ++requestGeneration.current
    }
  }, [refresh, projectId])

  const isUpdating = () => mutationLock.current || refreshPending.current
  const refreshLibrary = () => {
    if (isUpdating()) return
    refreshPending.current = true
    setLoading(true)
    setRefresh((value) => value + 1)
  }

  useEffect(() => {
    const changed = () => {
      // 当前页直接接收自己的写入结果；旧页面完成的写入会使当前目录重新读取。
      if (mutationLock.current) return
      refreshPending.current = true
      setLoading(true)
      setRefresh((value) => value + 1)
    }
    window.addEventListener('autoops:skill-library-changed', changed)
    return () => window.removeEventListener('autoops:skill-library-changed', changed)
  }, [])

  const mutate = async (
    action: SkillLibraryAction,
  ): Promise<{ previous: SkillLibrary; next: SkillLibrary } | null> => {
    if (!catalog || isUpdating()) return null
    const previous = catalog
    mutationLock.current = true
    const generation = ++requestGeneration.current
    setBusy(true)
    setError(null)
    try {
      const next = await changeSkillLibrary(previous.revision, action, projectId)
      window.dispatchEvent(new Event('autoops:skill-library-changed'))
      if (generation !== requestGeneration.current) return null
      setCatalog(next)
      setAccessDenied(false)
      return { previous, next }
    } catch (cause) {
      if (generation !== requestGeneration.current) return null
      setError(errorMessage(cause))
      if (isAutoOpsAccessError(cause)) {
        rejectAccess(cause)
        return null
      }
      // 写入失败只核对目录，不自动重发；离开页面时同时取消这次核对读取。
      try {
        const next = await loadSkillLibrary(activeRead.current?.signal, projectId)
        if (generation === requestGeneration.current) setCatalog(next)
      } catch (refreshCause) {
        if (generation === requestGeneration.current && isAutoOpsAccessError(refreshCause))
          rejectAccess(refreshCause)
      }
      return null
    } finally {
      mutationLock.current = false
      if (generation === requestGeneration.current) setBusy(false)
    }
  }

  return {
    catalog,
    error,
    accessDenied,
    busy,
    loading,
    refreshLibrary,
    isUpdating,
    mutate,
    clearError: () => setError(null),
  }
}
