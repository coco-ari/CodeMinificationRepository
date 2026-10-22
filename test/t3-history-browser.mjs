// Scale test against a real native server containing the separately generated
// canonical synthetic fixture. No browser store/event injection and no model calls.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'
const origin = process.env.AGENT_DEMO_URL || 'http://127.0.0.1:19087',
  threadId = 'synthetic-history-1000'
if (new URL(origin).hostname !== '127.0.0.1' || new URL(origin).port !== '19087')
  throw new Error('This scale test only reads the dedicated local synthetic server 19087')
const output = path.resolve(
  process.env.T3_UI_OUTPUT || '.test-artifacts/t3-history-1000-20261021-v2/scale-browser',
)
await mkdir(output, { recursive: true })
const report = {
  synthetic: true,
  modelCalls: 0,
  origin,
  threadId,
  startedAt: new Date().toISOString(),
  requests: [],
  frames: [],
  samples: [],
  pageErrors: [],
}
const client = new T3LiveClient(origin),
  browser = await chromium.launch(),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  cdp = await page.context().newCDPSession(page)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, label) => {
  for (let i = 0; i < 160; i++) {
    const v = await fn()
    if (v) return v
    await delay(200)
  }
  throw new Error('Timeout ' + label)
}
const sample = async (label) => {
  const metrics = await cdp.send('Performance.getMetrics'),
    dom = await page.evaluate(() => {
      const scroll = document.querySelector('.messages-timeline-scroll')
      const rows = [...document.querySelectorAll('[data-message-id]')],
        bounds = scroll?.getBoundingClientRect()
      const first = rows
        .filter(
          (row) =>
            row.getBoundingClientRect().bottom > (bounds?.top || 0) &&
            row.getBoundingClientRect().top < (bounds?.bottom || 0),
        )
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
      return {
        documentNodes: document.querySelectorAll('*').length,
        renderedMessages: rows.length,
        scrollTop: scroll?.scrollTop,
        scrollHeight: scroll?.scrollHeight,
        anchor: first
          ? {
              id: first.getAttribute('data-message-id'),
              offset: first.getBoundingClientRect().top - (bounds?.top || 0),
            }
          : null,
      }
    })
  const row = {
    label,
    at: Date.now(),
    ...dom,
    jsHeapUsedBytes: metrics.metrics.find((x) => x.name === 'JSHeapUsedSize')?.value,
  }
  report.samples.push(row)
  return row
}
page.on('pageerror', (error) => report.pageErrors.push(error.message))
const requests = new Map()
cdp.on('Network.requestWillBeSent', (event) =>
  requests.set(event.requestId, { url: event.request.url, started: event.timestamp }),
)
cdp.on('Network.loadingFinished', (event) => {
  const req = requests.get(event.requestId)
  if (req?.url.includes('/api/orchestration/threads/'))
    report.requests.push({
      path: new URL(req.url).pathname,
      query: new URL(req.url).search,
      bytes: event.encodedDataLength,
      ms: (event.timestamp - req.started) * 1000,
    })
})
page.on('websocket', (socket) =>
  socket.on('framereceived', ({ payload }) =>
    report.frames.push({ bytes: Buffer.byteLength(payload), at: Date.now() }),
  ),
)
try {
  await cdp.send('Performance.enable')
  await cdp.send('Network.enable')
  await client.login()
  await client.connect()
  const config = await client.rpc('server.getConfig')
  const initial = (await client.http(`/api/orchestration/threads/${threadId}`)).projection
  assert.equal(initial.runs.length, 1000)
  assert.equal(initial.providerThreads.length, 0)
  report.fixture = {
    turns: initial.runs.length,
    messages: initial.messages.length,
    providerThreads: 0,
  }
  await page.goto(origin + '/agent-demo.html')
  await page.getByRole('textbox', { name: '用户名' }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill('Demo123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByTestId('composer-editor').waitFor({ state: 'visible' })
  await page.evaluate(() => {
    window.__scaleLongTasks = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        window.__scaleLongTasks.push({ duration: e.duration, start: e.startTime })
    }).observe({ type: 'longtask' })
  })
  const started = Date.now()
  await page.goto(`${origin}/agent-demo.html#/${config.environment.environmentId}/${threadId}`)
  await page.locator('[data-message-id]').first().waitFor()
  await delay(500)
  const dismiss = page.getByRole('button', { name: /Dismiss Codex provider/ })
  if (await dismiss.isVisible()) {
    report.dismissedExpectedFakeRunnerBanner = true
    await dismiss.click()
  }
  report.firstHistoryVisibleMs = Date.now() - started
  await sample('initial-bounded-window')
  for (let n = 0; n < 3; n++) {
    await page
      .locator('.messages-timeline-scroll')
      .evaluate((node) => node.scrollTo({ top: 0, behavior: 'instant' }))
    await delay(250)
    const button = page.getByRole('button', { name: 'Load earlier turns', exact: true })
    await button.waitFor({ state: 'visible' })
    const before = await sample(`page-${n + 1}-before`)
    const count = report.requests.length
    await button.click()
    await until(() => report.requests.length > count, 'real history HTTP page')
    await until(() => button.isEnabled(), 'history merge')
    await delay(350)
    const after = await sample(`page-${n + 1}-after`)
    const retained =
      before.anchor &&
      (await page.locator('[data-message-id]').evaluateAll((nodes, id) => {
        const node = nodes.find((n) => n.getAttribute('data-message-id') === id)
        const container = document.querySelector('.messages-timeline-scroll')
        return node && container
          ? node.getBoundingClientRect().top - container.getBoundingClientRect().top
          : null
      }, before.anchor.id))
    report.samples.at(-1).anchorDelta = retained === null ? null : retained - before.anchor.offset
    report.samples.at(-1).retainedAnchorId = before.anchor?.id
    report.samples.at(-1).retainedAnchorMounted = retained !== null
  }
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  await page.getByRole('searchbox', { name: 'Find in thread', exact: true }).fill('编号1。')
  await until(
    async () => /1\/1/.test(await page.locator('[data-thread-find-bar]').innerText()),
    'earliest server search',
  )
  await page.getByRole('button', { name: 'Next match', exact: true }).click()
  await until(
    async () =>
      await page.locator('[data-message-role="user"]').filter({ hasText: '编号1。' }).count(),
    'earliest paged message loaded',
  )
  await sample('search-jump-earliest')
  await page
    .getByRole('button', { name: /^Worked for/ })
    .first()
    .click()
  await delay(200)
  const tool = page.getByRole('button', { name: /读取项目资料/ }).first()
  await tool.click()
  await until(
    async () =>
      await page
        .locator('body')
        .innerText()
        .then((text) => text.includes('x'.repeat(100))),
    'large tool output opened natively',
  )
  report.largeToolExpanded = true
  await sample('large-tool-expanded')
  await page.screenshot({ path: path.join(output, 'history-earliest.png') })
  report.longTasks = await page.evaluate(() => window.__scaleLongTasks)
  assert.ok(report.requests.some((r) => r.path.endsWith('/history')))
  assert.ok(
    Math.max(...report.samples.map((s) => s.renderedMessages)) < 100,
    'timeline rendered too many messages',
  )
  assert.equal(report.pageErrors.length, 0)
  for (const sample of report.samples.filter((x) => x.label.endsWith('-after'))) {
    assert.equal(sample.retainedAnchorMounted, true)
    assert.ok(Math.abs(sample.anchorDelta) < 2, 'history prepend moved reading anchor')
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.message
  process.exitCode = 1
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
} finally {
  report.completedAt = new Date().toISOString()
  report.frameSummary = {
    count: report.frames.length,
    totalBytes: report.frames.reduce((n, r) => n + r.bytes, 0),
    maxBytes: Math.max(0, ...report.frames.map((r) => r.bytes)),
  }
  delete report.frames
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  client.close()
  await browser.close()
  console.log(
    JSON.stringify({
      output,
      status: report.status,
      error: report.error,
      samples: report.samples,
      requests: report.requests.length,
    }),
  )
}
