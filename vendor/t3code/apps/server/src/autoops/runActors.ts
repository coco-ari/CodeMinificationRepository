import type { CommandId, RunId, MessageId, ThreadId } from '@t3tools/contracts'
import * as Stream from 'effect/Stream'
import type { EventStoreV2Shape } from '../orchestration-v2/EventStore.ts'
import type { AutoOpsAccess } from '../../../../../../agent-demo/t3-adapters/access.mjs'

/** 只采用 T3 已提交的编辑事件；拒绝或响应丢失的候选请求不能改写执行身份。 */
export function queuedRunActorCommand(
  access: AutoOpsAccess,
  read: EventStoreV2Shape['read'],
  threadId: ThreadId,
  runId: RunId,
  messageId: MessageId,
) {
  return read({ threadId, eventType: 'message.updated' }).pipe(
    Stream.runFold(
      () => undefined as CommandId | undefined,
      (latest, stored) => {
        if (
          stored.event.type !== 'message.updated' ||
          stored.event.runId !== runId ||
          stored.event.payload.id !== messageId ||
          stored.commandId === null
        )
          return latest
        return access.getQueuedEditActor(threadId, stored.commandId, runId)
          ? stored.commandId
          : latest
      },
    ),
  )
}
