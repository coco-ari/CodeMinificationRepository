// Adapted from OpenChamber, MIT License.
// Copyright (c) 2025 Bohdan Triapitsyn.
// Source: openchamber/openchamber@6491f51dbcf05d1e3f7f823049f5f097c96c234b
// packages/ui/src/components/chat/lib/turns/windowTurns.ts
// Keeps turn start indexes and message-to-turn lookup; AutoOps already supplies
// canonical turnId, so an in-turn steer/answer must not open another turn.
// Older-head reveal and reader anchoring follow Hermes _loadOlderMessages in
// static/sessions.js@3aa21f63387939dcff37baa141ad59a0e1e1147f (MIT).
// Copyright (c) 2025 Hermes Web UI Contributors.
// Full licenses: /third-party/agent-demo-streaming-NOTICES.txt
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { dispatchRowExpand } from './vendor/openchamber/timeline-scroll-intent'

export const HISTORY_TURN_WINDOW = 30

export function buildHistoryWindowModel(rows) {
  const turnIds = []
  const turnMessageStartIndexes = []
  const turnIndexById = new Map()
  const messageToTurnIndex = new Map()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const turnId = row.turnId ? `turn:${row.turnId}` : `row:${row.id}`
    if (!turnIndexById.has(turnId)) {
      turnIndexById.set(turnId, turnIds.length)
      turnIds.push(turnId)
      turnMessageStartIndexes.push(index)
    }
    const turnIndex = turnIndexById.get(turnId)
    messageToTurnIndex.set(row.id, turnIndex)
    if (row.sourceMessageId) messageToTurnIndex.set(row.sourceMessageId, turnIndex)
  }
  return { turnIds, turnMessageStartIndexes, turnIndexById, messageToTurnIndex }
}

function readAnchor(scroller) {
  if (!scroller) return null
  const viewport = scroller.getBoundingClientRect()
  const nodes = [...scroller.querySelectorAll('[data-message-id]')]
  const node = nodes.find((item) => item.getBoundingClientRect().bottom > viewport.top)
  return {
    id: node?.dataset.messageId,
    top: node ? node.getBoundingClientRect().top - viewport.top : null,
    scrollTop: scroller.scrollTop,
  }
}

/**
 * A growing suffix of whole turns, not a moving last-N slice. Once exposed,
 * history stays mounted until the conversation changes. The server still owns
 * and sends the full snapshot; this only bounds the initial rendered history.
 * revealRow resolves after React commits the requested row, so search can wait
 * before opening a nested reasoning block and scrolling to the match.
 */
export function useHistoryWindow({ rows, conversationId, scrollerRef }) {
  const model = useMemo(() => buildHistoryWindowModel(rows), [rows])
  const defaultStart = Math.max(0, model.turnIds.length - HISTORY_TURN_WINDOW)
  const [window, setWindow] = useState(() => ({
    conversationId,
    startTurnId: model.turnIds[defaultStart] ?? null,
  }))
  const storedStart =
    window.conversationId === conversationId
      ? model.turnIndexById.get(window.startTurnId)
      : undefined
  // A shorter authoritative replacement may remove turns after the anchor.
  // Still expose at least a full initial window (or all remaining turns).
  const start = Math.min(storedStart ?? defaultStart, defaultStart)
  const startRow = model.turnMessageStartIndexes[start] ?? 0
  const visibleRows = useMemo(() => rows.slice(startRow), [rows, startRow])
  const state = useRef(null)
  state.current = { conversationId, model, start, committedStart: start }
  const anchor = useRef(null)
  const reveals = useRef([])

  useLayoutEffect(() => {
    const startTurnId = model.turnIds[start] ?? null
    if (window.conversationId !== conversationId || window.startTurnId !== startTurnId)
      setWindow({ conversationId, startTurnId })

    const held = anchor.current
    anchor.current = null
    if (held?.conversationId === conversationId) {
      const node = scrollerRef.current
      const oldRow =
        node &&
        [...node.querySelectorAll('[data-message-id]')].find(
          (item) => item.dataset.messageId === held.id,
        )
      if (oldRow && held.top !== null)
        node.scrollTop +=
          oldRow.getBoundingClientRect().top - node.getBoundingClientRect().top - held.top
      else if (node) node.scrollTop = held.scrollTop
    }
    const pending = reveals.current
    reveals.current = []
    for (const request of pending) {
      const turn = model.messageToTurnIndex.get(request.id)
      request.resolve(
        request.conversationId === conversationId && turn !== undefined && turn >= start,
      )
    }
  })
  useLayoutEffect(
    () => () => {
      for (const request of reveals.current) request.resolve(false)
      reveals.current = []
      anchor.current = null
    },
    [],
  )

  const expose = useCallback(
    (target) => {
      const current = state.current
      const next = Math.max(0, Math.min(current.start, target))
      if (next === current.start) return false
      const node = scrollerRef.current
      // This is the same reader-intent signal used when opening a tool row.
      // Release the automatic end follower before prepending DOM above the reader.
      dispatchRowExpand(node)
      const captured = readAnchor(node)
      if (captured) anchor.current = { ...captured, conversationId: current.conversationId }
      // Update the ref too: repeated actions in one React batch can only expand.
      state.current = { ...current, start: next }
      setWindow({
        conversationId: current.conversationId,
        startTurnId: current.model.turnIds[next],
      })
      return true
    },
    [scrollerRef],
  )

  const loadEarlier = useCallback(() => {
    expose(state.current.start - HISTORY_TURN_WINDOW)
  }, [expose])
  const revealRow = useCallback(
    (id) => {
      const current = state.current
      const target = current.model.messageToTurnIndex.get(id)
      if (target === undefined) return Promise.resolve(false)
      if (target >= current.committedStart) return Promise.resolve(true)
      const result = new Promise((resolve) =>
        reveals.current.push({
          id,
          conversationId: current.conversationId,
          resolve,
        }),
      )
      expose(target)
      return result
    },
    [expose],
  )

  return {
    visibleRows,
    hasEarlier: start > 0,
    hiddenTurnCount: start,
    totalTurnCount: model.turnIds.length,
    loadEarlier,
    revealRow,
  }
}
