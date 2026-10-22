// OpenChamber, MIT License. Copyright (c) 2025 Bohdan Triapitsyn.
// Source: openchamber/openchamber@6491f51dbcf05d1e3f7f823049f5f097c96c234b
// packages/ui/src/components/chat/lib/turns/activityRows.ts
// packages/ui/src/components/chat/message/partUtils.ts
// packages/ui/src/lib/invisibleText.ts
// Type annotations and the unused React context removed; algorithms unchanged.
// Full license: public/third-party/agent-demo-streaming-NOTICES.txt.

export const LIVE_ACTIVITY_VISIBLE_ROWS = 7
const INVISIBLE_ONLY_RE = /^[\s\p{Default_Ignorable_Code_Point}]*$/u
export const isInvisibleText = (text) => INVISIBLE_ONLY_RE.test(text)

const isToolRunning = (status) =>
  status === 'pending' || status === 'running' || status === 'started'

export const isToolRowShown = (toolPart) => {
  const { state } = toolPart
  if (isToolRunning(state.status)) return true
  if (state.status !== 'completed' && state.status !== 'error') return false
  return state.time.end >= state.time.start
}

export const isActivityRowPart = (part) => {
  if (part.type === 'tool') return isToolRowShown(part)
  if (part.type === 'text') return !isInvisibleText(part.text)
  return part.type === 'reasoning'
}

export const activityRowParts = (parts, showReasoning) =>
  parts
    .filter((part) => part && typeof part === 'object' && typeof part.type === 'string')
    .filter((part) => showReasoning || part.type !== 'reasoning')
    .filter(isActivityRowPart)

const NO_TRIM = { hiddenMessages: 0, skipRows: 0, hiddenRows: 0 }

export const planActivityTrim = (rowsPerMessage, visibleRows) => {
  let kept = 0
  for (let index = rowsPerMessage.length - 1; index >= 0; index -= 1) {
    const rows = rowsPerMessage[index] ?? 0
    if (kept + rows <= visibleRows) {
      kept += rows
      continue
    }
    let hiddenRows = 0
    for (let earlier = 0; earlier <= index; earlier += 1) hiddenRows += rowsPerMessage[earlier] ?? 0
    const skipRows = rows - (visibleRows - kept)
    if (skipRows >= rows) return { hiddenMessages: index + 1, skipRows: 0, hiddenRows }
    return { hiddenMessages: index, skipRows, hiddenRows: hiddenRows - (rows - skipRows) }
  }
  return NO_TRIM
}
