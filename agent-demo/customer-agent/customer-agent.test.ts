import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomerAgentStore } from "./store.ts";
import { CustomerAgentExecutor, customerSkillId, type RunnerFactory } from "./executor.ts";
import { validateBaseUrl } from "./connection.ts";
import { decodeCustomerAgentServerFrame, type CustomerAgentCommand } from "../../vendor/t3code/packages/contracts/src/autoopsRemote.ts";

function fixture(options: ConstructorParameters<typeof CustomerAgentStore>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), "autoops-customer-test-"));
  const directory = join(root, "project"); mkdirSync(directory);
  const store = new CustomerAgentStore(join(root, "state"), options);
  const workspace = store.register(directory, "project-a", "测试项目");
  return { root, directory, store, workspace, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function command(target: CustomerAgentCommand["target"], method: CustomerAgentCommand["method"], id: string,
  input: unknown = {}, sessionId = "session-a", epoch?: string): CustomerAgentCommand {
  return { type: "command", commandId: id, sessionId, target, method, input, ...(epoch ? { runtimeEpoch: epoch } : {}) };
}
function runnerHarness(f: ReturnType<typeof fixture>, behavior?: (method: string) => void) {
  let calls: string[] = []; let emit: (event: unknown) => void | Promise<void> = () => {};
  const factory: RunnerFactory = async (options) => {
    emit = options.onEvent;
    return { processGeneration: "epoch-a", catalog: async () => ({ models: [], skills: [] }), close: async () => {},
      dispatch: async (method, input: any) => {
        calls.push(method); behavior?.(method);
        if (method === "startTurn") await emit({ type: "provider_turn.updated", providerTurn: { id: "turn-a", runAttemptId: input.attemptId, nativeTurnRef: { nativeId: "native-turn-a" } } });
        return null;
      } };
  };
  const executor = new CustomerAgentExecutor({ store: f.store, deviceId: "device-a", runnerFactory: factory, notify: () => {} });
  return { executor, calls, emit: (event: unknown) => emit(event) };
}

test("目录登记拒绝同目录、符号链接别名及父子重叠", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.directory, "child"));
    symlinkSync(f.directory, join(f.root, "alias"), process.platform === "win32" ? "junction" : "dir");
    for (const path of [f.directory, join(f.directory, "child"), f.root, join(f.root, "alias")]) {
      assert.throws(() => f.store.register(path, "project-b", "重复"), /已经登记/);
    }
  } finally { f.close(); }
});
test("替换为同路径的新目录不会使旧绑定自动指向它", () => {
  const f = fixture();
  try { renameSync(f.directory, `${f.directory}-old`); mkdirSync(f.directory); assert.throws(() => f.store.resolveWorkspace(f.workspace), /移动或被替换/); }
  finally { f.close(); }
});
test("开始回执丢失后的重复命令不会再次进入运行器", async () => {
  const f = fixture(), h = runnerHarness(f);
  try {
    await h.executor.execute(command(f.workspace, "openSession", "open"));
    const start = command(f.workspace, "startTurn", "start", { runId: "run-a", attemptId: "attempt-a" });
    assert.equal((await h.executor.execute(start)).state, "completed");
    assert.equal((await h.executor.execute(start)).state, "completed");
    assert.equal(h.calls.filter((method) => method === "startTurn").length, 1);
    assert.equal((await h.executor.execute({ ...start, input: { runId: "run-b" } })).error?.code, "command_id_conflict");
  } finally { await h.executor.close(); f.close(); }
});
test("两个对话争用一个工作区时本机拒绝第二次原生开始", async () => {
  const f = fixture(), h = runnerHarness(f);
  try {
    await h.executor.execute(command(f.workspace, "openSession", "open-a"));
    await h.executor.execute(command(f.workspace, "openSession", "open-b", {}, "session-b"));
    await h.executor.execute(command(f.workspace, "startTurn", "start-a", { runId: "run-a", attemptId: "attempt-a" }));
    const result = await h.executor.execute(command(f.workspace, "startTurn", "start-b", { runId: "run-b", attemptId: "attempt-b" }, "session-b"));
    assert.equal(result.error?.code, "workspace_busy");
    assert.equal(h.calls.filter((method) => method === "startTurn").length, 1);
  } finally { await h.executor.close(); f.close(); }
});
test("原生开始结果不明会保留目录占用且重启不重发", async () => {
  const f = fixture(), h = runnerHarness(f, (method) => { if (method === "startTurn") throw new Error("simulated lost native acknowledgement"); });
  try {
    await h.executor.execute(command(f.workspace, "openSession", "open"));
    const start = command(f.workspace, "startTurn", "start", { runId: "run-a", attemptId: "attempt-a" });
    assert.equal((await h.executor.execute(start)).state, "unknown");
    f.store.recoverAfterRestart();
    assert.equal((await h.executor.execute(start)).state, "unknown");
    assert.equal(f.store.session("session-a")?.state, "unknown");
    assert.throws(() => f.store.acquireWorkspace(f.workspace.registeredWorkspaceId, "session-b", "run-b"), /仍有运行/);
    assert.equal(h.calls.filter((method) => method === "startTurn").length, 1);
  } finally { await h.executor.close(); f.close(); }
});
test("明确执行前校验失败可释放占用而不标记未知", async () => {
  const f = fixture(), h = runnerHarness(f, (method) => { if (method === "startTurn") throw Object.assign(new Error("model removed"), { outcome: "not_started" }); });
  try {
    await h.executor.execute(command(f.workspace, "openSession", "open"));
    assert.equal((await h.executor.execute(command(f.workspace, "startTurn", "start", { runId: "run-a", attemptId: "attempt-a" }))).state, "failed");
    assert.equal(f.store.session("session-a")?.state, "idle");
    f.store.acquireWorkspace(f.workspace.registeredWorkspaceId, "session-b", "run-b");
  } finally { await h.executor.close(); f.close(); }
});
test("原生调用后的连续日志写失败不能降级成未开始失败", async () => {
  const f = fixture(), h = runnerHarness(f);
  try {
    await h.executor.execute(command(f.workspace, "openSession", "open"));
    const finish = f.store.finish.bind(f.store);
    f.store.finish = (receipt) => { if (receipt.commandId === "start") throw new Error("simulated journal write failure"); finish(receipt); };
    const result = await h.executor.execute(command(f.workspace, "startTurn", "start", { runId: "run-a", attemptId: "attempt-a" }));
    assert.equal(result.state, "unknown");
    assert.equal(f.store.session("session-a")?.state, "unknown");
    assert.throws(() => f.store.acquireWorkspace(f.workspace.registeredWorkspaceId, "session-b", "run-b"), /仍有运行/);
    assert.equal(h.calls.filter((method) => method === "startTurn").length, 1);
    f.store.finish = finish;
  } finally { await h.executor.close(); f.close(); }
});
test("过期运行器代次的停止与审批不进入原生运行器", async () => {
  const f = fixture(), h = runnerHarness(f);
  try {
    await h.executor.execute(command(f.workspace, "openSession", "open"));
    await h.executor.execute(command(f.workspace, "startTurn", "start", { runId: "run-a", attemptId: "attempt-a" }));
    for (const method of ["interruptTurn", "respondToRuntimeRequest"] as const) {
      assert.equal((await h.executor.execute(command(f.workspace, method, method, { providerTurnId: "turn-a", requestId: "request-a" }, "session-a", "old-epoch"))).error?.code, "stale_runtime");
    }
    assert.deepEqual(h.calls, ["openSession", "startTurn"]);
    assert.equal(f.store.session("session-a")?.state, "active");
  } finally { await h.executor.close(); f.close(); }
});
test("停止回执不释放占用，真实终态才释放", async () => {
  const f = fixture(), h = runnerHarness(f);
  try {
    await h.executor.execute(command(f.workspace, "openSession", "open"));
    await h.executor.execute(command(f.workspace, "startTurn", "start", { runId: "run-a", attemptId: "attempt-a" }));
    await h.executor.execute(command(f.workspace, "interruptTurn", "stop", { providerTurnId: "turn-a" }, "session-a", "epoch-a"));
    assert.equal(f.store.session("session-a")?.state, "active");
    await h.emit({ type: "turn.terminal", providerTurnId: "turn-a", status: "interrupted" });
    assert.equal(f.store.session("session-a")?.state, "idle");
    f.store.acquireWorkspace(f.workspace.registeredWorkspaceId, "session-b", "run-b");
  } finally { await h.executor.close(); f.close(); }
});
test("可靠序号不被易失日志占用，未ACK事件可补传且ACK不能越界", () => {
  const f = fixture();
  try {
    assert.equal(f.store.appendEvent("s", "e", { type: "message.updated", text: "一" }), 1);
    assert.equal(f.store.appendEvent("s", "e", { type: "turn.terminal" }), 2);
    assert.deepEqual(f.store.eventBatch("s", "e").map(({ seq }) => seq), [1, 2]);
    assert.throws(() => f.store.acknowledge("s", "e", 3), /超出/);
    f.store.acknowledge("s", "e", 1);
    assert.deepEqual(f.store.eventBatch("s", "e").map(({ seq }) => seq), [2]);
    f.store.acknowledge("s", "e", 1);
    assert.equal(f.store.appendEvent("s", "e", { type: "message.updated" }), 3);
    f.store.acknowledge("s", "e", 3);
    assert.deepEqual(f.store.eventBatch("s", "e"), []);
    assert.equal(f.store.lastSequence("s", "e"), 3);
    assert.equal(f.store.appendEvent("s", "e", { type: "message.updated" }), 4);
  } finally { f.close(); }
});
test("日志高水位保留控制空间并阻止新轮次", () => {
  const f = fixture({ maxLogBytes: 1024, reserveBytes: 256 });
  try { f.store.appendEvent("s", "e", { text: "a".repeat(800) }); assert.throws(() => f.store.assertCapacity(), /接近容量/); assert.throws(() => f.store.appendEvent("s", "e", { text: "b".repeat(300) }), /已达上限/); }
  finally { f.close(); }
});
test("撤销本机目录立即拒绝新执行，保留旧结果回收能力", () => {
  const f = fixture();
  try { f.store.revoke(f.workspace.registeredWorkspaceId); assert.throws(() => f.store.resolveWorkspace(f.workspace), /已撤销/); assert.equal(f.store.resolveWorkspace(f.workspace, true).revoked, true); }
  finally { f.close(); }
});
test("公网地址必须HTTPS，协议拒绝未知方法及过大消息", () => {
  assert.throws(() => validateBaseUrl("http://public.example"), /HTTPS/);
  assert.equal(validateBaseUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(() => validateBaseUrl("https://token:secret@example.com"), /账号/);
  assert.throws(() => decodeCustomerAgentServerFrame(JSON.stringify({ type: "command", method: "execAnyRpc" })));
  assert.throws(() => decodeCustomerAgentServerFrame("x".repeat(1024 * 1024 + 1)), /大小限制/);
});

test("人工核实要求明确确认，保留原run身份并禁止重做旧命令", async () => {
  const f = fixture(), h = runnerHarness(f, (method) => { if (method === "startTurn") throw new Error("lost acknowledgement"); });
  try {
    await h.executor.execute(command(f.workspace, "openSession", "open"));
    const start = command(f.workspace, "startTurn", "start", { runId: "run-a", attemptId: "attempt-a" });
    await h.executor.execute(start);
    assert.throws(() => f.store.resolveStopped("session-a", false), /必须先在本机确认/);
    const resolved = f.store.resolveStopped("session-a", true);
    assert.equal(resolved.state, "idle");
    assert.deepEqual({ ...resolved.resolution, resolvedAt: "time" }, { runId: "run-a", attemptId: "attempt-a", resolvedAt: "time", reason: "operator_confirmed_process_stopped" });
    assert.equal((await h.executor.execute(start)).error?.code, "CUSTOMER_MANUALLY_RECONCILED");
    f.store.acquireWorkspace(f.workspace.registeredWorkspaceId, "new-session", "new-run");
    assert.equal(h.calls.filter((method) => method === "startTurn").length, 1);
  } finally { await h.executor.close(); f.close(); }
});

test("同名技能换路径后拒绝缓存旧选择，不静默调用新技能", async () => {
  const f = fixture(); let dispatches = 0;
  const executor = new CustomerAgentExecutor({ store: f.store, deviceId: "device", notify: () => {}, runnerFactory: async () => ({
    processGeneration: "epoch", close: async () => {}, dispatch: async () => { dispatches++; return null; },
    catalog: async () => ({ models: [], skills: [{ name: "build", path: "/new/skills/build/SKILL.md", enabled: true, description: "build", scope: "repo" } as any] }),
  }) });
  try {
    await executor.execute(command(f.workspace, "openSession", "open"));
    const result = await executor.execute({ ...command(f.workspace, "startTurn", "start", { runId: "r", attemptId: "a", message: { text: "$build" } }),
      skillBindings: [{ id: customerSkillId(f.workspace.registeredWorkspaceId, "/old/skills/build/SKILL.md"), name: "build" }] });
    assert.equal(result.error?.code, "skill_catalog_changed"); assert.equal(dispatches, 1);
    assert.equal(f.store.session("session-a")?.state, "idle");
  } finally { await executor.close(); f.close(); }
});
