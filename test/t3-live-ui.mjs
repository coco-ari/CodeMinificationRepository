import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance as nodePerformance } from 'node:perf_hooks'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

// Real browser/native RPC acceptance. No fake model events, projections, or seeded
// browser stores. Run only after the parent confirms that this isolated stage is current.
if (process.env.T3_UI_LIVE !== '1')
  throw new Error('Set T3_UI_LIVE=1 after confirming the isolated stage is ready.')
const origin = new URL(process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').origin
if (new URL(origin).port === '8787')
  throw new Error('Production port 8787 is excluded from this test.')
const selected = new Set(
  (process.env.T3_UI_CASES || 'flow,history,mobile,reconnect,queue,shared-edit').split(','),
)
const runId = new Date().toISOString().replaceAll(':', '-'),
  marker = `UI-${randomUUID().slice(0, 8)}`
const output = path.resolve(process.env.T3_UI_OUTPUT || `.test-artifacts/t3-live/ui-${runId}`)
await mkdir(output, { recursive: true })
const report = {
  startedAt: new Date().toISOString(),
  origin,
  kind: 'real-native-browser',
  marker,
  steps: [],
  threads: [],
  pageErrors: [],
  httpFailures: [],
  rpc: [],
  limitations: [
    'Network interruption uses real Chromium offline mode on the browser; it does not isolate the server.',
    'Only newly created test threads are mutated. The existing 60-round thread is read-only.',
  ],
}
const browser = await chromium.launch({ headless: process.env.T3_UI_HEADED !== '1' })
const reader = new T3LiveClient(origin),
  contexts = [],
  terminal = (run) =>
    run && ['completed', 'failed', 'interrupted', 'cancelled'].includes(run.status)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const save = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
const summarize = (projection) => ({
  threadId: projection.thread.id,
  runCount: projection.runs.length,
  statuses: projection.runs.map((run) => ({
    id: run.id,
    status: run.status,
    userMessageId: run.userMessageId,
  })),
  nativeThreads: projection.providerThreads
    .map((thread) => thread.nativeThreadRef?.nativeId)
    .filter(Boolean),
  rollbackSafety: projection.thread.rollbackSafety,
})
async function until(read, label, timeout = 180000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await read()
    if (value) return value
    await delay(250)
  }
  throw new Error(`Timed out: ${label}`)
}
async function snapshot(threadId) {
  return (await reader.http(`/api/orchestration/threads/${encodeURIComponent(threadId)}`))
    .projection
}
async function finished(threadId, minimumRuns = 1, timeout = 240000) {
  return until(
    async () => {
      const p = await snapshot(threadId)
      return p.runs.length >= minimumRuns && p.runs.every(terminal) ? p : null
    },
    'native terminal run',
    timeout,
  )
}
async function step(name, action) {
  const row = { name, startedAt: new Date().toISOString() }
  report.steps.push(row)
  await save()
  try {
    row.result = await action()
    row.status = 'passed'
  } catch (error) {
    row.status = 'failed'
    row.error = error.message
    row.detail = error.detail
    if (name === 'streaming-scroll-refresh' && main?.page && !main.page.isClosed())
      row.partialMetrics = await main.page
        .evaluate(() => window.__t3UiProbe?.finish())
        .catch(() => null)
    if (main?.page && !main.page.isClosed())
      row.failureScreenshot = await shot(main.page, `failed-${name}`).catch(() => null)
    if (main?.page && !main.page.isClosed())
      await main.page.keyboard.press('Escape').catch(() => {})
    process.exitCode = 1
  }
  row.completedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ name, status: row.status, error: row.error }))
  return row
}
function observe(page, name) {
  page.on('response', (response) => {
    if (response.status() >= 400)
      report.httpFailures.push({
        page: name,
        status: response.status(),
        path: new URL(response.url()).pathname,
      })
  })
  page.on('pageerror', (error) =>
    report.pageErrors.push({ page: name, at: Date.now(), error: error.message }),
  )
  page.on('websocket', (socket) => {
    const requests = new Map()
    socket.on('framesent', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload))
        if (frame._tag === 'Request') {
          const row = {
            page: name,
            at: Date.now(),
            sentMono: nodePerformance.now(),
            direction: 'sent',
            method: frame.tag,
            type: frame.payload?.type,
            threadId: frame.payload?.threadId,
            commandId: frame.payload?.commandId,
            messageId: frame.payload?.messageId,
            sourcePlanRef:
              frame.payload?.initialMessage?.sourcePlanRef ?? frame.payload?.sourcePlanRef,
            requestId: frame.id,
          }
          report.rpc.push(row)
          requests.set(String(frame.id), row)
        }
      } catch {}
    })
    socket.on('framereceived', ({ payload }) => {
      try {
        const decoded = JSON.parse(String(payload))
        for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
          const row = requests.get(String(frame.requestId))
          if (frame._tag === 'Exit' && row) {
            row.ackAt = Date.now()
            row.ackMono = nodePerformance.now()
            row.ackStatus = frame.exit?._tag
            requests.delete(String(frame.requestId))
          }
        }
      } catch {}
    })
  })
}
async function login(name = 'admin', viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport })
  contexts.push(context)
  if (selected.has('reconnect') && process.env.T3_UI_CLOSE_WS === '1') {
    context.__nativeSockets = []
    await context.routeWebSocket('**/api/agent-demo/t3/ws*', (route) => {
      const server = route.connectToServer()
      context.__nativeSockets.push({ route, server })
      report.websocketConnections = (report.websocketConnections || 0) + 1
      route.onMessage((payload) => {
        // Read command metadata and forward the exact original bytes; no generated frames.
        try {
          const frame = JSON.parse(String(payload))
          if (frame._tag === 'Request')
            report.rpc.push({
              page: name,
              at: Date.now(),
              direction: 'sent-through-transparent-proxy',
              method: frame.tag,
              type: frame.payload?.type,
              threadId: frame.payload?.threadId,
              commandId: frame.payload?.commandId,
              messageId: frame.payload?.messageId,
            })
        } catch {}
        server.send(payload)
      })
    })
  }
  const page = await context.newPage()
  observe(page, name)
  await page.goto(origin + '/agent-demo.html')
  await page.getByRole('textbox', { name: '用户名' }).fill(name)
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByTestId('composer-editor').waitFor({ state: 'visible', timeout: 60000 })
  return { page, context }
}
const editor = (page) => page.getByTestId('composer-editor')
async function fill(page, text) {
  await editor(page).fill(text)
}
async function shot(page, name) {
  const filename = `${name}.png`
  await page.screenshot({ path: path.join(output, filename), fullPage: false })
  return filename
}
function routeThread(page) {
  const parts = new URL(page.url()).hash.slice(1).split('/').filter(Boolean)
  return parts.length === 2 && parts[0] !== 'draft'
    ? { environmentId: parts[0], threadId: parts[1] }
    : null
}
async function openThread(page, threadId, environmentId) {
  await page.goto(`${origin}/agent-demo.html#/${environmentId}/${threadId}`)
  await editor(page).waitFor({ state: 'visible', timeout: 60000 })
  await until(
    async () =>
      (await page.locator('[data-autoops-thread-scope]').innerText()).includes('项目助手'),
    'scope loaded',
    30000,
  )
}
async function enableNativePlanMode(page) {
  const current = page.url()
  await page.goto(`${origin}/agent-demo.html#/settings/general`)
  await page.getByRole('button', { name: 'Legacy features', exact: true }).click()
  const toggle = page.getByRole('switch', { name: 'Plan mode (legacy)', exact: true })
  await toggle.waitFor({ state: 'visible' })
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click()
  assert.equal(await toggle.getAttribute('aria-checked'), 'true')
  await page.goto(current)
  await editor(page).waitFor({ state: 'visible' })
}
async function newDraft(page, visibility = 'private') {
  if (routeThread(page)) {
    const toggle = page.getByRole('button', { name: 'Toggle main sidebar', exact: true })
    if (
      !(await page.getByRole('button', { name: 'New thread', exact: true }).isVisible()) &&
      (await toggle.isVisible())
    )
      await toggle.click()
    await page.getByRole('button', { name: 'New thread', exact: true }).click()
    await until(
      async () => {
        if (new URL(page.url()).hash.startsWith('#/draft/')) return true
        const option = page.getByRole('option').filter({ hasText: 'AutoOps 工作台' }).first()
        if (await option.isVisible()) {
          await option.click()
          return true
        }
        return false
      },
      'native project selection or draft route',
      30000,
    )
    await until(
      () => new URL(page.url()).hash.startsWith('#/draft/'),
      'new native draft route',
      30000,
    )
  }
  await editor(page).waitFor({ state: 'visible' })
  const project = page.locator('[data-draft-project-trigger]')
  if (await project.count()) {
    await project.click()
    const option = page.getByRole('option').filter({ hasText: 'AutoOps 工作台' }).first()
    await option.click()
  }
  const scope = page.getByLabel('会话可见范围', { exact: true })
  await scope.waitFor({ state: 'visible', timeout: 30000 })
  {
    await scope.click()
    await page
      .getByRole('option', { name: visibility === 'project' ? '项目共享' : '仅自己', exact: true })
      .click()
  }
}
async function send(page, text, { queue = false } = {}) {
  await fill(page, text)
  const submit = page
    .getByRole('button', {
      name: /^(Submit message|Steer message|Queue message|Compact and send)$/,
    })
    .last()
  await submit.waitFor({ state: 'visible' })
  const label = await submit.getAttribute('aria-label')
  await submit.click(
    queue && label === 'Steer message'
      ? { modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] }
      : {},
  )
  await until(
    async () => !(await editor(page).innerText()).includes(text),
    'accepted matching composer draft',
    30000,
  )
  return until(() => routeThread(page), 'native route created', 30000)
}
async function newThread(page, text, visibility = 'private') {
  await newDraft(page, visibility)
  const ref = await send(page, text)
  report.threads.push({ ...ref, visibility })
  await save()
  console.log(JSON.stringify({ createdTestThread: ref.threadId, visibility }))
  return ref
}
async function probe(page) {
  await page.evaluate(() => {
    const startedAt = Date.now(),
      samples = []
    let clickedAt = null,
      clickEpoch = null,
      clickedPrompt = '',
      clickedSubmit = null,
      firstLocalFeedback = null,
      localFeedbackKind = null
    const captureSubmit = (event) => {
      const button = event.target.closest?.('button')
      if (
        clickedAt !== null ||
        !button ||
        !/^(Submit message|Steer message|Queue message|Compact and send)$/.test(
          button.getAttribute('aria-label') || '',
        )
      )
        return
      clickedAt = performance.now()
      clickEpoch = Date.now()
      clickedSubmit = button
      clickedPrompt = document.querySelector('[data-testid=composer-editor]')?.textContent || ''
    }
    document.addEventListener('click', captureSubmit, true)
    let firstWork = null,
      firstText = null,
      lastText = ''
    const read = () => {
      if (clickedAt !== null && firstLocalFeedback === null) {
        const currentPrompt =
          document.querySelector('[data-testid=composer-editor]')?.textContent || ''
        if (clickedSubmit?.disabled || clickedSubmit?.getAttribute('aria-busy') === 'true')
          localFeedbackKind = 'submit-pending'
        else if (clickedPrompt.trim() && !currentPrompt.trim())
          localFeedbackKind = 'composer-cleared'
        if (localFeedbackKind) firstLocalFeedback = performance.now() - clickedAt
      }
      const activity =
        document.querySelector('[aria-label="Stop generation"]') ||
        document.querySelector('[data-chat-composer-activity-strip]')
      const texts = [...document.querySelectorAll('[data-message-role="assistant"]')]
        .map((node) => node.textContent || '')
        .join('\n')
      if (activity && !firstWork) firstWork = Date.now() - startedAt
      if (texts.length > 0 && !firstText) firstText = Date.now() - startedAt
      if (texts !== lastText) {
        samples.push({ ms: Date.now() - startedAt, characters: texts.length })
        lastText = texts
      }
    }
    const observer = new MutationObserver(read)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    const longTasks = []
    let performanceObserver
    try {
      performanceObserver = new PerformanceObserver((list) => {
        for (const item of list.getEntries())
          longTasks.push({ startTime: item.startTime, duration: item.duration })
      })
      performanceObserver.observe({ type: 'longtask', buffered: false })
    } catch {}
    window.__t3UiProbe = {
      finish: () => {
        observer.disconnect()
        performanceObserver?.disconnect()
        document.removeEventListener('click', captureSubmit, true)
        read()
        return {
          startedAt,
          clickEpoch,
          firstLocalFeedbackMs: firstLocalFeedback,
          localFeedbackKind,
          firstWorkMs: firstWork,
          firstTextMs: firstText,
          samples,
          longTasks,
        }
      },
    }
  })
}
async function measureQueuedFeedback(page, ref) {
  const samples = []
  for (let index = 0; index < 30; index++) {
    assert.ok(
      (await snapshot(ref.threadId)).runs.some((run) => run.status === 'running'),
      'source must still be running',
    )
    const before = report.rpc.length
    await probe(page)
    await send(page, `队列提交响应验收 ${marker} ${index + 1}，本条会在执行前取消。`, {
      queue: true,
    })
    const receipt = await until(
      () => report.rpc.slice(before).find((row) => row.type === 'message.dispatch' && row.ackAt),
      'real dispatch receipt',
      30000,
    )
    assert.equal(receipt.ackStatus, 'Success')
    const local = await page.evaluate(() => window.__t3UiProbe.finish())
    assert.ok(local.firstLocalFeedbackMs !== null, 'actual local feedback must be observed')
    const cancel = page.getByRole('button', { name: 'Remove queued message', exact: true }).last()
    await cancel.waitFor({ state: 'visible' })
    await cancel.click()
    await until(
      async () => !(await snapshot(ref.threadId)).runs.some((run) => run.status === 'queued'),
      'cancelled owned sample',
    )
    samples.push({
      index: index + 1,
      localFeedbackMs: local.firstLocalFeedbackMs,
      feedbackKind: local.localFeedbackKind,
      receiptMonoMs: receipt.ackMono - receipt.sentMono,
      clock: 'Node performance.now; WebSocket sent to Exit Success',
      commandId: receipt.commandId,
    })
    report.feedbackSamples = samples
    await save()
  }
  const percentile = (key) =>
    [...samples].map((row) => row[key]).sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]
  return {
    sampleCount: samples.length,
    localFeedbackP95Ms: percentile('localFeedbackMs'),
    localFeedbackClock: 'Browser performance.now; click to changed DOM',
    localFeedbackTargetMs: 100,
    localFeedbackTargetMet: percentile('localFeedbackMs') <= 100,
    durableReceiptP95Ms: percentile('receiptMonoMs'),
    durableReceiptClock: 'Node performance.now; WebSocket sent to Exit Success',
    samples,
  }
}
async function scrollState(page) {
  return page.locator('.messages-timeline-scroll').evaluate((node) => ({
    top: node.scrollTop,
    height: node.scrollHeight,
    viewport: node.clientHeight,
    bottomGap: node.scrollHeight - node.clientHeight - node.scrollTop,
  }))
}
const longPrompt = `本轮是网页交互验收，标记${marker}。请直接输出一份详细的测试环境发布准备说明，分40个小节，每节至少80字，包含Markdown标题、列表和一个6行表格；明确资料是假设的测试数据，不调用工具，不创建文件，不向我提问。请完整写完，不要省略。`
let main, streamingRef
try {
  await reader.login()
  await reader.connect()
  report.model = reader.bootstrap.fixedModel
  main = await login()
  if (selected.has('flow'))
    await step('streaming-scroll-refresh', async () => {
      const { page } = main
      await newDraft(page)
      await probe(page)
      const started = Date.now()
      streamingRef = await send(page, longPrompt)
      report.threads.push({ ...streamingRef, visibility: 'private' })
      await save()
      await until(async () => {
        const scroll = await scrollState(page)
        const real = await page.locator('[data-message-role=assistant]').evaluateAll((nodes) => ({
          characters: nodes.reduce((n, node) => n + (node.textContent || '').length, 0),
          height: nodes.reduce((n, node) => n + node.getBoundingClientRect().height, 0),
        }))
        return real.characters > 1800 && real.height > scroll.viewport + 700 && scroll.top > 700
      }, 'actual response content (not native anchor spacer) overflows viewport')
      const follow = await scrollState(page)
      const viewport = page.locator('.messages-timeline-scroll')
      await viewport.hover()
      await page.mouse.wheel(0, -700)
      await delay(350)
      const heldStart = await scrollState(page)
      await delay(1800)
      const heldEnd = await scrollState(page)
      report.steps.at(-1).partialScroll = { follow, heldStart, heldEnd }
      await save()
      assert.ok(heldEnd.bottomGap > 100, 'manual upward reading unexpectedly snapped to the bottom')
      const returned = page.getByRole('button', { name: 'Scroll to end', exact: true })
      await returned.click()
      await delay(500)
      const afterReturn = await scrollState(page)
      const final = await finished(streamingRef.threadId)
      assert.equal(final.runs.at(-1).status, 'completed')
      const metrics = await page.evaluate(() => window.__t3UiProbe.finish())
      metrics.completedMs = Date.now() - started
      assert.ok(metrics.firstTextMs !== null, 'no actual assistant DOM text observed')
      const before = summarize(final)
      const screenshot = await shot(page, 'streaming-complete')
      await page.reload()
      await editor(page).waitFor({ state: 'visible', timeout: 60000 })
      const after = summarize(await snapshot(streamingRef.threadId))
      assert.deepEqual(after.nativeThreads, before.nativeThreads)
      assert.equal(after.runCount, before.runCount)
      return {
        ...metrics,
        scroll: { follow, heldStart, heldEnd, afterReturn },
        before,
        after,
        screenshot,
      }
    })
  if (selected.has('feedback'))
    await step('real-first-work-feedback', async () => {
      const { page } = main
      await newDraft(page)
      await probe(page)
      const started = Date.now()
      const ref = await send(
        page,
        `即时反馈验收${marker}。请只用两句话说明发布前备份的重要性，不调用工具。`,
      )
      report.threads.push({ ...ref, visibility: 'private' })
      await save()
      const final = await finished(ref.threadId)
      assert.equal(final.runs.at(-1).status, 'completed')
      const metrics = await page.evaluate(() => window.__t3UiProbe.finish())
      assert.ok(metrics.firstWorkMs !== null, 'no visible native stop/working feedback')
      return {
        ...ref,
        ...metrics,
        completedMs: Date.now() - started,
        screenshot: await shot(page, 'work-feedback-complete'),
      }
    })
  if (selected.has('history'))
    await step('sixty-round-pagination-and-search', async () => {
      const threadId = process.env.T3_UI_HISTORY_THREAD || '4c5611b3-571a-44a3-a98b-80f317d9e5be'
      const existing = await snapshot(threadId)
      const initial = existing.messages.find((message) => message.role === 'user')
      assert.ok(existing.runs.length >= 60)
      assert.ok(initial)
      const search = initial.text.match(/原生记忆标记-[\w-]+/)?.[0] || initial.text.slice(0, 24)
      const environmentId =
        streamingRef?.environmentId ||
        (await reader.rpc('server.getConfig')).environment.environmentId
      assert.ok(environmentId, 'native environment id unavailable')
      const { page } = main
      await openThread(page, threadId, environmentId)
      const startRpc = report.rpc.length,
        seen = new Set()
      let historyPagesLoaded = 0
      for (let index = 0; index < 3; index++) {
        for (const id of await page
          .locator('[data-message-id]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-id'))))
          if (id) seen.add(id)
        await page
          .locator('.messages-timeline-scroll')
          .evaluate((node) => node.scrollTo({ top: 0, behavior: 'instant' }))
        await delay(250)
        const earlier = page.getByRole('button', { name: 'Load earlier turns', exact: true })
        try {
          await earlier.waitFor({ state: 'visible', timeout: 5000 })
        } catch {
          break
        }
        const loaded = page.waitForResponse(
          (response) =>
            response.url().includes(`/threads/${threadId}/history`) && response.status() === 200,
        )
        await earlier.click()
        await loaded
        historyPagesLoaded++
        await delay(400)
      }
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
      await page.getByRole('searchbox', { name: 'Find in thread', exact: true }).fill(search)
      await until(
        async () =>
          (await page.locator('[data-thread-find-bar]').innerText()).match(/\d+\s*\/\s*\d+/),
        'native history search results',
        30000,
      )
      await page.getByRole('button', { name: 'Next match', exact: true }).click()
      await delay(600)
      const summary = await page.locator('[data-thread-find-bar]').innerText()
      const screenshot = await shot(page, 'history-search')
      const after = await snapshot(threadId)
      assert.equal(after.runs.length, existing.runs.length)
      return {
        runCount: existing.runs.length,
        userMessageCount: existing.messages.filter((message) => message.role === 'user').length,
        distinctRenderedMessageIds: seen.size,
        historyPagesLoaded,
        searchStatus: summary,
        rpcMethods: [...new Set(report.rpc.slice(startRpc).map((row) => row.method))],
        screenshot,
      }
    })
  if (selected.has('mobile'))
    await step('mobile-real-send', async () => {
      const { page } = await login('admin', { width: 390, height: 844 })
      const ref = await newThread(
        page,
        `移动端真实验收${marker}。仅用两句话解释为什么发布前要确认回滚步骤，不调用工具。`,
      )
      const final = await finished(ref.threadId)
      assert.equal(final.runs.at(-1).status, 'completed')
      const layout = await page.evaluate(() => ({
        contentWidth: document.body.scrollWidth,
        viewportWidth: innerWidth,
      }))
      assert.ok(layout.contentWidth <= layout.viewportWidth + 1)
      return { ...ref, layout, screenshot: await shot(page, 'mobile-complete') }
    })
  if (selected.has('reconnect'))
    await step('browser-offline-reconnect-no-duplicate', async () => {
      const { page, context } = main
      const ref = await newThread(
        page,
        `重连验收${marker}。请直接写10段测试环境发布说明，每段150字，包含标题和列表；只用假设数据，不调用工具。`,
      )
      await until(
        async () =>
          ((p) =>
            p.runs.some((run) => run.status === 'running') &&
            p.providerThreads.some((thread) => thread.nativeThreadRef?.nativeId))(
            await snapshot(ref.threadId),
          ),
        'active native session before network interruption',
      )
      const before = summarize(await snapshot(ref.threadId))
      const connectionsBefore = report.websocketConnections || 0
      await context.setOffline(true)
      if (context.__nativeSockets)
        await Promise.allSettled(
          context.__nativeSockets.flatMap(({ route, server }) => [
            route.close({ code: 1001, reason: 'acceptance network interruption' }),
            server.close({ code: 1001, reason: 'acceptance network interruption' }),
          ]),
        )
      const disconnectedAt = Date.now()
      await delay(2200)
      await shot(page, 'browser-offline')
      await context.setOffline(false)
      await editor(page).waitFor({ state: 'visible' })
      if (context.__nativeSockets)
        await until(
          () => report.websocketConnections > connectionsBefore,
          'real native websocket replacement',
        )
      const final = await finished(ref.threadId)
      await until(
        async () => (await page.locator('[data-message-role="assistant"]').count()) > 0,
        'stream reconnected after actual browser offline',
      )
      assert.equal(final.runs.length, 1)
      assert.equal(new Set(final.runs.map((run) => run.userMessageId)).size, 1)
      assert.deepEqual(summarize(final).nativeThreads, before.nativeThreads)
      const sends = report.rpc.filter(
        (row) =>
          row.threadId === ref.threadId &&
          (row.type === 'message.dispatch' || row.method === 'orchestration.launchThread'),
      )
      assert.equal(new Set(sends.map((row) => row.commandId)).size, 1)
      return {
        ...ref,
        offlineMs: 2200,
        completedAfterOfflineMs: Date.now() - disconnectedAt,
        connectionsBefore,
        connectionsAfter: report.websocketConnections || 0,
        actualSocketClosed: !!context.__nativeSockets,
        browserCommandAttempts: sends.filter((row) => row.direction === 'sent').length,
        uniqueSendCommandCount: new Set(sends.map((row) => row.commandId)).size,
        canonical: summarize(final),
        screenshot: await shot(page, 'browser-reconnected'),
      }
    })
  if (selected.has('feedback-30'))
    await step('thirty-real-queue-submissions-local-feedback-and-durable-receipts', async () => {
      const { page } = main
      const ref = await newThread(page, longPrompt)
      await until(
        async () => (await snapshot(ref.threadId)).runs.some((run) => run.status === 'running'),
        'actual source running',
      )
      const feedback = await measureQueuedFeedback(page, ref)
      await page.getByRole('button', { name: 'Stop generation', exact: true }).click()
      const final = await finished(ref.threadId, 31)
      return {
        ...ref,
        ...feedback,
        canonical: summarize(final),
        screenshot: await shot(page, 'thirty-queue-submissions'),
      }
    })
  if (selected.has('queue'))
    await step('shared-two-page-dirty-queue-edit-stash', async () => {
      const secondary = await login('lin'),
        { page } = main
      await newDraft(page, 'project')
      await probe(page)
      const ref = await send(page, longPrompt)
      report.threads.push({ ...ref, visibility: 'project' })
      await save()
      await until(
        async () => (await snapshot(ref.threadId)).runs.some((run) => run.status === 'running'),
        'queue source running',
      )
      await openThread(secondary.page, ref.threadId, ref.environmentId)
      const queueText = `下一轮仅回复队列标记${marker}。`
      await send(page, queueText, { queue: true })
      await until(
        async () => (await snapshot(ref.threadId)).runs.some((run) => run.status === 'queued'),
        'actual queued run',
      )
      const originalDraft = `原有未发送草稿-${marker}`,
        edited = `队列未提交编辑-${marker}`
      await fill(page, originalDraft)
      report.queueGeometry = await page
        .getByRole('button', { name: 'Edit queued message', exact: true })
        .last()
        .evaluate((element) => {
          const geometry = (node) => {
            const r = node.getBoundingClientRect(),
              s = getComputedStyle(node)
            return {
              tag: node.tagName,
              slot: node.getAttribute('data-slot'),
              class: node.className,
              rect: r.toJSON(),
              marginBottom: s.marginBottom,
              display: s.display,
              height: s.height,
              afterHeight: getComputedStyle(node, '::after').height,
              afterContent: getComputedStyle(node, '::after').content,
            }
          }
          const ancestors = []
          for (let node = element; node && ancestors.length < 12; node = node.parentElement)
            ancestors.push(geometry(node))
          const r = element.getBoundingClientRect()
          return {
            ancestors,
            hit: document
              .elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
              ?.outerHTML.slice(0, 250),
          }
        })
      await save()
      await page.getByRole('button', { name: 'Edit queued message', exact: true }).last().click()
      await fill(page, edited)
      await page
        .locator('input[type=file]')
        .first()
        .setInputFiles({
          name: 'queue-preserved.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('队列编辑附件保留验收'),
        })
      await delay(700)
      await shot(page, 'queue-dirty-before-remote-cancel')
      await secondary.page
        .getByRole('button', { name: 'Remove queued message', exact: true })
        .last()
        .click()
      await until(
        async () => (await editor(page).innerText()).includes(originalDraft),
        'original composer remains after remote cancellation',
        30000,
      )
      const stash = await until(
        () =>
          page.evaluate(
            ({ marker }) => {
              for (let index = 0; index < localStorage.length; index++) {
                const key = localStorage.key(index)
                if (!key?.endsWith(':t3code:prompt-stash:v2')) continue
                const data = JSON.parse(localStorage.getItem(key) || '{}')
                const entry = data.state?.entries?.find((item) =>
                  item.prompt?.includes(`队列未提交编辑-${marker}`),
                )
                if (entry)
                  return {
                    promptLength: entry.prompt.length,
                    files:
                      entry.files?.map((file) => ({
                        name: file.name,
                        attachmentId: file.attachmentId,
                      })) || [],
                    pendingImageCount: entry.pendingImageCount || 0,
                  }
              }
              return null
            },
            { marker },
          ),
        'durable native stash preserves dirty queue edit',
      )
      assert.equal(stash.files[0]?.name, 'queue-preserved.txt')
      const fileChecks = []
      for (const file of stash.files) {
        const download = await fetch(
          `${origin}/api/agent-demo/t3/autoops/attachments/${encodeURIComponent(file.attachmentId)}`,
          { headers: { cookie: reader.cookie } },
        )
        assert.equal(download.status, 200)
        const bytes = (await download.arrayBuffer()).byteLength
        assert.equal(bytes, Buffer.byteLength('队列编辑附件保留验收'))
        fileChecks.push({ id: file.attachmentId, bytes, status: download.status })
      }
      const stop = page.getByRole('button', { name: 'Stop generation', exact: true })
      if (await stop.isVisible()) await stop.click()
      else if ((await snapshot(ref.threadId)).runs.some((run) => run.status === 'running'))
        await reader.rpc('orchestration.dispatchCommand', {
          type: 'thread.stop',
          threadId: ref.threadId,
          commandId: randomUUID(),
        })
      const final = await finished(ref.threadId)
      return {
        ...ref,
        stash,
        fileChecks,
        feedback: await page.evaluate(() => window.__t3UiProbe.finish()),
        originalDraftPreserved: (await editor(page).innerText()).includes(originalDraft),
        canonical: summarize(final),
        screenshot: await shot(page, 'queue-conflict-preserved'),
      }
    })
  if (selected.has('references-commands') || selected.has('references'))
    await step('native-reference-and-command-pickers', async () => {
      const rpcStart = report.rpc.length
      const { page } = main
      if (selected.has('references-commands')) await enableNativePlanMode(page)
      await newDraft(page)
      await fill(page, '@环境检查')
      const documentOption = page
        .locator('[data-composer-item-id^="path:file:"]')
        .filter({ hasText: '环境检查手册' })
        .first()
      await documentOption.waitFor({ state: 'visible', timeout: 30000 })
      const referenceId = await documentOption.getAttribute('data-composer-item-id')
      assert.ok(referenceId.includes('autoops/p-autoops/documents/'))
      await documentOption.click()
      const chip = page.locator('[data-composer-mention-chip]')
      await chip.waitFor({ state: 'visible' })
      await chip.click()
      await page
        .getByRole('button', { name: 'Save file', exact: true })
        .waitFor({ state: 'visible', timeout: 30000 })
      const previewError = await page.getByText('Failed to load file', { exact: false }).count()
      assert.equal(previewError, 0)
      await shot(page, 'reference-preview')
      await page.keyboard.press('Escape')
      if (selected.has('references') && !selected.has('references-commands')) {
        await fill(page, '')
        return { referenceId, referencePreview: true, modelCalls: 0 }
      }
      await fill(page, '/')
      const commandDrawer = page.locator('[data-composer-command-drawer]')
      await commandDrawer.waitFor({ state: 'visible' })
      const commands = await page
        .locator('[data-composer-item-id^="slash:"]')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-composer-item-id')))
      assert.ok(commands.includes('slash:plan'))
      assert.ok(
        !commands.includes('slash:model'),
        'fixed agent must not expose an inert model switch',
      )
      await page.locator('[data-composer-item-id="slash:plan"]').click()
      await fill(page, '$')
      const skill = page.locator('[data-composer-item-id^="skill:"]').first()
      await skill.waitFor({ state: 'visible', timeout: 30000 })
      const skills = await page.locator('[data-composer-item-id^="skill:"]').count()
      await skill.click()
      await page.getByRole('button', { name: /^Skill / }).waitFor({ state: 'visible' })
      const screenshot = await shot(page, 'native-skill-selected')
      await fill(page, '')
      assert.equal(
        report.rpc
          .slice(rpcStart)
          .filter(
            (row) => row.type === 'message.dispatch' || row.method === 'orchestration.launchThread',
          ).length,
        0,
      )
      return { referenceId, commands, skills, referencePreview: true, modelCalls: 0, screenshot }
    })
  if (selected.has('project-picker'))
    await step('native-new-thread-picker-offers-only-authorized-business-projects', async () => {
      const { page } = main
      const environmentId = (await reader.rpc('server.getConfig')).environment.environmentId
      await openThread(page, '84edf5ea-6245-4bed-a6cf-c27c22c7e44e', environmentId)
      await page.getByRole('button', { name: 'New thread', exact: true }).click()
      const option = page.getByRole('option').filter({ hasText: 'AutoOps 工作台' }).first()
      await option.waitFor({ state: 'visible' })
      assert.equal(await page.getByRole('option').filter({ hasText: 'No project' }).count(), 0)
      const options = await page.getByRole('option').allTextContents()
      assert.ok(options.every((text) => !text.includes('/home/') && !text.includes('/Users/')))
      await option.click()
      await until(() => new URL(page.url()).hash.startsWith('#/draft/'), 'business draft route')
      await page.getByLabel('会话可见范围', { exact: true }).waitFor({ state: 'visible' })
      return { options, modelCalls: 0, screenshot: await shot(page, 'authorized-project-draft') }
    })
  if (selected.has('plan-save'))
    await step('native-plan-save-to-authorized-project-material', async () => {
      const { page } = main,
        threadId = process.env.T3_UI_PLAN_THREAD || '84edf5ea-6245-4bed-a6cf-c27c22c7e44e'
      const environmentId = (await reader.rpc('server.getConfig')).environment.environmentId
      await openThread(page, threadId, environmentId)
      await page.getByRole('button', { name: 'Plan actions', exact: true }).click()
      await page.getByRole('menuitem', { name: '保存为项目资料', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '保存计划为项目资料', exact: true })
      await dialog.getByLabel('文件名', { exact: true }).fill(`浏览器计划验收-${marker}.md`)
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith('/autoops/plan-materials') &&
          response.request().method() === 'POST',
      )
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      const response = await saved
      assert.equal(response.status(), 200)
      const material = await response.json()
      assert.ok(material.id)
      assert.ok(material.sourceUrl)
      await dialog.waitFor({ state: 'hidden' })
      const download = await fetch(origin + material.sourceUrl, {
        headers: { cookie: reader.cookie, origin },
      })
      assert.equal(download.status, 200)
      const bytes = (await download.arrayBuffer()).byteLength
      assert.ok(bytes > 20)
      return {
        threadId,
        materialId: material.id,
        bytes,
        screenshot: await shot(page, 'plan-material-saved'),
      }
    })
  if (selected.has('plan-implement'))
    await step(
      'native-plan-implementation-new-thread-preserves-source-and-business-scope',
      async () => {
        const { page } = main,
          sourceThreadId = process.env.T3_UI_PLAN_THREAD || '84edf5ea-6245-4bed-a6cf-c27c22c7e44e'
        const environmentId = (await reader.rpc('server.getConfig')).environment.environmentId
        const sourceBinding = (await reader.http(`/autoops/thread-bindings/${sourceThreadId}`))
          .binding
        await enableNativePlanMode(page)
        await openThread(page, sourceThreadId, environmentId)
        const before = report.rpc.length
        await page.getByRole('button', { name: 'Implementation actions', exact: true }).click()
        await page.getByRole('menuitem', { name: 'Implement in a new thread', exact: true }).click()
        const ref = await until(
          () => {
            const value = routeThread(page)
            return value && value.threadId !== sourceThreadId ? value : null
          },
          'derived native thread route',
          60000,
        )
        report.threads.push({ ...ref, visibility: 'private' })
        await save()
        const binding = (await reader.http(`/autoops/thread-bindings/${ref.threadId}`)).binding
        for (const key of ['projectId', 'environmentId', 'agentId'])
          assert.equal(binding[key], sourceBinding[key])
        assert.equal(binding.visibility, 'private')
        let feedback
        if (selected.has('feedback-30-on-plan')) {
          await until(
            async () => (await snapshot(ref.threadId)).runs.some((run) => run.status === 'running'),
            'actual plan execution running',
          )
          feedback = await measureQueuedFeedback(page, ref)
          report.planFeedback = feedback
          await save()
        }
        const final = await finished(ref.threadId, feedback ? 31 : 1, 300000)
        report.steps.at(-1).partial = {
          binding: {
            projectId: binding.projectId,
            environmentId: binding.environmentId,
            agentId: binding.agentId,
            visibility: binding.visibility,
          },
          canonical: summarize(final),
          sourcePlanRef: final.runs[0].sourcePlanRef,
          launches: report.rpc
            .slice(before)
            .filter((row) => row.method === 'orchestration.launchThread'),
        }
        await save()
        assert.equal(final.runs[0].status, 'completed')
        assert.equal(final.runs[0].sourcePlanRef?.threadId, sourceThreadId)
        assert.ok(final.runs[0].sourcePlanRef?.planId)
        const launches = report.rpc
          .slice(before)
          .filter((row) => row.method === 'orchestration.launchThread')
        assert.equal(launches.length, 1)
        assert.deepEqual(final.runs[0].sourcePlanRef, launches[0].sourcePlanRef)
        const sourceAfter = await snapshot(sourceThreadId)
        const sourcePlan = sourceAfter.plans.find(
          (plan) => plan.id === final.runs[0].sourcePlanRef.planId,
        )
        assert.equal(sourcePlan?.status, 'completed')
        await openThread(page, sourceThreadId, environmentId)
        await page
          .getByRole('button', { name: 'Plan actions', exact: true })
          .waitFor({ state: 'visible' })
        await shot(page, 'completed-source-plan-retained')
        await openThread(page, ref.threadId, environmentId)
        return {
          ...ref,
          sourceThreadId,
          sourcePlanRef: final.runs[0].sourcePlanRef,
          binding: {
            projectId: binding.projectId,
            environmentId: binding.environmentId,
            agentId: binding.agentId,
            visibility: binding.visibility,
          },
          launchCount: launches.length,
          wireSourcePlanRef: launches[0].sourcePlanRef,
          sourcePlanStatus: sourcePlan.status,
          sourceNavigation: 'existing-thread-route; upstream has no dedicated source-plan link',
          canonical: summarize(final),
          screenshot: await shot(page, 'plan-implementation-completed'),
        }
      },
    )
  if (selected.has('shared-edit'))
    await step('shared-edit-from-here-protected-native-history', async () => {
      const { page } = main
      const ref = await newThread(
        page,
        `共享历史编辑验收${marker}。只回复“第一轮完成”。`,
        'project',
      )
      await finished(ref.threadId)
      await send(page, `第二轮仅回复“第二轮完成-${marker}”。`)
      await finished(ref.threadId, 2)
      const before = summarize(await snapshot(ref.threadId))
      const rows = page.locator('[data-message-role="user"]')
      await rows.last().hover()
      await rows.last().getByRole('button', { name: 'Edit from here', exact: true }).click()
      await page.getByRole('button', { name: '确认修改共享历史', exact: true }).click()
      const final = await until(
        async () => {
          const p = await snapshot(ref.threadId)
          if (p.thread.rollbackFailure)
            throw new Error('Native protected rollback reported failure')
          return p.thread.rollbackSafety?.status === 'complete' ? p : null
        },
        'protected native rollback complete',
        90000,
      )
      assert.ok(final.thread.rollbackSafety.protectedNativeThreadId)
      assert.ok(final.thread.rollbackSafety.sharedImpactConfirmed)
      assert.ok((await editor(page).innerText()).includes('第二轮'))
      return {
        ...ref,
        before,
        after: summarize(final),
        composerRestored: true,
        screenshot: await shot(page, 'shared-edit-protected'),
      }
    })
  if (selected.has('legacy'))
    await step('legacy-drafts-nonempty-and-device-dedup', async () => {
      // Never log legacy content or screenshot existing real conversations.
      const drafts = (await reader.http('/autoops/legacy-drafts')).drafts
      const expected = drafts.filter((draft) => draft.text.trim() || draft.attachments.length)
      assert.ok(expected.length > 0, 'this target has no substantive legacy draft')
      const { page } = main
      const counts = await until(
        () =>
          page.evaluate(() => {
            const entries = []
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i)
              if (key?.endsWith(':t3code:prompt-stash:v2'))
                entries.push(
                  ...(JSON.parse(localStorage.getItem(key) || '{}').state?.entries || []),
                )
            }
            const legacy = entries.filter((entry) => entry.id.startsWith('autoops-legacy-draft:'))
            return legacy.length
              ? {
                  count: legacy.length,
                  textLengths: legacy.map((entry) => entry.prompt.length),
                  attachmentCounts: legacy.map(
                    (entry) => (entry.files?.length || 0) + entry.attachments.length,
                  ),
                }
              : null
          }),
        'real legacy content recovered into native stash',
      )
      assert.equal(counts.count, expected.length)
      await page.reload()
      await editor(page).waitFor({ state: 'visible', timeout: 60000 })
      await delay(800)
      const after = await page.evaluate(() => {
        let count = 0
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key?.endsWith(':t3code:prompt-stash:v2'))
            count += (JSON.parse(localStorage.getItem(key) || '{}').state?.entries || []).filter(
              (entry) => entry.id.startsWith('autoops-legacy-draft:'),
            ).length
        }
        return count
      })
      assert.equal(after, counts.count)
      const shell = await reader.http('/api/orchestration/shell')
      const importedThreads = shell.threads || shell.snapshot?.threads || []
      const bindings = []
      const files = new Map()
      for (const thread of importedThreads) {
        const binding = (await reader.http(`/autoops/thread-bindings/${thread.id}`)).binding
        bindings.push(binding)
        const projection = await snapshot(thread.id)
        for (const message of projection.messages)
          for (const file of message.attachments || []) files.set(file.id, file)
      }
      const fileChecks = []
      for (const file of files.values()) {
        const response = await fetch(`${origin}/api/agent-demo/t3/autoops/attachments/${file.id}`, {
          headers: { cookie: reader.cookie },
        })
        assert.equal(response.status, 200)
        fileChecks.push({
          bytes: (await response.arrayBuffer()).byteLength,
          mime: response.headers.get('content-type'),
        })
      }
      if (bindings.length) {
        const readonly = bindings.find((binding) => binding.compatibilityReadOnly)
        assert.ok(readonly)
        const config = await reader.rpc('server.getConfig')
        await openThread(page, readonly.threadId, config.environment.environmentId)
        assert.ok(
          (await page.locator('[data-autoops-thread-scope]').innerText()).includes('历史仅供阅读'),
        )
      }
      return {
        readonlyThreadCount: bindings.filter((binding) => binding.compatibilityReadOnly).length,
        authorizedFileChecks: fileChecks,
        serverRows: drafts.length,
        substantiveDrafts: expected.length,
        imported: counts,
        afterReloadCount: after,
      }
    })
} catch (error) {
  report.fatal = error.message
  process.exitCode = 1
} finally {
  for (const ref of report.threads) {
    try {
      const p = await snapshot(ref.threadId)
      for (const run of p.runs.filter((item) => item.status === 'queued')) {
        await reader.rpc('orchestration.dispatchCommand', {
          type: 'queued-run.cancel',
          threadId: ref.threadId,
          runId: run.id,
          commandId: randomUUID(),
        })
      }
      if (p.runs.some((run) => !terminal(run)))
        await reader.rpc('orchestration.dispatchCommand', {
          type: 'thread.stop',
          threadId: ref.threadId,
          commandId: randomUUID(),
        })
    } catch {}
  }
  report.completedAt = new Date().toISOString()
  await save()
  reader.close()
  await browser.close()
  console.log(
    JSON.stringify({
      report: path.join(output, 'report.json'),
      steps: report.steps.map(({ name, status }) => ({ name, status })),
      fatal: report.fatal,
    }),
  )
}
