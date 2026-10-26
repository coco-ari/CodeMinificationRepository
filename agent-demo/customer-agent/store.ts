import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CustomerAgentCommand, CustomerAgentReceipt, CustomerAgentTarget, CustomerAgentResolution } from "../../vendor/t3code/packages/contracts/src/autoopsRemote.ts";
import { sharedSessionIdentity, type SharedExecutionScope } from "../../autoops/contracts/shared-execution.ts";
import { canonicalCustomerCommand, decodeUnseenOpenCommandExport, matchesUnseenOpenIdentity, type UnseenOpenCommandIdentity } from '../../autoops/contracts/customer-command-reconciliation.ts';

export interface LocalPolicy {
  approvalPolicy: "untrusted" | "on-request";
  sandboxMode: "read-only" | "workspace-write";
  networkAccess: boolean;
}
export interface LocalWorkspace extends CustomerAgentTarget {
  projectId: string; label: string; realPath: string; identity: string;
  revoked: boolean; policy: LocalPolicy;
  published?: boolean;
  sharedProfilePath?: string;
}
export interface LocalSession {
  sessionId: string; runtimeEpoch: string; workspaceId: string;
  state: "idle" | "active" | "unknown"; nativeThreadId: string | null;
  nativeTurnId: string | null; runId: string | null; attemptId: string | null;
  resolution?: CustomerAgentResolution;
  executionScope?: SharedExecutionScope;
}
export class ConnectorError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export const defaultLocalPolicy: LocalPolicy = {
  approvalPolicy: "on-request", sandboxMode: "workspace-write", networkAccess: false,
};
const canonical = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
function overlaps(a: string, b: string): boolean {
  const rel = relative(canonical(a), canonical(b));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function directoryIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory()) throw new ConnectorError("not_directory", "请选择本机目录");
  return `${stat.dev}:${stat.ino}`;
}
const parse = <T>(row: unknown, column: string): T => JSON.parse((row as Record<string, string>)[column]!) as T;
export class CustomerAgentStore {
  readonly db: DatabaseSync;
  readonly directory: string;
  readonly maxLogBytes: number;
  readonly reserveBytes: number;
  constructor(directory: string, options: { maxLogBytes?: number; reserveBytes?: number } = {}) {
    this.directory = resolve(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, "connector.sqlite"));
    this.maxLogBytes = options.maxLogBytes ?? 64 * 1024 * 1024;
    this.reserveBytes = options.reserveBytes ?? Math.min(8 * 1024 * 1024, this.maxLogBytes / 8);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, hash TEXT NOT NULL, session_id TEXT NOT NULL,
        method TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_locks(workspace_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS streams(session_id TEXT NOT NULL, epoch TEXT NOT NULL, tail INTEGER NOT NULL DEFAULT 0,
        ack INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id,epoch));
      CREATE TABLE IF NOT EXISTS events(session_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
        payload TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(session_id,epoch,seq));
      CREATE TABLE IF NOT EXISTS reconciliations(session_id TEXT NOT NULL, epoch TEXT NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(session_id,epoch));
      CREATE TABLE IF NOT EXISTS command_reconciliations(command_id TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
    if (process.platform !== "win32") chmodSync(join(directory, "connector.sqlite"), 0o600);
  }
  close(): void { this.db.close(); }
  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  workspaces(): LocalWorkspace[] {
    return this.db.prepare("SELECT payload FROM workspaces").all().map((row) => parse<LocalWorkspace>(row, "payload"));
  }
  register(path: string, projectId: string, label: string, policy: LocalPolicy = defaultLocalPolicy): LocalWorkspace {
    const realPath = realpathSync(resolve(path));
    const identity = directoryIdentity(realPath);
    if (!projectId.trim() || !label.trim()) throw new ConnectorError("invalid_registration", "项目与目录名称不能为空");
    for (const previous of this.workspaces()) {
      if (previous.revoked && !this.db.prepare("SELECT 1 FROM workspace_locks WHERE workspace_id=?").get(previous.registeredWorkspaceId)) continue;
      if (overlaps(previous.realPath, realPath) || overlaps(realPath, previous.realPath) || previous.identity === identity) {
        throw new ConnectorError("overlapping_workspace", "该目录或其父子目录已经登记，请复用原登记或先撤销并处理旧运行");
      }
    }
    const workspace: LocalWorkspace = {
      registeredWorkspaceId: randomUUID(), workspaceBindingRevision: 1, runtimeId: "codex",
      projectId, label, realPath, identity, revoked: false, policy,
    };
    this.db.prepare("INSERT INTO workspaces(id,payload) VALUES(?,?)").run(workspace.registeredWorkspaceId, JSON.stringify(workspace));
    return workspace;
  }
  resolveWorkspace(target: CustomerAgentTarget, allowRevoked = false): LocalWorkspace {
    const workspace = this.workspaces().find((item) => item.registeredWorkspaceId === target.registeredWorkspaceId);
    if (!workspace || (!allowRevoked && workspace.revoked)) throw new ConnectorError("workspace_revoked", "本机工作区不存在或已撤销");
    if (workspace.workspaceBindingRevision !== target.workspaceBindingRevision || target.runtimeId !== "codex") {
      throw new ConnectorError("binding_changed", "工作区登记版本不一致，请新建对话");
    }
    if (!allowRevoked && (!existsSync(workspace.realPath) || realpathSync(workspace.realPath) !== workspace.realPath || directoryIdentity(workspace.realPath) !== workspace.identity)) {
      throw new ConnectorError("directory_replaced", "登记目录已移动或被替换，请在本机重新登记");
    }
    return workspace;
  }
  revoke(workspaceId: string): void {
    const workspace = this.workspaces().find((item) => item.registeredWorkspaceId === workspaceId);
    if (!workspace) throw new ConnectorError("unknown_workspace", "未找到本机登记目录");
    this.db.prepare("UPDATE workspaces SET payload=? WHERE id=?").run(JSON.stringify({ ...workspace, revoked: true }), workspaceId);
  }
  markPublished(workspaceId: string): void {
    const workspace = this.workspaces().find((item) => item.registeredWorkspaceId === workspaceId);
    if (workspace) this.db.prepare("UPDATE workspaces SET payload=? WHERE id=?").run(JSON.stringify({ ...workspace, published: true }), workspaceId);
  }
  receipt(command: CustomerAgentCommand): CustomerAgentReceipt | undefined {
    const row = this.db.prepare("SELECT hash,receipt FROM commands WHERE id=?").get(command.commandId);
    if (!row) return undefined;
    if (row.hash !== this.commandHash(command)) throw new ConnectorError("command_id_conflict", "同一命令 ID 的内容不一致");
    return parse<CustomerAgentReceipt>(row, "receipt");
  }
  queryReceipt(commandId: string, sessionId: string, grantId?: string): CustomerAgentReceipt | undefined {
    const row = this.db.prepare('SELECT receipt FROM commands WHERE id=? AND session_id=?').get(commandId,sessionId);
    const receipt = row ? parse<CustomerAgentReceipt>(row,'receipt') : undefined;
    if (receipt && receipt.grantId !== grantId) throw new ConnectorError('receipt_scope_changed','原收据不属于此共享范围');
    return receipt;
  }
  commandHash(command: CustomerAgentCommand): string {
    return createHash("sha256").update(canonicalCustomerCommand(command)).digest("hex");
  }
  accept(command: CustomerAgentCommand): CustomerAgentReceipt {
    const previous = this.receipt(command);
    if (previous) return previous;
    if (!["interruptTurn", "respondToRuntimeRequest", "readThreadSnapshot"].includes(command.method)) this.assertCapacity();
    const count = this.db.prepare("SELECT COUNT(*) count FROM commands").get()!;
    if (Number(count.count) >= 100000) throw new ConnectorError("command_log_full", "本机恢复日志已达容量，请先维护日志");
    const receipt: CustomerAgentReceipt = { type: "receipt", commandId: command.commandId, sessionId: command.sessionId, state: "accepted",...(command.executionScope?{grantId:command.executionScope.grantId}:{}) };
    this.db.prepare("INSERT INTO commands(id,hash,session_id,method,state,receipt,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(command.commandId, this.commandHash(command), command.sessionId, command.method, "accepted", JSON.stringify(receipt), Date.now());
    return receipt;
  }
  finish(receipt: CustomerAgentReceipt): void {
    const row=this.db.prepare('SELECT session_id,receipt FROM commands WHERE id=?').get(receipt.commandId);
    if(!row || row.session_id!==receipt.sessionId || parse<CustomerAgentReceipt>(row,'receipt').grantId!==receipt.grantId)
      throw new ConnectorError('receipt_scope_changed','完成收据不能改写原命令及共享范围');
    this.db.prepare("UPDATE commands SET state=?,receipt=?,updated_at=? WHERE id=?")
      .run(receipt.state, JSON.stringify(receipt), Date.now(), receipt.commandId);
  }
  pendingReceipts(): CustomerAgentReceipt[] {
    return this.db.prepare("SELECT receipt FROM commands WHERE state IN ('accepted','unknown')").all().map((row) => parse<CustomerAgentReceipt>(row, "receipt"));
  }
  /** 与待执行/未知收据分开，重启不能把已人工中止的 tombstone 降成 unknown。 */
  manuallyReconciledOpenReceipts(): CustomerAgentReceipt[] {
    return this.db.prepare('SELECT c.receipt FROM commands c JOIN command_reconciliations r ON r.command_id=c.id WHERE c.state=\'failed\' ORDER BY c.rowid LIMIT 64').all().map(row => parse<CustomerAgentReceipt>(row, 'receipt'));
  }
  reconcileUnseenOpen(input: unknown, expected: UnseenOpenCommandIdentity, confirmed: boolean): CustomerAgentReceipt {
    if (!confirmed) throw new ConnectorError('confirmation_required', '必须明确核实旧受管进程已经结束，再指定 --confirm-stopped');
    let value;
    try { value = decodeUnseenOpenCommandExport(input); } catch { throw new ConnectorError('original_export_invalid', '原命令公开导出合同不完整'); }
    const scope = value.executionScope;
    if (!matchesUnseenOpenIdentity(value, expected) || scope.grantId !== value.grantId || scope.providerId !== value.providerId || scope.threadId !== value.threadId || scope.target.deviceId !== value.deviceId) throw new ConnectorError('original_identity_mismatch', '人工确认标识与原设备、提供者、授权或命令指纹不一致');
    return this.transaction(() => {
      const workspace = this.resolveWorkspace(scope.target, true);
      if (workspace.projectId !== scope.sourceProjectId) throw new ConnectorError('original_scope_changed', '原命令的来源项目与本机登记不一致');
      const history = this.db.prepare('SELECT 1 FROM commands WHERE id=? OR session_id=? LIMIT 1').get(value.commandId, value.sessionId)
        || this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(value.sessionId)
        || this.db.prepare('SELECT 1 FROM workspace_locks WHERE session_id=? OR workspace_id=? LIMIT 1').get(value.sessionId, workspace.registeredWorkspaceId)
        || this.db.prepare('SELECT 1 FROM streams WHERE session_id=? LIMIT 1').get(value.sessionId)
        || this.db.prepare('SELECT 1 FROM events WHERE session_id=? LIMIT 1').get(value.sessionId)
        || this.db.prepare('SELECT 1 FROM reconciliations WHERE session_id=? LIMIT 1').get(value.sessionId)
        || this.sessions().some(session => session.workspaceId === workspace.registeredWorkspaceId && session.state !== 'idle');
      if (history) throw new ConnectorError('original_local_history_exists', '原命令、会话或目录已有本机执行记录，须使用原运行恢复流程');
      if (Number(this.db.prepare('SELECT COUNT(*) count FROM command_reconciliations').get()!.count) >= 64) throw new ConnectorError('manual_reconciliation_full', '本机人工中止记录已达上限；历史保护记录不能删除，请联系维护人员');
      const receipt: CustomerAgentReceipt = { type: 'receipt', commandId: value.commandId, sessionId: value.sessionId, grantId: value.grantId, state: 'failed', error: { code: 'CUSTOMER_MANUALLY_RECONCILED', message: '用户已在本机明确中止原命令并核实旧受管进程结束；结果不完整，不重做或回滚，不据本机记录缺失推断曾未执行' } };
      const audit = JSON.stringify({ original: value, operatorConfirmedStopped: true, resultIncomplete: true, recordedAt: new Date().toISOString() });
      const count = Number(this.db.prepare('SELECT COUNT(*) count FROM commands').get()!.count);
      if (count >= 100000 || this.logBytes() + Buffer.byteLength(audit) + Buffer.byteLength(JSON.stringify(receipt)) > this.maxLogBytes) throw new ConnectorError('command_log_full', '本机恢复日志已达容量，请先维护日志');
      this.db.prepare('INSERT INTO commands(id,hash,session_id,method,state,receipt,updated_at) VALUES(?,?,?,?,?,?,?)').run(value.commandId, value.commandFingerprint, value.sessionId, 'openSession', 'failed', JSON.stringify(receipt), Date.now());
      this.db.prepare('INSERT INTO command_reconciliations(command_id,payload) VALUES(?,?)').run(value.commandId, audit);
      return receipt;
    });
  }
  sessions(): LocalSession[] { return this.db.prepare("SELECT payload FROM sessions").all().map((row) => parse<LocalSession>(row, "payload")); }
  session(id: string): LocalSession | undefined { return this.sessions().find((session) => session.sessionId === id); }
  saveSession(session: LocalSession): void {
    const old=this.session(session.sessionId);
    if(old && (old.workspaceId!==session.workspaceId || sharedSessionIdentity(old.executionScope)!==sharedSessionIdentity(session.executionScope)))
      throw new ConnectorError('session_scope_changed','本机会话不能更换实际调用者、项目或隔离边界');
    this.db.prepare("INSERT INTO sessions(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
      .run(session.sessionId, JSON.stringify(session));
  }
  setSharedProfile(workspaceId: string, path?: string): LocalWorkspace {
    const saved=this.workspaces().find(workspace=>workspace.registeredWorkspaceId===workspaceId);
    if(!saved)throw new ConnectorError('unknown_workspace','未找到本机登记目录');
    const workspace=this.resolveWorkspace(saved);
    if (path!==undefined&&(!isAbsolute(path) || realpathSync(path)!==path || !statSync(path).isFile())) throw new ConnectorError('shared_profile_invalid','请选择本机明确的隔离profile文件');
    const {sharedProfilePath:previous,...self}=workspace;
    const value=path===undefined?self:{...self,sharedProfilePath:path};
    this.db.prepare('UPDATE workspaces SET payload=? WHERE id=?').run(JSON.stringify(value),workspaceId);
    return value;
  }
  /** Only call once after owning the connector process lock. Never infer a crashed command did not run. */
  recoverAfterRestart(): void {
    this.transaction(() => {
      for (const receipt of this.pendingReceipts()) this.finish({ ...receipt, state: "unknown", error: {
        code: "restart_outcome_unknown", message: "连接程序已重启，旧命令结果待本机核实；不会自动重发",
      } });
      for (const session of this.sessions()) {
        if (session.state === "active") this.saveSession({ ...session, state: "unknown" });
      }
    });
  }
  /** A human explicitly verified local process termination. This is not a successful task result. */
  resolveStopped(sessionId: string, confirmed: boolean): LocalSession {
    if (!confirmed) throw new ConnectorError("confirmation_required", "必须先在本机确认旧受管进程已经结束，再指定 --confirm-stopped");
    const session = this.session(sessionId);
    if (!session || !["active", "unknown"].includes(session.state)) throw new ConnectorError("not_unresolved", "该会话没有待核实的执行");
    return this.transaction(() => {
      const resolution = session.runId && session.attemptId ? {
        runId: session.runId, attemptId: session.attemptId, resolvedAt: new Date().toISOString(),
        reason: "operator_confirmed_process_stopped" as const,
      } : undefined;
      this.db.prepare("INSERT OR REPLACE INTO reconciliations(session_id,epoch,payload) VALUES(?,?,?)")
        .run(sessionId, session.runtimeEpoch, JSON.stringify({ ...session, resolution, operatorConfirmedStopped: true, recordedAt: new Date().toISOString() }));
      for (const receipt of this.pendingReceipts().filter((item) => item.sessionId === sessionId)) {
        this.finish({ ...receipt, state: "failed", error: { code: "CUSTOMER_MANUALLY_RECONCILED", message: "用户已在本机确认旧进程结束；结果不完整，未重做或回滚文件修改" } });
      }
      if (session.runId) this.releaseWorkspace(session.workspaceId, sessionId, session.runId);
      const resolved: LocalSession = { ...session, state: "idle", runId: null, attemptId: null, ...(resolution ? { resolution } : {}) };
      this.saveSession(resolved); return resolved;
    });
  }
  acquireWorkspace(workspaceId: string, sessionId: string, runId: string): void {
    const row = this.db.prepare("SELECT session_id,run_id FROM workspace_locks WHERE workspace_id=?").get(workspaceId);
    if (row) throw new ConnectorError("workspace_busy", "该工作区仍有运行或待核实的执行");
    this.db.prepare("INSERT INTO workspace_locks(workspace_id,session_id,run_id) VALUES(?,?,?)").run(workspaceId, sessionId, runId);
  }
  releaseWorkspace(workspaceId: string, sessionId: string, runId: string): void {
    this.db.prepare("DELETE FROM workspace_locks WHERE workspace_id=? AND session_id=? AND run_id=?").run(workspaceId, sessionId, runId);
  }
  logBytes(): number {
    const events = Number(this.db.prepare("SELECT COALESCE(SUM(bytes),0) bytes FROM events").get()!.bytes);
    const commands = Number(this.db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(receipt AS BLOB))),0) bytes FROM commands").get()!.bytes);
    const reconciliations = Number(this.db.prepare('SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))),0) bytes FROM command_reconciliations').get()!.bytes);
    return events + commands + reconciliations;
  }
  assertCapacity(): void {
    if (this.logBytes() >= this.maxLogBytes - this.reserveBytes) throw new ConnectorError("outbox_high_water", "待回传日志接近容量上限，请恢复连接并完成同步后再开始新轮次");
  }
  appendEvent(sessionId: string, epoch: string, event: unknown): number {
    const payload = JSON.stringify(event);
    const bytes = Buffer.byteLength(payload);
    if (bytes > 900 * 1024) throw new ConnectorError("event_too_large", "运行器结果超过单条传输上限，执行结果需在本机核实");
    if (this.logBytes() + bytes > this.maxLogBytes) throw new ConnectorError("outbox_full", "待回传日志已达上限，执行结果需在本机核实");
    return this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO streams(session_id,epoch) VALUES(?,?)").run(sessionId, epoch);
      const seq = Number(this.db.prepare("SELECT tail FROM streams WHERE session_id=? AND epoch=?").get(sessionId, epoch)!.tail) + 1;
      this.db.prepare("INSERT INTO events(session_id,epoch,seq,payload,bytes) VALUES(?,?,?,?,?)").run(sessionId, epoch, seq, payload, bytes);
      this.db.prepare("UPDATE streams SET tail=? WHERE session_id=? AND epoch=?").run(seq, sessionId, epoch);
      return seq;
    });
  }
  acknowledge(sessionId: string, epoch: string, seq: number): void {
    this.transaction(() => {
      const stream = this.db.prepare("SELECT tail,ack FROM streams WHERE session_id=? AND epoch=?").get(sessionId, epoch);
      if (!stream || seq > Number(stream.tail) || seq < 0) throw new ConnectorError("invalid_ack", "中心回执序号超出本机事件范围");
      if (seq <= Number(stream.ack)) return;
      this.db.prepare("UPDATE streams SET ack=? WHERE session_id=? AND epoch=?").run(seq, sessionId, epoch);
      this.db.prepare("DELETE FROM events WHERE session_id=? AND epoch=? AND seq<=?").run(sessionId, epoch, seq);
    });
  }
  eventBatch(sessionId: string, epoch: string, afterSeq = 0, maxBytes = 192 * 1024): Array<{seq: number; event: unknown}> {
    const rows = this.db.prepare("SELECT seq,payload,bytes FROM events WHERE session_id=? AND epoch=? AND seq>? ORDER BY seq LIMIT 64").all(sessionId, epoch, afterSeq);
    const result: Array<{seq: number; event: unknown}> = []; let bytes = 0;
    for (const row of rows) { if (result.length && bytes + Number(row.bytes) > maxBytes) break; bytes += Number(row.bytes); result.push({ seq: Number(row.seq), event: JSON.parse(String(row.payload)) }); }
    return result;
  }
  streams(): Array<{sessionId: string; runtimeEpoch: string; ack: number; tail: number}> {
    return this.db.prepare("SELECT session_id,epoch,ack,tail FROM streams WHERE tail>ack").all().map((row) => ({ sessionId: String(row.session_id), runtimeEpoch: String(row.epoch), ack: Number(row.ack), tail: Number(row.tail) }));
  }
  lastSequence(sessionId: string, epoch: string): number {
    return Number(this.db.prepare("SELECT tail FROM streams WHERE session_id=? AND epoch=?").get(sessionId, epoch)?.tail ?? 0);
  }
}
