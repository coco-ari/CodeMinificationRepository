import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client, quantiles, requestId, sleep } from './agent-demo-helpers.mjs'

// Explicitly authorized real-model evaluation. No mock runner, scenario mode,
// imported history, bootstrap, global SSE, service restart or configuration edits.
// Prepare/check without network: node --check test/agent-demo-live-long-conversation.mjs
// Run only when coordinated: AGENT_DEMO_LIVE_LONG=1 node test/agent-demo-live-long-conversation.mjs
// Optional coordinated read-only browser follow-up: AGENT_DEMO_LIVE_LONG_PRESERVE=1
if (process.env.AGENT_DEMO_LIVE_LONG !== '1') {
  console.error('未执行：真实长对话验收须显式设置 AGENT_DEMO_LIVE_LONG=1。')
  process.exit(2)
}

const origin = (process.env.AGENT_DEMO_URL || 'http://172.29.22.6:8787').replace(/\/$/, '')
const logicalRoundCount = Number(process.env.AGENT_DEMO_LIVE_LONG_ROUNDS || 105)
assert.ok(
  Number.isInteger(logicalRoundCount) && logicalRoundCount >= 1 && logicalRoundCount <= 300,
  '轮数必须是 1–300 的整数；默认 105 轮',
)
const preserveConversation = process.env.AGENT_DEMO_LIVE_LONG_PRESERVE === '1'
const roundTimeoutMs = 120_000
const pollIntervalMs = 250
const testId = `long-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const output = path.resolve('.test-artifacts/agent-demo-real-evaluation/long', testId)
const terminalStates = new Set(['completed', 'failed', 'interrupted'])
const memoryRounds = new Set(
  [10, 30, 60, 100, ...(logicalRoundCount > 1 ? [logicalRoundCount] : [])].filter(
    (number) => number <= logicalRoundCount,
  ),
)
const memoryMarker = `LC_${randomUUID().replaceAll('-', '').slice(0, 20)}`
const roundMs = (number) => Math.round(number * 1000) / 1000
let ownedId = null
let latestConversation = null
let stopRequested = false
let evaluationErrors = []
// The long-run benchmark must not hide a lost native thread by rebuilding it
// through /retry. Retry/revision recovery has a separate controlled test.
let recoveryRetriesRemaining = 0
let client

const report = {
  testId,
  startedAt: new Date().toISOString(),
  mode: 'real-live-sequential-long-conversation',
  origin,
  requestedLogicalRounds: logicalRoundCount,
  preserveConversation,
  maxRoundMs: roundTimeoutMs,
  recoveryRetryBudget: 0,
  pollIntervalMs,
  memoryMarker,
  memoryRounds: [...memoryRounds],
  architecture: 'native-session-incremental-turns',
  formerHistoryEntryLimit: 200,
  rounds: [],
  scriptErrors: [],
  cleanup: { attempted: false, deleted: false },
  evidenceBoundary: [
    'Only a newly created private live conversation owned by this test is read or changed.',
    'Login intentionally skips Client.login bootstrap: bootstrap/global SSE can include other conversations.',
    'First-body latency is POST-to-first own-conversation REST snapshot with nonempty assistant text, sampled every 250ms; it is not browser paint or pure provider TTFT.',
    "History entry counts are derived from this test's actual saved timeline using the server transcript rules; no history is injected.",
    'Runner IDs confirm runner startup, not the exact number of provider API calls. The main service may hide Bridge error details.',
    'No terminal-failure retry is allowed: a retry starts a new native context revision and would conceal a broken continuous conversation.',
    'Persisted history entry count measures the transcript, not the incremental Bridge payload. Passing the former 200-entry boundary must now succeed.',
    'Token totals add only scope=turn usage. Thread-cumulative totals remain observations and are never summed across turns.',
    "A timeout triggers stop for this test's active turn. Stop/cleanup settlement can exceed the 120s model-execution budget.",
  ],
}

process.on('SIGINT', () => {
  stopRequested = true
})
process.on('SIGTERM', () => {
  stopRequested = true
})

function sanitize(value) {
  if (typeof value === 'string') {
    for (const secret of [client?.cookie, client?.csrf].filter(Boolean))
      value = value.replaceAll(secret, '[REDACTED]')
    return value.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]')
  }
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(cookie|csrf|authorization|password|apiKey|api_key|secret)$/i.test(key)
          ? '[REDACTED]'
          : sanitize(item),
      ]),
    )
  return value
}

function errorRecord(error) {
  return sanitize({ name: error?.name || 'Error', message: String(error?.message || error) })
}

async function saveJson(file, value) {
  const temporary = `${file}.tmp`
  await writeFile(temporary, JSON.stringify(sanitize(value), null, 2), { mode: 0o600 })
  await rename(temporary, file)
}

async function saveReport() {
  report.updatedAt = new Date().toISOString()
  await saveJson(path.join(output, 'report.json'), report)
}

class ScopedClient extends Client {
  async raw(method, endpoint, body, options) {
    const allowed =
      (endpoint === '/login' && method === 'POST') ||
      (endpoint === '/health' && method === 'GET') ||
      (endpoint === '/conversations' && method === 'POST') ||
      (ownedId &&
        (endpoint === `/conversations/${ownedId}` ||
          endpoint.startsWith(`/conversations/${ownedId}/`)))
    assert.ok(allowed, `测试越界请求被拒绝：${method} ${endpoint}`)
    return super.raw(method, endpoint, body, {
      ...options,
      ...(typeof options?.timeout === 'number'
        ? { timeout: Math.max(1, Math.ceil(options.timeout)) }
        : {}),
    })
  }

  async login() {
    const result = await this.raw('POST', '/login', { username: 'admin', password: 'Demo123!' })
    assert.equal(result.status, 200, '测试账号登录成功')
    const cookie = result.response.headers.get('set-cookie')
    assert.ok(cookie?.includes('HttpOnly'))
    this.cookie = cookie.split(';')[0]
    this.csrf = result.json.csrf
    this.user = result.json.user
    assert.ok(this.csrf && this.user?.id)
    return this
  }
}

// Read-only projection of the real persisted history, matching server.mjs
// transcript(). This function supplies measurements only, never request history.
function historyEntryCount(conversation, beforeTurnId) {
  const messages = new Map(conversation.messages.map((message) => [message.id, message]))
  let count = 0
  for (const turn of conversation.turns) {
    if (turn.id === beforeTurnId) break
    if (messages.has(turn.inputMessageId)) count++
    if (!Array.isArray(turn.timeline)) {
      count += conversation.messages.filter(
        (message) => message.turnId === turn.id && message.id !== turn.inputMessageId,
      ).length
      continue
    }
    let hasAssistantText = false
    for (const part of turn.timeline) {
      if (
        (part.type === 'text' && part.text) ||
        (part.type === 'question' && part.question?.prompt)
      )
        hasAssistantText = true
      if (part.type === 'user') {
        if (hasAssistantText) count++
        hasAssistantText = false
        if (messages.has(part.messageId)) count++
      }
    }
    if (hasAssistantText) count++
  }
  return count
}

function promptFor(number) {
  if (number === 1)
    return `这是经授权的简短长对话测试。请在本会话中记住随机标记 ${memoryMarker}，后面会询问。第 1 轮只回复数字 1，不解释，不调用工具。`
  if (memoryRounds.has(number))
    return `第 ${number} 轮：只回复第 1 轮给出的随机记忆标记，不解释，不调用工具；确实不记得则只回复“不记得”。`
  return `第 ${number} 轮简短确认：只回复数字 ${number}，不解释，不调用工具。`
}

async function readOwned(timeout = 10_000) {
  const response = await client.api('GET', `/conversations/${ownedId}`, undefined, { timeout })
  assert.equal(response.conversation.id, ownedId)
  assert.equal(response.conversation.ownerId, client.user.id)
  assert.equal(response.conversation.mode, 'live')
  latestConversation = response.conversation
  return latestConversation
}

async function stopOwned(reason, attempt) {
  const conversation = await readOwned()
  if (!conversation.activeTurnId) return conversation
  const turnId = conversation.activeTurnId
  if (attempt) attempt.stop = { reason, turnId, requestedAt: new Date().toISOString() }
  const stopped = await client.raw('POST', `/conversations/${ownedId}/stop`, {
    requestId: requestId(),
    expectedTurnId: turnId,
  })
  if (attempt) attempt.stop.httpStatus = stopped.status
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    const current = await readOwned(Math.min(5000, Math.max(100, deadline - performance.now())))
    if (!current.activeTurnId) return current
    await sleep(pollIntervalMs)
  }
  throw new Error(`测试轮次未能在停止后结束：${turnId}`)
}

async function executeAttempt(logical, retryOf, deadline) {
  const before = await readOwned()
  assert.equal(before.activeTurnId, null, '仅在上一轮终态后发下一请求')
  const sourceTurn = retryOf && before.turns.find((turn) => turn.id === retryOf)
  const historyBefore = retryOf ? sourceTurn?.retryOfTurnId || retryOf : undefined
  const attempt = {
    attempt: logical.attempts.length + 1,
    requestId: requestId(),
    startedAt: new Date().toISOString(),
    historyEntriesBefore: historyEntryCount(before, historyBefore),
    sourceTurnCountBefore: before.turns.length,
    requestKind: retryOf ? 'retry' : 'send',
    retryOf: retryOf || null,
    readErrors: [],
    postTransportRetries: 0,
  }
  logical.attempts.push(attempt)
  const started = performance.now()
  const route = retryOf ? `/conversations/${ownedId}/retry` : `/conversations/${ownedId}/messages`
  const payload = retryOf
    ? { requestId: attempt.requestId, turnId: retryOf }
    : { requestId: attempt.requestId, text: logical.prompt, attachmentIds: [], delivery: 'send' }
  let response
  try {
    response = await client.raw('POST', route, payload, {
      timeout: Math.min(15_000, Math.max(100, deadline - performance.now())),
    })
  } catch (error) {
    attempt.initialTransportError = errorRecord(error)
    // Reusing the same key cannot intentionally create a second turn.
    attempt.postTransportRetries = 1
    response = await client.raw('POST', route, payload, {
      timeout: Math.min(15_000, Math.max(100, deadline - performance.now())),
    })
  }
  attempt.httpStatus = response.status
  attempt.requestReceiptMs = roundMs(performance.now() - started)
  if (response.status < 200 || response.status >= 300) {
    attempt.outcome = 'http-rejection'
    attempt.error = {
      code: response.json?.code || null,
      message: response.json?.error || response.body.slice(0, 500),
    }
    attempt.totalMs = roundMs(performance.now() - started)
    return attempt
  }
  attempt.turnId = response.json.receipt?.turnId || response.json.conversation?.activeTurnId
  assert.ok(attempt.turnId, '发送回执必须有真实 turnId')
  latestConversation = response.json.conversation
  let interruptionReason = null
  while (performance.now() < deadline) {
    if (stopRequested) {
      interruptionReason = 'operator-stop'
      break
    }
    let current
    const pollStarted = performance.now()
    try {
      current = await readOwned(Math.min(10_000, Math.max(100, deadline - performance.now())))
    } catch (error) {
      attempt.readErrors.push({ at: new Date().toISOString(), ...errorRecord(error) })
      await sleep(Math.min(500, Math.max(0, deadline - performance.now())))
      continue
    }
    const turn = current.turns.find((item) => item.id === attempt.turnId)
    assert.ok(turn, '已接收的轮次必须能由自己的会话快照恢复')
    attempt.runnerThreadId = turn.runnerThreadId || null
    attempt.runnerTurnId = turn.runnerTurnId || null
    attempt.runtimeContextRevision = current.runtimeContextRevision || 0
    attempt.runtimeSession = current.runtimeSession || null
    const text =
      current.messages.find((message) => message.id === turn.assistantMessageId)?.content || ''
    if (text.trim() && attempt.firstBodyObservedMs === undefined) {
      attempt.firstBodyObservedMs = roundMs(performance.now() - started)
      attempt.firstBodyObservationRequestMs = roundMs(performance.now() - pollStarted)
    }
    if (terminalStates.has(turn.status) && !current.activeTurnId) {
      attempt.status = turn.status
      attempt.outcome = turn.status === 'completed' ? 'completed' : 'terminal-failure'
      attempt.totalMs = roundMs(performance.now() - started)
      attempt.serverStartedAt = turn.startedAt
      attempt.serverCompletedAt = turn.completedAt
      attempt.text = text
      attempt.usage = turn.usage || null
      attempt.runtimeTimings = turn.runtimeTimings || null
      attempt.error = turn.error || null
      attempt.steps = turn.steps.map(({ id, name, status }) => ({ id, name, status }))
      attempt.historyEntriesAfter = historyEntryCount(current)
      await saveJson(
        path.join(
          output,
          `round-${String(logical.number).padStart(3, '0')}-attempt-${attempt.attempt}.json`,
        ),
        {
          measurement: attempt,
          turn,
          messages: current.messages.filter((message) => message.turnId === turn.id),
        },
      )
      return attempt
    }
    if (turn.status === 'waiting') {
      interruptionReason = 'unexpected-question'
      break
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - performance.now())))
  }
  attempt.outcome = interruptionReason || 'timeout'
  attempt.totalMs = roundMs(performance.now() - started)
  await stopOwned(attempt.outcome, attempt)
  const stoppedTurn = latestConversation.turns.find((turn) => turn.id === attempt.turnId)
  attempt.status = stoppedTurn?.status || null
  attempt.text =
    latestConversation.messages.find((message) => message.id === stoppedTurn?.assistantMessageId)
      ?.content || ''
  attempt.usage = stoppedTurn?.usage || null
  attempt.runtimeTimings = stoppedTurn?.runtimeTimings || null
  attempt.error = stoppedTurn?.error || null
  await saveJson(
    path.join(
      output,
      `round-${String(logical.number).padStart(3, '0')}-attempt-${attempt.attempt}.json`,
    ),
    {
      measurement: attempt,
      turn: stoppedTurn,
      messages: latestConversation.messages.filter((message) => message.turnId === attempt.turnId),
    },
  )
  return attempt
}

function summarize() {
  const attempts = report.rounds.flatMap((round) => round.attempts)
  const used = new Set()
  const usageTotals = {}
  for (const attempt of attempts) {
    if (!attempt.turnId || used.has(attempt.turnId) || attempt.usage?.scope !== 'turn') continue
    used.add(attempt.turnId)
    for (const key of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cachedInputTokens',
      'reasoningOutputTokens',
    ]) {
      const value = attempt.usage?.[key]
      if (typeof value === 'number') usageTotals[key] = (usageTotals[key] || 0) + value
    }
  }
  const completed = attempts.filter((attempt) => attempt.outcome === 'completed')
  const threadIds = [...new Set(completed.map((attempt) => attempt.runnerThreadId).filter(Boolean))]
  const sessionChecks = completed.map((attempt) => ({
    turnId: attempt.turnId,
    revision: attempt.runtimeContextRevision,
    runnerThreadId: attempt.runnerThreadId,
    confirmed: Boolean(
      attempt.runnerThreadId &&
      !attempt.runtimeSession?.pending &&
      attempt.runtimeSession?.threadId === attempt.runnerThreadId &&
      attempt.runtimeSession?.revision === attempt.runtimeContextRevision,
    ),
    usageScope: attempt.usage?.scope || null,
  }))
  report.summary = {
    logicalRoundsAttempted: report.rounds.length,
    completedLogicalRounds: report.rounds.filter((round) => round.completed).length,
    actualRecordedTurnCount: latestConversation?.turns.length || 0,
    acceptedTurnIds: attempts.filter((attempt) => attempt.turnId).map((attempt) => attempt.turnId),
    runnerStartedCount: attempts.filter((attempt) => attempt.runnerTurnId).length,
    providerRequestCount: null,
    attempts: attempts.length,
    firstBodyObservedMs: quantiles(
      completed.map((attempt) => attempt.firstBodyObservedMs).filter(Number.isFinite),
    ),
    totalMs: quantiles(completed.map((attempt) => attempt.totalMs).filter(Number.isFinite)),
    usageTotals,
    usageTotalsScope: 'turn-only',
    usageExcludedFromTotals: attempts
      .filter((attempt) => attempt.usage && attempt.usage.scope !== 'turn')
      .map((attempt) => ({ turnId: attempt.turnId, scope: attempt.usage.scope || 'unknown' })),
    latestThreadCumulativeUsage: completed.at(-1)?.usage?.threadTotal || null,
    usageReportingAttempts: attempts.filter((attempt) => attempt.usage).length,
    nativeSession: {
      threadIds,
      sameThreadAcrossAllRounds:
        completed.length > 0 &&
        threadIds.length === 1 &&
        sessionChecks.every((check) => check.confirmed),
      sessionChecks,
    },
    memory: report.rounds
      .filter((round) => round.memoryCheck)
      .map(({ number, completed, recallContainsMarker, responseExactlyMatches }) => ({
        number,
        completed,
        recallContainsMarker,
        responseExactlyMatches,
      })),
    failures: report.rounds
      .filter((round) => !round.completed)
      .map((round) => ({
        number: round.number,
        outcome: round.outcome,
        attempts: round.attempts.map(
          ({ turnId, outcome, historyEntriesBefore, error, runnerTurnId }) => ({
            turnId,
            outcome,
            historyEntriesBefore,
            error,
            runnerTurnId,
          }),
        ),
      })),
    formerHistoryBoundaryObserved: attempts.some((attempt) => attempt.historyEntriesBefore > 200),
    formerHistoryBoundaryEvidence: attempts
      .filter((attempt) => attempt.historyEntriesBefore >= 200)
      .map(({ turnId, status, historyEntriesBefore, outcome, error, runnerTurnId }) => ({
        turnId,
        status,
        historyEntriesBefore,
        outcome,
        error,
        runnerTurnId,
      })),
  }
  report.evaluationCompleted =
    report.rounds.length === logicalRoundCount && report.scriptErrors.length === 0
  report.allRequestedRoundsSucceeded =
    report.evaluationCompleted && report.rounds.every((round) => round.completed)
  report.nativeSessionValidated = report.summary.nativeSession.sameThreadAcrossAllRounds
  report.turnUsageValidated =
    completed.length > 0 && sessionChecks.every((check) => check.usageScope === 'turn')
  report.memoryValidated =
    report.summary.memory.length > 0 &&
    report.summary.memory.every((round) => round.completed && round.recallContainsMarker)
  report.passed =
    report.allRequestedRoundsSucceeded &&
    report.nativeSessionValidated &&
    report.turnUsageValidated &&
    (logicalRoundCount === 1 || report.memoryValidated)
}

try {
  await mkdir(output, { recursive: true, mode: 0o700 })
  report.scriptSha256 = createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex')
  report.buildHashSources = [
    'agent-demo/server.mjs',
    'agent-demo/fixtures.mjs',
    'agent-demo/attachments.mjs',
    'agent-demo/attachment-pdf-worker.mjs',
    'agent-demo/vendor/openchamber/health-wait.mjs',
  ]
  const build = createHash('sha256')
  for (const file of report.buildHashSources) build.update(await readFile(file))
  report.localServerBuildHash = build.digest('hex')
  client = new ScopedClient('admin', origin)
  await client.login()
  report.healthBefore = await client.api('GET', '/health')
  assert.equal(report.healthBefore.liveAvailable, true, '当前配置必须已连接真实运行器')
  report.remoteMatchesLocalServer = report.healthBefore.buildHash === report.localServerBuildHash
  assert.equal(
    report.remoteMatchesLocalServer,
    true,
    '远端主服务必须与本地待验收源码匹配，避免用旧版本继续消耗真实模型',
  )
  const created = await client.create({
    mode: 'live',
    visibility: 'private',
    title: `真实长对话验收 ${testId}`,
  })
  ownedId = created.id
  latestConversation = created
  report.conversationId = ownedId
  await saveReport()
  console.log(`真实长对话验收已建私有会话；目标 ${logicalRoundCount} 轮；证据 ${output}`)
  for (let number = 1; number <= logicalRoundCount && !stopRequested; number++) {
    const logical = {
      number,
      prompt: promptFor(number),
      memoryCheck: memoryRounds.has(number),
      attempts: [],
    }
    report.rounds.push(logical)
    const deadline = performance.now() + roundTimeoutMs
    let attempt = await executeAttempt(logical, null, deadline)
    if (
      !stopRequested &&
      attempt.outcome === 'terminal-failure' &&
      recoveryRetriesRemaining &&
      attempt.turnId &&
      deadline - performance.now() > 5000
    ) {
      recoveryRetriesRemaining--
      attempt = await executeAttempt(logical, attempt.turnId, deadline)
    }
    logical.completed = attempt.outcome === 'completed'
    logical.outcome = attempt.outcome
    logical.beyondFormerHistoryLimit = attempt.historyEntriesBefore > 200
    const text = (attempt.text || '').trim()
    logical.responseExactlyMatches = text === (logical.memoryCheck ? memoryMarker : String(number))
    if (logical.memoryCheck) logical.recallContainsMarker = text.includes(memoryMarker)
    summarize()
    await saveJson(path.join(output, 'conversation-latest.json'), latestConversation)
    await saveReport()
    if (number === 1 || number % 10 === 0 || number >= 100 || !logical.completed)
      console.log(
        `第 ${number}/${logicalRoundCount} 轮：${attempt.outcome}；history=${attempt.historyEntriesBefore}；首正文=${attempt.firstBodyObservedMs ?? '无'}ms；总耗时=${attempt.totalMs ?? '未知'}ms${logical.memoryCheck ? `；回忆=${logical.recallContainsMarker}` : ''}`,
      )
  }
} catch (error) {
  report.scriptErrors.push(errorRecord(error))
  console.error(`长对话测试脚本/传输异常：${errorRecord(error).message}`)
} finally {
  if (ownedId && client) {
    try {
      if ((await readOwned()).activeTurnId) await stopOwned('evaluation-cleanup')
      const finalConversation = await readOwned()
      await saveJson(path.join(output, 'conversation-final.json'), finalConversation)
      report.cleanup.evidenceSaved = true
      if (preserveConversation) {
        report.cleanup.pending = true
        report.cleanup.reason =
          'Preserved for explicitly coordinated read-only browser evaluation; caller owns subsequent deletion.'
      } else {
        report.cleanup.attempted = true
        const removed = await client.raw('DELETE', `/conversations/${ownedId}`)
        report.cleanup.httpStatus = removed.status
        report.cleanup.deleted = removed.status === 200
        if (!report.cleanup.deleted) report.cleanup.error = removed.json?.error || '删除未成功'
      }
    } catch (error) {
      report.cleanup.error = errorRecord(error)
    }
  }
  report.finishedAt = new Date().toISOString()
  report.operatorInterrupted = stopRequested
  summarize()
  try {
    await saveReport()
  } catch (error) {
    evaluationErrors.push(errorRecord(error))
  }
  console.log(
    JSON.stringify(
      sanitize({
        evaluationCompleted: report.evaluationCompleted,
        allRequestedRoundsSucceeded: report.allRequestedRoundsSucceeded,
        passed: report.passed,
        nativeSessionValidated: report.nativeSessionValidated,
        turnUsageValidated: report.turnUsageValidated,
        memoryValidated: report.memoryValidated,
        logicalRoundsAttempted: report.summary.logicalRoundsAttempted,
        completedLogicalRounds: report.summary.completedLogicalRounds,
        scriptErrors: report.scriptErrors,
        evidenceWriteErrors: evaluationErrors,
        cleanup: report.cleanup,
        report: path.join(output, 'report.json'),
      }),
    ),
  )
  if (
    !report.passed ||
    (!report.cleanup.deleted && !report.cleanup.pending) ||
    evaluationErrors.length
  )
    process.exitCode = 1
}
