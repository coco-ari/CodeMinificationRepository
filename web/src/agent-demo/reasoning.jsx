// OpenChamber ReasoningPart protocol adapter; actual renderer is vendored below.
import { memo, useEffect, useLayoutEffect, useState } from 'react'
import {
  ReasoningTimelineBlock,
  cleanReasoningText,
  getReasoningSummary,
} from './vendor/openchamber/reasoning/ReasoningTimelineBlock'
import { useStreamingTextThrottle } from './use-streaming-text'
import { commitStreamedText } from './vendor/openchamber/reasoning/streamTextCommit'
export { cleanReasoningText }
export const reasoningSummary = getReasoningSummary

export function useReasoningPreferences(userId) {
  const key = `autoops:agent-demo:reasoning:${userId}`
  const read = () => {
    try {
      return { show: true, expand: false, ...JSON.parse(localStorage.getItem(key) || '{}') }
    } catch {
      return { show: true, expand: false }
    }
  }
  const [state, setState] = useState(() => ({ key, value: read() }))
  const value = state.key === key ? state.value : read()
  const update = (patch) => {
    const next = { ...value, ...patch }
    setState({ key, value: next })
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      /* memory only */
    }
  }
  useEffect(() => {
    const sync = (event) => {
      if (event.key === key) setState({ key, value: read() })
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [key])
  return [value, update]
}

export const ReasoningBlock = memo(function ReasoningBlock({
  part,
  running,
  expandWhileStreaming,
}) {
  const streaming = running && part.status !== 'completed'
  const text = cleanReasoningText(part.text || '')
  const throttled = useStreamingTextThrottle({ text, isStreaming: streaming, identityKey: part.id })
  const [revealRequest, setRevealRequest] = useState(0)
  useLayoutEffect(() => {
    const reveal = (event) => {
      if (event.detail?.partId === part.id) setRevealRequest((value) => value + 1)
    }
    window.addEventListener('workbench-demo-reveal-reasoning', reveal)
    return () => window.removeEventListener('workbench-demo-reveal-reasoning', reveal)
  }, [part.id])
  return (
    <ReasoningTimelineBlock
      text={streaming ? commitStreamedText(throttled) : throttled}
      blockId={part.id}
      isStreaming={streaming}
      expandWhileStreaming={expandWhileStreaming}
      time={part.status === 'completed' ? { end: Date.parse(part.updatedAt) || 0 } : undefined}
      revealRequest={revealRequest}
    />
  )
})

export function Usage({ usage }) {
  if (!usage) return null
  const hasLast = [usage.last?.inputTokens, usage.last?.outputTokens].some(Number.isFinite)
  const last = hasLast ? usage.last : usage
  const values = [last.inputTokens, last.outputTokens]
  if (!values.some((value) => Number.isFinite(value))) return null
  const format = (value) => (Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—')
  return (
    <span
      className="workbench-demo-usage"
      title={`会话累计：${format(usage.totalTokens)} tokens${Number.isFinite(usage.modelContextWindow) ? ` / 上下文窗口 ${format(usage.modelContextWindow)}` : ''}`}
    >
      {!hasLast && '会话累计 · '}输入 {format(last.inputTokens)} · 输出 {format(last.outputTokens)}{' '}
      tokens
    </span>
  )
}
