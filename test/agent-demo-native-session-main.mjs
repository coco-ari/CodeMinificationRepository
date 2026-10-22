import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { Client, requestId, until } from './agent-demo-helpers.mjs'

// Main-service native-session contract, with a controlled local HTTP Bridge.
// No runner/model process, deployed service or provider credential is used.
const directory = await mkdtemp(path.join(os.tmpdir(), 'autoops-native-main-'))
const hashServer = async () =>
  createHash('sha256')
    .update(await readFile('agent-demo/server.mjs'))
    .digest('hex')
const report = {
  startedAt: new Date().toISOString(),
  mode: 'real-main-http-sqlite-controlled-native-session-bridge',
  realModelCalls: 0,
  sourceHashBefore: await hashServer(),
  checks: [],
}
const bindings = new Map()
const runs = new Map()
const calls = []
const sockets = new Set()
let child,
  origin,
  client,
  logs = ''
const json = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
const event = (run, value) => run.response?.write(`data: ${JSON.stringify(value)}\n\n`)
const start = (run) =>
  event(run, {
    type: 'started',
    sessionMode: 'native',
    runnerThreadId: run.threadId,
    runnerTurnId: `native-turn-${run.runId}`,
  })
const complete = (run) => {
  event(run, { type: 'delta', text: `答复：${run.prompt}`, messagePhase: 'final_answer' })
  event(run, { type: 'completed' })
  run.terminal = true
  run.response?.end()
}
const bridge = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    calls.push({
      method: request.method,
      path: url.pathname,
      at: Date.now(),
      runId: body.runId,
      session: body.session,
      historyLength: body.history?.length,
    })
    if (url.pathname === '/health')
      return json(response, 200, {
        liveAvailable: true,
        name: 'native-session-test',
        capabilities: { sessions: { native: true, durable: true } },
      })
    if (request.method === 'DELETE' && url.pathname.startsWith('/sessions/')) {
      const id = decodeURIComponent(url.pathname.slice('/sessions/'.length))
      assert.ok(
        ![...runs.values()].some((run) => run.session.id === id && !run.terminal),
        'active native runs cannot be deleted',
      )
      bindings.delete(id)
      for (const [runId, run] of runs) if (run.session.id === id) runs.delete(runId)
      return json(response, 200, { deleted: true })
    }
    if (url.pathname === '/runs' && request.method === 'POST') {
      assert.ok(body.session?.id)
      let binding = bindings.get(body.session.id)
      if (body.session.expectedThreadId) {
        assert.equal(binding?.threadId, body.session.expectedThreadId)
        assert.equal(binding.revision, body.session.revision)
        assert.deepEqual(
          body.history,
          [],
          'confirmed native session must receive an incremental turn',
        )
      } else if (!binding || binding.revision !== body.session.revision) {
        binding = {
          revision: body.session.revision,
          threadId: `native-${body.session.id}-r${body.session.revision}`,
        }
        bindings.set(body.session.id, binding)
      }
      assert.ok(!runs.has(body.runId), 'run submission must not be duplicated')
      const run = { ...body, threadId: binding.threadId, terminal: false }
      runs.set(run.runId, run)
      if (run.prompt === 'NATIVE_LOST_ACK') {
        // The request reached the runner and its task settled, but the HTTP
        // receipt was lost before the main service could subscribe to events.
        run.terminal = true
        return response.destroy()
      }
      return json(response, 202, { accepted: true })
    }
    const match = url.pathname.match(/^\/runs\/([^/]+)\/(events|stop)$/)
    if (match) {
      const run = runs.get(match[1])
      if (!run) return json(response, 404, { error: 'unknown run' })
      if (match[2] === 'stop') {
        run.terminal = true
        event(run, { type: 'interrupted' })
        run.response?.end()
        return json(response, 200, { accepted: true, status: 'interrupted' })
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
      run.response = response
      if (run.prompt === 'NATIVE_HOLD_START' || run.prompt === 'NATIVE_STOP_PENDING') return
      if (run.prompt === 'NATIVE_FAIL_PENDING') {
        run.terminal = true
        event(run, { type: 'failed', error: 'controlled failure before started confirmation' })
        response.end()
        return
      }
      start(run)
      complete(run)
      return
    }
    return json(response, 404, { error: 'unexpected controlled route' })
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
const persisted = (id) => {
  const db = new DatabaseSync(path.join(directory, 'demo.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('SELECT body FROM conversations WHERE id=?').get(id)
    return row ? JSON.parse(row.body) : null
  } finally {
    db.close()
  }
}
const send = (id, text) =>
  client.api('POST', `/conversations/${id}/messages`, {
    requestId: requestId(),
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
const deleteAndVerify = async (id) => {
  await client.api('DELETE', `/conversations/${id}`)
  assert.equal(bindings.has(id), false)
  assert.equal(persisted(id), null)
  assert.equal(
    calls.filter((call) => call.method === 'DELETE' && call.path === `/sessions/${id}`).length,
    1,
  )
}
try {
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve))
  child = spawn(process.execPath, ['agent-demo/server.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: directory,
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
    if (child.exitCode !== null) throw new Error(logs)
    return origin
  }, 'isolated main service')
  await until(
    async () => (await (await fetch(`${origin}/api/agent-demo/health`)).json()).liveAvailable,
    'native capability health',
  )
  client = await new Client('lin', origin).login()

  await check(
    '202 acceptance is pending until started; confirmed revision sends only new input; retry bootstraps a new revision',
    async () => {
      const chat = await client.create({ mode: 'live' })
      const first = await send(chat.id, 'NATIVE_HOLD_START')
      const firstRun = await until(
        () => runs.get(first.receipt.turnId)?.response && runs.get(first.receipt.turnId),
        '202 accepted pending run',
      )
      const pending = await client.conversation(chat.id)
      assert.deepEqual(pending.runtimeSession, { pending: true, revision: 0 })
      assert.deepEqual(persisted(chat.id).runtimeSession, pending.runtimeSession)
      assert.deepEqual(firstRun.history, [])
      assert.equal(firstRun.session.expectedThreadId, undefined)
      start(firstRun)
      complete(firstRun)
      const firstDone = await client.finish(chat.id)
      assert.deepEqual(firstDone.runtimeSession, { threadId: firstRun.threadId, revision: 0 })
      const second = await send(chat.id, 'NATIVE_SECOND')
      const secondDone = await client.finish(chat.id)
      const secondRun = runs.get(second.receipt.turnId)
      assert.equal(secondRun.session.expectedThreadId, firstRun.threadId)
      assert.deepEqual(secondRun.history, [])
      assert.equal(secondDone.turns.at(-1).runnerThreadId, firstRun.threadId)
      const retry = await client.api('POST', `/conversations/${chat.id}/retry`, {
        requestId: requestId(),
        turnId: second.receipt.turnId,
        expectedRevision: secondDone.revision,
      })
      const retryDone = await client.finish(chat.id)
      const retryRun = runs.get(retry.receipt.turnId)
      assert.equal(retryRun.session.revision, 1)
      assert.equal(retryRun.session.expectedThreadId, undefined)
      assert.ok(retryRun.history.length >= 2)
      assert.ok(JSON.stringify(retryRun.history).includes('NATIVE_HOLD_START'))
      assert.ok(
        !JSON.stringify(retryRun.history).includes('NATIVE_SECOND'),
        'retry must not bootstrap its own discarded answer',
      )
      assert.notEqual(retryRun.threadId, firstRun.threadId)
      assert.deepEqual(retryDone.runtimeSession, { threadId: retryRun.threadId, revision: 1 })
      await deleteAndVerify(chat.id)
      return {
        initialPending: pending.runtimeSession,
        firstThread: firstRun.threadId,
        secondThread: secondRun.threadId,
        secondHistoryLength: secondRun.history.length,
        retryRevision: retryRun.session.revision,
        retryHistoryLength: retryRun.history.length,
        deleteClearedBinding: true,
      }
    },
  )

  await check(
    'stop before started confirmation keeps pending ownership and DELETE clears the native binding',
    async () => {
      const chat = await client.create({ mode: 'live' })
      const accepted = await send(chat.id, 'NATIVE_STOP_PENDING')
      await until(() => runs.get(accepted.receipt.turnId)?.response, 'pending native run stream')
      assert.equal((await client.conversation(chat.id)).runtimeSession.pending, true)
      await client.stop(chat.id, accepted.receipt.turnId)
      const stopped = await client.finish(chat.id)
      assert.equal(stopped.turns.at(-1).status, 'interrupted')
      assert.equal(stopped.runtimeSession.pending, true)
      await deleteAndVerify(chat.id)
      return { status: 'interrupted', deletedPendingBinding: true }
    },
  )

  for (const prompt of ['NATIVE_FAIL_PENDING', 'NATIVE_LOST_ACK']) {
    await check(
      `${prompt}: failure without started confirmation still cleans up native ownership on DELETE`,
      async () => {
        await fetch(`${origin}/api/agent-demo/health`)
        const chat = await client.create({ mode: 'live' })
        const accepted = await send(chat.id, prompt)
        const failed = await client.finish(chat.id)
        assert.equal(failed.turns.at(-1).status, 'failed')
        assert.equal(failed.runtimeSession.pending, true)
        assert.equal(failed.turns.at(-1).runnerThreadId, undefined)
        assert.ok(bindings.has(chat.id))
        assert.equal(
          calls.filter((call) => call.path === '/runs' && call.runId === accepted.receipt.turnId)
            .length,
          1,
        )
        await deleteAndVerify(chat.id)
        return {
          status: 'failed',
          confirmedThread: false,
          runPostCount: 1,
          deletedPendingBinding: true,
        }
      },
    )
  }
} catch (error) {
  report.error = error.stack
} finally {
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
  report.sourceHashAfter = await hashServer()
  report.sourceUnchanged = report.sourceHashAfter === report.sourceHashBefore
  report.passed =
    !report.error &&
    !report.bridgeError &&
    report.sourceUnchanged &&
    report.checks.length === 4 &&
    report.checks.every((check) => check.passed)
  await mkdir('.test-artifacts/agent-demo-native-session-main', { recursive: true })
  await writeFile(
    '.test-artifacts/agent-demo-native-session-main/report.json',
    JSON.stringify(report, null, 2),
  )
  await rm(directory, { recursive: true, force: true })
  if (!report.passed) {
    console.error(
      report.error ||
        report.bridgeError ||
        (!report.sourceUnchanged
          ? 'server changed during test; rerun against a fixed source'
          : 'native-session assertions failed'),
    )
    process.exitCode = 1
  }
}
