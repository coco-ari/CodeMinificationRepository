import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, requestId, until, writeEvidence } from './agent-demo-helpers.mjs'

// Real HTTP, real main server, real SQLite and PDF.js; the Bridge is controlled
// by this test and never calls a model or the configured demonstration server.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = await mkdtemp(path.join(tmpdir(), 'autoops-session-files-'))
const token = randomUUID()
const runs = new Map()
const bridgeErrors = []
const report = {
  startedAt: new Date().toISOString(),
  mode: 'controlled-bridge',
  realModelCalls: 0,
  checks: [],
}
let child
let logs = ''
let origin
let db

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
function event(runId, payload) {
  const run = runs.get(runId)
  assert.ok(run?.stream, `Bridge event stream is connected for ${runId}`)
  run.stream.write(`data: ${JSON.stringify(payload)}\n\n`)
  if (['completed', 'interrupted', 'failed'].includes(payload.type)) run.stream.end()
}
const bridge = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    if (req.url === '/health')
      return json(res, 200, {
        liveAvailable: true,
        name: 'Controlled file-test Bridge',
        modelVerified: true,
        readiness: { status: 'ready' },
      })
    if (req.url === '/runs' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const input = JSON.parse(body)
      runs.set(input.runId, { input })
      return json(res, 201, { accepted: true, runId: input.runId })
    }
    const streamMatch = req.url.match(/^\/runs\/([^/]+)\/events$/)
    if (streamMatch) {
      const run = runs.get(streamMatch[1])
      assert.ok(run)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      run.stream = res
      event(streamMatch[1], {
        type: 'started',
        runnerThreadId: `thread-${streamMatch[1]}`,
        runnerTurnId: `turn-${streamMatch[1]}`,
      })
      return
    }
    const stopMatch = req.url.match(/^\/runs\/([^/]+)\/stop$/)
    if (stopMatch) {
      event(stopMatch[1], { type: 'interrupted' })
      return json(res, 200, { accepted: true, status: 'interrupted' })
    }
    json(res, 404, { error: 'Unknown controlled Bridge route' })
  } catch (error) {
    bridgeErrors.push(error.stack)
    if (!res.headersSent) json(res, 500, { error: error.message })
    else res.destroy(error)
  }
})

async function boot(port = 0) {
  child = spawn(process.execPath, [path.join(root, 'agent-demo/server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      AGENT_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`,
      AGENT_BRIDGE_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  logs = ''
  child.stdout.on('data', (chunk) => {
    logs = (logs + chunk).slice(-8000)
  })
  child.stderr.on('data', (chunk) => {
    logs = (logs + chunk).slice(-8000)
  })
  await until(
    () => {
      if (child.exitCode !== null) throw new Error(`Main service exited: ${logs}`)
      const match = logs.match(/Agent Demo listening (\{[^\n]+\}); data=/)
      if (match) origin = `http://127.0.0.1:${JSON.parse(match[1]).port}`
      return origin && match
    },
    '临时主服务监听',
    10_000,
  )
  await until(
    async () => (await (await fetch(`${origin}/api/agent-demo/health`)).json()).liveAvailable,
    '受控Bridge就绪',
  )
}
async function stopChild() {
  if (!child || child.exitCode !== null) return
  const current = child
  const exited = new Promise((resolve) => current.once('exit', resolve))
  current.kill('SIGTERM')
  const timer = setTimeout(() => current.kill('SIGKILL'), 3000)
  await exited
  clearTimeout(timer)
  child = null
}
async function check(name, fn) {
  const started = performance.now()
  const detail = await fn()
  report.checks.push({
    name,
    status: 'passed',
    elapsedMs: Math.round(performance.now() - started),
    detail,
  })
  console.log(`通过：${name}`)
}
async function upload(client, cid, name, mime, bytes) {
  return (
    await client.api('POST', `/conversations/${cid}/attachments`, {
      name,
      mime,
      data: bytes.toString('base64'),
    })
  ).attachment
}
async function start(client, cid, text, attachmentIds = []) {
  const sent = await client.send(cid, text, { scenario: undefined, attachmentIds })
  const runId = sent.conversation.activeTurnId
  await until(() => runs.get(runId)?.stream, '受控Bridge开始轮次')
  return { runId, input: runs.get(runId).input }
}
async function internalRead(runId, fileId, { auth = token, method = 'POST' } = {}) {
  const response = await fetch(
    `${origin}/api/agent-demo/internal/runs/${runId}/attachments/${fileId}/read`,
    { method, headers: { Authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(15000) },
  )
  return { status: response.status, body: await response.json() }
}
function cached(id) {
  return db.prepare('SELECT version,metadata,content FROM file_extractions WHERE id=?').get(id)
}

try {
  await new Promise((resolve, reject) => {
    bridge.once('error', reject)
    bridge.listen(0, '127.0.0.1', resolve)
  })
  await boot()
  db = new DatabaseSync(path.join(dataDir, 'demo.sqlite'))
  let client = await new Client('lin', origin).login()
  const chat = await client.create({ mode: 'live' })
  const foreign = await client.create({ mode: 'live' })
  const text = `第一行 FIRST-${requestId()}\n第二行 SECOND-${requestId()}`
  let txt, pdf, draft, future, foreignFile
  await check('TXT/PDF 上传提取以及扫描、损坏能力状态', async () => {
    txt = await client.upload(chat.id, 'context.txt', text)
    pdf = await upload(
      client,
      chat.id,
      'verification.pdf',
      'application/pdf',
      await readFile(new URL('./fixtures/agent-demo-pdf/text.pdf', import.meta.url)),
    )
    const scan = await upload(
      client,
      chat.id,
      'scan.pdf',
      'application/pdf',
      await readFile(new URL('./fixtures/agent-demo-pdf/scan.pdf', import.meta.url)),
    )
    const damaged = await upload(
      client,
      chat.id,
      'damaged.pdf',
      'application/pdf',
      Buffer.from('%PDF-1.7\nbroken\n%%EOF'),
    )
    assert.equal(txt.readable, true)
    assert.equal(pdf.readable, true)
    assert.equal(pdf.extraction.format, 'pdf-text')
    assert.equal(scan.readable, false)
    assert.equal(scan.extraction.code, 'PDF_NO_TEXT_LAYER')
    assert.equal(damaged.readable, false)
    assert.equal(damaged.extraction.code, 'PDF_INVALID')
    assert.equal(cached(txt.id).content, text)
    assert.match(cached(pdf.id).content, /Verification code: PDF-/)
    draft = await client.upload(chat.id, 'draft.txt', 'DRAFT_MUST_NOT_BE_READ')
    future = await client.upload(chat.id, 'future.txt', 'FUTURE_MUST_NOT_BE_READ_YET')
    foreignFile = await client.upload(foreign.id, 'foreign.txt', 'OTHER_CONVERSATION_SECRET')
    return {
      readable: ['txt', 'pdf'],
      unavailable: [scan.extraction.code, damaged.extraction.code],
    }
  })
  const foreignRun = await start(client, foreign.id, '发布外会话文件', [foreignFile.id])
  event(foreignRun.runId, { type: 'completed' })
  await client.finish(foreign.id)
  const first = await start(client, chat.id, '只查看当前文件第一行', [txt.id, pdf.id])
  await check('本轮文件按需读取，错误身份和未授权文件被拒绝', async () => {
    assert.deepEqual(first.input.attachments.map((file) => file.id).sort(), [txt.id, pdf.id].sort())
    assert.equal(first.input.sessionAttachments.length, 0)
    assert.ok(first.input.attachments.every((file) => file.reference && file.content === undefined))
    const textRead = await internalRead(first.runId, txt.id)
    assert.equal(textRead.status, 200)
    assert.equal(textRead.body.file.content, text)
    const pdfRead = await internalRead(first.runId, pdf.id)
    assert.equal(pdfRead.status, 200)
    assert.match(pdfRead.body.file.content, /AutoOps live attachment probe/)
    assert.equal((await internalRead(first.runId, txt.id, { auth: 'wrong' })).status, 401)
    assert.equal((await internalRead(first.runId, txt.id, { method: 'GET' })).status, 405)
    for (const file of [draft, future, foreignFile])
      assert.equal((await internalRead(first.runId, file.id)).status, 404)
  })
  await check('发布到未来队列的文件仍不进入当前轮次权限', async () => {
    await client.send(chat.id, '稍后读取未来附件', {
      scenario: undefined,
      delivery: 'queue',
      attachmentIds: [future.id],
    })
    assert.equal(db.prepare('SELECT published FROM files WHERE id=?').get(future.id).published, 1)
    assert.equal((await internalRead(first.runId, future.id)).status, 404)
    event(first.runId, {
      type: 'artifact',
      name: 'report.md',
      content: '历史产物内容 ARTIFACT-REFERENCE',
      mime: 'text/markdown',
    })
    await until(
      async () => (await client.conversation(chat.id)).artifacts.length === 1,
      '历史产物保存',
    )
    await client.stop(chat.id, first.runId)
    await client.finish(chat.id)
    assert.equal((await internalRead(first.runId, txt.id)).status, 404)
  })
  const second = await start(client, chat.id, '不重附文件，读取上一轮文件第二行')
  await check('下一轮可重读旧TXT第二行、PDF及历史产物，未来队列仍排除', async () => {
    assert.deepEqual(second.input.attachments, [])
    const artifact = (await client.conversation(chat.id)).artifacts[0]
    assert.deepEqual(
      second.input.sessionAttachments.map((file) => file.id).sort(),
      [txt.id, pdf.id, artifact.id].sort(),
    )
    const textRead = await internalRead(second.runId, txt.id)
    assert.equal(textRead.status, 200)
    assert.equal(textRead.body.file.content.split('\n')[1], text.split('\n')[1])
    assert.equal((await internalRead(second.runId, pdf.id)).status, 200)
    const artifactRead = await internalRead(second.runId, artifact.id)
    assert.equal(artifactRead.status, 200)
    assert.equal(artifactRead.body.file.content, '历史产物内容 ARTIFACT-REFERENCE')
    for (const file of [future, draft, foreignFile])
      assert.equal((await internalRead(second.runId, file.id)).status, 404)
    event(second.runId, { type: 'completed' })
    await client.finish(chat.id)
    assert.equal((await internalRead(second.runId, txt.id)).status, 404)
  })
  await check('主服务重启后提取缓存与旧附件权限保持可用', async () => {
    const before = [cached(txt.id), cached(pdf.id)]
    await stopChild()
    const port = Number(new URL(origin).port)
    origin = null
    await boot(port)
    client = await new Client('lin', origin).login()
    assert.deepEqual([cached(txt.id), cached(pdf.id)], before)
    const third = await start(client, chat.id, '重启后再次读取历史PDF与TXT')
    assert.equal((await internalRead(third.runId, txt.id)).body.file.content, text)
    assert.match(
      (await internalRead(third.runId, pdf.id)).body.file.content,
      /Verification code: PDF-/,
    )
    assert.deepEqual([cached(txt.id), cached(pdf.id)], before)
    event(third.runId, { type: 'completed' })
    await client.finish(chat.id)
  })
  await check('删除会话清理文件与提取缓存，不残留读取入口', async () => {
    const ids = db
      .prepare('SELECT id FROM files WHERE cid=?')
      .all(chat.id)
      .map((row) => row.id)
    await client.api('DELETE', `/conversations/${chat.id}`)
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM files WHERE cid=?').get(chat.id).count,
      0,
    )
    for (const id of ids) assert.equal(cached(id), undefined)
    assert.equal((await internalRead(second.runId, txt.id)).status, 404)
    await client.api('DELETE', `/conversations/${foreign.id}`)
    assert.equal(db.prepare('SELECT count(*) AS count FROM file_extractions').get().count, 0)
    assert.deepEqual(bridgeErrors, [])
  })
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack
  report.logs = logs
  throw error
} finally {
  await stopChild()
  for (const run of runs.values()) run.stream?.destroy()
  bridge.closeAllConnections()
  await new Promise((resolve) => bridge.close(resolve))
  db?.close()
  await rm(dataDir, { recursive: true, force: true })
  report.completedAt = new Date().toISOString()
  report.controlledRuns = runs.size
  await writeEvidence('session-files.json', report)
}
