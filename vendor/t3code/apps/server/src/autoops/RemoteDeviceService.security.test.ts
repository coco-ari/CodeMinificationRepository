import { describe, expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { RemoteDeviceHub } from "./RemoteDeviceService.ts";
import { createCustomerTransportJournal } from "../../../../../../agent-demo/t3-adapters/customer-transport.mjs";
import * as C from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import { CustomerCodexCapabilities } from "../provider/HeadlessCodexRunner.ts";
import { validateCustomerEvent, validateCustomerResult } from "./CustomerEventValidation.ts";
import type { TransportSession } from "../../../../../../agent-demo/t3-adapters/customer-transport.mjs";

const now = "2026-10-22T00:00:00.000Z";
function fixture(threadId = "thread-one") {
  const instanceId = "customer-fixture-codex";
  const prefix = `customer:${instanceId}:${threadId}:`;
  const driver = C.ProviderDriverKind.make("codex");
  const ids = {
    thread: derive.providerThread({
      driver,
      providerInstanceId: C.ProviderInstanceId.make(instanceId),
      nativeThreadId: `${prefix}native-thread`,
    }),
    turn: derive.providerTurn({ driver, nativeTurnId: `${prefix}native-turn` }),
    node: derive.nodeFromProviderItem({ driver, nativeItemId: `${prefix}native-item` }),
    item: derive.turnItemFromProviderItem({ driver, nativeItemId: `${prefix}native-item` }),
    message: derive.messageFromProviderItem({ driver, nativeItemId: `${prefix}native-item` }),
    request: C.RuntimeRequestId.make(
      `runtime-request:provider:codex:provider-turn:${encodeURIComponent(derive.providerTurn({ driver, nativeTurnId: `${prefix}native-turn` }))}:native-request:${encodeURIComponent(`${prefix}native-request`)}:fixture-uuid`,
    ),
  };
  const session: TransportSession = {
    sessionId: `session-${threadId}`,
    deviceId: "fixture",
    threadId,
    ownerId: "owner",
    projectId: "project",
    target: { registeredWorkspaceId: "workspace", workspaceBindingRevision: 1, runtimeId: "codex" },
    providerThreadId: ids.thread,
    runs: [
      {
        runId: "run-one",
        attemptId: "attempt-one",
        rootNodeId: "root-one",
        runOrdinal: 1,
        providerTurnOrdinal: 1,
      },
      {
        runId: "run-two",
        attemptId: "attempt-two",
        rootNodeId: "root-two",
        runOrdinal: 2,
        providerTurnOrdinal: 2,
      },
    ],
  };
  const providerSession = {
    id: session.sessionId,
    driver,
    providerInstanceId: instanceId,
    status: "ready",
    cwd: "/local/path",
    model: "model",
    capabilities: CustomerCodexCapabilities,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  const thread = {
    id: ids.thread,
    driver,
    providerInstanceId: instanceId,
    providerSessionId: session.sessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, strength: "strong", nativeId: "native-thread" },
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const turn = {
    id: ids.turn,
    providerThreadId: ids.thread,
    nodeId: "root-one",
    runAttemptId: "attempt-one",
    nativeTurnRef: { driver, strength: "strong", nativeId: "native-turn" },
    ordinal: 1,
    status: "running",
    startedAt: now,
    completedAt: null,
  };
  const node = {
    id: ids.node,
    threadId,
    runId: "run-one",
    parentNodeId: "root-one",
    rootNodeId: "root-one",
    kind: "tool_call",
    status: "running",
    countsForRun: true,
    providerThreadId: ids.thread,
    providerTurnId: ids.turn,
    nativeItemRef: { driver, strength: "strong", nativeId: "native-item" },
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
  const message = {
    id: ids.message,
    threadId,
    runId: "run-one",
    nodeId: ids.node,
    role: "assistant",
    createdBy: "agent",
    creationSource: "provider",
    text: "hello",
    attachments: [],
    streaming: true,
    createdAt: now,
    updatedAt: now,
  };
  const item = {
    id: ids.item,
    threadId,
    runId: "run-one",
    nodeId: ids.node,
    providerThreadId: ids.thread,
    providerTurnId: ids.turn,
    nativeItemRef: { driver, strength: "strong", nativeId: "native-item" },
    parentItemId: null,
    ordinal: 1,
    status: "running",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "assistant_message",
    messageId: ids.message,
    text: "hello",
    streaming: true,
  };
  const request = {
    id: ids.request,
    nodeId: ids.node,
    providerTurnId: ids.turn,
    nativeRequestRef: { driver, strength: "strong", nativeId: "native-request" },
    kind: "command",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: session.sessionId },
    createdAt: now,
    resolvedAt: null,
  };
  const event = (type: string, key: string, value: unknown) => ({ type, driver, [key]: value });
  const admit = () => {
    validateCustomerEvent(session, event("provider_turn.updated", "providerTurn", turn));
    validateCustomerEvent(session, event("node.updated", "node", node));
  };
  return {
    session,
    ids,
    providerSession,
    thread,
    turn,
    node,
    message,
    item,
    request,
    event,
    admit,
  };
}
function expectScopeFailure(fn: () => unknown) {
  expect(fn).toThrowError(expect.objectContaining({ code: "CUSTOMER_EVENT_SCOPE" }));
}
describe("customer canonical admission", () => {
  it("accepts native scoped entities and binds approval replies to this provider session", () => {
    const f = fixture();
    f.admit();
    for (const [type, key, row] of [
      ["provider_session.updated", "providerSession", f.providerSession],
      ["provider_thread.updated", "providerThread", f.thread],
      ["message.updated", "message", f.message],
      ["turn_item.updated", "turnItem", f.item],
      ["runtime_request.updated", "runtimeRequest", f.request],
    ] as const) {
      expect(() => validateCustomerEvent(f.session, f.event(type, key, row))).not.toThrow();
    }
    const requestId = f.ids.request;
    const approvalNode = {
      ...f.node,
      id: derive.approvalNode({ requestId }),
      kind: "approval_request",
      runtimeRequestId: requestId,
    };
    expect(() =>
      validateCustomerEvent(f.session, f.event("node.updated", "node", approvalNode)),
    ).not.toThrow();
    const approvalItem = {
      ...f.item,
      id: derive.approvalTurnItem({ requestId }),
      nodeId: approvalNode.id,
      type: "approval_request",
      requestId,
      requestKind: "command",
    };
    expect(() =>
      validateCustomerEvent(f.session, f.event("turn_item.updated", "turnItem", approvalItem)),
    ).not.toThrow();
    expect(() =>
      validateCustomerEvent(f.session, {
        type: "turn.terminal",
        driver: "codex",
        providerThreadId: f.ids.thread,
        providerTurnId: f.ids.turn,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      }),
    ).not.toThrow();
  });
  it("accepts only the exact provider-thread placeholder already bound by the center", () => {
    const f=fixture();
    const trusted="provider-thread:provider:codex:native-thread:pending%3Arun%3Athread%3Athread-one";
    f.session.providerThreadId=trusted;
    expect(()=>validateCustomerEvent(f.session,f.event("provider_turn.updated","providerTurn",{...f.turn,providerThreadId:trusted}))).not.toThrow();
    expect(()=>validateCustomerResult(f.session,"ensureThread",{...f.thread,id:trusted})).not.toThrow();
    for (const providerThreadId of [`${trusted}-other`,"provider-thread:provider:codex:native-thread:pending%3Aforeign-run"]) {
      expectScopeFailure(()=>validateCustomerEvent(f.session,f.event("provider_turn.updated","providerTurn",{...f.turn,providerThreadId})));
    }
    expectScopeFailure(()=>validateCustomerResult(f.session,"ensureThread",{...f.thread,id:trusted,appThreadId:"foreign-thread"}));
  });
  it("rejects a live approval response capability targeting a different provider session", () => {
    const f = fixture();
    f.admit();
    expectScopeFailure(() =>
      validateCustomerEvent(
        f.session,
        f.event("runtime_request.updated", "runtimeRequest", {
          ...f.request,
          responseCapability: { type: "live", providerSessionId: "another-session" },
        }),
      ),
    );
  });
  it.each(["id", "nodeId", "providerTurnId"])(
    "rejects a runtime request with foreign %s",
    (key) => {
      const f = fixture();
      const other = fixture("thread-two");
      f.admit();
      expectScopeFailure(() =>
        validateCustomerEvent(
          f.session,
          f.event("runtime_request.updated", "runtimeRequest", {
            ...f.request,
            [key]: other.request[key as keyof typeof other.request],
          }),
        ),
      );
    },
  );
  it.each(["providerThreadId", "providerTurnId", "messageId", "parentItemId", "nodeId"])(
    "rejects foreign nested turn-item %s",
    (key) => {
      const f = fixture();
      const other = fixture("thread-two");
      f.admit();
      const reference =
        key === "parentItemId" ? other.ids.item : other.item[key as keyof typeof other.item];
      expectScopeFailure(() =>
        validateCustomerEvent(
          f.session,
          f.event("turn_item.updated", "turnItem", { ...f.item, [key]: reference }),
        ),
      );
    },
  );
  it("rejects a forged native namespace substring and a suffix after a scoped ID", () => {
    const f = fixture();
    f.admit();
    for (const id of [
      `turn-item:evil:${encodeURIComponent(`customer:customer-fixture-codex:${f.session.threadId}:`)}`,
      `${f.item.id}:unexpected`,
      f.item.id.replace(
        "customer%3Acustomer-fixture-codex",
        "pretend-customer%3Acustomer-fixture-codex",
      ),
    ]) {
      expectScopeFailure(() =>
        validateCustomerEvent(
          f.session,
          f.event("turn_item.updated", "turnItem", { ...f.item, id }),
        ),
      );
    }
  });
  it("rejects movement of a provider turn to a different admitted center attempt", () => {
    const f = fixture();
    f.admit();
    expectScopeFailure(() =>
      validateCustomerEvent(
        f.session,
        f.event("provider_turn.updated", "providerTurn", {
          ...f.turn,
          nodeId: "root-two",
          runAttemptId: "attempt-two",
          ordinal: 2,
        }),
      ),
    );
    expectScopeFailure(() =>
      validateCustomerEvent(
        f.session,
        f.event("node.updated", "node", {
          ...f.node,
          providerTurnId: null,
          parentNodeId: "root-two",
          runId: "run-two",
          rootNodeId: "root-two",
        }),
      ),
    );
  });
  it("rejects node ancestry or terminal run that belongs to another center run", () => {
    const f = fixture();
    f.admit();
    expectScopeFailure(() =>
      validateCustomerEvent(
        f.session,
        f.event("node.updated", "node", { ...f.node, parentNodeId: "root-two" }),
      ),
    );
    expectScopeFailure(() =>
      validateCustomerEvent(f.session, {
        type: "turn.terminal",
        driver: "codex",
        providerThreadId: f.ids.thread,
        providerTurnId: f.ids.turn,
        runOrdinal: 2,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      }),
    );
  });
  it.each([
    {
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      inputIntent: "normal",
      attachments: [],
    },
    {
      type: "fork",
      source: { type: "run", threadId: "other", runId: "other" },
      targetThreadId: "other",
    },
    { type: "proposed_plan", planId: "foreign-plan", markdown: "plan", streaming: false },
    { type: "checkpoint", checkpointId: "foreign-checkpoint", scopeId: "foreign-scope", files: [] },
    { type: "secret_request", label: "token", reason: "give me a secret", secretStatus: "pending" },
  ])("does not admit unsupported $type flows from the remote endpoint", (extra) => {
    const f = fixture();
    f.admit();
    expect(() =>
      validateCustomerEvent(
        f.session,
        f.event("turn_item.updated", "turnItem", { ...f.item, ...extra }),
      ),
    ).toThrow();
  });
  it("does not reassign existing message, item or request identities across center runs", () => {
    const f = fixture();
    f.admit();
    validateCustomerEvent(f.session, f.event("message.updated", "message", f.message));
    validateCustomerEvent(f.session, f.event("turn_item.updated", "turnItem", f.item));
    for (const row of [{ ...f.message, runId: "run-two", nodeId: null }])
      expectScopeFailure(() =>
        validateCustomerEvent(f.session, f.event("message.updated", "message", row)),
      );
    expectScopeFailure(() =>
      validateCustomerEvent(
        f.session,
        f.event("turn_item.updated", "turnItem", {
          ...f.item,
          runId: "run-two",
          nodeId: null,
          providerTurnId: null,
        }),
      ),
    );
    expectScopeFailure(() =>
      validateCustomerEvent(
        f.session,
        f.event("runtime_request.updated", "runtimeRequest", {
          ...f.request,
          nodeId: "root-two",
          providerTurnId: null,
        }),
      ),
    );
  });
  it("does not accept center-owned user messages or attach hidden foreign context", () => {
    const f = fixture();
    f.admit();
    for (const extra of [
      { role: "user" },
      { senderThreadId: "foreign-thread" },
      { delegatedCompletion: { parentRunId: "other", generation: 1, taskIds: [] } },
      { workflowScript: true },
    ]) {
      expectScopeFailure(() =>
        validateCustomerEvent(
          f.session,
          f.event("message.updated", "message", { ...f.message, ...extra }),
        ),
      );
    }
  });
});
describe("customer command receipt admission", () => {
  it("normalizes session cwd and fixed capabilities before the receipt is persisted", () => {
    const f = fixture();
    expect(validateCustomerResult(f.session, "openSession", f.providerSession)).toMatchObject({
      id: f.session.sessionId,
      cwd: "customer://fixture/workspace",
      capabilities: CustomerCodexCapabilities,
    });
    expectScopeFailure(() =>
      validateCustomerResult(f.session, "openSession", {
        ...f.providerSession,
        id: "foreign-session",
      }),
    );
    expectScopeFailure(() =>
      validateCustomerResult(f.session, "openSession", {
        ...f.providerSession,
        providerInstanceId: "codex",
      }),
    );
  });
  it.each(["ensureThread", "resumeThread"])(
    "validates %s identity before a returned thread can become authoritative",
    (method) => {
      const f = fixture();
      const other = fixture("other");
      expect(() => validateCustomerResult(f.session, method, f.thread)).not.toThrow();
      for (const extra of [
        { id: other.ids.thread },
        { appThreadId: "other" },
        { providerSessionId: "other" },
        { providerInstanceId: "codex" },
        { forkedFrom: { providerThreadId: other.ids.thread } },
        { ownerNodeId: "other" },
      ]) {
        expectScopeFailure(() =>
          validateCustomerResult(f.session, method, { ...f.thread, ...extra }),
        );
      }
    },
  );
  it("rejects model selections for another provider hidden in native metadata", () => {
    const f = fixture();
    expectScopeFailure(() =>
      validateCustomerResult(f.session, "ensureThread", {
        ...f.thread,
        nativeMetadata: { modelSelection: { instanceId: "other", model: "model" } },
      }),
    );
  });
  it("limits snapshots to this binding and strips unused opaque native payload", () => {
    const f = fixture();
    f.admit();
    const snapshot = {
      providerThread: f.thread,
      providerTurns: [f.turn],
      messages: [f.message],
      runtimeRequests: [f.request],
      providerPayload: { otherThread: { secret: "not admitted" } },
    };
    expect(validateCustomerResult(f.session, "readThreadSnapshot", snapshot)).not.toHaveProperty(
      "providerPayload",
    );
    expectScopeFailure(() =>
      validateCustomerResult(f.session, "readThreadSnapshot", {
        ...snapshot,
        providerThread: fixture("other").thread,
      }),
    );
    expectScopeFailure(() =>
      validateCustomerResult(f.session, "readThreadSnapshot", {
        ...snapshot,
        messages: [{ ...f.message, threadId: "other" }],
      }),
    );
    expectScopeFailure(() =>
      validateCustomerResult(f.session, "readThreadSnapshot", {
        ...snapshot,
        runtimeRequests: [
          { ...f.request, responseCapability: { type: "live", providerSessionId: "other" } },
        ],
      }),
    );
  });
  it("rejects unrecognized result-bearing control methods", () => {
    const f = fixture();
    expect(validateCustomerResult(f.session, "startTurn", null)).toBeNull();
    expectScopeFailure(() =>
      validateCustomerResult(f.session, "startTurn", { providerThread: f.thread }),
    );
    expectScopeFailure(() => validateCustomerResult(f.session, "forkThread", f.thread));
  });
});

describe("customer receipt boundary before durable storage", () => {
  it("durably queues an exact native interrupt without an in-memory runtime or network", () => {
    const f = fixture();
    f.admit();
    const db = new DatabaseSync(":memory:");
    const journal = createCustomerTransportJournal(db);
    const hub = new RemoteDeviceHub(
      { customerRegistry: { resetPresence: () => {} } } as never,
      journal,
    );
    try {
      journal.saveSession({ ...f.session, runtimeEpoch: "live-epoch", state: "active" });
      const id = hub.enqueueInterrupt(f.session.sessionId, f.thread, f.ids.turn);
      expect(journal.command(id)?.command).toMatchObject({
        method: "interruptTurn",
        runtimeEpoch: "live-epoch",
        input: { providerThread: { id: f.ids.thread }, providerTurnId: f.ids.turn },
      });
      expect(journal.command(id)?.receipt).toBeUndefined();
      expect(journal.session(f.session.sessionId)?.state).toBe("active");
      expect(
        hub.enqueueInterrupt(
          f.session.sessionId,
          { ...f.thread, updatedAt: "2026-10-23T00:00:00Z" },
          f.ids.turn,
        ),
      ).toBe(id);
      expect(() =>
        hub.enqueueInterrupt(f.session.sessionId, fixture("foreign").thread, f.ids.turn),
      ).toThrow();
      expect(() =>
        hub.enqueueInterrupt(f.session.sessionId, f.thread, fixture("foreign").ids.turn),
      ).toThrow();
    } finally {
      hub.close();
      db.close();
    }
  });
  it("rejects a foreign completed session receipt without poisoning the journal", async () => {
    const f = fixture();
    const db = new DatabaseSync(":memory:");
    const journal = createCustomerTransportJournal(db);
    const hub = new RemoteDeviceHub(
      {
        customerRegistry: {
          resetPresence: () => {},
          markConnected: () => ({ connectionEpoch: 1 }),
          markHeartbeat: () => {},
          markDisconnected: () => {},
          listWorkspaces: () => [],
        },
      } as never,
      journal,
    );
    const connection = hub.connect(
      { deviceId: f.session.deviceId, ownerId: f.session.ownerId } as never,
      async () => {},
      () => {},
    );
    try {
      journal.saveSession(f.session);
      journal.saveCommand({
        type: "command",
        commandId: "open-command",
        sessionId: f.session.sessionId,
        target: f.session.target,
        method: "openSession",
        input: {},
      });
      await connection.accept({
        type: "hello",
        protocolVersion: 1,
        deviceId: f.session.deviceId,
        connectorVersion: "test",
        connectorEpoch: "connector-epoch",
        workspaces: [],
        sessions: [],
      });
      const receipt = {
        type: "receipt" as const,
        commandId: "open-command",
        sessionId: f.session.sessionId,
        state: "completed" as const,
        runtimeEpoch: "runtime-epoch",
        result: { ...f.providerSession, id: "foreign-session" },
      };
      await expect(connection.accept(receipt)).rejects.toMatchObject({
        code: "CUSTOMER_EVENT_SCOPE",
      });
      expect(journal.command("open-command")?.receipt).toBeUndefined();
      expect(journal.session(f.session.sessionId)?.providerSession).toBeUndefined();
      expect(journal.session(f.session.sessionId)?.runtimeEpoch).toBeUndefined();
      await connection.accept({ ...receipt, result: f.providerSession });
      expect(journal.command("open-command")?.receipt).toMatchObject({
        state: "completed",
        result: { id: f.session.sessionId, cwd: "customer://fixture/workspace" },
      });
      // A late duplicate may arrive after a new process has already taken over.
      journal.saveSession({
        ...journal.session(f.session.sessionId)!,
        runtimeEpoch: "new-runtime",
      });
      await connection.accept({ ...receipt, state: "accepted" });
      await connection.accept({ ...receipt, result: f.providerSession });
      expect(journal.session(f.session.sessionId)?.runtimeEpoch).toBe("new-runtime");
      journal.saveCommand({
        type: "command",
        commandId: "start-command",
        sessionId: f.session.sessionId,
        target: f.session.target,
        method: "startTurn",
        runtimeEpoch: "new-runtime",
        input: {},
      });
      await expect(
        connection.accept({
          type: "receipt",
          commandId: "start-command",
          sessionId: f.session.sessionId,
          state: "completed",
          result: null,
        }),
      ).rejects.toMatchObject({ code: "RUNTIME_EPOCH" });
      expect(journal.command("start-command")?.receipt).toBeUndefined();
    } finally {
      connection.disconnect();
      hub.close();
      db.close();
    }
  });
});
