import { expect, it } from 'vite-plus/test'
import * as C from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as EventSink from '../orchestration-v2/EventSink.ts'
import * as EventStore from '../orchestration-v2/EventStore.ts'
import * as ProjectionStore from '../orchestration-v2/ProjectionStore.ts'
import * as EffectOutbox from '../orchestration-v2/EffectOutbox.ts'
import * as Sqlite from '../persistence/Sqlite.ts'
import { makeRunResourceLifecycle, nativeRunResourcesSettled } from './runResourceLifecycle.ts'
import { createRunResourceLifecycle } from '../../../../../../agent-demo/t3-adapters/run-resource-lifecycle.ts'

const now = DateTime.makeUnsafe('2026-10-26T00:00:00Z')
const threadId = C.ThreadId.make('resource-thread'),
  runId = C.RunId.make('resource-run')
function projection(status: C.OrchestrationV2Run['status'] = 'completed') {
  const thread = {
    id: threadId,
    createdBy: 'user',
    creationSource: 'web',
    projectId: 'project',
    title: '资料生命周期',
    providerInstanceId: 'codex',
    modelSelection: { instanceId: 'codex', model: 'model' },
    runtimeMode: 'approval-required',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  }
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: 'codex',
    modelSelection: { instanceId: 'codex', model: 'model' },
    providerThreadId: null,
    userMessageId: 'message',
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: now,
    completedAt: status === 'running' ? null : now,
    checkpointId: null,
    contextHandoffId: null,
  }
  return Schema.decodeUnknownSync(C.OrchestrationV2ThreadProjection)({
    ...Object.fromEntries(
      Object.keys(C.OrchestrationV2ThreadProjection.fields).map((key) => [key, []]),
    ),
    thread,
    runs: [run],
    updatedAt: now,
  })
}
const reference = {
  threadId,
  runId,
  projectId: 'project',
  environmentId: 'test',
  inputId: 'input',
  actorId: 'actual-caller',
  inputOwnerId: 'original-owner',
  actorVerified: true,
  createdAt: 'now',
}
const update = (
  status: C.OrchestrationV2Run['status'] = 'completed',
): C.OrchestrationV2StoredEvent => ({
  sequence: 1,
  commandId: null,
  event: {
    id: C.EventId.make('terminal'),
    type: 'run.updated',
    threadId,
    occurredAt: now,
    payload: projection(status).runs[0]!,
  },
})
const nativeStorage = Layer.mergeAll(
  ProjectionStore.layer,
  EventStore.layer,
  EffectOutbox.layer,
).pipe(Layer.provideMerge(Sqlite.layerMemory))
const nativeLayer = Layer.mergeAll(
  nativeStorage,
  EventSink.layer.pipe(Layer.provide(nativeStorage)),
)

it('原生持久终态才释放，运行、缺完成时间、未知attempt或活动节点继续保护', () => {
  expect(nativeRunResourcesSettled(projection(), runId)).toBe(true)
  expect(nativeRunResourcesSettled(projection('running'), runId)).toBe(false)
  const base = projection()
  const noTime = { ...base, runs: [{ ...base.runs[0]!, completedAt: null }] }
  expect(nativeRunResourcesSettled(noTime, runId)).toBe(false)
  const missingAttempt = {
    ...base,
    runs: [{ ...base.runs[0]!, activeAttemptId: C.RunAttemptId.make('missing') }],
  }
  expect(nativeRunResourcesSettled(missingAttempt, runId)).toBe(false)
  const active = {
    ...base,
    nodes: [
      { id: C.NodeId.make('active'), runId, status: 'running' } as C.OrchestrationV2ExecutionNode,
    ],
  }
  expect(nativeRunResourcesSettled(active, runId)).toBe(false)
})

it('实际SQLite提交的终态事件可在重启回放释放，实际调用者和原环境不受当前授权撤回影响', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2
        const released = yield* Deferred.make<void>()
        const values: unknown[] = []
        const resources = createRunResourceLifecycle(
          { runResourceReferences: () => [reference], nativeSubagentRunReferenced: () => false },
          {
            releaseRun: (scope) => {
              values.push(scope)
              Effect.runSync(Deferred.succeed(released, undefined))
              return {} as never
            },
          },
        )
        const state = projection('running')
        yield* sink.write({
          events: [
            {
              id: C.EventId.make('thread-created'),
              type: 'thread.created',
              threadId,
              occurredAt: now,
              payload: state.thread,
            },
            {
              id: C.EventId.make('run-created'),
              type: 'run.created',
              threadId,
              occurredAt: now,
              payload: state.runs[0]!,
            },
            update().event,
          ],
        })
        // 事件先提交，再构建消费者；此处验证持久回放，非只验证内存通知。
        const service = yield* makeRunResourceLifecycle(resources)
        const fiber = yield* Effect.forkChild(service.run)
        yield* Deferred.await(released)
        yield* Fiber.interrupt(fiber)
        expect(values).toEqual([
          {
            threadId,
            runId,
            actorId: 'actual-caller',
            projectId: 'project',
            environmentId: 'test',
          },
        ])
        expect(reference.inputOwnerId).toBe('original-owner')
      }).pipe(Effect.provide(nativeLayer)),
    ),
  )
})

it.each([
  ['startup', false],
  ['shutdown', false],
  ['startup', true],
  ['shutdown', true],
] as const)(
  '实际原生 %s 合成取消不释放，历史终态回放=%s 且无continuation仍保留',
  async (trigger, historical) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2
          const values: unknown[] = []
          const resources = createRunResourceLifecycle(
            { runResourceReferences: () => [reference], nativeSubagentRunReferenced: () => false },
            {
              releaseRun: (scope) => {
                values.push(scope)
                return {} as never
              },
            },
          )
          const state = projection('running')
          yield* sink.write({
            events: [
              {
                id: C.EventId.make('thread-created'),
                type: 'thread.created',
                threadId,
                occurredAt: now,
                payload: state.thread,
              },
              {
                id: C.EventId.make('run-created'),
                type: 'run.created',
                threadId,
                occurredAt: now,
                payload: state.runs[0]!,
              },
            ],
          })
          let original: C.OrchestrationV2StoredEvent | undefined
          if (historical) {
            const previous = yield* sink.write({
              commandId: C.CommandId.make('command:actual-cancel'),
              events: [{ ...update('cancelled').event, id: C.EventId.make('actual-cancelled') }],
            })
            original = previous[0]
            yield* sink.write({
              events: [{ ...update('running').event, id: C.EventId.make('run-resumed') }],
            })
          }
          const latest = yield* sink.write({
            commandId: C.CommandId.make(
              `command:runtime-reconcile:${trigger}:${threadId}:frozen-time`,
            ),
            events: [{ ...update('cancelled').event, id: C.EventId.make('synthetic-cancelled') }],
          })
          // 冻结时钟及全部相同字段：比较当前payload不能识别取消来源。
          if (original) expect(original.event.payload).toEqual(latest[0]!.event.payload)
          const service = yield* makeRunResourceLifecycle(resources)
          yield* service.handle(original ?? latest[0]!)
          expect(values).toEqual([])
        }).pipe(Effect.provide(nativeLayer)),
      ),
    )
  },
)

it('读取原生状态或continuation失败均保留；pending continuation与迟到旧终态不释放', async () => {
  for (const scenario of [
    'running',
    'pending',
    'read-failed',
    'outbox-failed',
    'source-failed',
    'source-unknown',
    'source-overflow',
  ] as const) {
    const released: unknown[] = []
    const resources = createRunResourceLifecycle(
      { runResourceReferences: () => [reference], nativeSubagentRunReferenced: () => false },
      {
        releaseRun: (scope) => {
          released.push(scope)
          return {} as never
        },
      },
    )
    const mocks = Layer.mergeAll(
      Layer.mock(EventSink.EventSinkV2)({ stream: () => Stream.empty }),
      Layer.mock(EventStore.EventStoreV2)({
        latestSequence: () => Effect.succeed(1),
        read: () =>
          scenario === 'source-failed'
            ? Stream.fail(new EventStore.EventStoreReadEventsError({ threadId }))
            : scenario === 'source-unknown'
              ? Stream.empty
              : Stream.fromIterable(
                  Array.from({ length: scenario === 'source-overflow' ? 129 : 1 }, () => update()),
                ),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadProjection: () =>
          scenario === 'read-failed'
            ? Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }))
            : Effect.succeed(projection(scenario === 'running' ? 'running' : 'completed')),
      }),
      Layer.mock(EffectOutbox.EffectOutboxV2)({
        awaitSettled: () => Effect.never,
        get: () =>
          scenario === 'outbox-failed'
            ? Effect.fail(new EffectOutbox.EffectOutboxError({ operation: 'get' }))
            : Effect.succeed(
                scenario === 'pending'
                  ? Option.some({ status: 'pending' } as EffectOutbox.OrchestrationEffectV2)
                  : Option.none(),
              ),
      }),
    )
    const result = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* makeRunResourceLifecycle(resources)
            yield* service.handle(update())
          }).pipe(Effect.provide(Layer.mergeAll(mocks, Sqlite.layerMemory))),
        ),
      ),
    )
    expect(Exit.isSuccess(result)).toBe(true)
    expect(released).toEqual([])
  }
})

it('原生恢复收据最终结束后通过已有通知重新核验，不依赖下一轮或轮询释放', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>(),
          settled = yield* Deferred.make<void>(),
          released = yield* Deferred.make<void>()
        let pending = true
        const resources = createRunResourceLifecycle(
          { runResourceReferences: () => [reference], nativeSubagentRunReferenced: () => false },
          {
            releaseRun: () => {
              Effect.runSync(Deferred.succeed(released, undefined))
              return {} as never
            },
          },
        )
        const mocks = Layer.mergeAll(
          Layer.mock(EventSink.EventSinkV2)({ stream: () => Stream.empty }),
          Layer.mock(EventStore.EventStoreV2)({
            latestSequence: () => Effect.succeed(1),
            read: () => Stream.make(update()),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadProjection: () => Effect.succeed(projection()),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            get: () =>
              Effect.succeed(
                pending
                  ? Option.some({ status: 'pending' } as EffectOutbox.OrchestrationEffectV2)
                  : Option.none(),
              ),
            awaitSettled: () =>
              Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(settled))),
          }),
        )
        yield* Effect.gen(function* () {
          const service = yield* makeRunResourceLifecycle(resources)
          yield* service.handle(update())
          yield* Deferred.await(waiting)
          pending = false
          yield* Deferred.succeed(settled, undefined)
          yield* Deferred.await(released)
        }).pipe(Effect.provide(Layer.mergeAll(mocks, Sqlite.layerMemory)))
      }),
    ),
  )
})
