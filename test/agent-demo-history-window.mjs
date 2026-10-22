import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'

const sources = [
  'web/src/agent-demo/use-history-window.js',
  'test/helpers/agent-demo-history-harness.jsx',
]
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { '@': path.resolve('web/src') } },
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.test-artifacts/**'] } },
  plugins: [
    react(),
    {
      name: 'isolated-history-fixture',
      configureServer(vite) {
        vite.middlewares.use('/__history-test', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(
            await vite.transformIndexHtml(
              '/__history-test',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/test/helpers/agent-demo-history-harness.jsx"></script></body></html>',
            ),
          )
        })
      },
    },
  ],
})
let browser, failure
const checks = []
const check = (name) => {
  checks.push(name)
  console.log(`✓ ${name}`)
}
const anchorScript = `(()=>{const root=document.querySelector('[data-testid=scroller]');const top=root.getBoundingClientRect().top;const row=[...root.querySelectorAll('[data-message-id]')].find(node=>node.getBoundingClientRect().bottom>top);return{id:row.dataset.messageId,top:row.getBoundingClientRect().top-top,scrollTop:root.scrollTop}})()`
try {
  await server.listen()
  process.env.PROTOTYPE_URL = `http://127.0.0.1:${server.httpServer.address().port}/__history-test`
  browser = await startBrowser('agent-demo-history-window')
  const { evaluate, click } = browser
  const state = () => evaluate('historyHarness.state()')
  await until(() => evaluate('Boolean(window.historyHarness)'), 'history fixture')
  await until(async () => (await state()).ids.length === 150, 'initial complete turn window')
  let current = await state()
  assert.equal(current.total, 90)
  assert.equal(current.hidden, 60)
  assert.equal(current.ids[0], 'a-60-0')
  assert.equal(current.ids.at(-1), 'a-89-4')
  check('initial window contains exactly 30 complete turns including in-turn steering and answers')

  await evaluate(
    `(()=>{const root=document.querySelector('[data-testid=scroller]');root.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));root.scrollTop=250;root.dispatchEvent(new Event('scroll',{bubbles:true}))})()`,
  )
  await wait(40)
  const before = await evaluate(anchorScript)
  await click('[data-testid=earlier]')
  await until(async () => (await state()).hidden === 30, 'older turns revealed')
  const after = await evaluate(anchorScript)
  assert.equal(after.id, before.id)
  assert.ok(Math.abs(after.top - before.top) <= 1, JSON.stringify({ before, after }))
  assert.equal((await state()).following, false)
  check(
    'revealing 30 older turns preserves the first visible row pixel position and releases end following',
  )

  await evaluate('historyHarness.append();historyHarness.extend()')
  await until(async () => (await state()).total === 91, 'new turn appended')
  current = await state()
  assert.equal(current.ids[0], 'a-30-0')
  assert.equal(current.ids.at(-1), 'a-90-4')
  const afterLive = await evaluate(anchorScript)
  assert.equal(afterLive.id, before.id)
  assert.ok(Math.abs(afterLive.top - before.top) <= 1)
  check(
    'stream updates and new turns never slide the visible start or discard previously revealed history',
  )

  const reveal = await evaluate(
    `(async()=>{const ok=await historyHarness.reveal('a-5-3');return{ok,mounted:!!document.querySelector('[data-message-id="a-5-3"]')}})()`,
  )
  assert.deepEqual(reveal, { ok: true, mounted: true })
  await until(async () => (await state()).hidden === 5, 'search turn reveal')
  assert.equal((await state()).ids[0], 'a-5-0')
  assert.equal(await evaluate('historyHarness.reveal("missing")'), false)
  check('search reveal waits for the complete hidden turn to mount; an unknown message is rejected')

  const batched = await evaluate(
    `(async()=>{const results=await Promise.all([historyHarness.reveal('a-3-0'),historyHarness.reveal('a-4-2')]);return{results,mounted:!!document.querySelector('[data-message-id="a-4-2"]')}})()`,
  )
  assert.deepEqual(batched, { results: [true, true], mounted: true })
  await evaluate('historyHarness.earlier();historyHarness.earlier()')
  await until(async () => (await state()).hidden === 0, 'all history shown')
  assert.equal(new Set((await state()).ids).size, 455)
  check(
    'batched search and repeated earlier actions cannot resolve before mount, duplicate rows, or collapse the window',
  )

  const switched = await evaluate(`(async()=>{historyHarness.switch('b',80);return true})()`)
  assert.equal(switched, true)
  await until(
    async () => (await state()).conversationId === 'b' && (await state()).hidden === 50,
    'new conversation reset',
  )
  assert.equal((await state()).ids[0], 'b-50-0')
  const stale = await evaluate(
    `(async()=>{const waiting=historyHarness.reveal('b-2-1');historyHarness.switch('c',40);return await waiting})()`,
  )
  assert.equal(stale, false)
  await until(
    async () => (await state()).conversationId === 'c' && (await state()).hidden === 10,
    'stale reveal isolated',
  )
  check('conversation changes reset the window and reject an old pending search reveal')

  await evaluate('historyHarness.switch("empty",0)')
  await until(async () => (await state()).total === 0, 'empty conversation')
  await evaluate('historyHarness.replace(31)')
  await until(async () => (await state()).hidden === 1, 'delayed snapshot')
  assert.equal((await state()).ids.length, 150)
  await evaluate('historyHarness.replace(5)')
  await until(async () => (await state()).hidden === 0, 'short authoritative replacement')
  assert.equal((await state()).ids.length, 25)
  check(
    'empty initial state and shorter authoritative snapshots retain every available complete turn',
  )
  assert.deepEqual(browser.errors, [])
} catch (error) {
  failure = error
} finally {
  const directory = path.resolve('.test-artifacts/agent-demo-history-window')
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: !failure,
        boundary:
          'Isolated real Chromium hook with the existing follow-scroll controller. No backend, login or model execution; no server pagination.',
        checks,
        sourceHashes: Object.fromEntries(
          await Promise.all(
            sources.map(async (source) => [
              source,
              createHash('sha256')
                .update(await readFile(source))
                .digest('hex'),
            ]),
          ),
        ),
        error: failure?.stack || null,
      },
      null,
      2,
    ),
  )
  await browser?.close()
  await server.close()
}
if (failure) throw failure
