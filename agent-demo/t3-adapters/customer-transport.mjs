// Transport receipts and delivery cursors only. T3 remains the conversation/run store.
import { createHash } from 'node:crypto';
import { sharedSessionIdentity } from '../../autoops/contracts/shared-execution.ts';
import { canonicalCustomerCommand, decodeUnseenOpenCommandExport, matchesUnseenOpenIdentity } from '../../autoops/contracts/customer-command-reconciliation.ts';
import { decodeCustomerAgentServerFrame } from '../../vendor/t3code/packages/contracts/src/autoopsRemote.ts';
import { customerWorkspaceKey } from './customer-target.mjs';

export class CustomerTransportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new CustomerTransportError(code, message); };
const parse = (row) => row ? JSON.parse(row.body) : undefined;
export const customerCommandId = (sessionId, method, key) => `remote-${createHash('sha256').update(JSON.stringify([sessionId, method, key])).digest('hex')}`;

/** 运维只读导出原 NULL/open 的公开事实；原 input 仅在内存中计算完整命令指纹。 */
function readUnseenOpenCommand(db, expected, inspect = false) {
  if (Number(db.prepare('PRAGMA query_only').get().query_only) !== 1) fail('READ_ONLY_REQUIRED', '导出必须使用只读数据库连接');
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT id,session_id,body,receipt FROM customer_transport_commands WHERE id=?').get(expected.commandId);
    const saved = db.prepare('SELECT id,device_id,thread_id,body FROM customer_transport_sessions WHERE id=?').get(expected.sessionId);
    if (!row || !saved || row.session_id !== expected.sessionId || row.receipt !== null) fail('UNSEEN_OPEN_REQUIRED', '只允许核实原收据缺失的未报告 open 命令');
    let command, session;
    try {
      if (Buffer.byteLength(row.body) > 1024 * 1024 || Buffer.byteLength(saved.body) > 1024 * 1024) throw Error();
      command = JSON.parse(row.body); session = JSON.parse(saved.body);
      decodeCustomerAgentServerFrame(row.body);
    } catch { fail('ORIGINAL_COMMAND_INVALID', '原命令或会话合同不完整'); }
    const scope = command.executionScope;
    if (command.type !== 'command' || command.method !== 'openSession' || command.commandId !== row.id || command.sessionId !== saved.id || session.sessionId !== saved.id || command.runtimeEpoch !== undefined || session.runtimeEpoch != null || session.providerSession != null || session.providerThreadId != null || !scope) fail('UNSEEN_OPEN_REQUIRED', '仅无运行代次的原共享 open 可以使用此人工核实入口');
    // 缺少代次不能抹去已有运行痕迹；异常历史必须留给原运行恢复流程核实。
    if ((session.state !== undefined && session.state !== 'idle') || ['runs', 'nodeIds', 'nodeBindings', 'entityBindings', 'providerTurnBindings'].some(key => session[key] !== undefined && (!Array.isArray(session[key]) || session[key].length > 0)) || ['pendingInterrupt', 'resolution', 'appliedResolution'].some(key => session[key] != null)) fail('UNSEEN_OPEN_REQUIRED', '原会话已有运行、控制或人工核实历史，不能使用未报告 open 入口');
    if (session.deviceId !== saved.device_id || session.threadId !== saved.thread_id || scope.actorId !== session.ownerId || scope.providerId !== session.providerId || scope.projectId !== session.projectId || scope.threadId !== session.threadId || scope.target.deviceId !== session.deviceId || canonicalCustomerCommand(scope) !== canonicalCustomerCommand(session.executionScope) || canonicalCustomerCommand(command.target) !== canonicalCustomerCommand(session.target) || canonicalCustomerCommand({ kind: 'customer', deviceId: session.deviceId, ...command.target }) !== canonicalCustomerCommand(scope.target)) fail('ORIGINAL_SCOPE_CHANGED', '原设备、提供者、会话、授权或登记目标不一致');
    if (db.prepare('SELECT 1 FROM customer_transport_commands WHERE session_id=? AND id<>? LIMIT 1').get(saved.id, row.id) || db.prepare('SELECT 1 FROM customer_transport_events WHERE session_id=? LIMIT 1').get(saved.id) || db.prepare('SELECT 1 FROM customer_transport_cursors WHERE session_id=? LIMIT 1').get(saved.id)) fail('UNSEEN_OPEN_REQUIRED', '该会话已有其他命令或运行历史，须使用原运行恢复流程');
    if (db.prepare('SELECT 1 FROM customer_workspace_leases WHERE thread_id=? OR workspace_key=? LIMIT 1').get(session.threadId, customerWorkspaceKey(scope.target))) fail('ORIGINAL_WORKSPACE_BUSY', '原线程或登记目标仍有运行占用，不能据此人工收束命令');
    const value = decodeUnseenOpenCommandExport({ format: 'autoops-unseen-open-command-v1', method: 'openSession', receipt: 'missing', commandId: command.commandId, sessionId: command.sessionId, deviceId: session.deviceId, providerId: scope.providerId, threadId: scope.threadId, grantId: scope.grantId, commandFingerprint: createHash('sha256').update(canonicalCustomerCommand(command)).digest('hex'), executionScope: scope, exportedAt: new Date().toISOString() });
    if (!matchesUnseenOpenIdentity(value, inspect ? { ...expected, commandFingerprint: value.commandFingerprint } : expected)) fail('ORIGINAL_IDENTITY_MISMATCH', '指定标识与原命令完整指纹不一致');
    db.exec('COMMIT'); return value;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function exportUnseenOpenCommand(db, expected) { return readUnseenOpenCommand(db, expected); }
/** 公开指纹核对阶段；不返回原 input，也不省略随后导出的指纹确认。 */
export function inspectUnseenOpenCommand(db, expected) {
  const value = readUnseenOpenCommand(db, expected, true);
  const { commandId, sessionId, deviceId, providerId, threadId, grantId, commandFingerprint } = value;
  return { commandId, sessionId, deviceId, providerId, threadId, grantId, commandFingerprint };
}

/** Durable, bounded, ordered inbox; no prompt replay and no second task queue. */
export function createCustomerTransportJournal(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_transport_sessions (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, thread_id TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customer_transport_commands (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL, receipt TEXT
    );
    CREATE TABLE IF NOT EXISTS customer_transport_events (
      session_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(session_id, epoch, seq)
    );
    CREATE TABLE IF NOT EXISTS customer_transport_cursors (
      session_id TEXT NOT NULL, epoch TEXT NOT NULL, received INTEGER NOT NULL DEFAULT 0,
      applied INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, epoch)
    );
    CREATE TABLE IF NOT EXISTS customer_workspace_leases (
      workspace_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, thread_id TEXT NOT NULL
    );
  `);
  if (!db.prepare('PRAGMA table_info(customer_transport_events)').all().some(column=>column.name==='processed'))
    db.exec('ALTER TABLE customer_transport_events ADD COLUMN processed INTEGER NOT NULL DEFAULT 0');
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    acquireWorkspace(workspaceKey,threadId,runId) {
      db.prepare('INSERT OR IGNORE INTO customer_workspace_leases(workspace_key,thread_id,run_id) VALUES(?,?,?)').run(workspaceKey,threadId,runId);
      const current=db.prepare('SELECT thread_id,run_id FROM customer_workspace_leases WHERE workspace_key=?').get(workspaceKey);
      return current.thread_id===threadId && current.run_id===runId;
    },
    releaseWorkspace(workspaceKey,runId) {return db.prepare('DELETE FROM customer_workspace_leases WHERE workspace_key=? AND run_id=?').run(workspaceKey,runId).changes>0;},
    session: id => parse(db.prepare('SELECT body FROM customer_transport_sessions WHERE id=?').get(id)),
    sessions: deviceId => db.prepare('SELECT body FROM customer_transport_sessions WHERE device_id=?').all(deviceId).map(parse),
    saveSession(value) {
      const old = this.session(value.sessionId);
      if (old && (old.deviceId !== value.deviceId || old.threadId !== value.threadId || old.ownerId !== value.ownerId || old.projectId !== value.projectId || old.providerId !== value.providerId || sharedSessionIdentity(old.executionScope) !== sharedSessionIdentity(value.executionScope) || JSON.stringify(old.target) !== JSON.stringify(value.target)))
        fail('SESSION_SCOPE_CHANGED', '客户会话的设备和工作区不能更换');
      db.prepare('INSERT INTO customer_transport_sessions(id,device_id,thread_id,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
        .run(value.sessionId, value.deviceId, value.threadId, JSON.stringify(value));
    },
    command: id => {
      const row = db.prepare('SELECT body,receipt FROM customer_transport_commands WHERE id=?').get(id);
      return row ? { command: JSON.parse(row.body), receipt: row.receipt ? JSON.parse(row.receipt) : undefined } : undefined;
    },
    saveCommand(command) {
      const old = this.command(command.commandId);
      if (old && JSON.stringify(old.command) !== JSON.stringify(command)) fail('COMMAND_CONFLICT', '客户命令身份冲突');
      db.prepare('INSERT OR IGNORE INTO customer_transport_commands(id,session_id,body) VALUES(?,?,?)').run(command.commandId,command.sessionId,JSON.stringify(command));
      return old;
    },
    saveReceipt(receipt) {
      const old = this.command(receipt.commandId);
      if (!old || old.command.sessionId !== receipt.sessionId) fail('UNKNOWN_COMMAND', '未知客户命令回执');
      if (old.command.executionScope?.grantId !== receipt.grantId) fail('RECEIPT_SCOPE_CHANGED', '客户回执不属于原命令固定执行范围');
      if (old.receipt && ['completed','failed','unknown'].includes(old.receipt.state)) return old.receipt;
      db.prepare('UPDATE customer_transport_commands SET receipt=? WHERE id=?').run(JSON.stringify(receipt),receipt.commandId);
      return receipt;
    },
    /** 只用于同设备已查询原收据的人工停止核实，不接受设备把未知结果声称为成功。 */
    reconcileStoppedReceipt(receipt, query) {
      return transaction(() => {
        const old=this.command(receipt.commandId),session=this.session(query.sessionId);
        if(!old||old.command.sessionId!==receipt.sessionId||query.sessionId!==receipt.sessionId)fail('UNKNOWN_COMMAND','原客户命令范围不匹配');
        if(old.command.executionScope?.grantId!==receipt.grantId)fail('RECEIPT_SCOPE_CHANGED','客户回执不属于原命令固定执行范围');
        if(old.receipt&&['completed','failed'].includes(old.receipt.state))return old.receipt;
        if(!old.receipt||old.receipt.state!=='unknown'||receipt.type!=='receipt'||receipt.state!=='failed'||receipt.result!==undefined||receipt.error?.code!=='CUSTOMER_MANUALLY_RECONCILED'||typeof receipt.error.message!=='string'||!receipt.error.message.trim()||receipt.error.message.length>2000)fail('RECEIPT_RECONCILIATION_INVALID','仅原命令合法的人工停止失败收据可收束未知结果');
        if(!query.runtimeEpoch||receipt.runtimeEpoch!==query.runtimeEpoch||session?.runtimeEpoch!==query.runtimeEpoch||(old.command.runtimeEpoch!==undefined&&old.command.runtimeEpoch!==query.runtimeEpoch))fail('RUNTIME_EPOCH','人工核实收据不属于原运行代次');
        db.prepare('UPDATE customer_transport_commands SET receipt=? WHERE id=?').run(JSON.stringify(receipt),receipt.commandId);
        return receipt;
      });
    },
    // 有界只读查询，与执行重放列表严格分开；unknown永远不进pendingCommands。
    unknownCommands: sessionId => db.prepare("SELECT body FROM customer_transport_commands WHERE session_id=? AND json_extract(receipt,'$.state')='unknown' ORDER BY rowid LIMIT 64").all(sessionId).map(parse),
    pendingCommands: sessionId => db.prepare('SELECT body,receipt FROM customer_transport_commands WHERE session_id=? ORDER BY rowid').all(sessionId)
      .filter(row => !row.receipt || JSON.parse(row.receipt).state === 'accepted').map(row => JSON.parse(row.body)),
    cursor: (sessionId, epoch) => ({...(db.prepare('SELECT received,applied FROM customer_transport_cursors WHERE session_id=? AND epoch=?').get(sessionId,epoch) ?? {received:0,applied:0})}),
    receive(sessionId,epoch,events) {
      return transaction(() => {
        db.prepare('INSERT OR IGNORE INTO customer_transport_cursors(session_id,epoch) VALUES(?,?)').run(sessionId,epoch);
        let {received} = this.cursor(sessionId,epoch);
        const pendingBytes = Number(db.prepare('SELECT COALESCE(SUM(length(body)),0) AS size FROM customer_transport_events WHERE session_id=?').get(sessionId).size);
        const newBytes = events.filter(event => event.seq > received).reduce((sum,event)=>sum+Buffer.byteLength(JSON.stringify(event.event)),0);
        if (pendingBytes + newBytes > 64*1024*1024) fail('INBOX_FULL', '客户事件等待处理，请恢复中心服务后重连');
        for (const entry of events) {
          if (entry.seq <= received) continue;
          if (entry.seq !== received + 1) fail('EVENT_GAP', '客户事件序列不连续，需要补传');
          db.prepare('INSERT INTO customer_transport_events(session_id,epoch,seq,body) VALUES(?,?,?,?)').run(sessionId,epoch,entry.seq,JSON.stringify(entry.event));
          received = entry.seq;
        }
        db.prepare('UPDATE customer_transport_cursors SET received=? WHERE session_id=? AND epoch=?').run(received,sessionId,epoch);
        return received;
      });
    },
    events: (sessionId,epoch,afterSeq) => db.prepare('SELECT seq,body FROM customer_transport_events WHERE session_id=? AND epoch=? AND seq>? ORDER BY seq LIMIT 128').all(sessionId,epoch,afterSeq).map(row=>({seq:Number(row.seq),event:JSON.parse(row.body)})),
    applied(sessionId,epoch,seq) {
      return transaction(() => {
        const cursor = this.cursor(sessionId,epoch);
        if (seq <= cursor.applied) return cursor.applied;
        if (seq > cursor.received) fail('ACK_GAP','不能确认尚未收到的客户事件');
        db.prepare('UPDATE customer_transport_events SET processed=1 WHERE session_id=? AND epoch=? AND seq=?').run(sessionId,epoch,seq);
        const first = db.prepare('SELECT MIN(seq) AS seq FROM customer_transport_events WHERE session_id=? AND epoch=? AND processed=0').get(sessionId,epoch).seq;
        const applied = first === null ? cursor.received : Number(first)-1;
        db.prepare('UPDATE customer_transport_cursors SET applied=? WHERE session_id=? AND epoch=?').run(applied,sessionId,epoch);
        db.prepare('DELETE FROM customer_transport_events WHERE session_id=? AND epoch=? AND seq<=?').run(sessionId,epoch,applied);
        return applied;
      });
    },
  };
}
