import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client, requestId, sleep } from './agent-demo-helpers.mjs'

// Real model / existing VM fault test. Preparation and `node --check` are inert.
// Run only after the coordinator has explicitly finished all other tests:
// AGENT_DEMO_LIVE_FAULTS=1 AGENT_DEMO_FAULT_WINDOW=exclusive-reviewed \
// AGENT_DEMO_URL=http://192.168.31.157:8787 node test/agent-demo-live-fault-evaluation.mjs
// Root must first restore the existing authenticated SSH master. This script
// never supplies SSH credentials, changes host trust, deploys code, or reads keys.
// It restarts only the Bridge once. The main-service restart is deliberately
// excluded so two bounded scenarios can be reviewed and run independently.
if (
  process.env.AGENT_DEMO_LIVE_FAULTS !== '1' ||
  process.env.AGENT_DEMO_FAULT_WINDOW !== 'exclusive-reviewed' ||
  !process.env.AGENT_DEMO_URL
) {
  console.error('未执行：须由协调者确认其他测试已结束，再显式设置真实测试与独占故障窗口开关。')
  process.exit(2)
}

const origin = new URL(process.env.AGENT_DEMO_URL)
assert(
  ['http:', 'https:'].includes(origin.protocol) &&
    ['192.168.31.157', '172.29.22.6'].includes(origin.hostname) &&
    !origin.username &&
    !origin.password &&
    !origin.search &&
    !origin.hash &&
    origin.pathname === '/' &&
    origin.port === '8787',
  '故障测试只允许已授权测试 VM 的 LAN / ZeroTier 8787 根地址',
)
const testId = `real-fault-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const directory = path.resolve('.test-artifacts/agent-demo-real-evaluation/faults', testId)
const reportPath = path.join(directory, 'report.json')
const client = new Client('admin', origin.origin)
const owned = new Set()
const streams = []
const TERMINAL = new Set(['completed', 'failed', 'interrupted'])
const SSH_ARGS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=/private/tmp/autoops-demo-ssh.sock',
  '-o',
  'ConnectTimeout=8',
  'tao@192.168.31.157',
]
const report = {
  testId,
  mode: 'real-grok-api-fault-evaluation',
  startedAt: new Date().toISOString(),
  origin: origin.origin,
  checks: [],
  failures: [],
  snapshots: [],
  guardChecks: [],
  acceptedRuns: 0,
  maxAcceptedRuns: 4,
  bridgeRestartAttempts: 0,
  mainServiceRestarted: false,
  providerKeyRead: false,
  scenarios: [],
  boundaries: [
    '真实配置 API 测试，不证明浏览器布局、实际手机输入、提供方计费终止或所有取消阶段。',
    '停止场景要求真实正文已出现且轮次仍活跃，不能以请求 accepted 或自然 completed 代替 interrupted。',
    'Bridge 故障在真实模型提出澄清后、等待回答时注入；不外推为所有工具/正文阶段恢复。',
    '继续仍是新轮次；Bridge 重启后以同一 runnerThreadId、未重述随机事实和未披露的附件第二行验证原生会话延续，不声称原地恢复被中断的执行。',
    'API 与只读 SQLite / loopback health 在重启前重复核对；不改变服务器访问规则，独占窗口需协调者保障。',
    'Bridge 没有运行集合查询接口；无法单靠本脚本枚举其内存孤儿任务。执行前须协调者确认其他真实测试已全部结束并清理。',
    '只处理本脚本新建的私有会话；主服务重启不在本次两场景范围。',
  ],
}
let abortRequested = false
let restartAttempted = false
let restoreError = null
process.once('SIGINT', () => {
  abortRequested = true
})
process.once('SIGTERM', () => {
  abortRequested = true
})

function sanitize(value) {
  if (typeof value === 'string') {
    let text = value
    for (const secret of [client.cookie, client.csrf, process.env.AGENT_DEMO_PASSWORD])
      if (secret) text = text.replaceAll(secret, '[REDACTED]')
    return text
      .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
  }
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(cookie|csrf|password|token|apiKey|api_key|authorization|secret)$/i.test(key)
          ? '[REDACTED]'
          : sanitize(item),
      ]),
    )
  return value
}
const errorRecord = (error) =>
  sanitize({ name: error?.name, message: error?.message || String(error) })
async function save() {
  await writeFile(reportPath, JSON.stringify(sanitize(report), null, 2), { mode: 0o600 })
}
async function waitFor(fn, label, timeout = 150_000, ignoreAbort = false) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (abortRequested && !ignoreAbort) throw new Error(`执行被中止：${label}`)
    const result = await fn()
    if (result) return result
    await sleep(200)
  }
  throw new Error(`等待超时：${label}`)
}
function ssh(command, input = '', timeout = 35_000, checkMaster = false) {
  return new Promise((resolve, reject) => {
    const args = checkMaster
      ? [...SSH_ARGS.slice(0, -1), '-O', 'check', SSH_ARGS.at(-1)]
      : [...SSH_ARGS, command]
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '',
      stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('SSH 操作超时'))
    }, timeout)
    child.stdout.on('data', (data) => {
      stdout += data
      if (stdout.length > 256_000) child.kill()
    })
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-4000)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`SSH ${code}: ${stderr.trim() || '远端检查未通过'}`))
      else resolve(stdout.trim())
    })
    child.stdin.end(input)
  })
}

// The remote check sees ALL owners, unlike the admin account's ACL-filtered
// bootstrap. It prints only active metadata, service states and public health.
// No environment / token / provider-secret file is read.
async function remoteGuard(expected, restart = false) {
  const payload = JSON.stringify({ expected, ownerId: client.user.id, prefix: testId, restart })
  const program = `import json, sqlite3, subprocess, urllib.request, sys, time
cfg = json.loads(${JSON.stringify(payload)})
db = sqlite3.connect('file:/home/tao/autoops-agent-demo/data/demo.sqlite?mode=ro', uri=True)
rows = [json.loads(row[0]) for row in db.execute('SELECT body FROM conversations')]
terminal = {'completed', 'failed', 'interrupted'}
active = []
for c in rows:
    pending = [t for t in c.get('turns', []) if t.get('status') not in terminal]
    if c.get('activeTurnId') or pending:
        active.append({'id': c['id'], 'turnId': c.get('activeTurnId'), 'ownerId': c.get('ownerId'),
                       'agentId': c.get('agentId'), 'visibility': c.get('visibility'), 'mode': c.get('mode'),
                       'testOwned': c.get('title', '').startswith(cfg['prefix']),
                       'pendingTurnIds': [t['id'] for t in pending]})
foreignReadyQueues = [c['id'] for c in rows if c.get('queue') and not c.get('queuePaused') and c['id'] != (cfg['expected'] or {}).get('id')]
health = json.load(urllib.request.urlopen('http://127.0.0.1:8787/api/agent-demo/health', timeout=5))
services = {}
for unit in ['autoops-agent-demo.service', 'autoops-agent-demo-bridge.service']:
    result = subprocess.run(['systemctl', '--user', 'is-active', unit], capture_output=True, text=True)
    services[unit] = result.stdout.strip()
expected = cfg['expected']
assert not foreignReadyQueues, 'Other conversations have runnable queued work'
assert health['active'] == (1 if expected else 0), 'Loopback runtime active count differs'
assert len(active) == (1 if expected else 0), 'Database has other active conversations'
if expected:
    a = active[0]
    assert a['id'] == expected['id'] and a['turnId'] == expected['turnId'], 'Unexpected active conversation/turn'
    assert a['ownerId'] == cfg['ownerId'] and a['testOwned'] and a['visibility'] == 'private' and a['mode'] == 'live', 'Active conversation is not owned by this test'
    assert a['agentId'] == 'a-project' and a['pendingTurnIds'] == [expected['turnId']], 'Unexpected agent or active turn'
assert all(state == 'active' for state in services.values()), 'Required service is not active'
result = {'at': time.time(), 'active': active, 'health': health, 'services': services, 'foreignReadyQueues': foreignReadyQueues}
if cfg['restart']:
    assert expected, 'Fault injection requires the exact owned active turn'
    pid_cmd = ['systemctl', '--user', 'show', '--property=MainPID', '--value', 'autoops-agent-demo-bridge.service']
    result['bridgePidBefore'] = subprocess.check_output(pid_cmd, text=True).strip()
    assert result['bridgePidBefore'].isdigit() and int(result['bridgePidBefore']) > 0, 'Bridge PID missing'
    result['restartRequestedAt'] = time.time()
    subprocess.run(['systemctl', '--user', 'restart', 'autoops-agent-demo-bridge.service'], check=True, timeout=25)
    result['restartReturnedAt'] = time.time()
    result['bridgePidAfter'] = subprocess.check_output(pid_cmd, text=True).strip()
    assert result['bridgePidAfter'].isdigit() and int(result['bridgePidAfter']) > 0, 'Restarted Bridge PID missing'
    assert result['bridgePidAfter'] != result['bridgePidBefore'], 'Bridge PID did not change'
print(json.dumps(result))
`
  return JSON.parse(await ssh('python3 -', program, 40_000))
}
async function exclusiveGuard(expected = null) {
  const bootstrap = await client.api('GET', '/bootstrap')
  const health = await client.api('GET', '/health')
  const active = bootstrap.conversations.filter((c) => c.activeTurnId)
  assert.equal(health.active, expected ? 1 : 0, '公开 health 检测到其他活动轮次')
  assert.deepEqual(
    active.map((c) => ({ id: c.id, turnId: c.activeTurnId })),
    expected ? [expected] : [],
  )
  for (const c of active)
    assert.ok(owned.has(c.id) && c.ownerId === client.user.id && c.mode === 'live')
  const remote = await remoteGuard(expected)
  assert.equal(remote.health.buildHash, health.buildHash, '浏览器/API地址与 SSH 主服务版本不同')
  report.guardChecks.push({ at: new Date().toISOString(), expected, apiHealth: health, remote })
  await save()
  return remote
}
async function snapshot(c, label) {
  assert.ok(owned.has(c.id), '只允许保存本测试会话')
  const filename = `${label}-${c.id}.json`
  await writeFile(path.join(directory, filename), JSON.stringify(sanitize(c), null, 2), {
    mode: 0o600,
  })
  report.snapshots.push(filename)
  return c
}
async function create(label) {
  const c = await client.create({
    mode: 'live',
    visibility: 'private',
    title: `${testId} ${label}`,
  })
  owned.add(c.id)
  assert.equal(c.ownerId, client.user.id)
  await save()
  return c
}
async function begin(c, prompt, attachmentIds = []) {
  assert.ok(report.acceptedRuns < report.maxAcceptedRuns, '超过真实轮次预算')
  const result = await client.api('POST', `/conversations/${c.id}/messages`, {
    requestId: requestId(),
    text: prompt,
    attachmentIds,
    delivery: 'send',
  })
  report.acceptedRuns++
  const turnId = result.conversation.activeTurnId
  assert.ok(turnId)
  await save()
  return turnId
}
function turnText(c, turnId) {
  return (c.turns.find((t) => t.id === turnId)?.timeline || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('')
}
async function terminal(c, turnId) {
  return waitFor(async () => {
    const current = await client.conversation(c.id)
    const turn = current.turns.find((t) => t.id === turnId)
    return !current.activeTurnId && TERMINAL.has(turn?.status) && current
  }, `轮次 ${turnId} 真实终态`)
}
async function scenario(name, fn) {
  const item = { name, startedAt: new Date().toISOString(), status: 'running' }
  report.scenarios.push(item)
  await save()
  try {
    await fn(item)
    item.status = 'passed'
  } catch (error) {
    item.status = 'failed'
    item.error = errorRecord(error)
    throw error
  } finally {
    item.finishedAt = new Date().toISOString()
    await save()
  }
}

await mkdir(directory, { recursive: true, mode: 0o700 })
try {
  // Existing socket must be usable; do not fall back to a fresh password login.
  await ssh('', '', 10_000, true)
  await client.login()
  assert.equal(client.user.username, 'admin')
  assert.equal(client.bootstrap.runtime.liveAvailable, true)
  report.runtime = client.bootstrap.runtime
  report.healthBefore = await client.api('GET', '/health')
  await exclusiveGuard()

  await scenario('真实正文输出后停止，再以新轮次继续', async (item) => {
    const c = await create('stop-continue')
    const stream = await client.stream(client.bootstrap.eventCursor)
    streams.push(stream)
    const marker = `STOP_${randomUUID().slice(0, 8)}`
    const turnId = await begin(
      c,
      `这是合成停止验收。请先输出一小段正文“${marker} 已开始”，然后连续用中文说明20项只读项目检查建议，每项约50字。不要调用工具、不要提问，不创建报告或执行操作。`,
    )
    item.conversationId = c.id
    item.turnId = turnId
    const live = await waitFor(async () => {
      const current = await client.conversation(c.id)
      const turn = current.turns.find((t) => t.id === turnId)
      if (TERMINAL.has(turn?.status)) throw new Error('模型在停止注入前已自然结束；不算停止通过')
      return turn?.runnerTurnId && turnText(current, turnId).trim() && current
    }, '真实正文开始且仍在执行')
    await snapshot(live, 'stop-before')
    item.beforeStop = {
      status: live.turns[0].status,
      characters: turnText(live, turnId).length,
      runnerThreadId: live.turns[0].runnerThreadId,
      runnerTurnId: live.turns[0].runnerTurnId,
      runtimeTimings: live.turns[0].runtimeTimings,
    }
    const receipt = await client.stop(c.id, turnId)
    const receiptEventCount = stream.events.length
    const receiptText = turnText(receipt.conversation, turnId)
    const receiptSeq = receipt.conversation.eventSeq
    const stopped = await terminal(c, turnId)
    assert.equal(stopped.turns.find((t) => t.id === turnId).status, 'interrupted')
    assert.equal(turnText(stopped, turnId), receiptText, '停止回执后正文继续增长')
    await sleep(3000)
    const stable = await snapshot(await client.conversation(c.id), 'stop-stable')
    assert.equal(turnText(stable, turnId), receiptText, '停止后观察期正文仍增长')
    assert.equal(stable.queuePaused, true)
    assert.deepEqual(stream.errors, [], '主服务 SSE 发生异常')
    assert.equal(stream.closed, false, '停止观察期主服务 SSE 意外断开')
    const late = stream.events
      .slice(receiptEventCount)
      .filter(
        (e) =>
          e.conversationId === c.id &&
          e.turnId === turnId &&
          e.type === 'message.delta' &&
          e.payload?.delta,
      )
    const generatedAfterReceipt = late.filter((e) => Number(e.seq ?? e.sseId) > receiptSeq)
    assert.equal(generatedAfterReceipt.length, 0, '停止回执序号之后产生了新正文事件')
    item.stop = {
      status: 'interrupted',
      postReceiptNewBodyEvents: generatedAfterReceipt.length,
      delayedPreReceiptBodyEvents: late.length - generatedAfterReceipt.length,
      stableObservationMs: 3000,
    }
    assert.ok(report.acceptedRuns < report.maxAcceptedRuns)
    const continued = await client.api('POST', `/conversations/${c.id}/continue`, {
      requestId: requestId(),
      turnId,
    })
    report.acceptedRuns++
    const nextId = continued.conversation.activeTurnId
    assert.ok(nextId && nextId !== turnId, '继续必须创建新轮次')
    const finished = await snapshot(await terminal(c, nextId), 'continue-completed')
    const next = finished.turns.find((t) => t.id === nextId)
    assert.equal(next.status, 'completed', '继续请求必须真实完成')
    assert.equal(next.continuesTurnId, turnId)
    assert.ok(next.runnerTurnId && turnText(finished, nextId).trim())
    assert.equal(finished.turns.find((t) => t.id === turnId).status, 'interrupted')
    assert.equal(turnText(finished, turnId), receiptText, '恢复不能覆盖旧部分结果')
    item.continuation = {
      turnId: nextId,
      runnerThreadId: next.runnerThreadId,
      runnerTurnId: next.runnerTurnId,
      status: next.status,
      characters: turnText(finished, nextId).length,
      runtimeTimings: next.runtimeTimings,
    }
    report.checks.push(
      '真实正文后停止进入 interrupted，停止后正文不再增长，继续新轮次真实完成且保留旧结果',
    )
    await stream.close()
    streams.splice(streams.indexOf(stream), 1)
  })

  await exclusiveGuard()
  await scenario(
    '真实澄清等待轮 Bridge 重启，同原生会话恢复事实与旧附件且队列暂停',
    async (item) => {
      const c = await create('bridge-restart')
      const fact = `FACT_${randomUUID().replaceAll('-', '')}`
      const fileFirstLine = `FIRST_${randomUUID().replaceAll('-', '')}`
      const fileSecondLine = `SECOND_${randomUUID().replaceAll('-', '')}`
      const file = await client.upload(
        c.id,
        `restart-context-${randomUUID().slice(0, 8)}.txt`,
        `${fileFirstLine}\n${fileSecondLine}\n`,
      )
      assert.equal(file.readable, true, '本测试 TXT 上传后应明确可读取')
      item.syntheticFixture = {
        fact,
        fileId: file.id,
        fileName: file.name,
        fileFirstLine,
        fileSecondLine,
        note: '均为本测试随机值；恢复请求不得重复提供 fact 或文件第二行。',
      }
      const turnId = await begin(
        c,
        `这是合成故障恢复验收。本会话代号是 ${fact}，请记住，稍后会追问。随本轮上传的 TXT 暂时不要读取，也不要引用其内容。现在必须先调用 ask_user 询问“故障注入准备完成，是否继续？”，选项“继续”和“结束”。等待我的回答，在收到回答前不要结束本轮。收到回答后只输出“已继续”。本轮只调用 ask_user，不创建报告或执行任何写操作。`,
        [file.id],
      )
      item.conversationId = c.id
      item.turnId = turnId
      const waiting = await waitFor(async () => {
        const current = await client.conversation(c.id)
        const turn = current.turns.find((t) => t.id === turnId)
        if (TERMINAL.has(turn?.status))
          throw new Error('真实模型没有停留在澄清等待，不能注入预定故障')
        return (
          turn?.runnerTurnId &&
          turn.question?.status === 'pending' &&
          current.status === 'waiting' &&
          current
        )
      }, '真实模型提出澄清并等待')
      await snapshot(waiting, 'bridge-before')
      const before = waiting.turns.find((turn) => turn.id === turnId)
      assert.ok(before.runnerThreadId, '故障前必须有原生运行器 thread ID')
      assert.equal(
        waiting.runtimeSession?.threadId,
        before.runnerThreadId,
        '主服务必须已记录原生会话映射',
      )
      assert.equal(
        (before.steps || []).filter((step) => step.name === 'read_attachment').length,
        0,
        '故障前不得读取附件，避免第二行先进入模型工具历史形成假通过',
      )
      assert.ok(
        !JSON.stringify(waiting).includes(fileSecondLine),
        '故障前会话可见正文、思考与工具记录不得包含附件第二行',
      )
      item.beforeRestart = {
        runnerThreadId: before.runnerThreadId,
        runnerTurnId: before.runnerTurnId,
        runtimeTimings: before.runtimeTimings,
        attachmentReadBeforeRestart: false,
        attachmentSecondLineDisclosed: false,
      }
      const queued = await client.api('POST', `/conversations/${c.id}/messages`, {
        requestId: requestId(),
        text: '这是待人工恢复的队列项，不应在故障后自动执行。',
        attachmentIds: [],
        delivery: 'queue',
      })
      const queueIds = queued.conversation.queue.map((q) => q.id)
      assert.equal(queueIds.length, 1)
      const expected = { id: c.id, turnId }
      await exclusiveGuard(expected)
      // A second remote-side guard runs immediately before systemctl, not merely
      // before opening SSH. Still requires the coordinator's exclusive window.
      restartAttempted = true
      report.bridgeRestartAttempts++
      await save()
      item.restartGuard = await remoteGuard(expected, true)
      const interrupted = await snapshot(await terminal(c, turnId), 'bridge-interrupted')
      const old = interrupted.turns.find((t) => t.id === turnId)
      item.actualTerminal = old.status
      item.interruptedRuntimeTimings = old.runtimeTimings
      assert.equal(
        old.status,
        'interrupted',
        'Bridge 正常重启应收到 interrupted；failed/自然 completed 不算同一结果',
      )
      assert.equal(interrupted.queuePaused, true)
      assert.deepEqual(
        interrupted.queue.map((q) => q.id),
        queueIds,
      )
      assert.equal(interrupted.turns.length, 1, '故障后的队列不得自动启动')
      await waitFor(
        async () => (await client.api('GET', '/health')).liveAvailable,
        'Bridge 恢复可用',
        45_000,
      )
      await exclusiveGuard()
      const marker = `RECOVERY_${randomUUID().slice(0, 8)}`
      const recoveryPrompt = `故障已结束，请在刚才的同一会话中继续，不再澄清。请回复三行：第一行写故障前我让你记住的“本会话代号”；第二行通过 read_attachment 读取本会话此前上传的 ${file.name}，原样写出文件第二行；第三行只写新恢复标记 ${marker}。不要重新索取或上传附件，不要猜测缺失信息，不执行写操作，不增加解释。`
      assert.ok(!recoveryPrompt.includes(fact), '恢复请求不能重述需回忆的随机事实')
      assert.ok(!recoveryPrompt.includes(fileSecondLine), '恢复请求不能泄漏附件第二行')
      const nextId = await begin(c, recoveryPrompt)
      const recovered = await snapshot(await terminal(c, nextId), 'bridge-recovered')
      const next = recovered.turns.find((t) => t.id === nextId)
      const responseText = turnText(recovered, nextId)
      const fileReads = (next.steps || []).filter(
        (step) => step.name === 'read_attachment' && step.input?.id === file.id,
      )
      // Preserve failed observations too; a changed thread or missing fact must
      // remain visible in the report instead of disappearing behind an assert.
      item.recoveryObserved = {
        turnId: nextId,
        runnerThreadId: next.runnerThreadId,
        runnerTurnId: next.runnerTurnId,
        status: next.status,
        sameNativeThread: next.runnerThreadId === before.runnerThreadId,
        randomFactRecalled: responseText.includes(fact),
        oldAttachmentSecondLineReturned: responseText.includes(fileSecondLine),
        markerReturned: responseText.includes(marker),
        attachmentReads: fileReads.map((step) => ({
          id: step.id,
          status: step.status,
          expectedContentRead: !!step.output?.content?.includes(fileSecondLine),
        })),
        runtimeTimings: next.runtimeTimings,
      }
      assert.equal(next.status, 'completed')
      assert.ok(next.runnerTurnId)
      assert.notEqual(next.runnerTurnId, before.runnerTurnId, '恢复请求必须创建新的原生轮次')
      assert.equal(
        next.runnerThreadId,
        before.runnerThreadId,
        'Bridge 重启后必须恢复同一原生 thread，而非建立空白新会话',
      )
      assert.equal(recovered.runtimeSession?.threadId, before.runnerThreadId)
      assert.ok(responseText.includes(marker), '重启后必须得到新真实模型响应')
      assert.ok(responseText.includes(fact), '同一原生会话必须回忆未在恢复请求中重述的随机事实')
      assert.ok(
        responseText.includes(fileSecondLine),
        '重启后必须读取未重附、此前未披露的附件第二行',
      )
      assert.ok(
        fileReads.some(
          (step) => step.status === 'completed' && step.output?.content?.includes(fileSecondLine),
        ),
        '必须有对应旧附件的真实成功读取工具结果，不能仅靠答复猜测通过',
      )
      assert.equal(recovered.turns.find((t) => t.id === turnId).status, 'interrupted')
      assert.deepEqual(
        recovered.queue.map((q) => q.id),
        queueIds,
      )
      assert.equal(recovered.queuePaused, true)
      item.recovery = {
        turnId: nextId,
        runnerThreadId: next.runnerThreadId,
        runnerTurnId: next.runnerTurnId,
        status: next.status,
        markerReturned: true,
        sameNativeThread: true,
        randomFactRecalled: true,
        oldAttachmentSecondLineRead: true,
        attachmentReadCalls: fileReads.length,
        queueStayedPaused: true,
        runtimeTimings: next.runtimeTimings,
      }
      report.checks.push(
        '真实澄清等待轮在受控 Bridge 重启后中断；新轮恢复同一原生 thread，回忆未重述随机事实并通过工具读取未重附旧TXT第二行，暂停队列保持且新marker返回',
      )
    },
  )
} catch (error) {
  report.failures.push(errorRecord(error))
} finally {
  // `start` is idempotent and never restarts an already active service. Do this
  // even after an uncertain SSH result; no fault is allowed to leave it stopped.
  if (restartAttempted) {
    try {
      const output = await ssh(
        'systemctl --user start autoops-agent-demo-bridge.service autoops-agent-demo.service && systemctl --user is-active autoops-agent-demo-bridge.service autoops-agent-demo.service',
      )
      assert.deepEqual(output.split(/\s+/), ['active', 'active'])
      report.servicesRestoredActive = true
    } catch (error) {
      restoreError = errorRecord(error)
      report.failures.push({ stage: 'restore-services', ...restoreError })
    }
  }
  for (const stream of streams)
    await stream
      .close()
      .catch((error) => report.failures.push({ stage: 'sse-close', ...errorRecord(error) }))
  report.cleanup = []
  for (const id of owned) {
    try {
      let c = await client.conversation(id)
      assert.ok(
        c.title.startsWith(testId) && c.ownerId === client.user.id && c.visibility === 'private',
        '清理对象不属于本测试',
      )
      if (c.activeTurnId) {
        await client.stop(id, c.activeTurnId)
        c = await waitFor(
          async () => {
            const next = await client.conversation(id)
            return !next.activeTurnId && next
          },
          '清理前停止自己的活动轮',
          30_000,
          true,
        )
      }
      await snapshot(c, 'final-before-cleanup')
      await client.api('DELETE', `/conversations/${id}`)
      report.cleanup.push({ id, removed: true })
    } catch (error) {
      report.cleanup.push({ id, removed: false, error: errorRecord(error) })
      report.failures.push({ stage: 'cleanup-owned-conversation', ...errorRecord(error) })
    }
  }
  if (client.user) {
    try {
      report.healthAfter = await client.api('GET', '/health')
    } catch (error) {
      report.failures.push({ stage: 'final-health', ...errorRecord(error) })
    }
  }
  report.finishedAt = new Date().toISOString()
  report.passed =
    report.failures.length === 0 &&
    !restoreError &&
    report.scenarios.length === 2 &&
    report.scenarios.every((item) => item.status === 'passed')
  await save()
  console.log(
    JSON.stringify({ passed: report.passed, report: reportPath, failures: report.failures }),
  )
  if (!report.passed) process.exitCode = 1
}
