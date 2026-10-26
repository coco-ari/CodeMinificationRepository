// @effect-diagnostics nodeBuiltinImport:off -- 隔离测试使用真实业务 SQLite 引用和原生事件所属模块。
import { expect, it } from 'vite-plus/test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as C from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import * as Option from 'effect/Option'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as EventSink from '../orchestration-v2/EventSink.ts'
import * as EventStore from '../orchestration-v2/EventStore.ts'
import * as ProjectionStore from '../orchestration-v2/ProjectionStore.ts'
import * as Receipts from '../orchestration-v2/CommandReceiptStore.ts'
import * as EffectOutbox from '../orchestration-v2/EffectOutbox.ts'
import * as Sqlite from '../persistence/Sqlite.ts'
import { makeWorkspaceInputLifecycle } from './workspaceInputLifecycle.ts'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { users, projects, agents } from '../../../../../../agent-demo/fixtures.mjs'
import { createRunResourceLifecycle } from '../../../../../../agent-demo/t3-adapters/run-resource-lifecycle.ts'
import { createNativeSubagentBindings } from '../../../../../../agent-demo/t3-adapters/subagents.mjs'

const now = DateTime.makeUnsafe('2026-10-26T00:00:00Z')
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'autoops-input-native-'))
  const sessionDb = new DatabaseSync(':memory:'),
    bindingDb = new DatabaseSync(join(directory, 't3-autoops.sqlite'))
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  sessionDb
    .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
    .run(
      createHash('sha256').update('admin').digest('hex'),
      'u-admin',
      'csrf',
      Number.MAX_SAFE_INTEGER,
    )
  const catalog = structuredClone({ users, projects, agents }),
    access = createAutoOpsAccess({
      sessionDb,
      bindingDb,
      catalog,
      workspaceStore: {
        getVersion() {
          return { id: 'legacy-version', type: 'internal', status: 'published' }
        },
      } as never,
    }),
    admin = access.authenticateCookie('demo_session=admin')
  for (const threadId of ['source', 'target'])
    access.bindThread(admin, {
      threadId,
      projectId: 'p-autoops',
      environmentId: 'env-test',
      agentId: 'a-project',
      visibility: 'project',
      workspaceType: 'internal',
    })
  access.bindRunInput('source', 'first', 'fixed-input', 'u-lin')
  const children = createNativeSubagentBindings(directory, access)
  return {
    access,
    admin,
    catalog,
    children,
    close() {
      children.close()
      bindingDb.close()
      sessionDb.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
function projection(
  threadId: string,
  runId: string,
  status: C.OrchestrationV2Run['status'] = 'completed',
) {
  return Schema.decodeUnknownSync(C.OrchestrationV2ThreadProjection)({
    ...Object.fromEntries(
      Object.keys(C.OrchestrationV2ThreadProjection.fields).map((key) => [key, []]),
    ),
    thread: {
      id: threadId,
      createdBy: 'user',
      creationSource: 'web',
      projectId: 'project',
      title: '资料回收',
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
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: 'codex',
        modelSelection: { instanceId: 'codex', model: 'model' },
        providerThreadId: null,
        userMessageId: 'message-' + runId,
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: ['queued', 'running'].includes(status) ? null : now,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    updatedAt: now,
  })
}
const storage = Layer.mergeAll(
  ProjectionStore.layer,
  EventStore.layer,
  EffectOutbox.layer,
  Receipts.layer,
).pipe(Layer.provideMerge(Sqlite.layerMemory))
const native = Layer.mergeAll(storage, EventSink.layer.pipe(Layer.provide(storage)))
let serial = 0
const create = (
  threadId: string,
  runId: string,
  status: C.OrchestrationV2Run['status'] = 'completed',
) => {
  const state = projection(threadId, runId, status)
  return [
    {
      id: C.EventId.make('thread-' + ++serial),
      type: 'thread.created',
      threadId: C.ThreadId.make(threadId),
      occurredAt: now,
      payload: state.thread,
    },
    {
      id: C.EventId.make('create-' + ++serial),
      type: 'run.created',
      threadId: C.ThreadId.make(threadId),
      occurredAt: now,
      payload: state.runs[0]!,
    },
    {
      id: C.EventId.make('update-' + ++serial),
      type: 'run.updated',
      threadId: C.ThreadId.make(threadId),
      occurredAt: now,
      payload: state.runs[0]!,
    },
  ] as const
}
const update = (
  threadId: string,
  runId: string,
  status: C.OrchestrationV2Run['status'] = 'completed',
) => ({
  id: C.EventId.make('update-' + ++serial),
  type: 'run.updated' as const,
  threadId: C.ThreadId.make(threadId),
  occurredAt: now,
  payload: projection(threadId, runId, status).runs[0]!,
})
const identity = { projectId: 'p-autoops', inputId: 'fixed-input', inputOwnerId: 'u-lin' }

it('命令拒绝没有原生事件也通过真实提交收据通知回收，未知命令等待期间继续保护', async () => {
  const f = fixture()
  let count = 0
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2,
            released = yield* Deferred.make<void>()
          yield* sink.write({ events: create('source', 'first') })
          f.access.retainInputReference('target', 'fixed-input', 'u-lin', 'u-admin', {
            kind: 'context',
            commandId: 'rejected-without-event',
            messageId: 'absent-message',
          })
          const service = yield* makeWorkspaceInputLifecycle(f.access, {
            collectUnusedCurrentVersionsForMaintenance() {
              return { removed: [], pending: [] }
            },
            subscribeInputPreparationSettled() {
              return () => {}
            },
            inputPreparationForNativeMaintenance() {
              return null
            },
            releaseInputAfterNativeTerminal() {
              count++
              Effect.runSync(Deferred.succeed(released, undefined))
              return true
            },
          })
          yield* service.handleIdentity(identity)
          expect(count).toBe(0)
          yield* sink.commitRejectedCommand({
            commandId: C.CommandId.make('rejected-without-event'),
            threadId: C.ThreadId.make('target'),
            commandType: 'message.send',
            rejectedAt: now,
            error: '命令被拒绝',
          })
          expect(
            Option.isSome(yield* Deferred.await(released).pipe(Effect.timeoutOption('250 millis'))),
          ).toBe(true)
          expect(count).toBe(1)
        }).pipe(Effect.provide(native)),
      ),
    )
  } finally {
    f.close()
  }
})

it('同一输入全部真实运行结束后自动归还，排队和另一会话继续保护；撤权不更换原身份', async () => {
  const f = fixture()
  const released: unknown[] = []
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2
          f.access.bindRunInput('target', 'second', 'fixed-input', 'u-admin', 'u-lin')
          const original = yield* sink.write({ events: create('source', 'first') })
          yield* sink.write({ events: create('target', 'second', 'queued') })
          const service = yield* makeWorkspaceInputLifecycle(f.access, {
            collectUnusedCurrentVersionsForMaintenance() {
              return { removed: [], pending: [] }
            },
            subscribeInputPreparationSettled() {
              return () => {}
            },
            inputPreparationForNativeMaintenance() {
              return null
            },
            releaseInputAfterNativeTerminal(value) {
              released.push(value)
              return true
            },
          })
          yield* service.handle(original.at(-1)!)
          expect(released).toEqual([])
          f.catalog.users.find(
            (value: { id: string; status?: string }) => value.id === 'u-lin',
          )!.status = 'disabled'
          const terminal = yield* sink.write({ events: [update('target', 'second')] })
          yield* service.handle(terminal[0]!)
          expect(released).toEqual([identity])
        }).pipe(Effect.provide(native)),
      ),
    )
  } finally {
    f.close()
  }
})

it('命令未判定及迟到历史取消不能释放；最新合成停机保持保护', async () => {
  const f = fixture()
  const released: unknown[] = []
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2
          const original = yield* sink.write({ events: create('source', 'first', 'cancelled') })
          yield* sink.write({ events: [update('source', 'first', 'running')] })
          yield* sink.write({
            commandId: C.CommandId.make('command:runtime-reconcile:shutdown:source'),
            events: [update('source', 'first', 'cancelled')],
          })
          const service = yield* makeWorkspaceInputLifecycle(f.access, {
            collectUnusedCurrentVersionsForMaintenance() {
              return { removed: [], pending: [] }
            },
            subscribeInputPreparationSettled() {
              return () => {}
            },
            inputPreparationForNativeMaintenance() {
              return null
            },
            releaseInputAfterNativeTerminal(value) {
              released.push(value)
              return true
            },
          })
          yield* service.handle(original.at(-1)!)
          expect(released).toEqual([])
          yield* sink.write({ events: [update('source', 'first')] })
          f.access.retainInputReference('target', 'fixed-input', 'u-lin', 'u-admin', {
            kind: 'context',
            commandId: 'unknown',
            messageId: 'message-second',
          })
          yield* service.handleIdentity(identity)
          expect(released).toEqual([])
          yield* (yield* Receipts.CommandReceiptStoreV2).insertIfAbsent({
            commandId: C.CommandId.make('unknown'),
            threadId: C.ThreadId.make('target'),
            commandType: 'message.send',
            acceptedAt: now,
            resultSequence: 1,
            status: 'rejected',
            error: '拒绝',
          })
          yield* service.handleIdentity(identity)
          expect(released).toEqual([identity])
        }).pipe(Effect.provide(native)),
      ),
    )
  } finally {
    f.close()
  }
})

it('真实分叉命令未接受保留输入，接受后新排队仍保留，全部终态才归还', async () => {
  const f = fixture()
  const released: unknown[] = []
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2,
            receipts = yield* Receipts.CommandReceiptStoreV2
          yield* sink.write({ events: create('source', 'first') })
          f.access.forkBinding(f.admin, 'source', 'fork', 'fork-command')
          yield* sink.write({ events: create('fork', 'fork-run', 'queued') })
          const service = yield* makeWorkspaceInputLifecycle(f.access, {
            collectUnusedCurrentVersionsForMaintenance() {
              return { removed: [], pending: [] }
            },
            subscribeInputPreparationSettled() {
              return () => {}
            },
            inputPreparationForNativeMaintenance() {
              return null
            },
            releaseInputAfterNativeTerminal(value) {
              released.push(value)
              return true
            },
          })
          yield* service.handleIdentity(identity)
          expect(released).toEqual([])
          yield* receipts.insertIfAbsent({
            commandId: C.CommandId.make('fork-command'),
            threadId: C.ThreadId.make('fork'),
            commandType: 'thread.fork',
            acceptedAt: now,
            resultSequence: 1,
            status: 'accepted',
            error: null,
          })
          yield* service.handleIdentity(identity)
          expect(released).toEqual([])
          const ended = yield* sink.write({ events: [update('fork', 'fork-run')] })
          yield* service.handle(ended[0]!)
          expect(released).toEqual([identity])
        }).pipe(Effect.provide(native)),
      ),
    )
  } finally {
    f.close()
  }
})

it('真实原生子绑定共用原输入；父终态、子idle或合成取消不归还，子真实终态后归还', async () => {
  const f = fixture(),
    released: unknown[] = [],
    environments: unknown[] = []
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2
          f.children.register('source', 'child', 'native-child', 'first')
          const parent = yield* sink.write({ events: create('source', 'first') })
          const childProjection = projection('child', 'unused')
          yield* sink.write({
            events: [
              {
                id: C.EventId.make('child-created'),
                type: 'thread.created',
                threadId: C.ThreadId.make('child'),
                occurredAt: now,
                payload: childProjection.thread,
              },
            ],
          })
          const subagent = (status: C.OrchestrationV2Subagent['status']) =>
            Schema.decodeUnknownSync(C.OrchestrationV2Subagent)({
              id: 'child-task',
              threadId: 'source',
              runId: 'first',
              parentNodeId: 'parent-node',
              origin: 'provider_native',
              createdBy: 'agent',
              driver: 'codex',
              providerInstanceId: 'codex',
              providerThreadId: null,
              childThreadId: 'child',
              nativeTaskRef: null,
              prompt: '读取原件',
              title: null,
              model: null,
              status,
              result: null,
              startedAt: now,
              completedAt: status === 'idle' || status === 'running' ? null : now,
              updatedAt: now,
            })
          const changed = (status: C.OrchestrationV2Subagent['status']) => ({
            id: C.EventId.make('child-status-' + ++serial),
            type: 'subagent.updated' as const,
            threadId: C.ThreadId.make('source'),
            occurredAt: now,
            payload: subagent(status),
          })
          yield* sink.write({ events: [changed('running')] })
          const service = yield* makeWorkspaceInputLifecycle(
            f.access,
            {
              collectUnusedCurrentVersionsForMaintenance() {
                return { removed: [], pending: [] }
              },
              subscribeInputPreparationSettled() {
                return () => {}
              },
              inputPreparationForNativeMaintenance() {
                return null
              },
              releaseInputAfterNativeTerminal(value) {
                released.push(value)
                return true
              },
            },
            createRunResourceLifecycle(f.access, {
              releaseRun(value) {
                environments.push(value)
                return {} as never
              },
            }),
          )
          yield* service.handle(parent.at(-1)!)
          expect(released).toEqual([])
          const idle = yield* sink.write({ events: [changed('idle')] })
          yield* service.handle(idle[0]!)
          expect(released).toEqual([])
          const synthetic = yield* sink.write({
            commandId: C.CommandId.make('command:runtime-reconcile:shutdown:child'),
            events: [changed('cancelled')],
          })
          yield* service.handle(synthetic[0]!)
          expect(released).toEqual([])
          const complete = yield* sink.write({ events: [changed('completed')] })
          yield* service.handle(complete[0]!)
          expect(released).toEqual([identity])
          expect(environments).toEqual([
            {
              threadId: 'source',
              runId: 'first',
              actorId: 'u-lin',
              projectId: 'p-autoops',
              environmentId: 'env-test',
            },
          ])
          f.access.recordNativeInputTurn('child', 'reused-child-turn')
          yield* service.handleIdentity(identity)
          expect(released).toEqual([identity])
          const turn = (status: C.OrchestrationV2ProviderTurn['status']) => ({
            id: C.EventId.make('child-turn-' + ++serial),
            type: 'provider-turn.updated' as const,
            threadId: C.ThreadId.make('child'),
            occurredAt: now,
            payload: Schema.decodeUnknownSync(C.OrchestrationV2ProviderTurn)({
              id: 'reused-child-turn',
              providerThreadId: 'child-provider',
              nodeId: 'child-root',
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: 1,
              status,
              startedAt: now,
              completedAt: status === 'running' ? null : now,
            }),
          })
          const active = yield* sink.write({ events: [turn('running')] })
          yield* service.handle(active[0]!)
          expect(released).toEqual([identity])
          const cancelled = yield* sink.write({
            commandId: C.CommandId.make('command:runtime-reconcile:shutdown:reused-child'),
            events: [turn('cancelled')],
          })
          yield* service.handle(cancelled[0]!)
          expect(released).toEqual([identity])
          const ended = yield* sink.write({ events: [turn('completed')] })
          yield* service.handle(ended[0]!)
          expect(released).toEqual([identity, identity])
          expect(environments).toHaveLength(2)
        }).pipe(Effect.provide(native)),
      ),
    )
  } finally {
    f.close()
  }
})

it('运行先结束但资料交接后到时，真实准备完成通知重新读取原收据并回收，不等待下一轮', async () => {
  const f = fixture(),
    values: unknown[] = []
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2,
            subscribed = yield* Deferred.make<void>(),
            released = yield* Deferred.make<void>()
          f.access.recordRunInputRequest(
            'source',
            'prepared-run',
            'original-preparation',
            'u-admin',
          )
          let available = false,
            listener = (_value: { projectId: string; requestId: string; actorId: string }) => {}
          const service = yield* makeWorkspaceInputLifecycle(f.access, {
            collectUnusedCurrentVersionsForMaintenance() {
              return { removed: [], pending: [] }
            },
            subscribeInputPreparationSettled(callback) {
              listener = callback
              Effect.runSync(Deferred.succeed(subscribed, undefined))
              return () => {
                listener = () => {}
              }
            },
            inputPreparationForNativeMaintenance() {
              return available
                ? ({ actorId: 'u-admin', preparing: true, value: { id: 'prepared-only' } } as never)
                : null
            },
            releaseInputAfterNativeTerminal(value) {
              values.push(value)
              Effect.runSync(Deferred.succeed(released, undefined))
              return true
            },
          })
          const fiber = yield* Effect.forkChild(service.run)
          yield* Deferred.await(subscribed)
          const ended = yield* sink.write({ events: create('source', 'prepared-run') })
          yield* service.handle(ended.at(-1)!)
          expect(values).toEqual([])
          available = true
          listener({
            projectId: 'p-autoops',
            requestId: 'original-preparation',
            actorId: 'u-admin',
          })
          expect(
            Option.isSome(yield* Deferred.await(released).pipe(Effect.timeoutOption('500 millis'))),
          ).toBe(true)
          expect(values).toEqual([
            { projectId: 'p-autoops', inputId: 'prepared-only', inputOwnerId: 'u-admin' },
          ])
          expect(
            f.access.inputResourceSnapshot('p-autoops', 'prepared-only').origins[0]?.runId,
          ).toBe('prepared-run')
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(native)),
      ),
    )
  } finally {
    f.close()
  }
})

it('旧固定范围仅在真实全线程终态后归还版本保护，新未知命令重新保护且拒绝收据通知可收尾', async () => {
  const f = fixture()
  let count = 0
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2,
            rejected = yield* Deferred.make<void>()
          f.access.bindThread(f.admin, {
            threadId: 'legacy-thread',
            projectId: 'p-autoops',
            environmentId: 'env-test',
            agentId: 'a-project',
            visibility: 'project',
            workspaceType: 'internal',
            workspaceVersionId: 'legacy-version',
          })
          const stored = yield* sink.write({ events: create('legacy-thread', 'legacy-run') })
          const service = yield* makeWorkspaceInputLifecycle(f.access, {
            inputPreparationForNativeMaintenance() {
              return null
            },
            subscribeInputPreparationSettled() {
              return () => {}
            },
            releaseInputAfterNativeTerminal() {
              return false
            },
            collectUnusedCurrentVersionsForMaintenance(project) {
              expect(project).toBe('p-autoops')
              count++
              if (count === 2) Effect.runSync(Deferred.succeed(rejected, undefined))
              return { removed: [], pending: [] }
            },
          })
          yield* service.handle(stored.at(-1)!)
          expect(f.access.workspaceVersionReferences('p-autoops')).toEqual([])
          expect(f.access.getThreadBinding('legacy-thread')?.workspaceVersionId).toBe(
            'legacy-version',
          )
          f.access.recordMessageActor(f.admin, 'legacy-thread', 'unknown-message', 'new-message')
          yield* service.handle(stored.at(-1)!)
          expect(f.access.workspaceVersionReferences('p-autoops')).toEqual(['legacy-version'])
          expect(count).toBe(1)
          yield* sink.commitRejectedCommand({
            commandId: C.CommandId.make('unknown-message'),
            threadId: C.ThreadId.make('legacy-thread'),
            commandType: 'message.send',
            rejectedAt: now,
            error: '已拒绝',
          })
          expect(
            Option.isSome(yield* Deferred.await(rejected).pipe(Effect.timeoutOption('500 millis'))),
          ).toBe(true)
          expect(f.access.workspaceVersionReferences('p-autoops')).toEqual([])
        }).pipe(Effect.provide(native)),
      ),
    )
  } finally {
    f.close()
  }
})
