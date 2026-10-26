import {
  OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import * as Scope from 'effect/Scope'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import { configuredAutoOpsAccess } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { configuredEnvironmentMcp } from '../../../../../../agent-demo/t3-adapters/environment-mcp-runtime.ts'
import {
  createRunResourceLifecycle,
  type RunResourceLifecycle,
} from '../../../../../../agent-demo/t3-adapters/run-resource-lifecycle.ts'
import { forkParked } from '../serverActivation.ts'
import * as EventSink from '../orchestration-v2/EventSink.ts'
import * as EventStore from '../orchestration-v2/EventStore.ts'
import * as ProjectionStore from '../orchestration-v2/ProjectionStore.ts'
import * as EffectOutbox from '../orchestration-v2/EffectOutbox.ts'
import { isTerminalRunStatus } from '../orchestration-v2/ThreadManagementService.ts'

const sourceEventLimit = 128
const encodeRun = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2Run))

/** 断线、请求停止和进程停机都不是终态；只使用已提交的原生运行投影。 */
export function nativeRunResourcesSettled(
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
) {
  const run = projection.runs.find((value) => value.id === runId)
  if (!run || !isTerminalRunStatus(run.status) || run.completedAt === null) return false
  const attempts = projection.attempts.filter((value) => value.runId === runId)
  if (run.activeAttemptId !== null && !attempts.some((value) => value.id === run.activeAttemptId))
    return false
  if (
    attempts.some(
      (value) => ['pending', 'running'].includes(value.status) || value.completedAt === null,
    )
  )
    return false
  const nodes = projection.nodes.filter((value) => value.runId === runId)
  if (nodes.some((value) => ['pending', 'running', 'waiting'].includes(value.status))) return false
  const attemptIds = new Set(attempts.map((value) => value.id)),
    nodeIds = new Set(nodes.map((value) => value.id))
  if (
    projection.providerTurns.some(
      (value) =>
        value.runAttemptId !== null &&
        attemptIds.has(value.runAttemptId) &&
        (['pending', 'running'].includes(value.status) || value.completedAt === null),
    )
  )
    return false
  if (
    projection.runtimeRequests.some(
      (value) => nodeIds.has(value.nodeId) && value.status === 'pending',
    )
  )
    return false
  return true
}

export const makeRunResourceLifecycle = Effect.fn('AutoOpsRunResourceLifecycle.make')(function* (
  resources: RunResourceLifecycle,
) {
  const events = yield* EventSink.EventSinkV2
  const store = yield* EventStore.EventStoreV2
  const projections = yield* ProjectionStore.ProjectionStoreV2
  const outbox = yield* EffectOutbox.EffectOutboxV2
  const sql = yield* SqlClient.SqlClient
  const scope = yield* Scope.Scope
  const watching = new Set<string>()
  const handle: (stored: OrchestrationV2StoredEvent) => Effect.Effect<void> = Effect.fn(
    'AutoOpsRunResourceLifecycle.handle',
  )(
    function* (stored: OrchestrationV2StoredEvent) {
      if (stored.event.type !== 'run.updated' || !isTerminalRunStatus(stored.event.payload.status))
        return
      const { threadId, payload: run } = stored.event
      // 原生写连接使用 BEGIN IMMEDIATE；核验和同步释放期间不能插入新的原生状态。
      const pending = yield* sql.withTransaction(
        Effect.gen(function* () {
          const references = yield* Effect.try(() => resources.references(threadId, run.id))
          if (!references.length) return false
          const projection = yield* projections.getThreadProjection(threadId)
          if (!nativeRunResourcesSettled(projection, run.id)) return false
          const throughSequence = yield* store.latestSequence({ threadId })
          if (throughSequence < stored.sequence) return false
          // 投影的 cancelled 也可能来自启动/停机合成记录，必须核对最新持久来源。
          // 有限读取不能证明完整来源时继续保留；后续最新事件仍可重新触发核验。
          const sourceEvents = yield* store
            .read({
              threadId,
              eventType: 'run.updated',
              afterSequence: stored.sequence - 1,
              throughSequence,
              limit: sourceEventLimit + 1,
            })
            .pipe(Stream.runCollect)
          if (sourceEvents.length > sourceEventLimit) return false
          const latest = sourceEvents
            .filter(
              (value) => value.event.type === 'run.updated' && value.event.payload.id === run.id,
            )
            .at(-1)
          const current = projection.runs.find((value) => value.id === run.id)
          if (
            !latest ||
            latest.event.type !== 'run.updated' ||
            !current ||
            latest.commandId?.startsWith('command:runtime-reconcile:') ||
            encodeRun(current) !== encodeRun(latest.event.payload)
          )
            return false
          const continuation = yield* outbox.get(`effect:restart-continuation:${run.id}`)
          if (
            Option.exists(
              continuation,
              (value) => value.status === 'pending' || value.status === 'running',
            )
          )
            return true
          for (const reference of references)
            yield* Effect.try(() => resources.releaseAfterNativeTerminal(reference))
          return false
        }),
      )
      const effectId = `effect:restart-continuation:${run.id}`
      if (pending && !watching.has(effectId)) {
        if (watching.size >= 128) {
          yield* Effect.logWarning('等待原生恢复收据的数量达到上限，保留环境输入')
          return
        }
        watching.add(effectId)
        // 等待原生已有收据通知，不轮询，也不在原生写事务内等待恢复执行。
        yield* Effect.forkIn(
          outbox.awaitSettled(effectId).pipe(
            Effect.andThen(handle(stored)),
            Effect.catchCause((cause) =>
              Effect.logWarning('原生恢复收据核验失败，保留环境输入', { cause }),
            ),
            Effect.ensuring(Effect.sync(() => watching.delete(effectId))),
          ),
          scope,
        )
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning('原生运行资源终态核验失败，保留环境输入', { cause }),
    ),
  )
  return {
    handle,
    // 持久事件按类型回放并衔接 live；重启不会根据内存状态或超时推断完成。
    run: Stream.runForEach(events.stream({ afterSequence: 0, eventType: 'run.updated' }), handle),
  }
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const access = configuredAutoOpsAccess()
    if (!access) return
    const service = yield* makeRunResourceLifecycle(
      createRunResourceLifecycle(access, configuredEnvironmentMcp(access)),
    )
    yield* forkParked(
      service.run.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning('原生资源终态事件读取中断，保留尚未释放的环境输入', { cause }),
        ),
      ),
    )
  }),
)
