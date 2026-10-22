import { useSyncExternalStore } from 'react'
import { readKnownAutoOpsThreadScope, subscribeAutoOpsThreadScopes } from './hostConfig'
export function useAutoOpsThreadScope(threadId: string) {
  return useSyncExternalStore(
    subscribeAutoOpsThreadScopes,
    () => readKnownAutoOpsThreadScope(threadId),
    () => undefined,
  )
}
