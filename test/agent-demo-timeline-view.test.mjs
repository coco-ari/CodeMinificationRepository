import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationRows, applyTimelineDelta } from '../web/src/agent-demo/timeline.js'
import {
  formatConversationMarkdown,
  buildExportFilename,
} from '../web/src/agent-demo/conversation-export.js'

const base = () => ({
  turns: [{ id: 'turn', timeline: [] }],
  messages: [
    { id: 'prompt', role: 'user', turnId: 'turn', content: '检查环境' },
    { id: 'assistant', role: 'assistant', turnId: 'turn', content: '原始汇总' },
  ],
})

test('文字、工具、澄清和引导保持执行顺序，用户消息不重复', () => {
  const c = base()
  c.messages.push({ id: 'steer', role: 'user', kind: 'steer', turnId: 'turn', content: '先看生产' })
  c.turns[0].timeline = [
    { id: 'a', type: 'text', text: '先检查', itemId: 'model-a' },
    { id: 'tool', type: 'tool', stepId: 'step' },
    { id: 'question', type: 'question', question: { status: 'answered', prompt: '哪个环境？' } },
    { id: 'user', type: 'user', messageId: 'steer' },
    { id: 'b', type: 'text', text: '改为生产', itemId: 'model-a' },
  ]
  const rows = conversationRows(c)
  assert.deepEqual(
    rows.map((row) => row.role),
    ['user', 'assistant', 'user', 'assistant'],
  )
  assert.deepEqual(
    rows[1].parts.map((part) => part.type),
    ['text', 'tool', 'question'],
  )
  assert.equal(rows[1].content, '先检查')
  assert.equal(rows[3].content, '改为生产')
  assert.equal(rows[1].finalSegment, false)
  assert.equal(rows[3].finalSegment, true)
  assert.equal(rows.filter((row) => row.id === 'steer').length, 1)
})

test('续文仅更新自己的part，历史引用与行标识保持稳定', () => {
  const c = base()
  const original = { id: 'first', type: 'text', text: '已完成的段落' }
  c.turns[0].timeline = [original, { id: 'live', type: 'text', text: '继续' }]
  const before = conversationRows(c)
  const event = {
    turnId: 'turn',
    at: '2026-10-21T00:00:00Z',
    payload: {
      timelineEntry: { id: 'live', type: 'text', text: '继续生成中文。' },
      phase: 'responding',
    },
  }
  c.turns = applyTimelineDelta(c.turns, event)
  assert.equal(c.turns[0].timeline[0], original)
  assert.equal(c.turns[0].timeline.length, 2)
  assert.equal(c.turns[0].timeline[1].text, '继续生成中文。')
  assert.equal(conversationRows(c)[1].id, before[1].id)
  assert.equal(c.turns[0].lastActivityAt, event.at)
  assert.equal(c.turns[0].phase, 'responding')
})

test('旧记录与空轮次可展示，中途引导后不重复空回答', () => {
  const c = base()
  assert.equal(conversationRows(c)[1].id, 'assistant')
  delete c.turns[0].timeline
  assert.equal(conversationRows(c)[1], c.messages[1])
  c.turns[0].timeline = [
    { id: 'a', type: 'text', text: '说明' },
    { id: 'u', type: 'user', messageId: 'steer' },
  ]
  c.messages.push({ id: 'steer', role: 'user', turnId: 'turn' })
  assert.deepEqual(
    conversationRows(c).map((row) => row.id),
    ['prompt', 'assistant', 'steer'],
  )
})

test('新轮次更新复用旧轮次行，避免历史消息随流式更新重渲染', () => {
  const c = base()
  c.turns[0].timeline = [{ id: 'a', type: 'text', text: '历史内容' }]
  const cache = new Map()
  const before = conversationRows(c, cache)
  c.turns = [...c.turns, { id: 'new', timeline: [] }]
  c.messages = [...c.messages, { id: 'new-answer', role: 'assistant', turnId: 'new' }]
  const after = conversationRows(c, cache)
  assert.equal(after[1], before[1])
})

test('紧凑增量校验offset，摘要替换不污染正文，缺失片段触发快照修复', () => {
  const c = base()
  const event = (delta) => ({
    type: 'reasoning.delta',
    turnId: 'turn',
    payload: { timelineDelta: { id: 'reasoning', type: 'reasoning', ...delta } },
  })
  c.turns = applyTimelineDelta(c.turns, event({ mode: 'append', offset: 0, delta: '原片段' }))
  assert.equal(
    applyTimelineDelta(c.turns, event({ mode: 'append', offset: 100, delta: '丢失后的增量' })),
    null,
  )
  c.turns = applyTimelineDelta(
    c.turns,
    event({ mode: 'replace', offset: 0, delta: '模型返回的摘要' }),
  )
  c.turns = applyTimelineDelta(c.turns, event({ mode: 'append', offset: 7, delta: '。' }))
  assert.equal(c.turns[0].timeline[0].text, '模型返回的摘要。')
  assert.equal(conversationRows(c)[1].content, '')
  c.turns = applyTimelineDelta(c.turns, {
    type: 'turn.usage.updated',
    turnId: 'turn',
    payload: { usage: { totalTokens: 50 } },
  })
  c.turns = applyTimelineDelta(c.turns, {
    type: 'turn.usage.updated',
    turnId: 'turn',
    payload: { usage: { totalTokens: 80 } },
  })
  assert.equal(c.turns[0].usage.totalTokens, 80)
})

test('导出保留执行顺序，尊重思考显示选项，不包含工具原始数据', () => {
  const c = base()
  c.title = '测试 / 危险<>文件名'
  c.turns[0].steps = [
    {
      id: 'tool',
      name: 'read_document',
      status: 'completed',
      input: 'private raw input',
      output: 'private raw output',
    },
  ]
  c.turns[0].timeline = [
    { id: 'r', type: 'reasoning', text: '推理摘要' },
    { id: 't', type: 'tool', stepId: 'tool' },
    { id: 'a', type: 'text', text: '最终正文' },
  ]
  const all = formatConversationMarkdown(c)
  assert.ok(all.indexOf('推理摘要') < all.indexOf('工具：read_document'))
  assert.ok(all.indexOf('工具：read_document') < all.indexOf('最终正文'))
  assert.ok(!all.includes('private raw'))
  assert.ok(!formatConversationMarkdown(c, { includeReasoning: false }).includes('推理摘要'))
  assert.match(buildExportFilename(c.title), /^测试-危险-文件名-\d{4}-\d{2}-\d{2}\.md$/)
})
