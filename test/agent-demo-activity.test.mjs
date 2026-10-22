import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activityRowParts,
  planActivityTrim,
} from '../web/src/agent-demo/vendor/openchamber/activity-rows.js'
import { projectTurnActivity } from '../web/src/agent-demo/turn-activity-model.js'

const tool = (id) => ({ id, type: 'tool', stepId: id })
const text = (id, value, extra = {}) => ({ id, type: 'text', text: value, ...extra })
const tools = Array.from({ length: 10 }, (_, index) => tool(`tool-${index}`))
const turnWith = (parts, extra = {}) => ({
  id: 'turn',
  status: 'running',
  steps: tools.map((part) => ({
    id: part.id,
    status: 'completed',
    startedAt: 1,
    completedAt: 2,
  })),
  timeline: parts,
  ...extra,
})

// The cases below come from OpenChamber activityRows.test.ts at the source
// revision attributed by activity-rows.js. They guard the copied policy while
// the protocol-facing cases below guard AutoOps' additional storage formats.
test('OpenChamber 裁剪保留最新七行并正确处理完整消息边界', () => {
  assert.deepEqual(planActivityTrim([2, 3, 2], 7), {
    hiddenMessages: 0,
    skipRows: 0,
    hiddenRows: 0,
  })
  assert.deepEqual(planActivityTrim([3, 3, 4, 2], 7), {
    hiddenMessages: 1,
    skipRows: 2,
    hiddenRows: 5,
  })
  assert.deepEqual(planActivityTrim([3, 4, 3], 7), {
    hiddenMessages: 1,
    skipRows: 0,
    hiddenRows: 3,
  })
  assert.deepEqual(planActivityTrim([12], 7), {
    hiddenMessages: 0,
    skipRows: 5,
    hiddenRows: 5,
  })
})

test('OpenChamber 不把空白或零宽文字计为行，保留正常词内连接符', () => {
  const parts = [
    text('zero', '\u200B'),
    text('bom', '\uFEFF\n'),
    text('joiners', '\u200C\u200D'),
    text('persian', 'می‌خواهم'),
    text('emoji', '👨‍👩‍👧'),
    { id: 'reasoning', type: 'reasoning', text: 'thinking' },
  ]
  assert.deepEqual(
    activityRowParts(parts, false).map((part) => part.id),
    ['persian', 'emoji'],
  )
  assert.deepEqual(
    activityRowParts(parts, true).map((part) => part.id),
    ['persian', 'emoji', 'reasoning'],
  )
})

test('OpenChamber 仅计入运行中或结束时间有效的工具', () => {
  const parts = [
    { id: 'pending', type: 'tool', state: { status: 'pending' } },
    { id: 'running', type: 'tool', state: { status: 'running', time: { start: 2 } } },
    { id: 'done', type: 'tool', state: { status: 'completed', time: { start: 2, end: 3 } } },
    { id: 'failed', type: 'tool', state: { status: 'error', time: { start: 2, end: 3 } } },
    { id: 'invalid', type: 'tool', state: { status: 'completed', time: { start: 3, end: 2 } } },
  ]
  assert.deepEqual(
    activityRowParts(parts, true).map((part) => part.id),
    ['pending', 'running', 'done', 'failed'],
  )
})

test('运行时显示最新七行，手动展开后显示完整原始顺序', () => {
  const turn = turnWith(tools)
  const collapsed = projectTurnActivity({ parts: tools, turn })
  assert.equal(collapsed.hiddenRows, 3)
  assert.deepEqual(
    collapsed.shownParts.map((part) => part.id),
    tools.slice(3).map((part) => part.id),
  )
  const opened = projectTurnActivity({ parts: tools, turn, expanded: true })
  assert.equal(opened.hiddenRows, 0)
  assert.deepEqual(
    opened.shownParts.map((part) => part.id),
    tools.map((part) => part.id),
  )
})

test('只有最终答复完成才折叠，流式首字与普通说明完成不会提前折叠', () => {
  const final = text('final', '最终结果', { messagePhase: 'final_answer', status: 'streaming' })
  const parts = [...tools, final]
  assert.equal(projectTurnActivity({ parts, turn: turnWith(parts) }).settled, false)
  const completed = [...tools, { ...final, status: 'completed' }]
  const model = projectTurnActivity({ parts: completed, turn: turnWith(completed) })
  assert.equal(model.settled, true)
  assert.equal(model.finalPart.id, 'final')
  assert.deepEqual(
    model.activityParts.map((part) => part.id),
    tools.map((part) => part.id),
  )
  const commentary = [
    ...tools,
    text('commentary', '准备生成', { messagePhase: 'commentary', status: 'completed' }),
  ]
  assert.equal(
    projectTurnActivity({ parts: commentary, turn: turnWith(commentary, { status: 'completed' }) })
      .settled,
    false,
  )
})

test('历史兼容只从完成轮的尾部正文识别最终答复，不将中断说明当作结果', () => {
  const parts = [tools[0], text('comment', '正在读取'), tools[1], text('answer', '实际答复')]
  const completed = projectTurnActivity({ parts, turn: turnWith(parts, { status: 'completed' }) })
  assert.equal(completed.finalPart.id, 'answer')
  const interrupted = projectTurnActivity({
    parts,
    turn: turnWith(parts, { status: 'interrupted' }),
  })
  assert.equal(interrupted.settled, false)
  assert.equal(interrupted.finalPart, undefined)
  const endsInTool = [text('comment', '开始读取'), tools[0]]
  assert.equal(
    projectTurnActivity({ parts: endsInTool, turn: turnWith(endsInTool, { status: 'completed' }) })
      .finalPart,
    undefined,
  )
})

test('待回答表单保持原始位置，超出七行也不得裁掉', () => {
  const question = { id: 'question', type: 'question', question: { status: 'pending' } }
  const parts = [tools[0], question, ...tools.slice(1)]
  const model = projectTurnActivity({ parts, turn: turnWith(parts, { status: 'waiting' }) })
  assert.equal(model.settled, false)
  assert.deepEqual(
    model.shownParts.map((part) => part.id),
    parts.slice(1).map((part) => part.id),
  )
  assert.equal(model.hiddenRows, 1)
})

test('已回答表单可随旧活动裁剪，不阻止新的活动尾部显示', () => {
  const question = { id: 'question', type: 'question', question: { status: 'answered' } }
  const parts = [question, ...tools]
  const model = projectTurnActivity({ parts, turn: turnWith(parts) })
  assert.deepEqual(
    model.shownParts.map((part) => part.id),
    tools.slice(3).map((part) => part.id),
  )
})

test('引导消息前的 segment 不提取别处答复，整轮完成后仍可收起其活动', () => {
  const final = text('answer', '完成', { messagePhase: 'final_answer', status: 'completed' })
  const beforeSteer = tools.slice(0, 2)
  const timeline = [
    ...beforeSteer,
    { id: 'steer', type: 'user', messageId: 'user' },
    ...tools.slice(2),
    final,
  ]
  const model = projectTurnActivity({
    parts: beforeSteer,
    turn: turnWith(timeline),
    finalSegment: false,
  })
  assert.equal(model.settled, true)
  assert.equal(model.finalPart, undefined)
  assert.deepEqual(
    model.activityParts.map((part) => part.id),
    beforeSteer.map((part) => part.id),
  )
})

test('没有答复的旧轮在后续助手开始后收起，单独排队不会使它退场', () => {
  const turn = turnWith(tools, { status: 'interrupted' })
  assert.equal(projectTurnActivity({ parts: tools, turn }).settled, false)
  const retired = projectTurnActivity({ parts: tools, turn, hasLaterAssistant: true })
  assert.equal(retired.settled, true)
  assert.equal(retired.finalPart, undefined)
})

test('先前的最终标记不能折叠其后的新工作或待答问题', () => {
  const final = text('old-final', '先前完成', { messagePhase: 'final_answer', status: 'completed' })
  for (const later of [
    tools[1],
    text('later-commentary', '还有下一项', { messagePhase: 'commentary' }),
    { id: 'question', type: 'question', question: { status: 'pending' } },
    { id: 'steer', type: 'user', messageId: 'user' },
  ]) {
    const parts = [tools[0], final, later]
    const model = projectTurnActivity({ parts, turn: turnWith(parts) })
    assert.equal(model.settled, false, later.type)
    assert.equal(model.finalPart, undefined, later.type)
  }
})

test('纯文字对话与隐藏思考后的纯答复不增加活动折叠层', () => {
  const parts = [text('answer', '你好')]
  assert.equal(
    projectTurnActivity({ parts, turn: turnWith(parts, { status: 'completed' }) }).hasActivity,
    false,
  )
  const withReasoning = [{ id: 'r', type: 'reasoning', text: '思考' }, ...parts]
  assert.equal(
    projectTurnActivity({
      parts: withReasoning,
      turn: turnWith(withReasoning),
      showReasoning: false,
    }).hasActivity,
    false,
  )
  assert.equal(
    projectTurnActivity({ parts: withReasoning, turn: turnWith(withReasoning) }).hasActivity,
    true,
  )
})
