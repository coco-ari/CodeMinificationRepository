import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, requestId, sleep, until, writeEvidence } from './agent-demo-helpers.mjs'

// 受控 Bridge 验证 live 适配层的错误与时序；这里不连接模型，不计入真实模型验收。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'autoops-agent-bridge-test-'))
const runs = new Map()
const sockets = new Set()
let available = true
let bridgeCalls = []
let child
const report = {
  startedAt: new Date().toISOString(),
  mode: 'controlled-bridge',
  evidenceBoundary: '验证 live 适配器的 HTTP/SSE 协议处理，Bridge 为测试替身，无真实模型推理。',
  checks: [],
}
const writeJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const event = (run, item) => {
  if (!run.res?.destroyed && !run.res?.writableEnded)
    run.res?.write(`data: ${JSON.stringify(item)}\n\n`)
}
const complete = (run, type = 'completed') => {
  event(run, { type })
  run.res?.end()
}

const bridge = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    bridgeCalls.push({ path: url.pathname, method: req.method, runId: body.runId })
    if (url.pathname === '/health')
      return writeJson(res, 200, {
        liveAvailable: available,
        name: '协议测试替身',
        version: 'test-only',
      })
    if (url.pathname === '/runs' && req.method === 'POST') {
      const run = { ...body, answers: 0, steers: 0, stops: 0 }
      runs.set(body.runId, run)
      return writeJson(res, 200, { ok: true })
    }
    const match = url.pathname.match(/^\/runs\/([^/]+)\/(events|steer|answer|stop)$/)
    if (!match) return writeJson(res, 404, { error: 'not found' })
    const run = runs.get(match[1])
    if (!run) return writeJson(res, 404, { error: 'unknown run' })
    if (match[2] === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      run.res = res
      event(run, {
        type: 'started',
        runnerThreadId: `thread-${run.runId}`,
        runnerTurnId: `turn-${run.runId}`,
      })
      if (run.prompt === 'UTF8_BOUNDARY') {
        const encoded = Buffer.from(
          `data: ${JSON.stringify({ type: 'delta', text: '设备连接正常。' })}\n\n`,
        )
        const split = encoded.indexOf(Buffer.from('设备')) + 1
        res.write(encoded.subarray(0, split))
        await sleep(40)
        res.write(encoded.subarray(split))
        await sleep(40)
        complete(run)
      } else if (run.prompt === 'TIMELINE_ORDER') {
        event(run, { type: 'delta', itemId: 'intro', text: '开始检查。' })
        event(run, { type: 'delta', itemId: 'intro', text: '先看资料。' })
        event(run, { type: 'delta', itemId: 'progress', text: '现在读取配置。' })
        event(run, { type: 'tool', id: 'read-config', name: '读取配置', status: 'running' })
        event(run, { type: 'delta', itemId: 'progress', text: '读取过程中说明。' })
        event(run, {
          type: 'tool',
          id: 'read-config',
          name: '读取配置',
          status: 'completed',
          output: '已读取',
        })
      } else if (run.prompt === 'QUESTION_IDEMPOTENCY') {
        event(run, { type: 'delta', text: '请先选择检查范围。' })
        event(run, {
          type: 'question',
          id: 'question-test',
          prompt: '检查哪一项？',
          options: ['测试环境'],
        })
      } else if (run.prompt === 'MESSAGE_PHASE') {
        event(run, {
          type: 'delta',
          itemId: 'progress',
          text: '先读资料。',
          messagePhase: 'commentary',
        })
        event(run, { type: 'tool', id: 'read-phase', name: '读取配置', status: 'running' })
        event(run, { type: 'delta', itemId: 'progress', text: '资料已读。' })
        event(run, { type: 'tool', id: 'read-phase', name: '读取配置', status: 'completed' })
        event(run, { type: 'delta', itemId: 'progress', text: '', messagePhase: 'commentary' })
        event(run, { type: 'delta', itemId: 'answer', text: '检查结果。' })
      } else if (run.prompt === 'STREAM_DROPPED') {
        event(run, { type: 'delta', text: '连接中断前已生成的内容。' })
        await sleep(40)
        res.end()
      } else {
        event(run, { type: 'delta', text: '已读取资料，等待后续指令。' })
      }
      return
    }
    if (match[2] === 'steer') {
      if (!body.requestId) return writeJson(res, 400, { error: 'requestId required' })
      run.steers++
      if (run.prompt === 'STEER_FINISH_RACE') {
        complete(run)
        await sleep(100)
        return writeJson(res, 409, { accepted: false, error: 'turn completed' })
      }
      if (run.prompt === 'TIMELINE_ORDER') {
        event(run, { type: 'delta', itemId: 'progress', text: '已按补充指令继续。' })
        await sleep(100)
      }
      return writeJson(res, 200, { accepted: true })
    }
    if (match[2] === 'answer') {
      if (!body.requestId) return writeJson(res, 400, { error: 'requestId required' })
      run.answers++
      if (run.prompt === 'TIMELINE_ORDER') {
        event(run, { type: 'delta', itemId: 'progress', text: '已按澄清答案继续。' })
        complete(run)
      }
      await sleep(100)
      return writeJson(res, 200, { accepted: true })
    }
    if (match[2] === 'stop') {
      if (!body.requestId) return writeJson(res, 400, { error: 'requestId required' })
      run.stops++
      if (run.prompt === 'STOP_DELAYED_ACCEPT') {
        writeJson(res, 200, { accepted: true, runId: run.runId, status: 'stopping' })
        await sleep(50)
        event(run, { type: 'delta', text: '停止请求之后不应追加的晚到正文' })
        await sleep(450)
        complete(run, 'interrupted')
        return
      }
      if (run.prompt === 'STOP_FAIL') {
        await sleep(80)
        return writeJson(res, 503, { error: 'test upstream stop failed' })
      }
      if (run.prompt === 'STOP_FINISH_RACE') {
        complete(run)
        await sleep(250)
        return writeJson(res, 503, { error: 'late failure for previous turn' })
      }
      complete(run, 'interrupted')
      return writeJson(res, 200, { accepted: true })
    }
  } catch (error) {
    if (!res.headersSent) writeJson(res, 500, { error: error.message })
    else res.end()
  }
})
bridge.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})
await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve))
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`
const reservation = http.createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const origin = `http://127.0.0.1:${port}`

async function check(name, fn) {
  try {
    const detail = await fn()
    report.checks.push({ name, status: 'passed', detail })
    console.log(`通过：${name}`)
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.stack })
    console.error(`失败：${name}\n${error.stack}`)
  }
}
let client
async function liveChat(text) {
  const conversation = await client.create({ mode: 'live' })
  const sent = await client.send(conversation.id, text, { scenario: undefined })
  await until(() => runs.get(sent.conversation.activeTurnId)?.res, 'Bridge SSE 已建立')
  return {
    id: conversation.id,
    turnId: sent.conversation.activeTurnId,
    run: runs.get(sent.conversation.activeTurnId),
  }
}
const textOf = (conversation, turnId) =>
  conversation.messages.find((message) => message.role === 'assistant' && message.turnId === turnId)
    ?.content

try {
  child = spawn(process.execPath, [path.join(root, 'agent-demo/server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      AGENT_BRIDGE_URL: bridgeUrl,
      AGENT_BRIDGE_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (data) => {
    output = (output + data).slice(-3000)
  })
  child.stderr.on('data', (data) => {
    output = (output + data).slice(-3000)
  })
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`测试服务退出：${output}`)
    try {
      const response = await fetch(`${origin}/api/agent-demo/health`)
      return response.ok && (await response.json()).liveAvailable
    } catch {
      return false
    }
  }, '服务连接受控 Bridge')
  client = await new Client('lin', origin).login()

  await check('中文 UTF-8 跨网络 chunk 不损坏', async () => {
    const chat = await liveChat('UTF8_BOUNDARY')
    const completed = await client.finish(chat.id)
    assert.equal(completed.turns[0].status, 'completed')
    assert.equal(textOf(completed, chat.turnId), '设备连接正常。')
  })

  await check('真实消息相位保留到时间线；晚到 final 更新既有正文，断线重放与快照一致', async () => {
    const chat = await liveChat('MESSAGE_PHASE')
    const initial = await until(async () => {
      const value = await client.conversation(chat.id)
      return value.turns[0].timeline.at(-1)?.itemId === 'answer' && value
    }, '已收到未分类的回答')
    const original = initial.turns[0].timeline
    assert.deepEqual(
      original.map((part) => part.type),
      ['text', 'tool', 'text', 'text'],
    )
    assert.equal(original[0].messagePhase, 'commentary')
    assert.equal(original[2].messagePhase, 'commentary')
    assert.equal(original[3].messagePhase, undefined)
    const beforePhase = initial.eventSeq
    assert.ok(Number.isInteger(beforePhase))
    event(chat.run, { type: 'delta', itemId: 'answer', text: '', messagePhase: 'final_answer' })
    event(chat.run, { type: 'delta', itemId: 'answer', text: '', messagePhase: 'final_answer' })
    event(chat.run, {
      type: 'delta',
      itemId: 'unknown',
      text: '相位未知。',
      messagePhase: 'invalid',
    })
    complete(chat.run)
    const done = await client.finish(chat.id)
    const turn = done.turns[0]
    assert.equal(turn.timeline.length, 5)
    assert.equal(turn.timeline[3].id, original[3].id)
    assert.equal(turn.timeline[3].messagePhase, 'final_answer')
    assert.equal(turn.timeline[4].messagePhase, undefined)
    assert.equal(textOf(done, chat.turnId), '先读资料。资料已读。检查结果。相位未知。')
    assert.ok(turn.steps[0].completedAt >= turn.steps[0].startedAt)
    const reconnected = await client.stream(beforePhase)
    try {
      const finalEvent = await until(
        () =>
          reconnected.events.findLast(
            (item) =>
              item.conversationId === chat.id && item.payload?.conversation?.status === 'idle',
          ),
        '断线后重放完整完成快照',
      )
      assert.deepEqual(finalEvent.payload.conversation.turns[0].timeline, turn.timeline)
      assert.ok(
        reconnected.events.some(
          (item) =>
            item.conversationId === chat.id &&
            item.payload?.conversation?.turns[0]?.timeline.find(
              (part) => part.id === original[3].id,
            )?.messagePhase === 'final_answer',
        ),
      )
      return { timelineParts: turn.timeline.length, phaseInSnapshot: turn.timeline[3].messagePhase }
    } finally {
      await reconnected.close()
    }
  })

  await check('执行时间线保留文本、工具和接收输入的顺序，SSE 重放可还原完整文本片段', async () => {
    const chat = await liveChat('TIMELINE_ORDER')
    const stream = await client.stream()
    try {
      const initial = await until(async () => {
        const c = await client.conversation(chat.id)
        return c.turns[0].steps[0]?.status === 'completed' && c
      }, '工具完成并保留时间线位置')
      assert.deepEqual(
        initial.turns[0].timeline.map((entry) => entry.type),
        ['text', 'text', 'tool', 'text'],
      )
      const [intro, progress, tool, duringTool] = initial.turns[0].timeline
      assert.equal(intro.text, '开始检查。先看资料。')
      assert.equal(intro.itemId, 'intro')
      assert.equal(progress.itemId, duringTool.itemId)
      assert.notEqual(progress.id, duringTool.id)
      assert.equal(tool.stepId, 'read-config')
      assert.equal(initial.turns[0].phase, 'awaiting_model')
      assert.ok(initial.messages.find((message) => message.kind === 'prompt').clientRequestId)

      const steerId = requestId()
      const steerBody = {
        requestId: steerId,
        text: '优先测试环境',
        delivery: 'steer',
        expectedTurnId: chat.turnId,
        attachmentIds: [],
      }
      await client.api('POST', `/conversations/${chat.id}/messages`, steerBody)
      await client.api('POST', `/conversations/${chat.id}/messages`, steerBody)
      const steered = await client.conversation(chat.id)
      const steerMessage = steered.messages.find((message) => message.kind === 'steer')
      assert.equal(steerMessage.clientRequestId, steerId)
      assert.equal(chat.run.steers, 1)
      assert.equal(steered.turns[0].timeline.at(-2).messageId, steerMessage.id)
      assert.equal(steered.turns[0].timeline.at(-1).text, '已按补充指令继续。')
      assert.notEqual(steered.turns[0].timeline.at(-1).id, duringTool.id)

      event(chat.run, {
        type: 'question',
        id: 'timeline-question',
        prompt: '确认环境？',
        options: ['测试环境'],
      })
      const waiting = await until(async () => {
        const c = await client.conversation(chat.id)
        return c.turns[0].question?.status === 'pending' && c
      }, '时间线澄清问题')
      assert.equal(waiting.turns[0].phase, 'waiting_user')
      const answerId = requestId()
      await client.api('POST', `/conversations/${chat.id}/questions/timeline-question`, {
        requestId: answerId,
        answer: '测试环境',
        expectedTurnId: chat.turnId,
      })
      const done = await client.finish(chat.id)
      const turn = done.turns[0]
      const timeline = turn.timeline
      assert.deepEqual(
        timeline.map((entry) => entry.type),
        ['text', 'text', 'tool', 'text', 'user', 'text', 'question', 'user', 'text'],
      )
      assert.equal(timeline[6].question.status, 'answered')
      assert.equal(timeline[6].question.answer, '测试环境')
      assert.equal(
        timeline[7].messageId,
        done.messages.find((message) => message.clientRequestId === answerId).id,
      )
      assert.equal(timeline[8].text, '已按澄清答案继续。')
      assert.equal(turn.phase, 'completed')
      assert.ok(turn.lastActivityAt >= turn.startedAt)
      assert.equal(
        timeline
          .filter((entry) => entry.type === 'text')
          .map((entry) => entry.text)
          .join(''),
        textOf(done, chat.turnId),
      )
      await until(
        () =>
          stream.events.some(
            (item) =>
              item.conversationId === chat.id && item.payload?.conversation?.status === 'idle',
          ),
        '完成事件重放',
      )
      const deltas = stream.events.filter(
        (item) => item.conversationId === chat.id && item.type === 'message.delta',
      )
      const replay = new Map()
      for (const item of deltas) {
        assert.equal(item.payload.messageId, turn.assistantMessageId)
        assert.equal(item.payload.phase, 'responding')
        assert.ok(item.payload.lastActivityAt)
        let entry = item.payload.timelineEntry
        if (!entry) {
          const { delta, offset, mode, ...metadata } = item.payload.timelineDelta
          const previous = replay.get(metadata.id)?.text || ''
          if (mode === 'append') assert.equal(offset, previous.length)
          assert.equal(delta, item.payload.delta)
          entry = { ...metadata, text: mode === 'replace' ? delta : previous + delta }
        }
        assert.ok(entry.text.endsWith(item.payload.delta))
        replay.set(entry.id, entry)
      }
      assert.deepEqual(
        [...replay.values()],
        timeline.filter((entry) => entry.type === 'text'),
      )
      return {
        timelineTypes: timeline.map((entry) => entry.type),
        deltaEvents: deltas.length,
        steers: chat.run.steers,
      }
    } finally {
      await stream.close()
    }
  })

  await check('场景模式在引导与澄清后分段，队列保留原请求标识', async () => {
    const c = await client.create()
    const sent = await client.send(c.id, '检查项目，等待补充', {
      scenario: { kind: 'hold', stepDelayMs: 10 },
    })
    const turnId = sent.conversation.activeTurnId
    await until(
      async () =>
        (await client.conversation(c.id)).turns[0].timeline.some((entry) => entry.type === 'text'),
      '场景首段输出',
    )
    const queueId = requestId()
    await client.send(c.id, '下一轮检查', { delivery: 'queue', requestId: queueId })
    await client.send(c.id, 'release，优先测试环境', { delivery: 'steer', expectedTurnId: turnId })
    const finished = await until(async () => {
      const value = await client.conversation(c.id)
      return value.turns.length === 2 && !value.activeTurnId && value
    }, '场景引导和队列完成')
    const timeline = finished.turns[0].timeline
    const userIndex = timeline.findIndex((entry) => entry.type === 'user')
    assert.ok(userIndex > 0)
    assert.equal(timeline[userIndex - 1].type, 'text')
    assert.equal(timeline[userIndex + 1].type, 'text')
    assert.notEqual(timeline[userIndex - 1].id, timeline[userIndex + 1].id)
    assert.equal(
      finished.messages.find((message) => message.id === finished.turns[1].inputMessageId)
        .clientRequestId,
      queueId,
    )

    const clarify = await client.create()
    const pending = await client.send(clarify.id, '先问我再检查', {
      scenario: { kind: 'clarify', stepDelayMs: 10 },
    })
    const waiting = await until(async () => {
      const current = await client.conversation(clarify.id)
      return current.turns[0].question?.status === 'pending' && current
    }, '场景澄清问题')
    await client.api(
      'POST',
      `/conversations/${clarify.id}/questions/${waiting.turns[0].question.id}`,
      {
        requestId: requestId(),
        answer: '服务与资源健康',
        expectedTurnId: pending.conversation.activeTurnId,
      },
    )
    const answered = await client.finish(clarify.id)
    const parts = answered.turns[0].timeline
    const questionIndex = parts.findIndex((entry) => entry.type === 'question')
    assert.equal(parts[questionIndex].question.status, 'answered')
    assert.equal(parts[questionIndex + 1].type, 'user')
    assert.equal(parts[questionIndex + 2].type, 'tool')
  })

  await check('live 澄清并发与重复请求仅向 Bridge 投递一次', async () => {
    const chat = await liveChat('QUESTION_IDEMPOTENCY')
    await until(
      async () => (await client.conversation(chat.id)).turns[0].question?.status === 'pending',
      '澄清问题可见',
    )
    const body = { requestId: requestId(), answer: '测试环境', expectedTurnId: chat.turnId }
    const endpoint = `/conversations/${chat.id}/questions/question-test`
    const [first, second] = await Promise.all([
      client.api('POST', endpoint, body),
      client.api('POST', endpoint, body),
    ])
    await client.api('POST', endpoint, body)
    assert.equal(first.conversation.activeTurnId, second.conversation.activeTurnId)
    assert.equal(chat.run.answers, 1)
    assert.equal(
      (await client.conversation(chat.id)).messages.filter(
        (message) => message.role === 'user' && message.kind === 'answer',
      ).length,
      1,
    )
    complete(chat.run)
    await client.finish(chat.id)
    return { bridgeAnswerCalls: chat.run.answers }
  })

  await check('上游流意外结束保留正文，明确失败且允许继续', async () => {
    const chat = await liveChat('STREAM_DROPPED')
    const ended = await client.finish(chat.id)
    assert.equal(ended.status, 'failed')
    assert.equal(ended.turns[0].status, 'failed')
    assert.equal(ended.queuePaused, true)
    assert.equal(textOf(ended, chat.turnId), '连接中断前已生成的内容。')
    assert.ok(ended.turns[0].error)
    const continued = await client.api('POST', `/conversations/${chat.id}/continue`, {
      requestId: requestId(),
      turnId: chat.turnId,
    })
    assert.equal(continued.conversation.turns.length, 2)
    await client.finish(chat.id)
  })

  await check('停止失败保留运行态和错误，不虚报已停止', async () => {
    const chat = await liveChat('STOP_FAIL')
    const stopping = await client.stop(chat.id, chat.turnId)
    assert.equal(stopping.conversation.status, 'stopping')
    const restored = await until(async () => {
      const current = await client.conversation(chat.id)
      return current.turns[0].error?.includes('停止') && current
    }, '停止失败反馈')
    assert.equal(restored.activeTurnId, chat.turnId)
    assert.equal(restored.status, 'running')
    assert.equal(restored.turns[0].status, 'running')
    assert.equal(restored.queuePaused, true)
    event(chat.run, { type: 'delta', text: '停止未确认后继续接收的内容。' })
    await until(
      async () => textOf(await client.conversation(chat.id), chat.turnId).includes('继续接收'),
      '失败后保持真实状态',
    )
    complete(chat.run)
    await client.finish(chat.id)
  })

  await check('旧轮停止迟到失败不覆盖新轮状态', async () => {
    const chat = await liveChat('STOP_FINISH_RACE')
    await client.stop(chat.id, chat.turnId)
    await client.finish(chat.id)
    const next = await client.send(chat.id, 'NEW_HOLD', { scenario: undefined })
    const nextTurnId = next.conversation.activeTurnId
    assert.notEqual(nextTurnId, chat.turnId)
    await sleep(350)
    const current = await client.conversation(chat.id)
    assert.equal(current.activeTurnId, nextTurnId)
    assert.equal(current.status, 'running')
    assert.equal(current.turns.find((turn) => turn.id === nextTurnId).status, 'running')
    await client.stop(chat.id, nextTurnId)
    await client.finish(chat.id)
  })

  await check('停止接收回执不冒充终态，等待 interrupted 期间保持队列暂停', async () => {
    const chat = await liveChat('STOP_DELAYED_ACCEPT')
    await client.send(chat.id, '停止后保留的下一轮', { delivery: 'queue', scenario: undefined })
    const before = textOf(await client.conversation(chat.id), chat.turnId)
    const stopping = await client.stop(chat.id, chat.turnId)
    assert.equal(stopping.conversation.status, 'stopping')
    await sleep(150)
    const pending = await client.conversation(chat.id)
    assert.equal(pending.status, 'stopping')
    assert.equal(pending.activeTurnId, chat.turnId)
    assert.equal(pending.turns.length, 1)
    assert.equal(pending.queue.length, 1)
    assert.equal(pending.queuePaused, true)
    assert.equal(textOf(pending, chat.turnId), before)
    const ended = await client.finish(chat.id)
    assert.equal(ended.status, 'interrupted')
    assert.equal(ended.queue.length, 1)
    assert.equal(ended.turns.length, 1)
    assert.equal(ended.queuePaused, true)
    assert.equal(textOf(ended, chat.turnId), before)
    return { acceptedOnlyWaitMs: 500, queuedItems: 1 }
  })

  await check('执行结束与引导拒绝竞态不产生新轮或伪造已送达', async () => {
    const chat = await liveChat('STEER_FINISH_RACE')
    const rejected = await client.raw('POST', `/conversations/${chat.id}/messages`, {
      requestId: requestId(),
      text: '应保留给用户决定的引导',
      attachmentIds: [],
      delivery: 'steer',
      expectedTurnId: chat.turnId,
    })
    assert.ok(
      [409, 502, 503].includes(rejected.status),
      `运行器拒绝需明确业务状态，实际 ${rejected.status}`,
    )
    const current = await client.finish(chat.id)
    assert.equal(current.turns.length, 1)
    assert.equal(current.turns[0].guidance.length, 0)
    assert.equal(current.queue.length, 0)
    assert.equal(current.messages.filter((message) => message.kind === 'steer').length, 0)
  })

  await check('运行器离线拒绝发送、排队、继续，保留原有会话状态', async () => {
    const chat = await liveChat('OFFLINE_HOLD')
    await client.stop(chat.id, chat.turnId)
    await client.finish(chat.id)
    available = false
    await until(
      async () => !(await client.api('GET', '/bootstrap')).runtime.liveAvailable,
      '运行器健康检查进入离线',
      12000,
      100,
    )
    const beforeCalls = bridgeCalls.filter(
      (item) => item.path === '/runs' && item.method === 'POST',
    ).length
    for (const delivery of ['send', 'queue']) {
      const result = await client.raw('POST', `/conversations/${chat.id}/messages`, {
        requestId: requestId(),
        text: '离线不能提交',
        attachmentIds: [],
        delivery,
      })
      assert.equal(result.status, 503)
    }
    const continued = await client.raw('POST', `/conversations/${chat.id}/continue`, {
      requestId: requestId(),
      turnId: chat.turnId,
    })
    assert.equal(continued.status, 503)
    const current = await client.conversation(chat.id)
    assert.equal(current.turns.length, 1)
    assert.equal(current.queue.length, 0)
    assert.equal(
      bridgeCalls.filter((item) => item.path === '/runs' && item.method === 'POST').length,
      beforeCalls,
    )
  })
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
} finally {
  for (const run of runs.values()) run.res?.end()
  if (child?.exitCode === null) {
    const exit = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exit
  }
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => bridge.close(resolve))
  report.completedAt = new Date().toISOString()
  report.bridgeCalls = bridgeCalls
  const output = await writeEvidence('bridge-protocol.json', report)
  console.log(`受控 Bridge 协议证据：${output}`)
  await rm(dataDir, { recursive: true, force: true })
  if (report.checks.some((item) => item.status === 'failed')) process.exitCode = 1
  if (report.error) console.error(report.error)
}
