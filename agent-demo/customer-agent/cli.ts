#!/usr/bin/env node
import { hostname, homedir } from "node:os";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { CustomerAgentStore, defaultLocalPolicy, ConnectorError } from "./store.ts";
import { CustomerAgentConnection, CustomerAgentHttpClient, CONNECTOR_VERSION, type DeviceCredentials } from "./connection.ts";

export function defaultStateDirectory(): string { return join(homedir(), ".autoops", "customer-agent"); }
function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}
export function readCredentials(directory: string): DeviceCredentials {
  try {
    const value = JSON.parse(readFileSync(join(directory, "device.json"), "utf8"));
    if (!value.deviceId || !value.token || !value.baseUrl) throw new Error();
    return value;
  } catch { throw new Error("此连接程序尚未接入中心，请先运行 connect"); }
}
export function writeCredentials(directory: string, credentials: DeviceCredentials): void {
  ensureDirectory(directory);
  const temporary = join(directory, `device-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(credentials), { mode: 0o600 });
  renameSync(temporary, join(directory, "device.json"));
  if (process.platform !== "win32") chmodSync(join(directory, "device.json"), 0o600);
}
export function acquireProcessLock(directory: string): () => void {
  ensureDirectory(directory);
  const path = join(directory, "connector.lock");
  if (existsSync(path)) {
    const old = JSON.parse(readFileSync(path, "utf8"));
    let alive = true;
    try { process.kill(Number(old.pid), 0); } catch (error: any) { if (error?.code === "ESRCH") alive = false; }
    if (alive) throw new Error("此状态目录已有连接程序运行；请先停止原进程");
    unlinkSync(path);
  }
  const nonce = randomUUID();
  const descriptor = openSync(path, "wx", 0o600);
  writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce })); closeSync(descriptor);
  return () => {
    try { if (JSON.parse(readFileSync(path, "utf8")).nonce === nonce) unlinkSync(path); } catch { /* Already removed by its owner. */ }
  };
}
async function question(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("缺少参数；非交互环境请显式指定所需选项");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await readline.question(prompt)).trim(); } finally { readline.close(); }
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "state-dir": { type: "string" }, url: { type: "string" }, code: { type: "string" }, name: { type: "string" },
    project: { type: "string" }, path: { type: "string" }, label: { type: "string" },
    workspace: { type: "string" }, "allow-insecure": { type: "boolean" },
    session: { type: "string" }, "confirm-stopped": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    "read-only": { type: "boolean" }, "network-access": { type: "boolean" }, "approval-policy": { type: "string" },
  } });
  const command = positionals[0]; const directory = resolve(values["state-dir"] ?? defaultStateDirectory());
  if (values.help || !["connect", "register", "status", "run", "revoke", "resolve"].includes(command ?? "")) {
    console.log("AutoOps 客户连接程序\n\nconnect --url https://中心地址 [--code 一次性配对码]\nregister --project 项目ID --path 本机目录 --label 名称 [--read-only] [--network-access]\nstatus\nrun\nrevoke --workspace 登记ID\nresolve --session 会话ID --confirm-stopped\n\n本机 Codex CLI 需已安装并登录。公网必须使用 HTTPS。凭据保留在本机，不上传目录内容。");
    return;
  }
  if (command === "connect") {
    if (existsSync(join(directory, "device.json"))) throw new Error("此状态目录已经绑定设备。请使用 run 重新连接；新增设备请使用新的 --state-dir，不能覆盖旧运行的恢复身份。");
    const url = values.url ?? await question("中心 HTTPS 地址：");
    const pairingCode = values.code ?? await question("网页生成的一次性配对码：");
    const client = new CustomerAgentHttpClient(url, undefined, values["allow-insecure"]);
    try {
      const result = await client.request<{ device: { id: string }; deviceToken: string }>("connector/pair", {
        pairingCode, label: values.name ?? hostname(), platform: process.platform, connectorVersion: CONNECTOR_VERSION,
      });
      writeCredentials(directory, { deviceId: result.device.id, token: result.deviceToken, baseUrl: client.baseUrl,
        ...(values["allow-insecure"] ? { allowInsecure: true } : {}) });
      console.log("设备已接入。请在本机登记目录，然后运行 run。设备凭据已单独保存，不会打印。");
    } finally { await client.close(); }
    return;
  }
  const store = new CustomerAgentStore(directory);
  try {
    if (command === "resolve") {
      if (!values.session || !values["confirm-stopped"]) throw new Error("先检查并结束旧受管进程，再使用 resolve --session 会话ID --confirm-stopped；这不会撤销已经发生的文件修改");
      const release = acquireProcessLock(directory);
      try { store.resolveStopped(values.session, true); console.log("已保存人工核实记录。旧轮次将按结果不完整结束，不重做、不回滚；运行 run 后回传中心。"); }
      finally { release(); }
      return;
    }
    if (command === "status") {
      let device: string | null = null; try { device = readCredentials(directory).deviceId; } catch {}
      console.log(JSON.stringify({ deviceId: device, workspaces: store.workspaces().map((workspace) => ({
        id: workspace.registeredWorkspaceId, label: workspace.label, path: workspace.realPath,
        projectId: workspace.projectId, revoked: workspace.revoked, policy: workspace.policy,
      })), sessions: store.sessions(), pendingEventBytes: store.logBytes(), pendingCommands: store.pendingReceipts().map(({ commandId, sessionId, state }) => ({ commandId, sessionId, state })) }, null, 2));
      return;
    }
    const credentials = readCredentials(directory);
    const client = new CustomerAgentHttpClient(credentials.baseUrl, credentials.token, credentials.allowInsecure);
    const publishWorkspace = async (workspace: ReturnType<CustomerAgentStore["workspaces"]>[number]) => client.request("connector/workspaces", {
      registeredWorkspaceId: workspace.registeredWorkspaceId, projectId: workspace.projectId, label: workspace.label,
      workspaceBindingRevision: workspace.workspaceBindingRevision, runtimeId: workspace.runtimeId,
    });
    try {
      if (command === "register") {
        const path = values.path ?? await question("本机项目目录绝对路径：");
        const projectId = values.project ?? await question("中心项目 ID：");
        const label = values.label ?? await question("工作区显示名称：");
        const approval = values["approval-policy"] ?? "on-request";
        if (!["on-request", "untrusted"].includes(approval)) throw new Error("审批方式只能是 on-request 或 untrusted");
        const workspace = store.register(path, projectId, label, { ...defaultLocalPolicy,
          approvalPolicy: approval as "on-request" | "untrusted", sandboxMode: values["read-only"] ? "read-only" : "workspace-write", networkAccess: values["network-access"] ?? false });
        try { await publishWorkspace(workspace); store.markPublished(workspace.registeredWorkspaceId); console.log(`已登记工作区：${workspace.label}（${workspace.registeredWorkspaceId}）`); }
        catch { console.log(`本机登记已保存（${workspace.registeredWorkspaceId}），中心暂不可达；下次 run 会重新同步登记。`); }
        return;
      }
      if (command === "revoke") {
        if (!values.workspace) throw new Error("请提供 --workspace 登记 ID");
        store.revoke(values.workspace);
        // The running executor resolves the latest local grant before every command. A running turn
        // still needs a real stop confirmation; revocation is never reported as a stopped process.
        await client.request(`connector/workspaces/${encodeURIComponent(values.workspace)}/revoke`, {});
        console.log("工作区已撤销，新命令将被拒绝。活动任务仍需等待实际停止确认。"); return;
      }
      const release = acquireProcessLock(directory);
      let connection: CustomerAgentConnection | undefined;
      try {
        store.recoverAfterRestart();
        const { createHeadlessCodexRunner } = await import("../../vendor/t3code/apps/server/src/provider/HeadlessCodexRunner.ts");
        let refreshing = false;
        connection = new CustomerAgentConnection({ store, credentials, runnerFactory: createHeadlessCodexRunner,
          onState: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
          beforeConnect: async () => {
            for (const workspace of store.workspaces().filter((item) => !item.revoked && !item.published)) {
              await publishWorkspace(workspace); store.markPublished(workspace.registeredWorkspaceId);
            }
          },
          onReady: async () => {
            if (refreshing) return;
            refreshing = true;
            try {
              for (const workspace of store.workspaces().filter((item) => !item.revoked && item.published)) {
                try { await client.request("connector/capabilities", await connection!.executor.capabilities(workspace)); }
                catch { console.log(`工作区 ${workspace.label} 的能力发现未完成，请检查本机 Codex 登录与版本；不会替换为平台模型。`); }
              }
            } finally { refreshing = false; }
          } });
        connection.start();
        await new Promise<void>((resolveStopped) => {
          let lastInterrupt = 0;
          const stop = () => {
            if (connection!.executor.hasActivity() && Date.now() - lastInterrupt > 5000) {
              lastInterrupt = Date.now();
              console.log("仍有本机执行或待核实任务，请先在网页停止任务。5 秒内再次按 Ctrl+C 将强制退出并保留未知状态与工作区占用。"); return;
            }
            process.off("SIGINT", stop); process.off("SIGTERM", stop); resolveStopped();
          };
          process.on("SIGINT", stop); process.on("SIGTERM", stop);
        });
      } finally { await connection?.close(); release(); }
    } finally { await client.close(); }
  } finally { store.close(); }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error instanceof ConnectorError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "连接程序未完成操作"); process.exitCode = 1; });
}
