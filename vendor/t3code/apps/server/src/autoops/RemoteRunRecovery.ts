import * as Option from "effect/Option";
import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RunExecutionService from "../orchestration-v2/RunExecutionService.ts";
import { CustomerRuntimeRecovery } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { RemoteDeviceService } from "./RemoteDeviceService.ts";

/** Reattach the existing T3 run. A center restart is not a customer process restart. */
export const layer = Layer.effect(
  CustomerRuntimeRecovery,
  Effect.gen(function* () {
    const remote = yield* Effect.serviceOption(RemoteDeviceService);
    const hub = Option.isSome(remote) ? remote.value.hub : undefined;
    if (!hub) return { recover: () => Effect.void };
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const execution = yield* RunExecutionService.RunExecutionServiceV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const scope = yield* Scope.Scope;
    const locks = yield* KeyedLock.make<string>();
    const recoverSession = Effect.fn("RemoteRunRecovery.recoverSession")(function* (
      sessionId: string,
    ) {
      const saved = hub.session(sessionId);
      if (!saved) return;
      const threadId = C.ThreadId.make(saved.threadId);
      const projection = yield* projections.getThreadProjection(threadId);
      // A local operator attestation is durably repeated in hello. Reconcile a
      // receipt whose canonical finalization already committed (including a crash
      // before the transport marker), without cancelling a later run or lease.
      const priorResolution = saved.resolution;
      if (priorResolution) {
        const resolvedRun = projection.runs.find((run) => run.id === priorResolution.runId);
        const resolvedAttempt = projection.attempts.find(
          (attempt) =>
            attempt.id === priorResolution.attemptId && attempt.runId === priorResolution.runId,
        );
        const terminal = (status: string) =>
          ["completed", "failed", "interrupted", "cancelled"].includes(status);
        if (
          resolvedRun?.activeAttemptId === priorResolution.attemptId &&
          terminal(resolvedRun.status) &&
          resolvedAttempt &&
          terminal(resolvedAttempt.status)
        ) {
          yield* Effect.sync(() => {
            const activeDispatched = projection.runs.some(
              (run) =>
                !terminal(run.status) &&
                run.activeAttemptId !== null &&
                hub.hasDispatchedRun(sessionId, run.id, run.activeAttemptId),
            );
            hub.update(sessionId, {
              appliedResolution: priorResolution,
              ...(!activeDispatched ? { state: "idle" as const } : {}),
            });
            hub.releaseWorkspace(threadId, resolvedRun.id);
          });
        }
      }
      const pendingInterrupt = saved.pendingInterrupt;
      if (pendingInterrupt) {
        const nativeTurn = projection.providerTurns.find(
          (turn) => turn.runAttemptId === pendingInterrupt.attemptId,
        );
        const nativeThread =
          nativeTurn &&
          projection.providerThreads.find((thread) => thread.id === nativeTurn.providerThreadId);
        if (nativeTurn && nativeThread) {
          const encoded = yield* Schema.encodeEffect(C.OrchestrationV2ProviderThreadJson)(
            nativeThread,
          );
          yield* Effect.try({
            try: () => {
              hub.enqueueInterrupt(sessionId, encoded, nativeTurn.id);
              hub.clearPendingInterrupt(sessionId, pendingInterrupt.attemptId);
            },
            catch: (cause) =>
              new ProviderAdapterProtocolError({
                driver: C.ProviderDriverKind.make("codex"),
                detail: "客户停止请求等待原生轮次确认",
                cause,
              }),
          });
        }
      }
      for (const run of projection.runs.filter((run) =>
        ["starting", "running", "waiting"].includes(run.status),
      )) {
        const attempt = projection.attempts.find(
          (candidate) => candidate.id === run.activeAttemptId,
        );
        const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
        const providerThread = projection.providerThreads.find(
          (candidate) => candidate.id === run.providerThreadId,
        );
        const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
        const checkpointScope = projection.checkpointScopes.find(
          (candidate) => candidate.id === rootNode?.checkpointScopeId,
        );
        if (
          !attempt ||
          !rootNode ||
          !providerThread ||
          !message ||
          !checkpointScope ||
          providerThread.providerSessionId !== sessionId
        )
          continue;
        const resolution = saved.resolution;
        if (resolution?.runId === run.id && resolution.attemptId === attempt.id) {
          // This is an explicit, durable local operator attestation, never inferred from silence.
          const now = DateTime.makeUnsafe(resolution.resolvedAt);
          const commandId = C.CommandId.make(
            `customer:resolve:${sessionId}:${run.id}:${attempt.id}:${resolution.resolvedAt}`,
          );
          const base = {
            threadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
          };
          const events: C.OrchestrationV2DomainEvent[] = [];
          const add = Effect.fn("RemoteRunRecovery.addResolutionEvent")(function* (
            event: Omit<C.OrchestrationV2DomainEvent, "id">,
          ) {
            events.push({
              ...event,
              id: yield* ids.allocate.event({ threadId, commandId }),
            } as C.OrchestrationV2DomainEvent);
          });
          yield* add({
            ...base,
            type: "run.updated",
            payload: { ...run, status: "cancelled", completedAt: now },
          });
          yield* add({
            ...base,
            type: "run-attempt.updated",
            payload: { ...attempt, status: "cancelled", completedAt: now },
          });
          for (const node of projection.nodes.filter(
            (node) =>
              node.runId === run.id && ["pending", "running", "waiting"].includes(node.status),
          )) {
            yield* add({
              ...base,
              nodeId: node.id,
              type: "node.updated",
              payload: { ...node, status: "cancelled", completedAt: now },
            });
          }
          for (const request of projection.runtimeRequests.filter(
            (request) =>
              request.status === "pending" &&
              projection.nodes.some((node) => node.runId === run.id && node.id === request.nodeId),
          )) {
            yield* add({
              ...base,
              nodeId: request.nodeId,
              type: "runtime-request.updated",
              payload: {
                ...request,
                status: "cancelled",
                resolvedAt: now,
                responseCapability: {
                  type: "not_resumable",
                  reason: "客户已在本机确认进程停止并解除工作区占用。",
                },
              },
            });
          }
          for (const turn of projection.providerTurns.filter(
            (turn) =>
              turn.runAttemptId === attempt.id &&
              ["pending", "running", "waiting"].includes(turn.status),
          )) {
            yield* add({
              ...base,
              type: "provider-turn.updated",
              payload: { ...turn, status: "cancelled", completedAt: now },
            });
          }
          for (const item of projection.turnItems.filter(
            (item) =>
              item.runId === run.id && ["pending", "running", "waiting"].includes(item.status),
          )) {
            yield* add({
              ...base,
              type: "turn-item.updated",
              payload: {
                ...item,
                status: "cancelled",
                completedAt: now,
                updatedAt: now,
                ...(item.type === "secret_request" ? { secretStatus: "cancelled" as const } : {}),
              },
            });
          }
          yield* add({
            ...base,
            type: "provider-thread.updated",
            payload: { ...providerThread, status: "not_loaded", updatedAt: now },
          });
          const committed = yield* eventSink.writeIfRunCurrent({
            commandId,
            threadId,
            runId: run.id,
            activeAttemptId: attempt.id,
            expectedStatus: run.status,
            events,
            effects: [],
          });
          if (!committed.committed) continue;
          yield* Effect.sync(() => {
            hub.releaseWorkspace(threadId, run.id);
            hub.update(sessionId, { state: "idle", appliedResolution: resolution });
          });
          yield* sessions.release({
            providerSessionId: C.ProviderSessionId.make(sessionId),
            reason: "manual_shutdown",
          });
          continue;
        }
        if (run.status !== "running") continue;
        if (yield* sessions.isLive(C.ProviderSessionId.make(sessionId))) continue;
        const wasDispatched = hub.hasDispatchedRun(sessionId, run.id, attempt.id);
        const existingSession = projection.providerSessions.find(
          (candidate) => candidate.id === sessionId,
        );
        if (!existingSession) continue;
        const runtimePolicy = {
          runtimeMode: "approval-required" as const,
          interactionMode: "default" as const,
          cwd: null,
        };
        const session = yield* sessions.open({
          threadId,
          providerSessionId: existingSession.id,
          modelSelection: run.modelSelection,
          runtimePolicy,
          reattachOnly: true,
          resumeFromSession: existingSession,
          ...(providerThread.nativeThreadRef?.nativeId == null
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
        });
        const isCurrent = () =>
          projections
            .getRuntimeRecoveryProjection(threadId)
            .pipe(
              Effect.map((current) =>
                current.runs.some(
                  (candidate) =>
                    candidate.id === run.id &&
                    candidate.activeAttemptId === attempt.id &&
                    candidate.status === "running",
                ),
              ),
            );
        yield* Effect.gen(function* () {
          let recoveredProviderThread = providerThread;
          if (!wasDispatched) {
            // The command journal is committed before network delivery. Its absence is
            // evidence that this exact attempt never reached the customer process.
            yield* Effect.tryPromise({
              try: (signal) => hub.acquireWorkspace(threadId, run.id, signal),
              catch: (cause) =>
                new ProviderAdapterProtocolError({
                  driver: C.ProviderDriverKind.make("codex"),
                  detail: "客户工作区暂不可恢复",
                  cause,
                }),
            });
            if (!(yield* isCurrent())) {
              return;
            }
            recoveredProviderThread = yield* session.resumeThread({
              providerThread,
              threadId,
              modelSelection: run.modelSelection,
              runtimePolicy,
            });
          }
          yield* execution.startRootRun({
            commandId: C.CommandId.make(`customer:reattach:${run.id}:${attempt.id}`),
            appThread: projection.thread,
            providerSessionId: existingSession.id,
            session,
            run,
            rootNode,
            checkpointScope,
            providerThread: recoveredProviderThread,
            attempt,
            attemptId: attempt.id,
            providerTurnOrdinal:
              saved.runs?.find(
                (record) => record.runId === run.id && record.attemptId === attempt.id,
              )?.providerTurnOrdinal ??
              Math.max(
                0,
                ...projection.providerTurns
                  .filter((turn) => turn.providerThreadId === providerThread.id)
                  .map((turn) => turn.ordinal),
              ) + 1,
            resumeOnly: wasDispatched,
            shouldStartProviderTurn: isCurrent,
            shouldFinalizeRun: () =>
              projections
                .getRuntimeRecoveryProjection(threadId)
                .pipe(
                  Effect.map((current) =>
                    current.runs.some(
                      (candidate) =>
                        candidate.id === run.id &&
                        candidate.activeAttemptId === attempt.id &&
                        candidate.status === "running",
                    ),
                  ),
                ),
            message: {
              messageId: message.id,
              text: message.text,
              attachments: [],
              createdBy: message.createdBy,
              creationSource: message.creationSource,
            },
            modelSelection: run.modelSelection,
            runtimePolicy,
          });
        }).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              hub.releaseWorkspace(threadId, run.id, { onlyIfNotDispatched: true }),
            ),
          ),
        );
      }
      // A terminal can be committed immediately before the center crashes. Drain its
      // receipt-backed replay even when no active run remains to attach a consumer.
      const savedSession = projection.providerSessions.find((session) => session.id === sessionId);
      if (
        savedSession &&
        saved.runtimeEpoch &&
        saved.state !== "unknown" &&
        !(yield* sessions.isLive(savedSession.id))
      ) {
        yield* sessions.open({
          threadId,
          providerSessionId: savedSession.id,
          modelSelection: projection.thread.modelSelection,
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: null,
          },
          reattachOnly: true,
          resumeFromSession: savedSession,
        });
      }
    });
    const recover = (sessionId: string) =>
      locks
        .withLock(sessionId, recoverSession(sessionId))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Customer runtime reconciliation is pending.", { sessionId, cause }),
          ),
        );
    const changes = yield* Queue.unbounded<string>();
    const unsubscribe = hub.subscribeSession((sessionId) => {
      Queue.offerUnsafe(changes, sessionId);
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    yield* Stream.fromQueue(changes).pipe(
      Stream.runForEach((sessionId) => recover(sessionId).pipe(Effect.forkIn(scope))),
      Effect.forkIn(scope),
    );
    return {
      recover: (projection: ProjectionStore.ProjectionRuntimeRecoveryState) =>
        Effect.forEach(
          projection.providerSessions,
          (session) => recover(session.id).pipe(Effect.forkIn(scope)),
          { discard: true },
        ),
    };
  }),
);
