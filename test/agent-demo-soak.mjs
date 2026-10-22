import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  Client,
  baseUrl,
  errorDetails,
  eventSeq,
  persistentEvents,
  quantiles,
  requestId,
  samples,
  sleep,
  until,
  writeEvidence,
} from './agent-demo-helpers.mjs'

// 持续验收明确使用 scenario。时长按墙钟计算，不将快速循环冒充持续运行。
const durationSeconds = Math.max(10, Number(process.env.AGENT_DEMO_SOAK_SECONDS) || 600)
const intervalMs = Math.max(1000, Number(process.env.AGENT_DEMO_SOAK_INTERVAL_MS) || 10000)
const started = performance.now()
const source = await readFile(new URL('../agent-demo/server.mjs', import.meta.url))
const report = {
  startedAt: new Date().toISOString(),
  baseUrl,
  mode: 'scenario',
  requestedDurationSeconds: durationSeconds,
  loopIntervalMs: intervalMs,
  localServerSourceSha256: createHash('sha256').update(source).digest('hex'),
  sourceBoundary: '本地源码哈希用于关联实现；远端部署是否同版本需另用部署记录证明。',
  clientNodeVersion: process.version,
  sendSamples: [],
  cycles: [],
  reconnects: 0,
  eventCount: 0,
  deltaCount: 0,
  duplicateEventCount: 0,
  transportReconnects: [],
  failures: [],
}
const client = await new Client('lin').login()
const conversations = await Promise.all(
  Array.from({ length: 5 }, (_, index) =>
    client.create({ title: `持续验收 ${index} ${requestId().slice(0, 6)}` }),
  ),
)
report.conversations = conversations.map(({ id, title, createdAt }) => ({ id, title, createdAt }))
report.initialHealth = await client.api('GET', '/health')
const ids = new Set(conversations.map((conversation) => conversation.id))
let cursor = Math.max(...conversations.map((conversation) => conversation.eventSeq))
let stream = await client.stream(cursor)
const acceptedTurnIds = new Set()
const observedEventIds = new Set()
const observedConversations = new Map()
const confirmationTimes = []

function consumeEvents() {
  const events = persistentEvents(stream.events.splice(0))
  for (const event of events) {
    const seq = eventSeq(event)
    if (observedEventIds.has(seq)) report.duplicateEventCount++
    assert.ok(!observedEventIds.has(seq), `重复事件 ${seq}`)
    assert.ok(seq > cursor, `事件次序倒退 ${seq} <= ${cursor}`)
    observedEventIds.add(seq)
    cursor = seq
    if (!ids.has(event.conversationId)) continue
    report.eventCount++
    if (event.type === 'conversation.updated')
      observedConversations.set(event.conversationId, event.payload.conversation)
    if (event.type === 'message.delta') {
      report.deltaCount++
      assert.ok(event.turnId, '增量必须属于明确轮次')
    }
  }
}

async function reconnectTransport(cycle) {
  const previous = stream
  report.transportReconnects.push({
    cycle,
    at: new Date().toISOString(),
    cursor,
    errors: [...previous.errors],
    transport: { ...previous.transport },
  })
  try {
    await previous.close()
  } catch {}
  stream = await client.stream(cursor)
}

async function requireSseSnapshots(expected, cycle) {
  const startedAt = performance.now()
  let reconnections = 0
  while (performance.now() - startedAt < 5000) {
    consumeEvents()
    if (
      expected.every((conversation) => {
        const observed = observedConversations.get(conversation.id)
        return (
          observed &&
          observed.eventSeq >= conversation.eventSeq &&
          observed.activeTurnId === null &&
          observed.queue.length === 0
        )
      })
    )
      return
    if (stream.closed) {
      if (++reconnections > 2) throw new Error('同一轮 SSE 重连超过2次')
      await reconnectTransport(cycle)
    }
    await sleep(20)
  }
  report.stalledStream = {
    cycle,
    cursor,
    transport: { ...stream.transport },
    closed: stream.closed,
    errors: [...stream.errors],
    expected: expected.map(({ id, eventSeq }) => ({ id, eventSeq })),
    observed: [...observedConversations].map(([id, conversation]) => ({
      id,
      eventSeq: conversation.eventSeq,
      status: conversation.status,
    })),
  }
  throw new Error('SSE 5秒内未补齐本轮全部终态；HTTP轮询不能替代事件流验收')
}

try {
  let cycle = 0
  while (performance.now() - started < durationSeconds * 1000) {
    if (stream.closed) await reconnectTransport(cycle)
    const cycleStarted = performance.now()
    const held = cycle % 4 === 3
    const cases = await Promise.all(
      conversations.map(async (conversation, index) => {
        const prompt = `持续验收第 ${cycle} 轮会话 ${index}：读取项目状态`
        const before = performance.now()
        const sent = await client.send(conversation.id, prompt, {
          scenario: { kind: held ? 'hold' : 'normal', stepDelayMs: 50 },
        })
        const elapsedMs = performance.now() - before
        confirmationTimes.push(elapsedMs)
        report.sendSamples.push({ cycle, conversationId: conversation.id, elapsedMs })
        const turnId = sent.conversation.activeTurnId
        assert.ok(turnId)
        assert.ok(!acceptedTurnIds.has(turnId), '新轮次 ID 不重复')
        acceptedTurnIds.add(turnId)
        return { id: conversation.id, prompt, turnId }
      }),
    )
    if (held) {
      await Promise.all(
        cases.map((item) =>
          client.send(item.id, `后续消息 ${cycle}`, {
            delivery: 'queue',
            scenario: { kind: 'normal', stepDelayMs: 50 },
          }),
        ),
      )
      await sleep(150)
      await Promise.all(cases.map((item) => client.stop(item.id, item.turnId)))
      for (const item of cases) {
        const stopped = await client.finish(item.id)
        assert.equal(stopped.queuePaused, true)
        assert.equal(stopped.queue.length, 1)
        const output = stopped.messages.find(
          (message) => message.role === 'assistant' && message.turnId === item.turnId,
        )?.content
        await sleep(30)
        const stable = await client.conversation(item.id)
        assert.equal(stable.activeTurnId, null)
        assert.equal(
          stable.messages.find(
            (message) => message.role === 'assistant' && message.turnId === item.turnId,
          )?.content,
          output,
        )
      }
      await Promise.all(
        cases.map((item) =>
          client.api('POST', `/conversations/${item.id}/queue/resume`, { requestId: requestId() }),
        ),
      )
    }
    if (cycle % 5 === 2) {
      consumeEvents()
      await stream.close()
      // 模拟页面断开；运行由服务端持续推进，重连只补事件。
      await sleep(250)
      stream = await client.stream(cursor)
      report.reconnects++
    }
    const completed = await Promise.all(
      cases.map((item) =>
        until(
          async () => {
            const current = await client.conversation(item.id)
            return !current.activeTurnId && !current.queue.length && current
          },
          `持续轮次 ${cycle} 完成`,
          10000,
          60,
        ),
      ),
    )
    for (let index = 0; index < cases.length; index++) {
      const current = completed[index]
      assert.equal(current.id, cases[index].id)
      assert.equal(
        current.messages.filter(
          (message) =>
            message.role === 'user' &&
            message.kind === 'prompt' &&
            message.content === cases[index].prompt,
        ).length,
        1,
      )
      assert.ok(current.turns.every((turn) => ['completed', 'interrupted'].includes(turn.status)))
    }
    await requireSseSnapshots(completed, cycle)
    const health = await client.api('GET', '/health')
    assert.equal(health.ok, true)
    assert.equal(health.buildHash, report.initialHealth.buildHash, '持续测试期间后端版本发生变化')
    report.cycles.push({
      cycle,
      kind: held ? 'stop-pause-resume' : 'normal',
      simultaneousConversations: 5,
      elapsedMs: Math.round(performance.now() - cycleStarted),
      totalTurns: completed.reduce((total, conversation) => total + conversation.turns.length, 0),
      eventCount: report.eventCount,
      sseTerminalVerified: true,
      health,
    })
    report.elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(2))
    report.sendConfirmationMs = quantiles(confirmationTimes)
    await writeEvidence('soak-progress.json', report)
    console.log(
      `持续验收 ${report.elapsedSeconds}s / ${durationSeconds}s：第 ${cycle + 1} 轮完成，累计 ${report.eventCount} 事件，${report.reconnects} 次重连`,
    )
    cycle++
    const remaining = durationSeconds * 1000 - (performance.now() - started)
    if (remaining > 0)
      await sleep(Math.min(Math.max(0, intervalMs - (performance.now() - cycleStarted)), remaining))
  }
  consumeEvents()
  assert.ok(report.eventCount > 0 && report.deltaCount > 0)
  assert.equal(report.duplicateEventCount, 0)
  assert.ok(
    report.sendConfirmationMs.p95 <= 500,
    `发送确认 p95 超标：${report.sendConfirmationMs.p95}ms`,
  )
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failures.push(errorDetails(error))
  console.error(JSON.stringify(errorDetails(error)))
  process.exitCode = 1
} finally {
  try {
    await stream.close()
  } catch (error) {
    report.streamCloseError = errorDetails(error)
    if (report.status === 'passed') {
      report.status = 'failed'
      report.failures.push(errorDetails(error))
      process.exitCode = 1
    }
  }
  for (const conversation of conversations) {
    try {
      const current = await client.conversation(conversation.id)
      if (current.activeTurnId) await client.stop(current.id, current.activeTurnId)
      await client.api('DELETE', `/conversations/${conversation.id}`)
    } catch (error) {
      report.cleanupError = errorDetails(error)
    }
  }
  report.completedAt = new Date().toISOString()
  report.elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(2))
  report.requestLatencyMs = quantiles(samples.map((sample) => sample.elapsedMs))
  report.sendConfirmationMs = quantiles(confirmationTimes)
  report.acceptedTurns = acceptedTurnIds.size
  console.log(`持续运行证据：${await writeEvidence('soak.json', report)}`)
}
