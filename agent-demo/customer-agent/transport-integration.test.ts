import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { NodeWS } from "../../vendor/t3code/apps/server/node_modules/@effect/platform-node-shared/dist/NodeSocket.js";
import { CustomerAgentStore } from "./store.ts";
import { CustomerAgentConnection } from "./connection.ts";
import { createHeadlessCodexRunner } from "../../vendor/t3code/apps/server/src/provider/HeadlessCodexRunner.ts";
import { writeFakeCli } from "../../vendor/t3code/packages/provider-testing/src/fakeCli.ts";
import { RemoteDeviceHub } from "../../vendor/t3code/apps/server/src/autoops/RemoteDeviceService.ts";
import { createCustomerRegistry } from "../t3-adapters/customer-registry.mjs";
import { createCustomerTransportJournal } from "../t3-adapters/customer-transport.mjs";
import { decodeCustomerAgentClientFrame } from "../../vendor/t3code/packages/contracts/src/autoopsRemote.ts";

async function until(condition: () => boolean, timeout = 10000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}

test("真实WS和本机fixture进程：丢启动回执、断线重连、可靠事件补传不重复执行", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "autoops-remote-wire-"));
  const directory = join(root, "project"); mkdirSync(directory);
  const requestLog = join(root, "requests.jsonl"), sideEffect = join(directory, "execution-count.txt");
  const transcript = readFileSync(new URL("../../vendor/t3code/apps/server/src/orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson", import.meta.url), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const responses = Object.fromEntries(transcript.filter((entry) => entry.type === "emit_inbound" && entry.frame?.id !== undefined && entry.frame.result).map((entry) => [entry.label, entry.frame.result]));
  const notifications = transcript.filter((entry) => entry.type === "emit_inbound" && ["turn/started", "item/started", "item/agentMessage/delta", "item/completed", "turn/completed"].includes(entry.frame?.method)).map((entry) => entry.frame);
  const binaryPath = writeFakeCli({ directory: root, name: "codex", source: `
    import {createInterface} from 'node:readline';
    import {appendFileSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
    const responses=${JSON.stringify(responses)},notifications=${JSON.stringify(notifications)};
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{
      const message=JSON.parse(line);appendFileSync(${JSON.stringify(requestLog)},line+'\\n');
      if(message.id===undefined)return;
      let result;
      if(message.method==='model/list')result={data:[{id:'gpt-6-luna',model:'gpt-6-luna',displayName:'GPT-6-Luna',description:'Fixture',hidden:false,isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Medium'}]}],nextCursor:null};
      else if(message.method==='skills/list')result={data:[{cwd:${JSON.stringify(directory)},errors:[],skills:[]}]};
      else result=responses[message.method];
      if(result===undefined)return send({id:message.id,error:{code:-32601,message:'unsupported fixture method'}});
      if(message.method==='turn/start')writeFileSync(${JSON.stringify(sideEffect)},String((existsSync(${JSON.stringify(sideEffect)})?Number(readFileSync(${JSON.stringify(sideEffect)},'utf8')):0)+1));
      send({id:message.id,result});
      if(message.method==='turn/start')setTimeout(()=>notifications.forEach(send),250);
    });
  ` });
  const store = new CustomerAgentStore(join(root, "state"));
  const workspace = store.register(directory, "project", "客户项目");
  store.markPublished(workspace.registeredWorkspaceId);
  const registryDb = new DatabaseSync(":memory:"), transportDb = new DatabaseSync(":memory:");
  const registry = createCustomerRegistry({ db: registryDb, enabled: () => true, requireOwner() {}, requireProjectForUser() {} });
  const paired = registry.consumePairing(registry.createPairing("owner").pairingCode, { label: "本机集成测试" });
  const principal = registry.authenticateToken(paired.deviceToken);
  registry.registerWorkspace(principal, { registeredWorkspaceId: workspace.registeredWorkspaceId, projectId: "project", label: "客户项目", workspaceBindingRevision: 1, runtimeId: "codex" });
  let bound: any;
  const hub = new RemoteDeviceHub({ customerRegistry: registry, getThreadBinding: () => bound } as any, createCustomerTransportJournal(transportDb));
  const server = createServer();
  const wss = new NodeWS.WebSocketServer({ server });
  const errors: unknown[] = []; const connectionStates: string[] = []; const sockets: Array<InstanceType<typeof NodeWS.WebSocket>> = [];
  let dropped = false, startCommandId = "", connectionCount = 0;
  wss.on("connection", (socket: InstanceType<typeof NodeWS.WebSocket>, request: IncomingMessage) => {
    sockets.push(socket); connectionCount++;
    assert.equal(request.headers.authorization, `Bearer ${paired.deviceToken}`);
    const peer = hub.connect(principal, async (frame) => { socket.send(JSON.stringify(frame)); }, () => socket.close());
    socket.on("message", (raw: unknown) => {
      const frame = decodeCustomerAgentClientFrame(String(raw));
      if (frame.type === "receipt" && frame.commandId === startCommandId && frame.state === "completed" && !dropped) {
        dropped = true; socket.close(1001, "fixture lost acknowledgement"); return;
      }
      void peer.accept(frame).catch((error) => { errors.push(error); socket.close(4002, "fixture protocol failure"); });
    });
    socket.on("close", () => peer.disconnect());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const connection = new CustomerAgentConnection({ store, credentials: { deviceId: paired.device.id, token: paired.deviceToken, baseUrl: `http://127.0.0.1:${port}` },
    onState: (message) => connectionStates.push(message),
    runnerFactory: (options) => createHeadlessCodexRunner({ ...options, binaryPath, environment: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` } }) });
  const abort = new AbortController();
  let consume: Promise<void> | undefined;
  try {
    connection.start(); await until(() => { if (errors.length) throw errors[0]; return hub.online(paired.device.id); }).catch((error) => { throw new Error(`${String(error)}; states=${JSON.stringify(connectionStates)}; connections=${connectionCount}`); });
    const threadId = "thread-customer", sessionId = "session-customer", instanceId = `customer-${paired.device.id}-codex`;
    const modelSelection = { instanceId, model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "medium" }] };
    const runtimePolicy = { cwd: "/rejected-central-path", runtimeMode: "full-access", interactionMode: "default" };
    bound = { threadId, ownerId: "owner", projectId: "project", executionBinding: { kind: "customer", deviceId: paired.device.id,
      registeredWorkspaceId: workspace.registeredWorkspaceId, workspaceBindingRevision: 1, runtimeId: "codex" } };
    hub.bind(bound, sessionId);
    await hub.command(sessionId, "openSession", { threadId, providerSessionId: sessionId, modelSelection, runtimePolicy }, "open");
    const providerThread = await hub.command(sessionId, "ensureThread", { threadId, modelSelection, runtimePolicy }, "ensure") as any;
    hub.update(sessionId, { providerThreadId: providerThread.id, runs: [{ runId: "run-customer", attemptId: "attempt-customer", rootNodeId: "node-customer", runOrdinal: 1, providerTurnOrdinal: 1 }] });
    const events: any[] = [];
    consume = (async () => { for await (const event of hub.events(sessionId, abort.signal)) { events.push(event); await hub.acknowledge(event); } })().catch((error) => { errors.push(error); });
    const now = new Date().toISOString();
    const turn = { threadId, runId: "run-customer", runOrdinal: 1, providerTurnOrdinal: 1, attemptId: "attempt-customer", rootNodeId: "node-customer", providerThread,
      appThread: { createdBy: "user", creationSource: "web", id: threadId, projectId: "project", title: "Customer", providerInstanceId: instanceId, modelSelection,
        runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }, forkedFrom: null,
        createdAt: now, updatedAt: now, archivedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null },
      message: { createdBy: "user", creationSource: "web", messageId: "message-customer", text: "fixture simple ok", attachments: [] }, modelSelection, runtimePolicy };
    const { customerCommandId } = await import("../t3-adapters/customer-transport.mjs");
    startCommandId = customerCommandId(sessionId, "startTurn", "start");
    await hub.acquireWorkspace(threadId, "run-customer");
    await hub.command(sessionId, "startTurn", turn, "start");
    await until(() => events.some((event) => event.type === "turn.terminal"));
    await until(() => store.streams().length === 0);
    assert.equal(dropped, true); assert.ok(connectionCount >= 2);
    assert.deepEqual(errors, []);
    assert.equal(readFileSync(sideEffect, "utf8"), "1");
    assert.equal(readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.method === "turn/start").length, 1);
    assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
    assert.ok(events.some((event) => event.type === "message.updated" && event.message.text.includes("fixture simple ok")));
    assert.equal(store.session(sessionId)?.state, "idle");
  } finally {
    abort.abort(); await consume?.catch(() => {}); await connection.close(); hub.close();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve())); await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close(); registryDb.close(); transportDb.close(); rmSync(root, { recursive: true, force: true });
  }
});
