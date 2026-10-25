import { it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as C from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { makeRemoteProviderAdapter } from "./RemoteProviderAdapter.ts";
import type { RemoteDeviceHub } from "./RemoteDeviceService.ts";
import { CustomerCodexCapabilities } from "../provider/HeadlessCodexRunner.ts";
import { HeadlessCodexInputs } from "../provider/HeadlessCodexProtocol.ts";

it.each(["restart", "preflight-failure", "dispatch-unknown", "same-file", "other-file"] as const)(
  "keeps the native thread and start outcome across %s",
  async (scenario) => {
    const instanceId = C.ProviderInstanceId.make(
      "customer-11111111-1111-1111-1111-111111111111-codex",
    );
    const now = "2026-10-23T00:00:00Z";
    const modelSelection = { instanceId, model: "local-model" };
    const runtimePolicy = {
      cwd: null,
      runtimeMode: "approval-required",
      interactionMode: "default",
    };
    const nativeThread = {
      id: "provider-thread",
      appThreadId: "thread",
      providerSessionId: "session",
      driver: "codex",
      providerInstanceId: instanceId,
      ownerNodeId: null,
      nativeThreadRef: { driver: "codex", strength: "strong", nativeId: "original-native-thread" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    const providerSession = {
      id: "session",
      driver: "codex",
      providerInstanceId: instanceId,
      status: "ready",
      cwd: "customer://fixture/workspace",
      model: "local-model",
      capabilities: CustomerCodexCapabilities,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    const saved: Record<string, any> = {
      providerSession,
      runtimeEpoch: "old-epoch",
      state: "idle",
    };
    let live = false,
      dispatched = false;
    const commands: Array<{ method: string; input: any }> = [];
    const hub = {
      access: {
        getThreadBinding: () => ({
          ownerId: "owner",
          projectId: "project",
          executionBinding: {
            kind: "customer",
            deviceId: "11111111-1111-1111-1111-111111111111",
            runtimeId: "codex",
            registeredWorkspaceId: "workspace",
            workspaceBindingRevision: 1,
          },
        }),
        customerRegistry: { validateSelection: () => {} },
      },
      bind: () => {},
      session: () => saved,
      connectorEpoch: () => "new-connector",
      runtimeState: () => ({ runtimeEpoch: saved.runtimeEpoch, state: "idle", live, lastSeq: 0 }),
      awaitOnline: async () => {},
      awaitInboxDrained: async () => {},
      hasDispatchedRun: () => dispatched,
      update: (_id: string, value: unknown) => Object.assign(saved, value),
      events: async function* () {},
      command: async (_session: string, method: string, input: any) => {
        commands.push({ method, input });
        if (method === "openSession") {
          live = true;
          saved.runtimeEpoch = "new-epoch";
          return providerSession;
        }
        if (method === "resumeThread") {
          if (scenario === "preflight-failure")
            throw Error("Resume refused before any turn was sent");
          return nativeThread;
        }
        if (method === "startTurn") {
          dispatched = true;
          if (scenario === "dispatch-unknown") throw Error("Connection lost after durable start");
          return;
        }
        if (method === "steerTurn") return;
        throw Error("Unexpected command");
      },
    } as unknown as RemoteDeviceHub;
    const input = Schema.decodeUnknownSync(HeadlessCodexInputs.startTurn)({
      appThread: {
        id: "thread",
        createdBy: "user",
        creationSource: "web",
        projectId: "project",
        title: "Fixture",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: nativeThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread" },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId: "thread",
      runId: "run-two",
      runOrdinal: 2,
      providerTurnOrdinal: 2,
      attemptId: "attempt-two",
      rootNodeId: "root-two",
      providerThread: nativeThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: "message-two",
        text: scenario.endsWith("file")
          ? `[client (4G).ts](autoops-customer/11111111-1111-1111-1111-111111111111/${scenario === "same-file" ? "workspace" : "other-workspace"}/1/src/client%20%284G%29.ts) Read this file`
          : "Continue this same conversation",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });
    const openInput = Schema.decodeUnknownSync(HeadlessCodexInputs.openSession)({
      threadId: "thread",
      providerSessionId: "session",
      modelSelection,
      runtimePolicy,
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRemoteProviderAdapter(hub, instanceId).openSession(openInput);
          const result = yield* Effect.result(runtime.startTurn(input));
          if (scenario === "restart" || scenario === "same-file")
            expect(result._tag).toBe("Success");
          else {
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure")
              expect((result.failure as { outcome?: string }).outcome).toBe(
                scenario === "dispatch-unknown" ? undefined : "not_started",
              );
          }
          if (scenario === "same-file") {
            const steering = yield* Schema.decodeUnknownEffect(HeadlessCodexInputs.steerTurn)({
              threadId: input.threadId,
              providerThread: nativeThread,
              providerTurnId: "turn-two",
              runId: input.runId,
              attemptId: input.attemptId,
              message: { ...input.message, messageId: "steer-message" },
            });
            yield* runtime.steerTurn(steering);
            const rejected = yield* Effect.result(
              runtime.steerTurn({
                ...steering,
                message: {
                  ...steering.message,
                  text: steering.message.text.replace("/workspace/", "/other-workspace/"),
                },
              }),
            );
            expect(rejected._tag).toBe("Failure");
          }
        }),
      ),
    );
    expect(commands.map((c) => c.method)).toEqual(
      scenario === "preflight-failure" || scenario === "other-file"
        ? ["openSession", "resumeThread"]
        : scenario === "same-file"
          ? ["openSession", "resumeThread", "startTurn", "steerTurn"]
          : ["openSession", "resumeThread", "startTurn"],
    );
    expect(commands[1]!.input.providerThread.nativeThreadRef.nativeId).toBe(
      "original-native-thread",
    );
    if (scenario !== "preflight-failure" && scenario !== "other-file")
      expect(commands[2]!.input.runId).toBe("run-two");
  },
);
