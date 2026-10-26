import { useSyncExternalStore } from 'react'
import { subscribeAutoOpsHost, readAutoOpsHost } from './hostSnapshot'
import { readKnownAutoOpsThreadScope, subscribeAutoOpsThreadScopes } from './hostConfig'
export function useAutoOpsThreadScope(threadId: string) {
  useSyncExternalStore(subscribeAutoOpsHost, readAutoOpsHost, () => undefined)
  return useSyncExternalStore(
    subscribeAutoOpsThreadScopes,
    () => readKnownAutoOpsThreadScope(threadId),
    () => undefined,
  )
}
