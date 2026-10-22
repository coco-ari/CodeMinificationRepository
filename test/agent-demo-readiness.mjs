import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { Client, requestId, sleep, until } from './agent-demo-helpers.mjs'

// Real main-service HTTP, SSE and SQLite with a controlled loopback Bridge.
// No Codex process, provider key, deployed service or model inference is used.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'autoops-readiness-'))
const report = {
  startedAt: new Date().toISOString(),
  mode: 'real-main-http-sse-sqlite-controlled-loopback-bridge',
  realModelCalls: 0,
  boundary:
    'Bridge health, connection resets and event timings are injected only into this isolated local test service.',
  checks: [],
}
const calls = []
const sockets = new Set()
const runs = new Map()
let healthMode = 'ready'
let failRunConnection = false
let child,
  client,
  stream,
  origin,
  logs = ''
const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}
const event = (run, value) => run.response?.write(`data: ${JSON.stringify(value)}\n\n`)
const complete = (run, timings) => {
  event(run, { type: 'delta', text: `已完成：${run.prompt}`, messagePhase: 'final_answer' })
  event(run, { type: 'completed', timings })
  run.response?.end()
}
const bridge = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    calls.push({
      path: url.pathname,
      method: request.method,
      runId: body.runId,
      at: Date.now(),
      healthMode,
    })
    if (url.pathname === '/health') {
      if (healthMode === 'reset') return response.destroy()
      return json(response, 200, {
        liveAvailable: healthMode === 'ready',
        name: '就绪验收 Bridge',
        version: 'controlled-test',
        reason: healthMode === 'ready' ? undefined : '测试运行器正在启动',
      })
    }
    if (url.pathname === '/runs' && request.method === 'POST') {
      if (failRunConnection) return response.destroy()
      assert.equal(healthMode, 'ready', 'main must not dispatch before Bridge readiness')
      assert.ok(!runs.has(body.runId), 'main must not dispatch a duplicate run')
      runs.set(body.runId, { ...body })
      return json(response, 200, { ok: true })
    }
    const match = url.pathname.match(/^\/runs\/([^/]+)\/events$/)
    if (match) {
      const run = runs.get(match[1])
      if (!run) return json(response, 404, { error: 'unknown test run' })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      run.response = response
      event(run, {
        type: 'started',
        runnerThreadId: `test-thread-${run.runId}`,
        runnerTurnId: `test-turn-${run.runId}`,
      })
      if (run.prompt === 'READINESS_METADATA') {
        event(run, {
          type: 'timing',
          phase: 'thread_ready',
          elapsedMs: 123,
          at: '2026-10-21T08:00:00.123Z',
        })
        event(run, { type: 'context.compaction', status: 'started' })
      } else complete(run)
      return
    }
    return json(response, 404, { error: 'unexpected test endpoint' })
  } catch (error) {
    report.bridgeError = error.stack
    if (!response.headersSent) json(response, 500, { error: error.message })
    else response.end()
  }
})
bridge.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})
const runPosts = (id) =>
  calls.filter(
    (call) => call.path === '/runs' && call.method === 'POST' && (!id || call.runId === id),
  )
const health = async () => (await fetch(`${origin}/api/agent-demo/health`)).json()
const ready = async () => {
  healthMode = 'ready'
  failRunConnection = false
  assert.equal((await health()).liveAvailable, true)
}
const persisted = (id) => {
  const db = new DatabaseSync(path.join(dataDir, 'demo.sqlite'), { readOnly: true })
  try {
    return JSON.parse(db.prepare('SELECT body FROM conversations WHERE id=?').get(id).body)
  } finally {
    db.close()
  }
}
const send = (id, text, key = requestId()) =>
  client.api('POST', `/conversations/${id}/messages`, {
    requestId: key,
    text,
    attachmentIds: [],
    delivery: 'send',
  })
const check = async (name, action) => {
  try {
    const detail = await action()
    report.checks.push({ name, passed: true, detail })
    console.log(`✓ ${name}`)
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.stack })
    console.error(`✗ ${name}: ${error.message}`)
  }
}
try {
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve))
  child = spawn(process.execPath, ['agent-demo/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: dataDir,
      AGENT_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`,
      AGENT_BRIDGE_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => {
    logs += chunk
    const match = logs.match(/"port":(\d+)/)
    if (match) origin = `http://127.0.0.1:${match[1]}`
  })
  child.stderr.on('data', (chunk) => {
    logs += chunk
  })
  await until(() => {
    if (child.exitCode !== null) throw new Error(`isolated service exited: ${logs}`)
    return origin
  }, 'isolated main service')
  await ready()
  client = await new Client('lin', origin).login()
  stream = await client.stream()

  await check(
    'sequential /health probes never return cached success after readiness changes',
    async () => {
      const before = calls.filter((call) => call.path === '/health').length
      healthMode = 'starting'
      const unavailable = await health()
      assert.equal(unavailable.liveAvailable, false)
      assert.equal((await client.api('GET', '/bootstrap')).runtime.liveAvailable, false)
      healthMode = 'ready'
      const recovered = await health()
      assert.equal(recovered.liveAvailable, true)
      assert.ok(calls.filter((call) => call.path === '/health').length >= before + 2)
      return {
        unavailable: unavailable.liveAvailable,
        recovered: recovered.liveAvailable,
        newProbeCount: calls.filter((call) => call.path === '/health').length - before,
      }
    },
  )

  await check(
    'accepted turn waits through brief unready interval and dispatches exactly once',
    async () => {
      await ready()
      const chat = await client.create({ mode: 'live' })
      healthMode = 'starting'
      const started = Date.now()
      const key = requestId()
      const accepted = await send(chat.id, 'READINESS_BRIEF_RECOVERY', key)
      const id = accepted.receipt.turnId
      assert.equal(accepted.receipt.status, 'accepted')
      await sleep(250)
      assert.equal(runPosts(id).length, 0)
      assert.equal((await health()).liveAvailable, false)
      assert.equal((await client.conversation(chat.id)).activeTurnId, id)
      const recoveredAt = Date.now()
      healthMode = 'ready'
      const done = await client.finish(chat.id)
      const turn = done.turns.at(-1)
      assert.equal(turn.status, 'completed')
      assert.equal(runPosts(id).length, 1)
      assert.ok(runPosts(id)[0].at >= recoveredAt)
      await send(chat.id, 'READINESS_BRIEF_RECOVERY', key)
      assert.equal(runPosts(id).length, 1)
      assert.equal((await client.conversation(chat.id)).turns.length, 1)
      assert.ok(Date.parse(turn.runtimeTimings.preparationCompletedAt) >= recoveredAt)
      return {
        elapsedMs: Date.now() - started,
        waitBeforeRecoveryMs: recoveredAt - started,
        runPostCount: 1,
        runtimeTimings: turn.runtimeTimings,
      }
    },
  )

  let failedChat
  await check(
    'persistent transport outage fails clearly after bounded preparation and durably preserves input',
    async () => {
      await ready()
      failedChat = await client.create({ mode: 'live' })
      healthMode = 'reset'
      const started = Date.now()
      const accepted = await send(failedChat.id, 'READINESS_PRESERVE_EXACT_INPUT_随机-238a')
      const id = accepted.receipt.turnId
      const done = await client.finish(failedChat.id, 6500)
      const elapsedMs = Date.now() - started
      const turn = done.turns.at(-1)
      assert.equal(turn.status, 'failed')
      assert.match(turn.error, /运行器|暂不可达/)
      assert.equal(runPosts(id).length, 0)
      assert.ok(elapsedMs >= 2800 && elapsedMs < 6000)
      assert.equal((await health()).liveAvailable, false)
      const durable = persisted(failedChat.id)
      assert.equal(
        durable.messages.find((message) => message.id === turn.inputMessageId).content,
        'READINESS_PRESERVE_EXACT_INPUT_随机-238a',
      )
      assert.equal(durable.turns.at(-1).status, 'failed')
      assert.ok(durable.turns.at(-1).runtimeTimings.preparationStartedAt)
      return { elapsedMs, error: turn.error, runPostCount: 0, persistedInput: true }
    },
  )

  await check(
    'a new request completes after recovery while the failed prior turn stays intact',
    async () => {
      assert.ok(failedChat)
      await ready()
      const prior = await client.conversation(failedChat.id)
      const accepted = await send(failedChat.id, 'READINESS_NEW_REQUEST_AFTER_RECOVERY')
      const done = await client.finish(failedChat.id)
      assert.equal(done.turns.at(-1).status, 'completed')
      assert.deepEqual(done.turns[0], prior.turns[0])
      assert.equal(runPosts(accepted.receipt.turnId).length, 1)
      return { turnStatuses: done.turns.map((turn) => turn.status), totalRunPosts: 1 }
    },
  )

  await check(
    'stop during preparation immediately interrupts and never submits a run after readiness returns',
    async () => {
      await ready()
      const chat = await client.create({ mode: 'live' })
      healthMode = 'starting'
      const before = calls.length
      const accepted = await send(chat.id, 'READINESS_STOP_BEFORE_MODEL')
      const id = accepted.receipt.turnId
      await until(
        () => calls.slice(before).some((call) => call.path === '/health'),
        'preparation probe started',
      )
      const stopStarted = Date.now()
      await client.stop(chat.id, id)
      const stopped = await client.finish(chat.id)
      const stopMs = Date.now() - stopStarted
      assert.equal(stopped.turns.at(-1).status, 'interrupted')
      assert.ok(stopMs < 1000)
      healthMode = 'ready'
      await sleep(3300)
      assert.equal(runPosts(id).length, 0)
      assert.equal(calls.filter((call) => call.path === `/runs/${id}/stop`).length, 0)
      assert.equal((await client.conversation(chat.id)).turns.at(-1).status, 'interrupted')
      return { stopMs, runPostCountAfterRecovery: 0, bridgeStopCount: 0 }
    },
  )

  await check(
    'run POST connection reset marks runtime unavailable immediately without retrying accepted dispatch',
    async () => {
      await ready()
      const chat = await client.create({ mode: 'live' })
      failRunConnection = true
      const before = stream.events.length
      const accepted = await send(chat.id, 'READINESS_RUN_CONNECTION_RESET')
      const done = await client.finish(chat.id)
      assert.equal(done.turns.at(-1).status, 'failed')
      assert.equal(runPosts(accepted.receipt.turnId).length, 1)
      await until(
        () =>
          stream.events
            .slice(before)
            .some(
              (entry) => entry.type === 'runtime.updated' && entry.payload.liveAvailable === false,
            ),
        'unavailable event after reset',
      )
      assert.equal((await client.api('GET', '/bootstrap')).runtime.liveAvailable, false)
      assert.equal(
        persisted(chat.id).messages.find((message) => message.role === 'user').content,
        'READINESS_RUN_CONNECTION_RESET',
      )
      return { runPostCount: 1, runtimeInvalidated: true, inputPersisted: true }
    },
  )

  await check(
    'turn usage, runtime timings and compaction transitions survive HTTP snapshots and SQLite',
    async () => {
      await ready()
      const chat = await client.create({ mode: 'live' })
      const accepted = await send(chat.id, 'READINESS_METADATA')
      const id = accepted.receipt.turnId
      const compacting = await until(async () => {
        const value = await client.conversation(chat.id)
        return value.turns.at(-1).phase === 'context_compacting' && value
      }, 'compaction phase')
      assert.equal(compacting.turns.at(-1).runtimeTimings.thread_ready.elapsedMs, 123)
      const run = runs.get(id)
      event(run, { type: 'context.compaction', status: 'completed' })
      await until(
        async () => (await client.conversation(chat.id)).turns.at(-1).phase === 'awaiting_model',
        'compaction finished phase',
      )
      event(run, {
        type: 'usage',
        scope: 'turn',
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        threadTotal: { inputTokens: 111, outputTokens: 77, totalTokens: 188 },
        last: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      })
      complete(run, { firstDeltaMs: 456, totalMs: 789 })
      const done = await client.finish(chat.id)
      const durable = persisted(chat.id)
      assert.deepEqual(durable.turns.at(-1), done.turns.at(-1))
      const turn = durable.turns.at(-1)
      assert.equal(turn.usage.scope, 'turn')
      assert.equal(turn.usage.totalTokens, 18)
      assert.equal(turn.usage.threadTotal.totalTokens, 188)
      assert.equal(turn.runtimeTimings.thread_ready.elapsedMs, 123)
      assert.deepEqual(turn.runtimeTimings.runner, { firstDeltaMs: 456, totalMs: 789 })
      await until(
        () =>
          stream.events.some(
            (entry) =>
              entry.conversationId === chat.id &&
              entry.payload?.conversation?.turns.at(-1)?.phase === 'context_compacting',
          ),
        'compaction SSE snapshot',
      )
      const db = new DatabaseSync(path.join(dataDir, 'demo.sqlite'), { readOnly: true })
      const phases = db
        .prepare('SELECT body FROM events WHERE cid=? ORDER BY seq')
        .all(chat.id)
        .map((row) => JSON.parse(row.body).payload?.conversation?.turns.at(-1)?.phase)
        .filter(Boolean)
      db.close()
      assert.ok(phases.includes('context_compacting'))
      return {
        phases,
        usage: turn.usage,
        runtimeTimings: turn.runtimeTimings,
        sqliteVerified: true,
      }
    },
  )
} catch (error) {
  report.error = error.stack
} finally {
  await stream?.close().catch((error) => {
    report.streamError = error.stack
  })
  for (const run of runs.values()) run.response?.end()
  if (child?.exitCode === null) {
    const exit = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exit
  }
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => bridge.close(resolve))
  report.finishedAt = new Date().toISOString()
  report.calls = calls
  report.passed =
    !report.error &&
    !report.streamError &&
    !report.bridgeError &&
    report.checks.length === 7 &&
    report.checks.every((check) => check.passed)
  report.sourceHashes = Object.fromEntries(
    await Promise.all(
      ['agent-demo/server.mjs', 'agent-demo/vendor/openchamber/health-wait.mjs'].map(
        async (file) => [
          file,
          createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
        ],
      ),
    ),
  )
  await mkdir('.test-artifacts/agent-demo-readiness', { recursive: true })
  await writeFile(
    '.test-artifacts/agent-demo-readiness/report.json',
    JSON.stringify(report, null, 2),
  )
  await rm(dataDir, { recursive: true, force: true })
  if (!report.passed) {
    console.error(
      report.error || report.streamError || report.bridgeError || 'readiness assertions failed',
    )
    process.exitCode = 1
  }
}
