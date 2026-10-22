import assert from 'node:assert/strict'
import {
  Client,
  errorDetails,
  eventSeq,
  isolatedServer,
  persistentEvents,
  sleep,
  until,
  writeEvidence,
} from './agent-demo-helpers.mjs'

// 定向构造超过1MiB的授权事件回放，验证慢客户端不会拖垮服务或静默丢失事件。
const server = await isolatedServer()
const report = {
  startedAt: new Date().toISOString(),
  mode: 'scenario',
  target: '独立临时服务',
  status: 'running',
}
let stream
try {
  const client = await new Client('lin', server.origin).login()
  const conversation = await client.create()
  for (let round = 0; round < 12; round++) {
    await client.send(conversation.id, `回放负载 ${round} ${'资料 '.repeat(5000)}`, {
      scenario: { kind: 'normal', stepDelayMs: 10 },
    })
    await client.finish(conversation.id)
  }
  const current = await client.conversation(conversation.id)
  report.conversationSnapshotBytes = Buffer.byteLength(JSON.stringify(current))
  const early = await client.stream(conversation.eventSeq, {}, { readDelayMs: 200 })
  await sleep(20)
  await early.close()
  report.earlyCloseHealth = await client.api('GET', '/health')
  assert.equal(report.earlyCloseHealth.ok, true)
  stream = await client.stream(conversation.eventSeq, {}, { readDelayMs: 10 })
  // 回放尚在消费时追加四次事件，验证回放与实时切换间没有空隙。
  for (let update = 0; update < 4; update++) {
    await client.api('PATCH', `/conversations/${conversation.id}`, {
      title: `回放中更新 ${update}`,
    })
    await sleep(15)
  }
  const latest = await client.conversation(conversation.id)
  report.expectedLastSeq = latest.eventSeq
  const healthStart = performance.now()
  report.healthDuringSlowRead = await client.api('GET', '/health')
  report.healthDuringSlowReadMs = performance.now() - healthStart
  await until(
    () => stream.events.some((event) => event.type === 'ready') || stream.closed,
    '大型回放完成或连接关闭',
    15000,
  )
  await sleep(100)
  const events = persistentEvents(stream.events)
  report.receivedEventCount = events.length
  report.receivedBytes = events.reduce(
    (total, event) => total + Buffer.byteLength(JSON.stringify(event)),
    0,
  )
  report.receivedLastSeq = Math.max(0, ...events.map(eventSeq))
  report.streamErrors = stream.errors
  report.server = server.state()
  const health = await client.api('GET', '/health')
  assert.equal(health.ok, true)
  assert.ok(report.receivedBytes > 1024 * 1024, '测试必须实际覆盖超过1MiB的回放')
  assert.equal(report.receivedLastSeq, latest.eventSeq, '回放期间产生的新事件也必须补至最新状态')
  assert.ok(
    stream.events.some((event) => event.type === 'ready'),
    '回放完成后可进入实时流',
  )
  assert.equal(new Set(events.map(eventSeq)).size, events.length)
  assert.equal(
    events.filter((event) => event.payload?.conversation?.title === '回放中更新 3').length,
    1,
  )
  report.finalHealth = health
  await stream.close()
  stream = null

  const parallel = await Promise.all(Array.from({ length: 5 }, () => client.create()))
  for (let round = 0; round < 6; round++) {
    await Promise.all(
      parallel.map((conversation) =>
        client.send(conversation.id, `实时流历史 ${round} ${'上下文 '.repeat(2500)}`, {
          scenario: { kind: 'normal', stepDelayMs: 10 },
        }),
      ),
    )
    await Promise.all(parallel.map((conversation) => client.finish(conversation.id)))
  }
  const baseline = await Promise.all(
    parallel.map((conversation) => client.conversation(conversation.id)),
  )
  let cursor = Math.max(...baseline.map((conversation) => conversation.eventSeq))
  stream = await client.stream(cursor, {}, { readDelayMs: 20 })
  const seen = new Set()
  const snapshots = new Map()
  report.realtime = { cycles: [], bytes: 0, events: 0, reconnects: 0 }
  const consume = () => {
    for (const event of persistentEvents(stream.events.splice(0))) {
      const seq = eventSeq(event)
      assert.ok(seq > cursor)
      assert.ok(!seen.has(seq))
      seen.add(seq)
      cursor = seq
      report.realtime.bytes += Buffer.byteLength(JSON.stringify(event))
      report.realtime.events++
      if (event.type === 'conversation.updated')
        snapshots.set(event.conversationId, event.payload.conversation)
    }
  }
  for (let round = 0; round < 4; round++) {
    await Promise.all(
      parallel.map((conversation) =>
        client.send(conversation.id, `五会话实时流 ${round}`, {
          scenario: { kind: 'normal', stepDelayMs: 10 },
        }),
      ),
    )
    if (round === 2) {
      consume()
      await stream.close()
      await sleep(100)
      stream = await client.stream(cursor, {}, { readDelayMs: 20 })
      report.realtime.reconnects++
    }
    const ended = await Promise.all(parallel.map((conversation) => client.finish(conversation.id)))
    await until(
      () => {
        consume()
        assert.equal(stream.closed, false, '慢读中的实时流不应被静默关闭')
        assert.deepEqual(stream.errors, [])
        return ended.every((conversation) => {
          const received = snapshots.get(conversation.id)
          return (
            received && received.activeTurnId === null && received.eventSeq >= conversation.eventSeq
          )
        })
      },
      '五会话所有终态都从SSE到达',
      15000,
      20,
    )
    report.realtime.cycles.push({ round, terminalSnapshots: ended.length, lastSeq: cursor })
  }
  assert.ok(report.realtime.bytes > 1024 * 1024)
  report.finalHealth = await client.api('GET', '/health')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = errorDetails(error)
  report.server = server.state()
  console.error(JSON.stringify(report.error))
  process.exitCode = 1
} finally {
  if (stream) {
    try {
      await stream.close()
    } catch (error) {
      report.streamCloseError = errorDetails(error)
    }
  }
  await server.stop()
  report.completedAt = new Date().toISOString()
  console.log(`大型 SSE 回放证据：${await writeEvidence('sse-load.json', report)}`)
}
