// AutoOps adapter: retain the server's event order and stable text-part identities.
// Historical conversations without timeline data keep their original representation.
export function conversationRows(conversation, cache) {
  const turns = new Map(conversation.turns.map((turn) => [turn.id, turn]))
  const messages = new Map(conversation.messages.map((message) => [message.id, message]))
  const embedded = new Set(
    conversation.turns.flatMap((turn) =>
      (turn.timeline || [])
        .filter((entry) => entry.type === 'user')
        .map((entry) => entry.messageId),
    ),
  )
  return conversation.messages.flatMap((message) => {
    if (embedded.has(message.id)) return []
    const turn = turns.get(message.turnId)
    if (message.role !== 'assistant' || !Array.isArray(turn?.timeline)) return [message]
    const previous = cache?.get(message.id)
    if (previous?.message === message && previous?.turn === turn) return previous.rows
    const rows = []
    let segment = {
      ...message,
      sourceMessageId: message.id,
      parts: [],
      content: '',
      finalSegment: false,
    }
    for (const entry of turn.timeline) {
      if (entry.type === 'user') {
        if (segment.parts.length) rows.push(segment)
        const user = messages.get(entry.messageId)
        if (user) rows.push(user)
        segment = {
          ...message,
          sourceMessageId: message.id,
          id: `${message.id}:after:${entry.id}`,
          parts: [],
          content: '',
          createdAt: entry.createdAt,
          finalSegment: false,
        }
      } else {
        segment.parts.push(entry)
        if (entry.type === 'text')
          segment.content += `${segment.content ? '\n\n' : ''}${entry.text}`
      }
    }
    // Keep the first empty assistant row stable while awaiting the first event.
    // After a user interruption, the activity footer owns the waiting feedback.
    if (segment.parts.length || !rows.length) rows.push(segment)
    const lastAssistant = rows.findLast((row) => row.role === 'assistant')
    if (lastAssistant) lastAssistant.finalSegment = true
    cache?.set(message.id, { message, turn, rows })
    return rows
  })
}

export function applyTimelineDelta(turns, event) {
  const { timelineEntry, timelineDelta, lastActivityAt, phase, usage } = event.payload
  if (!timelineEntry && !timelineDelta && event.type !== 'turn.usage.updated') return turns
  const target = turns.find((turn) => turn.id === event.turnId)
  if (!target) return null
  let entry = timelineEntry
  if (timelineDelta) {
    const previous = target.timeline?.find((part) => part.id === timelineDelta.id)
    // A lost patch is repaired from the authoritative snapshot. Never concatenate
    // text at an unknown offset (SSE may reconnect between any two patches).
    if (
      timelineDelta.mode !== 'replace' &&
      Number(timelineDelta.offset) !== (previous?.text || '').length
    )
      return null
    const { delta, offset, mode, ...metadata } = timelineDelta
    entry = {
      ...previous,
      ...metadata,
      text: mode === 'replace' ? delta : (previous?.text || '') + delta,
    }
  }
  return turns.map((turn) => {
    if (turn.id !== event.turnId) return turn
    if (event.type === 'turn.usage.updated') return { ...turn, usage }
    const timeline = turn.timeline || []
    const index = timeline.findIndex((part) => part.id === entry.id)
    return {
      ...turn,
      phase: phase || turn.phase,
      lastActivityAt: lastActivityAt || event.at,
      timeline:
        index < 0 ? [...timeline, entry] : timeline.map((part, i) => (i === index ? entry : part)),
    }
  })
}
