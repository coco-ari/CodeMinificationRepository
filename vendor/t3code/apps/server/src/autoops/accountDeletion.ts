import { configuredWorkspaceManagement } from '../../../../../../agent-demo/t3-adapters/workspace-management.ts'
import { CommandId, ThreadId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as ThreadManagement from '../orchestration-v2/ThreadManagementService.ts'
import { purgeDeletedData } from '../orchestration-v2/DeletedDataCleanup.ts'
import {
  configuredAutoOpsProjectDirectory,
  configuredAutoOpsAssistantDirectory,
  type AutoOpsAccess,
} from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { configuredBusinessArtifactStore } from '../../../../../../agent-demo/t3-adapters/business-tools.mjs'

export const purgeAccountRelations = Effect.fn('AutoOps.purgeAccountRelations')(function* (
  access: AutoOpsAccess,
  user: string,
) {
  const owned = access.ownerThreads(user)
  if (owned.length) {
    const threads = yield* ThreadManagement.ThreadManagementService
    const snapshot = yield* threads.getShellSnapshot()
    const active = new Set(
      [...snapshot.threads, ...snapshot.archivedThreads].map((thread) => String(thread.id)),
    )
    for (const thread of owned)
      if (active.has(thread.nativeId))
        yield* threads.dispatch({
          type: 'thread.delete',
          threadId: ThreadId.make(thread.nativeId),
          commandId: CommandId.make(`autoops:account:delete:${user}:${thread.nativeId}`),
        })
    yield* purgeDeletedData({ threadIds: owned.map((thread) => thread.nativeId) })
  }
  yield* Effect.try(() => {
    configuredAutoOpsAssistantDirectory().purgeUser(user)
    configuredAutoOpsProjectDirectory().purgeUser(user)
    configuredBusinessArtifactStore()?.purgeUser(user)
    configuredWorkspaceManagement(access).authoring.purgeUser(user)
    access.purgeUser(user)
  })
})
