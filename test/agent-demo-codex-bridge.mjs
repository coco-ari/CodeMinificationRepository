import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createCodexBridge } from '../agent-demo/codex-bridge.mjs'
// 注入协议运行器，仅启动回环 HTTP；不启动 Codex，不读取配置或凭据，不请求模型。
const output = path.resolve(
  process.env.AGENT_DEMO_PROTOCOL_REPORT || '.test-artifacts/agent-demo-api/codex-bridge.json',
)
let result
const token = 'local-protocol-check-token-only-123456789'
const calls = [],
  replies = []
let emit
const bridge = await createCodexBridge({
  token,
  enabled: true,
  model: 'protocol-only',
  codexHome: '/private/tmp/protocol-only',
  runnerFactory(onMessage) {
    emit = onMessage
    return {
      async request(method, params) {
        calls.push({ method, params })
        if (method === 'thread/start')
          return {
            thread: { id: 'thread_1' },
            activePermissionProfile: { id: 'agent_demo' },
            approvalPolicy: 'never',
            sandbox: { type: 'readOnly', networkAccess: false },
          }
        if (method === 'turn/start') {
          await emit({
            method: 'turn/started',
            params: { threadId: 'thread_1', turn: { id: 'turn_1' } },
          })
          return { turn: { id: 'turn_1' } }
        }
        if (method === 'account/read')
          return { account: { type: 'apiKey' }, requiresOpenaiAuth: true }
        if (method === 'turn/steer') {
          await new Promise((r) => setTimeout(r, 10))
          return { turnId: 'turn_1' }
        }
        return {}
      },
      notify() {},
      reply(id, result) {
        replies.push({ id, result })
      },
      replyError(id, error) {
        replies.push({ id, error })
      },
      close() {},
    }
  },
})
try {
  const { port } = await bridge.listen(0),
    base = `http://127.0.0.1:${port}`
  const request = async (path, body, extra = {}) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, value: await response.json() }
  }
  assert.equal((await request('/health')).value.liveAvailable, true)
  assert.equal((await request('/health', null, { Origin: 'https://invalid.example' })).status, 403)
  assert.equal((await request('/health', null, { Authorization: 'Bearer invalid' })).status, 401)
  const input = {
    runId: 'run_1',
    prompt: '分析并生成报告',
    context: {
      project: { id: 'p1', name: '项目' },
      environment: { id: 'e1', name: '测试' },
      documents: [{ id: 'doc1', name: '说明', content: '已授权内容' }],
      resources: [],
      resourceSnapshot: { kind: 'fixture' },
      partialOutput: '先前部分',
      originalGuidance: ['只分析测试'],
    },
    history: [],
    attachments: [
      { id: 'pdf1', name: 'a.pdf', mime: 'application/pdf' },
      { id: 'text1', name: '资料.txt', mime: 'text/plain', content: '已授权附件' },
    ],
  }
  assert.equal((await request('/runs', input)).status, 202)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((await request('/runs', input)).status, 200)
  assert.equal(calls.filter((c) => c.method === 'thread/start').length, 1)
  assert.equal(calls.find((c) => c.method === 'thread/start').params.permissions, 'agent_demo')
  assert.equal(calls.find((c) => c.method === 'thread/start').params.approvalPolicy, 'never')
  const steering = { requestId: 'steer1', text: '先看生产说明', expectedRunnerTurnId: 'turn_1' }
  const both = await Promise.all([
    request('/runs/run_1/steer', steering),
    request('/runs/run_1/steer', steering),
  ])
  assert(both.every((r) => r.value.accepted))
  assert.equal(calls.filter((c) => c.method === 'turn/steer').length, 1)
  assert.equal((await request('/runs/run_1/steer', { ...steering, text: '不同正文' })).status, 409)
  assert.equal(
    (
      await request('/runs/run_1/steer', {
        ...steering,
        requestId: 'stale',
        expectedRunnerTurnId: 'wrong',
      })
    ).status,
    409,
  )
  const tool = (id, tool, args) =>
    emit({
      id,
      method: 'item/tool/call',
      params: { threadId: 'thread_1', turnId: 'turn_1', callId: id, tool, arguments: args },
    })
  await tool('env', 'query_environment', { environmentId: 'e1' })
  assert.match(JSON.stringify(replies.at(-1)), /demo_fixture_snapshot/)
  await tool('doc', 'read_project_document', { id: 'doc1' })
  assert.equal(
    JSON.parse(replies.at(-1).result.contentItems[0].text).sourceUrl,
    '/api/agent-demo/projects/p1/documents/doc1',
  )
  await tool('text', 'read_attachment', { id: 'text1' })
  assert.equal(
    JSON.parse(replies.at(-1).result.contentItems[0].text).sourceUrl,
    '/api/agent-demo/files/text1',
  )
  await tool('bad-doc', 'read_project_document', { id: 'unrelated' })
  assert.equal(replies.at(-1).result.success, false)
  await tool('pdf', 'read_attachment', { id: 'pdf1' })
  assert.equal(replies.at(-1).result.success, false)
  await emit({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'msg1', delta: '中文开始' },
  })
  const waiting = tool('ask', 'ask_user', { prompt: '需要哪个环境？', options: ['测试', '生产'] })
  const abort = new AbortController(),
    response = await fetch(base + '/runs/run_1/events', {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort.signal,
    })
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let buffer = '',
    question
  while (!question) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value, { stream: true })
    for (const line of buffer.split('\n'))
      if (line.startsWith('data: ')) {
        const event = JSON.parse(line.slice(6))
        if (event.type === 'question') question = event.payload
      }
  }
  abort.abort()
  const answer = { requestId: 'answer1', questionId: question.id, answer: '测试' },
    answers = await Promise.all([
      request('/runs/run_1/answer', answer),
      request('/runs/run_1/answer', answer),
    ])
  assert(answers.every((r) => r.value.accepted))
  await waiting
  assert.equal(replies.filter((r) => r.id === 'ask').length, 1)
  await tool('report', 'create_report', {
    name: '分析.md',
    mime: 'text/markdown',
    content: '# 测试报告',
  })
  const stop = { requestId: 'stop1', expectedRunnerTurnId: 'turn_1' },
    stops = await Promise.all([
      request('/runs/run_1/stop', stop),
      request('/runs/run_1/stop', stop),
    ])
  assert(stops.every((r) => r.value.accepted))
  assert.equal(calls.filter((c) => c.method === 'turn/interrupt').length, 1)
  await emit({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'msg1', delta: '停止后不应出现' },
  })
  await emit({
    method: 'turn/completed',
    params: { threadId: 'thread_1', turn: { id: 'turn_1', status: 'interrupted' } },
  })
  const eventsResponse = await fetch(base + '/runs/run_1/events', {
      headers: { Authorization: `Bearer ${token}` },
    }),
    events = (await eventsResponse.text())
      .split('\n')
      .filter((x) => x.startsWith('data: '))
      .map((x) => JSON.parse(x.slice(6)))
  assert.equal(events.at(-1).type, 'interrupted')
  assert.equal(events.filter((e) => e.type === 'started').length, 1)
  assert(!JSON.stringify(events).includes('停止后不应出现'))
  assert(events.some((e) => e.type === 'artifact'))
  const toolEvents = events.filter((e) => e.type === 'tool').map((e) => e.payload)
  assert(toolEvents.every((e) => Number.isFinite(Date.parse(e.startedAt))))
  assert(
    toolEvents.filter((e) => e.status !== 'running').every((e) => e.completedAt >= e.startedAt),
  )
  assert(
    toolEvents
      .filter((e) => e.status !== 'running')
      .every(
        (e) =>
          toolEvents.find((start) => start.id === e.id && start.status === 'running')?.startedAt ===
          e.startedAt,
      ),
  )
  assert(events.every((e, i) => e.seq === i + 1))
  const replay = await fetch(base + `/runs/run_1/events?after=${events.length - 1}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal((await replay.text()).split('\n').filter((x) => x.startsWith('data: ')).length, 1)
  result = {
    passed: true,
    assertions: 30,
    events: events.length,
    realModelCalls: 0,
    runnerProcesses: 0,
  }
} catch (error) {
  result = { passed: false, error: error.stack, realModelCalls: 0, runnerProcesses: 0 }
  throw error
} finally {
  await bridge.close()
  await mkdir(path.dirname(output), { recursive: true })
  const evidence = {
    ...result,
    testedAt: new Date().toISOString(),
    nodeVersion: process.version,
    bridgeSha256: createHash('sha256')
      .update(await readFile(new URL('../agent-demo/codex-bridge.mjs', import.meta.url)))
      .digest('hex'),
    testSha256: createHash('sha256')
      .update(await readFile(new URL(import.meta.url)))
      .digest('hex'),
    limitation:
      '注入协议验证不证明真实 Codex app-server 配置、系统隔离或模型行为；这些仍待明确授权后单独实测。',
  }
  await writeFile(output, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ...result, evidence: output }))
}
