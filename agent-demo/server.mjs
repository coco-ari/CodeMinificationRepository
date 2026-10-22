import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { users, projects, agents, contextFor } from './fixtures.mjs'
import { extractAttachment } from './attachments.mjs'
import { waitForOpenCodeHealth as waitForRuntimeHealth } from './vendor/openchamber/health-wait.mjs'
import { createT3Gateway } from './t3-adapters/gateway.mjs'
import { resolveProductProfile } from './t3-adapters/product-profile.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const BUILD_HASH = createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(readFileSync(join(ROOT, 'fixtures.mjs')))
  .update(readFileSync(join(ROOT, 'attachments.mjs')))
  .update(readFileSync(join(ROOT, 'attachment-pdf-worker.mjs')))
  .update(readFileSync(join(ROOT, 'vendor/openchamber/health-wait.mjs')))
  .digest('hex')
const DATA = resolve(process.env.DATA_DIR || join(ROOT, 'data'))
const t3Mode = process.env.AGENT_DEMO_ENGINE === 't3'
if (t3Mode) resolveProductProfile(process.env)
const t3Gateway = t3Mode ? createT3Gateway(process.env.AUTOOPS_T3_INTERNAL_URL || 'http://127.0.0.1:8788') : null
mkdirSync(DATA, { recursive: true, mode: 0o700 })
const db = new DatabaseSync(join(DATA, 'demo.sqlite'))
let legacyT3Map
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_conversation_time ON events(cid, json_extract(body, '$.at'), seq);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS drafts(key TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, cid TEXT NOT NULL, owner TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS file_extractions(id TEXT PRIMARY KEY, version TEXT NOT NULL, metadata TEXT NOT NULL, content TEXT);
CREATE TABLE IF NOT EXISTS conversation_preferences(uid TEXT NOT NULL, cid TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(uid,cid));
`)
const convs = new Map(
  db
    .prepare('SELECT * FROM conversations')
    .all()
    .map((r) => [r.id, JSON.parse(r.body)]),
)
const connections = new Set(),
  running = new Map(),
  loginAttempts = new Map(),
  deletingConversations = new Set()
const bridge = process.env.AGENT_BRIDGE_URL || ''
const bridgeToken = process.env.AGENT_BRIDGE_TOKEN || ''
let runtime = {
  liveAvailable: false,
  name: bridge ? 'Codex 连接桥' : '未连接真实运行器',
  reason: bridge ? '正在检查连接' : '请连接真实运行器；可先体验标记明确的交互测试场景',
}
const now = () => new Date().toISOString(),
  uid = () => randomUUID(),
  clone = (x) => structuredClone(x)
const fail = (status, code, error) => {
  throw Object.assign(new Error(error), { status, code })
}
const visible = (u, c) =>
  projects.find((p) => p.id === c.projectId)?.memberIds.includes(u.id) &&
  (c.visibility === 'project' || c.ownerId === u.id)
const requireConv = (u, id) => {
  const c = convs.get(id)
  if (!c || !visible(u, c)) fail(404, 'NOT_FOUND', '会话不存在或无权访问')
  return c
}
const save = (c) =>
  db.prepare('INSERT OR REPLACE INTO conversations VALUES(?,?)').run(c.id, JSON.stringify(c))
function conversationPreferences(u, c) {
  const row = db
    .prepare('SELECT pinned,archived FROM conversation_preferences WHERE uid=? AND cid=?')
    .get(u.id, c.id)
  return { pinned: Boolean(row?.pinned), archived: Boolean(row?.archived) }
}
function publicConversation(u, c) {
  // Preferences belong to the viewer, including when an old SSE snapshot or an
  // idempotent action response is replayed. Never persist them in shared history.
  return { ...c, ...conversationPreferences(u, c) }
}
function eventFrame(client, event) {
  if (event.conversationId) {
    const c =
      convs.get(event.conversationId) || (event.type === 'conversation.deleted' ? event._acl : null)
    if (!c || !visible(client.user, c)) return null
  }
  const { _acl, ...publicEvent } = event
  if (event.payload?.conversation)
    publicEvent.payload = {
      ...event.payload,
      conversation: publicConversation(client.user, event.payload.conversation),
    }
  return `id: ${event.seq}\ndata: ${JSON.stringify(publicEvent)}\n\n`
}
function sendEvent(client) {
  void pumpEvents(client).catch(() => {
    connections.delete(client)
    client.res.destroy()
  })
}
async function pumpEvents(client) {
  if (client.pumping || client.res.destroyed || client.res.writableEnded) return
  client.pumping = true
  const { res } = client
  try {
    while (!res.destroyed && !res.writableEnded) {
      const rows = db
        .prepare('SELECT seq,body FROM events WHERE seq>? ORDER BY seq LIMIT 32')
        .all(client.cursor)
      if (!rows.length) break
      for (const row of rows) {
        if (res.destroyed || res.writableEnded) return
        const frame = eventFrame(client, JSON.parse(row.body))
        client.cursor = Number(row.seq)
        if (frame && !res.write(frame) && !(await waitForDrain(res))) return
      }
    }
    if (!client.readySent && !res.destroyed && !res.writableEnded) {
      client.readySent = true
      res.write(`data: ${JSON.stringify({ type: 'ready', payload: {}, at: now() })}\n\n`)
    }
  } finally {
    client.pumping = false
  }
}
function waitForDrain(res) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false)
  // 某些 HTTP/socket flush 时序下 write(false) 的 drain 已经完成；先核对当前状态。
  if (!res.writableNeedDrain) return Promise.resolve(true)
  const trace = (event) => {
    if (process.env.DEMO_TRACE_STREAMS === '1')
      console.log(
        JSON.stringify({
          event,
          at: now(),
          needDrain: res.writableNeedDrain,
          length: res.writableLength,
          socketLength: res.socket?.writableLength,
          destroyed: res.destroyed,
        }),
      )
  }
  trace('sse.waitDrain')
  return new Promise((resolve) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      clearInterval(check)
      res.off('drain', drained)
      res.off('close', closed)
      res.off('error', closed)
    }
    const done = (ok, event) => {
      if (settled) return
      settled = true
      trace(event)
      cleanup()
      resolve(ok)
    }
    const drained = () => done(true, 'sse.drained'),
      closed = () => done(false, 'sse.closed')
    const check = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        closed()
        return
      }
      // 已经没有任何待写字节时不再等待一个可能已发出的 drain。
      if (!res.writableNeedDrain || (res.writableLength === 0 && res.socket?.writableLength === 0))
        done(true, 'sse.emptyBuffer')
    }, 25)
    const timer = setTimeout(() => {
      trace('sse.drainTimeout')
      res.destroy()
      closed()
    }, 30000)
    res.once('drain', drained)
    res.once('close', closed)
    res.once('error', closed)
    if (!res.writableNeedDrain) drained()
  })
}
function emit(type, c, payload = {}, turnId) {
  return transaction(() => {
    const event = { type, conversationId: c?.id, turnId, payload, at: now() }
    if (type === 'conversation.deleted')
      event._acl = { projectId: c.projectId, ownerId: c.ownerId, visibility: c.visibility }
    // 先在同一事务内分配序号，再编码最终事件，避免长会话快照重复写入及深拷贝。
    const row = db.prepare('INSERT INTO events(cid,body) VALUES(?,?)').run(c?.id || null, '{}')
    event.seq = Number(row.lastInsertRowid)
    if (c) {
      c.eventSeq = event.seq
      if (payload.conversation) payload.conversation = c
    }
    db.prepare('UPDATE events SET body=? WHERE seq=?').run(JSON.stringify(event), event.seq)
    for (const client of connections) queueMicrotask(() => sendEvent(client))
    return event.seq
  })
}
function transaction(fn) {
  const own = !db.isTransaction
  if (own) db.exec('BEGIN')
  try {
    const out = fn()
    if (own) db.exec('COMMIT')
    return out
  } catch (e) {
    if (own) db.exec('ROLLBACK')
    throw e
  }
}
function changed(c) {
  c.revision++
  c.updatedAt = now()
  transaction(() => {
    emit('conversation.updated', c, { conversation: c }, c.activeTurnId)
    save(c)
  })
}
function activity(t, phase) {
  t.lastActivityAt = now()
  t.phase = phase
}
function timelineTool(t, step) {
  if (!t.timeline.some((entry) => entry.type === 'tool' && entry.stepId === step.id))
    t.timeline.push({
      id: uid(),
      type: 'tool',
      stepId: step.id,
      createdAt: step.startedAt || now(),
    })
  activity(
    t,
    t.question?.status === 'pending'
      ? 'waiting_user'
      : t.steps.some((item) => item.status === 'running')
        ? 'tool'
        : 'awaiting_model',
  )
}
function timelineQuestion(t, question) {
  const existing = t.timeline.find(
    (entry) => entry.type === 'question' && entry.question.id === question.id,
  )
  if (existing) existing.question = question
  else t.timeline.push({ id: uid(), type: 'question', question, createdAt: now() })
  activity(t, question.status === 'pending' ? 'waiting_user' : 'awaiting_model')
}
function timelineUser(c, t, message) {
  c.messages.push(message)
  t.timeline.push({ id: uid(), type: 'user', messageId: message.id, createdAt: message.createdAt })
  activity(t, t.question?.status === 'pending' ? 'waiting_user' : 'awaiting_model')
}
function streamPart(
  c,
  t,
  text,
  { itemId = null, type = 'text', mode = 'append', kind, status, messagePhase } = {},
) {
  if (
    typeof text !== 'string' ||
    (!text && mode !== 'replace' && status !== 'completed') ||
    !['running', 'waiting'].includes(t.status) ||
    c.activeTurnId !== t.id ||
    c.status === 'stopping'
  )
    return
  const m = c.messages.find((m) => m.id === t.assistantMessageId)
  if (type === 'text') m.content += text
  let entry =
    type === 'reasoning'
      ? t.timeline.find((part) => part.type === type && part.itemId === itemId)
      : t.timeline.at(-1)
  if (entry?.type !== type || entry.itemId !== itemId) {
    entry = { id: uid(), type, text: '', itemId, createdAt: now() }
    t.timeline.push(entry)
  }
  const offset = entry.text.length
  entry.text = mode === 'replace' ? text : entry.text + text
  if (kind) entry.kind = kind
  if (status) entry.status = status
  if (type === 'text' && ['commentary', 'final_answer'].includes(messagePhase))
    entry.messagePhase = messagePhase
  entry.updatedAt = now()
  activity(
    t,
    t.question?.status === 'pending'
      ? 'waiting_user'
      : type === 'reasoning'
        ? 'thinking'
        : 'responding',
  )
  c.revision++
  c.updatedAt = now()
  transaction(() => {
    emit(
      type === 'reasoning' ? 'reasoning.delta' : 'message.delta',
      c,
      {
        messageId: m.id,
        delta: text,
        revision: c.revision,
        timelineDelta: {
          id: entry.id,
          type,
          itemId,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          offset: mode === 'replace' ? 0 : offset,
          delta: text,
          mode,
          ...(kind ? { kind } : {}),
          ...(status ? { status } : {}),
          ...(entry.messagePhase ? { messagePhase: entry.messagePhase } : {}),
        },
        lastActivityAt: t.lastActivityAt,
        phase: t.phase,
      },
      t.id,
    )
    save(c)
  })
}
function delta(c, t, text, itemId = null, messagePhase) {
  const phase = ['commentary', 'final_answer'].includes(messagePhase) ? messagePhase : null
  // A late item/completed classification updates the existing item, including
  // fragments split by tools or user steering. Never synthesize a final answer.
  if (phase && itemId) {
    let updated = false
    for (const part of t.timeline) {
      if (part.type === 'text' && part.itemId === itemId && part.messagePhase !== phase) {
        part.messagePhase = phase
        updated = true
      }
    }
    if (updated) changed(c)
  }
  streamPart(c, t, text, { itemId, messagePhase: phase })
}
const usageFields = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'reasoningOutputTokens',
  'modelContextWindow',
]
function usageSnapshot(value) {
  return Object.fromEntries(
    usageFields.map((key) => [
      key,
      typeof value?.[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0
        ? value[key]
        : null,
    ]),
  )
}
function updateUsage(c, t, e) {
  t.usage = {
    ...usageSnapshot(e),
    scope: e.scope === 'turn' ? 'turn' : 'thread',
    last: usageSnapshot(e.last),
    updatedAt: now(),
  }
  if (e.threadTotal) t.usage.threadTotal = usageSnapshot(e.threadTotal)
  c.revision++
  c.updatedAt = now()
  transaction(() => {
    emit('turn.usage.updated', c, { usage: t.usage, revision: c.revision }, t.id)
    save(c)
  })
}
for (const c of t3Mode ? [] : convs.values()) {
  if (c.activeTurnId) {
    const t = c.turns.find((t) => t.id === c.activeTurnId)
    if (t) {
      t.status = 'interrupted'
      t.completedAt = now()
      activity(t, 'interrupted')
      if (t.question?.status === 'pending') {
        t.question.status = 'cancelled'
        if (t.timeline) timelineQuestion(t, t.question)
        t.phase = 'interrupted'
      }
      t.error = '服务已重启，保留已接收内容；可继续此轮。'
      for (const s of t.steps) if (s.status === 'running') s.status = 'failed'
      for (const entry of t.timeline || [])
        if (entry.type === 'reasoning' && entry.status !== 'completed') entry.status = 'interrupted'
      const m = c.messages.find((m) => m.id === t.assistantMessageId)
      if (m) m.status = 'interrupted'
    }
    c.activeTurnId = null
    c.status = 'interrupted'
    c.queuePaused = true
    changed(c)
  }
}
function json(res, status, body, headers = {}) {
  if (res.demoUser && (body.conversation || body.conversations))
    body = {
      ...body,
      ...(body.conversation
        ? { conversation: publicConversation(res.demoUser, body.conversation) }
        : {}),
      ...(body.conversations
        ? { conversations: body.conversations.map((c) => publicConversation(res.demoUser, c)) }
        : {}),
    }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(body))
}
async function body(req) {
  if (!req.demoBody) req.demoBody = readBody(req)
  return req.demoBody
}
async function readBody(req) {
  let size = 0,
    chunks = []
  for await (const b of req) {
    size += b.length
    if (size > 12 * 1024 * 1024) fail(413, 'TOO_LARGE', '请求超过限制')
    chunks.push(b)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}')
  } catch {
    fail(400, 'BAD_JSON', '请求格式无效')
  }
}
function auth(req) {
  const token = (req.headers.cookie || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('demo_session='))
    ?.slice(13)
  const row =
    token &&
    db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(hash(token), Date.now())
  if (!row) fail(401, 'UNAUTHENTICATED', '请先登录')
  return { ...row, user: users.find((u) => u.id === row.uid) }
}
const hash = (s) => createHash('sha256').update(s).digest('hex')
function csrf(req, s) {
  if (req.headers['x-demo-csrf'] !== s.csrf) fail(403, 'CSRF', '会话校验失败，请刷新后重试')
}
function validText(s, max = 32000) {
  if (typeof s !== 'string' || !s.trim() || s.length > max)
    fail(400, 'INVALID_TEXT', '请输入有效内容')
  return s.trim()
}
function fileMeta(row) {
  const cached = db
    .prepare('SELECT metadata FROM file_extractions WHERE id=? AND version=?')
    .get(row.id, EXTRACTION_VERSION)
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.data.byteLength,
    url: `/api/agent-demo/files/${row.id}`,
    ...(cached ? JSON.parse(cached.metadata) : {}),
  }
}
const EXTRACTION_VERSION = 'pdfjs-6.4.299:1'
const pendingExtractions = new Map()
function storeExtraction(id, result) {
  const metadata = { readable: result.readable, extraction: result.extraction }
  db.prepare('INSERT OR REPLACE INTO file_extractions VALUES(?,?,?,?)').run(
    id,
    EXTRACTION_VERSION,
    JSON.stringify(metadata),
    typeof result.content === 'string' ? result.content : null,
  )
}
async function extractedFile(row, includeImage = false) {
  const cached = db
    .prepare('SELECT metadata,content FROM file_extractions WHERE id=? AND version=?')
    .get(row.id, EXTRACTION_VERSION)
  let result
  if (cached)
    result = {
      ...fileMeta(row),
      ...JSON.parse(cached.metadata),
      ...(cached.content !== null ? { content: cached.content } : {}),
    }
  else {
    let pending = pendingExtractions.get(row.id)
    if (!pending) {
      pending = extractAttachment({ ...row, bytes: Buffer.from(row.data) })
        .then((value) => {
          // A deleted conversation/file cannot be resurrected by a late parser.
          if (db.prepare('SELECT 1 FROM files WHERE id=?').get(row.id))
            storeExtraction(row.id, value)
          return value
        })
        .finally(() => pendingExtractions.delete(row.id))
      pendingExtractions.set(row.id, pending)
    }
    result = await pending
  }
  const { data, ...file } = result
  return includeImage && file.extraction?.format === 'image'
    ? { ...file, data: data || Buffer.from(row.data).toString('base64') }
    : file
}
// Hermes retains session file references; OpenChamber delegates reads to the
// runtime. Here IDs replace filesystem paths, and every tool read rechecks the
// owning conversation and the exact turn boundary. Queued/future files stay out.
function runFileIds(c, t) {
  const boundary = c.turns.findIndex((turn) => turn.id === (t.retryOfTurnId || t.id))
  const earlier = new Set(c.turns.slice(0, Math.max(0, boundary)).map((turn) => turn.id))
  const ids = new Set(
    c.messages
      .filter((m) => earlier.has(m.turnId))
      .flatMap((m) => (m.attachments || []).map((f) => f.id)),
  )
  for (const file of c.artifacts || []) if (earlier.has(file.turnId)) ids.add(file.id)
  for (const file of c.messages.find((m) => m.id === t.inputMessageId)?.attachments || [])
    ids.add(file.id)
  return ids
}
function authorizedRunFile(r, id) {
  if (!runFileIds(r.c, r.t).has(id))
    fail(404, 'ATTACHMENT_FORBIDDEN', '附件不属于当前会话或可见历史')
  const row = db.prepare('SELECT * FROM files WHERE id=?').get(id)
  if (!row || row.cid !== r.c.id || !row.published)
    fail(404, 'ATTACHMENT_FORBIDDEN', '附件不存在或无权访问')
  return row
}
function attachments(c, u, ids = []) {
  if (!Array.isArray(ids) || ids.length > 8) fail(400, 'INVALID_ATTACHMENTS', '每条消息最多8个附件')
  return ids.map((id) => {
    const row = db.prepare('SELECT * FROM files WHERE id=?').get(id)
    if (!row || row.cid !== c.id || (!row.published && row.owner !== u.id))
      fail(404, 'NOT_FOUND', '附件不存在或无权访问')
    return fileMeta(row)
  })
}
function publish(files) {
  for (const f of files) db.prepare('UPDATE files SET published=1 WHERE id=?').run(f.id)
}
function revision(c, b) {
  if (
    b.expectedRevision !== undefined &&
    (b.expectedRevision < (c.queueRevision || 0) || b.expectedRevision > c.revision)
  )
    fail(409, 'REVISION_CONFLICT', '队列已更新，请查看最新状态后重试')
}
function once(u, c, op, b, fn) {
  if (typeof b.requestId !== 'string' || b.requestId.length < 4 || b.requestId.length > 128)
    fail(400, 'REQUEST_ID_REQUIRED', '缺少有效请求标识')
  const key = `${u.id}/${c.id}/${op}/${b.requestId}`,
    fingerprint = hash(JSON.stringify(b))
  const old = db.prepare('SELECT * FROM requests WHERE key=?').get(key)
  if (old) {
    if (old.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', '请求标识已用于不同内容')
    return JSON.parse(old.body)
  }
  return transaction(() => {
    const out = fn()
    db.prepare('INSERT INTO requests VALUES(?,?,?)').run(key, fingerprint, JSON.stringify(out))
    return out
  })
}
function active(c, expected) {
  const t = c.turns.find((t) => t.id === c.activeTurnId)
  if (
    !t ||
    !['running', 'waiting'].includes(t.status) ||
    t.id !== expected ||
    c.status === 'stopping'
  )
    fail(409, 'TURN_CHANGED', '当前轮次已变化，输入已保留，请选择发送或排队')
  return t
}
function scenario(b) {
  if (!b.scenario) return { kind: 'normal', stepDelayMs: 450 }
  if (!['normal', 'hold', 'clarify', 'fail'].includes(b.scenario.kind))
    fail(400, 'INVALID_SCENARIO', '未知测试场景')
  return {
    kind: b.scenario.kind,
    stepDelayMs: Math.max(10, Math.min(3000, Number(b.scenario.stepDelayMs) || 450)),
  }
}
function queueChanged(c) {
  c.queueRevision = c.revision + 1
  changed(c)
}
function requireIdle(c, b) {
  if (
    c.activeTurnId ||
    c.status === 'stopping' ||
    c.turns.some(
      (t) =>
        t.question?.status === 'pending' &&
        !['completed', 'failed', 'interrupted'].includes(t.status),
    )
  )
    fail(409, 'BUSY', '请先等待当前执行或补充问题结束')
  if (b.expectedRevision !== undefined && b.expectedRevision !== c.revision)
    fail(409, 'REVISION_CONFLICT', '会话已更新，请查看最新内容后重试')
}
function transcript(c, beforeTurnId) {
  const out = []
  const messages = new Map(c.messages.map((m) => [m.id, m]))
  for (const turn of c.turns) {
    if (turn.id === beforeTurnId) break
    const prompt = messages.get(turn.inputMessageId)
    if (prompt) out.push({ role: 'user', content: prompt.content })
    if (!Array.isArray(turn.timeline)) {
      for (const message of c.messages.filter(
        (m) => m.turnId === turn.id && m.id !== turn.inputMessageId,
      ))
        out.push({ role: message.role, content: message.content })
      continue
    }
    let content = ''
    const flush = () => {
      if (content) out.push({ role: 'assistant', content })
      content = ''
    }
    for (const entry of turn.timeline) {
      if (entry.type === 'text') content += entry.text
      if (entry.type === 'question') content += `${content ? '\n\n' : ''}${entry.question.prompt}`
      if (entry.type === 'user') {
        flush()
        const message = messages.get(entry.messageId)
        if (message) out.push({ role: 'user', content: message.content })
      }
    }
    flush()
  }
  return out
}

// Adapted from OpenChamber session-actions.ts forkAfterMessage/forkFromMessage
// (6491f51dbcf05d1e3f7f823049f5f097c96c234b, MIT): keep an assistant turn,
// cut before a user boundary, and restore that user's text/files into the fork's
// own draft. AutoOps copies its database files and never truncates the source.
function branchBoundarySnapshot(c, target, targetTurn) {
  // Tool/reasoning records are mutable during a run. The final turn snapshot
  // cannot reconstruct an earlier user boundary by slicing its timeline alone.
  // accepted steer/answer is persisted before deferred runner events are released.
  // Events are retained across restarts; the indexed conversation/time range
  // limits this lookup to snapshots between that input and the end of its turn.
  const rows = db
    .prepare(
      `
    SELECT body FROM events
    WHERE cid=? AND json_extract(body, '$.at') >= ? AND json_extract(body, '$.at') <= ?
      AND seq <= ? AND json_extract(body, '$.type')='conversation.updated'
      AND json_extract(body, '$.payload.conversation.activeTurnId')=?
    ORDER BY seq
  `,
    )
    .iterate(
      c.id,
      target.createdAt,
      targetTurn.completedAt || c.updatedAt,
      c.eventSeq,
      targetTurn.id,
    )
  for (const row of rows) {
    const snapshot = JSON.parse(row.body).payload?.conversation
    const turn = snapshot?.turns.find((item) => item.id === targetTurn.id)
    const boundary = turn?.timeline?.at(-1)
    if (
      ['running', 'waiting'].includes(turn?.status) &&
      boundary?.type === 'user' &&
      boundary.messageId === target.id
    )
      return { snapshot, turn }
  }
  fail(
    409,
    'BRANCH_BOUNDARY_UNAVAILABLE',
    '该历史消息缺少可恢复的执行边界，请从普通用户消息或已结束的助手回复创建分支',
  )
}

function branchConversation(c, u, b) {
  requireIdle(c, b)
  const target = c.messages.find((message) => message.id === b.messageId)
  if (!target) fail(404, 'NOT_FOUND', '分支起点不存在')
  const index = c.turns.findIndex((turn) => turn.id === target.turnId)
  if (index < 0) fail(409, 'INVALID_BRANCH', '无法从此消息创建分支')
  const editing = Object.hasOwn(b, 'text')
  if (editing && target.role !== 'user') fail(400, 'INVALID_EDIT', '只能编辑用户消息')
  const editedText = editing
    ? validText(
        typeof b.text === 'string' && !b.text.trim() && target.attachments?.length
          ? '请分析所附文件。'
          : b.text,
      )
    : undefined
  if (editing && c.mode === 'live' && !runtime.liveAvailable)
    fail(503, 'RUNTIME_UNAVAILABLE', runtime.reason)
  const targetTurn = c.turns[index]
  let artifactSource = c.artifacts
  let turns = clone(c.turns.slice(0, index))
  let retainedIds = new Set(
    c.messages.filter((m) => turns.some((t) => t.id === m.turnId)).map((m) => m.id),
  )
  if (target.role === 'assistant') {
    turns.push(clone(targetTurn))
    for (const m of c.messages.filter((m) => m.turnId === targetTurn.id)) retainedIds.add(m.id)
  } else if (target.id !== targetTurn.inputMessageId) {
    const { snapshot, turn: boundaryTurn } = branchBoundarySnapshot(c, target, targetTurn)
    const boundary = boundaryTurn.timeline?.findIndex(
      (entry) => entry.type === 'user' && entry.messageId === target.id,
    )
    if (boundary === undefined || boundary < 0)
      fail(409, 'INVALID_BRANCH', '该历史消息没有可恢复的执行边界')
    const partial = clone(boundaryTurn)
    artifactSource = snapshot.artifacts
    partial.timeline = partial.timeline.slice(0, boundary)
    const stepIds = new Set(
      partial.timeline.filter((entry) => entry.type === 'tool').map((entry) => entry.stepId),
    )
    partial.steps = partial.steps.filter((step) => stepIds.has(step.id))
    for (const step of partial.steps)
      if (['running', 'pending', 'started'].includes(step.status)) {
        step.status = 'cancelled'
        step.completedAt = target.createdAt
      }
    partial.question =
      partial.timeline.findLast((entry) => entry.type === 'question')?.question || null
    if (target.kind === 'answer' && partial.question) {
      partial.question.status = 'cancelled'
      delete partial.question.answer
      delete partial.question.answeredAt
    }
    for (const entry of partial.timeline) {
      if (entry.type === 'question' && entry.question.status === 'pending')
        entry.question.status = 'cancelled'
      if (entry.type === 'reasoning' && entry.status === 'running') entry.status = 'interrupted'
    }
    partial.status = 'interrupted'
    partial.phase = 'interrupted'
    partial.completedAt = target.createdAt
    partial.lastActivityAt = target.createdAt
    partial.branchedAtMessageId = target.id
    delete partial.error
    delete partial.usage
    // The accepted steer is the last guidance in its boundary snapshot. Slice
    // by order, not millisecond timestamps that can coincide with earlier input.
    if (target.kind === 'steer') partial.guidance = partial.guidance.slice(0, -1)
    turns.push(partial)
    retainedIds.add(partial.inputMessageId)
    retainedIds.add(partial.assistantMessageId)
    for (const entry of partial.timeline)
      if (entry.type === 'user') retainedIds.add(entry.messageId)
  }
  let messages = clone(c.messages.filter((m) => retainedIds.has(m.id)))
  const partial = turns.find((turn) => turn.branchedAtMessageId === target.id)
  if (partial) {
    const assistant = messages.find((m) => m.id === partial.assistantMessageId)
    if (assistant) {
      assistant.content = partial.timeline
        .filter((entry) => entry.type === 'text')
        .map((entry) => entry.text)
        .join('')
      assistant.status = 'interrupted'
    }
  }
  const keptTurnIds = new Set(turns.map((turn) => turn.id))
  let artifacts = clone(artifactSource.filter((file) => keptTurnIds.has(file.turnId)))
  const draftFiles = target.role === 'user' ? clone(target.attachments || []) : []
  const referenced = new Set([
    ...messages.flatMap((m) => (m.attachments || []).map((file) => file.id)),
    ...artifacts.map((file) => file.id),
    ...draftFiles.map((file) => file.id),
  ])
  // Also preserve published files linked in prose/tool results, even if the UI
  // did not list that link as a message attachment.
  for (const match of JSON.stringify({ messages, turns, artifacts }).matchAll(
    /\/api\/agent-demo\/files\/([a-f0-9-]{36})/g,
  )) {
    const file = db.prepare('SELECT cid,published,owner FROM files WHERE id=?').get(match[1])
    if (file?.cid === c.id && (file.published || file.owner === u.id)) referenced.add(match[1])
  }
  const newId = uid()
  const files = [...referenced].map((id) => {
    const file = db.prepare('SELECT * FROM files WHERE id=?').get(id)
    if (!file || file.cid !== c.id || (!file.published && file.owner !== u.id))
      fail(404, 'NOT_FOUND', '分支附件不存在或无权访问')
    return { ...file, newId: uid() }
  })
  const fileIds = new Map(files.map((file) => [file.id, file.newId]))
  const rewriteFiles = (value) => {
    if (typeof value === 'string') {
      if (fileIds.has(value)) return fileIds.get(value)
      for (const [oldId, id] of fileIds)
        value = value.replaceAll(`/api/agent-demo/files/${oldId}`, `/api/agent-demo/files/${id}`)
      return value
    }
    if (Array.isArray(value)) return value.map(rewriteFiles)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, rewriteFiles(item)]),
      )
    return value
  }
  const restoredFiles = rewriteFiles(draftFiles)
  messages = rewriteFiles(messages)
  turns = rewriteFiles(turns)
  artifacts = rewriteFiles(artifacts)
  const fork = {
    id: newId,
    title: `${c.title.slice(0, 90)} · 分支`,
    projectId: c.projectId,
    agentId: c.agentId,
    environmentId: c.environmentId,
    visibility: 'private',
    ownerId: u.id,
    mode: c.mode,
    createdAt: now(),
    updatedAt: now(),
    revision: 0,
    eventSeq: 0,
    status: 'idle',
    activeTurnId: null,
    queuePaused: true,
    messages,
    turns,
    queue: [],
    artifacts,
    branchedFrom: { conversationId: c.id, messageId: target.id },
  }
  for (const file of files) {
    const data = /^(text\/|application\/(json|xml))/.test(file.mime)
      ? Buffer.from(rewriteFiles(Buffer.from(file.data).toString('utf8')))
      : file.data
    db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?)').run(
      file.newId,
      newId,
      u.id,
      1,
      file.name,
      file.mime,
      data,
    )
  }
  convs.set(fork.id, fork)
  changed(fork)
  if (target.role === 'user' && !editing) {
    const draft = {
      text: target.content,
      attachmentIds: restoredFiles.map((file) => file.id),
      revision: 1,
    }
    db.prepare('INSERT INTO drafts VALUES(?,?)').run(`${u.id}/${fork.id}`, JSON.stringify(draft))
  }
  if (editing)
    start(fork, {
      text: editedText,
      attachments: restoredFiles,
      actorName: u.name,
      requestId: b.requestId,
      scenario: { kind: 'normal', stepDelayMs: targetTurn.scenario?.stepDelayMs || 450 },
    })
  return {
    conversation: clone(fork),
    receipt: { status: editing ? 'accepted' : 'branched', sourceConversationId: c.id },
  }
}
function start(c, input) {
  if (deletingConversations.has(c.id)) fail(409, 'BUSY', '会话正在删除')
  if (c.activeTurnId) fail(409, 'BUSY', '会话已有运行中的任务，请选择引导或排队')
  if (input.retryOfTurnId) c.runtimeContextRevision = (c.runtimeContextRevision || 0) + 1
  const t = {
    id: uid(),
    status: 'running',
    inputMessageId: uid(),
    assistantMessageId: uid(),
    startedAt: now(),
    lastActivityAt: now(),
    phase: 'accepted',
    timeline: [],
    steps: [],
    question: null,
    guidance: [],
    context: contextFor(c),
    scenario: input.scenario || { kind: 'normal', stepDelayMs: 450 },
  }
  if (input.continuesTurnId) t.continuesTurnId = input.continuesTurnId
  if (input.retryOfTurnId) t.retryOfTurnId = input.retryOfTurnId
  c.turns.push(t)
  c.messages.push(
    {
      id: t.inputMessageId,
      role: 'user',
      kind: 'prompt',
      content: input.text,
      turnId: t.id,
      status: 'accepted',
      createdAt: now(),
      attachments: input.attachments || [],
      actorName: input.actorName,
      clientRequestId: input.requestId,
    },
    {
      id: t.assistantMessageId,
      role: 'assistant',
      kind: 'answer',
      content: '',
      turnId: t.id,
      status: 'running',
      createdAt: now(),
      attachments: [],
    },
  )
  publish(input.attachments || [])
  c.activeTurnId = t.id
  c.status = 'running'
  if (c.title === '新会话') c.title = input.text.slice(0, 28)
  changed(c)
  running.set(t.id, {
    c,
    t,
    abort: new AbortController(),
    wake: null,
    released: false,
    started: false,
  })
  queueMicrotask(schedule)
  return t
}
function schedule() {
  let slots = 5 - [...running.values()].filter((r) => r.started).length
  for (const r of running.values()) {
    if (slots <= 0) break
    if (r.started) continue
    r.started = true
    slots--
    execute(r).catch((e) => finish(r, 'failed', e.message))
  }
}
async function delay(r, ms) {
  if (r.abort.signal.aborted) throw new Error('STOPPED')
  await new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      r.abort.signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    r.abort.signal.addEventListener('abort', done, { once: true })
  })
  if (r.abort.signal.aborted) throw new Error('STOPPED')
}
function finish(r, status, error) {
  const { c, t } = r
  if (!running.has(t.id)) return
  t.status = status
  t.completedAt = now()
  if (t.question?.status === 'pending') {
    t.question.status = 'cancelled'
    timelineQuestion(t, t.question)
  }
  activity(t, status)
  for (const entry of t.timeline || [])
    if (entry.type === 'reasoning' && entry.status !== 'completed')
      entry.status = status === 'completed' ? 'completed' : 'interrupted'
  if (error) t.error = error
  for (const s of t.steps)
    if (s.status === 'running') {
      s.status = status === 'completed' ? 'completed' : 'failed'
      s.completedAt = now()
    }
  const m = c.messages.find((m) => m.id === t.assistantMessageId)
  if (m) m.status = status
  c.activeTurnId = null
  c.status = status === 'completed' ? 'idle' : status
  if (status !== 'completed') c.queuePaused = true
  running.delete(t.id)
  changed(c)
  schedule()
  if (status === 'completed') queueMicrotask(() => drain(c))
}
function drain(c) {
  if (deletingConversations.has(c.id) || c.activeTurnId || c.queuePaused || !c.queue.length) return
  const q = c.queue.shift()
  c.queueRevision = c.revision + 1
  start(c, q)
}
async function step(r, name, input, fn) {
  const s = { id: uid(), name, input, output: '', status: 'running', startedAt: now() }
  r.t.steps.push(s)
  timelineTool(r.t, s)
  changed(r.c)
  await delay(r, r.t.scenario.stepDelayMs)
  s.output = typeof fn === 'function' ? fn() : fn
  s.status = 'completed'
  s.completedAt = now()
  timelineTool(r.t, s)
  changed(r.c)
  return s.output
}
function artifact(c, t, name, content, mime = 'text/markdown') {
  const id = uid(),
    data = Buffer.from(content)
  db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?)').run(
    id,
    c.id,
    c.ownerId,
    1,
    name,
    mime,
    data,
  )
  const f = {
    id,
    name,
    mime,
    size: data.length,
    url: `/api/agent-demo/files/${id}`,
    content,
    createdAt: now(),
    turnId: t.id,
  }
  c.artifacts.push(f)
  activity(t, t.question?.status === 'pending' ? 'waiting_user' : 'awaiting_model')
  changed(c)
  return f
}
async function execute(r) {
  try {
    if (r.c.mode === 'live') return await executeLive(r)
    await executeScenario(r)
  } catch (e) {
    if (r.abort.signal.aborted) {
      finish(r, 'interrupted')
      return
    }
    finish(r, 'failed', e.message)
  }
}
async function executeScenario(r) {
  const { c, t } = r
  const input = c.messages.find((m) => m.id === t.inputMessageId)
  const ctx = t.context
  await step(
    r,
    '读取项目资料',
    { project: ctx.project.name, documents: ctx.documents.map((d) => d.name) },
    () => ctx.documents.map((d) => ({ name: d.name, content: d.content })),
  )
  if (t.scenario.kind === 'clarify' || /澄清|先问我|迁移/.test(input.content)) {
    t.question = {
      id: uid(),
      prompt: '这次希望重点检查哪一项？',
      options: ['服务与资源健康', '项目设计与实现边界', '生成检查报告'],
      status: 'pending',
    }
    t.status = 'waiting'
    c.status = 'waiting'
    timelineQuestion(t, t.question)
    changed(c)
    await new Promise((resolve) => {
      r.wake = resolve
      r.abort.signal.addEventListener('abort', resolve, { once: true })
    })
    r.wake = null
    if (r.abort.signal.aborted) throw new Error('STOPPED')
    t.status = 'running'
    c.status = 'running'
    changed(c)
  }
  await step(
    r,
    '查询环境快照',
    { environment: ctx.environment.name, readOnly: true },
    () => ctx.resourceSnapshot,
  )
  delta(
    c,
    t,
    `已读取 **${ctx.project.name}** 的项目资料和 **${ctx.environment.name}** 资源快照。\n\n`,
  )
  if (t.scenario.kind === 'hold') {
    await new Promise((resolve) => {
      r.wake = resolve
      if (r.released) resolve()
      r.abort.signal.addEventListener('abort', resolve, { once: true })
    })
    r.wake = null
    if (r.abort.signal.aborted) throw new Error('STOPPED')
  }
  if (t.scenario.kind === 'fail') {
    await delay(r, t.scenario.stepDelayMs)
    throw new Error('测试场景：模拟上游连接中断，已保留部分结果与输入。')
  }
  const chunks = [
    `| 检查项 | 结果 |\n| --- | --- |\n`,
    ...ctx.resourceSnapshot.services.map(
      (s) =>
        `| ${s.name} | ${s.status} · CPU ${s.cpuPercent}% · 内存 ${s.memoryPercent}% · 磁盘 ${s.diskPercent}% |\n`,
    ),
    `\n备份距今 ${ctx.resourceSnapshot.lastBackupHours} 小时。${ctx.environment.id === 'env-prod' ? 'API 服务磁盘占用 86%，超过手册的 80% 关注线，建议先核对增长来源。' : '当前夹具未出现超过检查阈值的资源。'}\n\n`,
    `资料来源：${ctx.documents.map((d) => `[${d.name}](/api/agent-demo/projects/${c.projectId}/documents/${d.id})`).join('、')}。\n\n`,
    `> 这是可重复的交互测试场景；以上资源来自演示夹具，不代表真实生产监控或模型推理。\n`,
  ]
  for (const text of chunks) {
    await delay(r, t.scenario.stepDelayMs)
    delta(c, t, text)
  }
  if (t.guidance.length)
    delta(
      c,
      t,
      `\n本轮已接收的引导：${t.guidance.map((g) => g.text).join('；')}。测试场景保留同一轮次供协议验证。\n`,
    )
  if (
    (/报告|report/i.test(input.content) || c.agentId === 'a-report') &&
    !t.guidance.some((g) => /别.*报告|不要.*报告|不生成报告/.test(g.text))
  ) {
    const text = c.messages.find((m) => m.id === t.assistantMessageId).content
    await step(r, '生成报告文件', { format: 'Markdown' }, () => ({ name: '项目检查报告.md' }))
    artifact(
      c,
      t,
      '项目检查报告.md',
      `# ${ctx.project.name}检查报告\n\n采集时间：${ctx.resourceSnapshot.collectedAt}\n\n${text}`,
    )
  }
  finish(r, 'completed')
}
async function bridgeFetch(path, opts = {}) {
  let res
  try {
    res = await fetch(`${bridge}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {}),
        ...opts.headers,
      },
      signal: opts.signal || AbortSignal.timeout(10000),
    })
  } catch (error) {
    if (!opts.signal?.aborted) setRuntimeUnavailable('真实运行器暂不可达，输入和已有内容已保留')
    throw Object.assign(new Error('真实运行器连接暂不可用，输入和已有内容已保留'), {
      cause: error,
      code: 'RUNTIME_UNAVAILABLE',
    })
  }
  if (!res.ok) {
    if ([404, 409].includes(res.status))
      fail(409, 'TURN_CHANGED', '运行器当前轮次已变化，输入已保留，请查看最新状态后重试')
    fail(503, 'RUNTIME_UNAVAILABLE', `运行器暂时无法接受请求 (${res.status})，输入已保留`)
  }
  return res
}
// A fast runner may send its continuation before the control HTTP receipt arrives.
// Keep those events in receive order until accepted user input has its timeline slot.
// Rejected controls leave no user entry and release the same buffered events unchanged.
function deferBridgeEvents(t) {
  const r = running.get(t.id)
  if (!r) return () => {}
  r.pendingControls = (r.pendingControls || 0) + 1
  return () => {
    r.pendingControls--
    if (r.pendingControls) return
    const events = r.deferredEvents || []
    r.deferredEvents = []
    for (const event of events) applyBridgeEvent(r, event)
  }
}
function applyBridgeEvent(r, e) {
  const { c, t } = r
  if (c.activeTurnId !== t.id || !running.has(t.id)) return
  if (
    c.status === 'stopping' &&
    !['completed', 'failed', 'interrupted', 'stream.closed', 'usage'].includes(e.type)
  )
    return
  if (e.type === 'started') {
    t.runnerThreadId = e.runnerThreadId
    t.runnerTurnId = e.runnerTurnId
    if (e.sessionMode && e.sessionMode !== 'stateless')
      c.runtimeSession = { threadId: e.runnerThreadId, revision: c.runtimeContextRevision || 0 }
    activity(t, 'awaiting_model')
    changed(c)
  } else if (e.type === 'timing') {
    if (typeof e.phase === 'string' && Number.isFinite(e.elapsedMs) && e.elapsedMs >= 0) {
      t.runtimeTimings ||= {}
      t.runtimeTimings[e.phase] = { elapsedMs: e.elapsedMs, at: e.at }
      save(c)
    }
  } else if (e.type === 'context.compaction') {
    activity(t, e.status === 'completed' ? 'awaiting_model' : 'context_compacting')
    changed(c)
  } else if (e.type === 'delta') delta(c, t, e.text, e.itemId ?? null, e.messagePhase)
  else if (e.type === 'reasoning')
    streamPart(c, t, e.text || '', {
      itemId: e.itemId ?? e.id ?? null,
      type: 'reasoning',
      mode: e.mode === 'replace' ? 'replace' : 'append',
      kind: e.kind === 'text' ? 'text' : 'summary',
      status: e.status === 'completed' ? 'completed' : 'running',
    })
  else if (e.type === 'usage') updateUsage(c, t, e)
  else if (e.type === 'tool') {
    let s = t.steps.find((step) => step.id === e.id)
    if (s) Object.assign(s, e)
    else {
      s = { ...e, startedAt: e.startedAt || now() }
      t.steps.push(s)
    }
    if (['completed', 'failed', 'cancelled'].includes(s.status) && !s.completedAt)
      s.completedAt = now()
    timelineTool(t, s)
    changed(c)
  } else if (e.type === 'question') {
    const existing = t.timeline.find(
      (entry) => entry.type === 'question' && entry.question.id === e.id,
    )
    // Replayed question updates must not reopen an already answered question.
    if (existing && existing.question.status !== 'pending') return
    t.question = { id: e.id, prompt: e.prompt, options: e.options || [], status: 'pending' }
    t.status = 'waiting'
    c.status = 'waiting'
    timelineQuestion(t, t.question)
    changed(c)
  } else if (e.type === 'artifact') artifact(c, t, e.name, e.content, e.mime)
  else if (['completed', 'failed', 'interrupted'].includes(e.type)) {
    if (e.timings) t.runtimeTimings = { ...t.runtimeTimings, runner: e.timings }
    finish(r, e.type, e.error)
  } else if (e.type === 'stream.closed') finish(r, 'failed', '运行器事件连接结束，未收到完成回执')
}
function receiveBridgeEvent(r, event) {
  if (r.pendingControls) (r.deferredEvents ||= []).push(event)
  else applyBridgeEvent(r, event)
}
async function executeLive(r) {
  const { c, t } = r,
    input = c.messages.find((m) => m.id === t.inputMessageId)
  t.runtimeTimings = { acceptedAt: t.startedAt, preparationStartedAt: now() }
  const files = []
  for (const id of runFileIds(c, t)) {
    const row = authorizedRunFile(r, id)
    const current = input.attachments.some((file) => file.id === id)
    if (current && /^image\/(png|jpeg|webp|gif)$/.test(row.mime)) {
      files.push({ ...(await extractedFile(row, true)), current })
    } else {
      const meta = fileMeta(row)
      const oldImage = /^image\/(png|jpeg|webp|gif)$/.test(row.mime)
      files.push({
        ...meta,
        reference: true,
        current,
        ...(oldImage
          ? {
              readable: false,
              extraction: {
                status: 'unavailable',
                code: 'IMAGE_REATTACH_REQUIRED',
                message: '历史图片未提取文本；如需重新视觉分析，请将图片重新附到本轮。',
              },
            }
          : {}),
      })
    }
  }
  const ready = await waitForRuntimeHealth({
    probe: checkBridge,
    waitMs: 3000,
    isAborted: () => r.abort.signal.aborted,
  })
  if (r.abort.signal.aborted || !running.has(t.id)) return
  if (!ready.healthy)
    fail(503, 'RUNTIME_UNAVAILABLE', runtime.reason || '运行器仍在恢复，请稍后继续；输入已保留')
  t.runtimeTimings.preparationCompletedAt = now()
  const revision = c.runtimeContextRevision || 0
  const expectedThreadId =
    c.runtimeSession?.revision === revision ? c.runtimeSession.threadId : undefined
  // Record ownership before dispatch: an interrupted response can still leave a
  // native binding behind. DELETE remains idempotent when no binding was made.
  if (runtime.capabilities?.sessions?.native && !expectedThreadId) {
    c.runtimeSession = { pending: true, revision }
    changed(c)
  }
  r.bridgeDispatchStarted = true
  await bridgeFetch('/runs', {
    method: 'POST',
    body: JSON.stringify({
      runId: t.id,
      session: { id: c.id, revision, ...(expectedThreadId ? { expectedThreadId } : {}) },
      prompt: input.content,
      context: t.context,
      history: expectedThreadId ? [] : transcript(c, t.retryOfTurnId || t.id),
      attachments: files.filter((file) => file.current).map(({ current, ...file }) => file),
      sessionAttachments: files.filter((file) => !file.current).map(({ current, ...file }) => file),
    }),
  })
  const res = await bridgeFetch(`/runs/${t.id}/events`, { signal: r.abort.signal })
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n')
      if (!data) continue
      const envelope = JSON.parse(data)
      const e = { ...envelope, ...envelope.payload }
      if (c.activeTurnId !== t.id || !running.has(t.id)) return
      receiveBridgeEvent(r, e)
    }
  }
  if (running.has(t.id)) receiveBridgeEvent(r, { type: 'stream.closed' })
}
function setRuntimeUnavailable(reason) {
  setRuntime({ ...runtime, liveAvailable: false, reason })
}
function setRuntime(next) {
  if (JSON.stringify(next) !== JSON.stringify(runtime)) {
    runtime = next
    emit('runtime.updated', null, runtime)
  }
}
let healthProbeInFlight = null
function checkBridge() {
  if (t3Mode) return Promise.resolve({ healthy: true, body: { name: 'T3 Code', liveAvailable: true } })
  // Share only concurrent probes, never an earlier success across a restart.
  if (healthProbeInFlight) return healthProbeInFlight
  healthProbeInFlight = probeBridge().finally(() => {
    healthProbeInFlight = null
  })
  return healthProbeInFlight
}
async function probeBridge() {
  if (!bridge) return { healthy: false, final: true }
  let next
  try {
    const r = await bridgeFetch('/health', { signal: AbortSignal.timeout(1000) })
    const h = await r.json()
    next = {
      liveAvailable: !!h.liveAvailable,
      name: h.name || 'Codex',
      reason: h.reason,
      capabilities: h.capabilities,
      version: h.version,
      provider: h.provider,
      model: h.model,
      readiness: h.readiness,
      modelVerified: h.modelVerified,
    }
  } catch {
    next = {
      liveAvailable: false,
      name: 'Codex 连接桥',
      reason: '真实运行器暂不可达，已有内容已保留',
    }
  }
  setRuntime(next)
  return { healthy: next.liveAvailable, body: next }
}
checkBridge()
const runtimeTimer = setInterval(checkBridge, 10000)
runtimeTimer.unref()

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  try {
    if (t3Gateway?.request(req, res)) return
    const url = new URL(req.url, 'http://localhost'),
      path = url.pathname.replace(/^\/api\/agent-demo/, '')
    const internalFile = path.match(
      /^\/internal\/runs\/([a-zA-Z0-9_.:-]+)\/attachments\/([a-zA-Z0-9_.:-]+)\/read$/,
    )
    if (internalFile) {
      const presented = req.headers.authorization?.replace(/^Bearer /, '') || ''
      if (
        !bridgeToken ||
        !timingSafeEqual(Buffer.from(hash(presented), 'hex'), Buffer.from(hash(bridgeToken), 'hex'))
      )
        fail(401, 'UNAUTHORIZED', '运行器身份校验失败')
      if (req.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '仅支持读取请求')
      const r = running.get(internalFile[1])
      if (!r || r.c.mode !== 'live' || r.c.activeTurnId !== r.t.id || r.c.status === 'stopping')
        fail(404, 'RUN_NOT_ACTIVE', '读取所属轮次已结束')
      const row = authorizedRunFile(r, internalFile[2])
      const file = await extractedFile(row)
      if (!running.has(r.t.id) || r.c.status === 'stopping')
        fail(409, 'RUN_NOT_ACTIVE', '读取所属轮次已结束')
      return json(res, 200, { file: { ...file, sourceUrl: `/api/agent-demo/files/${row.id}` } })
    }
    if (!url.pathname.startsWith('/api/agent-demo')) return staticFile(req, res, url)
    if (path === '/health') {
      if (t3Mode) {
        let workerReachable = false
        try { workerReachable = (await fetch(`${process.env.AUTOOPS_T3_INTERNAL_URL || 'http://127.0.0.1:8788'}/.well-known/t3/environment`, {signal:AbortSignal.timeout(1500)})).ok } catch {}
        return json(res, workerReachable ? 200 : 503, {ok:workerReachable,service:'autoops-agent-demo',engine:'t3',sourceVersion:'0.1.1',sourceCommit:'fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92',workerReachable,buildHash:BUILD_HASH,nodeVersion:process.version})
      }
      await checkBridge()
      return json(res, 200, {
        ok: true,
        service: 'autoops-agent-demo',
        version: '0.1.0',
        buildHash: BUILD_HASH,
        nodeVersion: process.version,
        active: running.size,
        liveAvailable: runtime.liveAvailable,
      })
    }
    if (path === '/login' && req.method === 'POST') {
      const b = await body(req),
        ip = req.socket.remoteAddress
      const attempts = loginAttempts.get(ip) || { count: 0, at: Date.now() }
      if (Date.now() - attempts.at > 60000) {
        attempts.count = 0
        attempts.at = Date.now()
      }
      if (++attempts.count > 30) fail(429, 'RATE_LIMIT', '尝试过于频繁，请稍后重试')
      loginAttempts.set(ip, attempts)
      const user = users.find((u) => u.username === b.username)
      const a = hash(String(b.password || '')),
        z = hash(process.env.DEMO_PASSWORD || 'Demo123!')
      if (!user || !timingSafeEqual(Buffer.from(a), Buffer.from(z)))
        fail(401, 'BAD_CREDENTIALS', '账号或密码不正确')
      const token = randomBytes(32).toString('hex'),
        csrf = randomBytes(24).toString('hex')
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(
        hash(token),
        user.id,
        csrf,
        Date.now() + 86400000,
      )
      return json(
        res,
        200,
        { user, csrf },
        {
          'Set-Cookie': `demo_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`,
        },
      )
    }
    const s = auth(req),
      u = s.user
    res.demoUser = u
    if (!['GET', 'HEAD'].includes(req.method)) {
      csrf(req, s)
      await body(req)
    }
    if (path === '/logout' && req.method === 'POST') {
      db.prepare('DELETE FROM sessions WHERE token=?').run(s.token)
      for (const client of connections) if (client.sessionToken === s.token) client.res.end()
      return json(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': 'demo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' },
      )
    }
    if (t3Mode && !['GET', 'HEAD'].includes(req.method))
      fail(410, 'LEGACY_ENGINE_RETIRED', '旧对话执行入口已退出，请使用新版对话。')
    if (t3Mode && (path === '/events' || path.startsWith('/internal/')))
      fail(410, 'LEGACY_ENGINE_RETIRED', '旧事件链路已退出，请使用新版对话。')
    if (t3Mode && ['GET', 'HEAD'].includes(req.method) && path.startsWith('/files/')) {
      const fileId = path.slice('/files/'.length)
      const mappingPath = join(DATA, 't3-autoops.sqlite')
      if (!existsSync(mappingPath)) fail(404, 'NOT_FOUND', '文件不存在或无权访问')
      legacyT3Map ||= new DatabaseSync(mappingPath, {readOnly:true})
      if (!legacyT3Map.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='t3_legacy_id_map'").get()) fail(404, 'NOT_FOUND', '文件不存在或无权访问')
      const mapping = legacyT3Map.prepare("SELECT kind,native_id FROM t3_legacy_id_map WHERE legacy_id=? AND kind IN ('attachment','report') ORDER BY CASE kind WHEN 'report' THEN 0 ELSE 1 END LIMIT 1").get(fileId)
      if (!mapping) fail(404, 'NOT_FOUND', '文件不存在或无权访问')
      // The new resource handler rechecks current membership, visibility and
      // deletion. Never serve stale legacy ACL/bytes after the core cutover.
      res.writeHead(302, {'Location': `/api/agent-demo/t3/autoops/${mapping.kind === 'report' ? 'files' : 'attachments'}/${encodeURIComponent(mapping.native_id)}`, 'Cache-Control':'no-store'})
      return res.end()
    }
    if (t3Mode && !/^\/projects\/[^/]+\/documents\/[^/]+$/.test(path))
      fail(410, 'LEGACY_ENGINE_RETIRED', '旧对话入口已退出，请使用新版对话。')
    if (path === '/bootstrap')
      return json(res, 200, {
        user: u,
        csrf: s.csrf,
        projects: projects
          .filter((p) => p.memberIds.includes(u.id))
          .map((p) => ({ ...p, documents: p.documents.map(({ content, ...d }) => d) })),
        agents: agents.filter((a) =>
          a.projectIds.some((id) => projects.find((p) => p.id === id).memberIds.includes(u.id)),
        ),
        conversations: [...convs.values()]
          .filter((c) => visible(u, c))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        runtime,
        serverTime: now(),
        eventCursor: Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq),
      })
    if (path === '/events' && req.method === 'GET') {
      const after = Math.max(
        0,
        Number(req.headers['last-event-id'] || url.searchParams.get('after')) || 0,
      )
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const client = {
        res,
        user: u,
        sessionToken: s.token,
        cursor: after,
        pumping: false,
        readySent: false,
      }
      connections.add(client)
      let heartbeat
      const cleanup = () => {
        clearInterval(heartbeat)
        connections.delete(client)
      }
      res.on('close', cleanup)
      res.on('error', () => {
        cleanup()
        res.destroy()
      })
      // 同一连接只有一个日志发送循环，回放与实时都等待 drain，避免五任务同时推送时盲写或丢流。
      await pumpEvents(client)
      if (res.destroyed || res.writableEnded) return
      heartbeat = setInterval(() => {
        if (res.destroyed || res.writableEnded) {
          cleanup()
          return
        }
        if (Date.now() > s.expires) {
          res.end()
          return
        }
        res.write(': heartbeat\n\n')
      }, 15000)
      return
    }
    const docMatch = path.match(/^\/projects\/([^/]+)\/documents\/([^/]+)$/)
    if (docMatch) {
      const p = projects.find((p) => p.id === docMatch[1] && p.memberIds.includes(u.id)),
        d = p?.documents.find((d) => d.id === docMatch[2])
      if (!d) fail(404, 'NOT_FOUND', '资料不存在或无权访问')
      return json(res, 200, { document: d })
    }
    const fileMatch = path.match(/^\/files\/([^/]+)$/)
    if (fileMatch) {
      const f = db.prepare('SELECT * FROM files WHERE id=?').get(fileMatch[1])
      if (!f) fail(404, 'NOT_FOUND', '文件不存在')
      requireConv(u, f.cid)
      if (!f.published && f.owner !== u.id) fail(404, 'NOT_FOUND', '文件不存在')
      const inline = url.searchParams.get('inline') === '1',
        safe = [
          'text/plain',
          'text/markdown',
          'text/csv',
          'application/pdf',
          'image/png',
          'image/jpeg',
          'image/webp',
        ].includes(f.mime)
      res.writeHead(200, {
        'Content-Type': safe ? f.mime : 'application/octet-stream',
        'Content-Disposition': `${inline && safe ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'Content-Length': f.data.byteLength,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      })
      return res.end(Buffer.from(f.data))
    }
    if (path === '/conversations' && req.method === 'POST') {
      const b = await body(req),
        p = projects.find((p) => p.id === b.projectId && p.memberIds.includes(u.id))
      if (!p) fail(404, 'NOT_FOUND', '项目不存在或无权访问')
      if (
        !p.environments.some((e) => e.id === b.environmentId) ||
        !agents.some((a) => a.id === b.agentId && a.projectIds.includes(p.id))
      )
        fail(400, 'INVALID_CONTEXT', 'Agent或环境不属于此项目')
      if (!['private', 'project'].includes(b.visibility) || !['live', 'scenario'].includes(b.mode))
        fail(400, 'INVALID_MODE', '请选择会话范围与运行模式')
      if (b.mode === 'live' && !runtime.liveAvailable)
        fail(503, 'RUNTIME_UNAVAILABLE', runtime.reason)
      const c = {
        id: uid(),
        title: b.title ? validText(b.title, 100) : '新会话',
        projectId: p.id,
        agentId: b.agentId,
        environmentId: b.environmentId,
        visibility: b.visibility,
        ownerId: u.id,
        mode: b.mode,
        createdAt: now(),
        updatedAt: now(),
        revision: 0,
        eventSeq: 0,
        status: 'idle',
        activeTurnId: null,
        queuePaused: false,
        messages: [],
        turns: [],
        queue: [],
        artifacts: [],
      }
      convs.set(c.id, c)
      changed(c)
      return json(res, 201, { conversation: c })
    }
    const match = path.match(/^\/conversations\/([^/]+)(.*)$/)
    if (!match) fail(404, 'NOT_FOUND', '接口不存在')
    const c = requireConv(u, match[1]),
      action = match[2],
      method = req.method
    if (method !== 'GET' && deletingConversations.has(c.id)) fail(409, 'BUSY', '会话正在删除')
    if (!action) {
      if (method === 'GET') return json(res, 200, { conversation: c })
      if (method === 'PATCH') {
        const b = await body(req)
        c.title = validText(b.title, 100)
        changed(c)
        return json(res, 200, { conversation: c })
      }
      if (method === 'DELETE') {
        if (c.activeTurnId) fail(409, 'BUSY', '请先停止任务再删除会话')
        if (c.ownerId !== u.id) fail(403, 'FORBIDDEN', '只有创建者可以删除会话')
        if (c.mode === 'live' && c.runtimeSession) {
          deletingConversations.add(c.id)
          try {
            await bridgeFetch(`/sessions/${encodeURIComponent(c.id)}`, { method: 'DELETE' })
          } finally {
            deletingConversations.delete(c.id)
          }
        }
        emit('conversation.deleted', c, {})
        convs.delete(c.id)
        db.prepare('DELETE FROM conversations WHERE id=?').run(c.id)
        db.prepare('DELETE FROM drafts WHERE key LIKE ?').run(`%/${c.id}`)
        db.prepare(
          'DELETE FROM file_extractions WHERE id IN (SELECT id FROM files WHERE cid=?)',
        ).run(c.id)
        db.prepare('DELETE FROM files WHERE cid=?').run(c.id)
        db.prepare('DELETE FROM conversation_preferences WHERE cid=?').run(c.id)
        return json(res, 200, { ok: true })
      }
    }
    if (action === '/preferences' && method === 'PATCH') {
      const b = await body(req)
      if (
        !b ||
        typeof b !== 'object' ||
        Array.isArray(b) ||
        !Object.keys(b).length ||
        Object.keys(b).some(
          (key) => !['pinned', 'archived'].includes(key) || typeof b[key] !== 'boolean',
        )
      )
        fail(400, 'INVALID_PREFERENCES', '请提供置顶或归档的布尔状态')
      const old = conversationPreferences(u, c),
        next = { ...old, ...b }
      // Adapted from OpenChamber session-actions.ts setSessionPinned/archiveSession/
      // unarchiveSession and sessionPins.ts withSessionPinned (6491f51d, MIT):
      // persist explicit metadata state, preserve omitted fields, no-op repeats.
      // AutoOps scopes this state to one member instead of the whole runtime.
      if (next.pinned !== old.pinned || next.archived !== old.archived)
        transaction(() => {
          db.prepare('INSERT OR REPLACE INTO conversation_preferences VALUES(?,?,?,?)').run(
            u.id,
            c.id,
            Number(next.pinned),
            Number(next.archived),
          )
          // Advance delivery order so other tabs refresh, without changing the
          // shared content revision, recency, visibility or running turn.
          emit('conversation.updated', c, { conversation: c }, c.activeTurnId)
          save(c)
        })
      return json(res, 200, { conversation: c })
    }
    if (action === '/draft') {
      const key = `${u.id}/${c.id}`,
        old = JSON.parse(
          db.prepare('SELECT body FROM drafts WHERE key=?').get(key)?.body ||
            '{"text":"","attachmentIds":[],"revision":0}',
        )
      if (method === 'GET')
        return json(res, 200, {
          draft: { ...old, attachments: attachments(c, u, old.attachmentIds) },
        })
      if (method === 'PUT') {
        const b = await body(req)
        if (typeof b.text !== 'string' || b.text.length > 32000)
          fail(400, 'INVALID_TEXT', '草稿超过限制')
        if (b.revision !== old.revision) fail(409, 'REVISION_CONFLICT', '草稿在另一个页面已更新')
        const files = attachments(c, u, b.attachmentIds)
        const draft = {
          text: b.text,
          attachmentIds: files.map((f) => f.id),
          revision: old.revision + 1,
        }
        db.prepare('INSERT OR REPLACE INTO drafts VALUES(?,?)').run(key, JSON.stringify(draft))
        return json(res, 200, { draft: { ...draft, attachments: files } })
      }
    }
    if (action === '/attachments' && method === 'POST') {
      const b = await body(req)
      if (typeof b.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.data))
        fail(400, 'INVALID_FILE', '附件编码无效')
      const name = validText(b.name, 180).replace(/[\x00-\x1f/\\]/g, '_'),
        mime =
          typeof b.mime === 'string' && b.mime.length < 100 ? b.mime : 'application/octet-stream',
        data = Buffer.from(b.data, 'base64')
      if (data.length > 8 * 1024 * 1024) fail(413, 'TOO_LARGE', '单个文件不能超过8MB')
      const id = uid()
      const extracted = await extractAttachment({ id, name, mime, bytes: data })
      if (!convs.has(c.id)) fail(404, 'NOT_FOUND', '会话已删除')
      transaction(() => {
        db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?)').run(
          id,
          c.id,
          u.id,
          0,
          name,
          mime,
          data,
        )
        storeExtraction(id, extracted)
      })
      return json(res, 201, { attachment: fileMeta({ id, name, mime, data }) })
    }
    if (action === '/messages' && method === 'POST') {
      const b = await body(req)
      if (!['send', 'queue', 'steer'].includes(b.delivery))
        fail(400, 'INVALID_DELIVERY', '请选择发送方式')
      if (c.mode === 'live' && b.scenario) fail(400, 'INVALID_SCENARIO', '真实模型不能使用测试控制')
      const files = attachments(c, u, b.attachmentIds)
      const text = validText(
        typeof b.text === 'string' && !b.text.trim() && files.length ? '请分析所附文件。' : b.text,
      )
      // Bridge steering must complete before an accepted receipt; concurrent retries share a promise.
      if (b.delivery === 'steer' && c.mode === 'live')
        return await liveSteer(req, res, u, c, b, text)
      const out = once(u, c, 'messages', b, () => {
        if (b.delivery === 'steer') {
          const t = active(c, b.expectedTurnId)
          if (files.length) fail(400, 'STEER_ATTACHMENTS', '本轮引导仅支持文本，请将附件排队')
          const g = { id: uid(), text, status: 'accepted', createdAt: now() }
          t.guidance.push(g)
          timelineUser(c, t, {
            id: uid(),
            role: 'user',
            kind: 'steer',
            content: text,
            turnId: t.id,
            status: 'accepted',
            createdAt: now(),
            attachments: [],
            actorName: u.name,
            clientRequestId: b.requestId,
          })
          const r = running.get(t.id)
          if (/release/i.test(text) && r) {
            r.released = true
            r.wake?.()
          }
          changed(c)
          return { conversation: clone(c), receipt: { id: g.id, status: 'accepted', turnId: t.id } }
        }
        if (c.mode === 'live' && !runtime.liveAvailable)
          fail(503, 'RUNTIME_UNAVAILABLE', runtime.reason)
        const sc = scenario(b)
        if (b.delivery === 'queue') {
          if (c.queue.length >= 30) fail(429, 'QUEUE_FULL', '队列最多30条')
          const q = {
            id: uid(),
            text,
            attachments: files,
            createdAt: now(),
            actorName: u.name,
            scenario: sc,
            requestId: b.requestId,
          }
          publish(files)
          c.queue.push(q)
          queueChanged(c)
          queueMicrotask(() => drain(c))
          return { conversation: clone(c), receipt: { id: q.id, status: 'queued' } }
        }
        if (c.mode === 'live' && !runtime.liveAvailable)
          fail(503, 'RUNTIME_UNAVAILABLE', runtime.reason)
        const t = start(c, {
          text,
          attachments: files,
          actorName: u.name,
          scenario: sc,
          requestId: b.requestId,
        })
        return {
          conversation: clone(c),
          receipt: { id: t.inputMessageId, status: 'accepted', turnId: t.id },
        }
      })
      return json(res, 200, out)
    }
    if (action === '/stop' && method === 'POST') {
      const b = await body(req),
        out = once(u, c, 'stop', b, () => {
          const t = active(c, b.expectedTurnId),
            r = running.get(t.id)
          c.queuePaused = true
          if (c.mode === 'live' && !r.bridgeDispatchStarted) {
            r.abort.abort()
            finish(r, 'interrupted')
          } else if (c.mode === 'live') {
            c.status = 'stopping'
            activity(t, 'stopping')
            changed(c)
            bridgeFetch(`/runs/${t.id}/stop`, {
              method: 'POST',
              body: JSON.stringify({
                requestId: b.requestId,
                expectedRunnerTurnId: t.runnerTurnId,
              }),
            })
              .then(async (response) => {
                const receipt = await response.json()
                if (c.activeTurnId !== t.id || !running.has(t.id)) return
                if (!receipt.accepted) throw new Error('运行器未确认中断请求')
                // 接收控制请求不等于执行已终止；等待运行器 SSE 终态。
                if (['interrupted', 'completed', 'failed'].includes(receipt.status))
                  finish(r, receipt.status)
              })
              .catch((e) => {
                if (c.activeTurnId !== t.id || !running.has(t.id)) return
                c.status = t.status
                t.error = `停止未确认：${e.message}`
                activity(
                  t,
                  t.question?.status === 'pending'
                    ? 'waiting_user'
                    : t.steps.some((step) => step.status === 'running')
                      ? 'tool'
                      : 'awaiting_model',
                )
                changed(c)
              })
          } else {
            r.abort.abort()
            r.wake?.()
            finish(r, 'interrupted')
          }
          return { conversation: clone(c) }
        })
      return json(res, 200, out)
    }
    if (action === '/branch' && method === 'POST') {
      const b = await body(req)
      const out = once(u, c, 'branch', b, () => branchConversation(c, u, b))
      return json(res, 201, out)
    }
    if (action === '/retry' && method === 'POST') {
      const b = await body(req)
      const out = once(u, c, 'retry', b, () => {
        requireIdle(c, b)
        // Hermes regenerateResponse/startRegeneration (ui.js/messages.js,
        // 3aa21f63387939dcff37baa141ad59a0e1e1147f, MIT): bind to the last settled
        // response and replay its owning user input. AutoOps retains both runs.
        const old = c.turns.at(-1)
        if (
          !old ||
          old.id !== b.turnId ||
          !['completed', 'failed', 'interrupted'].includes(old.status)
        )
          fail(409, 'TURN_CHANGED', '只能重新生成最新已结束轮次，请查看最新会话')
        if (c.mode === 'live' && !runtime.liveAvailable)
          fail(503, 'RUNTIME_UNAVAILABLE', runtime.reason)
        const prompt = c.messages.find((message) => message.id === old.inputMessageId)
        if (!prompt) fail(409, 'INVALID_RETRY', '原始输入不存在')
        const files = attachments(
          c,
          u,
          (prompt.attachments || []).map((file) => file.id),
        )
        const turn = start(c, {
          text: prompt.content,
          attachments: files,
          actorName: u.name,
          requestId: b.requestId,
          retryOfTurnId: old.retryOfTurnId || old.id,
          scenario: { kind: 'normal', stepDelayMs: old.scenario?.stepDelayMs || 450 },
        })
        turn.context = clone(old.context)
        delete turn.context.partialOutput
        delete turn.context.originalGuidance
        changed(c)
        return {
          conversation: clone(c),
          receipt: { status: 'accepted', id: turn.inputMessageId, turnId: turn.id },
        }
      })
      return json(res, 200, out)
    }
    if (action === '/continue' && method === 'POST') {
      const b = await body(req),
        out = once(u, c, 'continue', b, () => {
          if (c.mode === 'live' && !runtime.liveAvailable)
            fail(503, 'RUNTIME_UNAVAILABLE', runtime.reason)
          const old = c.turns.find((t) => t.id === b.turnId)
          if (!old || !['interrupted', 'failed'].includes(old.status))
            fail(409, 'NOT_RESUMABLE', '该轮次不能继续')
          const msg = c.messages.find((m) => m.id === old.inputMessageId),
            partial = c.messages.find((m) => m.id === old.assistantMessageId)
          const t = start(c, {
            text: msg.content,
            attachments: msg.attachments,
            actorName: u.name,
            scenario: { kind: 'normal', stepDelayMs: old.scenario.stepDelayMs },
            continuesTurnId: old.id,
            requestId: b.requestId,
          })
          t.context = clone(old.context)
          t.context.partialOutput = partial?.content || ''
          t.context.originalGuidance = old.guidance
          changed(c)
          return { conversation: clone(c) }
        })
      return json(res, 200, out)
    }
    if (['/queue/resume', '/queue/pause'].includes(action) && method === 'POST') {
      const b = await body(req),
        out = once(u, c, action, b, () => {
          c.queuePaused = action.endsWith('pause')
          queueChanged(c)
          if (!c.queuePaused) queueMicrotask(() => drain(c))
          return { conversation: clone(c) }
        })
      return json(res, 200, out)
    }
    if (action === '/queue/reorder' && method === 'POST') {
      const b = await body(req)
      revision(c, b)
      if (
        !Array.isArray(b.ids) ||
        b.ids.length !== c.queue.length ||
        new Set(b.ids).size !== c.queue.length ||
        b.ids.some((id) => !c.queue.some((q) => q.id === id))
      )
        fail(409, 'QUEUE_CHANGED', '队列已变化，请重试')
      c.queue = b.ids.map((id) => c.queue.find((q) => q.id === id))
      queueChanged(c)
      return json(res, 200, { conversation: c })
    }
    const sendNow = action.match(/^\/queue\/([^/]+)\/send-now$/)
    if (sendNow && method === 'POST') {
      const b = await body(req)
      // Adapted from OpenChamber ChatInput.tsx takeForSend and
      // useQueuedMessageAutoSend.ts buildQueuedAutoSendPayload: claim the exact
      // stored item once, delivering its captured text/files without rewriting.
      // AutoOps keeps ownership in this transaction and only admits idle runs.
      const out = once(u, c, 'queue/send-now', { ...b, queueItemId: sendNow[1] }, () => {
        requireIdle(c, b)
        if (c.mode === 'live' && !runtime.liveAvailable)
          fail(503, 'RUNTIME_UNAVAILABLE', runtime.reason)
        const index = c.queue.findIndex((item) => item.id === sendNow[1])
        if (index < 0) fail(409, 'QUEUE_CHANGED', '排队消息已执行或移除')
        const [item] = c.queue.splice(index, 1)
        c.queueRevision = c.revision + 1
        const turn = start(c, item)
        return {
          conversation: clone(c),
          receipt: { status: 'accepted', id: item.id, turnId: turn.id },
        }
      })
      return json(res, 200, out)
    }
    const qm = action.match(/^\/queue\/([^/]+)$/)
    if (qm) {
      const b = await body(req)
      revision(c, b)
      const q = c.queue.find((q) => q.id === qm[1])
      if (!q) fail(404, 'NOT_FOUND', '排队消息已执行或移除')
      if (method === 'PATCH')
        q.text = validText(
          typeof b.text === 'string' && !b.text.trim() && q.attachments.length
            ? '请分析所附文件。'
            : b.text,
        )
      else if (method === 'DELETE') c.queue = c.queue.filter((item) => item.id !== q.id)
      else fail(405, 'METHOD_NOT_ALLOWED', '不支持的方法')
      queueChanged(c)
      return json(res, 200, { conversation: c })
    }
    const question = action.match(/^\/questions\/([^/]+)$/)
    if (question && method === 'POST') {
      const b = await body(req)
      const out = await onceAsync(u, c, 'answer', b, async () => {
        const t = active(c, b.expectedTurnId)
        if (t.question?.id !== question[1] || t.question.status !== 'pending')
          fail(409, 'QUESTION_CHANGED', '问题已回答或已过期')
        const answer = validText(b.answer)
        const releaseEvents = c.mode === 'live' ? deferBridgeEvents(t) : () => {}
        try {
          if (c.mode === 'live')
            await bridgeFetch(`/runs/${t.id}/answer`, {
              method: 'POST',
              body: JSON.stringify({ requestId: b.requestId, questionId: question[1], answer }),
            })
          t.question.status = 'answered'
          t.question.answer = answer
          t.question.answeredAt = now()
          timelineQuestion(t, t.question)
          timelineUser(c, t, {
            id: uid(),
            role: 'user',
            kind: 'answer',
            content: answer,
            turnId: t.id,
            status: 'accepted',
            createdAt: now(),
            attachments: [],
            actorName: u.name,
            clientRequestId: b.requestId,
          })
          if (c.activeTurnId === t.id && c.status !== 'stopping') {
            t.status = 'running'
            c.status = 'running'
          }
          changed(c)
        } finally {
          releaseEvents()
        }
        running.get(t.id)?.wake?.()
        return { conversation: clone(c) }
      })
      return json(res, 200, out)
    }
    fail(404, 'NOT_FOUND', '接口不存在')
  } catch (e) {
    if (!res.headersSent)
      json(res, e.status || 500, {
        error: e.status ? e.message : '服务暂时出错，请重试',
        code: e.code || 'INTERNAL_ERROR',
      })
    else res.end()
    if (!e.status) console.error(e)
  }
})
const inFlight = new Map()
async function onceAsync(u, c, op, b, fn) {
  if (typeof b.requestId !== 'string' || b.requestId.length < 4 || b.requestId.length > 128)
    fail(400, 'REQUEST_ID_REQUIRED', '缺少有效请求标识')
  const key = `${u.id}/${c.id}/${op}/${b.requestId}`,
    fingerprint = hash(JSON.stringify(b))
  const prior = db.prepare('SELECT * FROM requests WHERE key=?').get(key)
  if (prior) {
    if (prior.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', '请求标识已使用')
    return JSON.parse(prior.body)
  }
  if (inFlight.has(key)) {
    const pending = inFlight.get(key)
    if (pending.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', '请求标识已使用')
    return pending.promise
  }
  const promise = (async () => {
    const out = await fn()
    db.prepare('INSERT INTO requests VALUES(?,?,?)').run(key, fingerprint, JSON.stringify(out))
    return out
  })()
  inFlight.set(key, { fingerprint, promise })
  try {
    return await promise
  } finally {
    inFlight.delete(key)
  }
}
async function liveSteer(req, res, u, c, b, text) {
  const out = await onceAsync(u, c, 'messages', b, async () => {
    const t = active(c, b.expectedTurnId)
    if ((b.attachmentIds || []).length) fail(400, 'STEER_ATTACHMENTS', '引导仅支持文本')
    if (!t.runnerTurnId) fail(409, 'RUNNER_STARTING', '运行器正在启动，输入已保留，请稍后引导')
    const releaseEvents = deferBridgeEvents(t)
    let g
    try {
      const response = await bridgeFetch(`/runs/${t.id}/steer`, {
        method: 'POST',
        body: JSON.stringify({
          requestId: b.requestId,
          text,
          expectedRunnerTurnId: t.runnerTurnId,
        }),
      })
      const receipt = await response.json()
      if (!receipt.accepted) fail(409, 'STEER_REJECTED', '运行器未接收引导，输入已保留')
      g = { id: uid(), text, status: 'accepted', createdAt: now() }
      t.guidance.push(g)
      timelineUser(c, t, {
        id: uid(),
        role: 'user',
        kind: 'steer',
        content: text,
        turnId: t.id,
        status: 'accepted',
        createdAt: now(),
        attachments: [],
        actorName: u.name,
        clientRequestId: b.requestId,
      })
      changed(c)
    } finally {
      releaseEvents()
    }
    return { conversation: clone(c), receipt: { id: g.id, status: 'accepted', turnId: t.id } }
  })
  return json(res, 200, out)
}
const staticRoot = resolve(process.env.STATIC_DIR || join(ROOT, '../dist/web'))
function staticFile(req, res, url) {
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return json(res, 400, { error: '无效路径' })
  }
  const target = resolve(staticRoot, '.' + (pathname === '/' ? '/agent-demo.html' : pathname))
  if (!target.startsWith(staticRoot + '/') || !existsSync(target) || !statSync(target).isFile())
    return json(res, 404, { error: '页面不存在' })
  const mime =
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
      '.txt': 'text/plain',
    }[extname(target)] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': extname(target) === '.html' ? 'no-cache' : 'public, max-age=3600',
    'Content-Security-Policy':
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src ${t3Mode && (pathname === '/' || pathname === '/agent-demo.html') ? "'self'" : "'none'"}; base-uri 'self'; frame-ancestors 'none'`,
  })
  res.end(readFileSync(target))
}
if (t3Gateway) server.on('upgrade', t3Gateway.upgrade)
server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () =>
  console.log(`Agent Demo listening ${JSON.stringify(server.address())}; data=${DATA}`),
)
function shutdown() {
  for (const r of [...running.values()]) {
    r.abort.abort()
    r.wake?.()
    finish(r, 'interrupted', '服务正常关闭，执行已中断，可继续。')
  }
  for (const c of connections) c.res.end()
  server.close(() => {
    legacyT3Map?.close()
    db.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
