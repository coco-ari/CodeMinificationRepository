import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

const origin = 'http://192.168.31.157:18887'
const unit = 'autoops-t3-staging-worker.service'
const output = process.env.T3_RESTART_REPORT || '.test-artifacts/t3-live/restart.json'
if (process.env.T3_ALLOW_STAGING_RESTART !== '1' || (process.env.AGENT_DEMO_URL && process.env.AGENT_DEMO_URL !== origin))
  throw new Error('Requires explicit T3_ALLOW_STAGING_RESTART=1 and the isolated staging origin only')
const execute = promisify(execFile), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const terminal = (run) => ['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back'].includes(run?.status)
const sshArgs = ['-S', '/private/tmp/autoops-demo-ssh.sock', '-o', 'UserKnownHostsFile=/private/tmp/autoops-demo-known-hosts', '-o', 'BatchMode=yes', 'tao@192.168.31.157']
const ssh = async (command) => (await execute('ssh', [...sshArgs, command], { timeout: 30000, maxBuffer: 512 * 1024 })).stdout
const report = { kind: 'real-staging-worker-process-group-crash', origin, unit, startedAt: new Date().toISOString(), limitations: ['使用真实 CPA/Grok 和原生 RPC；不等同于浏览器恢复体验', 'SIGKILL 限于隔离 staging worker unit，网关进程保留；不是主机断电或磁盘损坏测试', '补流只核恢复水位和最终核心状态，未逐事件重建全投影'], errors: [] }
let client = new T3LiveClient(origin), threadId, queuedRunId, killed = false
let request, active, queueMessageId, sequence = 0, killedAt
const save = async () => { await mkdir('.test-artifacts/t3-live', { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2)) }
const summary = (p) => ({ threadId: p.thread.id, runs: p.runs.map(({ id, ordinal, status, queueHeld, userMessageId, startedAt, completedAt }) => ({ id, ordinal, status, queueHeld, userMessageId, startedAt, completedAt })), requests: p.runtimeRequests, nativeThreads: p.providerThreads.map(({ id, nativeThreadRef, status }) => ({ id, nativeThreadRef, status })), nativeTurns: p.providerTurns.map(({ id, runId, nativeTurnRef, status }) => ({ id, runId, nativeTurnRef, status })), messages: p.messages.map(({ id, role, runId, text }) => ({ id, role, runId, text: text?.slice(-1200) })) })
const dispatch = (type, fields) => client.rpc('orchestration.dispatchCommand', { type, threadId, commandId: randomUUID(), ...fields }, { timeout: 60000 })
async function waitProjection(predicate, label, timeout = 120000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { const p = await client.projection(threadId); if (predicate(p)) return p; report.lastProjection = summary(p); await sleep(350) }
  throw new Error('Timed out: ' + label)
}
async function serviceState() {
  const raw = await ssh(`systemctl --user show ${unit} --property=MainPID --property=ActiveState --property=SubState --property=NRestarts --property=ControlGroup`)
  return Object.fromEntries(raw.trim().split('\n').map((line) => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
}
function idleGuardScript() {
  assert.match(threadId, /^[a-f0-9-]{36}$/)
  return `python3 - <<'PY'\nimport sqlite3,json\np='/home/tao/autoops-agent-demo/t3-staging-data/t3/userdata/statev2.sqlite'\nc=sqlite3.connect('file:'+p+'?mode=ro',uri=True)\nn=c.execute("SELECT count(*) FROM orchestration_v2_projection_runs WHERE thread_id != ? AND status IN ('preparing','starting','running','waiting')",('${threadId}',)).fetchone()[0]\nc.close()\nprint(json.dumps({'otherActiveStagingRuns':n}))\nif n: raise SystemExit('Other active staging runs exist; refusing crash test')\nPY`
}

try {
  if (process.env.T3_RESTART_CONTINUE_FROM) {
    const previous = JSON.parse(await readFile(process.env.T3_RESTART_CONTINUE_FROM, 'utf8'))
    assert.equal(previous.origin, origin); assert.equal(previous.unit, unit)
    assert.ok(previous.killStartedAt && previous.beforeService?.MainPID && previous.before && previous.cursor > 0)
    threadId = previous.threadId; queuedRunId = previous.queuedRunId; sequence = previous.cursor
    request = { id: previous.requestId }; active = { id: previous.activeRunId }
    queueMessageId = previous.before.runs.find((run) => run.id === queuedRunId)?.userMessageId
    assert.ok(queueMessageId)
    for (const key of ['threadId', 'model', 'before', 'beforeService', 'cursor', 'requestId', 'activeRunId', 'queuedRunId', 'killCommand', 'killStartedAt', 'queueReceipt']) report[key] = previous[key]
    report.initialAttempt = { path: process.env.T3_RESTART_CONTINUE_FROM, status: previous.status, errors: previous.errors }
    report.limitations.push('首次全组SIGKILL返回辅助进程错误；本次只补核同一次已观察到的真实重启，不再次kill或发送模型，不能给出精确恢复延迟')
    killedAt = Date.parse(previous.killStartedAt)
  } else {
  await client.login(); await client.connect(); report.model = client.bootstrap.fixedModel
  ;({ threadId } = await client.createThread('这是一次需要人工确认的独立发布准备讨论。请立即真实调用 ask_user，询问“这次先检查测试环境还是生产环境？”，提供“测试环境”和“生产环境”两个选项。必须停下来等待表单回答，不要默认回答，不读取其他数据，也不要生成文件。', { title: 'A07真实进程重启验收', visibility: 'private' }))
  report.threadId = threadId; await save()
  let p = await waitProjection((p) => p.runtimeRequests.some((r) => r.kind === 'user_input' && r.status === 'pending'), 'actual MCP waiting question')
  request = p.runtimeRequests.find((r) => r.kind === 'user_input' && r.status === 'pending')
  const item = p.turnItems.find((i) => i.type === 'user_input_request' && i.requestId === request.id)
  active = p.runs.find((r) => !terminal(r) && r.status !== 'queued')
  assert.ok(item?.questions[0] && active && p.providerTurns.some((turn) => turn.nativeTurnRef?.nativeId), 'No real pending native form')
  queueMessageId = randomUUID(); const queueCommandId = randomUUID()
  report.queueReceipt = await client.rpc('orchestration.dispatchCommand', { type: 'message.dispatch', threadId, commandId: queueCommandId, messageId: queueMessageId, createdBy: 'user', creationSource: 'web', text: '下一轮请仅回复“队列需要明确恢复后执行”。现在不要提前执行。', attachments: [], modelSelection: client.bootstrap.fixedModel, dispatchMode: { type: 'queue_after_active' } })
  p = await waitProjection((p) => p.runs.some((r) => r.userMessageId === queueMessageId && r.status === 'queued'), 'queued follow-up')
  const queued = p.runs.find((r) => r.userMessageId === queueMessageId)
  queuedRunId = queued.id
  client.rpc('orchestration.subscribeThread', { threadId }, { timeout: 600000, onValue: (event) => { sequence = Math.max(sequence, event.sequence || event.snapshotSequence || event.snapshot?.snapshotSequence || 0) } }).catch(() => {})
  for (let i = 0; i < 40 && sequence === 0; i++) await sleep(100)
  assert.ok(sequence > 0, 'No real positive stream cursor before crash')
  report.before = summary(p); report.cursor = sequence; report.activeRunId = active.id; report.requestId = request.id; report.queuedRunId = queuedRunId
  report.beforeService = await serviceState()
  assert.equal(report.beforeService.ActiveState, 'active')
  assert.ok(Number(report.beforeService.MainPID) > 0)
  const help = await ssh('systemctl --help')
  const whom = help.includes('--kill-whom=') ? '--kill-whom=all' : help.includes('--kill-who=') ? '--kill-who=all' : undefined
  assert.ok(whom, 'systemctl does not advertise a supported whole-unit kill option')
  const killCommand = `systemctl --user kill ${whom} --signal=SIGKILL ${unit}`
  report.killCommand = killCommand; report.killStartedAt = new Date().toISOString(); await save()
  // The idle check and kill execute in one fail-fast remote shell. Neither the
  // production unit nor either production/native data path occurs in it.
  try { report.guard = (await ssh(`set -eu\n${idleGuardScript()}\n${killCommand}`)).trim() }
  catch (error) {
    // Some systemd/container combinations kill the main process but return an
    // auxiliary-process error. Never retry the signal; require PID/restart
    // evidence below, retaining the real command failure in this report.
    report.killCommandError = { code: error.code, stdout: error.stdout, stderr: error.stderr }
    if (!error.stdout?.includes('"otherActiveStagingRuns": 0') || !error.stderr?.includes('Failed to send signal SIGKILL to auxiliary processes')) throw error
  }
  killedAt = Date.now()
  client.close()
  }
  let health
  for (let i = 0; i < 120; i++) {
    try { const response = await fetch(origin + '/api/agent-demo/health', { signal: AbortSignal.timeout(1500) }); if (response.ok) { const body = await response.json(); if (body.engine === 't3' && body.workerReachable === true) { health = body; break } } } catch {}
    await sleep(500)
  }
  assert.ok(health, 'Staging worker did not recover through on-failure restart')
  report.health = health
  report[process.env.T3_RESTART_CONTINUE_FROM ? 'recoveryObservedAfterMs' : 'recoveryMs'] = Date.now() - killedAt
  report.afterService = await serviceState()
  assert.notEqual(report.afterService.MainPID, report.beforeService.MainPID, 'The worker process did not change')
  assert.ok(Number(report.afterService.NRestarts) > Number(report.beforeService.NRestarts), 'No on-failure restart recorded')
  killed = true
  client = new T3LiveClient(origin); await client.login(); await client.connect()
  const replay = []
  client.rpc('orchestration.subscribeThread', { threadId, afterSequence: sequence, requestCompletionMarker: true }, { timeout: 600000, onValue: (event) => replay.push({ kind: event.kind, sequence: event.sequence ?? event.snapshotSequence, type: event.event?.type ?? event.type }) }).catch(() => {})
  let p = await waitProjection((p) => p.runtimeRequests.find((r) => r.id === request.id)?.status !== 'pending' && terminal(p.runs.find((r) => r.id === active.id)), 'startup reconciliation', 60000)
  report.afterRecovery = summary(p)
  const beforeIds = report.before.nativeTurns.map((turn) => turn.id).sort()
  assert.deepEqual(p.providerTurns.map((turn) => turn.id).sort(), beforeIds, 'Crash recovery started a duplicate provider turn')
  const recoveredRequest = p.runtimeRequests.find((r) => r.id === request.id)
  assert.equal(recoveredRequest?.responseCapability?.type, 'not_resumable')
  assert.ok(['expired', 'cancelled'].includes(recoveredRequest.status))
  assert.equal(p.runs.find((r) => r.id === queuedRunId)?.status, 'queued')
  assert.equal(p.runs.find((r) => r.id === queuedRunId)?.queueHeld, true)
  const item = p.turnItems.find((i) => i.type === 'user_input_request' && i.requestId === request.id)
  assert.ok(item?.questions[0], 'Original request question identity was not preserved')
  let lateAccepted = false
  try { await dispatch('runtime-request.respond', { requestId: request.id, answers: { [item.questions[0].id]: ['测试环境'] } }); lateAccepted = true } catch (error) { report.lateAnswerError = { message: error.message, detail: error.detail } }
  assert.equal(lateAccepted, false, 'Expired pre-crash form accepted a late answer')
  await sleep(5000)
  const stable = await client.projection(threadId)
  report.afterFiveSeconds = summary(stable); report.replay = replay
  assert.equal(stable.runs.find((r) => r.id === queuedRunId)?.status, 'queued')
  assert.equal(stable.runs.find((r) => r.id === queuedRunId)?.queueHeld, true)
  assert.deepEqual(stable.providerTurns.map((turn) => turn.id).sort(), beforeIds)
  assert.deepEqual(stable.providerThreads.map((thread) => thread.nativeThreadRef), p.providerThreads.map((thread) => thread.nativeThreadRef))
  assert.equal(stable.messages.filter((m) => m.id === queueMessageId).length, 1)
  assert.ok(replay.length > 0, 'No reconnect stream evidence')
  report.assertions = { workerProcessReplaced: true, automaticOnFailureRestart: true, expiredQuestionRejected: true, activeRunTerminal: true, queuedRunHeldForFiveSeconds: true, noExtraProviderTurn: true, originalNativeThreadRetained: true, queuedMessageNotDuplicated: true, positiveCursorReconnect: true, userCommandsNotResent: true }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.errors.push({ message: error.message, detail: error.detail }); process.exitCode = 1
} finally {
  // Clean up only this test's pending work, after saving recovery observations.
  if (threadId) try {
    if (!client.socket || client.socket.readyState !== 1) { client = new T3LiveClient(origin); await client.login(); await client.connect() }
    const p = await client.projection(threadId)
    if (queuedRunId && p.runs.some((r) => r.id === queuedRunId && r.status === 'queued')) await dispatch('queued-run.cancel', { runId: queuedRunId })
    if (p.runs.some((r) => !terminal(r) && r.status !== 'queued')) await dispatch('thread.stop', {})
    report.cleanup = { ownPendingWorkCancelled: true }
  } catch (error) { report.cleanup = { error: error.message }; report.status = 'failed'; report.errors.push({ cleanup: error.message }); process.exitCode = 1 }
  client.close(); report.killed = killed; report.completedAt = new Date().toISOString(); await save()
  console.log(JSON.stringify({ status: report.status, report: output, threadId, killed, recoveryMs: report.recoveryMs, assertions: report.assertions, errors: report.errors }))
}
