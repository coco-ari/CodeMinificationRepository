import { assert, it } from "@effect/vitest";
import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RunExecutionService from "../orchestration-v2/RunExecutionService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { CustomerRuntimeRecovery } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { RemoteDeviceService, type RemoteDeviceHub } from "./RemoteDeviceService.ts";
import * as RemoteRunRecovery from "./RemoteRunRecovery.ts";

it.effect.each([
  "reattach",
  "never-dispatched",
  "pending-stop",
  "operator-resolution",
  "committed-resolution",
] as const)("reconciles customer %s with the original run and attempt", (scenario) =>
  Effect.gen(function* () {
    const now = DateTime.makeUnsafe("2026-10-23T00:00:00Z");
    const threadId = C.ThreadId.make("customer-thread");
    const runId = C.RunId.make("customer-run");
    const attemptId = C.RunAttemptId.make("customer-attempt");
    const nodeId = C.NodeId.make("customer-node");
    const sessionId = C.ProviderSessionId.make("customer-session");
    const providerThreadId = C.ProviderThreadId.make("customer-provider-thread");
    const instanceId = C.ProviderInstanceId.make(
      "customer-11111111-1111-1111-1111-111111111111-codex",
    );
    const modelSelection = { instanceId, model: "local-model" };
    const messageId = C.MessageId.make("customer-message");
    const checkpointScopeId = C.CheckpointScopeId.make("customer-checkpoint-scope");
    const projection = {
      thread: { id: threadId, providerInstanceId: instanceId, modelSelection },
      runs: [
        {
          id: runId,
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          providerThreadId,
          userMessageId: messageId,
          providerInstanceId: instanceId,
          status: scenario === "committed-resolution" ? "cancelled" : "running",
          ordinal: 7,
          threadId,
        },
      ],
      attempts: [
        {
          id: attemptId,
          runId,
          providerTurnId: null,
          status: scenario === "committed-resolution" ? "cancelled" : "running",
        },
      ],
      nodes: [{ id: nodeId, runId, checkpointScopeId, status: "running" }],
      providerThreads: [
        {
          id: providerThreadId,
          providerSessionId: sessionId,
          status: "active",
          driver: "codex",
          providerInstanceId: instanceId,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: "codex",
            strength: "strong",
            nativeId: "same-native-thread",
          },
          nativeConversationHeadRef: null,
          firstRunOrdinal: 7,
          lastRunOrdinal: 7,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      providerSessions: [{ id: sessionId, status: "running" }],
      providerTurns:
        scenario === "pending-stop"
          ? [
              {
                id: C.ProviderTurnId.make("known-native-turn"),
                providerThreadId,
                runAttemptId: attemptId,
                status: "running",
              },
            ]
          : [],
      runtimeRequests: [],
      turnItems: [],
      messages: [
        {
          id: messageId,
          text: "Never resend this prompt",
          createdBy: "user",
          creationSource: "web",
        },
      ],
      checkpointScopes: [{ id: checkpointScopeId }],
    } as unknown as C.OrchestrationV2ThreadProjection;
    const done = yield* Deferred.make<void>();
    const opened: Parameters<
      ProviderSessionManager.ProviderSessionManagerV2["Service"]["open"]
    >[0][] = [];
    const execution: Parameters<
      RunExecutionService.RunExecutionServiceV2["Service"]["startRootRun"]
    >[0][] = [];
    const writes: C.OrchestrationV2DomainEvent[] = [];
    const released: string[] = [];
    const interrupted: string[] = [];
    const updates: Array<Record<string, unknown>> = [];
    let live = false;
    const hub = {
      hasDispatchedRun: () => scenario !== "never-dispatched",
      acquireWorkspace: async () => {},
      update: (_id: string, value: Record<string, unknown>) => {
        updates.push(value);
      },
      enqueueInterrupt: (_session: string, _thread: unknown, turn: string) => {
        interrupted.push(turn);
      },
      clearPendingInterrupt: () => {},
      session: () => ({
        sessionId,
        threadId,
        runtimeEpoch: "original-epoch",
        ...(scenario === "pending-stop"
          ? { pendingInterrupt: { runId, attemptId, requestedAt: DateTime.formatIso(now) } }
          : {}),
        runs: [{ runId, attemptId, rootNodeId: nodeId, runOrdinal: 7, providerTurnOrdinal: 9 }],
        ...(["operator-resolution", "committed-resolution"].includes(scenario)
          ? {
              resolution: {
                runId,
                attemptId,
                resolvedAt: DateTime.formatIso(now),
                reason: "operator_confirmed_process_stopped",
              },
            }
          : {}),
      }),
      subscribeSession: () => () => {},
      releaseWorkspace: (_thread: string, run: string) => {
        released.push(run);
        if (scenario === "committed-resolution") Deferred.doneUnsafe(done, Effect.void);
      },
    } as unknown as RemoteDeviceHub;
    const dependencies = Layer.mergeAll(
      Layer.succeed(RemoteDeviceService, { hub }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadProjection: () => Effect.succeed(projection),
        getRuntimeRecoveryProjection: () => Effect.succeed(projection),
      }),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        isLive: () => Effect.sync(() => live),
        open: (input) =>
          Effect.sync(() => {
            opened.push(input);
            live = true;
            return {
              resumeThread: () => Effect.succeed(projection.providerThreads[0]!),
            } as unknown as Adapter.ProviderAdapterV2SessionRuntime;
          }),
        release: () => Deferred.succeed(done, undefined),
      }),
      Layer.mock(RunExecutionService.RunExecutionServiceV2)({
        startRootRun: (input) =>
          Effect.sync(() => {
            execution.push(input);
          }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
      }),
      Layer.mock(EventSink.EventSinkV2)({
        writeIfRunCurrent: (input) =>
          Effect.sync(() => {
            assert.equal(input.activeAttemptId, attemptId);
            writes.push(...input.events);
            return { committed: true, storedEvents: [] };
          }),
      }),
      IdAllocator.layer,
    );
    yield* Effect.gen(function* () {
      const recovery = yield* CustomerRuntimeRecovery;
      yield* recovery.recover(projection);
      yield* Deferred.await(done);
      if (scenario === "committed-resolution") {
        assert.isEmpty(execution);
        assert.isEmpty(writes);
        assert.equal((updates[0]?.appliedResolution as { runId: string }).runId, runId);
        assert.equal(updates[0]?.state, "idle");
        assert.deepEqual(released, [runId]);
      } else if (scenario !== "operator-resolution") {
        assert.equal(opened.length, 1);
        assert.isTrue(opened[0]!.reattachOnly);
        assert.equal(opened[0]!.initialNativeThreadId, "same-native-thread");
        assert.equal(execution[0]!.run.id, runId);
        assert.equal(execution[0]!.attemptId, attemptId);
        assert.equal(execution[0]!.providerTurnOrdinal, 9);
        assert.equal(execution[0]!.resumeOnly, scenario !== "never-dispatched");
        assert.deepEqual(interrupted, scenario === "pending-stop" ? ["known-native-turn"] : []);
        assert.equal(execution[0]!.message.text, "Never resend this prompt");
        assert.isEmpty(writes);
      } else {
        assert.isEmpty(opened);
        assert.isEmpty(execution);
        assert.deepEqual(released, [runId]);
        assert.deepEqual(
          writes
            .filter((event) =>
              ["run.updated", "run-attempt.updated", "node.updated"].includes(event.type),
            )
            .map((event) => (event.payload as { status: string }).status),
          ["cancelled", "cancelled", "cancelled"],
        );
      }
    }).pipe(Effect.provide(RemoteRunRecovery.layer.pipe(Layer.provide(dependencies))));
  }),
);
