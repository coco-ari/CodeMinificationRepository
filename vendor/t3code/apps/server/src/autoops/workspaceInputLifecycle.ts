import * as C from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'
import * as SqlClient from 'effect/sql/SqlClient'
import { configuredAutoOpsAccess } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import type { AutoOpsAccess } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { configuredWorkspaceManagement } from '../../../../../../agent-demo/t3-adapters/workspace-management.ts'
import { configuredEnvironmentMcp } from '../../../../../../agent-demo/t3-adapters/environment-mcp-runtime.ts'
import {
  createRunResourceLifecycle,
  type RunResourceLifecycle,
} from '../../../../../../agent-demo/t3-adapters/run-resource-lifecycle.ts'
import * as EventSink from '../orchestration-v2/EventSink.ts'
import * as EventStore from '../orchestration-v2/EventStore.ts'
import * as ProjectionStore from '../orchestration-v2/ProjectionStore.ts'
import * as CommandReceipts from '../orchestration-v2/CommandReceiptStore.ts'
import * as EffectOutbox from '../orchestration-v2/EffectOutbox.ts'
import { forkParked } from '../serverActivation.ts'
import { nativeRunResourcesSettled } from './runResourceLifecycle.ts'

type Identity = { projectId: string; inputId: string; inputOwnerId: string }
type Access = Pick<
  AutoOpsAccess,
  | 'inputResourceCandidates'
  | 'inputResourceSnapshot'
  | 'withInputResourceSnapshot'
  | 'inputPreparationCandidates'
  | 'completeRunInputRequest'
  | 'inputRequestThreads'
  | 'workspaceVersionResourceSnapshot'
  | 'releaseWorkspaceVersionResource'
>
type Workspace = Pick<
  ReturnType<typeof configuredWorkspaceManagement>,
  | 'releaseInputAfterNativeTerminal'
  | 'inputPreparationForNativeMaintenance'
  | 'subscribeInputPreparationSettled'
  | 'collectUnusedCurrentVersionsForMaintenance'
>
const encodeRun = Schema.encodeSync(Schema.fromJsonString(C.OrchestrationV2Run))
const encodeSubagent = Schema.encodeSync(Schema.fromJsonString(C.OrchestrationV2Subagent))
const encodeProviderTurn = Schema.encodeSync(Schema.fromJsonString(C.OrchestrationV2ProviderTurn))
const terminal = (status: string) =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)

/** 引用事实由业务所属模块保存；完成与排队状态只读取已提交的 T3 投影和收据。 */
export const makeWorkspaceInputLifecycle = Effect.fn('AutoOpsWorkspaceInputLifecycle.make')(
  function* (access: Access, workspace: Workspace, environment?: RunResourceLifecycle) {
    const events = yield* EventSink.EventSinkV2,
      store = yield* EventStore.EventStoreV2
    const projections = yield* ProjectionStore.ProjectionStoreV2,
      receipts = yield* CommandReceipts.CommandReceiptStoreV2
    const outbox = yield* EffectOutbox.EffectOutboxV2,
      sql = yield* SqlClient.SqlClient,
      scope = yield* Scope.Scope
    const watching = new Set<string>()
    type Pending = { continuations: Set<string>; commands: Set<string> }
    const createProof = () => {
      const pending: Pending = { continuations: new Set(), commands: new Set() },
        seen = new Set<string>()
      const get = (threadId: string) => projections.getThreadProjection(C.ThreadId.make(threadId))
      const source = (
        threadId: C.ThreadId,
        eventType: 'run.updated' | 'subagent.updated' | 'provider-turn.updated',
        entityId: string,
      ) => store.latestResourceUpdate({ threadId, eventType, entityId })
      const checkRun = (
        projection: C.OrchestrationV2ThreadProjection,
        runId: C.RunId,
      ): Effect.Effect<boolean, Error> =>
        Effect.gen(function* () {
          if (!nativeRunResourcesSettled(projection, runId)) return false
          const current = projection.runs.find((value) => value.id === runId)!,
            latest = yield* source(projection.thread.id, 'run.updated', runId)
          if (
            Option.isNone(latest) ||
            latest.value.event.type !== 'run.updated' ||
            latest.value.commandId?.startsWith('command:runtime-reconcile:') ||
            encodeRun(current) !== encodeRun(latest.value.event.payload)
          )
            return false
          const effectId = `effect:restart-continuation:${runId}`,
            continuation = yield* outbox.get(effectId)
          if (
            Option.exists(
              continuation,
              (value) => value.status === 'pending' || value.status === 'running',
            )
          ) {
            pending.continuations.add(effectId)
            return false
          }
          for (const child of projection.subagents.filter((value) => value.runId === runId))
            if (!(yield* checkChild(projection, child))) return false
          return true
        })
      const checkChild = (
        parent: C.OrchestrationV2ThreadProjection,
        child: C.OrchestrationV2Subagent,
      ): Effect.Effect<boolean, Error> =>
        Effect.gen(function* () {
          if (!terminal(child.status) || child.completedAt === null || child.childThreadId === null)
            return false
          const latest = yield* source(parent.thread.id, 'subagent.updated', child.id)
          if (
            Option.isNone(latest) ||
            latest.value.event.type !== 'subagent.updated' ||
            latest.value.commandId?.startsWith('command:runtime-reconcile:') ||
            encodeSubagent(child) !== encodeSubagent(latest.value.event.payload)
          )
            return false
          return yield* checkThread(yield* get(child.childThreadId))
        })
      const checkThread = (
        projection: C.OrchestrationV2ThreadProjection,
      ): Effect.Effect<boolean, Error> =>
        Effect.gen(function* () {
          const threadId = projection.thread.id
          if (seen.has(threadId) || seen.size >= 1000) return false
          seen.add(threadId)
          if (
            projection.nodes.some((value) => !terminal(value.status)) ||
            projection.providerTurns.some(
              (value) => !terminal(value.status) || value.completedAt === null,
            ) ||
            projection.runtimeRequests.some((value) => value.status === 'pending')
          )
            return false
          for (const turn of projection.providerTurns) {
            const latest = yield* source(projection.thread.id, 'provider-turn.updated', turn.id)
            if (
              Option.isNone(latest) ||
              latest.value.event.type !== 'provider-turn.updated' ||
              latest.value.commandId?.startsWith('command:runtime-reconcile:') ||
              encodeProviderTurn(turn) !== encodeProviderTurn(latest.value.event.payload)
            )
              return false
          }
          for (const run of projection.runs)
            if (!(yield* checkRun(projection, run.id))) return false
          for (const child of projection.subagents.filter((value) => value.runId === null))
            if (!(yield* checkChild(projection, child))) return false
          seen.delete(threadId)
          return true
        })
      return { pending, get, source, checkRun, checkChild, checkThread }
    }
    const reconcile = (
      identity: Identity,
    ): Effect.Effect<{ continuations: Set<string>; commands: Set<string> }, Error> =>
      sql.withTransaction(
        Effect.gen(function* () {
          const snapshot = yield* Effect.try(() =>
            access.inputResourceSnapshot(identity.projectId, identity.inputId),
          )
          const { pending, get, source, checkRun, checkChild, checkThread } = createProof()
          if (
            snapshot.truncated ||
            (!snapshot.runs.length &&
              !snapshot.claims.length &&
              !snapshot.origins.length &&
              !snapshot.nativeTurns.length)
          )
            return pending
          if (
            snapshot.runs.some(
              (value) => !value.actorVerified || value.inputOwnerId !== identity.inputOwnerId,
            ) ||
            snapshot.references.some((value) => value.inputOwnerId !== identity.inputOwnerId) ||
            snapshot.claims.some((value) => value.inputOwnerId !== identity.inputOwnerId) ||
            snapshot.origins.some((value) => value.actorId !== identity.inputOwnerId) ||
            snapshot.nativeTurns.some((value) => value.inputOwnerId !== identity.inputOwnerId)
          )
            return pending
          let settled = true
          for (const reference of snapshot.nativeTurns) {
            const projection = yield* get(reference.threadId),
              turn = projection.providerTurns.find((value) => value.id === reference.providerTurnId)
            if (!turn || !terminal(turn.status) || turn.completedAt === null) {
              settled = false
              continue
            }
            const latest = yield* source(projection.thread.id, 'provider-turn.updated', turn.id)
            if (
              Option.isNone(latest) ||
              latest.value.event.type !== 'provider-turn.updated' ||
              latest.value.commandId?.startsWith('command:runtime-reconcile:') ||
              encodeProviderTurn(turn) !== encodeProviderTurn(latest.value.event.payload)
            )
              settled = false
          }
          for (const origin of snapshot.origins)
            if (!(yield* checkRun(yield* get(origin.threadId), C.RunId.make(origin.runId))))
              settled = false
          for (const reference of snapshot.runs) {
            if (reference.parentThreadId) {
              const parent = yield* get(reference.parentThreadId),
                children = parent.subagents.filter(
                  (value) => value.childThreadId === reference.threadId,
                )
              if (!children.length) {
                settled = false
                continue
              }
              for (const child of children) if (!(yield* checkChild(parent, child))) settled = false
            } else if (
              !(yield* checkRun(yield* get(reference.threadId), C.RunId.make(reference.runId)))
            )
              settled = false
          }
          for (const reference of snapshot.references) {
            if (reference.parentThreadId) {
              const parent = yield* get(reference.parentThreadId),
                children = parent.subagents.filter(
                  (value) => value.childThreadId === reference.threadId,
                )
              if (!children.length) settled = false
              for (const child of children) if (!(yield* checkChild(parent, child))) settled = false
              continue
            }
            const claims = snapshot.claims.filter((value) => value.threadId === reference.threadId)
            // 旧的未登记命令引用不能凭没有运行记录推断为已拒绝。
            if (!claims.length) {
              settled = false
              continue
            }
            for (const claim of claims) {
              const receipt = yield* receipts.getByCommandId(C.CommandId.make(claim.commandId))
              if (Option.isNone(receipt)) {
                pending.commands.add(claim.commandId)
                settled = false
                continue
              }
              if (receipt.value.threadId !== claim.threadId) {
                settled = false
                continue
              }
              if (receipt.value.status === 'rejected') continue
              const projection = yield* get(claim.threadId)
              if (claim.kind === 'fork') {
                if (!(yield* checkThread(projection))) settled = false
                continue
              }
              const message = claim.messageId
                ? projection.messages.find((value) => value.id === claim.messageId)
                : undefined
              const runId = claim.runId ?? message?.runId
              if (!runId || !(yield* checkRun(projection, C.RunId.make(runId)))) settled = false
            }
          }
          if (settled)
            yield* Effect.try(() =>
              access.withInputResourceSnapshot(snapshot, () => {
                if (!workspace.releaseInputAfterNativeTerminal(identity)) return false
                if (environment)
                  for (const run of snapshot.runs.filter((value) => value.parentThreadId === null))
                    for (const reference of environment.references(run.threadId, run.runId))
                      environment.releaseAfterNativeTreeTerminal(reference)
                return true
              }),
            )
          return pending
        }),
      )
    const watchPending = (pending: Pending, prefix: string, resume: () => Effect.Effect<void>) => {
      const waits: Array<{ key: string; wait: Effect.Effect<void, Error> }> = [
        ...[...pending.continuations].map((id) => ({
          key: `effect:${id}`,
          wait: outbox.awaitSettled(id),
        })),
        ...[...pending.commands].map((id) => ({
          key: `command:${id}`,
          wait: events.awaitCommandReceipt(C.CommandId.make(id)),
        })),
      ]
      return Effect.forEach(
        waits,
        (entry) =>
          Effect.gen(function* () {
            const key = `${prefix.length}:${prefix}${entry.key}`
            if (watching.has(key) || watching.size >= 128) return
            watching.add(key)
            yield* Effect.forkIn(
              entry.wait.pipe(
                Effect.ensuring(Effect.sync(() => watching.delete(key))),
                Effect.andThen(Effect.suspend(resume)),
                Effect.catchCause((cause) =>
                  Effect.logWarning('原输入收据等待失败，继续保护原资料', { cause }),
                ),
              ),
              scope,
            )
          }),
        { discard: true },
      )
    }
    const handleIdentity: (identity: Identity) => Effect.Effect<void> = (identity) =>
      reconcile(identity).pipe(
        Effect.flatMap((pending) =>
          watchPending(
            pending,
            `${identity.projectId.length}:${identity.projectId}${identity.inputId}`,
            () => handleIdentity(identity),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning('原输入终态核验失败，继续保护原资料', { cause }),
        ),
      )
    const handleVersionScope: (threadId: string) => Effect.Effect<void> = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const proof = createProof(),
              snapshot = yield* Effect.try(() => access.workspaceVersionResourceSnapshot(threadId))
            if (
              !snapshot ||
              snapshot.truncated ||
              (snapshot.scopeState === 'submitting' && !snapshot.submissionCommandId)
            )
              return proof.pending
            const projection = yield* proof.get(threadId)
            let settled = yield* proof.checkThread(projection)
            const commands = [
              ...snapshot.commands,
              ...(snapshot.submissionCommandId
                ? [
                    {
                      commandId: snapshot.submissionCommandId,
                      targetId: '',
                      kind: 'submission',
                      actorId: '',
                    },
                  ]
                : []),
            ]
            for (const command of commands) {
              const receipt = yield* receipts.getByCommandId(C.CommandId.make(command.commandId))
              if (Option.isNone(receipt)) {
                proof.pending.commands.add(command.commandId)
                settled = false
                continue
              }
              if (receipt.value.threadId !== threadId) {
                settled = false
                continue
              }
              if (receipt.value.status === 'rejected') continue
              if (command.kind === 'message') {
                const message = projection.messages.find((value) => value.id === command.targetId)
                if (!message?.runId || !(yield* proof.checkRun(projection, message.runId)))
                  settled = false
              } else if (
                command.kind === 'queued-run.edit' &&
                !projection.runs.some((value) => value.id === command.targetId)
              )
                settled = false
            }
            if (settled) {
              const sequence = yield* store.latestSequence({ threadId: C.ThreadId.make(threadId) })
              yield* Effect.try(() =>
                access.releaseWorkspaceVersionResource(snapshot, sequence, () =>
                  workspace.collectUnusedCurrentVersionsForMaintenance(snapshot.projectId),
                ),
              )
            }
            return proof.pending
          }),
        )
        .pipe(
          Effect.flatMap((pending) =>
            watchPending(pending, `scope:${threadId}`, () => handleVersionScope(threadId)),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning('旧固定资料范围终态核验失败，继续保护原件', { cause }),
          ),
        )
    const handleThread = (threadId: string) =>
      Effect.gen(function* () {
        const origins = yield* Effect.try(() => access.inputPreparationCandidates(threadId))
        for (const origin of origins) {
          const record = yield* Effect.try(() =>
            workspace.inputPreparationForNativeMaintenance(origin),
          )
          if (record)
            yield* Effect.try(() => access.completeRunInputRequest(origin, record.value.id))
        }
        const candidates = yield* Effect.try(() => access.inputResourceCandidates(threadId))
        for (const candidate of candidates) yield* handleIdentity(candidate)
        yield* handleVersionScope(threadId)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning('原输入引用读取失败，继续保护原资料', { cause }),
        ),
      )
    const handle = (event: C.OrchestrationV2StoredEvent) =>
      [
        'thread.created',
        'thread.updated',
        'run-attempt.updated',
        'run.updated',
        'subagent.updated',
        'node.updated',
        'provider-turn.updated',
        'runtime-request.updated',
      ].includes(event.event.type)
        ? handleThread(event.event.threadId)
        : Effect.void
    const changes = Stream.callback<{ projectId: string; requestId: string; actorId: string }>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            workspace.subscribeInputPreparationSettled((value) => Queue.offerUnsafe(queue, value)),
          ),
          (remove) => Effect.sync(remove),
        ),
    )
    const preparationChanged = (value: { projectId: string; requestId: string; actorId: string }) =>
      Effect.gen(function* () {
        const threads = yield* Effect.try(() =>
          access.inputRequestThreads(value.projectId, value.requestId, value.actorId),
        )
        for (const thread of threads) yield* handleThread(thread)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning('资料准备收尾核验失败，继续保护原资料', { cause }),
        ),
      )
    return {
      handle,
      handleIdentity,
      run: Effect.all(
        [
          Stream.runForEach(events.stream({ afterSequence: 0 }), handle),
          Stream.runForEach(changes, preparationChanged),
        ],
        { concurrency: 'unbounded', discard: true },
      ),
    }
  },
)

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const access = configuredAutoOpsAccess()
    if (!access) return
    const service = yield* makeWorkspaceInputLifecycle(
      access,
      configuredWorkspaceManagement(access),
      createRunResourceLifecycle(access, configuredEnvironmentMcp(access)),
    )
    yield* forkParked(
      service.run.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning('原输入终态读取中断，继续保护原资料', { cause }),
        ),
      ),
    )
  }),
)
