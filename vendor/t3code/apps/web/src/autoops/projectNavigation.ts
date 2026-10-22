import { useSyncExternalStore } from 'react'
import { useLocation } from '@tanstack/react-router'
import { scopeThreadRef } from '@t3tools/client-runtime/environment'
import type { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { type DraftId, useComposerDraftStore } from '../composerDraftStore'
import { readThreadShell, useQuietThreadShell, useThreadProjection } from '../state/entities'
import { environmentThreadDetails } from '../state/threads'
import { appAtomRegistry } from '../rpc/atomRegistry'
import { useThreadRouteTarget } from '../hooks/useThreadRouteTarget'
import { readAutoOpsHost } from './hostConfig'
import {
  createAutoOpsProjectNavigation, normalizeAutoOpsChatHref, resolveAutoOpsNativeThreadProjectId,
} from './projectNavigation.logic'

export {
  autoOpsAreaFromPath,
  normalizeAutoOpsChatHref,
  resolveAutoOpsRouteProjectId,
  type AutoOpsArea,
  type RouteProjectSelection,
} from './projectNavigation.logic'

function readRouteSearch() {
  if (typeof window === 'undefined') return undefined
  return window.location.hash.startsWith('#/')
    ? window.location.hash.slice(1)
    : window.location.href
}

function nativeChatProjectId(href: string, purpose: 'context' | 'recent' = 'context'): string | null {
  const normalized = normalizeAutoOpsChatHref(href)
  if (!normalized) return null
  const [, first, second] = normalized.split('/').map(decodeURIComponent)
  if (first === 'draft') return useComposerDraftStore.getState().getDraftSession(second as DraftId)?.projectId ?? ''
  const ref = scopeThreadRef(first as EnvironmentId, second as ThreadId)
  const shell = readThreadShell(ref)
  const detail = shell === null
    ? appAtomRegistry.get(environmentThreadDetails.threadAtom(ref))?.projection.thread
    : null
  return resolveAutoOpsNativeThreadProjectId(shell, detail, purpose)
}

/** Read an existing native identity for safe settings-return navigation. */
export function readAutoOpsChatProjectId(href: string): string | null {
  const projectId = nativeChatProjectId(href)
  if (projectId === null) return null
  return readAutoOpsHost()?.projects.some((project) => project.id === projectId) ? projectId : ''
}

const navigation = createAutoOpsProjectNavigation({
  readHost: readAutoOpsHost,
  readStorage: () => typeof window === 'undefined' ? undefined : window.sessionStorage,
  readRouteSearch,
  readNativeProjectId: () => {
    if (typeof window === 'undefined') return null
    const href = window.location.hash.startsWith('#/')
      ? window.location.hash.slice(1)
      : `${window.location.pathname}${window.location.search}`
    return nativeChatProjectId(href)
  },
  ownsChatHref(projectId, href) {
    const hostProject = readAutoOpsHost()?.projects.find((project) => project.id === projectId)
    if (!hostProject) return false
    return nativeChatProjectId(href, 'recent') === projectId
  },
})

export const readAutoOpsProjectId = navigation.readProjectId
export const selectAutoOpsProject = navigation.selectProject
export const rememberAutoOpsChatLocation = navigation.rememberChatLocation
export const autoOpsProjectHref = navigation.projectHref

/** Router state, not location-only events, also covers same-document native navigation. */
export function useAutoOpsProjectId(): string {
  const search = useLocation({ select: (location) => location.search })
  const target = useThreadRouteTarget()
  const threadRef = target?.kind === 'server' ? target.threadRef : null
  const thread = useQuietThreadShell(threadRef)
  const detail = useThreadProjection(thread === null ? threadRef : null)
  const draft = useComposerDraftStore((state) =>
    target?.kind === 'draft' ? state.getDraftSession(target.draftId) : null,
  )
  const nativeProjectId = target
    ? target.kind === 'server'
      ? resolveAutoOpsNativeThreadProjectId(thread, detail?.projection.thread)
      : draft?.projectId ?? ''
    : null
  return useSyncExternalStore(
    navigation.subscribe,
    () => navigation.readProjectId(search, nativeProjectId),
    () => '',
  )
}
