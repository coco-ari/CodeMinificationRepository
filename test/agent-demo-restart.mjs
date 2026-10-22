import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Client,
  eventSeq,
  persistentEvents,
  requestId,
  sleep,
  until,
  writeEvidence,
} from './agent-demo-helpers.mjs'

// 本测试启动自己的临时服务并只终止该子进程，不重启现有演示站点。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'agent-demo/server.mjs')
await readFile(entry, 'utf8')
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'autoops-agent-demo-restart-'))
const reservation = createServer()
await new Promise((resolve, reject) => {
  reservation.once('error', reject)
  reservation.listen(0, '127.0.0.1', resolve)
})
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const origin = `http://127.0.0.1:${port}`
const report = {
  startedAt: new Date().toISOString(),
  mode: 'scenario',
  target: '独立临时服务，非用户演示站点',
  checks: [],
  restarts: 0,
}
let child
let logs = ''

async function boot() {
  child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (data) => {
    logs = (logs + data).slice(-4000)
  })
  child.stderr.on('data', (data) => {
    logs = (logs + data).slice(-4000)
  })
  await until(
    async () => {
      if (child.exitCode !== null) throw new Error(`临时服务提前退出：${logs}`)
      try {
        const response = await fetch(`${origin}/api/agent-demo/health`, {
          signal: AbortSignal.timeout(500),
        })
        return response.ok
      } catch {
        return false
      }
    },
    '临时服务启动',
    15000,
  )
}

async function stopChild(signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return
  const current = child
  const exit = new Promise((resolve) => current.once('exit', resolve))
  current.kill(signal)
  await Promise.race([
    exit,
    sleep(3000).then(() => {
      if (current.exitCode === null) current.kill('SIGKILL')
    }),
  ])
  await exit
  child = null
}

try {
  await boot()
  const client = await new Client('lin', origin).login()
  const chat = await client.create()
  const attachment = await client.upload(chat.id, '重启资料.txt', '重启后附件内容保持一致')
  const draftFile = await client.upload(chat.id, '未发附件.txt', '未提交草稿的附件')
  await client.api('PUT', `/conversations/${chat.id}/draft`, {
    text: '重启之前的私人草稿',
    attachmentIds: [draftFile.id],
    revision: 0,
  })
  const sendId = requestId()
  const sent = await client.send(chat.id, '读取资料，等待进一步指令', {
    requestId: sendId,
    attachmentIds: [attachment.id],
    scenario: { kind: 'hold', stepDelayMs: 20 },
  })
  const turnId = sent.conversation.activeTurnId
  await client.send(chat.id, '重启后不得自动执行的后续任务', { delivery: 'queue' })
  const before = await until(async () => {
    const current = await client.conversation(chat.id)
    return current.messages.find((message) => message.role === 'assistant')?.content && current
  }, '崩溃前已持久保存部分输出')
  const prefix = before.messages.find((message) => message.role === 'assistant').content
  const beforeSeq = before.eventSeq
  await stopChild('SIGKILL')
  report.restarts++
  await boot()
  const restoredClient = await new Client('lin', origin).login()
  const restored = await restoredClient.conversation(chat.id)
  assert.equal(restored.activeTurnId, null)
  assert.equal(restored.status, 'interrupted')
  assert.equal(restored.queuePaused, true)
  assert.equal(restored.queue.length, 1)
  assert.equal(restored.turns.length, 1)
  assert.equal(restored.turns.find((turn) => turn.id === turnId).status, 'interrupted')
  assert.ok(
    restored.messages.find((message) => message.role === 'assistant').content.startsWith(prefix),
  )
  assert.deepEqual(restored.turns[0].timeline, before.turns[0].timeline)
  assert.equal(restored.turns[0].phase, 'interrupted')
  assert.ok(restored.turns[0].lastActivityAt >= before.turns[0].lastActivityAt)
  assert.ok(restored.eventSeq > beforeSeq)
  const draft = (await restoredClient.api('GET', `/conversations/${chat.id}/draft`)).draft
  assert.equal(draft.text, '重启之前的私人草稿')
  assert.deepEqual(draft.attachmentIds, [draftFile.id])
  const file = await restoredClient.raw('GET', `/files/${attachment.id}`)
  assert.equal(file.status, 200)
  assert.equal(file.body, '重启后附件内容保持一致')
  const draftDownload = await restoredClient.raw('GET', `/files/${draftFile.id}`)
  assert.equal(draftDownload.status, 200)
  const repeated = await restoredClient.send(chat.id, '读取资料，等待进一步指令', {
    requestId: sendId,
    attachmentIds: [attachment.id],
    scenario: { kind: 'hold', stepDelayMs: 20 },
  })
  assert.equal(repeated.receipt.id, sent.receipt.id)
  assert.equal((await restoredClient.conversation(chat.id)).turns.length, 1)
  await sleep(150)
  assert.equal((await restoredClient.conversation(chat.id)).activeTurnId, null)
  report.checks.push({ name: '崩溃后状态、部分输出、附件、草稿与幂等记录恢复', status: 'passed' })

  const stream = await restoredClient.stream(beforeSeq)
  try {
    await until(
      () => stream.events.some((event) => event.conversationId === chat.id),
      '重启中断事件回放',
    )
    const events = persistentEvents(stream.events).filter(
      (event) => event.conversationId === chat.id,
    )
    assert.ok(events.every((event) => eventSeq(event) > beforeSeq))
    assert.equal(new Set(events.map(eventSeq)).size, events.length)
    report.checks.push({
      name: '重启后 SSE 序号持续递增并回放中断事件',
      status: 'passed',
      ids: events.map(eventSeq),
    })
  } finally {
    await stream.close()
  }
  await stopChild('SIGKILL')
  report.restarts++
  await boot()
  const secondClient = await new Client('lin', origin).login()
  const secondRestore = await secondClient.conversation(chat.id)
  assert.equal(secondRestore.turns.length, 1)
  assert.equal(secondRestore.queue.length, 1)
  assert.equal(secondRestore.activeTurnId, null)
  assert.equal(secondRestore.queuePaused, true)
  assert.deepEqual(secondRestore.turns[0].timeline, restored.turns[0].timeline)
  const continueId = requestId()
  const continued = await secondClient.api('POST', `/conversations/${chat.id}/continue`, {
    requestId: continueId,
    turnId,
  })
  assert.equal(continued.conversation.turns.length, 2)
  assert.notEqual(continued.conversation.activeTurnId, turnId)
  if (continued.conversation.activeTurnId)
    await secondClient.stop(chat.id, continued.conversation.activeTurnId)
  report.checks.push({ name: '重复重启不重复恢复，用户可显式继续原轮次', status: 'passed' })
} catch (error) {
  report.error = error.stack
  report.checks.push({ name: '重启恢复验收', status: 'failed', error: error.stack })
  process.exitCode = 1
} finally {
  await stopChild()
  report.completedAt = new Date().toISOString()
  const output = await writeEvidence('restart.json', report)
  console.log(`重启恢复证据：${output}`)
  if (process.exitCode) console.error(report.error)
  await rm(dataDir, { recursive: true, force: true })
}
