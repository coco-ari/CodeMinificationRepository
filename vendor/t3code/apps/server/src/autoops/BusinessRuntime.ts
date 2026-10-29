import {
  DeletedThreadDataHooks,
  DeletedDataCleanupError,
} from '../orchestration-v2/DeletedDataCleanup.ts'
import { configuredAutoOpsAccess } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { configuredWorkspaceManagement } from '../../../../../../agent-demo/t3-adapters/workspace-management.ts'
import { configuredBusinessArtifactStore } from '../../../../../../agent-demo/t3-adapters/business-tools.mjs'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import {
  createBusinessRuntime,
  type BusinessRuntime as BusinessRuntimePort,
} from '../../../../../../agent-demo/t3-adapters/business-runtime.mjs'

export class BusinessRuntime extends Context.Service<BusinessRuntime, BusinessRuntimePort>()(
  't3/autoops/BusinessRuntime',
) {}

const runtimeLayer = Layer.effect(
  BusinessRuntime,
  Effect.gen(function* () {
    const runtime = createBusinessRuntime()
    // 先登记清理，保证初始化到一半失败也释放已打开的业务资源。
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.close()))
    yield* Effect.promise(() => runtime.initialize())
    return runtime
  }),
)

// 此层装配在业务消费者之上；停止接单与本地落盘先于消费者和身份资源的释放。
export const stopping = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* BusinessRuntime
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.drain()))
  }),
)

// 在现有原生持久删除队列中清理业务归属；重启后仍由同一任务继续。
export const layer = Layer.merge(
  runtimeLayer,
  Layer.succeed(DeletedThreadDataHooks, {
    cleanup: (threadId: string) =>
      Effect.try(() => {
        const access = configuredAutoOpsAccess(),
          binding = access?.getThreadBinding(threadId)
        if (!access || !binding) return
        configuredWorkspaceManagement(access).authoring.purgeInputs(
          binding.projectId,
          access.ownedInputIdsForDeletion(threadId),
        )
        configuredBusinessArtifactStore()?.purgeScope(binding.projectId, [threadId])
        access.purgeThread(threadId)
      }).pipe(
        Effect.mapError(
          (cause) => new DeletedDataCleanupError({ message: '会话业务数据清理失败', cause }),
        ),
      ),
  }),
)
