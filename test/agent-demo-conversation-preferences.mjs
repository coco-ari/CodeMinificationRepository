import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client, requestId, until, writeEvidence } from './agent-demo-helpers.mjs'

// Real HTTP/SSE/SQLite tests, isolated data and no model or deployed service.
const root = process.cwd()
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'autoops-preferences-'))
const reservation = http.createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const origin = `http://127.0.0.1:${port}`
const report = { mode: 'isolated-scenario', realModelCalls: 0, checks: [] }
let child
let logs = ''
let lin, admin, chen
async function boot() {
  child = spawn(process.execPath, ['agent-demo/server.mjs'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      AGENT_BRIDGE_URL: '',
      AGENT_BRIDGE_TOKEN: '',
    },
  })
  for (const pipe of [child.stdout, child.stderr])
    pipe.on('data', (data) => {
      logs = (logs + data).slice(-4000)
    })
  await until(async () => {
    if (child.exitCode !== null) throw new Error(logs)
    try {
      const response = await fetch(`${origin}/api/agent-demo/health`)
      if (!response.ok) return false
      report.buildHash = (await response.json()).buildHash
      return true
    } catch {
      return false
    }
  }, 'isolated preferences server boot')
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const stopped = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
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
const flags = (c) => ({ pinned: c.pinned, archived: c.archived })
const patch = async (client, id, body) =>
  (await client.api('PATCH', `/conversations/${id}/preferences`, body)).conversation
const inspectDb = (fn) => {
  const db = new DatabaseSync(path.join(dataDir, 'demo.sqlite'), { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
const sharedEvent = (stream, id, seq) =>
  stream.events.find(
    (event) => event.conversationId === id && event.seq === seq && event.payload?.conversation,
  )?.payload.conversation

try {
  await boot()
  ;[lin, admin, chen] = await Promise.all(
    ['lin', 'admin', 'chen'].map((name) => new Client(name, origin).login()),
  )

  await check('个人置顶/归档独立持久化，PATCH重复与省略字段不产生副作用', async () => {
    const c = await lin.create({ visibility: 'project' })
    assert.deepEqual(flags(c), { pinned: false, archived: false })
    const pinned = await patch(lin, c.id, { pinned: true })
    assert.deepEqual(flags(pinned), { pinned: true, archived: false })
    assert.equal(pinned.revision, c.revision)
    assert.equal(pinned.updatedAt, c.updatedAt)
    assert.equal(pinned.visibility, c.visibility)
    assert.ok(pinned.eventSeq > c.eventSeq)
    const repeated = await patch(lin, c.id, { pinned: true })
    assert.equal(repeated.eventSeq, pinned.eventSeq, 'same state must not emit another event')
    assert.deepEqual(flags(await admin.conversation(c.id)), { pinned: false, archived: false })
    const archived = await patch(lin, c.id, { archived: true })
    assert.deepEqual(flags(archived), { pinned: true, archived: true })
    const restored = await patch(lin, c.id, { archived: false })
    assert.deepEqual(flags(restored), { pinned: true, archived: false })
    await Promise.all([patch(lin, c.id, { archived: true }), patch(admin, c.id, { pinned: true })])
    assert.deepEqual(flags(await lin.conversation(c.id)), { pinned: true, archived: true })
    assert.deepEqual(flags(await admin.conversation(c.id)), { pinned: true, archived: false })
    const linBootstrap = await lin.api('GET', '/bootstrap')
    const adminBootstrap = await admin.api('GET', '/bootstrap')
    assert.deepEqual(flags(linBootstrap.conversations.find((item) => item.id === c.id)), {
      pinned: true,
      archived: true,
    })
    assert.deepEqual(flags(adminBootstrap.conversations.find((item) => item.id === c.id)), {
      pinned: true,
      archived: false,
    })
    return { conversationId: c.id, sharedRevisionUnchanged: c.revision }
  })

  await check('HTTP与实时/回放SSE都按接收用户投影，个人标记不进入共享历史', async () => {
    const c = await lin.create({ visibility: 'project' })
    const [linStream, adminStream] = await Promise.all([
      lin.stream(c.eventSeq),
      admin.stream(c.eventSeq),
    ])
    try {
      const updated = await patch(lin, c.id, { pinned: true, archived: true })
      await until(
        () =>
          sharedEvent(linStream, c.id, updated.eventSeq) &&
          sharedEvent(adminStream, c.id, updated.eventSeq),
        'both users receive preference update',
      )
      assert.deepEqual(flags(sharedEvent(linStream, c.id, updated.eventSeq)), {
        pinned: true,
        archived: true,
      })
      assert.deepEqual(flags(sharedEvent(adminStream, c.id, updated.eventSeq)), {
        pinned: false,
        archived: false,
      })
      const renamed = (
        await admin.api('PATCH', `/conversations/${c.id}`, { title: '共享标题更新后保留个人归档' })
      ).conversation
      assert.deepEqual(flags(renamed), { pinned: false, archived: false })
      await until(() => sharedEvent(linStream, c.id, renamed.eventSeq), 'content update projection')
      assert.deepEqual(flags(sharedEvent(linStream, c.id, renamed.eventSeq)), {
        pinned: true,
        archived: true,
      })
      assert.deepEqual(flags(await lin.conversation(c.id)), { pinned: true, archived: true })
      inspectDb((db) => {
        const stored = JSON.parse(
          db.prepare('SELECT body FROM conversations WHERE id=?').get(c.id).body,
        )
        assert.equal(Object.hasOwn(stored, 'pinned'), false)
        assert.equal(Object.hasOwn(stored, 'archived'), false)
        for (const row of db.prepare('SELECT body FROM events WHERE cid=?').all(c.id)) {
          const conversation = JSON.parse(row.body).payload?.conversation
          if (!conversation) continue
          assert.equal(Object.hasOwn(conversation, 'pinned'), false)
          assert.equal(Object.hasOwn(conversation, 'archived'), false)
        }
      })
      const [linReplay, adminReplay] = await Promise.all([lin.stream(0), admin.stream(0)])
      try {
        await until(
          () =>
            sharedEvent(linReplay, c.id, renamed.eventSeq) &&
            sharedEvent(adminReplay, c.id, renamed.eventSeq),
          'replay catches latest conversation',
        )
        for (const [stream, expected] of [
          [linReplay, { pinned: true, archived: true }],
          [adminReplay, { pinned: false, archived: false }],
        ])
          for (const event of stream.events.filter((item) => item.conversationId === c.id))
            if (event.payload?.conversation)
              assert.deepEqual(flags(event.payload.conversation), expected)
      } finally {
        await Promise.all([linReplay.close(), adminReplay.close()])
      }
      return { liveUsers: 2, replayUsers: 2, rawHistoryContainsPreferences: false }
    } finally {
      await Promise.all([linStream.close(), adminStream.close()])
    }
  })

  await check('偏好接口沿用项目/私有会话ACL与CSRF，拒绝无效字段和伪造用户', async () => {
    const shared = await lin.create({ visibility: 'project' })
    const privateChat = await lin.create()
    for (const [client, id] of [
      [chen, shared.id],
      [admin, privateChat.id],
    ]) {
      assert.equal(
        (await client.raw('PATCH', `/conversations/${id}/preferences`, { pinned: true })).status,
        404,
      )
      assert.equal((await client.raw('GET', `/conversations/${id}`)).status, 404)
    }
    assert.equal(
      (
        await lin.raw(
          'PATCH',
          `/conversations/${shared.id}/preferences`,
          { pinned: true },
          { noCsrf: true },
        )
      ).status,
      403,
    )
    for (const invalid of [
      {},
      null,
      [],
      { pinned: 1 },
      { archived: 'true' },
      { pinned: true, uid: admin.user.id },
      { visibility: 'private' },
    ])
      assert.equal(
        (await lin.raw('PATCH', `/conversations/${shared.id}/preferences`, invalid)).status,
        400,
      )
    assert.deepEqual(flags(await lin.conversation(shared.id)), { pinned: false, archived: false })
    assert.equal((await lin.conversation(shared.id)).visibility, 'project')
    return { deniedNonMember: true, deniedOtherPrivate: true, deniedCsrf: true, malformedBodies: 7 }
  })

  await check('归档不会停止执行或影响重放动作，内容更新与新分支偏好保持独立', async () => {
    const c = await lin.create({ visibility: 'project' })
    const body = {
      requestId: requestId(),
      text: '保留运行中的个人归档',
      attachmentIds: [],
      delivery: 'send',
      scenario: { kind: 'hold', stepDelayMs: 20 },
    }
    const sent = await lin.api('POST', `/conversations/${c.id}/messages`, body)
    const before = await until(async () => {
      const current = await lin.conversation(c.id)
      return (
        current.messages.some(
          (message) => message.role === 'assistant' && message.content.includes('资源快照'),
        ) && current
      )
    }, 'scenario reaches stable hold boundary')
    const updated = await patch(lin, c.id, { pinned: true, archived: true })
    assert.equal(updated.activeTurnId, sent.receipt.turnId)
    assert.equal(updated.status, before.status)
    assert.equal(updated.revision, before.revision)
    const replay = await lin.api('POST', `/conversations/${c.id}/messages`, body)
    assert.deepEqual(flags(replay.conversation), { pinned: true, archived: true })
    assert.equal(replay.receipt.turnId, sent.receipt.turnId)
    await lin.stop(c.id, sent.receipt.turnId)
    const done = await lin.finish(c.id)
    assert.deepEqual(flags(done), { pinned: true, archived: true })
    assert.equal(done.turns.length, 1)
    const fork = await lin.api('POST', `/conversations/${c.id}/branch`, {
      messageId: done.turns[0].inputMessageId,
      requestId: requestId(),
    })
    assert.deepEqual(flags(fork.conversation), { pinned: false, archived: false })
    assert.deepEqual(flags(await lin.conversation(c.id)), { pinned: true, archived: true })
    return { retainedTurnId: sent.receipt.turnId, sourceAndForkPreferencesIndependent: true }
  })

  await check('个人偏好重启后保留、恢复只影响本人，删除会话清理全部个人偏好', async () => {
    const c = await lin.create({ visibility: 'project' })
    await patch(lin, c.id, { pinned: true, archived: true })
    await patch(admin, c.id, { pinned: true })
    await stop()
    await boot()
    assert.deepEqual(flags(await lin.conversation(c.id)), { pinned: true, archived: true })
    assert.deepEqual(flags(await admin.conversation(c.id)), { pinned: true, archived: false })
    const snapshot = await lin.api('GET', '/bootstrap')
    assert.deepEqual(flags(snapshot.conversations.find((item) => item.id === c.id)), {
      pinned: true,
      archived: true,
    })
    assert.deepEqual(flags(await patch(lin, c.id, { archived: false })), {
      pinned: true,
      archived: false,
    })
    await patch(admin, c.id, { archived: true })
    assert.deepEqual(flags(await lin.conversation(c.id)), { pinned: true, archived: false })
    assert.deepEqual(flags(await admin.conversation(c.id)), { pinned: true, archived: true })
    assert.equal(
      inspectDb(
        (db) =>
          db.prepare('SELECT count(*) AS count FROM conversation_preferences WHERE cid=?').get(c.id)
            .count,
      ),
      2,
    )
    await lin.api('DELETE', `/conversations/${c.id}`)
    assert.equal(
      inspectDb(
        (db) =>
          db.prepare('SELECT count(*) AS count FROM conversation_preferences WHERE cid=?').get(c.id)
            .count,
      ),
      0,
    )
    assert.equal((await admin.raw('GET', `/conversations/${c.id}`)).status, 404)
    return { preservedAcrossRestart: true, deletedPreferenceRows: 2 }
  })
} catch (error) {
  report.error = error.stack
} finally {
  await stop()
  await rm(dataDir, { recursive: true, force: true })
  report.passed = !report.error && report.checks.every((check) => check.passed)
  report.completedAt = new Date().toISOString()
  const destination = await writeEvidence('conversation-preferences.json', report)
  console.log(JSON.stringify({ passed: report.passed, report: destination }))
  if (!report.passed) process.exitCode = 1
}
