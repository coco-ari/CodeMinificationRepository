import assert from 'node:assert/strict'
import {
  Client,
  baseUrl,
  deny,
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

// 本文件只用显式 scenario 验证 HTTP 状态机，不将其结果视为真实模型证据。
const startedAt = new Date().toISOString()
const checks = []
const clients = {}
let initialHealth
let raceCases = 0
const created = []
const track = (client, conversation) => {
  created.push({ client, id: conversation.id })
  return conversation
}
const create = async (client, args) => track(client, await client.create(args))
const hold = { kind: 'hold', stepDelayMs: 20 }
const normal = { kind: 'normal', stepDelayMs: 20 }

async function check(name, fn) {
  const start = performance.now()
  try {
    const detail = await fn()
    checks.push({
      name,
      status: 'passed',
      elapsedMs: Math.round(performance.now() - start),
      detail,
    })
    console.log(`通过：${name}`)
  } catch (error) {
    checks.push({
      name,
      status: 'failed',
      elapsedMs: Math.round(performance.now() - start),
      error: error.stack,
    })
    console.error(`失败：${name}\n${error.stack}`)
  }
}

const count = (conversation, predicate) => conversation.messages.filter(predicate).length
const promptTexts = (conversation) =>
  conversation.messages
    .filter((message) => message.kind === 'prompt')
    .map((message) => message.content)
const responseText = (conversation, turnId) =>
  conversation.messages.find((message) => message.turnId === turnId && message.role === 'assistant')
    ?.content || ''

await check('身份、Cookie、CSRF 与未登录拒绝', async () => {
  const anonymous = new Client('anonymous')
  await deny(anonymous, 'GET', '/bootstrap', undefined, [401])
  const invalid = await anonymous.raw('POST', '/login', { username: 'lin', password: 'invalid' })
  assert.equal(invalid.status, 401)
  for (const name of ['admin', 'lin', 'chen']) clients[name] = await new Client(name).login()
  initialHealth = await clients.lin.api('GET', '/health')
  const lin = clients.lin
  await deny(
    { raw: (...args) => lin.raw(...args.slice(0, 3), { noCsrf: true }) },
    'POST',
    '/conversations',
    { projectId: 'p-autoops', agentId: 'a-project', mode: 'scenario' },
  )
  const wrong = await lin.raw(
    'POST',
    '/conversations',
    { projectId: 'p-autoops', agentId: 'a-project', mode: 'scenario' },
    { headers: { 'X-Demo-CSRF': 'wrong' } },
  )
  assert.equal(wrong.status, 403)
  assert.ok(!clients.lin.bootstrap.projects.some((project) => project.id === 'p-cabinet'))
  assert.ok(!clients.chen.bootstrap.projects.some((project) => project.id === 'p-autoops'))
})

if (Object.keys(clients).length !== 3) {
  await writeEvidence('api.json', { startedAt, baseUrl, mode: 'scenario', checks, samples })
  throw new Error('身份基线失败，不能继续授权与状态验收')
}
const { admin, lin, chen } = clients

await check('成员、私有会话、资料、文件与个人草稿 ACL', async () => {
  const privateChat = await create(lin)
  const shared = await create(lin, { visibility: 'project' })
  await deny(admin, 'GET', `/conversations/${privateChat.id}`)
  await deny(chen, 'GET', `/conversations/${shared.id}`)
  await deny(chen, 'PATCH', `/conversations/${shared.id}`, { title: '不应更新' })
  await deny(chen, 'POST', `/conversations/${shared.id}/messages`, {
    requestId: requestId(),
    text: '不应发送',
    delivery: 'send',
  })
  await deny(lin, 'POST', '/conversations', {
    projectId: 'p-cabinet',
    agentId: 'a-project',
    environmentId: 'env-test',
    visibility: 'project',
    mode: 'scenario',
  })
  assert.equal((await admin.conversation(shared.id)).id, shared.id)
  const document = lin.bootstrap.projects.find((project) => project.id === 'p-autoops').documents[0]
  assert.ok(document, '种子项目必须提供可读资料')
  await lin.api('GET', `/projects/p-autoops/documents/${document.id}`)
  await deny(chen, 'GET', `/projects/p-autoops/documents/${document.id}`)
  const privateFile = await lin.upload(privateChat.id, 'private.txt', 'private-content')
  await deny(admin, 'GET', `/files/${privateFile.id}`)
  const pending = await lin.upload(shared.id, 'draft.txt', 'draft-secret')
  await lin.api('PUT', `/conversations/${shared.id}/draft`, {
    text: '仅林的草稿',
    attachmentIds: [pending.id],
    revision: 0,
  })
  assert.equal((await lin.api('GET', `/conversations/${shared.id}/draft`)).draft.text, '仅林的草稿')
  assert.notEqual(
    (await admin.api('GET', `/conversations/${shared.id}/draft`)).draft.text,
    '仅林的草稿',
  )
  await deny(admin, 'GET', `/files/${pending.id}`)
  await deny(admin, 'PUT', `/conversations/${shared.id}/draft`, {
    text: '偷用附件',
    attachmentIds: [pending.id],
    revision: 0,
  })
  const sent = await lin.send(shared.id, '分析附件', {
    attachmentIds: [pending.id],
    scenario: hold,
  })
  const file = await admin.raw('GET', `/files/${pending.id}`)
  assert.equal(file.status, 200)
  assert.equal(file.body, 'draft-secret')
  await deny(chen, 'GET', `/files/${pending.id}`)
  await deny(
    lin,
    'POST',
    `/conversations/${privateChat.id}/messages`,
    {
      requestId: requestId(),
      text: '跨会话附件应拒绝',
      attachmentIds: [pending.id],
      delivery: 'send',
    },
    [400, 403, 404, 409],
  )
  await admin.stop(shared.id, sent.conversation.activeTurnId)
  const unauthorizedList = await chen.api('GET', '/bootstrap')
  assert.ok(
    !unauthorizedList.conversations.some((item) => [shared.id, privateChat.id].includes(item.id)),
  )
  return { privateId: privateChat.id, sharedId: shared.id }
})

await check('发送幂等、同轮引导、回执及结束后的引导拒绝', async () => {
  const chat = await create(lin)
  const sendId = requestId()
  const [first, duplicate] = await Promise.all([
    lin.send(chat.id, '读取项目资料', { requestId: sendId, scenario: hold }),
    lin.send(chat.id, '读取项目资料', { requestId: sendId, scenario: hold }),
  ])
  assert.equal(first.receipt.id, duplicate.receipt.id)
  const conflictingRetry = await lin.raw('POST', `/conversations/${chat.id}/messages`, {
    requestId: sendId,
    text: '同一个标识改成另一条输入',
    attachmentIds: [],
    delivery: 'send',
    scenario: hold,
  })
  assert.equal(conflictingRetry.status, 409)
  assert.equal(conflictingRetry.json.code, 'IDEMPOTENCY_CONFLICT')
  const turnId = first.conversation.activeTurnId
  assert.ok(turnId)
  let current = await lin.conversation(chat.id)
  assert.equal(current.turns.length, 1)
  assert.equal(
    count(current, (message) => message.kind === 'prompt'),
    1,
  )
  await until(async () => responseText(await lin.conversation(chat.id), turnId), '引导前有部分输出')
  const prefix = responseText(await lin.conversation(chat.id), turnId)
  const steerId = requestId()
  const steer = { delivery: 'steer', expectedTurnId: turnId, requestId: steerId }
  const [accepted, repeated] = await Promise.all([
    lin.send(chat.id, '先检查环境，暂时不要生成报告', steer),
    lin.send(chat.id, '先检查环境，暂时不要生成报告', steer),
  ])
  assert.equal(accepted.receipt.id, repeated.receipt.id)
  current = await lin.conversation(chat.id)
  assert.equal(current.activeTurnId, turnId)
  assert.equal(current.turns.length, 1)
  assert.equal(current.turns[0].guidance.length, 1)
  assert.equal(current.turns[0].guidance[0].status, 'accepted')
  assert.ok(responseText(current, turnId).startsWith(prefix))
  assert.equal(
    count(current, (message) => message.kind === 'steer'),
    1,
  )
  const stopId = requestId()
  await Promise.all([lin.stop(chat.id, turnId, stopId), lin.stop(chat.id, turnId, stopId)])
  current = await lin.finish(chat.id)
  const rejected = await lin.raw('POST', `/conversations/${chat.id}/messages`, {
    requestId: requestId(),
    text: '迟到引导',
    attachmentIds: [],
    delivery: 'steer',
    expectedTurnId: turnId,
  })
  assert.equal(rejected.status, 409)
  current = await lin.conversation(chat.id)
  assert.equal(current.turns.length, 1)
  assert.equal(current.queue.length, 0)
  assert.equal(
    count(current, (message) => message.content === '迟到引导'),
    0,
  )
  return { turnId, guidanceStatus: current.turns[0].guidance[0].status }
})

await check('队列编辑删除排序、停止暂停、恢复 FIFO 与重复恢复', async () => {
  const chat = await create(lin)
  const active = await lin.send(chat.id, '主轮次', { scenario: hold })
  for (const text of ['排队一', '排队二', '排队三'])
    await lin.send(chat.id, text, { delivery: 'queue', scenario: normal })
  let current = await lin.conversation(chat.id)
  assert.equal(current.queue.length, 3)
  const [one, two, three] = current.queue
  const queueEditRevision = current.revision
  await lin.send(chat.id, '先看环境，不改变排队内容', {
    delivery: 'steer',
    expectedTurnId: active.conversation.activeTurnId,
  })
  current = await lin.conversation(chat.id)
  assert.ok(current.revision > queueEditRevision)
  assert.ok(current.queueRevision <= queueEditRevision)
  const edited = await lin.api('PATCH', `/conversations/${chat.id}/queue/${one.id}`, {
    text: '排队一已编辑',
    expectedRevision: queueEditRevision,
  })
  assert.ok(edited.conversation.queueRevision > queueEditRevision)
  const staleEdit = await lin.raw('PATCH', `/conversations/${chat.id}/queue/${one.id}`, {
    text: '旧页面试图覆盖',
    expectedRevision: queueEditRevision,
  })
  assert.equal(staleEdit.status, 409)
  assert.equal(staleEdit.json.code, 'REVISION_CONFLICT')
  await lin.api('DELETE', `/conversations/${chat.id}/queue/${two.id}`)
  await lin.api('POST', `/conversations/${chat.id}/queue/reorder`, { ids: [three.id, one.id] })
  await deny(lin, 'POST', `/conversations/${chat.id}/queue/reorder`, { ids: [one.id] }, [400, 409])
  await lin.stop(chat.id, active.conversation.activeTurnId)
  current = await lin.finish(chat.id)
  assert.equal(current.queuePaused, true)
  assert.deepEqual(
    current.queue.map((item) => item.text),
    ['排队三', '排队一已编辑'],
  )
  await sleep(250)
  current = await lin.conversation(chat.id)
  assert.equal(current.activeTurnId, null)
  assert.equal(current.turns.length, 1)
  const resumeId = requestId()
  await Promise.all([
    lin.api('POST', `/conversations/${chat.id}/queue/resume`, { requestId: resumeId }),
    lin.api('POST', `/conversations/${chat.id}/queue/resume`, { requestId: resumeId }),
  ])
  current = await until(
    async () => {
      const next = await lin.conversation(chat.id)
      return !next.activeTurnId && !next.queue.length && next
    },
    '所有队列完成',
    15000,
  )
  assert.equal(current.turns.length, 3)
  assert.deepEqual(promptTexts(current), ['主轮次', '排队三', '排队一已编辑'])
  return { order: promptTexts(current), pausedPersisted: true }
})

await check('澄清固定轮次、重复回答不重复执行、等待期间不抢跑队列', async () => {
  const chat = await create(lin)
  const sent = await lin.send(chat.id, '请检查项目状态，需要先明确范围', {
    scenario: { kind: 'clarify', stepDelayMs: 20 },
  })
  const turnId = sent.conversation.activeTurnId
  await lin.send(chat.id, '随后整理清单', { delivery: 'queue' })
  const waiting = await until(async () => {
    const current = await lin.conversation(chat.id)
    return (
      current.turns.find((turn) => turn.id === turnId)?.question?.status === 'pending' && current
    )
  }, '等待澄清')
  const question = waiting.turns.find((turn) => turn.id === turnId).question
  await sleep(150)
  const stillWaiting = await lin.conversation(chat.id)
  assert.equal(stillWaiting.activeTurnId, turnId)
  assert.equal(stillWaiting.turns.length, 1)
  assert.equal(stillWaiting.queue.length, 1)
  const answerId = requestId()
  const body = {
    requestId: answerId,
    answer: question.options[0] || '测试环境',
    expectedTurnId: turnId,
  }
  await Promise.all([
    lin.api('POST', `/conversations/${chat.id}/questions/${question.id}`, body),
    lin.api('POST', `/conversations/${chat.id}/questions/${question.id}`, body),
  ])
  const completed = await until(
    async () => {
      const current = await lin.conversation(chat.id)
      return !current.activeTurnId && !current.queue.length && current
    },
    '澄清后当前轮和队列完成',
    15000,
  )
  assert.equal(completed.turns.length, 2)
  assert.equal(
    count(completed, (message) => message.kind === 'answer' && message.role === 'user'),
    1,
  )
  assert.equal(completed.turns.find((turn) => turn.id === turnId).question.status, 'answered')
  return { questionId: question.id, turnId, answerMessages: 1 }
})

await check('失败和停止保留部分输出、继续沿用原输入附件且幂等', async () => {
  const chat = await create(lin)
  const attachment = await lin.upload(chat.id, '继续资料.txt', '继续时必须保留的资料')
  const sent = await lin.send(chat.id, '依据附件分析', {
    attachmentIds: [attachment.id],
    scenario: { kind: 'fail', stepDelayMs: 20 },
  })
  const originalTurnId = sent.conversation.activeTurnId
  const failed = await lin.finish(chat.id)
  assert.equal(failed.turns.find((turn) => turn.id === originalTurnId).status, 'failed')
  assert.ok(responseText(failed, originalTurnId), '失败前输出应保留')
  const continueId = requestId()
  const [continued, repeated] = await Promise.all([
    lin.api('POST', `/conversations/${chat.id}/continue`, {
      requestId: continueId,
      turnId: originalTurnId,
    }),
    lin.api('POST', `/conversations/${chat.id}/continue`, {
      requestId: continueId,
      turnId: originalTurnId,
    }),
  ])
  assert.equal(continued.conversation.activeTurnId, repeated.conversation.activeTurnId)
  const current = await lin.conversation(chat.id)
  assert.equal(current.turns.length, 2)
  const newTurn = current.turns.find((turn) => turn.id !== originalTurnId)
  assert.ok(newTurn)
  const newInput = current.messages.find((message) => message.id === newTurn.inputMessageId)
  assert.ok(newInput.attachments.some((file) => file.id === attachment.id))
  assert.match(newInput.content, /依据附件分析/)
  if (current.activeTurnId) await lin.stop(chat.id, current.activeTurnId)
  return { failedTurnId: originalTurnId, continuedTurnId: newTurn.id }
})

await check('SSE 权限过滤、断线回放、事件顺序与唯一性', async () => {
  const privateChat = await create(lin)
  const shared = await create(lin, { visibility: 'project' })
  const initialCursor = Math.max(privateChat.eventSeq, shared.eventSeq)
  const memberStream = await admin.stream(initialCursor)
  const outsiderStream = await chen.stream(initialCursor)
  const ownerStream = await lin.stream(initialCursor)
  let after = 0
  try {
    const privateRun = await lin.send(privateChat.id, '私密事件验证', { scenario: hold })
    const sharedRun = await lin.send(shared.id, '共享事件验证', { scenario: hold })
    await until(
      () =>
        ownerStream.events.some(
          (event) => event.conversationId === shared.id && event.type === 'message.delta',
        ),
      'SSE 实际增量',
    )
    const observed = persistentEvents(ownerStream.events)
    after = Math.max(...observed.map(eventSeq))
    await ownerStream.close()
    await lin.send(privateChat.id, '断线期间的引导', {
      delivery: 'steer',
      expectedTurnId: privateRun.conversation.activeTurnId,
    })
    await lin.stop(privateChat.id, privateRun.conversation.activeTurnId)
    await lin.stop(shared.id, sharedRun.conversation.activeTurnId)
    const replay = await lin.stream(after)
    try {
      await until(
        () => replay.events.some((event) => event.conversationId === privateChat.id),
        'SSE 回放补齐',
      )
      await sleep(100)
      const replayed = persistentEvents(replay.events)
      assert.ok(replayed.length > 0)
      const ids = replayed.map(eventSeq)
      assert.ok(ids.every((seq) => seq > after))
      assert.equal(new Set(ids).size, ids.length)
      assert.deepEqual(
        ids,
        [...ids].sort((a, b) => a - b),
      )
      for (const event of replayed) assert.equal(event.sseId, event.seq, 'SSE id 与事件 seq 一致')
      await until(
        () => memberStream.events.some((event) => event.conversationId === shared.id),
        '成员收到共享事件',
      )
      assert.ok(!memberStream.events.some((event) => event.conversationId === privateChat.id))
      assert.ok(
        !outsiderStream.events.some((event) =>
          [privateChat.id, shared.id].includes(event.conversationId),
        ),
      )
      return { after, replayedCount: replayed.length, ids, permissionFiltered: true }
    } finally {
      await replay.close()
    }
  } finally {
    await ownerStream.close()
    await memberStream.close()
    await outsiderStream.close()
  }
})

await check('100 次受控并发及边界竞态，无重复轮次/引导/队列', async () => {
  for (let iteration = 0; iteration < 25; iteration++) {
    const chat = await create(lin)
    const id = requestId()
    const options = { requestId: id, scenario: hold }
    const [first, second] = await Promise.all([
      lin.send(chat.id, `竞态 ${iteration}`, options),
      lin.send(chat.id, `竞态 ${iteration}`, options),
    ])
    assert.equal(first.receipt.id, second.receipt.id)
    assert.equal((await lin.conversation(chat.id)).turns.length, 1)
    raceCases++
    const turnId = first.conversation.activeTurnId
    const queueId = requestId()
    await Promise.all([
      lin.send(chat.id, '唯一队列', { delivery: 'queue', requestId: queueId }),
      lin.send(chat.id, '唯一队列', { delivery: 'queue', requestId: queueId }),
    ])
    assert.equal((await lin.conversation(chat.id)).queue.length, 1)
    raceCases++
    const steerId = requestId()
    await Promise.all([
      lin.send(chat.id, '保持当前任务检查', {
        delivery: 'steer',
        expectedTurnId: turnId,
        requestId: steerId,
      }),
      lin.send(chat.id, '保持当前任务检查', {
        delivery: 'steer',
        expectedTurnId: turnId,
        requestId: steerId,
      }),
    ])
    let current = await lin.conversation(chat.id)
    assert.equal(current.turns[0].guidance.length, 1)
    assert.equal(current.activeTurnId, turnId)
    raceCases++
    const [stop, raceSteer] = await Promise.all([
      lin.raw('POST', `/conversations/${chat.id}/stop`, {
        requestId: requestId(),
        expectedTurnId: turnId,
      }),
      lin.raw('POST', `/conversations/${chat.id}/messages`, {
        requestId: requestId(),
        text: '停止边界引导',
        attachmentIds: [],
        delivery: 'steer',
        expectedTurnId: turnId,
      }),
    ])
    assert.ok([200, 202].includes(stop.status))
    assert.ok([200, 202, 409].includes(raceSteer.status))
    current = await lin.finish(chat.id)
    assert.equal(current.turns.length, 1)
    assert.equal(current.queue.length, 1)
    assert.equal(current.queuePaused, true)
    assert.ok(current.turns[0].guidance.length <= 2)
    const before = responseText(current, turnId)
    await sleep(40)
    current = await lin.conversation(chat.id)
    assert.equal(responseText(current, turnId), before, '停止确认后不能继续正文')
    assert.equal(current.activeTurnId, null)
    raceCases++
  }
  assert.equal(raceCases, 100)
  return {
    iterations: 25,
    raceCases,
    families: ['重复发送', '重复排队', '重复引导', '停止与引导同时到达'],
  }
})

await check('五会话并发独立运行与 API 确认延迟', async () => {
  const chats = await Promise.all(Array.from({ length: 5 }, () => create(lin)))
  const runs = await Promise.all(
    chats.map((chat, index) => lin.send(chat.id, `并发任务 ${index}`, { scenario: hold })),
  )
  const current = await Promise.all(chats.map((chat) => lin.conversation(chat.id)))
  assert.equal(current.filter((chat) => chat.activeTurnId).length, 5)
  assert.equal(new Set(current.map((chat) => chat.activeTurnId)).size, 5)
  const firstSample = samples.length
  for (let round = 0; round < 6; round++)
    await Promise.all(
      chats.map((chat, index) =>
        lin.send(chat.id, `第 ${round} 次补充，保持当前任务检查`, {
          delivery: 'steer',
          expectedTurnId: runs[index].conversation.activeTurnId,
        }),
      ),
    )
  const timings = samples.slice(firstSample).map((sample) => sample.elapsedMs)
  const latency = quantiles(timings)
  await Promise.all(
    chats.map((chat, index) => lin.stop(chat.id, runs[index].conversation.activeTurnId)),
  )
  assert.equal(latency.count, 30)
  assert.ok(latency.p95 <= 500, `LAN API p95 超过500ms：${JSON.stringify(latency)}`)
  return { concurrency: 5, operation: '30 次真实 HTTP 引导确认，执行器为 scenario', latency }
})

await check('草稿版本冲突保护、状态快照版本与运行删除守卫', async () => {
  const chat = await create(lin)
  const first = await lin.api('PUT', `/conversations/${chat.id}/draft`, {
    text: '新草稿',
    attachmentIds: [],
    revision: 0,
  })
  const stale = await lin.raw('PUT', `/conversations/${chat.id}/draft`, {
    text: '迟到旧草稿',
    attachmentIds: [],
    revision: 0,
  })
  assert.ok([409, 200].includes(stale.status))
  assert.equal((await lin.api('GET', `/conversations/${chat.id}/draft`)).draft.text, '新草稿')
  assert.ok(first.draft.revision >= 1)
  const sent = await lin.send(chat.id, '运行删除守卫', { scenario: hold })
  assert.ok(Number.isInteger(sent.conversation.revision))
  assert.ok(Number.isInteger(sent.conversation.eventSeq))
  await deny(lin, 'DELETE', `/conversations/${chat.id}`, undefined, [409])
  await lin.stop(chat.id, sent.conversation.activeTurnId)
  const stopped = await lin.finish(chat.id)
  assert.ok(stopped.revision > sent.conversation.revision)
  assert.ok(stopped.eventSeq > sent.conversation.eventSeq)
  await lin.api('DELETE', `/conversations/${chat.id}`)
  await deny(lin, 'GET', `/conversations/${chat.id}`, undefined, [404])
})

// 仅清理本脚本建立的会话；保留完整测试结果，不触及用户已有演示数据。
for (const { client, id } of created) {
  try {
    const result = await client.raw('GET', `/conversations/${id}`)
    if (result.status === 404) continue
    const conversation = result.json?.conversation
    if (conversation?.activeTurnId) await client.stop(id, conversation.activeTurnId)
    await client.raw('DELETE', `/conversations/${id}`)
  } catch {
    // 清理失败不能掩盖首个验收错误。
  }
}
let finalHealth
try {
  finalHealth = await lin.api('GET', '/health')
  if (initialHealth?.buildHash && finalHealth.buildHash !== initialHealth.buildHash) {
    checks.push({
      name: '测试期间部署版本保持不变',
      status: 'failed',
      error: '后端 buildHash 发生变化，需复跑',
    })
  }
} catch (error) {
  finalHealth = { error: errorDetails(error) }
  checks.push({ name: '测试结束服务健康', status: 'failed', error: errorDetails(error) })
}
const report = {
  startedAt,
  completedAt: new Date().toISOString(),
  baseUrl,
  mode: 'scenario',
  initialHealth,
  finalHealth,
  clientNodeVersion: process.version,
  evidenceBoundary: 'HTTP 状态机与授权验收；不证明真实模型、浏览器视觉、手机键盘或完整商业体验。',
  checks,
  raceCases,
  requestLatency: quantiles(samples.map((sample) => sample.elapsedMs)),
  samples,
}
const output = await writeEvidence('api.json', report)
console.log(`证据：${output}`)
if (checks.some((item) => item.status === 'failed')) process.exitCode = 1
