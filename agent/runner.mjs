import { mkdir, readFile, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { identifier, VERSION, CAPABILITIES } from './config.mjs';
import { readJson, writeJson, TaskJournal } from './state.mjs';
import { Docker } from './docker.mjs';
import { CenterClient } from './client.mjs';
import { DeploymentExecutor, terminal } from './executor.mjs';
import { Monitor } from './monitor.mjs';
import { acquireAgentLock } from './lock.mjs';

export class AgentRunner {
  constructor({ root = '/opt/cmr-agent', centerUrl, registrationToken = null, registrationTokenFile = null, allowHttpTest = false, docker = new Docker(), client = null, heartbeatMs = 10000, retryMs = 5000, procRoot = '/host/proc', logger = console } = {}) {
    this.root = path.resolve(root); this.centerUrl = centerUrl; this.registrationToken = registrationToken; this.registrationTokenFile = registrationTokenFile;
    this.client = client || new CenterClient(centerUrl, { allowHttpTest }); this.docker = docker; this.heartbeatMs = heartbeatMs; this.retryMs = retryMs; this.logger = logger;
    this.journal = new TaskJournal(this.root); this.monitor = new Monitor({ docker, root: this.root, procRoot });
    this.executor = new DeploymentExecutor({ root: this.root, identity: () => this.identity, journal: this.journal, client: this.client, docker });
    this.stopped = false; this.activeTaskId = null; this.flushing = null;
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (this.root.includes(',') || this.root.includes('\n')) throw new Error('Agent 工作目录不能包含逗号或换行');
    this.lock = await acquireAgentLock(this.root, { onLost: () => {
      // 锁丢失后退出专用 Agent 进程，避免与接管该目录的新进程并发写入。
      this.logger.error('Agent 工作目录锁意外释放，立即停止当前进程'); process.exit(73);
    } });
    try {
    this.identity = await readJson(path.join(this.root, 'identity.json'));
    if (this.identity) {
      if (this.identity.centerUrl !== new URL(this.centerUrl).origin) throw new Error('本目录已经接入其他中心，拒绝覆盖身份');
      identifier(this.identity.serverId); this.client.token = this.identity.token;
    } else {
      const token = this.registrationToken || (this.registrationTokenFile ? (await readFile(this.registrationTokenFile, 'utf8')).trim() : '');
      if (!token) throw new Error('首次启动需要中心生成的一次性注册令牌');
      const registered = await this.client.register(token); identifier(registered.serverId);
      if (typeof registered.token !== 'string' || registered.token.length < 32 || registered.mode !== 'managed') throw new Error('中心注册响应无效');
      this.identity = { ...registered, targets: registered.targets || [], centerUrl: new URL(this.centerUrl).origin, registeredAt: new Date().toISOString() };
      await this.saveIdentity(); this.client.token = this.identity.token;
    }
    // 注册令牌只用于首次接入；专属身份保存成功后删除暂存令牌。
    if (this.registrationTokenFile && path.dirname(path.resolve(this.registrationTokenFile)) === this.root) await rm(this.registrationTokenFile, { force: true });
    this.registrationToken = null;
    await this.docker.run(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15000 });
    await this.docker.run(['compose', 'version', '--short'], { timeoutMs: 15000 });
    await this.journal.repair();
    return this.identity;
    } catch (error) { await this.lock.release(); throw error; }
  }
  saveIdentity() { return writeJson(path.join(this.root, 'identity.json'), this.identity); }
  async heartbeat() {
    const [metrics, containers] = await Promise.all([this.monitor.metrics(), this.monitor.containers(this.identity)]);
    if (Number.isFinite(this.centerRttMs)) metrics.centerRttMs = this.centerRttMs;
    const started = performance.now();
    const response = await this.client.post('heartbeat', { version: VERSION, capabilities: CAPABILITIES, metrics, containers, activeTaskId: this.activeTaskId });
    this.centerRttMs = Math.max(0, Math.round(performance.now() - started));
    if (response.mode !== 'managed' || !Array.isArray(response.targets)) throw new Error('中心心跳响应无效');
    this.identity.mode = response.mode; this.identity.targets = response.targets; await this.saveIdentity();
  }
  async flushEvents() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      for (const record of await this.journal.list()) {
        for await (const event of this.journal.pending(record)) {
          if (!event) throw new Error('任务事件文件缺失，停止补报以免跳过日志');
          const result = await this.client.post(`tasks/${record.task.id}/events`, event);
          if (!Number.isInteger(result.ackSeq) || result.ackSeq < event.seq || result.ackSeq > (await this.journal.get(record.task.id)).seq) throw new Error('中心日志确认序号无效');
          await this.journal.update(record.task.id, { ackSeq: result.ackSeq });
        }
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async recover() {
    for (const record of await this.journal.list()) {
      if (terminal(record.status)) { await this.executor.cleanupWork(record.task).catch(() => {}); continue; }
      this.activeTaskId = record.task.id;
      try { await this.executor.recover(record); } finally { this.activeTaskId = null; }
    }
  }
  async tick() {
    if (this.activeTaskId) return;
    await this.flushEvents();
    const response = await this.client.post('claim', {}, 35000), task = response.task;
    if (!task) return;
    const existing = await this.journal.get(task.id);
    if (existing && terminal(existing.status)) { await this.flushEvents(); return; }
    this.activeTaskId = task.id;
    try {
      // 领取后刷新目标白名单，避免刚创建的目标尚未出现在上一轮心跳中。
      await this.heartbeat(); await this.executor.execute(task);
    } finally { this.activeTaskId = null; }
    await this.flushEvents();
  }
  async loop(label, action, interval) {
    while (!this.stopped) {
      try { await action(); } catch (error) { this.logger.warn(`${label}暂不可用：${String(error.message).slice(0, 500)}`); }
      if (!this.stopped) await sleep(interval);
    }
  }
  async run() {
    await this.initialize();
    let background = [];
    try {
    // 启动时先刷新授权，中心离线时保留本地任务，等待恢复后再处理重启恢复。
    while (!this.stopped) { try { await this.heartbeat(); break; } catch (error) { this.logger.warn(`等待中心连接：${error.message}`); await sleep(this.retryMs); } }
    if (this.stopped) return;
    background = [this.loop('心跳', () => this.heartbeat(), this.heartbeatMs), this.loop('日志补报', () => this.flushEvents(), this.retryMs)];
    await this.recover();
    await this.loop('任务领取', () => this.tick(), this.retryMs);
    await Promise.all(background);
    } finally { this.stop(); await Promise.allSettled(background); await this.close(); }
  }
  stop() { this.stopped = true; }
  async close() {
    if (this.activeTaskId) throw new Error('任务执行中不能释放 Agent 工作目录锁');
    await this.lock?.release(); this.lock = null;
  }
}
