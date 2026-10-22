import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'

const sourceFiles = [
  'web/src/agent-demo/use-chat-scroll.js',
  'web/src/agent-demo/vendor/openchamber/follow-scroll.js',
  'web/src/agent-demo/vendor/openchamber/timeline-scroll-intent.js',
]
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.test-artifacts/**'] } },
  plugins: [
    {
      name: 'isolated-chat-scroll-fixture',
      configureServer(vite) {
        vite.middlewares.use('/__scroll-test', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(
            await vite.transformIndexHtml(
              '/__scroll-test',
              '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px}#scroller::-webkit-scrollbar{width:16px}#scroller::-webkit-scrollbar-thumb{background:#aaa}</style></head><body><div id="root"></div><script type="module" src="/test/helpers/agent-demo-scroll-harness.js"></script></body></html>',
            ),
          )
        })
      },
    },
  ],
})
let browser
let failure
const checks = []
const evidence = []
const check = (name, metrics = {}) => {
  checks.push(name)
  evidence.push({ name, ...metrics })
  console.log(`✓ ${name}`)
}
try {
  await server.listen()
  const port = server.httpServer.address().port
  process.env.PROTOTYPE_URL = `http://127.0.0.1:${port}/__scroll-test`
  browser = await startBrowser('agent-demo-scroll')
  const { evaluate, command } = browser
  await until(() => evaluate('Boolean(window.scrollHarness)'), 'scroll harness')
  const measure = () => evaluate('scrollHarness.measure()')
  const atEnd = () =>
    until(async () => {
      const value = await measure()
      return value.following && Math.abs(value.maximum - value.top) <= 2 && value
    }, 'follow content end')
  const wheel = async (deltaY, target = '#scroller') => {
    const point = await evaluate(
      `(()=>{const r=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`,
    )
    await command('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY })
    await wait(160)
  }
  await atEnd()
  await evaluate('scrollHarness.add(3)')
  check('streamed React content follows its new end', await atEnd())
  await evaluate('scrollHarness.growDOM(160)')
  check('asynchronous Markdown DOM growth follows without parent version change', await atEnd())
  const burstStarted = Date.now()
  await evaluate(
    'new Promise(resolve=>{let count=0;const timer=setInterval(()=>{scrollHarness.growDOM(12);if(++count===30){clearInterval(timer);resolve()}},12)})',
  )
  const burst = await atEnd()
  assert.ok(
    Date.now() - burstStarted < 1500,
    'streaming growth must not accumulate a scroll-animation backlog',
  )
  check('30 rapid DOM updates converge without queued smooth-scroll animations', {
    ...burst,
    elapsedMs: Date.now() - burstStarted,
  })
  await wheel(-200)
  const reading = await measure()
  assert.equal(reading.following, false)
  await evaluate('scrollHarness.add(4)')
  await wait(220)
  assert.ok(Math.abs((await measure()).top - reading.top) <= 1)
  check(
    'real upward wheel releases follow and subsequent stream preserves reading top',
    await measure(),
  )
  await evaluate('scrollHarness.composer(190)')
  await wait(180)
  assert.ok(Math.abs((await measure()).top - reading.top) <= 1)
  check('composer growth preserves the reader position while held', await measure())
  await evaluate('document.querySelector("#scroller").focus()')
  await browser.key('End', 35)
  check('real End key at bottom resumes follow', await atEnd())
  await evaluate('scrollHarness.composer(70)')
  check('viewport contraction and expansion do not accidentally release follow', await atEnd())
  await evaluate('document.querySelector("#nested").scrollTop=200')
  await wheel(-65, '#nested')
  assert.equal((await measure()).following, true)
  assert.ok(await evaluate('document.querySelector("#nested").scrollTop < 200'))
  check('wheel inside scrollable tool output leaves outer follow enabled', await measure())
  await evaluate('document.querySelector("#scroller").focus()')
  await browser.key('PageUp', 33)
  await wait(220)
  assert.equal((await measure()).following, false)
  check('PageUp releases follow before the next streamed chunk', await measure())
  const aPosition = (await measure()).top
  await evaluate('scrollHarness.switch("b")')
  await atEnd()
  await wheel(-170)
  const bPosition = (await measure()).top
  await evaluate('scrollHarness.switch("a")')
  await wait(120)
  assert.ok(Math.abs((await measure()).top - aPosition) <= 1)
  assert.equal((await measure()).following, false)
  await evaluate('scrollHarness.switch("b")')
  await wait(120)
  assert.ok(Math.abs((await measure()).top - bPosition) <= 1)
  check('switching conversations restores each held position and follow state', {
    aPosition,
    bPosition,
  })
  await evaluate('scrollHarness.latest()')
  await atEnd()
  const track = await evaluate(
    '(()=>{const n=document.querySelector("#scroller"),r=n.getBoundingClientRect();return{x:r.right-7,y:r.top+30}})()',
  )
  await command('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...track,
    button: 'left',
    clickCount: 1,
  })
  await wait(80)
  await command('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...track,
    button: 'left',
    clickCount: 1,
  })
  await wait(250)
  assert.equal((await measure()).following, false)
  check('native scrollbar track interaction releases follow', await measure())
  await command('Emulation.setTouchEmulationEnabled', { enabled: true })
  await browser.viewport(390, 844)
  await evaluate('scrollHarness.latest()')
  await atEnd()
  const touch = await evaluate(
    '(()=>{const r=document.querySelector("#scroller").getBoundingClientRect();return{x:r.left+100,y:r.top+180}})()',
  )
  await command('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...touch, radiusX: 3, radiusY: 3, id: 1 }],
  })
  for (let i = 1; i <= 5; i++) {
    await command('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: touch.x, y: touch.y + i * 22, radiusX: 3, radiusY: 3, id: 1 }],
    })
    await wait(20)
  }
  await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await wait(300)
  assert.equal((await measure()).following, false)
  check('mobile upward reading swipe releases follow', await measure())
  // Let the browser's native fling settle before testing a new explicit action.
  await wait(650)
  await command('Emulation.setTouchEmulationEnabled', { enabled: false })
  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  await evaluate('scrollHarness.latest()')
  await atEnd()
  const reduced = await evaluate(
    'new Promise(resolve=>{const before=scrollHarness.measure();const started=performance.now();const frames=[];scrollHarness.growDOM(200);const sample=()=>{frames.push({...scrollHarness.measure(),elapsed:performance.now()-started});if(frames.length===6)resolve({before,frames});else requestAnimationFrame(sample)};requestAnimationFrame(sample)})',
  )
  assert.ok(reduced.frames.some((frame) => Math.abs(frame.maximum - frame.top) <= 2))
  assert.ok(
    reduced.frames.every(
      (frame) =>
        Math.abs(frame.top - reduced.before.top) <= 2 || Math.abs(frame.maximum - frame.top) <= 2,
    ),
    'reduced motion must jump directly to the new end, without intermediate glide positions',
  )
  check('reduced motion jumps directly to the resized end without animated catch-up', reduced)
  assert.equal(browser.errors.length, 0, browser.errors.join('\n'))
} catch (error) {
  failure = error
  console.error(error)
} finally {
  const output = path.resolve('.test-artifacts/agent-demo-scroll')
  await mkdir(output, { recursive: true })
  const hashes = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  )
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: !failure,
        boundary:
          'Real Chromium isolated React/DOM scroll fixture; no Agent/model/server/login verification.',
        checks,
        evidence,
        sourceHashes: hashes,
        error: failure?.message ?? null,
      },
      null,
      2,
    ),
  )
  await browser?.close()
  await server.close()
}
if (failure) process.exitCode = 1
