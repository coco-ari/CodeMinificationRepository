import { randomUUID } from "node:crypto";
import { WebSocket, EnvHttpProxyAgent, fetch } from "../../vendor/t3code/apps/server/node_modules/undici/index.js";
import { decodeCustomerAgentServerFrame, type CustomerAgentClientFrame } from "../../vendor/t3code/packages/contracts/src/autoopsRemote.ts";
import { CustomerAgentExecutor } from "./executor.ts";
import type { CustomerAgentStore } from "./store.ts";
import { CustomerWorkspaceFiles } from "./files.ts";
import { ConnectorError } from "./store.ts";
import { CUSTOMER_FILE_LIMITS } from "../../vendor/t3code/packages/contracts/src/customerFiles.ts";

export interface DeviceCredentials { deviceId: string; token: string; baseUrl: string; allowInsecure?: boolean; }
export const CONNECTOR_VERSION = "0.4.3";
export function validateBaseUrl(value: string, allowInsecure = false): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search) throw new Error("中心地址不能包含账号、密码、查询参数或片段");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || allowInsecure))) {
    throw new Error("公网接入必须使用 HTTPS；仅测试网络可显式指定 --allow-insecure");
  }
  return url.href.replace(/\/$/, "");
}
const endpoint = (base: string, path: string) => `${base}/api/agent-demo/t3/autoops/customer/${path}`;
export class CustomerAgentHttpClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly dispatcher = new EnvHttpProxyAgent();
  constructor(baseUrl: string, token?: string, allowInsecure = false) {
    this.baseUrl = validateBaseUrl(baseUrl, allowInsecure); this.token = token;
  }
  async request<T>(path: string, body?: unknown, signal?:AbortSignal): Promise<T> {
    const response = await fetch(endpoint(this.baseUrl, path), {
      method: body === undefined ? "GET" : "POST", dispatcher: this.dispatcher,
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), redirect: "error",
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`中心请求失败（HTTP ${response.status}），请检查设备授权与地址`); }
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("中心响应超过大小限制");
    return JSON.parse(text) as T;
  }
  async *downloadAttachment(commandId: string, attachmentId: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    const response = await fetch(endpoint(this.baseUrl, `connector/attachments/${encodeURIComponent(commandId)}/${encodeURIComponent(attachmentId)}`), {
      dispatcher: this.dispatcher, headers: {authorization: `Bearer ${this.token}`},
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]), redirect: "error",
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("附件下载失败"); }
    for await (const chunk of response.body) yield chunk;
  }
  async close(): Promise<void> { await this.dispatcher.close(); }
}

/** A socket is only a transport epoch. Disconnecting never closes the local runner. */
export class CustomerAgentConnection {
  readonly executor: CustomerAgentExecutor;
  private readonly store: CustomerAgentStore;
  private readonly credentials: DeviceCredentials;
  private readonly dispatcher = new EnvHttpProxyAgent();
  private readonly attachmentClient: CustomerAgentHttpClient;
  private readonly connectorEpoch = randomUUID();
  private readonly onState: (message: string) => void;
  private readonly beforeConnect: () => Promise<void>;
  private readonly onReady: () => Promise<void>;
  private socket: InstanceType<typeof WebSocket> | undefined;
  private stopped = false;
  private ready = false;
  private lastReceived = 0;
  private retry = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly control: CustomerAgentClientFrame[] = [];
  private readonly sent = new Map<string, { seq: number; at: number }>();
  private readonly connectionLost = new Set<() => void>();
  private readonly fileReads = new Map<string, AbortController>();
  constructor(options: {
    store: CustomerAgentStore; credentials: DeviceCredentials;
    runnerFactory: ConstructorParameters<typeof CustomerAgentExecutor>[0]["runnerFactory"];
    onState?: (message: string) => void;
    beforeConnect?: () => Promise<void>;
    onReady?: () => Promise<void>;
  }) {
    this.store = options.store; this.credentials = options.credentials; this.onState = options.onState ?? (() => {});
    this.beforeConnect = options.beforeConnect ?? (async () => {}); this.onReady = options.onReady ?? (async () => {});
    this.attachmentClient = new CustomerAgentHttpClient(this.credentials.baseUrl, this.credentials.token, this.credentials.allowInsecure);
    this.executor = new CustomerAgentExecutor({ store: this.store, deviceId: this.credentials.deviceId,
      authorizeShared:async (scope,signal)=>{const admitted=await this.attachmentClient.request<{grantId:string;available:boolean}>('connector/shared-admission',scope,signal);if(admitted.grantId!==scope.grantId||admitted.available!==true)throw new ConnectorError('shared_admission_denied','共享执行授权已失效')},
      downloadAttachment: (commandId, attachmentId, signal) => this.attachmentClient.downloadAttachment(commandId, attachmentId, signal),
      runnerFactory: options.runnerFactory, notify: (frame) => this.enqueue(frame), onState: this.onState });
  }
  start(): void {
    this.flushTimer = setInterval(() => { this.executor.enforceLocalRevocations(); this.flush(); }, 100);
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || !this.ready) return;
      if (Date.now() - this.lastReceived > 45000) { this.socket.close(4000, "heartbeat timeout"); return; }
      this.enqueue({ type: "ping", at: Date.now() });
    }, 15000);
    void this.connect();
  }
  private async connect(): Promise<void> {
    if (this.stopped) return;
    try { await this.beforeConnect(); }
    catch { this.onState("目录登记暂未同步，已登记会话仍会尝试恢复连接"); }
    if (this.stopped) return;
    const base = validateBaseUrl(this.credentials.baseUrl, this.credentials.allowInsecure);
    const url = new URL(endpoint(base, "connect")); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { dispatcher: this.dispatcher, headers: { authorization: `Bearer ${this.credentials.token}` } });
    this.socket = socket; this.ready = false;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.stopped) return;
      this.lastReceived = Date.now(); this.sent.clear();
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, deviceId: this.credentials.deviceId,
        connectorVersion: CONNECTOR_VERSION, connectorEpoch: this.connectorEpoch, attachmentTransfers: true, workspaceFiles: true, assistantConfiguration: true,sharedExecutionVersion:1,receiptQueries:true,
        workspaces: this.store.workspaces().filter((workspace) => !workspace.revoked && workspace.published).map((workspace) => ({
          registeredWorkspaceId: workspace.registeredWorkspaceId, workspaceBindingRevision: workspace.workspaceBindingRevision,
          runtimeId: workspace.runtimeId, projectId: workspace.projectId, label: workspace.label,
        })), sessions: this.store.sessions().map((session) => ({ sessionId: session.sessionId,
          runtimeEpoch: session.runtimeEpoch, state: session.state, live: this.executor.runners.has(session.sessionId),
          lastSeq: this.store.lastSequence(session.sessionId, session.runtimeEpoch),
          ...(session.resolution ? { resolution: session.resolution } : {}) })),
      }));
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        if (typeof event.data !== "string") throw new Error("text frames required");
        const frame = decodeCustomerAgentServerFrame(event.data); this.lastReceived = Date.now();
        switch (frame.type) {
          case "filesCancel": this.fileReads.get(frame.requestId)?.abort(); break;
          case "files": {
            if (!this.ready) throw new Error("handshake required");
            if (this.fileReads.size >= 2 || this.fileReads.has(frame.requestId)) {
              this.enqueue({ type: "filesResult", requestId: frame.requestId, error: { code: "FILES_BUSY", message: "文件读取正忙，请稍后重试" } });
              break;
            }
            const controller = new AbortController();
            this.fileReads.set(frame.requestId, controller);
            void new CustomerWorkspaceFiles(this.store).read(frame.target, frame.input,
              AbortSignal.any([controller.signal, AbortSignal.timeout(CUSTOMER_FILE_LIMITS.timeoutMs)]))
              .then((result) => {
                if (this.socket === socket && this.ready && !controller.signal.aborted)
                  this.enqueue({ type: "filesResult", requestId: frame.requestId, result });
              }, (error: unknown) => {
                if (this.socket === socket && this.ready && !controller.signal.aborted)
                  this.enqueue({ type: "filesResult", requestId: frame.requestId, error: {
                    code: error instanceof ConnectorError ? error.code : "FILES_UNAVAILABLE",
                    message: error instanceof ConnectorError ? error.message : "文件读取失败，请刷新后重试",
                  } });
              }).finally(() => this.fileReads.delete(frame.requestId));
            break;
          }
          case "welcome":
            this.ready = true; this.retry = 0; this.onState("已连接中心，正在核对待回传结果");
            for (const receipt of this.store.pendingReceipts()) this.enqueue(receipt);
            for (const receipt of this.store.manuallyReconciledOpenReceipts()) this.enqueue(receipt);
            void this.onReady().catch(() => this.onState("本机能力目录暂未刷新，保留原缓存与运行状态"));
            this.flush(); break;
          case "command":
            if (!this.ready) throw new Error("handshake required");
            void this.executor.execute(frame).catch(() => this.onState("客户命令未完成，请查看本机状态")); break;
          case "receiptQuery": {
            if (!this.ready) throw new Error('handshake required');
            const receipt=this.store.queryReceipt(frame.commandId,frame.sessionId,frame.grantId);
            const session=this.store.session(frame.sessionId);
            // 历史turn引用可以保留；只在原会话idle且无在途命令或受管进程时补查询响应，不改账本。
            const original=receipt?.state==='failed'&&receipt.error?.code==='CUSTOMER_MANUALLY_RECONCILED'&&receipt.result===undefined&&session?.state==='idle'&&!session.runId&&!session.attemptId&&!this.executor.hasSessionActivity(frame.sessionId)
              ? {...receipt,runtimeEpoch:receipt.runtimeEpoch??session.runtimeEpoch}:receipt;
            this.enqueue(original ?? {type:'receipt',commandId:frame.commandId,sessionId:frame.sessionId,...(frame.grantId?{grantId:frame.grantId}:{}),state:'unknown',error:{code:'command_not_seen',message:'本机没有原命令收据，不能自动补发；请核查原任务'}});
            break;
          }
          case "ack": this.store.acknowledge(frame.sessionId, frame.runtimeEpoch, frame.seq); break;
          case "replay": this.sent.set(`${frame.sessionId}:${frame.runtimeEpoch}`, { seq: frame.afterSeq, at: Date.now() }); this.flush(); break;
          case "ping": this.enqueue({ type: "pong", at: frame.at }); break;
          case "pong": break;
          case "error":
            this.onState(`中心拒绝连接操作：${frame.code}`);
            if (["device_revoked", "protocol_incompatible", "unauthorized"].includes(frame.code)) { this.stopped = true; socket.close(4003, "authorization rejected"); }
            break;
        }
      } catch { this.onState("收到无效中心消息，连接将重新核对"); socket.close(4002, "invalid frame"); }
    });
    socket.addEventListener("error", () => { this.onState("中心连接暂不可用，本机执行与恢复记录保留"); });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      for (const controller of this.fileReads.values()) controller.abort();
      this.ready = false; this.socket = undefined;
      for (const listener of this.connectionLost) listener();
      if (this.stopped) return;
      if (event.code === 4003 || event.code === 4401 || event.code === 4403) { this.stopped = true; this.onState("设备授权已失效，请在本机重新接入"); return; }
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retry++, 5)) * (0.75 + Math.random() * 0.5);
      this.onState("与中心断开，等待重连；这不代表本机任务停止");
      this.retryTimer = setTimeout(() => { void this.connect(); }, delay);
    });
  }
  private enqueue(frame: CustomerAgentClientFrame): void {
    if (frame.type === "delta") {
      if (this.ready && this.socket && this.socket.bufferedAmount < 128 * 1024 && !this.control.length) this.socket.send(JSON.stringify(frame));
      return;
    }
    if (this.control.length >= 128) { this.socket?.close(4000, "control backpressure"); this.control.length = 0; return; }
    this.control.push(frame); this.flush();
  }
  private flush(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.ready) return;
    while (this.control.length && socket.bufferedAmount < 256 * 1024) socket.send(JSON.stringify(this.control.shift()));
    if (this.control.length || socket.bufferedAmount >= 128 * 1024) return;
    // One reliable batch per tick gives fresh controls priority over large tool output.
    for (const stream of this.store.streams()) {
      const key = `${stream.sessionId}:${stream.runtimeEpoch}`;
      const sent = this.sent.get(key);
      const after = sent && Date.now() - sent.at < 10000 ? Math.max(stream.ack, sent.seq) : stream.ack;
      const events = this.store.eventBatch(stream.sessionId, stream.runtimeEpoch, after);
      if (!events.length) continue;
      socket.send(JSON.stringify({ type: "events", sessionId: stream.sessionId, runtimeEpoch: stream.runtimeEpoch, events }));
      this.sent.set(key, { seq: events.at(-1)!.seq, at: Date.now() }); break;
    }
  }
  async close(): Promise<void> {
    for (const controller of this.fileReads.values()) controller.abort();
    this.stopped = true; clearTimeout(this.retryTimer); clearInterval(this.flushTimer); clearInterval(this.heartbeatTimer);
    this.socket?.close(1000, "connector shutdown");
    await this.executor.close();
    await this.attachmentClient.close(); await this.dispatcher.close();
  }
}
