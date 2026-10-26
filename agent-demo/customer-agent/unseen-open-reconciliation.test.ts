import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as transport from '../t3-adapters/customer-transport.mjs';
import { CustomerAgentStore } from './store.ts';
import { main, readUnseenOpenCommandFile, writeCredentials, acquireProcessLock } from './cli.ts';
import { CustomerAgentConnection } from './connection.ts';
import { CustomerAgentExecutor } from './executor.ts';
import { createCustomerRegistry } from '../t3-adapters/customer-registry.mjs';
import { RemoteDeviceHub } from '../../vendor/t3code/apps/server/src/autoops/RemoteDeviceService.ts';
import { NodeWS } from '../../vendor/t3code/apps/server/node_modules/@effect/platform-node-shared/dist/NodeSocket.js';
import { decodeCustomerAgentClientFrame } from '../../vendor/t3code/packages/contracts/src/autoopsRemote.ts';
import { canonicalCustomerCommand } from '../../autoops/contracts/customer-command-reconciliation.ts';

const exportCli = (args: string[]) => console.log(execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/export-customer-unseen-open.mjs', import.meta.url)), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoops-unseen-reconciliation-')));
  const source = join(root, 'source'); mkdirSync(source);
  const store = new CustomerAgentStore(join(root, 'state'));
  const workspace = store.register(source, 'fixture-source', '隔离目录');
  const target = { registeredWorkspaceId: workspace.registeredWorkspaceId, workspaceBindingRevision: 1, runtimeId: 'codex' as const };
  const scope = {
    grantId: 'fixture-grant', actorId: 'fixture-caller', providerId: 'fixture-provider', projectId: 'fixture-business', sourceProjectId: 'fixture-source', threadId: 'fixture-thread',
    runId: 'fixture-run', assistantId: 'fixture-assistant', presetRevision: 1, shareRevision: 1,
    allocation: { kind: 'member' as const, id: 'fixture-caller', revision: 1 }, capabilityRevision: 'fixture-capability',
    profile: { id: 'fixture-profile', revision: 1, digest: 'a'.repeat(64), imageDigest: `sha256:${'b'.repeat(64)}`, policy: 'linux-docker-readonly-v1' as const },
    target: { kind: 'customer' as const, deviceId: 'fixture-device', ...target },
    model: { instanceId: 'customer-fixture-device-codex', model: 'fixture-model', reasoningEffort: 'medium' as const }, skillIds: [],
  };
  const session = { sessionId: 'fixture-session', deviceId: 'fixture-device', ownerId: scope.actorId, providerId: scope.providerId, projectId: scope.projectId, threadId: scope.threadId, target, executionScope: scope };
  const command = { type: 'command' as const, commandId: 'fixture-command', sessionId: session.sessionId, target, method: 'openSession' as const, executionScope: scope, input: { privatePrompt: 'fixture-input-must-stay-in-ram' } };
  const db = new DatabaseSync(':memory:'); const journal = transport.createCustomerTransportJournal(db);
  journal.saveSession(session); journal.saveCommand(command);
  const expected = { commandId: command.commandId, sessionId: session.sessionId, deviceId: session.deviceId, providerId: session.providerId, threadId: session.threadId, grantId: scope.grantId, commandFingerprint: store.commandHash(command) };
  return { root, store, workspace, db, journal, command, session, scope, expected, close() { store.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('只读导出不含原input，正式人工中止留下无假会话和epoch的原命令tombstone', () => {
  const f = fixture();
  try {
    f.db.exec('PRAGMA query_only=ON');
    const envelope = transport.exportUnseenOpenCommand(f.db, f.expected);
    assert.equal(JSON.stringify(envelope).includes('fixture-input-must-stay-in-ram'), false);
    const receipt = f.store.reconcileUnseenOpen(envelope, f.expected, true);
    assert.equal(receipt.state, 'failed'); assert.equal(receipt.runtimeEpoch, undefined);
    assert.equal(receipt.error?.code, 'CUSTOMER_MANUALLY_RECONCILED');
    assert.deepEqual(f.store.receipt(f.command), receipt);
    assert.equal(f.store.sessions().length, 0); assert.equal(f.store.pendingReceipts().length, 0);
    f.store.recoverAfterRestart(); assert.deepEqual(f.store.receipt(f.command), receipt);
    assert.equal(f.journal.command(f.command.commandId)?.receipt, undefined);
  } finally { f.close(); }
});

test('导出拒绝非只读、非NULL、旧epoch、非open和任何原范围或指纹不一致', async t => {
  for (const kind of ['writable', 'accepted', 'unknown', 'failed', 'completed', 'epoch', 'providerSession', 'method', 'commandId', 'sessionId', 'deviceId', 'providerId', 'threadId', 'grantId', 'commandFingerprint', 'scope', 'target', 'otherCommand', 'event', 'threadLease', 'targetLease']) await t.test(kind, () => {
    const f = fixture();
    try {
      if (['accepted', 'unknown', 'failed', 'completed'].includes(kind)) f.journal.saveReceipt({ type: 'receipt', commandId: f.command.commandId, sessionId: f.session.sessionId, grantId: f.scope.grantId, state: kind as 'failed' });
      if (kind === 'epoch') f.journal.saveSession({ ...f.session, runtimeEpoch: 'old-epoch' });
      if (kind === 'providerSession') f.journal.saveSession({ ...f.session, providerSession: {} });
      if (['method', 'scope', 'target'].includes(kind)) {
        const altered = structuredClone(f.command);
        if (kind === 'method') (altered as any).method = 'resumeThread';
        if (kind === 'scope') altered.executionScope.actorId = 'other-caller';
        if (kind === 'target') altered.target.workspaceBindingRevision++;
        f.db.prepare('UPDATE customer_transport_commands SET body=?').run(JSON.stringify(altered));
      }
      if (kind === 'otherCommand') f.journal.saveCommand({ ...f.command, commandId: 'other-command' });
      if (kind === 'event') f.journal.receive(f.session.sessionId, 'old-epoch', [{ seq: 1, event: {} }]);
      if (kind === 'threadLease') f.journal.acquireWorkspace('different-target', f.scope.threadId, 'still-owned-run');
      if (kind === 'targetLease') f.journal.acquireWorkspace(`${f.session.deviceId}/${f.workspace.registeredWorkspaceId}/1`, 'other-thread', 'still-owned-run');
      const expected = { ...f.expected };
      if (Object.hasOwn(expected, kind)) (expected as any)[kind] = kind === 'commandFingerprint' ? '0'.repeat(64) : 'other-identity';
      if (kind !== 'writable') f.db.exec('PRAGMA query_only=ON');
      assert.throws(() => transport.exportUnseenOpenCommand(f.db, expected));
      assert.equal(f.store.sessions().length, 0); assert.equal(f.store.pendingReceipts().length, 0);
    } finally { f.close(); }
  });
});

test('本机确认拒绝缺确认、跨身份范围、登记修订和任何已有原命令/会话/活动', async t => {
  for (const kind of ['confirmation', 'commandId', 'sessionId', 'deviceId', 'providerId', 'threadId', 'grantId', 'commandFingerprint', 'targetRevision', 'sourceProject', 'session', 'command', 'lock', 'stream', 'event', 'resolution', 'active']) await t.test(kind, () => {
    const f = fixture();
    try {
      f.db.exec('PRAGMA query_only=ON'); const value = transport.exportUnseenOpenCommand(f.db, f.expected), expected = { ...f.expected };
      if (Object.hasOwn(expected, kind)) (expected as any)[kind] = kind === 'commandFingerprint' ? '0'.repeat(64) : 'other-identity';
      if (kind === 'targetRevision') (value.executionScope.target as { workspaceBindingRevision: number }).workspaceBindingRevision++;
      if (kind === 'sourceProject') (value.executionScope as { sourceProjectId: string }).sourceProjectId = 'other-source';
      if (kind === 'command') f.store.accept(f.command);
      if (kind === 'lock') f.store.acquireWorkspace(f.workspace.registeredWorkspaceId, 'other-session', 'other-run');
      if (kind === 'stream') f.store.db.prepare('INSERT INTO streams(session_id,epoch) VALUES(?,?)').run(f.session.sessionId, 'old-epoch');
      if (kind === 'event') f.store.appendEvent(f.session.sessionId, 'old-epoch', {});
      if (kind === 'resolution') f.store.db.prepare('INSERT INTO reconciliations(session_id,epoch,payload) VALUES(?,?,?)').run(f.session.sessionId, 'old-epoch', '{}');
      if (kind === 'session' || kind === 'active') f.store.saveSession({ sessionId: kind === 'session' ? f.session.sessionId : 'other-session', runtimeEpoch: 'old-epoch', workspaceId: f.workspace.registeredWorkspaceId, state: kind === 'active' ? 'active' : 'idle', nativeThreadId: null, nativeTurnId: null, runId: null, attemptId: null });
      assert.throws(() => f.store.reconcileUnseenOpen(value, expected, kind !== 'confirmation'));
      assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM command_reconciliations').get()!.n), 0);
    } finally { f.close(); }
  });
});

test('原NULL/open无epoch仍须逐项拒绝会话运行和人工核实历史', async t => {
  const traces = {
    active: { state: 'active' }, unknown: { state: 'unknown' },
    runs: { runs: [{ runId: 'fixture-run-trace', attemptId: 'fixture-attempt-trace', rootNodeId: 'node', runOrdinal: 1, providerTurnOrdinal: 1 }] },
    nodeIds: { nodeIds: ['node'] }, nodeBindings: { nodeBindings: [{ id: 'node', runId: 'fixture-run-trace' }] },
    entityBindings: { entityBindings: [{ kind: 'message', id: 'message', runId: 'fixture-run-trace' }] },
    providerTurnBindings: { providerTurnBindings: [{ id: 'turn', runId: 'fixture-run-trace', attemptId: 'fixture-attempt-trace', ordinal: 1 }] },
    pendingInterrupt: { pendingInterrupt: { runId: 'fixture-run-trace', attemptId: 'fixture-attempt-trace', requestedAt: new Date().toISOString() } },
    resolution: { resolution: { runId: 'fixture-run-trace', attemptId: 'fixture-attempt-trace', resolvedAt: new Date().toISOString(), reason: 'operator_confirmed_process_stopped' } },
    appliedResolution: { appliedResolution: { runId: 'fixture-run-trace', attemptId: 'fixture-attempt-trace', resolvedAt: new Date().toISOString(), reason: 'operator_confirmed_process_stopped' } },
  };
  for (const [name, trace] of Object.entries(traces)) await t.test(name, () => {
    const f = fixture();
    try {
      f.journal.saveSession({ ...f.session, ...trace } as transport.TransportSession); f.db.exec('PRAGMA query_only=ON');
      assert.throws(() => transport.exportUnseenOpenCommand(f.db, f.expected), { code: 'UNSEEN_OPEN_REQUIRED' });
      assert.throws(() => transport.inspectUnseenOpenCommand(f.db, f.expected), { code: 'UNSEEN_OPEN_REQUIRED' });
      assert.equal(f.journal.command(f.command.commandId)?.receipt, undefined);
    } finally { f.close(); }
  });
});

test('原idle和空history数组可导出，空数组不误作实际运行证据', () => {
  const f = fixture();
  try {
    f.journal.saveSession({ ...f.session, state: 'idle', runs: [], nodeIds: [], nodeBindings: [], entityBindings: [], providerTurnBindings: [] });
    f.db.exec('PRAGMA query_only=ON'); assert.equal(transport.exportUnseenOpenCommand(f.db, f.expected).commandFingerprint, f.expected.commandFingerprint);
  } finally { f.close(); }
});

test('未来同ID返回原failed，篡改同ID拒绝且绝不进入runner或授权', async () => {
  const f = fixture(); let starts = 0, admissions = 0;
  const executor = new CustomerAgentExecutor({ store: f.store, deviceId: f.session.deviceId, runnerFactory: async () => { starts++; throw Error('不应执行'); }, authorizeShared: async () => { admissions++; }, notify() {} });
  try {
    f.db.exec('PRAGMA query_only=ON'); f.store.reconcileUnseenOpen(transport.exportUnseenOpenCommand(f.db, f.expected), f.expected, true);
    const original = f.store.receipt(f.command);
    assert.deepEqual(await executor.execute(f.command), original);
    const tampered = await executor.execute({ ...f.command, input: { changed: true } });
    assert.equal(tampered.error?.code, 'command_id_conflict');
    assert.deepEqual(f.store.receipt(f.command), original); assert.equal(starts, 0); assert.equal(admissions, 0);
  } finally { await executor.close(); f.close(); }
});

test('运维默认零动作，执行只读原库并独占0600输出，原input不落文件或stdout', () => {
  const f = fixture(); const oldLog = console.log, logs: string[] = []; console.log = value => { logs.push(String(value)); };
  try {
    exportCli(['--database', '/nonexistent-fixture', '--output', '/nonexistent-fixture']);
    const database = join(f.root, 'central.sqlite'), output = join(f.root, 'original.json');
    const db = new DatabaseSync(database), journal = transport.createCustomerTransportJournal(db); journal.saveSession(f.session); journal.saveCommand(f.command); db.close();
    const before = createHash('sha256').update(readFileSync(database)).digest('hex');
    const locator = ['--execute', '--database', database, '--command', f.expected.commandId, '--session', f.expected.sessionId, '--device', f.expected.deviceId, '--provider', f.expected.providerId, '--thread', f.expected.threadId, '--grant', f.expected.grantId];
    exportCli([...locator, '--inspect']);
    const inspected = JSON.parse(logs.at(-1)!); assert.equal(inspected.commandFingerprint, f.expected.commandFingerprint); assert.equal(inspected.readOnly, true);
    assert.equal(logs.at(-1)!.includes('fixture-input-must-stay-in-ram'), false);
    const args = [...locator, '--output', output, '--fingerprint', inspected.commandFingerprint];
    exportCli(args); assert.throws(() => exportCli(args), /原命令公开事实导出失败/);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(createHash('sha256').update(readFileSync(database)).digest('hex'), before);
    const text = readFileSync(output, 'utf8'); assert.equal(text.includes('fixture-input-must-stay-in-ram'), false); assert.equal(text.includes('"input"'), false);
    assert.equal(logs.join('\n').includes('fixture-input-must-stay-in-ram'), false);
    assert.equal(readUnseenOpenCommandFile(output).commandFingerprint, f.expected.commandFingerprint);
  } finally { console.log = oldLog; f.close(); }
});

test('独立人工中止列表最多64条且永久保护历史，不挤入未知pending或超出welcome队列', () => {
  const f = fixture();
  try {
    f.db.exec('PRAGMA query_only=ON'); const original = transport.exportUnseenOpenCommand(f.db, f.expected);
    for (let index = 0; index < 64; index++) {
      const command = { ...f.command, commandId: `fixture-command-${index}`, sessionId: `fixture-session-${index}` };
      const value = { ...original, commandId: command.commandId, sessionId: command.sessionId, commandFingerprint: f.store.commandHash(command) };
      const expected = { ...f.expected, commandId: value.commandId, sessionId: value.sessionId, commandFingerprint: value.commandFingerprint };
      f.store.reconcileUnseenOpen(value, expected, true);
    }
    assert.equal(f.store.manuallyReconciledOpenReceipts().length, 64); assert.equal(f.store.pendingReceipts().length, 0);
    assert.throws(() => f.store.reconcileUnseenOpen(original, f.expected, true), { code: 'manual_reconciliation_full' });
    f.store.recoverAfterRestart(); assert.equal(f.store.manuallyReconciledOpenReceipts().length, 64);
    assert.ok(f.store.logBytes() > 64 * 1000);
  } finally { f.close(); }
});

test('正式CLI逐项确认原身份，已有run锁、错设备和错登记拒绝，成功只落原tombstone', async () => {
  const f = fixture();
  try {
    f.db.exec('PRAGMA query_only=ON'); const file = join(f.root, 'original.json'); writeFileSync(file, JSON.stringify(transport.exportUnseenOpenCommand(f.db, f.expected)), { mode: 0o600 });
    writeCredentials(f.store.directory, { deviceId: f.session.deviceId, token: 'fictional-device-token', baseUrl: 'http://127.0.0.1:1' });
    const args = ['resolve', '--state-dir', f.store.directory, '--command-file', file, '--command', f.expected.commandId, '--session', f.expected.sessionId, '--provider', f.expected.providerId, '--thread', f.expected.threadId, '--grant', f.expected.grantId, '--workspace', f.workspace.registeredWorkspaceId, '--fingerprint', f.expected.commandFingerprint, '--confirm-stopped'];
    await assert.rejects(main(args.slice(0, -1)), { code: 'confirmation_required' });
    const release = acquireProcessLock(f.store.directory);
    try { await assert.rejects(main(args), /已有连接程序运行/); } finally { release(); }
    writeCredentials(f.store.directory, { deviceId: 'other-device', token: 'fictional-other-token', baseUrl: 'http://127.0.0.1:1' });
    await assert.rejects(main(args), { code: 'original_identity_mismatch' });
    writeCredentials(f.store.directory, { deviceId: f.session.deviceId, token: 'fictional-device-token', baseUrl: 'http://127.0.0.1:1' });
    const wrong = [...args]; wrong[wrong.indexOf('--workspace') + 1] = 'other-workspace'; await assert.rejects(main(wrong), { code: 'original_identity_mismatch' });
    await main(args); assert.equal(f.store.receipt(f.command)?.state, 'failed'); assert.equal(f.store.sessions().length, 0);
    await assert.rejects(main(args), { code: 'original_local_history_exists' });
  } finally { f.close(); }
});

test('导入文件拒绝符号链接、宽权限、超限、额外字段和FIFO且不会等待写端', { timeout: 3000 }, () => {
  const f = fixture();
  try {
    f.db.exec('PRAGMA query_only=ON'); const file = join(f.root, 'original.json'), value = transport.exportUnseenOpenCommand(f.db, f.expected);
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); const link = join(f.root, 'alias.json'); symlinkSync(file, link); assert.throws(() => readUnseenOpenCommandFile(link));
    chmodSync(file, 0o644); assert.throws(() => readUnseenOpenCommandFile(file)); chmodSync(file, 0o600);
    writeFileSync(file, 'x'.repeat(128 * 1024 + 1)); assert.throws(() => readUnseenOpenCommandFile(file));
    writeFileSync(file, JSON.stringify({ ...value, input: 'not-allowed' })); assert.throws(() => readUnseenOpenCommandFile(file));
    if (process.platform !== 'win32') { const fifo = join(f.root, 'fifo'); execFileSync('mkfifo', [fifo]); assert.throws(() => readUnseenOpenCommandFile(fifo)); }
  } finally { f.close(); }
});

test('canonical提取保持旧账本字节语义，包括嵌套顺序与undefined', () => {
  const old = (value: any): any => Array.isArray(value) ? value.map(old) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, old(item)])) : value;
  for (const value of [{ z: [{ b: 2, a: 1 }], a: { missing: undefined, nil: null } }, { '中文': 1, A: 2, a: 3 }]) assert.equal(canonicalCustomerCommand(value), JSON.stringify(old(value)));
});

test('真实WS沿旧Hub正常接纳原NULL人工failed，无原open、无runner、无假epoch且重启保留', { timeout: 15000 }, async () => {
  const f = fixture(), registryDb = new DatabaseSync(':memory:'), central = new DatabaseSync(':memory:');
  const registry = createCustomerRegistry({ db: registryDb, enabled: () => true, requireOwner() {}, requireProjectForUser() {} });
  const paired = registry.consumePairing(registry.createPairing(f.scope.providerId).pairingCode, { label: '虚构恢复设备' }), principal = registry.authenticateToken(paired.deviceToken);
  f.store.markPublished(f.workspace.registeredWorkspaceId);
  registry.registerWorkspace(principal, { registeredWorkspaceId: f.workspace.registeredWorkspaceId, projectId: f.workspace.projectId, label: '虚构目录', workspaceBindingRevision: 1, runtimeId: 'codex' });
  f.scope.target.deviceId = paired.device.id; f.session.deviceId = paired.device.id; f.expected.deviceId = paired.device.id; f.expected.commandFingerprint = f.store.commandHash(f.command);
  const journal = transport.createCustomerTransportJournal(central); journal.saveSession(f.session); journal.saveCommand(f.command); central.exec('PRAGMA query_only=ON');
  const value = transport.exportUnseenOpenCommand(central, f.expected); central.exec('PRAGMA query_only=OFF');
  f.store.reconcileUnseenOpen(value, f.expected, true); f.store.recoverAfterRestart();
  let starts = 0, admission = 0;
  const hub = new RemoteDeviceHub({ assertAccepting() {}, customerRegistry: registry, requireSharedExecutionScope() { admission++; throw Error('不应准入新执行'); } } as never, journal);
  const server = createServer(), wss = new NodeWS.WebSocketServer({ server }), done = Promise.withResolvers<void>(), sent: any[] = [], received: any[] = [];
  wss.on('connection', (socket: InstanceType<typeof NodeWS.WebSocket>, request: IncomingMessage) => {
    const peer = hub.connect(registry.authenticateToken(request.headers.authorization?.slice(7) ?? ''), async frame => { sent.push(frame); socket.send(JSON.stringify(frame)); }, () => socket.close());
    socket.on('message', (raw: unknown) => { const frame = decodeCustomerAgentClientFrame(String(raw)); received.push(frame); void peer.accept(frame).then(() => { if (frame.type === 'receipt' && frame.state === 'failed') done.resolve(); }, done.reject); });
    socket.on('close', () => peer.disconnect());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = new CustomerAgentConnection({ store: f.store, credentials: { deviceId: paired.device.id, token: paired.deviceToken, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, runnerFactory: async () => { starts++; throw Error('不应启动'); } });
  try {
    connection.start(); await done.promise;
    assert.deepEqual(received.find(frame => frame.type === 'hello').sessions, []);
    assert.equal(sent.filter(frame => frame.type === 'command').length, 0); assert.equal(sent.filter(frame => frame.type === 'receiptQuery').length, 0);
    assert.equal(journal.command(f.command.commandId)?.receipt?.state, 'failed'); assert.equal(journal.command(f.command.commandId)?.receipt?.runtimeEpoch, undefined);
    assert.equal(journal.session(f.session.sessionId)?.runtimeEpoch, undefined); assert.equal(f.store.sessions().length, 0);
    assert.equal(starts, 0); assert.equal(admission, 0); assert.equal(journal.pendingCommands(f.session.sessionId).length, 0);
    f.store.recoverAfterRestart(); assert.equal(f.store.receipt(f.command)?.state, 'failed');
  } finally {
    await connection.close(); hub.close(); for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve()));
    registryDb.close(); central.close(); f.close();
  }
});
