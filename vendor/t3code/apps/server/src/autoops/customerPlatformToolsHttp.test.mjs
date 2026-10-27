import { expect, it, vi } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { request as httpRequest } from "node:http";
import { createCustomerPlatformToolsBridge } from "../../../../../../agent-demo/customer-agent/platform-tools-bridge.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import {
  fixture as ownerFixture,
  selection,
  dispatch,
} from "../../../../../../test/t3-customer-platform-fixture.mjs";
import { createCustomerTransportJournal } from "../../../../../../agent-demo/t3-adapters/customer-transport.mjs";
import { decodeCustomerAgentClientFrame } from "../../../../packages/contracts/src/autoopsRemote.ts";
import { RemoteDeviceHub, RemoteDeviceService } from "./RemoteDeviceService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

const state = vi.hoisted(() => ({ access: undefined, workspace: undefined, mcp: undefined }));
vi.mock("../../../../../../agent-demo/t3-adapters/access.mjs", async (original) => ({
  ...(await original()),
  configuredAutoOpsAccess: () => state.access,
}));
vi.mock("../../../../../../agent-demo/t3-adapters/workspace-management.ts", async (original) => ({
  ...(await original()),
  configuredWorkspaceManagement: () => state.workspace,
}));
vi.mock(
  "../../../../../../agent-demo/t3-adapters/environment-mcp-runtime.ts",
  async (original) => ({ ...(await original()), configuredEnvironmentMcp: () => state.mcp }),
);
import { layer } from "./customerPlatformToolsHttp.ts";

async function fixture(shared = false) {
  const cleanup = [],
    f = await ownerFixture({ after: (close) => cleanup.push(close) }, { shared }),
    actorId = shared ? "reader" : "provider",
    projectId = shared ? "target-project" : "project",
    principal = f.access.authenticateCookie("demo_session=" + actorId);
  state.access = f.access;
  state.workspace = f.workspace;
  state.mcp = f.mcp;
  const db = new DatabaseSync(":memory:"),
    journal = createCustomerTransportJournal(db),
    hub = new RemoteDeviceHub(f.access, journal);
  cleanup.push(() => db.close());
  cleanup.push(() => hub.close());
  const connection = hub.connect(
    f.machine,
    async () => {},
    () => {},
  );
  const { deviceId, updatedAt, ...capability } = f.registry.getCapabilities("provider", f.target);
  f.registry.updateCapabilities(f.machine, { ...capability, platformToolsVersion: 1 });
  const configuration = f.customerConfiguration({
      workspaceType: "internal",
      environmentId: "test",
      ...(shared ? { customerProfile: f.profile } : {}),
    }),
    preset = f.assistants.saveProvided("provider", null, f.command(configuration));
  if (shared)
    f.assistants.shareProvided("provider", preset.id, projectId, {
      requestId: randomUUID(),
      expectedRevision: 0,
      enabled: true,
    });
  f.assistants.assign("manager", projectId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    target: { kind: "member", id: actorId },
    assistantIds: [preset.id],
    defaultAssistantId: preset.id,
  });
  const threadId = randomUUID(),
    runId = `run:thread:${threadId}:ordinal:1`,
    sessionId = "session:owned",
    runtimeEpoch = "epoch:owned",
    commandId = "command:owned",
    attemptId = "attempt:owned";
  f.access.reserveThread(principal, {
    threadId,
    projectId,
    environmentId: "test",
    agentId: "a-project",
    visibility: "private",
    workspaceType: "internal",
    executionBinding: f.target,
    question: selection(preset),
  });
  f.access.markThreadAccepted(threadId);
  const message = dispatch(threadId, f.modelSelection);
  f.access.recordMessageActor(principal, threadId, message.commandId, message.messageId);
  const executionScope = f.access.prepareCustomerRun(
    threadId,
    runId,
    message.messageId,
    undefined,
    message.modelSelection,
  );
  f.access.prepareCustomerToolRun(
    threadId,
    runId,
    message.messageId,
    undefined,
    message.modelSelection,
  );
  await f.inputs.prepare(
    threadId,
    runId,
    undefined,
    undefined,
    message.messageId,
    undefined,
    message.modelSelection,
  );
  f.mcp.prepareRun({ threadId, runId, actorId, projectId, environmentId: "test" });
  const reference = f.access.completeCustomerToolRun(threadId, runId);
  const target = {
    registeredWorkspaceId: f.target.registeredWorkspaceId,
    workspaceBindingRevision: 1,
    runtimeId: "codex",
  };
  journal.saveSession({
    sessionId,
    deviceId: f.machine.deviceId,
    ownerId: actorId,
    ...(shared ? { providerId: "provider", executionScope } : {}),
    projectId,
    threadId,
    target,
    runtimeEpoch,
  });
  journal.saveCommand({
    type: "command",
    commandId,
    sessionId,
    target,
    method: "startTurn",
    runtimeEpoch,
    platformTools: reference,
    ...(executionScope ? { executionScope } : {}),
    input: { runId, attemptId },
  });
  await connection.accept(
    decodeCustomerAgentClientFrame(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        deviceId: f.machine.deviceId,
        connectorVersion: "fixture-bridge",
        connectorEpoch: "connector:owned",
        platformToolsVersion: 1,
        sharedExecutionVersion: 1,
        workspaces: [{ ...target, projectId: "project", label: "离线目录" }],
        sessions: [{ sessionId, runtimeEpoch, state: "active", live: true }],
      }),
    ),
  );
  // 原生状态端口是可控外部投影；授权、设备、原命令、资料与环境均为真实owner/SQLite。
  const projection = {
    thread: { deletedAt: null },
    runs: [
      {
        id: runId,
        ordinal: 1,
        status: "running",
        activeAttemptId: attemptId,
        providerInstanceId: `customer-${f.machine.deviceId}-codex`,
        modelSelection: f.modelSelection,
      },
    ],
  };
  const app = HttpRouter.toWebHandler(
    layer.pipe(
      Layer.provideMerge(Layer.succeed(RemoteDeviceService, { hub })),
      Layer.provideMerge(
        Layer.succeed(Threads.ThreadManagementService, {
          getThreadProjection: () => Effect.succeed(projection),
        }),
      ),
    ),
    { disableLogger: true },
  );
  cleanup.push(app.dispose);
  const input = {
    reference,
    commandId,
    sessionId,
    runtimeEpoch,
    call: { tool: "query_environment", arguments: {} },
  };
  const request = (body = input, token = f.deviceToken) =>
    app.handler(
      new Request("http://localhost/autoops/customer/connector/platform-tools", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return {
    ...f,
    actorId,
    projectId,
    projection,
    input,
    request,
    async close() {
      for (const close of cleanup.reverse()) await close();
      state.access = state.workspace = state.mcp = undefined;
    },
  };
}

it("同设备原命令与本轮资料通过真实HTTP，协议参数与epoch篡改拒绝", async () => {
  const f = await fixture();
  try {
    expect((await f.request()).status).toBe(200);
    const context = f.access.requireCustomerToolRun(f.input.reference).context;
    const response = await f.request({
      ...f.input,
      call: {
        tool: "read_project_material",
        arguments: { path: `autoops/project/inputs/${context.inputId}/docs/proof.txt` },
      },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).content).toContain("C7_REAL_SQLITE_CURRENT_INPUT");
    expect((await f.request({ ...f.input, actorId: "manager" })).status).toBe(400);
    expect((await f.request({ ...f.input, runtimeEpoch: "other:epoch" })).status).toBe(403);
    expect(
      (await f.request({ ...f.input, call: { tool: "create_report", arguments: {} } })).status,
    ).toBe(400);
    expect((await f.request(f.input, "invalid-device-token")).status).toBe(401);
  } finally {
    await f.close();
  }
});
it("原任务终态与错误context引用均不能继续调用，原上下文保留", async () => {
  const f = await fixture();
  try {
    const before = JSON.stringify(f.access.requireCustomerToolRun(f.input.reference).context);
    f.projection.runs[0].status = "completed";
    expect((await f.request()).status).toBe(403);
    expect(
      (await f.request({ ...f.input, reference: { version: 1, contextId: randomUUID() } })).status,
    ).toBe(403);
    expect(JSON.stringify(f.access.requireCustomerToolRun(f.input.reference).context)).toBe(before);
  } finally {
    await f.close();
  }
});
it("工具正文读取期间撤回环境授权，不返回迟到正文", async () => {
  const f = await fixture();
  try {
    const context = f.access.requireCustomerToolRun(f.input.reference).context;
    let entered, release;
    const pending = new Promise((resolve) => {
        entered = resolve;
      }),
      gate = new Promise((resolve) => {
        release = resolve;
      }),
      read = f.workspace.readInputContent.bind(f.workspace);
    f.workspace.readInputContent = async (...args) => {
      entered();
      await gate;
      return read(...args);
    };
    const response = f.request({
      ...f.input,
      call: {
        tool: "read_project_material",
        arguments: { path: `autoops/project/inputs/${context.inputId}/docs/proof.txt` },
      },
    });
    await pending;
    f.providerMember.environmentIds = [];
    release();
    const denied = await response;
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).not.toContain("C7_REAL_SQLITE_CURRENT_INPUT");
  } finally {
    await f.close();
  }
});

it.each([false, true])(
  "真实UDS原生MCP经设备HTTP读取同轮SQLite原件(shared=%s)，终态后原桥不再获准读取",
  async (shared) => {
    const f = await fixture(shared);
    const bridge = await createCustomerPlatformToolsBridge({
      callTool: async (request) => {
        const response = await f.request(request);
        if (!response.ok) throw new Error("原范围未获准");
        return response.json();
      },
    });
    try {
      const context = f.access.requireCustomerToolRun(f.input.reference).context;
      bridge.activate({
        reference: f.input.reference,
        commandId: f.input.commandId,
        sessionId: f.input.sessionId,
        runtimeEpoch: f.input.runtimeEpoch,
        threadId: context.threadId,
      });
      const wire = (value, session) =>
        new Promise((resolve, reject) => {
          const request = httpRequest(
            {
              socketPath: bridge.socketPath,
              path: "/mcp",
              method: "POST",
              headers: {
                authorization: bridge.authorizationHeader,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                ...(session
                  ? { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" }
                  : {}),
              },
            },
            (response) => {
              let text = "";
              response.setEncoding("utf8");
              response.on("data", (part) => (text += part));
              response.once("end", () =>
                resolve({
                  status: response.statusCode,
                  headers: response.headers,
                  body: text ? JSON.parse(text) : undefined,
                }),
              );
              response.once("error", reject);
            },
          );
          request.once("error", reject);
          request.end(JSON.stringify(value));
        });
      const initialized = await wire({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "real-owner-fixture", version: "1" },
        },
      });
      expect(initialized.status).toBe(200);
      expect(initialized.body.id).toBe(0);
      const session = String(initialized.headers["mcp-session-id"]);
      expect(
        (await wire({ jsonrpc: "2.0", method: "notifications/initialized" }, session)).status,
      ).toBe(202);
      const read = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "read_project_material",
          arguments: { path: `autoops/${f.projectId}/inputs/${context.inputId}/docs/proof.txt` },
        },
      };
      const result = await wire(read, session);
      const marker = shared ? "C7_RECIPIENT_PROJECT_CURRENT_INPUT" : "C7_REAL_SQLITE_CURRENT_INPUT";
      expect(result.body.result.isError ?? false).toBe(false);
      expect(JSON.stringify(result.body)).toContain(marker);
      expect(context.scope.actorId).toBe(f.actorId);
      expect(context.scope.projectId).toBe(f.projectId);
      if (shared) expect(context.scope.grantId).not.toBe(null);
      f.projection.runs[0].status = "completed";
      const denied = await wire({ ...read, id: 2 }, session);
      expect(denied.body.result.isError).toBe(true);
      expect(JSON.stringify(denied.body)).not.toContain(marker);
    } finally {
      await bridge.close();
      await f.close();
    }
  },
);
