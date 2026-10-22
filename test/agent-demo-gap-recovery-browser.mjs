import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.test-artifacts/**'] } },
  plugins: [
    {
      name: 'controlled-gap-fixture',
      configureServer(vite) {
        vite.middlewares.use('/__gap-test', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(
            await vite.transformIndexHtml(
              '/__gap-test',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/test/helpers/agent-demo-gap-harness.js"></script></body></html>',
            ),
          )
        })
      },
    },
  ],
})
const report = {
  at: new Date().toISOString(),
  mode: 'real-react-hook-controlled-browser-transports',
  realModelCalls: 0,
  checks: [],
  failures: [],
  observations: [],
}
let browser
try {
  await server.listen()
  process.env.PROTOTYPE_URL = `http://127.0.0.1:${server.httpServer.address().port}/__gap-test`
  browser = await startBrowser('agent-demo-gap-recovery')
  const { evaluate } = browser
  const reset = async () => {
    await browser.command('Page.reload')
    await until(() => evaluate('window.gapHarness?.ready()'), 'hook ready')
  }
  const state = () => evaluate('gapHarness.snapshot()')
  const requests = () => evaluate('gapHarness.requests()')
  const send = (event) => evaluate(`gapHarness.send(${JSON.stringify(event)})`)
  const resolve = (index, snapshot) =>
    evaluate(`gapHarness.resolve(${index},${JSON.stringify(snapshot)})`)
  const frames = () =>
    evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))',
    )
  const waitRequests = (count) =>
    until(async () => (await requests()).length >= count, `${count} repair requests`)
  const gap = () =>
    send({
      type: 'message.delta',
      seq: 3,
      payload: {
        revision: 3,
        messageId: 'assistant-gap',
        delta: 'C',
        timelineDelta: { id: 'text-gap', type: 'text', offset: 2, delta: 'C' },
      },
    })
  const usage = (seq = 4) =>
    send({
      type: 'turn.usage.updated',
      seq,
      payload: { revision: seq, usage: { totalTokens: seq } },
    })
  const reasoning = (seq = 5) =>
    send({
      type: 'reasoning.delta',
      seq,
      payload: {
        revision: seq,
        timelineDelta: {
          id: 'reasoning-gap',
          type: 'reasoning',
          mode: 'replace',
          delta: `R${seq}`,
        },
      },
    })
  const verify = async (name, action) => {
    await reset()
    try {
      await action()
      report.checks.push(name)
      console.log(`✓ ${name}`)
    } catch (error) {
      report.failures.push({ name, error: error.stack })
      console.error(`✗ ${name}: ${error.message}`)
    }
  }
  await verify(
    'gap locks compact deltas until a sufficiently new snapshot; stale GET retries',
    async () => {
      await gap()
      await waitRequests(1)
      await usage()
      await reasoning()
      await frames()
      const dirty = await state()
      assert.equal(dirty._appliedSeq, 1)
      assert.equal(dirty.revision, 1)
      assert.equal(dirty.messages[0].content, 'A')
      assert.equal(dirty.turns[0].usage, null)
      assert.equal(dirty.turns[0].timeline.length, 1)
      await resolve(0, { seq: 3, text: 'ABC' })
      await waitRequests(2)
      assert.equal((await state())._appliedSeq, 3)
      await resolve(1, { seq: 5, text: 'ABC', reasoning: 'R5', usage: { totalTokens: 4 } })
      await until(async () => (await state())?._appliedSeq === 5, 'new snapshot accepted')
      await send({
        type: 'message.delta',
        seq: 6,
        payload: {
          revision: 6,
          messageId: 'assistant-gap',
          delta: 'D',
          timelineDelta: { id: 'text-gap', type: 'text', offset: 3, delta: 'D' },
        },
      })
      await frames()
      const healed = await state()
      assert.equal(healed.messages[0].content, 'ABCD')
      assert.equal(healed.turns[0].timeline[0].text, 'ABCD')
      assert.equal(healed.turns[0].timeline[1].text, 'R5')
      assert.equal(healed._appliedSeq, 6)
      await wait(100)
      assert.equal((await requests()).length, 2)
      report.observations.push({
        case: 'gap-and-stale',
        dirtyAppliedSeq: dirty._appliedSeq,
        healedAppliedSeq: healed._appliedSeq,
        reads: await requests(),
      })
    },
  )
  await verify(
    'failed GET preserves dirty state and retries even without another event',
    async () => {
      await gap()
      await waitRequests(1)
      await usage()
      await reasoning()
      await frames()
      // No event arrives after the failure: the repair timer itself must wake it.
      await evaluate('gapHarness.fail(0)')
      assert.equal((await state())._appliedSeq, 1)
      await waitRequests(2)
      await resolve(1, { seq: 5, text: 'ABC', reasoning: 'R5', usage: { totalTokens: 4 } })
      await until(async () => (await state())?._appliedSeq === 5, 'retry heals dirty state')
      const reads = await requests()
      assert.ok(
        reads[1].at - reads[0].at >= 900,
        'failure retry should back off instead of spinning',
      )
      report.observations.push({ case: 'failed-get', reads })
    },
  )
  await verify('failure backoff also holds while newer compact events arrive', async () => {
    await gap()
    await waitRequests(1)
    await evaluate('gapHarness.fail(0)')
    await wait(80)
    await usage()
    await reasoning()
    await frames()
    await wait(100)
    assert.equal(
      (await requests()).length,
      1,
      'new events must not bypass the scheduled repair backoff',
    )
    assert.equal((await state())._appliedSeq, 1)
    await waitRequests(2)
    await resolve(1, { seq: 5, text: 'ABC', reasoning: 'R5', usage: { totalTokens: 4 } })
    await until(async () => (await state())?._appliedSeq === 5, 'repair after backoff')
    const reads = await requests()
    assert.ok(reads[1].at - reads[0].at >= 900)
    report.observations.push({ case: 'backoff-with-events', reads })
  })
  await verify(
    'SSE deletion wins over an in-flight snapshot and cancels recovery retries',
    async () => {
      await gap()
      await waitRequests(1)
      await send({ type: 'conversation.deleted', seq: 6, payload: {} })
      await frames()
      await resolve(0, { seq: 1 })
      await wait(180)
      assert.equal(await state(), null)
      assert.equal((await requests()).length, 1)
      assert.equal(
        (await evaluate('gapHarness.timers()')).filter((timer) => timer.delay === 30).length,
        0,
      )
    },
  )
  await verify('local deletion cancels failed recovery without recurring 30ms timers', async () => {
    await gap()
    await waitRequests(1)
    await evaluate('gapHarness.remove();gapHarness.fail(0)')
    await wait(1250)
    assert.equal(await state(), null)
    assert.equal((await requests()).length, 1)
    const timers = await evaluate('gapHarness.timers()')
    report.observations.push({ case: 'local-delete', timers })
    assert.equal(
      timers.filter((timer) => timer.delay === 30).length,
      0,
      'a deleted conversation must not run an endless empty repair loop',
    )
  })
  await verify('unmount clears scheduled recovery after a failed read', async () => {
    await gap()
    await waitRequests(1)
    await evaluate('gapHarness.fail(0)')
    await wait(30)
    await evaluate('gapHarness.unmount()')
    await wait(1100)
    assert.equal((await requests()).length, 1)
  })
  report.runtimeErrors = browser.errors
} finally {
  report.passed = !report.failures.length && !report.runtimeErrors?.length
  report.sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        'web/src/agent-demo/use-demo.js',
        'web/src/agent-demo/timeline.js',
        'web/src/agent-demo/api.js',
      ].map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  )
  const output = path.resolve('.test-artifacts/agent-demo-gap-recovery')
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  await server.close()
}
if (!report.passed) process.exitCode = 1
