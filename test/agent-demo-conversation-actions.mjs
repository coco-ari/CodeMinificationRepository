import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client, requestId, sleep, until, writeEvidence } from './agent-demo-helpers.mjs'

// Independent real HTTP/SQLite/SSE coverage. The Bridge below is controlled;
// this test does not call a model or touch the deployed Demo.
const root = process.cwd()
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'autoops-actions-'))
const runs = new Map()
const sockets = new Set()
const report = { mode: 'controlled-bridge-and-scenario', realModelCalls: 0, checks: [] }
const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const event = (run, type, payload = {}) =>
  run.res.write(`data: ${JSON.stringify({ type, payload })}\n\n`)
const end = (run, status = 'completed') => {
  event(run, status)
  run.res.end()
}
const bridge = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}
  if (req.url === '/health') return reply(res, 200, { liveAvailable: true, name: 'actions-test' })
  if (req.url === '/runs') {
    runs.set(body.runId, { ...body })
    return reply(res, 200, { ok: true })
  }
  const match = req.url.match(/^\/runs\/([^/]+)\/(events|stop|steer|answer)$/)
  const run = match && runs.get(match[1])
  if (!run) return reply(res, 404, {})
  if (match[2] === 'events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    run.res = res
    event(run, 'started', {
      runnerThreadId: `thread-${run.runId}`,
      runnerTurnId: `turn-${run.runId}`,
    })
    return
  }
  if (match[2] === 'stop') {
    reply(res, 200, { accepted: true, status: 'stopping' })
    await sleep(20)
    event(run, 'reasoning', {
      itemId: 'thinking',
      text: '不应接收的停止后片段',
      mode: 'delta',
      kind: 'summary',
      status: 'running',
    })
    event(run, 'usage', { totalTokens: 23, inputTokens: 13, outputTokens: 10 })
    end(run, 'interrupted')
    return
  }
  return reply(res, 200, { accepted: true })
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
let child
let logs = ''
async function boot() {
  child = spawn(process.execPath, ['agent-demo/server.mjs'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      AGENT_BRIDGE_URL: bridgeUrl,
      AGENT_BRIDGE_TOKEN: '',
    },
  })
  child.stdout.on('data', (data) => {
    logs = (logs + data).slice(-4000)
  })
  child.stderr.on('data', (data) => {
    logs = (logs + data).slice(-4000)
  })
  await until(async () => {
    if (child.exitCode !== null) throw new Error(logs)
    try {
      return (await (await fetch(`${origin}/api/agent-demo/health`)).json()).liveAvailable
    } catch {
      return false
    }
  }, 'isolated server boot')
}
async function stop(signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return
  const stopped = new Promise((resolve) => child.once('exit', resolve))
  child.kill(signal)
  await stopped
  child = null
}
async function check(name, fn) {
  try {
    const detail = await fn()
    report.checks.push({ name, passed: true, detail })
    console.log(`通过：${name}`)
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.stack })
    console.error(`失败：${name}\n${error.stack}`)
  }
}
let lin, admin, chen
async function liveChat(text = '验证真实事件顺序') {
  const c = await lin.create({ mode: 'live' })
  const sent = await lin.send(c.id, text, { scenario: undefined })
  const run = await until(
    () => runs.get(sent.conversation.activeTurnId)?.res && runs.get(sent.conversation.activeTurnId),
    'bridge subscriber',
  )
  return { id: c.id, turnId: sent.conversation.activeTurnId, run }
}

try {
  await boot()
  ;[lin, admin, chen] = await Promise.all(
    ['lin', 'admin', 'chen'].map((name) => new Client(name, origin).login()),
  )

  await check('reasoning摘要替换、累计usage与紧凑增量持久化，缺口可由快照恢复', async () => {
    const chat = await liveChat()
    const stream = await lin.stream()
    try {
      event(chat.run, 'reasoning', {
        itemId: 'thinking',
        text: '原始推理',
        mode: 'delta',
        kind: 'text',
        status: 'running',
      })
      event(chat.run, 'reasoning', {
        itemId: 'thinking',
        text: '简短摘要',
        mode: 'replace',
        kind: 'summary',
        status: 'running',
      })
      event(chat.run, 'reasoning', {
        itemId: 'thinking',
        text: '，继续核对。',
        mode: 'delta',
        kind: 'summary',
        status: 'running',
      })
      for (let i = 0; i < 40; i++)
        event(chat.run, 'delta', { itemId: 'answer', text: '可见正文'.repeat(10) })
      event(chat.run, 'usage', {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        last: { totalTokens: 15 },
      })
      event(chat.run, 'usage', {
        inputTokens: 10,
        outputTokens: 8,
        totalTokens: 18,
        last: { totalTokens: 3 },
      })
      event(chat.run, 'reasoning', {
        itemId: 'thinking',
        text: '简短摘要，继续核对。',
        mode: 'replace',
        kind: 'summary',
        status: 'completed',
      })
      end(chat.run)
      const done = await lin.finish(chat.id)
      assert.equal(done.turns[0].timeline[0].text, '简短摘要，继续核对。')
      assert.equal(done.turns[0].timeline[0].kind, 'summary')
      assert.equal(done.turns[0].timeline[0].status, 'completed')
      assert.equal(done.turns[0].usage.totalTokens, 18)
      assert.equal(done.turns[0].usage.cachedInputTokens, null)
      assert.equal(
        done.messages.find((m) => m.role === 'assistant').content,
        '可见正文'.repeat(400),
      )
      await until(
        () =>
          stream.events.some(
            (e) => e.conversationId === chat.id && e.payload?.conversation?.status === 'idle',
          ),
        'SSE terminal',
      )
      const deltas = stream.events.filter(
        (e) =>
          e.conversationId === chat.id && ['message.delta', 'reasoning.delta'].includes(e.type),
      )
      const text = deltas.filter((e) => e.type === 'message.delta')
      assert.equal(text.length, 40)
      assert.ok(
        text.every((e) => !e.payload.timelineEntry && e.payload.timelineDelta.delta.length === 40),
      )
      assert.ok(
        Math.max(...text.map((e) => JSON.stringify(e.payload).length)) -
          Math.min(...text.map((e) => JSON.stringify(e.payload).length)) <
          20,
      )
      const parts = new Map()
      for (const e of deltas) {
        const d = e.payload.timelineDelta
        const old = parts.get(d.id) || ''
        if (d.mode === 'append') assert.equal(d.offset, old.length)
        parts.set(d.id, d.mode === 'replace' ? d.delta : old + d.delta)
      }
      assert.deepEqual(
        [...parts.values()],
        done.turns[0].timeline.map((entry) => entry.text),
      )
      const missed = text[1].payload.timelineDelta
      assert.notEqual(missed.offset, 0, 'missing first delta is detectable from offset')
      assert.equal(
        (await lin.conversation(chat.id)).turns[0].timeline[1].text,
        parts.get(missed.id),
      )
      return {
        textEvents: text.length,
        maxPayloadBytes: Math.max(...text.map((e) => Buffer.byteLength(JSON.stringify(e.payload)))),
      }
    } finally {
      await stream.close()
    }
  })

  await check('停止拒绝迟到reasoning、保留终结usage；崩溃重启保留推理与文本', async () => {
    const chat = await liveChat()
    event(chat.run, 'reasoning', {
      itemId: 'thinking',
      text: '已显示的摘要',
      mode: 'delta',
      kind: 'summary',
      status: 'running',
    })
    await until(
      async () => (await lin.conversation(chat.id)).turns[0].timeline.length,
      'saved reasoning',
    )
    await lin.stop(chat.id, chat.turnId)
    const stopped = await lin.finish(chat.id)
    assert.equal(stopped.turns[0].timeline[0].text, '已显示的摘要')
    assert.equal(stopped.turns[0].timeline[0].status, 'interrupted')
    assert.equal(stopped.turns[0].usage.totalTokens, 23)
    const held = await liveChat()
    event(held.run, 'reasoning', {
      itemId: 'thinking',
      text: '重启前摘要',
      mode: 'delta',
      kind: 'summary',
      status: 'running',
    })
    event(held.run, 'delta', { itemId: 'answer', text: '重启前正文' })
    event(held.run, 'usage', { totalTokens: 27 })
    await until(
      async () => (await lin.conversation(held.id)).turns[0].usage?.totalTokens === 27,
      'persisted usage',
    )
    await stop('SIGKILL')
    await boot()
    const restored = await lin.conversation(held.id)
    assert.equal(restored.status, 'interrupted')
    assert.deepEqual(
      restored.turns[0].timeline.map((e) => e.text),
      ['重启前摘要', '重启前正文'],
    )
    assert.equal(restored.turns[0].timeline[0].status, 'interrupted')
    assert.equal(restored.turns[0].usage.totalTokens, 27)
  })

  await check('分支复制ACL/附件/报告并独立存活，重复请求不重复创建，原历史不变', async () => {
    const source = await lin.create({ visibility: 'project' })
    const file = await lin.upload(source.id, '分支资料.txt', '附件必须在原会话删除后仍存在')
    await lin.send(source.id, '整理项目报告', { attachmentIds: [file.id] })
    const done = await lin.finish(source.id)
    const original = JSON.stringify(done)
    const request = {
      requestId: requestId(),
      messageId: done.turns[0].assistantMessageId,
      expectedRevision: done.revision,
    }
    const [a, b] = await Promise.all([
      admin.api('POST', `/conversations/${source.id}/branch`, request),
      admin.api('POST', `/conversations/${source.id}/branch`, request),
    ])
    assert.equal(a.conversation.id, b.conversation.id)
    assert.equal(a.conversation.ownerId, admin.user.id)
    assert.equal(a.conversation.visibility, 'private')
    assert.equal(a.receipt.status, 'branched')
    assert.equal(a.conversation.activeTurnId, null)
    assert.equal(a.conversation.queuePaused, true)
    assert.deepEqual(a.conversation.queue, [])
    assert.deepEqual((await admin.api('GET', `/conversations/${a.conversation.id}/draft`)).draft, {
      text: '',
      attachmentIds: [],
      revision: 0,
      attachments: [],
    })
    assert.equal(
      (
        await admin.raw('POST', `/conversations/${source.id}/branch`, {
          ...request,
          messageId: done.turns[0].inputMessageId,
        })
      ).status,
      409,
      '同一幂等键不能改成另一个分支起点',
    )
    assert.equal(JSON.stringify(await lin.conversation(source.id)), original)
    const copied = a.conversation.messages.find((m) => m.role === 'user').attachments[0]
    assert.notEqual(copied.id, file.id)
    assert.equal((await lin.raw('GET', `/conversations/${a.conversation.id}`)).status, 404)
    assert.equal(
      (await chen.raw('POST', `/conversations/${source.id}/branch`, request)).status,
      404,
    )
    assert.equal(
      (
        await admin.raw('POST', `/conversations/${source.id}/branch`, {
          ...request,
          text: '不能编辑助手',
          requestId: requestId(),
        })
      ).status,
      400,
    )
    await lin.api('DELETE', `/conversations/${source.id}`)
    assert.equal(
      (await admin.raw('GET', `/files/${copied.id}`)).body,
      '附件必须在原会话删除后仍存在',
    )
    const reportFile = a.conversation.artifacts[0]
    assert.notEqual(reportFile.id, done.artifacts[0].id)
    assert.equal((await admin.raw('GET', `/files/${reportFile.id}`)).status, 200)
  })

  await check('用户消息分支恢复草稿，编辑重发保留原历史且快速重复点击只创建一次', async () => {
    const source = await lin.create()
    const file = await lin.upload(source.id, '重发资料.txt', '保留编辑后的附件')
    await lin.send(source.id, '原始问题', { attachmentIds: [file.id] })
    const done = await lin.finish(source.id)
    const before = JSON.stringify(done)
    const branch = await lin.api('POST', `/conversations/${source.id}/branch`, {
      requestId: requestId(),
      messageId: done.turns[0].inputMessageId,
    })
    assert.equal(branch.conversation.messages.length, 0)
    assert.equal(branch.conversation.activeTurnId, null)
    const draft = (await lin.api('GET', `/conversations/${branch.conversation.id}/draft`)).draft
    assert.equal(draft.text, '原始问题')
    assert.equal(draft.attachments.length, 1)
    assert.notEqual(draft.attachments[0].id, file.id)
    const edit = {
      requestId: requestId(),
      messageId: done.turns[0].inputMessageId,
      text: '修改后的问题',
      expectedRevision: done.revision,
    }
    const [a, b] = await Promise.all([
      lin.api('POST', `/conversations/${source.id}/branch`, edit),
      lin.api('POST', `/conversations/${source.id}/branch`, edit),
    ])
    assert.equal(a.conversation.id, b.conversation.id)
    const edited = await lin.finish(a.conversation.id)
    assert.equal(edited.turns.length, 1)
    assert.equal(edited.messages[0].content, '修改后的问题')
    assert.equal(edited.messages[0].attachments.length, 1)
    assert.equal(JSON.stringify(await lin.conversation(source.id)), before)
    assert.equal((await admin.raw('POST', `/conversations/${source.id}/branch`, edit)).status, 404)
  })

  await check('从中途引导与澄清答案之前分支，不复制边界之后正文或答案', async () => {
    const source = await lin.create()
    const held = await lin.send(source.id, '保持原始问题', {
      scenario: { kind: 'hold', stepDelayMs: 10 },
    })
    await until(
      async () =>
        (await lin.conversation(source.id)).turns[0].timeline.some((e) => e.type === 'text'),
      'held output',
    )
    await lin.send(source.id, 'release 继续', {
      delivery: 'steer',
      expectedTurnId: held.conversation.activeTurnId,
    })
    const done = await lin.finish(source.id)
    const steer = done.messages.find((m) => m.kind === 'steer')
    const branch = (
      await lin.api('POST', `/conversations/${source.id}/branch`, {
        requestId: requestId(),
        messageId: steer.id,
      })
    ).conversation
    assert.ok(
      branch.messages.find((m) => m.role === 'assistant').content.length <
        done.messages.find((m) => m.role === 'assistant').content.length,
    )
    assert.ok(!branch.messages.some((m) => m.id === steer.id))
    assert.equal(
      (await lin.api('GET', `/conversations/${branch.id}/draft`)).draft.text,
      steer.content,
    )
    const clarify = await lin.create()
    await lin.send(clarify.id, '先问我', { scenario: { kind: 'clarify', stepDelayMs: 10 } })
    const waiting = await until(async () => {
      const c = await lin.conversation(clarify.id)
      return c.status === 'waiting' && c
    }, 'pending question')
    await lin.api(
      'POST',
      `/conversations/${clarify.id}/questions/${waiting.turns[0].question.id}`,
      { requestId: requestId(), answer: '选择健康', expectedTurnId: waiting.activeTurnId },
    )
    const answered = await lin.finish(clarify.id)
    const answer = answered.messages.find((m) => m.kind === 'answer' && m.role === 'user')
    const fork = (
      await lin.api('POST', `/conversations/${clarify.id}/branch`, {
        requestId: requestId(),
        messageId: answer.id,
      })
    ).conversation
    assert.equal(fork.turns[0].question.status, 'cancelled')
    assert.equal(fork.turns[0].question.answer, undefined)
    assert.equal((await lin.api('GET', `/conversations/${fork.id}/draft`)).draft.text, '选择健康')
  })

  await check('引导边界按当时快照分支，跨边界工具结果和思考不得从未来回填', async () => {
    const chat = await liveChat('在工具执行途中引导')
    event(chat.run, 'reasoning', {
      itemId: 'cross-boundary-thinking',
      text: '引导前摘要',
      kind: 'summary',
      status: 'running',
    })
    event(chat.run, 'delta', { itemId: 'before', text: '引导前说明', messagePhase: 'commentary' })
    event(chat.run, 'tool', {
      id: 'cross-boundary-tool',
      name: 'query_environment',
      status: 'running',
      input: { environmentId: 'env-test' },
    })
    await until(
      async () => (await lin.conversation(chat.id)).turns[0].steps[0]?.status === 'running',
      '工具启动已持久化',
    )
    const steered = await lin.send(chat.id, '改看另一组数据', {
      delivery: 'steer',
      expectedTurnId: chat.turnId,
      scenario: undefined,
    })
    const target = steered.conversation.messages.find((message) => message.kind === 'steer')
    event(chat.run, 'tool', {
      id: 'cross-boundary-tool',
      name: 'query_environment',
      status: 'completed',
      output: '引导后才产生的工具结果',
    })
    event(chat.run, 'reasoning', {
      itemId: 'cross-boundary-thinking',
      text: '，引导后的新摘要',
      kind: 'summary',
      status: 'completed',
    })
    event(chat.run, 'delta', {
      itemId: 'after',
      text: '引导后的最终答复',
      messagePhase: 'final_answer',
    })
    event(chat.run, 'artifact', {
      name: '引导后报告.md',
      content: '引导后报告数据',
      mime: 'text/markdown',
    })
    end(chat.run)
    const source = await lin.finish(chat.id)
    const sourceBefore = JSON.stringify(source)
    await stop()
    await boot()
    const runsBefore = runs.size
    const body = { requestId: requestId(), messageId: target.id, expectedRevision: source.revision }
    const [first, replay] = await Promise.all([
      lin.api('POST', `/conversations/${chat.id}/branch`, body),
      lin.api('POST', `/conversations/${chat.id}/branch`, body),
    ])
    const fork = first.conversation
    const boundary = {
      reasoning: fork.turns[0].timeline.find((part) => part.type === 'reasoning')?.text,
      lateToolOutput: fork.turns[0].steps.some((step) =>
        JSON.stringify(step.output || '').includes('引导后'),
      ),
      lateText: fork.messages.some((message) => message.content.includes('引导后')),
      lateArtifact: fork.artifacts.some((file) => file.name.includes('引导后')),
    }
    report.branchBoundaryEvidence = boundary
    assert.deepEqual(boundary, {
      reasoning: '引导前摘要',
      lateToolOutput: false,
      lateText: false,
      lateArtifact: false,
    })
    assert.equal(first.conversation.id, replay.conversation.id)
    assert.equal(fork.activeTurnId, null)
    assert.equal(fork.turns[0].status, 'interrupted')
    assert.equal(fork.turns[0].steps[0].status, 'cancelled')
    assert.equal(
      fork.turns[0].timeline.find((part) => part.type === 'reasoning').status,
      'interrupted',
    )
    assert.equal(fork.queuePaused, true)
    assert.equal(
      (await lin.api('GET', `/conversations/${fork.id}/draft`)).draft.text,
      target.content,
    )
    assert.equal(runs.size, runsBefore, '创建分支不启动模型')
    assert.equal(JSON.stringify(await lin.conversation(chat.id)), sourceBefore)

    const imported = (
      await lin.api('POST', `/conversations/${chat.id}/branch`, {
        requestId: requestId(),
        messageId: source.turns[0].assistantMessageId,
      })
    ).conversation
    const unavailable = await lin.raw('POST', `/conversations/${imported.id}/branch`, {
      requestId: requestId(),
      messageId: target.id,
    })
    assert.equal(
      unavailable.status,
      409,
      '没有运行时边界快照时显式拒绝，不能把导入的最终历史当精确截断',
    )
    assert.equal(unavailable.json.code, 'BRANCH_BOUNDARY_UNAVAILABLE')
    assert.deepEqual(await lin.conversation(imported.id), imported, '拒绝后导入会话保持不变')
    return {
      ...boundary,
      restoredAfterRestart: true,
      sourceUnchanged: true,
      extraModelRuns: runs.size - runsBefore,
    }
  })

  await check('澄清答案分支保留回答前工具/思考，将问题封存并只恢复答案草稿', async () => {
    const chat = await liveChat('需要用户确认后再继续')
    event(chat.run, 'reasoning', {
      itemId: 'question-thinking',
      text: '等待确认前摘要',
      kind: 'summary',
      status: 'running',
    })
    event(chat.run, 'tool', {
      id: 'ask-tool',
      name: 'ask_user',
      input: { prompt: '确认哪一项？' },
      status: 'running',
    })
    event(chat.run, 'question', {
      id: 'branch-question',
      prompt: '确认哪一项？',
      options: ['测试环境'],
    })
    await until(async () => (await lin.conversation(chat.id)).status === 'waiting', '等待澄清')
    const answered = await lin.api('POST', `/conversations/${chat.id}/questions/branch-question`, {
      requestId: requestId(),
      answer: '用户确认的答案',
      expectedTurnId: chat.turnId,
    })
    const target = answered.conversation.messages.find(
      (message) => message.kind === 'answer' && message.role === 'user',
    )
    event(chat.run, 'tool', {
      id: 'ask-tool',
      name: 'ask_user',
      status: 'completed',
      output: { answer: '用户确认的答案' },
    })
    event(chat.run, 'reasoning', {
      itemId: 'question-thinking',
      text: '，回答后的决策',
      kind: 'summary',
      status: 'completed',
    })
    event(chat.run, 'delta', {
      itemId: 'answer-result',
      text: '回答后的最终结果',
      messagePhase: 'final_answer',
    })
    end(chat.run)
    const source = await lin.finish(chat.id)
    const runsBefore = runs.size
    const fork = (
      await lin.api('POST', `/conversations/${chat.id}/branch`, {
        requestId: requestId(),
        messageId: target.id,
      })
    ).conversation
    const turn = fork.turns[0]
    assert.equal(turn.question.status, 'cancelled')
    assert.equal(turn.question.answer, undefined)
    assert.equal(turn.question.answeredAt, undefined)
    assert.equal(turn.steps[0].status, 'cancelled')
    assert.equal(turn.steps[0].output, undefined)
    assert.equal(turn.timeline.find((part) => part.type === 'reasoning').text, '等待确认前摘要')
    assert.equal(turn.timeline.find((part) => part.type === 'question').question.answer, undefined)
    assert.ok(
      !fork.messages.some(
        (message) => message.id === target.id || message.content.includes('回答后'),
      ),
    )
    assert.equal(fork.activeTurnId, null)
    assert.equal(
      (await lin.api('GET', `/conversations/${fork.id}/draft`)).draft.text,
      '用户确认的答案',
    )
    assert.deepEqual(await lin.conversation(chat.id), source)
    assert.equal(runs.size, runsBefore)
    return { sealedQuestion: true, extraModelRuns: 0, sourceUnchanged: true }
  })

  await check('普通用户与助手起点按整轮边界分支，后续轮次和暂停队列不继承', async () => {
    const chat = await liveChat('第一轮输入')
    event(chat.run, 'delta', { itemId: 'first', text: '第一轮回答', messagePhase: 'final_answer' })
    end(chat.run)
    const first = await lin.finish(chat.id)
    const sent = await lin.send(chat.id, '第二轮输入', { scenario: undefined })
    const second = await until(
      () => runs.get(sent.receipt.turnId)?.res && runs.get(sent.receipt.turnId),
      '第二轮 Bridge',
    )
    event(second, 'delta', { itemId: 'second', text: '第二轮回答', messagePhase: 'final_answer' })
    end(second)
    await lin.finish(chat.id)
    await lin.api('POST', `/conversations/${chat.id}/queue/pause`, { requestId: requestId() })
    await lin.send(chat.id, '原会话的暂停队列', { delivery: 'queue', scenario: undefined })
    const source = await lin.conversation(chat.id)
    const before = JSON.stringify(source)
    const runsBefore = runs.size
    const fromAssistant = (
      await lin.api('POST', `/conversations/${chat.id}/branch`, {
        requestId: requestId(),
        messageId: first.turns[0].assistantMessageId,
      })
    ).conversation
    const fromUser = (
      await lin.api('POST', `/conversations/${chat.id}/branch`, {
        requestId: requestId(),
        messageId: source.turns[1].inputMessageId,
      })
    ).conversation
    for (const fork of [fromAssistant, fromUser]) {
      assert.deepEqual(
        fork.turns.map((turn) => turn.id),
        [first.turns[0].id],
      )
      assert.deepEqual(
        fork.messages.map((message) => message.content),
        ['第一轮输入', '第一轮回答'],
      )
      assert.deepEqual(fork.queue, [])
      assert.equal(fork.activeTurnId, null)
      assert.equal(fork.queuePaused, true)
    }
    assert.equal((await lin.api('GET', `/conversations/${fromAssistant.id}/draft`)).draft.text, '')
    assert.equal(
      (await lin.api('GET', `/conversations/${fromUser.id}/draft`)).draft.text,
      '第二轮输入',
    )
    assert.equal(JSON.stringify(await lin.conversation(chat.id)), before)
    assert.equal(runs.size, runsBefore)
    return { extraModelRuns: runs.size - runsBefore, sourceQueueItems: source.queue.length }
  })

  await check('重试只绑定最新终态轮次，保留旧回复，模型上下文不包含被重试回复', async () => {
    const chat = await liveChat('原始请求')
    event(chat.run, 'delta', { itemId: 'answer', text: '保留但不能回灌的原回复' })
    end(chat.run)
    const done = await lin.finish(chat.id)
    const body = { requestId: requestId(), turnId: chat.turnId, expectedRevision: done.revision }
    const [a, b] = await Promise.all([
      lin.api('POST', `/conversations/${chat.id}/retry`, body),
      lin.api('POST', `/conversations/${chat.id}/retry`, body),
    ])
    assert.equal(a.receipt.turnId, b.receipt.turnId)
    const retry = await until(
      () => runs.get(a.receipt.turnId)?.res && runs.get(a.receipt.turnId),
      'retry bridge run',
    )
    assert.equal(retry.prompt, '原始请求')
    assert.deepEqual(retry.history, [])
    assert.equal(a.conversation.turns[1].retryOfTurnId, chat.turnId)
    assert.equal(a.conversation.messages[1].content, '保留但不能回灌的原回复')
    assert.equal(
      (
        await lin.raw('POST', `/conversations/${chat.id}/retry`, {
          ...body,
          requestId: requestId(),
        })
      ).status,
      409,
    )
    assert.equal(
      (
        await lin.raw('POST', `/conversations/${chat.id}/branch`, {
          messageId: done.messages[0].id,
          requestId: requestId(),
        })
      ).status,
      409,
    )
    event(retry, 'delta', { itemId: 'new', text: '重试回复' })
    end(retry)
    await lin.finish(chat.id)
    assert.equal(
      (
        await lin.raw('POST', `/conversations/${chat.id}/retry`, {
          turnId: chat.turnId,
          requestId: requestId(),
        })
      ).status,
      409,
    )
    assert.equal(
      (
        await lin.raw('POST', `/conversations/${chat.id}/retry`, {
          turnId: a.receipt.turnId,
          expectedRevision: done.revision,
          requestId: requestId(),
        })
      ).status,
      409,
    )
  })

  await check('队列立即执行只在空闲可用、原子领取、不越过停止与澄清边界', async () => {
    const c = await lin.create()
    await lin.api('POST', `/conversations/${c.id}/queue/pause`, { requestId: requestId() })
    await lin.send(c.id, '保留队列第一项', { delivery: 'queue' })
    await lin.send(c.id, '立即执行第二项', {
      delivery: 'queue',
      scenario: { kind: 'hold', stepDelayMs: 10 },
    })
    const queued = await lin.conversation(c.id)
    const target = queued.queue[1]
    const body = { requestId: requestId(), expectedRevision: queued.revision }
    const route = `/conversations/${c.id}/queue/${target.id}/send-now`
    const [a, b] = await Promise.all([lin.api('POST', route, body), lin.api('POST', route, body)])
    assert.equal(a.receipt.turnId, b.receipt.turnId)
    assert.equal(a.conversation.messages[0].content, target.text)
    assert.equal(a.conversation.queue.length, 1)
    assert.equal(a.conversation.queuePaused, true)
    assert.equal(
      (
        await lin.raw('POST', `/conversations/${c.id}/queue/${queued.queue[0].id}/send-now`, {
          requestId: requestId(),
        })
      ).status,
      409,
    )
    await lin.stop(c.id, a.receipt.turnId)
    assert.equal((await lin.raw('POST', route, { requestId: requestId() })).status, 409)
    const waiting = await lin.send(c.id, '先问我', {
      scenario: { kind: 'clarify', stepDelayMs: 10 },
    })
    await until(
      async () => (await lin.conversation(c.id)).status === 'waiting',
      'queue waiting question',
    )
    assert.equal(
      (
        await lin.raw('POST', `/conversations/${c.id}/queue/${queued.queue[0].id}/send-now`, {
          requestId: requestId(),
        })
      ).status,
      409,
    )
    await lin.stop(c.id, waiting.conversation.activeTurnId)
  })

  await check('图片附件以纯base64传到Bridge，重试与编辑分支保留图片且ACL不放宽', async () => {
    const c = await lin.create({ mode: 'live' })
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6xkAAAAASUVORK5CYII=',
      'base64',
    )
    const file = (
      await lin.api('POST', `/conversations/${c.id}/attachments`, {
        name: '测试像素.png',
        mime: 'image/png',
        data: bytes.toString('base64'),
      })
    ).attachment
    assert.equal((await admin.raw('GET', `/files/${file.id}`)).status, 404)
    const sent = await lin.send(c.id, '读取附件图片', {
      scenario: undefined,
      attachmentIds: [file.id],
    })
    const run = await until(
      () => runs.get(sent.receipt.turnId)?.res && runs.get(sent.receipt.turnId),
      'image bridge payload',
    )
    const validateImage = (payload) => {
      assert.equal(payload.attachments.length, 1)
      const image = payload.attachments[0]
      assert.equal(image.mime, 'image/png')
      assert.equal(image.content, undefined)
      assert.ok(
        typeof image.data === 'string' && !image.data.startsWith('data:'),
        'Bridge requires plain base64',
      )
      assert.ok(Buffer.from(image.data, 'base64').equals(bytes), 'image bytes must be unchanged')
    }
    validateImage(run)
    event(run, 'delta', { itemId: 'image-answer', text: '受控图片回执' })
    end(run)
    const first = await lin.finish(c.id)
    const retry = await lin.api('POST', `/conversations/${c.id}/retry`, {
      turnId: first.turns[0].id,
      requestId: requestId(),
    })
    const rerun = await until(
      () => runs.get(retry.receipt.turnId)?.res && runs.get(retry.receipt.turnId),
      'image retry payload',
    )
    validateImage(rerun)
    end(rerun)
    await lin.finish(c.id)
    const fork = await lin.api('POST', `/conversations/${c.id}/branch`, {
      messageId: first.turns[0].inputMessageId,
      text: '',
      requestId: requestId(),
    })
    const forkRun = await until(
      () =>
        runs.get(fork.conversation.activeTurnId)?.res && runs.get(fork.conversation.activeTurnId),
      'image branch payload',
    )
    validateImage(forkRun)
    assert.equal(
      forkRun.prompt,
      '请分析所附文件。',
      'attachment-only edit follows the ordinary send contract',
    )
    assert.notEqual(forkRun.attachments[0].id, file.id)
    end(forkRun)
    await lin.finish(fork.conversation.id)
    return { imageBytes: bytes.length, checkedRuns: 3 }
  })
} catch (error) {
  report.error = error.stack
} finally {
  await stop()
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => bridge.close(resolve))
  await rm(dataDir, { recursive: true, force: true })
  report.passed = !report.error && report.checks.every((check) => check.passed)
  report.completedAt = new Date().toISOString()
  const destination = await writeEvidence('conversation-actions.json', report)
  console.log(JSON.stringify({ passed: report.passed, report: destination }))
  if (!report.passed) process.exitCode = 1
}
