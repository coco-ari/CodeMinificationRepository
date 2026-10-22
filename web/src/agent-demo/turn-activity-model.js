// AutoOps protocol adapter for OpenChamber's activityRows/liveActivity projection.
// UI policy lives in the attributed vendor modules; this file only maps stored
// tool steps, final-answer phases, and AutoOps' separate question records.
import {
  LIVE_ACTIVITY_VISIBLE_ROWS,
  activityRowParts,
  isInvisibleText,
  planActivityTrim,
} from './vendor/openchamber/activity-rows.js'

const timestamp = (value) => (typeof value === 'number' ? value : Date.parse(value))
const phaseOf = (part) => part.messagePhase ?? part.phase

export function finalAnswerPart(parts, turn, finalSegment = true) {
  if (!finalSegment) return undefined
  if (parts.some((part) => part.type === 'question' && part.question?.status === 'pending'))
    return undefined
  const explicitIndex = parts.findLastIndex(
    (part) =>
      part.type === 'text' &&
      phaseOf(part) === 'final_answer' &&
      !isInvisibleText(part.text || '') &&
      (part.status === 'completed' || turn?.status === 'completed'),
  )
  if (explicitIndex >= 0) {
    // getLiveFinalMessage reads the LAST conversation record. A previously
    // completed answer followed by another tool, user interruption, or text
    // cannot retire newer work. Reasoning belonging to that final message and
    // transport-only notices do not constitute a later conversation record.
    const hasLaterWork = parts
      .slice(explicitIndex + 1)
      .some(
        (part) =>
          part.type === 'tool' ||
          part.type === 'question' ||
          part.type === 'user' ||
          (part.type === 'text' && !isInvisibleText(part.text || '')),
      )
    if (!hasLaterWork) return parts[explicitIndex]
    return undefined
  }
  // Old persisted turns predate the transport's phase field. Only an entirely
  // completed turn can use this compatibility path; an interrupted commentary
  // must never become a fabricated final answer.
  if (turn?.status !== 'completed' || parts.some((part) => phaseOf(part))) return undefined
  const last = parts.at(-1)
  return last?.type === 'text' && !isInvisibleText(last.text || '') ? last : undefined
}

export function adaptActivityPart(part, stepsById) {
  if (part.type !== 'tool' || part.state) return part
  const step = stepsById.get(part.stepId)
  const started = timestamp(step?.startedAt ?? part.createdAt)
  const completed = timestamp(step?.completedAt)
  return {
    ...part,
    state: {
      status: step?.status === 'failed' ? 'error' : step?.status || 'pending',
      time: {
        // Older persisted Demo steps have no timing. Equal zero timestamps
        // preserve their completed result without inventing a duration.
        start: Number.isFinite(started) ? started : 0,
        end: Number.isFinite(completed) ? completed : Number.isFinite(started) ? started : 0,
      },
    },
  }
}

export function projectTurnActivity({
  parts = [],
  turn,
  finalSegment = true,
  showReasoning = true,
  expanded = false,
  hasLaterAssistant = false,
}) {
  const stepsById = new Map((turn?.steps || []).map((step) => [step.id, step]))
  const adapted = parts.map((part) => adaptActivityPart(part, stepsById))
  const finalPart = finalAnswerPart(adapted, turn, finalSegment)
  const turnFinalPart = finalAnswerPart(turn?.timeline || parts, turn)
  const settled = Boolean(finalPart || turnFinalPart) || hasLaterAssistant
  const activityParts = finalPart ? adapted.filter((part) => part.id !== finalPart.id) : adapted
  const rows = activityRowParts(activityParts, showReasoning)
  const rowIds = new Set(rows.map((part) => part.id))
  const visible = activityParts.filter((part) => rowIds.has(part.id) || part.type === 'question')
  const hasActivity = rows.some((part) => part.type === 'tool' || part.type === 'reasoning')
  const trim = expanded ? null : planActivityTrim([rows.length], LIVE_ACTIVITY_VISIBLE_ROWS)
  let remaining = trim?.skipRows ?? 0
  let firstShown = 0
  for (; firstShown < visible.length && remaining > 0; firstShown += 1) {
    const part = visible[firstShown]
    // OpenCode places unanswered forms outside the trimmed transcript. AutoOps
    // persists forms inline, so retain this form in situ and never trim past it.
    if (part.type === 'question' && part.question?.status === 'pending') break
    if (rowIds.has(part.id)) remaining -= 1
  }
  const hiddenRows = visible.slice(0, firstShown).filter((part) => rowIds.has(part.id)).length
  return {
    hasActivity,
    settled,
    finalPart,
    activityParts: visible,
    shownParts: visible.slice(firstShown),
    hiddenRows,
  }
}
