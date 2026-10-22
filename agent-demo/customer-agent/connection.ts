import { randomUUID } from "node:crypto";
import { WebSocket, EnvHttpProxyAgent, fetch } from "../../vendor/t3code/apps/server/node_modules/undici/index.js";
import { decodeCustomerAgentServerFrame, type CustomerAgentClientFrame } from "../../vendor/t3code/packages/contracts/src/autoopsRemote.ts";
import { CustomerAgentExecutor } from "./executor.ts";
import type { CustomerAgentStore } from "./store.ts";

export interface DeviceCredentials { deviceId: string; token: string; baseUrl: string; allowInsecure?: boolean; }
export const CONNECTOR_VERSION = "0.1.0";
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
  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(endpoint(this.baseUrl, path), {
      method: body === undefined ? "GET" : "POST", dispatcher: this.dispatcher,
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000), redirect: "error",
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`中心请求失败（HTTP ${response.status}），请检查设备授权与地址`); }
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("中心响应超过大小限制");
    return JSON.parse(text) as T;
  }
  async close(): Promise<void> { await this.dispatcher.close(); }
}

/** A socket is only a transport epoch. Disconnecting never closes the local runner. */
export class CustomerAgentConnection {
  readonly executor: CustomerAgentExecutor;
  private readonly store: CustomerAgentStore;
  private readonly credentials: DeviceCredentials;
  private readonly dispatcher = new EnvHttpProxyAgent();
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
  constructor(options: {
    store: CustomerAgentStore; credentials: DeviceCredentials;
    runnerFactory: ConstructorParameters<typeof CustomerAgentExecutor>[0]["runnerFactory"];
    onState?: (message: string) => void;
    beforeConnect?: () => Promise<void>;
    onReady?: () => Promise<void>;
  }) {
    this.store = options.store; this.credentials = options.credentials; this.onState = options.onState ?? (() => {});
    this.beforeConnect = options.beforeConnect ?? (async () => {}); this.onReady = options.onReady ?? (async () => {});
    this.executor = new CustomerAgentExecutor({ store: this.store, deviceId: this.credentials.deviceId,
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
        connectorVersion: CONNECTOR_VERSION, connectorEpoch: this.connectorEpoch,
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
          case "welcome":
            this.ready = true; this.retry = 0; this.onState("已连接中心，正在核对待回传结果");
            for (const receipt of this.store.pendingReceipts()) this.enqueue(receipt);
            void this.onReady().catch(() => this.onState("本机能力目录暂未刷新，保留原缓存与运行状态"));
            this.flush(); break;
          case "command":
            if (!this.ready) throw new Error("handshake required");
            void this.executor.execute(frame).catch(() => this.onState("客户命令未完成，请查看本机状态")); break;
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
    this.stopped = true; clearTimeout(this.retryTimer); clearInterval(this.flushTimer); clearInterval(this.heartbeatTimer);
    this.socket?.close(1000, "connector shutdown");
    await this.executor.close(); await this.dispatcher.close();
  }
}
