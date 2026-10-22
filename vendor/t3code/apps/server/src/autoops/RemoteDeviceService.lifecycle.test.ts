import { expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { RemoteDeviceHub } from "./RemoteDeviceService.ts";
import { CustomerCodexCapabilities } from "../provider/HeadlessCodexRunner.ts";
import {
  createCustomerTransportJournal,
  customerCommandId,
  type TransportSession,
} from "../../../../../../agent-demo/t3-adapters/customer-transport.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const journal = createCustomerTransportJournal(db);
  const validation: unknown[] = [];
  const hub = new RemoteDeviceHub(
    {
      customerRegistry: {
        resetPresence() {},
        markConnected: () => ({ connectionEpoch: 1 }),
        markHeartbeat() {},
        markDisconnected() {},
        listWorkspaces: () => [],
        validateTarget(_owner: unknown, _project: unknown, _target: unknown, options: unknown) {
          validation.push(options);
        },
      },
    } as never,
    journal,
  );
  const session = {
    sessionId: "session",
    deviceId: "fixture",
    ownerId: "owner",
    projectId: "project",
    threadId: "thread",
    runtimeEpoch: "old-epoch",
    state: "idle" as const,
    target: {
      registeredWorkspaceId: "workspace",
      workspaceBindingRevision: 1,
      runtimeId: "codex" as const,
    },
  };
  journal.saveSession(session);
  const connection = hub.connect(
    { deviceId: session.deviceId, ownerId: session.ownerId } as never,
    async () => {},
    () => {},
  );
  const hello = (lastSeq?: number, resolution?: TransportSession["resolution"]) =>
    connection.accept({
      type: "hello",
      protocolVersion: 1,
      deviceId: session.deviceId,
      connectorVersion: "test",
      connectorEpoch: "new-connector",
      workspaces: [],
      sessions: [
        {
          sessionId: session.sessionId,
          runtimeEpoch: session.runtimeEpoch,
          state: "idle",
          live: false,
          ...(lastSeq === undefined ? {} : { lastSeq }),
          ...(resolution === undefined ? {} : { resolution }),
        },
      ],
    });
  return {
    db,
    journal,
    hub,
    session,
    connection,
    hello,
    validation,
    close() {
      connection.disconnect();
      hub.close();
      db.close();
    },
  };
}

it("does not reopen an already applied operator resolution on a later idle reconnect", async () => {
  const f = fixture();
  const resolution = {
    runId: "old-run",
    attemptId: "old-attempt",
    resolvedAt: "2026-10-23T00:00:00Z",
    reason: "operator_confirmed_process_stopped" as const,
  };
  try {
    f.journal.saveSession({ ...f.session, resolution, appliedResolution: resolution });
    await f.hello(0, resolution);
    expect(f.hub.session(f.session.sessionId)?.state).toBe("idle");
  } finally {
    f.close();
  }
  const fresh = fixture();
  try {
    fresh.journal.saveSession({ ...fresh.session, resolution, appliedResolution: resolution });
    await fresh.hello(0, {
      ...resolution,
      runId: "new-run",
      attemptId: "new-attempt",
      resolvedAt: "2026-10-23T01:00:00Z",
    });
    expect(fresh.hub.session(fresh.session.sessionId)?.state).toBe("unknown");
    expect(fresh.hub.session(fresh.session.sessionId)?.resolution?.runId).toBe("new-run");
  } finally {
    fresh.close();
  }
});

it("waits for durable application of the full old epoch before permitting a fresh process", async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    await f.hello(1);
    let drained = false;
    const drain = f.hub.awaitInboxDrained(f.session.sessionId, controller.signal).then(() => {
      drained = true;
    });
    await f.connection.accept({
      type: "events",
      sessionId: f.session.sessionId,
      runtimeEpoch: f.session.runtimeEpoch,
      events: [
        {
          seq: 1,
          event: {
            type: "provider_session.updated",
            driver: "codex",
            providerSession: {
              id: f.session.sessionId,
              driver: "codex",
              providerInstanceId: "customer-fixture-codex",
              status: "ready",
              cwd: "/customer/path",
              model: "model",
              capabilities: CustomerCodexCapabilities,
              createdAt: "2026-10-23T00:00:00.000Z",
              updatedAt: "2026-10-23T00:00:00.000Z",
              lastError: null,
            },
          },
        },
      ],
    });
    expect(drained).toBe(false);
    const stream = f.hub.events(f.session.sessionId, controller.signal);
    const delivery = await stream.next();
    expect(f.journal.cursor(f.session.sessionId, f.session.runtimeEpoch)).toMatchObject({
      received: 1,
      applied: 0,
    });
    expect(drained).toBe(false);
    await f.hub.acknowledge(delivery.value!);
    await drain;
    expect(drained).toBe(true);
    controller.abort();
    await stream.return(undefined);
  } finally {
    controller.abort();
    f.close();
  }
});

it("does not interpret a missing customer outbox tail as an empty old epoch", async () => {
  const f = fixture();
  try {
    await f.hello();
    await expect(f.hub.awaitInboxDrained(f.session.sessionId)).rejects.toMatchObject({
      code: "CONNECTOR_UPDATE_REQUIRED",
    });
  } finally {
    f.close();
  }
});

it("journals an authorized approval response while the customer is disconnected", async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    await f.hello(0);
    f.connection.disconnect();
    const key = ["request", "accept"];
    const waiting = f.hub.command(
      f.session.sessionId,
      "respondToRuntimeRequest",
      { requestId: "request", decision: "accept" },
      key,
      controller.signal,
    );
    expect(f.validation).toEqual([{ requireOnline: false }]);
    expect(
      f.journal.command(customerCommandId(f.session.sessionId, "respondToRuntimeRequest", key))
        ?.command,
    ).toMatchObject({ runtimeEpoch: "old-epoch", method: "respondToRuntimeRequest" });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "WAIT_CANCELLED" });
  } finally {
    controller.abort();
    f.close();
  }
});
