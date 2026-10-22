import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createServer } from 'vite'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'

const report = {
  startedAt: new Date().toISOString(),
  mode: 'production-Chat-useDemo-native-EventSource-local-controlled-HTTP',
  realModelCalls: 0,
  boundary:
    'Synthetic server transcript; actual Chromium DOM, React Chat, fetch and SSE sockets. No deployed service or provider configuration changed.',
  checks: [],
  observations: [],
}
let seq = 1
let text = ''
let running = true
let offline = false
let replayFloor = 0
const journal = []
const clients = new Set()
const requests = []
const connectionEvents = []
const now = () => new Date().toISOString()
const snapshot = () => ({
  id: 'transport-chat',
  projectId: 'transport-project',
  agentId: 'fixture',
  title: '流式滚动与断线恢复 · 本地受控验收',
  mode: 'scenario',
  visibility: 'private',
  ownerId: 'transport-user',
  revision: seq,
  eventSeq: seq,
  activeTurnId: running ? 'transport-turn' : null,
  status: running ? 'running' : 'completed',
  queue: [],
  artifacts: [],
  queuePaused: false,
  messages: [
    {
      id: 'transport-user-message',
      role: 'user',
      turnId: 'transport-turn',
      content: '输出一份多段说明，用于浏览器受控滚动验收。',
      createdAt: now(),
      attachments: [],
    },
    {
      id: 'transport-assistant',
      role: 'assistant',
      turnId: 'transport-turn',
      content: text,
      createdAt: now(),
      attachments: [],
    },
  ],
  turns: [
    {
      id: 'transport-turn',
      status: running ? 'running' : 'completed',
      phase: running ? 'answering' : 'completed',
      startedAt: '2026-10-21T08:00:00.000Z',
      completedAt: running ? null : now(),
      steps: [],
      timeline: [
        {
          id: 'transport-reasoning',
          type: 'reasoning',
          status: 'completed',
          text: '已获得资料，按段整理结果。'.repeat(25),
        },
        { id: 'transport-text', type: 'text', text, status: running ? 'running' : 'completed' },
      ],
    },
  ],
})
const encode = (event) =>
  `id: ${event.seq || ''}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const emit = (event) => {
  journal.push(event)
  for (const response of clients) response.write(encode(event))
}
const append = (delta) => {
  const offset = text.length
  text += delta
  seq += 1
  emit({
    type: 'message.delta',
    seq,
    conversationId: 'transport-chat',
    turnId: 'transport-turn',
    payload: {
      revision: seq,
      messageId: 'transport-assistant',
      delta,
      timelineDelta: { id: 'transport-text', type: 'text', offset, delta },
    },
  })
}
const settle = () => {
  running = false
  seq += 1
  emit({
    type: 'conversation.updated',
    seq,
    conversationId: 'transport-chat',
    payload: { conversation: snapshot() },
  })
}
const cut = () => {
  offline = true
  const count = clients.size
  for (const response of [...clients]) response.destroy()
  return count
}
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { '@': path.resolve('web/src') } },
  server: { host: '127.0.0.1', port: 0, watch: null },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'actual-http-stream-fixture',
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          const url = new URL(request.url, 'http://localhost')
          if (url.pathname === '/__transport-test') {
            response.setHeader('content-type', 'text/html')
            response.end(
              await vite.transformIndexHtml(
                url.pathname,
                '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test/helpers/agent-demo-transport-harness.jsx"></script></body></html>',
              ),
            )
            return
          }
          if (!url.pathname.startsWith('/api/agent-demo/')) return next()
          requests.push({
            path: url.pathname,
            after: url.searchParams.get('after'),
            at: now(),
            seq,
            offline,
          })
          if (offline) return json(response, { error: 'Controlled browser transport outage' }, 503)
          if (url.pathname.endsWith('/bootstrap'))
            return json(response, {
              user: { id: 'transport-user', name: '验收用户' },
              csrf: 'test-csrf',
              eventCursor: seq,
              conversations: [snapshot()],
              projects: [],
              agents: [],
              runtime: { liveAvailable: false },
            })
          if (url.pathname.endsWith('/conversations/transport-chat'))
            return json(response, { conversation: snapshot() })
          if (url.pathname.endsWith('/events')) {
            response.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            })
            response.flushHeaders()
            const after = Number(url.searchParams.get('after'))
            const entry = { after, openedAt: now(), closedAt: null, replayed: [] }
            connectionEvents.push(entry)
            for (const event of journal.filter(
              (item) => item.seq > after && item.seq > replayFloor,
            )) {
              entry.replayed.push(event.seq)
              response.write(encode(event))
            }
            response.write(encode({ type: 'ready' }))
            clients.add(response)
            response.on('close', () => {
              clients.delete(response)
              entry.closedAt = now()
            })
            return
          }
          return json(response, {})
        })
      },
    },
  ],
})
let browser
let failure
const check = (name, value) => {
  report.checks.push(name)
  if (value) report.observations.push({ name, ...value })
  console.log(`✓ ${name}`)
}
try {
  await server.listen()
  process.env.PROTOTYPE_URL = `http://127.0.0.1:${server.httpServer.address().port}/__transport-test`
  browser = await startBrowser('agent-demo-transport')
  await browser.viewport(1280, 900)
  const state = () => browser.evaluate('transportHarness.snapshot()')
  const geometry = () =>
    browser.evaluate(
      `(()=>{const n=document.querySelector('.workbench-demo-messages');return {top:n.scrollTop,end:n.scrollHeight-n.clientHeight,gap:n.scrollHeight-n.clientHeight-n.scrollTop,latest:Boolean(document.querySelector('[aria-label="回到最新消息"]'))}})()`,
    )
  const atEnd = () =>
    until(async () => {
      const value = await geometry()
      return !value.latest && value.gap <= 2 && value
    }, 'following latest actual Chat')
  const pointerClick = async (selector) => {
    const point = await browser.evaluate(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    for (const type of ['mousePressed', 'mouseReleased'])
      await browser.command('Input.dispatchMouseEvent', {
        type,
        ...point,
        button: 'left',
        clickCount: 1,
      })
  }
  await until(
    () => browser.evaluate('window.transportHarness?.snapshot().connection === "connected"'),
    'native EventSource connection',
  )
  await browser.evaluate(
    `(()=>{window.scrollEvidence=[];const n=document.querySelector('.workbench-demo-messages');n.addEventListener('scroll',()=>scrollEvidence.push({at:performance.now(),kind:'scroll',top:n.scrollTop,end:n.scrollHeight-n.clientHeight,latest:Boolean(document.querySelector('[aria-label="回到最新消息"]'))}));const d=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');Object.defineProperty(Element.prototype,'scrollTop',{...d,set(value){if(this===n)scrollEvidence.push({at:performance.now(),kind:'write',from:d.get.call(this),to:value,end:n.scrollHeight-n.clientHeight,stack:new Error().stack});d.set.call(this,value)}})})()`,
  )
  for (let i = 0; i < 18; i += 1) {
    append(`第 ${i + 1} 段：这是持续到达的受控文本，验证用户上翻、回到最新与活动收起时的位置。\n\n`)
    await wait(45)
  }
  await atEnd()
  assert.ok(
    (await geometry()).end > 300,
    'the transcript must actually overflow before testing reader gestures',
  )
  const point = await browser.evaluate(
    `(()=>{const r=document.querySelector('.workbench-demo-messages').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await browser.command('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...point,
    deltaX: 0,
    deltaY: -420,
  })
  await wait(200)
  const reading = await geometry()
  assert.equal(reading.latest, true)
  for (let i = 18; i < 25; i += 1) {
    append(`第 ${i + 1} 段：读者查看历史时，本段继续追加，但页面不抢滚动。\n\n`)
    await wait(45)
  }
  await wait(150)
  assert.ok(Math.abs((await geometry()).top - reading.top) < 2)
  check('actual Chat preserves upward reading while streamed paragraphs grow', {
    reading,
    after: await geometry(),
  })
  await pointerClick('[aria-label="回到最新消息"]')
  await wait(300)
  report.observations.push({ name: 'return-button-300ms', geometry: await geometry() })
  await atEnd()
  for (let i = 25; i < 30; i += 1) {
    append(`第 ${i + 1} 段：回最新之后继续保持跟随。\n\n`)
    await wait(80)
  }
  check('native pointer return-to-latest resumes sustained follow', await atEnd())
  settle()
  await until(
    async () => (await state()).conversation.status === 'completed',
    'first settled state',
  )
  check('activity collapsing above the reader retains follow at terminal answer', await atEnd())
  await browser.screenshot('desktop-follow-after-collapse')

  // Reopen the fixture turn and cut the actual HTTP response socket, rather
  // than relying on CDP offline emulation to terminate an already-open SSE.
  running = true
  seq += 1
  emit({
    type: 'conversation.updated',
    seq,
    conversationId: 'transport-chat',
    payload: { conversation: snapshot() },
  })
  await until(async () => (await state()).conversation.activeTurnId, 'running second phase')
  const before = seq
  assert.equal(cut(), 1)
  await until(async () => (await state()).connection === 'reconnecting', 'visible reconnect status')
  assert.ok(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-connection').textContent.includes('连接已中断')",
    ),
  )
  const reconnectSeen = now()
  for (let i = 0; i < 12; i += 1) {
    append(`断线期间第 ${i + 1} 块仍在服务器产生。\n\n`)
    await wait(100)
  }
  assert.ok(seq > before)
  assert.equal(clients.size, 0)
  await browser.screenshot('transport-disconnected')
  offline = false
  await until(async () => (await state()).connection === 'connected', 'native stream reconnect')
  append('REPLAY-TAIL-唯一尾标记。\n\n')
  await until(
    async () => (await state()).conversation.messages[1].content === text,
    'exact replay content',
  )
  const afterReplay = await state()
  assert.equal(
    afterReplay.conversation.turns[0].timeline.find((part) => part.id === 'transport-text').text,
    text,
  )
  assert.equal(
    afterReplay.conversation.messages[1].content.split('REPLAY-TAIL-唯一尾标记').length - 1,
    1,
  )
  assert.ok(connectionEvents.at(-1).after >= before)
  assert.ok(connectionEvents.at(-1).replayed.length >= 12)
  check('destroyed native SSE reconnects with cursor and exact body/timeline, no duplicate tail', {
    beforeSeq: before,
    afterSeq: seq,
    reconnectSeen,
    connection: connectionEvents.at(-1),
  })

  // Retention gaps must heal by authoritative HTTP snapshot, even when no
  // later token is available to expose an offset mismatch.
  assert.equal(cut(), 1)
  await until(async () => (await state()).connection === 'reconnecting', 'second disconnect')
  append('日志保留之外的最后一段，仅快照包含。\n\n')
  settle()
  replayFloor = seq
  offline = false
  await until(async () => {
    const value = await state()
    return (
      value.connection === 'connected' &&
      value.conversation.status === 'completed' &&
      value.conversation.messages[1].content === text
    )
  }, 'snapshot after missing replay and terminal completion')
  assert.equal(connectionEvents.at(-1).replayed.length, 0)
  check(
    'reconnect snapshot repairs fully expired replay including terminal tail with no subsequent event',
    { seq, connection: connectionEvents.at(-1) },
  )
  await atEnd()
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('[data-activity-final-answer]').textContent.includes('日志保留之外的最后一段，仅快照包含。')",
      ),
    'final restored tail painted',
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('[data-activity-final-answer]').textContent.split('REPLAY-TAIL-唯一尾标记').length - 1",
    ),
    1,
  )
  await browser.screenshot('desktop-recovered-exact-tail')
  running = true
  seq += 1
  emit({
    type: 'conversation.updated',
    seq,
    conversationId: 'transport-chat',
    payload: { conversation: snapshot() },
  })
  await until(async () => (await state()).conversation.activeTurnId, 'running held-position phase')
  await atEnd()
  await browser.command('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...point,
    deltaX: 0,
    deltaY: -420,
  })
  await wait(250)
  const visibleAnchor = () =>
    browser.evaluate(
      `(()=>{const n=document.querySelector('.workbench-demo-messages'),top=n.getBoundingClientRect().top;const p=[...n.querySelectorAll('.workbench-demo-markdown p')].find(p=>p.getBoundingClientRect().top>=top);return p?{text:p.textContent,top:p.getBoundingClientRect().top}:null})()`,
    )
  const heldAnchor = await visibleAnchor()
  assert.ok(heldAnchor)
  settle()
  await until(
    async () => (await state()).conversation.status === 'completed',
    'held turn completed',
  )
  await wait(300)
  const afterHeld = await visibleAnchor()
  assert.equal(
    (await geometry()).latest,
    true,
    'a held reader must not resume follow while finishing',
  )
  assert.deepEqual(
    afterHeld,
    heldAnchor,
    'finishing an answer must preserve the paragraph a reader scrolled up to',
  )
  check('activity collapse preserves the paragraph while a reader holds history', {
    before: heldAnchor,
    after: afterHeld,
  })
  await pointerClick('[aria-label="回到最新消息"]')
  await atEnd()
  await browser.viewport(390, 844)
  await atEnd()
  assert.ok(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'))
  await browser.screenshot('mobile-recovered-exact-tail')
  check('390px viewport remains readable after stream recovery')
  assert.equal(browser.errors.length, 0, browser.errors.join('\n'))
} catch (error) {
  failure = error
  console.error(error)
  await browser?.screenshot('failure').catch(() => {})
  report.scrollEvidence = await browser?.evaluate('window.scrollEvidence').catch(() => null)
} finally {
  report.finishedAt = now()
  report.passed = !failure
  report.error = failure?.stack || null
  report.requests = requests
  report.connections = connectionEvents
  report.runtimeErrors = browser?.errors || []
  report.sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        'web/src/agent-demo/use-chat-scroll.js',
        'web/src/agent-demo/use-demo.js',
        'web/src/agent-demo/turn-activity.jsx',
        'web/src/agent-demo/vendor/openchamber/hold-anchor.js',
      ].map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  )
  await mkdir('.test-artifacts/agent-demo-transport', { recursive: true })
  await writeFile(
    '.test-artifacts/agent-demo-transport/report.json',
    JSON.stringify(report, null, 2),
  )
  await browser?.close()
  for (const response of clients) response.destroy()
  await server.close()
}
if (failure) process.exitCode = 1
