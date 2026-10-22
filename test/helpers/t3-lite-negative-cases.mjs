import { randomUUID } from 'node:crypto'

// Shared with the local native-contract decoder test. All IDs are syntactically
// valid; product policy must reject before consulting the absent target records.
export function liteNegativeCases(threadId, checkpoint, snapshotAt = new Date().toISOString()) {
  const dispatch = (type, extra = {}) => ['orchestration.dispatchCommand', { type, threadId, commandId: randomUUID(), ...extra }]
  return [
    dispatch('thread.interaction-mode.set', { interactionMode: 'plan' }),
    dispatch('thread.settle'),
    dispatch('thread.auto-settle', { snapshotAt }),
    dispatch('thread.auto-settle.set', { enabled: true }),
    dispatch('thread.snooze', { snoozedUntil: new Date(Date.now() + 60000).toISOString() }),
    ['orchestration.dispatchCommand', { type: 'thread.fork', commandId: randomUUID(), sourceThreadId: threadId, targetThreadId: randomUUID(), sourcePoint: { type: 'latest_stable' }, createdBy: 'user', creationSource: 'web' }],
    dispatch('checkpoint.rollback', { scopeId: checkpoint?.scopeId || 'lite-no-scope', checkpointId: checkpoint?.id || 'lite-no-checkpoint', restoreFiles: false }),
    dispatch('message.dispatch', { messageId: randomUUID(), text: 'Disabled plan execution probe', attachments: [], createdBy: 'user', creationSource: 'web', dispatchMode: { type: 'start_immediately' }, sourcePlanRef: { threadId, planId: 'lite-no-plan' } }),
    ['server.upsertKeybinding', { key: 'ctrl+alt+k', command: 'chat.new' }],
    ['server.getUsageSummary', { sinceDay: '2026-10-01', untilDay: '2026-10-22', timeZone: 'Asia/Shanghai' }],
    ['mcpApps.callTool', { threadId, itemId: 'lite-no-item', name: 'html_render', arguments: {} }],
    ['server.updateSettings', { patch: { autoResumeLimitedThreads: true } }],
  ]
}
