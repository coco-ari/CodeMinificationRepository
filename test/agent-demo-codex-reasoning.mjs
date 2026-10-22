import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createCodexBridge } from '../agent-demo/codex-bridge.mjs'

// Controlled official-protocol notifications. No CLI, credentials, or model.
// Schema: codex-cli 0.159.2 app-server generate-ts (2026-10-21), v2
// Reasoning{SummaryTextDelta,SummaryPartAdded,TextDelta}Notification,
// ThreadItem, ThreadTokenUsageUpdatedNotification, TokenUsageBreakdown.
const output = path.resolve('.test-artifacts/agent-demo-api/codex-reasoning.json')
const token = 'synthetic-reasoning-protocol-token-123456789'
const checks = []
const calls = []
let emit
let sequence = 0
let base
let evidence
const bridge = await createCodexBridge({
  enabled: true,
  token,
  model: 'synthetic-protocol-only',
  codexHome: '/private/tmp/protocol-only',
  runnerFactory(onMessage) {
    emit = onMessage
    return {
      async request(method, params) {
        calls.push({ method, params })
        if (method === 'account/read')
          return { account: { type: 'apiKey' }, requiresOpenaiAuth: true }
        if (method === 'thread/start')
          return {
            thread: { id: `thread_${++sequence}` },
            activePermissionProfile: { id: 'agent_demo' },
            approvalPolicy: 'never',
            sandbox: { type: 'readOnly', networkAccess: false },
          }
        if (method === 'turn/start')
          return { turn: { id: params.threadId.replace('thread_', 'turn_') } }
        return {}
      },
      notify() {},
      reply() {},
      replyError() {},
      close() {},
    }
  },
})
const request = async (route, body) => {
  const response = await fetch(base + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  assert.ok(response.ok, `${route}: ${response.status}`)
  return response
}
const start = async (name) => {
  await request('/runs', {
    runId: name,
    prompt: '合成协议校验',
    context: { projectId: 'p1', environmentId: 'e1', documents: [], resources: [] },
    history: [],
    attachments: [],
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const threadId = `thread_${sequence}`,
    turnId = `turn_${sequence}`
  return {
    name,
    threadId,
    turnId,
    send: (method, params = {}) => emit({ method, params: { threadId, turnId, ...params } }),
    complete: (status = 'completed', items = []) =>
      emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, items } } }),
    events: async (after = 0) =>
      (await (await request(`/runs/${name}/events?after=${after}`)).text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6))),
  }
}
const applyReasoning = (events) => {
  const parts = new Map()
  for (const { type, payload } of events) {
    if (type !== 'reasoning') continue
    const old = parts.get(payload.id)
    parts.set(payload.id, {
      ...payload,
      text: payload.mode === 'delta' ? (old?.text || '') + payload.text : payload.text,
    })
  }
  return [...parts.values()]
}
try {
  const address = await bridge.listen(0)
  base = `http://127.0.0.1:${address.port}`
  const health = await (await request('/health')).json()
  assert.equal(health.liveAvailable, true)
  assert.deepEqual(health.capabilities.reasoning, {
    summary: true,
    text: true,
    availability: 'provider-dependent',
  })
  assert.equal(health.capabilities.usage, true)
  checks.push('capabilities declares parser support and provider-dependent availability')

  const a = await start('summary')
  await a.send('item/started', { item: { type: 'reasoning', id: 'r1', summary: [], content: [] } })
  await a.send('item/reasoning/summaryPartAdded', { itemId: 'r1', summaryIndex: 0 })
  await a.send('item/reasoning/summaryTextDelta', {
    itemId: 'r1',
    summaryIndex: 0,
    delta: '先核对',
  })
  await a.send('item/reasoning/summaryTextDelta', { itemId: 'r1', summaryIndex: 0, delta: '资料' })
  await a.send('item/reasoning/summaryPartAdded', { itemId: 'r1', summaryIndex: 1 })
  await a.send('item/reasoning/summaryTextDelta', {
    itemId: 'r1',
    summaryIndex: 1,
    delta: '再总结',
  })
  await a.send('item/reasoning/textDelta', {
    itemId: 'r1',
    contentIndex: 0,
    delta: '不重复展示的已提供文本',
  })
  const item = {
    type: 'reasoning',
    id: 'r1',
    summary: ['先核对资料。', '再总结。'],
    content: ['不重复展示的已提供文本'],
  }
  await a.send('item/completed', { item })
  await a.send('item/completed', { item })
  await a.send('item/reasoning/summaryTextDelta', {
    itemId: 'r1',
    summaryIndex: 0,
    delta: '完成后迟到',
  })
  await a.send('item/agentMessage/delta', { itemId: 'answer1', delta: '最终回答' })
  const usage = {
    total: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 5,
    },
    last: {
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 2,
    },
    modelContextWindow: 128000,
  }
  await a.send('thread/tokenUsage/updated', { tokenUsage: usage })
  await a.send('thread/tokenUsage/updated', { tokenUsage: usage })
  await a.send('thread/tokenUsage/updated', {
    turnId: 'unrelated',
    tokenUsage: { total: { totalTokens: 999 } },
  })
  await a.complete('completed', [item])
  const events = await a.events()
  const parts = applyReasoning(events)
  assert.equal(parts.length, 1)
  assert.equal(parts[0].text, '先核对资料。\n\n再总结。')
  assert.equal(parts[0].kind, 'summary')
  assert.equal(parts[0].status, 'completed')
  assert.equal(
    events.filter((e) => e.type === 'reasoning' && e.payload.status === 'completed').length,
    1,
  )
  assert.equal(
    events
      .filter((e) => e.type === 'delta')
      .map((e) => e.payload.text)
      .join(''),
    '最终回答',
  )
  assert.ok(!JSON.stringify(events).includes('完成后迟到'))
  assert.ok(!JSON.stringify(events).includes('不重复展示'))
  const usageEvents = events.filter((e) => e.type === 'usage')
  assert.equal(usageEvents.length, 1)
  assert.deepEqual(usageEvents[0].payload, {
    ...usage.total,
    scope: 'turn',
    threadTotal: usage.total,
    last: usage.last,
    modelContextWindow: 128000,
  })
  assert.ok(events.every((event, index) => event.seq === index + 1))
  assert.deepEqual(
    await a.events(2),
    events.filter((event) => event.seq > 2),
  )
  checks.push(
    'indexed summary deltas, complete snapshot correction, duplicate settlement and cursor replay',
  )
  checks.push('reasoning stays separate from answer and summary wins over simultaneous text')
  checks.push(
    'usage keeps the native thread total and a validated per-turn snapshot, with duplicate and unrelated-turn suppression',
  )

  const b = await start('fallback')
  await b.send('item/reasoning/textDelta', {
    itemId: 'r2',
    contentIndex: 0,
    delta: '提供方已提供文本',
  })
  await b.send('item/reasoning/summaryTextDelta', {
    itemId: 'r2',
    summaryIndex: 0,
    delta: '公开摘要',
  })
  await b.complete()
  const switched = (await b.events()).filter((e) => e.type === 'reasoning')
  assert.equal(switched[0].payload.kind, 'text')
  assert.equal(switched[1].payload.kind, 'summary')
  assert.equal(switched[1].payload.mode, 'replace')
  assert.equal(switched[0].payload.id, switched[1].payload.id)
  assert.equal(applyReasoning(await b.events())[0].text, '公开摘要')
  checks.push('text-only fallback switches to summary by replacement, never a duplicated block')

  const c = await start('terminal_backfill')
  await c.complete('completed', [
    { type: 'reasoning', id: 'r3', summary: ['仅终态返回的摘要'], content: [] },
  ])
  assert.equal(applyReasoning(await c.events())[0].text, '仅终态返回的摘要')
  checks.push(
    'turn terminal items backfill reasoning when delta/item-completed notifications were absent',
  )

  const d = await start('failure')
  await d.send('item/reasoning/summaryTextDelta', {
    itemId: 'r4',
    summaryIndex: 0,
    delta: '已经完成的检查',
  })
  await d.send('error', { turnId: 'unrelated', willRetry: false, error: { message: 'wrong turn' } })
  await d.send('error', { willRetry: true, error: { message: 'retry privately' } })
  await d.send('item/reasoning/summaryTextDelta', {
    itemId: 'r4',
    summaryIndex: 0,
    delta: '仍保留',
  })
  await d.send('error', { willRetry: false, error: { message: 'private provider diagnostic' } })
  const failed = await d.events()
  assert.equal(failed.at(-1).type, 'failed')
  assert.equal(applyReasoning(failed)[0].text, '已经完成的检查仍保留')
  assert.equal(applyReasoning(failed)[0].status, 'completed')
  assert.ok(!JSON.stringify(failed).includes('private provider diagnostic'))
  checks.push(
    'wrong-turn/retry errors do not end the run; real failure seals retained reasoning without raw diagnostics',
  )

  const e = await start('stopping')
  await e.send('item/reasoning/summaryTextDelta', {
    itemId: 'r5',
    summaryIndex: 0,
    delta: '停止前内容',
  })
  await request(`/runs/${e.name}/stop`, {
    requestId: 'stop-reasoning',
    expectedRunnerTurnId: e.turnId,
  })
  await e.send('item/reasoning/summaryTextDelta', {
    itemId: 'r5',
    summaryIndex: 0,
    delta: '停止后不追加',
  })
  await e.send('item/completed', {
    item: { type: 'reasoning', id: 'r5', summary: ['停止后不替换'], content: [] },
  })
  await e.complete('completed', [
    { type: 'reasoning', id: 'r5', summary: ['终态不添加'], content: [] },
  ])
  const stopped = await e.events()
  assert.equal(stopped.at(-1).type, 'interrupted')
  assert.equal(applyReasoning(stopped)[0].text, '停止前内容')
  assert.equal(applyReasoning(stopped)[0].status, 'completed')
  assert.ok(!JSON.stringify(stopped).includes('停止后'))
  checks.push(
    'stop seals only visible reasoning; late deltas and complete snapshots cannot add content',
  )

  const f = await start('indices')
  await f.send('item/reasoning/summaryTextDelta', {
    itemId: 'r6',
    summaryIndex: -1,
    delta: 'invalid',
  })
  await f.send('item/reasoning/summaryTextDelta', {
    itemId: 'r6',
    summaryIndex: 1,
    delta: '第二段',
  })
  await f.send('item/reasoning/summaryTextDelta', {
    itemId: 'r6',
    summaryIndex: 0,
    delta: '第一段',
  })
  await f.send('thread/tokenUsage/updated', {
    tokenUsage: { total: { inputTokens: -1, totalTokens: '99' } },
  })
  await f.send('thread/tokenUsage/updated', { tokenUsage: { total: { outputTokens: 0 } } })
  await f.complete('completed', [{ type: 'reasoning', id: 'r6', summary: [], content: [] }])
  const indexed = await f.events()
  assert.equal(applyReasoning(indexed)[0].text, '第一段\n\n第二段')
  assert.ok(!JSON.stringify(indexed).includes('invalid'))
  const partial = indexed.filter((event) => event.type === 'usage')
  assert.equal(partial.length, 1)
  assert.equal(partial[0].payload.outputTokens, 0)
  assert.equal(partial[0].payload.inputTokens, null)
  assert.equal(partial[0].payload.totalTokens, null)
  checks.push(
    'out-of-order section indices reconcile safely; absent/invalid token counts remain unknown, not zero',
  )

  const g = await start('message-phase')
  await g.send('item/started', {
    item: { type: 'agentMessage', id: 'commentary', text: '', phase: 'commentary' },
  })
  await g.send('item/agentMessage/delta', { itemId: 'commentary', delta: '正在读取资料。' })
  await g.send('item/completed', {
    item: { type: 'agentMessage', id: 'commentary', text: '正在读取资料。', phase: null },
  })
  await g.send('item/agentMessage/delta', { itemId: 'late-phase', delta: '最终答复' })
  const finalItem = {
    type: 'agentMessage',
    id: 'late-phase',
    text: '最终答复。',
    phase: 'final_answer',
  }
  await g.send('item/completed', { item: finalItem })
  await g.send('item/completed', { item: finalItem })
  await g.send('item/agentMessage/delta', { itemId: 'unknown', delta: '提供方未标注。' })
  await g.send('item/completed', {
    item: { type: 'agentMessage', id: 'unknown', text: '提供方未标注。', phase: null },
  })
  await g.send('item/started', {
    turnId: 'unrelated',
    item: { type: 'agentMessage', id: 'unknown', text: '', phase: 'final_answer' },
  })
  await g.send('item/completed', {
    item: { type: 'agentMessage', id: 'unknown', text: '提供方未标注。', phase: 'invalid' },
  })
  await g.complete('completed', [
    finalItem,
    {
      type: 'agentMessage',
      id: 'terminal-snapshot',
      text: '仅终态快照返回。',
      phase: 'final_answer',
    },
  ])
  const phaseEvents = await g.events()
  const messages = phaseEvents
    .filter((event) => event.type === 'delta')
    .map((event) => event.payload)
  assert.deepEqual(
    messages.filter((item) => item.itemId === 'commentary'),
    [{ text: '正在读取资料。', itemId: 'commentary', messagePhase: 'commentary' }],
  )
  assert.deepEqual(
    messages.filter((item) => item.itemId === 'late-phase'),
    [
      { text: '最终答复', itemId: 'late-phase' },
      { text: '', itemId: 'late-phase', messagePhase: 'final_answer' },
      { text: '。', itemId: 'late-phase', messagePhase: 'final_answer' },
    ],
  )
  assert.deepEqual(
    messages.filter((item) => item.itemId === 'unknown'),
    [{ text: '提供方未标注。', itemId: 'unknown' }],
  )
  assert.deepEqual(
    messages.filter((item) => item.itemId === 'terminal-snapshot'),
    [{ text: '仅终态快照返回。', itemId: 'terminal-snapshot', messagePhase: 'final_answer' }],
  )
  assert.deepEqual(
    await g.events(2),
    phaseEvents.filter((event) => event.seq > 2),
  )
  checks.push(
    'official message phase survives start, late completion and terminal snapshot with cursor replay; unknown stays unknown',
  )

  evidence = { passed: true, checks, runCount: sequence, realModelCalls: 0, runnerProcesses: 0 }
} catch (error) {
  evidence = { passed: false, checks, error: error.stack, realModelCalls: 0, runnerProcesses: 0 }
  throw error
} finally {
  await bridge.close()
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(
    output,
    JSON.stringify(
      {
        ...evidence,
        testedAt: new Date().toISOString(),
        source: 'https://learn.chatgpt.com/docs/app-server',
        schemaVersion: 'codex-cli 0.159.2',
        bridgeSha256: createHash('sha256')
          .update(await readFile(new URL('../agent-demo/codex-bridge.mjs', import.meta.url)))
          .digest('hex'),
        testSha256: createHash('sha256')
          .update(await readFile(new URL(import.meta.url)))
          .digest('hex'),
        limitation:
          'Controlled protocol validation only; provider reasoning/usage availability and actual model behavior were not tested.',
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ ...evidence, report: output }))
}
