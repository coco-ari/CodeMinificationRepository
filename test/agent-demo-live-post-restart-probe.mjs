import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client, requestId, sleep } from './agent-demo-helpers.mjs'

// A separately authorized ONE-request diagnostic. Never changes the original
// fault verdict and never starts/stops/restarts a service or reads credentials.
assert.equal(process.env.AGENT_DEMO_POST_RESTART_PROBE, '1', '延后恢复探针须明确授权')
assert.ok(process.env.AGENT_DEMO_FAULT_REPORT && process.env.AGENT_DEMO_URL)
const originalPath = path.resolve(process.env.AGENT_DEMO_FAULT_REPORT)
const originalBytes = await readFile(originalPath)
const originalDigest = createHash('sha256').update(originalBytes).digest('hex')
const original = JSON.parse(originalBytes)
const restart = original.scenarios.find((item) => item.restartGuard)?.restartGuard
assert.ok(restart?.restartReturnedAt, '必须引用已有重启记录')
assert.equal(process.env.AGENT_DEMO_URL, 'http://172.29.22.6:8787')
const output = path.join(path.dirname(originalPath), 'post-restart-recovery-probe.json')
const client = new Client('admin', process.env.AGENT_DEMO_URL)
const title = `post-restart-probe-${randomUUID()}`
const marker = `RESTORED_${randomUUID().replaceAll('-', '')}`
const report = {
  startedAt: new Date().toISOString(),
  mode: 'one-real-request-delayed-recovery-probe',
  originalFaultReport: originalPath,
  originalReportSha256: originalDigest,
  originalFaultPassed: original.passed,
  maxModelRequests: 1,
  requestsSubmitted: 0,
  restartedServices: false,
  readProviderKey: false,
  failures: [],
  boundary: '独立延后探针只能区分短暂不可达与持续不可用；即使通过也不把原故障场景改为通过。',
}
let cid
let cancelled = false
process.once('SIGINT', () => {
  cancelled = true
})
process.once('SIGTERM', () => {
  cancelled = true
})
function remoteHealth() {
  const program = `import json, subprocess, urllib.request, urllib.error, sqlite3, time
units = ['autoops-agent-demo.service', 'autoops-agent-demo-bridge.service']
services = {u: subprocess.check_output(['systemctl','--user','is-active',u],text=True).strip() for u in units}
assert all(v == 'active' for v in services.values()), 'Service not active'
health = json.load(urllib.request.urlopen('http://127.0.0.1:8787/api/agent-demo/health',timeout=5))
assert health['active'] == 0 and health['liveAvailable'], 'Main health is not idle/available'
# Authentication is deliberately not bypassed. HTTP 401 proves this loopback
# listener responds; model readiness comes from the main service's health poll.
try:
    response = urllib.request.urlopen('http://127.0.0.1:8791/health',timeout=5)
    bridge_status = response.status
except urllib.error.HTTPError as e:
    bridge_status = e.code
assert bridge_status == 401, 'Unexpected Bridge listener response'
db = sqlite3.connect('file:/home/tao/autoops-agent-demo/data/demo.sqlite?mode=ro',uri=True)
active = sum(1 for row in db.execute('SELECT body FROM conversations') if json.loads(row[0]).get('activeTurnId'))
assert active == 0, 'Database still has active conversations'
print(json.dumps({'serverTime':time.time(),'services':services,'health':health,'bridgeUnauthenticatedStatus':bridge_status,'databaseActive':active}))
`
  const text = execFileSync(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=/private/tmp/autoops-demo-ssh.sock',
      'tao@192.168.31.157',
      'python3 -',
    ],
    { input: program, encoding: 'utf8', timeout: 12_000, maxBuffer: 64 * 1024 },
  )
  return JSON.parse(text)
}
async function read(timeout = 15_000) {
  return (await client.api('GET', `/conversations/${cid}`, undefined, { timeout })).conversation
}
try {
  report.preflight = remoteHealth()
  await client.login()
  assert.equal(client.bootstrap.runtime.liveAvailable, true)
  report.runtime = client.bootstrap.runtime
  report.healthBefore = await client.api('GET', '/health')
  assert.equal(report.healthBefore.active, 0)
  assert.ok(
    report.preflight.serverTime - restart.restartReturnedAt > 10,
    '须跨过主服务10秒健康刷新周期',
  )
  report.secondsAfterRestartAtPreflight = report.preflight.serverTime - restart.restartReturnedAt
  const c = await client.create({ title, mode: 'live', visibility: 'private' })
  cid = c.id
  assert.equal(c.ownerId, client.user.id)
  report.conversationId = cid
  const start = performance.now()
  report.requestsSubmitted++
  const response = await client.api('POST', `/conversations/${cid}/messages`, {
    requestId: requestId(),
    text: `这是一次短恢复探针。不要调用任何工具、不要提问，只回复这一个标记：${marker}`,
    attachmentIds: [],
    delivery: 'send',
  })
  const turnId = response.conversation.activeTurnId
  assert.ok(turnId)
  let current
  while (performance.now() - start < 60_000) {
    if (cancelled) throw new Error('探针被中止，不追加请求')
    current = await read(
      Math.max(1, Math.min(15_000, Math.floor(60_000 - (performance.now() - start)))),
    )
    const turn = current.turns.find((item) => item.id === turnId)
    if (!current.activeTurnId && ['completed', 'failed', 'interrupted'].includes(turn?.status))
      break
    await sleep(200)
  }
  const turn = current?.turns.find((item) => item.id === turnId)
  report.turn = {
    id: turnId,
    status: turn?.status,
    runnerThreadId: turn?.runnerThreadId,
    runnerTurnId: turn?.runnerTurnId,
    startedAt: turn?.startedAt,
    completedAt: turn?.completedAt,
    error: turn?.error || null,
    secondsAfterRestartAtRunStart: turn?.startedAt
      ? Date.parse(turn.startedAt) / 1000 - restart.restartReturnedAt
      : null,
  }
  report.elapsedMs = performance.now() - start
  assert.equal(turn?.status, 'completed', '独立恢复请求必须在60秒内真实完成')
  assert.ok(turn.runnerTurnId)
  assert.equal(turn.steps.length, 0, '短探针不应调用工具')
  const body = (turn.timeline || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('')
  report.markerReturned = body.includes(marker)
  assert.equal(report.markerReturned, true)
  report.completed = true
} catch (error) {
  report.failures.push({ name: error.name, message: error.message })
} finally {
  if (cid) {
    try {
      let c = await read()
      assert.equal(c.title, title)
      assert.equal(c.ownerId, client.user.id)
      if (c.activeTurnId) {
        await client.stop(cid, c.activeTurnId)
        const deadline = Date.now() + 20_000
        while (c.activeTurnId && Date.now() < deadline) {
          await sleep(200)
          c = await read()
        }
      }
      await writeFile(
        path.join(path.dirname(output), 'post-restart-recovery-probe-conversation.json'),
        JSON.stringify(c, null, 2),
        { mode: 0o600 },
      )
      assert.equal(c.activeTurnId, null, '未停止的自有任务不能删除')
      await client.api('DELETE', `/conversations/${cid}`)
      report.cleanedUp = true
    } catch (error) {
      report.failures.push({ stage: 'cleanup', message: error.message })
    }
  }
  try {
    report.finalHealth = remoteHealth()
  } catch (error) {
    report.failures.push({ stage: 'final-health', message: error.message })
  }
  const afterDigest = createHash('sha256')
    .update(await readFile(originalPath))
    .digest('hex')
  report.originalReportUnchanged = afterDigest === originalDigest
  if (!report.originalReportUnchanged) report.failures.push({ stage: 'original-report-changed' })
  report.finishedAt = new Date().toISOString()
  report.passed =
    report.completed === true && report.cleanedUp === true && report.failures.length === 0
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(
    JSON.stringify({
      passed: report.passed,
      report: output,
      turn: report.turn,
      failures: report.failures,
    }),
  )
  if (!report.passed) process.exitCode = 1
}
