// Copied/adapted from OpenChamber message/parts/WorkingPlaceholder.tsx,
// hooks/useAssistantStatus.ts and components/ScrollToBottomButton.tsx.
// Commit 6491f51dbcf05d1e3f7f823049f5f097c96c234b (MIT).
// Copyright (c) 2025 Bohdan Triapitsyn. License: /third-party/agent-demo-streaming-NOTICES.txt
// The 1200ms status queue, generic-churn filtering, retry countdown and cleanup
// are upstream code. Store/provider-logo access is omitted; the caller owns
// placement. The adapter below consumes real turn events, never silence timers.
import React from 'react'
import { toolPresentation } from './tool-parts'

// The Chinese source translation uses "{model} · {status}". The back-to-latest
// pill uses this same unanimated label, as in ScrollToBottomButton.tsx.
export function workStatusLabel({ statusText, modelName } = {}) {
  if (!statusText) return ''
  const trimmed = modelName?.trim() ?? ''
  return trimmed
    ? `${trimmed} · ${statusText}`
    : statusText.charAt(0).toUpperCase() + statusText.slice(1)
}

export function deriveWorkStatus(turn) {
  // Matches useAssistantStatus's pending-form and aborted/settled suppression.
  if (
    !turn ||
    turn.status !== 'running' ||
    turn.phase === 'stopping' ||
    turn.question?.status === 'pending'
  ) {
    return { active: false, statusText: null, isGenericStatus: true }
  }
  if (turn.phase === 'thinking')
    return { active: true, statusText: '正在思考', isGenericStatus: false }
  if (turn.phase === 'context_compacting')
    return { active: true, statusText: '正在整理上下文', isGenericStatus: false }
  if (turn.phase === 'responding')
    return { active: true, statusText: '正在组织回答', isGenericStatus: false }
  const running = (Array.isArray(turn.steps) ? turn.steps : []).filter(
    (step) => step && ['running', 'pending', 'started'].includes(step.status),
  )
  const last = running.at(-1)
  if (last) {
    const { kind, name } = toolPresentation(last, turn)
    const count = running.filter((step) => toolPresentation(step, turn).kind === kind).length
    // Upstream counts concurrent calls of the same class; it does not infer
    // file counts from the amount of data returned by a search.
    const statusText =
      kind === 'read'
        ? count > 1
          ? `正在读取 ${count} 个文件`
          : '正在读取文件'
        : kind === 'search'
          ? '正在搜索资料'
          : `正在调用 ${name}`
    return { active: true, statusText, isGenericStatus: false }
  }
  // A neutral translation of upstream's generic "working" fallback. No
  // lifecycle claim is synthesized from elapsed time or missing text deltas.
  return { active: true, statusText: '正在处理', isGenericStatus: true }
}

const STATUS_DISPLAY_TIME_MS = 1200

const EPOCH_SECONDS_THRESHOLD = 1_000_000_000
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000

const toRetryTargetTimestamp = (next) => {
  if (next >= EPOCH_MILLISECONDS_THRESHOLD) {
    return next
  }
  if (next >= EPOCH_SECONDS_THRESHOLD) {
    return next * 1000
  }
  return Date.now() + next
}

const formatRetryCountdown = (seconds) => {
  if (seconds < 60) {
    return `${seconds}s`
  }

  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    const remainderSeconds = seconds % 60
    return remainderSeconds > 0 ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`
  }

  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600)
    const remainderMinutes = Math.floor((seconds % 3600) / 60)
    return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`
  }

  const days = Math.floor(seconds / 86400)
  const remainderHours = Math.floor((seconds % 86400) / 3600)
  if (remainderHours > 0) {
    return `${days}d ${remainderHours}h`
  }

  return `${days}d`
}

/** "at 3:20 PM" today, "Oct 20, 3:20 PM" on another day, in the user's locale. */
const formatResetTime = (at) => {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (date.toDateString() === new Date().toDateString()) return `at ${time}`
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

export function WorkStatus({
  active,
  isWorking = active,
  statusText,
  isGenericStatus,
  isWaitingForPermission,
  retryInfo,
  modelName,
}) {
  const [displayedText, setDisplayedText] = React.useState(null)
  const [displayedPermission, setDisplayedPermission] = React.useState(false)
  const displayedTextRef = React.useRef(displayedText)
  const displayedPermissionRef = React.useRef(displayedPermission)
  displayedTextRef.current = displayedText
  displayedPermissionRef.current = displayedPermission

  const statusShownAtRef = React.useRef(0)
  const queuedStatusRef = React.useRef(null)
  const processQueueTimerRef = React.useRef(null)

  // Countdown state for retry mode
  const [retryCountdown, setRetryCountdown] = React.useState(null)

  React.useEffect(() => {
    const rawNext = retryInfo?.next
    if (!rawNext || rawNext <= 0) {
      setRetryCountdown(null)
      return
    }

    const retryTargetAt = toRetryTargetTimestamp(rawNext)

    const update = () => {
      const remaining = Math.max(0, retryTargetAt - Date.now())
      setRetryCountdown(Math.ceil(remaining / 1000))
    }

    update()
    const id = setInterval(update, 500)
    return () => clearInterval(id)
  }, [retryInfo?.next, retryInfo?.attempt])

  const clearTimers = React.useCallback(() => {
    if (processQueueTimerRef.current) {
      clearTimeout(processQueueTimerRef.current)
      processQueueTimerRef.current = null
    }
  }, [])

  const showStatus = React.useCallback(
    (text, permission) => {
      clearTimers()
      queuedStatusRef.current = null
      setDisplayedText(text)
      setDisplayedPermission(permission)
      statusShownAtRef.current = Date.now()
    },
    [clearTimers],
  )

  const scheduleQueueProcess = React.useCallback(() => {
    if (processQueueTimerRef.current) return
    const elapsed = Date.now() - statusShownAtRef.current
    const remaining = Math.max(0, STATUS_DISPLAY_TIME_MS - elapsed)
    processQueueTimerRef.current = setTimeout(() => {
      processQueueTimerRef.current = null

      const queued = queuedStatusRef.current
      if (queued) {
        showStatus(queued.text, queued.permission)
      }
    }, remaining)
  }, [showStatus])

  React.useEffect(() => {
    if (!isWorking) {
      clearTimers()
      queuedStatusRef.current = null
      setDisplayedText(null)
      setDisplayedPermission(false)
      return
    }

    // Retry state has its own display — skip the normal queue
    if (retryInfo) {
      clearTimers()
      queuedStatusRef.current = null
      return
    }

    const incomingText = isWaitingForPermission ? 'waiting for permission' : statusText
    const incomingPermission = Boolean(isWaitingForPermission)
    const incomingGeneric = Boolean(isGenericStatus) && !incomingPermission

    if (!incomingText) {
      return
    }

    if (!displayedTextRef.current) {
      showStatus(incomingText, incomingPermission)
      return
    }

    if (
      incomingText === displayedTextRef.current &&
      incomingPermission === displayedPermissionRef.current
    ) {
      return
    }

    // Ignore generic churn.
    if (incomingGeneric) {
      return
    }

    const elapsed = Date.now() - statusShownAtRef.current
    if (elapsed >= STATUS_DISPLAY_TIME_MS) {
      showStatus(incomingText, incomingPermission)
      return
    }

    queuedStatusRef.current = { text: incomingText, permission: incomingPermission }
    scheduleQueueProcess()
  }, [
    isWorking,
    statusText,
    isGenericStatus,
    isWaitingForPermission,
    retryInfo,
    clearTimers,
    showStatus,
    scheduleQueueProcess,
  ])

  React.useEffect(() => () => clearTimers(), [clearTimers])

  if (!isWorking) {
    return null
  }

  // Retry state: show countdown and attempt info
  if (retryInfo) {
    const attemptLabel =
      retryInfo.attempt && retryInfo.attempt > 1 ? ` (attempt ${retryInfo.attempt})` : ''
    const countdownLabel =
      retryCountdown !== null && retryCountdown > 0
        ? ` in ${formatRetryCountdown(retryCountdown)}`
        : ''
    // A rate limit that lifts after the next retry: say when, since the
    // retry itself will most likely hit the limit again.
    const resetsAt = retryInfo.resetsAt
    const retryTargetAt = retryInfo.next ? toRetryTargetTimestamp(retryInfo.next) : Date.now()
    const retryText =
      resetsAt !== undefined && resetsAt > retryTargetAt
        ? `Limit resets ${formatResetTime(resetsAt)} · retry${countdownLabel}${attemptLabel}`
        : `Retrying${countdownLabel}${attemptLabel}`

    return (
      <div
        className="flex h-full items-center text-muted-foreground"
        role="status"
        aria-live="polite"
        aria-label={retryText}
      >
        <span className="typography-ui-header">{retryText}</span>
      </div>
    )
  }

  if (!displayedText) {
    return null
  }

  const label = workStatusLabel({ statusText: displayedText, modelName })

  return (
    <div
      // Full muted-foreground, matching the scroll-to-bottom pill's status
      // text: the row and the pill hand off to each other in the same spot
      // and must read as one element changing chrome.
      className={'flex h-full items-center text-muted-foreground'}
      role="status"
      aria-live={displayedPermission ? 'assertive' : 'polite'}
      aria-label={label}
      data-waiting={displayedPermission ? 'true' : undefined}
    >
      <span className="text-[13px] leading-4">{label}</span>
    </div>
  )
}
