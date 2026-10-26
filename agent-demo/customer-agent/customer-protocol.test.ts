import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWS } from "../../vendor/t3code/apps/server/node_modules/@effect/platform-node-shared/dist/NodeSocket.js";
import { decodeCustomerAgentServerFrame, type CustomerAgentReceipt } from "../../vendor/t3code/packages/contracts/src/autoopsRemote.ts";
import type { SharedExecutionScope } from "../../autoops/contracts/shared-execution.ts";
import { CustomerAgentConnection } from "./connection.ts";
import { CustomerAgentStore } from "./store.ts";

function sharedCommand() {
  const scope: SharedExecutionScope = {
    grantId: `shared-${"a".repeat(64)}`,
    actorId: "recipient",
    providerId: "provider",
    projectId: "recipient-project",
    sourceProjectId: "provider-project",
    threadId: "recipient-thread",
    runId: "recipient-run",
    assistantId: "shared-assistant",
    presetRevision: 2,
    shareRevision: 3,
    allocation: { kind: "member", id: "recipient", revision: 4 },
    capabilityRevision: "b".repeat(64),
    profile: {
      id: "readonly-profile",
      revision: 5,
      digest: "c".repeat(64),
      imageDigest: `sha256:${"d".repeat(64)}`,
      policy: "linux-docker-readonly-v1",
    },
    target: {
      kind: "customer",
      deviceId: "provider-device",
      registeredWorkspaceId: "provider-workspace",
      workspaceBindingRevision: 6,
      runtimeId: "codex",
    },
    model: {
      instanceId: "provider-instance",
      model: "actual-runner-model",
      reasoningEffort: "medium",
    },
    skillIds: ["curated-proof"],
  };
  return {
    type: "command" as const,
    commandId: "original-open-command",
    sessionId: "recipient-session",
    target: {
      registeredWorkspaceId: scope.target.registeredWorkspaceId,
      workspaceBindingRevision: scope.target.workspaceBindingRevision,
      runtimeId: "codex" as const,
    },
    method: "openSession" as const,
    input: { model: scope.model, originalInput: "保留原调用参数" },
    executionScope: scope,
  };
}

test("正式客户传输接受合法跨项目共享范围并保留实际调用者与固定来源", () => {
  const original = sharedCommand();
  const decoded = decodeCustomerAgentServerFrame(JSON.stringify(original));
  assert.deepEqual(decoded, original);
  assert.notEqual(original.executionScope.actorId, original.executionScope.providerId);
  assert.notEqual(original.executionScope.projectId, original.executionScope.sourceProjectId);
});

test("既有自用命令继续接受不含共享范围的原传输合同", () => {
  const { executionScope: _scope, ...original } = sharedCommand();
  assert.deepEqual(decodeCustomerAgentServerFrame(JSON.stringify(original)), original);
});

test("共享传输继续拒绝缺失或篡改的隔离字段及运行能力", () => {
  const invalidChanges: Array<(scope: SharedExecutionScope) => void> = [
    (scope) => { Reflect.deleteProperty(scope, "grantId"); },
    (scope) => { Reflect.set(scope, "grantId", ""); },
    (scope) => { Reflect.set(scope, "actorId", "recipient\nprovider"); },
    (scope) => { Reflect.deleteProperty(scope, "sourceProjectId"); },
    (scope) => { Reflect.set(scope.allocation, "revision", 0); },
    (scope) => { Reflect.set(scope.profile, "digest", "unverified"); },
    (scope) => { Reflect.set(scope.target, "workspaceBindingRevision", 0); },
    (scope) => { Reflect.set(scope.model, "reasoningEffort", "automatic"); },
    (scope) => { Reflect.set(scope, "skillIds", ["../outside"]); },
    (scope) => { Reflect.set(scope, "platformAdmin", true); },
    (scope) => { Reflect.set(scope.profile, "unverifiedApproval", true); },
  ];
  for (const change of invalidChanges) {
    const original = sharedCommand();
    change(original.executionScope);
    assert.throws(() => decodeCustomerAgentServerFrame(JSON.stringify(original)));
  }
});

test("真实WS共享命令到达本机准入，缺失隔离profile仍明确拒绝且不退回自用执行", { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "autoops-shared-wire-"));
  mkdirSync(join(directory, "source"));
  const store = new CustomerAgentStore(join(directory, "state"));
  const workspace = store.register(join(directory, "source"), "provider-project", "提供者目录");
  store.markPublished(workspace.registeredWorkspaceId);
  const original = sharedCommand();
  const target = {
    ...original.target,
    registeredWorkspaceId: workspace.registeredWorkspaceId,
    workspaceBindingRevision: workspace.workspaceBindingRevision,
  };
  const command = {
    ...original,
    target,
    executionScope: { ...original.executionScope, target: { ...original.executionScope.target, ...target } },
  };
  const server = createServer();
  const sockets = new NodeWS.WebSocketServer({ server });
  let received!: (receipt: CustomerAgentReceipt) => void;
  const originalReceipt = new Promise<CustomerAgentReceipt>((resolve) => { received = resolve; });
  sockets.on("connection", (socket: InstanceType<typeof NodeWS.WebSocket>) => {
    socket.on("message", (bytes: unknown) => {
      const frame = JSON.parse(String(bytes));
      if (frame.type === "hello") {
        socket.send(JSON.stringify({ type: "welcome", connectionEpoch: "fixture-epoch" }));
        socket.send(JSON.stringify(command));
      } else if (frame.type === "receipt") received(frame);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let runnerStarts = 0;
  const states: string[] = [];
  const connection = new CustomerAgentConnection({
    store,
    credentials: {
      deviceId: "provider-device",
      token: "isolated-fixture-token",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    },
    runnerFactory: async () => { runnerStarts++; throw new Error("缺少隔离profile不得启动运行器"); },
    onState: (message) => states.push(message),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    connection.start();
    const receipt = await Promise.race([
      originalReceipt,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("原共享命令未返回准入结果")), 3000); }),
    ]);
    assert.equal(receipt.commandId, command.commandId);
    assert.equal(receipt.sessionId, command.sessionId);
    assert.equal(receipt.grantId, command.executionScope.grantId);
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.error?.code, "shared_profile_required");
    assert.equal(runnerStarts, 0);
    assert.equal(store.sessions().length, 0);
    assert(!states.includes("收到无效中心消息，连接将重新核对"));
  } finally {
    clearTimeout(timer);
    await connection.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
