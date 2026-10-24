import { useEffect, useRef, useState } from 'react'

/** 只自动读取已有操作结果；重连和回到页面时继续查询，不自动新增写入。 */
export function useWorkspaceRequestRecovery(
  requestId: string | undefined,
  busy: boolean,
  check: () => Promise<unknown>,
) {
  const latest = useRef({ busy, check })
  const [pausedFor, setPausedFor] = useState<string>()
  useEffect(() => {
    latest.current = { busy, check }
  }, [busy, check])
  useEffect(() => {
    if (!requestId) return
    let stopped = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer)
      if (stopped) return
      if (attempts < 3) timer = setTimeout(() => void recover(), 1500)
      else setPausedFor(requestId)
    }
    const recover = async () => {
      if (stopped) return
      if (latest.current.busy) {
        schedule()
        return
      }
      attempts++
      await latest.current.check()
      schedule()
    }
    const resume = () => {
      if (document.visibilityState === 'hidden') return
      attempts = 0
      setPausedFor(undefined)
      schedule()
    }
    schedule()
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      stopped = true
      clearTimeout(timer)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [requestId])
  return pausedFor === requestId && requestId !== undefined
}
