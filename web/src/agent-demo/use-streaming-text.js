// Adapted from OpenChamber (MIT), commit 6491f51dbcf05d1e3f7f823049f5f097c96c234b.
// See /third-party/agent-demo-streaming-NOTICES.txt for the original path and license.
import { useLayoutEffect, useRef, useState } from 'react'

// Coalesce updates to a small render window; never invent a typing animation.
// The first text and the terminal flush are immediate, including Chinese text.
export function useStreamingTextThrottle({ text, isStreaming, identityKey, throttleMs = 32 }) {
  const [visible, setVisible] = useState({ text, identityKey })
  const pending = useRef({ timer: null, lastEmitAt: 0, text, identityKey })

  useLayoutEffect(() => {
    const state = pending.current
    clearTimeout(state.timer)
    state.timer = null
    state.text = text
    const changedIdentity = state.identityKey !== identityKey
    state.identityKey = identityKey
    const flush = () => {
      state.timer = null
      state.lastEmitAt = performance.now()
      setVisible({ text: state.text, identityKey: state.identityKey })
    }
    // Unlike the upstream default, a corrected/replaced text is allowed: the
    // incremental parser explicitly resets on non-append updates.
    const delay = Math.max(0, throttleMs - (performance.now() - state.lastEmitAt))
    if (!isStreaming || changedIdentity || !visible.text || delay === 0) flush()
    else state.timer = setTimeout(flush, delay)
    return () => clearTimeout(state.timer)
  }, [text, isStreaming, identityKey, throttleMs])

  // Completion and identity changes do not wait for an effect/timer commit.
  return !isStreaming || visible.identityKey !== identityKey ? text : visible.text
}
