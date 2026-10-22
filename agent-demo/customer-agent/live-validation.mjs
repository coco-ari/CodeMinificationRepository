// Explicit, isolated acceptance test. Uses a real installed Codex and a real configured model.
// Run only against an independently started loopback center; never defaults to the deployed demo.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { T3LiveClient } from '../../test/helpers/t3-live-client.mjs';
import { fixedNativeModelCatalog } from '../t3-adapters/native-catalog.mjs';

const origin = process.env.CUSTOMER_LIVE_ORIGIN;
if (!origin || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Set CUSTOMER_LIVE_ORIGIN to an isolated loopback center.');
const root = resolve(import.meta.dirname, '../..');
const base = resolve(process.env.CUSTOMER_LIVE_DIRECTORY || join(root, '.test-artifacts/customer-real/client'));
const keyFile = process.env.CUSTOMER_LIVE_KEY_FILE;
if (!keyFile) throw new Error('Set CUSTOMER_LIVE_KEY_FILE; credentials are read without printing.');
const model = process.env.CUSTOMER_LIVE_MODEL || 'grok-4.6';
const phase = process.env.CUSTOMER_LIVE_PHASE || 'baseline';
const home = join(base, 'customer-home'), state = join(base, 'connector-state');
mkdirSync(base, { recursive: true, mode: 0o700 }); mkdirSync(home, { recursive: true, mode: 0o700 });
writeFileSync(join(base, 'validation.pid'), String(process.pid), { mode: 0o600 });
const fixtureFile = join(base, 'fixture.json');
const fixture = existsSync(fixtureFile) ? JSON.parse(readFileSync(fixtureFile, 'utf8')) : { root: mkdtempSync(join(tmpdir(), 'autoops-customer-live-')), nonce: randomUUID() };
const workspace = join(fixture.root, 'workspace'), external = join(base, 'approval-target');
mkdirSync(workspace, { recursive: true, mode: 0o700 }); mkdirSync(external, { recursive: true, mode: 0o700 });
writeFileSync(fixtureFile, JSON.stringify(fixture), { mode: 0o600 });
writeFileSync(join(workspace, 'source.txt'), `customer-live:${fixture.nonce}\n`, { mode: 0o600 });
const skillDirectory = join(home, 'skills', 'customer-live-check'); mkdirSync(skillDirectory, { recursive: true });
writeFileSync(join(skillDirectory, 'SKILL.md'), '---\nname: customer-live-check\ndescription: 验证真实客户工作区读取和本机技能执行。\n---\n读取当前工作区的 source.txt。创建 skill-result.txt，内容为 LOCAL_SKILL_OK 加上 source.txt 的完整内容。然后确认已完成。\n', { mode: 0o600 });
const catalog = fixedNativeModelCatalog(model);
// This is an explicitly provided, already discovered capability snapshot, not
// platform instructions or credentials. Never invent effort levels for a test.
if (process.env.CUSTOMER_LIVE_CAPABILITIES_FILE) {
  const capability = JSON.parse(readFileSync(process.env.CUSTOMER_LIVE_CAPABILITIES_FILE, 'utf8')).models?.find(entry => entry.id === model);
  if (!capability || !Array.isArray(capability.reasoningLevels) || capability.reasoningLevels.some(value => !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value))) throw new Error('Invalid discovered model capability snapshot');
  Object.assign(catalog.models[0], { supported_reasoning_levels: capability.reasoningLevels.map(effort => ({ effort, description: '' })), supports_reasoning_effort_updates: capability.supportsReasoningEffortUpdates === true, ...(capability.defaultReasoning ? { default_reasoning_level: capability.defaultReasoning } : {}) });
}
Object.assign(catalog.models[0], { base_instructions: 'You are a coding assistant operating in the user-selected local project. Complete requested file operations using actual tools. Keep operations inside the selected workspace unless the user explicitly requests an approval test. Do not fabricate tool results.', shell_type: 'default', apply_patch_tool_type: 'freeform', include_skills_usage_instructions: true });
writeFileSync(join(home, 'models.json'), JSON.stringify(catalog), { mode: 0o600 });
const q = JSON.stringify;
writeFileSync(join(home, 'config.toml'), `model = ${q(model)}\nmodel_provider = "cpa"\nmodel_catalog_json = ${q(join(home, 'models.json'))}\ncli_auth_credentials_store = "ephemeral"\ncheck_for_update_on_startup = false\nweb_search = "disabled"\n[model_providers.cpa]\nname = "CPA"\nbase_url = ${q(process.env.CUSTOMER_LIVE_CPA_URL || 'https://x.996788.xyz/v1')}\nenv_key = "CPA_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 1\nstream_max_retries = 0\n[features]\nshell_tool = true\napps = false\nplugins = false\nmemories = false\nmulti_agent = false\n[skills.bundled]\nenabled = false\n[shell_environment_policy]\ninherit = "core"\nexclude = ["CPA_API_KEY"]\n[projects.${q(workspace)}]\ntrust_level = "trusted"\n`, { mode: 0o600 });
const environment = { ...process.env, CODEX_HOME: home, CPA_API_KEY: readFileSync(keyFile, 'utf8').trim(), PATH: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` };
delete environment.AUTOOPS_T3_DATA_DIR; delete environment.AUTOOPS_T3_CODEX_HOME;
const bundle = join(root, 'dist/customer-agent/autoops-customer-agent.mjs');
const cli = (args) => {
  try { return execFileSync(process.execPath, [bundle, ...args, '--state-dir', state], { cwd: workspace, env: environment, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error(`Customer CLI ${args[0]} failed; sensitive command arguments are withheld.`); }
};
const client = new T3LiveClient(origin), reportFile = join(base, `report-${phase}.json`);
// Keep failed attempts as evidence when a repaired flow is rerun.
if (existsSync(reportFile)) writeFileSync(join(base, `report-${phase}.previous-${Date.now()}.json`), readFileSync(reportFile), { mode: 0o600 });
const report = { kind: 'real-codex-real-cpa-customer-loopback', startedAt: new Date().toISOString(), model, phase, fixtureRoot: fixture.root, steps: [], limitations: ['Loopback transport; WAN latency and browser interactions are separate acceptance checks.'] };
const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let connector, threadId, binding, selection;
async function wait(check, label, timeout = 180000) { const start = Date.now(); while (Date.now() - start < timeout) { const result = await check(); if (result) return result; await sleep(400); } throw new Error(`Timed out: ${label}`); }
const terminal = run => Boolean(run && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status));
const pendingApprovalForActiveRun = p => {
  const run = p.runs.find(r => r.status === 'running');
  const request = run && p.runtimeRequests.find(r => r.status === 'pending' && r.kind === 'command' && p.turnItems.some(item => item.type === 'approval_request' && item.requestId === r.id && item.runId === run.id));
  return request ? { run, request, p } : null;
};
const dispatch = command => client.rpc('orchestration.dispatchCommand', { commandId: randomUUID(), threadId, ...command }, { timeout: 60000 });
const send = (text, dispatchMode = { type: 'start_immediately' }) => dispatch({ type: 'message.dispatch', createdBy: 'user', creationSource: 'web', messageId: randomUUID(), text, attachments: [], modelSelection: selection, dispatchMode });
const settled = () => wait(async () => { const p = await client.projection(threadId); if (p.runs.length && p.runs.every(terminal)) return p; }, 'real run terminal');
const evidence = p => ({ threadId, runs: p.runs.map(r => ({ id: r.id, status: r.status, failure: r.failure })), messages: p.messages.map(m => ({ role: m.role, text: m.text })), tools: p.turnItems.filter(i => /tool|command|file_change/.test(i.type)).map(i => ({ type: i.type, status: i.status, title: i.title })), requests: p.runtimeRequests.map(r => ({ id: r.id, kind: r.kind, status: r.status, decision: r.decision })) });
const localSession = () => { const db = new DatabaseSync(join(state, 'connector.sqlite'), { readOnly: true }); try { return db.prepare('SELECT payload FROM sessions').all().map(row => JSON.parse(row.payload)).find(session => session.sessionId.includes(`:thread:${threadId}:`)); } finally { db.close(); } };
async function step(name, task) { const start = Date.now(); const row = { name, startedAt: new Date(start).toISOString() }; report.steps.push(row); save(); try { row.result = await task(); row.status = 'passed'; } catch (error) { row.status = 'failed'; row.error = error.message; row.detail = error.detail; throw error; } finally { row.completedAt = new Date().toISOString(); row.elapsedMs = Date.now() - start; save(); console.log(JSON.stringify({ name, status: row.status, error: row.error, elapsedMs: row.elapsedMs })); } }
try {
  await client.login(); await client.connect();
  if (!existsSync(join(state, 'device.json'))) { const pairing = await client.http('/autoops/customer/pairings', 'POST', { label: '真实客户验证设备' }); cli(['connect', '--url', origin, '--code', pairing.pairingCode, '--name', '真实客户验证设备']); }
  let status = JSON.parse(cli(['status']));
  if (!status.workspaces.length) { cli(['register', '--project', 'p-autoops', '--path', workspace, '--label', '真实客户开发工作区']); status = JSON.parse(cli(['status'])); }
  const local = status.workspaces[0]; binding = { kind: 'customer', deviceId: status.deviceId, registeredWorkspaceId: local.id, workspaceBindingRevision: 1, runtimeId: 'codex' };
  selection = { instanceId: `customer-${status.deviceId}-codex`, model, ...(process.env.CUSTOMER_LIVE_REASONING_EFFORT ? { options: [{ id: 'reasoningEffort', value: process.env.CUSTOMER_LIVE_REASONING_EFFORT }] } : {}) };
  if (process.env.CUSTOMER_LIVE_USE_EXISTING_CONNECTOR !== '1') {
    const log = openSync(join(base, 'connector.log'), 'a', 0o600);
    connector = spawn(process.execPath, [bundle, 'run', '--state-dir', state], { cwd: workspace, env: environment, stdio: ['ignore', log, log] });
  }
  report.deviceId = status.deviceId; report.workspaceId = local.id; save();
  await wait(async () => { const response = await client.http('/autoops/customer/devices'); return response.devices.some(device => device.id === status.deviceId && device.online); }, 'customer device online', 45000);
  const query = new URLSearchParams(binding); query.delete('kind');
  const capabilities = await wait(async () => { const response = await client.http(`/autoops/customer/capabilities?${query}`); return response.capabilities?.models?.some(m => m.id === model && (!process.env.CUSTOMER_LIVE_REASONING_EFFORT || m.supportedReasoningEfforts.includes(process.env.CUSTOMER_LIVE_REASONING_EFFORT))) ? response.capabilities : null; }, 'real Codex capability discovery', 45000);
  report.capabilities = capabilities; save();
  if (process.env.CUSTOMER_LIVE_REASONING_EFFORT && !capabilities.models.find(m => m.id === model)?.supportedReasoningEfforts.includes(process.env.CUSTOMER_LIVE_REASONING_EFFORT)) throw new Error('Requested reasoning effort was not discovered from this actual customer runner');
  report.modelSelection = selection; save();
  console.log(JSON.stringify({ ready: true, deviceId: status.deviceId, workspaceId: local.id, skillDiscovered: capabilities.skills.some(s => s.name === 'customer-live-check') }));
  const reuseThread = ['controls', 'approval', 'approval-stop', 'steer', 'resume'].includes(phase);
  if (reuseThread) { threadId = process.env.CUSTOMER_LIVE_THREAD_ID || JSON.parse(readFileSync(join(base, 'report-baseline.json'), 'utf8')).threadId; report.threadId = threadId; }
  if (!['setup', 'approval-stop-fresh'].includes(phase) && !reuseThread) await step('real-local-read-write', async () => {
    rmSync(join(workspace, 'output.txt'), { force: true });
    threadId = randomUUID(); report.threadId = threadId;
    await client.http('/autoops/thread-bindings', 'POST', { threadId, projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'private', executionBinding: binding });
    await client.rpc('orchestration.launchThread', { commandId: randomUUID(), threadId, projectId: 'p-autoops', title: '真实客户开发验收', generateTitle: false, modelSelection: selection, runtimeMode: 'approval-required', interactionMode: 'default', workspaceStrategy: { type: 'root' }, initialMessage: { messageId: randomUUID(), text: '请实际读取当前工作区的 source.txt，然后创建 output.txt，内容为 source.txt 的完整内容再追加一行 REAL_WRITE_OK。必须真实操作文件，完成后简短回复。', attachments: [] } }, { timeout: 60000 });
    const p = await settled(); const output = readFileSync(join(workspace, 'output.txt'), 'utf8');
    if (!output.includes(fixture.nonce) || !output.includes('REAL_WRITE_OK') || p.runs.at(-1).status !== 'completed') throw new Error('Actual file effect or completed run missing');
    return { output, ...evidence(p) };
  });
  if (!['setup', 'approval-stop-fresh'].includes(phase) && !reuseThread) await step('real-multi-turn-local-skill', async () => {
    rmSync(join(workspace, 'skill-result.txt'), { force: true });
    await send('$customer-live-check 请使用这个本机技能执行，完成后告诉我它生成的文件名。'); const p = await settled();
    const output = readFileSync(join(workspace, 'skill-result.txt'), 'utf8'); if (!output.includes(fixture.nonce) || !output.includes('LOCAL_SKILL_OK')) throw new Error('Actual local skill file missing');
    return { output, ...evidence(p) };
  });
  if (['full', 'controls'].includes(phase)) {
    await step('queue-and-real-stop', async () => {
      rmSync(join(workspace, 'wait-result.txt'), { force: true });
      await send('请运行 sleep 45，等待命令完成后再创建 wait-result.txt，内容为 FINISHED_WAIT。不要提前回复。');
      const running = await wait(async () => { const p = await client.projection(threadId); const active = p.runs.find(r => r.status === 'running'); return active && p.turnItems.some(i => i.runId === active.id && i.type === 'command_execution' && i.status === 'running') ? active : null; }, 'current native command running');
      const queued = await send('请只回复 QUEUE_RESUMED，不要运行任何工具。', { type: 'queue_after_active' });
      const before = await client.projection(threadId); if (!before.runs.some(r => r.status === 'queued')) throw new Error('Queue was not persisted');
      await dispatch({ type: 'thread.stop' });
      const stopped = await wait(async () => { const p = await client.projection(threadId); return terminal(p.runs.find(r => r.id === running.id)) ? p : null; }, 'actual stopped turn');
      if (existsSync(join(workspace, 'wait-result.txt'))) throw new Error('The stopped command completed its deferred write');
      if (stopped.runs.some(r => r.status === 'queued')) await dispatch({ type: 'queue.resume' });
      const after = await settled();
      if (!after.messages.some(m => m.role === 'assistant' && m.text?.includes('QUEUE_RESUMED'))) throw new Error('Queued follow-up did not execute after resume');
      return { queued, stoppedRunId: running.id, ...evidence(after) };
    });
  }
  if (['full', 'controls', 'approval'].includes(phase)) {
    await step('real-native-approval', async () => {
      const target = join(external, 'approved.txt');
      rmSync(target, { force: true });
      await send(`这是人工审批功能的验证。请通过 shell 在工作区外但仅属于本次测试的路径 ${target} 写入 APPROVED_TEST。请请求提升权限并等待用户审批；不要使用其他路径，不要绕开审批。`);
      const { p, request } = await wait(async () => pendingApprovalForActiveRun(await client.projection(threadId)), 'native approval');
      const item = p.turnItems.find(item => item.type === 'approval_request' && item.requestId === request.id);
      if (!item?.prompt?.includes(target) || !item.prompt.includes('APPROVED_TEST') || /\b(rm|curl|wget|sudo|chmod|chown)\b/.test(item.prompt)) throw new Error('Approval scope differs from the explicitly authorized test write; it was not accepted.');
      await dispatch({ type: 'runtime-request.respond', requestId: request.id, decision: 'accept' });
      const after = await settled(); if (!readFileSync(target, 'utf8').includes('APPROVED_TEST')) throw new Error('Approval did not produce its bounded actual file effect');
      return evidence(after);
    });
  }
  if (['approval-stop', 'approval-stop-fresh'].includes(phase)) await step('real-stop-pending-approval', async () => {
    const target = join(external, phase === 'approval-stop-fresh' ? 'approval-stop-fresh.txt' : 'approval-stop.txt'); rmSync(target, { force: true });
    const text = `验证未审批时停止。请通过 shell 请求提升权限，在 ${target} 写入 MUST_NOT_EXECUTE，等待用户审批；不得改用其他路径或绕开审批。`;
    if (phase === 'approval-stop-fresh') {
      threadId = randomUUID(); report.threadId = threadId; save();
      await client.http('/autoops/thread-bindings', 'POST', { threadId, projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'private', executionBinding: binding });
      await client.rpc('orchestration.launchThread', { commandId: randomUUID(), threadId, projectId: 'p-autoops', title: '客户审批停止最终验收', generateTitle: false, modelSelection: selection, runtimeMode: 'approval-required', interactionMode: 'default', workspaceStrategy: { type: 'root' }, initialMessage: { messageId: randomUUID(), text, attachments: [] } }, { timeout: 60000 });
    } else await send(text);
    const waiting = await wait(async () => pendingApprovalForActiveRun(await client.projection(threadId)), 'native command approval before stop');
    await dispatch({ type: 'thread.stop' }); const after = await settled();
    if (existsSync(target) || after.runs.find(r => r.id === waiting.run.id)?.status !== 'interrupted' || after.runtimeRequests.find(r => r.id === waiting.request.id)?.status !== 'cancelled' || localSession()?.state !== 'idle') throw new Error('Stopping pending approval did not release the real run and request without execution');
    return evidence(after);
  });
  if (phase === 'steer') await step('real-steer-without-new-run', async () => {
    const target = join(workspace, 'steer-result.txt'); rmSync(target, { force: true });
    await send('请实际执行 sleep 20（只传 cmd 参数），等它结束后只回复 ORIGINAL_TARGET，不要创建文件。');
    const active = await wait(async () => { const p = await client.projection(threadId); const run = p.runs.find(r => r.status === 'running'); return run && p.turnItems.some(i => i.runId === run.id && i.type === 'command_execution' && i.status === 'running') ? { run, count: p.runs.length } : null; }, 'running command before steering');
    await send('引导当前轮：把后续目标改为实际读取 source.txt，然后创建 steer-result.txt，内容为 STEER_APPLIED 加上 source.txt 原文。不要再只回复 ORIGINAL_TARGET，不开启新一轮。', { type: 'steer_active', targetRunId: active.run.id });
    const after = await settled(); const output = readFileSync(target, 'utf8');
    if (after.runs.length !== active.count || after.runs.at(-1).id !== active.run.id || !output.includes('STEER_APPLIED') || !output.includes(fixture.nonce)) throw new Error('Steering did not stay within the same run or produce its actual file effect');
    report.nativeThreadId = after.providerThreads.at(-1)?.nativeThreadRef?.nativeId; report.runtimeEpoch = localSession()?.runtimeEpoch;
    return { output, nativeThreadId: report.nativeThreadId, runtimeEpoch: report.runtimeEpoch, ...evidence(after) };
  });
  if (phase === 'resume') await step('real-idle-connector-restart-resume', async () => {
    const prior = JSON.parse(readFileSync(join(base, 'report-steer.json'), 'utf8'));
    if (prior.threadId !== threadId || !prior.nativeThreadId || !prior.runtimeEpoch) throw new Error('Need a completed real steer report for this exact thread before restarting its idle connector');
    const target = join(workspace, 'resumed.txt'); rmSync(target, { force: true });
    await send('继续刚才的对话。请实际读取 source.txt 和 steer-result.txt，然后写入 resumed.txt，内容为 RESUMED_NATIVE_THREAD 加上 source.txt 原文，完成后简短回复。');
    const after = await settled(), output = readFileSync(target, 'utf8'), session = localSession();
    const nativeThreadId = after.providerThreads.at(-1)?.nativeThreadRef?.nativeId;
    if (!output.includes('RESUMED_NATIVE_THREAD') || !output.includes(fixture.nonce) || nativeThreadId !== prior.nativeThreadId || !session || session.runtimeEpoch === prior.runtimeEpoch) throw new Error('Restart did not resume the same native thread in a new process or its actual file effect is missing');
    return { output, oldRuntimeEpoch: prior.runtimeEpoch, runtimeEpoch: session.runtimeEpoch, nativeThreadId, ...evidence(after) };
  });
  if (threadId) {
    const nativeThreadId = (await client.projection(threadId)).providerThreads.at(-1)?.nativeThreadRef?.nativeId;
    const sessionsDirectory = join(home, 'sessions');
    const sessionFile = nativeThreadId && readdirSync(sessionsDirectory, { recursive: true }).find(name => typeof name === 'string' && name.endsWith('.jsonl') && name.includes(nativeThreadId));
    if (sessionFile) {
      const contexts = readFileSync(join(sessionsDirectory, sessionFile), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'turn_context');
      const latest = contexts.at(-1);
      report.nativeContext = { nativeThreadId, nativeTurnId: latest?.payload.turn_id, model: latest?.payload.model, reasoningEffort: latest?.payload.collaboration_mode?.settings?.reasoning_effort ?? null };
      if (process.env.CUSTOMER_LIVE_REASONING_EFFORT && report.nativeContext.reasoningEffort !== process.env.CUSTOMER_LIVE_REASONING_EFFORT) throw new Error('Actual native turn reasoning effort differs from the selected supported value');
    } else if (process.env.CUSTOMER_LIVE_REASONING_EFFORT) throw new Error('Native turn context evidence is missing');
  }
  report.completedAt = new Date().toISOString(); save();
  if (process.env.CUSTOMER_LIVE_HOLD === '1') { console.log('Validation complete; connector retained for independent UI checks.'); await Promise.race([once(process, 'SIGINT'), once(process, 'SIGTERM')]); }
} catch (error) { report.error = error.message; report.detail = error.detail; process.exitCode = 1; if (threadId) { try { report.failureProjection = evidence(await client.projection(threadId)); } catch {} } save(); console.log(JSON.stringify({ failed: true, error: error.message, report: reportFile })); }
finally {
  if (threadId) { try { const p = await client.projection(threadId); if (p.runs.some(r => !terminal(r))) { await dispatch({ type: 'thread.stop' }); await settled(); } } catch {} }
  if (connector) { connector.kill('SIGTERM'); await Promise.race([once(connector, 'exit'), sleep(1500)]); if (connector.exitCode === null) connector.kill('SIGTERM'); }
  client.close(); save();
}
