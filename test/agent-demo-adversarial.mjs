import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import {
  Client,
  baseUrl,
  eventSeq,
  isolatedServer,
  persistentEvents,
  sleep,
  until,
  writeEvidence,
} from './agent-demo-helpers.mjs'

// 延迟请求体与断线状态的定向测试，不依赖模型速度或概率性高并发。
const isolated = process.env.AGENT_DEMO_ISOLATED === '1' ? await isolatedServer() : null
const origin = isolated?.origin || baseUrl
const report = {
  startedAt: new Date().toISOString(),
  baseUrl: origin,
  mode: 'scenario',
  checks: [],
}
const owner = await new Client('lin', origin).login()
const stranger = await new Client('chen', origin).login()
const created = []
async function create() {
  const conversation = await owner.create()
  created.push(conversation.id)
  return conversation
}
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

function delayedBody(client, method, endpoint, body) {
  const url = new URL(`${origin}/api/agent-demo${endpoint}`)
  const encoded = JSON.stringify(body)
  let request
  const response = new Promise((resolve, reject) => {
    request = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method,
        headers: {
          Cookie: client.cookie,
          'X-Demo-CSRF': client.csrf,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(encoded),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            json: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        )
      },
    )
    request.once('error', reject)
    request.setTimeout(5000, () => request.destroy(new Error('延迟请求测试超时')))
    request.flushHeaders()
  })
  return {
    finish: () => {
      request.end(encoded)
      return response
    },
    cancel: () => request.destroy(),
  }
}

await check('慢请求不能用过期草稿版本覆盖较新保存', async () => {
  const conversation = await create()
  const path = `/conversations/${conversation.id}/draft`
  const slow = delayedBody(owner, 'PUT', path, { text: '迟到草稿', attachmentIds: [], revision: 0 })
  try {
    await sleep(100)
    const latest = await owner.api('PUT', path, {
      text: '较新草稿',
      attachmentIds: [],
      revision: 0,
    })
    assert.equal(latest.draft.revision, 1)
    const late = await slow.finish()
    assert.equal(late.status, 409)
    assert.equal((await owner.api('GET', path)).draft.text, '较新草稿')
  } finally {
    slow.cancel()
  }
})

await check('会话删除后迟到的修改不能成功或复活会话', async () => {
  const conversation = await create()
  const path = `/conversations/${conversation.id}`
  const slow = delayedBody(owner, 'PATCH', path, { title: '不应复活的会话' })
  try {
    await sleep(100)
    await owner.api('DELETE', path)
    const late = await slow.finish()
    assert.ok([404, 409].includes(late.status), `迟到修改应拒绝，实际${late.status}`)
    assert.equal((await owner.raw('GET', path)).status, 404)
  } finally {
    slow.cancel()
  }
})

await check('断线期间删除事件可回放且保持原权限', async () => {
  const conversation = await create()
  const after = conversation.eventSeq
  await owner.api('DELETE', `/conversations/${conversation.id}`)
  const stream = await owner.stream(after)
  const forbidden = await stranger.stream(after)
  try {
    await until(() => stream.events.some((event) => event.type === 'ready'), '回放完成')
    const deletion = persistentEvents(stream.events).find(
      (event) => event.type === 'conversation.deleted' && event.conversationId === conversation.id,
    )
    assert.ok(deletion, '断线后必须补回 conversation.deleted')
    assert.ok(eventSeq(deletion) > after)
    await until(() => forbidden.events.some((event) => event.type === 'ready'), '未授权回放完成')
    assert.ok(!forbidden.events.some((event) => event.conversationId === conversation.id))
    return { deletionSeq: eventSeq(deletion), after }
  } finally {
    await stream.close()
    await forbidden.close()
  }
})

await check('Last-Event-ID 回放游标与退出登录关闭 SSE', async () => {
  const account = await new Client('lin', origin).login()
  const conversation = await account.create()
  created.push(conversation.id)
  await account.api('PATCH', `/conversations/${conversation.id}`, { title: '游标之后的更新' })
  const stream = await account.stream(0, { 'Last-Event-ID': String(conversation.eventSeq) })
  try {
    await until(
      () => stream.events.some((event) => event.type === 'ready'),
      'Last-Event-ID 回放完成',
    )
    const ownEvents = persistentEvents(stream.events).filter(
      (event) => event.conversationId === conversation.id,
    )
    assert.ok(ownEvents.length > 0)
    assert.ok(ownEvents.every((event) => eventSeq(event) > conversation.eventSeq))
    await account.api('POST', '/logout', {})
    await until(() => stream.closed, '登出后旧 SSE 关闭')
    assert.equal((await account.raw('GET', '/bootstrap')).status, 401)
  } finally {
    await stream.close()
  }
})

for (const id of created) await owner.raw('DELETE', `/conversations/${id}`)
report.completedAt = new Date().toISOString()
console.log(`定向竞态证据：${await writeEvidence('adversarial.json', report)}`)
await isolated?.stop()
if (report.checks.some((check) => check.status === 'failed')) process.exitCode = 1
