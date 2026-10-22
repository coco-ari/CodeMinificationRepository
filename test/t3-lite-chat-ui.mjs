import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

// Execute only through the approved browser-test command. Chromium owns a fresh
// disposable context; no user profile, mocked events or private app state is used.
if (process.env.T3_UI_LIVE !== '1') throw new Error('Set T3_UI_LIVE=1 for the approved real-model stage test.')
const origin = new URL(process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').origin
if (new URL(origin).port !== '18887') throw new Error('This test is restricted to isolated stage port 18887.')
const marker = `精简交互-${randomUUID().slice(0, 8)}`
const output = path.resolve(process.env.T3_LITE_CHAT_OUTPUT || `.test-artifacts/t3-lite/chat-${Date.now()}`)
await mkdir(output, { recursive: true })
const report = { startedAt: new Date().toISOString(), origin, marker, steps: [], ownedThreadIds: [], rpc: [], pageErrors: [], httpFailures: [], cleanup: [], limitations: ['真实中文文本输入，不等同于实体设备中文输入法组合键验收。', '轮次耗时同时包含模型与服务端时间，不单独归因于界面。', '只创建和清理本脚本专属私有对话，既有对话只可能在初次登录显示。'] }
const client = new T3LiveClient(origin)
const browser = await chromium.launch({ headless: process.env.T3_UI_HEADED !== '1' })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
const page = await context.newPage()
page.setDefaultTimeout(20000)
const owned = new Set(), requests = new Map()
const terminal = run => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
const draftText = value => value.trim().replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n')
const editor = () => page.getByTestId('composer-editor')
const save = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const snapshot = async id => (await client.http(`/api/orchestration/threads/${encodeURIComponent(id)}`)).projection
const dispatch = (type, id, extra = {}) => client.rpc('orchestration.dispatchCommand', { type, threadId: id, commandId: randomUUID(), ...extra })
async function until(read, label, timeout = 45000) {
  const started = performance.now()
  while (performance.now() - started < timeout) {
    const result = await read()
    if (result) return result
    await wait(200)
  }
  throw new Error(`等待超时：${label}`)
}
async function shot(name) { const file = `${name}.png`; await page.screenshot({ path: path.join(output, file), fullPage: false }); return file }
async function step(name, action) {
  const row = { name, startedAt: new Date().toISOString() }
  report.steps.push(row); await save()
  try { row.result = await action(); row.status = 'passed' }
  catch (error) { row.status = 'failed'; row.error = error.message; row.screenshot = await shot(`${name}-failed`).catch(() => null); throw error }
  finally { row.completedAt = new Date().toISOString(); await save(); console.log(JSON.stringify(row)) }
}
function route() { const parts = new URL(page.url()).hash.slice(1).split('/').filter(Boolean); return parts.length === 2 && parts[0] !== 'draft' && parts[0] !== 'settings' ? { environmentId: parts[0], threadId: parts[1] } : null }
function summary(p) { return { threadId: p.thread.id, runs: p.runs.map(r => ({ id: r.id, status: r.status })).sort((a, b) => a.id.localeCompare(b.id)), nativeIds: p.providerThreads.map(t => t.nativeThreadRef?.nativeId).filter(Boolean).sort(), messageIds: p.messages.map(m => m.id).sort() } }
page.on('pageerror', error => report.pageErrors.push({ at: Date.now(), message: error.message }))
page.on('response', response => { if (response.status() >= 400) report.httpFailures.push({ status: response.status(), path: new URL(response.url()).pathname }) })
page.on('websocket', socket => {
  socket.on('framesent', ({ payload }) => {
    try {
      const frame = JSON.parse(String(payload))
      if (frame._tag !== 'Request') return
      const row = { method: frame.tag, type: frame.payload?.type, threadId: frame.payload?.threadId, commandId: frame.payload?.commandId, messageId: frame.payload?.messageId, deliveryIntent: frame.payload?.deliveryIntent, dispatchMode: frame.payload?.dispatchMode, sentMono: performance.now() }
      report.rpc.push(row); requests.set(String(frame.id), row)
      if (frame.tag === 'orchestration.launchThread' && frame.payload?.initialMessage?.text?.includes(marker)) {
        owned.add(frame.payload.threadId); report.ownedThreadIds = [...owned]
      }
    } catch { /* Non-JSON keepalive frames have no application meaning. */ }
  })
  socket.on('framereceived', ({ payload }) => {
    try {
      const decoded = JSON.parse(String(payload))
      for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
        const row = requests.get(String(frame.requestId))
        if (frame._tag === 'Exit' && row) { row.ackStatus = frame.exit?._tag; row.receiptMs = performance.now() - row.sentMono; requests.delete(String(frame.requestId)) }
      }
    } catch { /* No generated or altered server events. */ }
  })
})
async function newPrivateDraft() {
  const button = page.getByRole('button', { name: '新建对话', exact: true })
  await button.waitFor({ state: 'visible' }); await button.click()
  // The current two-project host opens the native project command dialog even
  // when #/draft is already rendered underneath. Route readiness is insufficient.
  const projectDialog = page.locator('[data-slot="command-dialog-popup"]')
  await projectDialog.waitFor({ state: 'visible' })
  await projectDialog.getByRole('option').filter({ hasText: 'AutoOps 工作台' }).first().click()
  await projectDialog.waitFor({ state: 'hidden' })
  await page.locator('[data-slot="command-dialog-backdrop"]').waitFor({ state: 'hidden' })
  await until(() => new URL(page.url()).hash.startsWith('#/draft/'), '项目选择完成后的原生草稿路由')
  await editor().waitFor({ state: 'visible' })
  const project = page.locator('[data-draft-project-trigger]')
  if (await project.isVisible()) assert((await project.innerText()).includes('AutoOps 工作台'), '草稿项目应是刚刚选择的真实项目')
  await page.getByLabel('会话可见范围', { exact: true }).click()
  await page.getByRole('option', { name: '仅自己', exact: true }).click()
}
async function submit(text, mode = 'foreground') {
  await editor().fill(text)
  const button = page.locator('button[aria-label="发送消息"]:visible, button[aria-label="加入队列"]:visible, button[aria-label="引导当前执行"]:visible, button[aria-label="压缩并发送"]:visible').last()
  await until(() => button.isEnabled(), '发送按钮可操作')
  const label = await button.getAttribute('aria-label')
  if (mode !== 'foreground') assert(['加入队列', '引导当前执行'].includes(label), '当前执行必须仍在运行')
  const useAlternate = mode === 'queue' ? label === '引导当前执行' : mode === 'steer' && label === '加入队列'
  const before = report.rpc.length
  await button.click(useAlternate ? { modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] } : {})
  await until(async () => !(await editor().innerText()).includes(text), '原生发送清空本次草稿')
  const receipt = await until(() => report.rpc.slice(before).find(r => (r.method === 'orchestration.launchThread' || r.type === 'message.dispatch') && r.ackStatus), '原生持久回执')
  assert.equal(receipt.ackStatus, 'Success')
  return receipt
}
async function installProbe() {
  await page.evaluate(() => {
    const start = performance.now(), samples = []
    let last = '', firstWorkMs = null, firstTextMs = null, firstFeedbackMs = null, clicked = null, original = ''
    const click = e => { if (clicked === null && e.target.closest?.('button[aria-label="发送消息"]')) { clicked = performance.now(); original = document.querySelector('[data-testid="composer-editor"]')?.textContent || '' } }
    document.addEventListener('click', click, true)
    const read = () => {
      if (clicked !== null && firstFeedbackMs === null && original && !(document.querySelector('[data-testid="composer-editor"]')?.textContent || '').trim()) firstFeedbackMs = performance.now() - clicked
      if (firstWorkMs === null && document.querySelector('[aria-label="停止生成"], [data-chat-composer-activity-strip]')) firstWorkMs = performance.now() - start
      const text = [...document.querySelectorAll('[data-message-role="assistant"]')].map(n => n.textContent || '').join('\n')
      if (text && firstTextMs === null) firstTextMs = performance.now() - start
      if (text !== last) { samples.push({ elapsedMs: performance.now() - start, characters: text.length }); last = text }
    }
    const observer = new MutationObserver(read); observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
    window.__liteChatProbe = { read: () => ({ firstFeedbackMs, firstWorkMs, firstTextMs, samples: [...samples] }), finish: () => { read(); observer.disconnect(); document.removeEventListener('click', click, true); return { firstFeedbackMs, firstWorkMs, firstTextMs, samples } } }
  })
}
async function scrollState() {
  return page.locator('.messages-timeline-scroll').evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight, gap: node.scrollHeight - node.clientHeight - node.scrollTop }))
}
async function readingAnchor(text) {
  return page.locator('.messages-timeline-scroll').evaluate((node, expected) => {
    const bounds = node.getBoundingClientRect()
    const candidates = [...node.querySelectorAll('[data-message-role="assistant"] p, [data-message-role="assistant"] li')]
    const element = expected
      ? candidates.find(candidate => candidate.textContent.trim() === expected)
      : candidates.find(candidate => { const rect = candidate.getBoundingClientRect(); return candidate.textContent.trim().length > 20 && rect.top > bounds.top + 10 && rect.bottom < bounds.bottom - 10 })
    return element ? { text: element.textContent.trim(), top: element.getBoundingClientRect().top - bounds.top } : null
  }, text)
}
let ref
try {
  await step('login-private-draft', async () => {
    await client.login(); await client.connect()
    assert.equal(client.bootstrap.productProfile?.id, 'project-assistant-lite-v1')
    report.model = client.bootstrap.fixedModel
    await page.goto(origin + '/agent-demo.html')
    await page.getByRole('textbox', { name: '用户名' }).fill('admin')
    await page.getByLabel('密码', { exact: true }).fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await editor().waitFor({ state: 'visible', timeout: 60000 })
    await newPrivateDraft()
    return { profile: client.bootstrap.productProfile.id, screenshot: await shot('private-draft') }
  })
  await step('chinese-send-waiting-stream', async () => {
    await installProbe()
    const receipt = await submit(`这是网页交互验收 ${marker}。请直接写一份用于演示的测试环境发布说明，分60个小节，每节至少100字，用中文Markdown标题和列表，内容明确是假设测试资料。请完整写完，不要省略，不调用工具、不创建文件、不提问。`)
    ref = await until(() => route(), '原生对话路由')
    assert(owned.has(ref.threadId), '只接管本次已观察到真实 launch 的对话')
    const binding = await client.http(`/autoops/thread-bindings/${ref.threadId}`)
    assert.equal(binding.binding.visibility, 'private')
    const p = await until(async () => { const value = await snapshot(ref.threadId); return value.runs.some(r => r.status === 'running') && value.providerThreads.some(t => t.nativeThreadRef?.nativeId) ? value : null }, '真实原生运行', 90000)
    await until(async () => { const probe = await page.evaluate(() => window.__liteChatProbe.read()); return probe.samples.filter(s => s.characters > 0).length >= 2 && probe.firstWorkMs !== null }, '真实流式DOM至少两次增长', 120000)
    return { receipt, native: summary(p), feedback: await page.evaluate(() => window.__liteChatProbe.read()), screenshot: await shot('streaming') }
  })
  await step('queue-edit-cancel', async () => {
    const queuedText = `待取消的下一轮 ${marker}，仅回复队列验收。`
    const receipt = await submit(queuedText, 'queue')
    assert.equal(receipt.dispatchMode?.type, 'queue_after_active')
    const queued = await until(async () => { const p = await snapshot(ref.threadId); const message = p.messages.find(m => m.text === queuedText); return message && p.runs.find(r => r.userMessageId === message.id && r.status === 'queued') }, '原生队列持久化')
    const expand = page.getByRole('button', { name: '展开队列消息', exact: true }); if (await expand.isVisible()) await expand.click()
    await page.getByRole('button', { name: '编辑队列消息', exact: true }).last().click()
    await until(async () => (await editor().innerText()).includes(queuedText), '队列文本进入原输入框')
    const edited = `已编辑且将取消 ${marker}，不需要执行。`
    await editor().fill(edited)
    await page.getByRole('button', { name: '更新队列消息', exact: true }).click()
    await until(async () => (await snapshot(ref.threadId)).messages.some(m => m.text === edited), '编辑内容持久化')
    const screenshot = await shot('queue-edited')
    await page.getByRole('button', { name: '移除队列消息', exact: true }).last().click()
    await until(async () => {
      const run = (await snapshot(ref.threadId)).runs.find(r => r.id === queued.id)
      return run === undefined || run.status === 'cancelled'
    }, '本条队列已取消且不能执行')
    await until(async () => await page.getByRole('button', { name: '编辑队列消息', exact: true }).count() === 0, '已取消消息退出可执行队列')
    return { receipt, queuedRunId: queued.id, edited: true, cancelled: true, screenshot }
  })
  await step('steer-current-execution', async () => {
    const p = await snapshot(ref.threadId), active = p.runs.find(r => r.status === 'running')
    assert(active, '引导前当前轮次仍须运行')
    const text = `当前补充 ${marker}：继续完整说明，后续小节突出回滚检查；不要提前结束。`
    const receipt = await submit(text, 'steer')
    // T3 commandContext servers intentionally resolve deliveryIntent=steer
    // themselves; start_immediately is the wire envelope, not a new-turn claim.
    // Legacy servers instead receive steer_active with an explicit targetRunId.
    assert(
      (receipt.dispatchMode?.type === 'start_immediately' && receipt.deliveryIntent === 'steer') ||
      (receipt.dispatchMode?.type === 'steer_active' && receipt.dispatchMode.targetRunId === active.id),
      '原生协议必须明确请求引导当前执行',
    )
    const after = await until(async () => {
      const value = await snapshot(ref.threadId)
      return value.turnItems.some(item => item.type === 'user_message' && item.text === text && item.runId === active.id && item.inputIntent === 'steer') ? value : null
    }, '引导进入当前原生轮次且服务端标记为steer')
    assert(after.runs.every(run => p.runs.some(previous => previous.id === run.id)), '引导不能创建额外轮次')
    return { receipt, activeRunId: active.id, native: summary(after), screenshot: await shot('steered') }
  })
  await step('read-upward-and-return-to-latest', async () => {
    await until(async () => {
      const s = await scrollState()
      const content = await page.locator('[data-message-role="assistant"]').evaluateAll(nodes => ({ characters: nodes.reduce((n, el) => n + (el.textContent || '').length, 0), height: nodes.reduce((n, el) => n + el.getBoundingClientRect().height, 0) }))
      return content.characters > 1600 && content.height > s.viewport + 600 && s.top > 600
    }, '真实正文超过视口而非仅锚点占位', 120000)
    const active = (await snapshot(ref.threadId)).runs.find(r => r.status === 'running')
    assert(active, '滚动验收须发生于输出中')
    const before = await scrollState(), viewport = page.locator('.messages-timeline-scroll')
    await viewport.hover(); await page.mouse.wheel(0, -650)
    const held = await until(async () => { const s = await scrollState(); return s.top < before.top - 200 ? s : null }, '真实wheel向上阅读')
    const anchor = await readingAnchor()
    assert(anchor, '向上阅读时须取得可见正文锚点')
    const nativeCharacters = p => p.turnItems.filter(item => item.type === 'assistant_message' && item.runId === active.id).reduce((total, item) => total + item.text.length, 0)
    const startChars = nativeCharacters(await snapshot(ref.threadId))
    const holdSamples = [], began = performance.now()
    await until(async () => {
      const s = await scrollState(), current = await readingAnchor(anchor.text), characters = nativeCharacters(await snapshot(ref.threadId))
      holdSamples.push({ elapsedMs: performance.now() - began, ...s, anchorTop: current?.top, characters })
      assert(s.gap > 100, '向上阅读被拉回底部')
      assert(current && Math.abs(current.top - anchor.top) <= 40, '新增正文期间可见阅读锚点发生明显跳动')
      return performance.now() - began >= 1500 && characters > startChars
    }, '新增流式正文时保持阅读位置', 20000)
    const screenshot = await shot('reading-upward')
    await page.getByRole('button', { name: '滚动到底部', exact: true }).click()
    const returned = await until(async () => { const s = await scrollState(); return s.top > held.top + 150 ? s : null }, '原生回底部控件推进位置')
    return { before, held, anchor, holdSamples, returned, screenshot, returnedScreenshot: await shot('returned-to-latest') }
  })
  await step('stop-and-draft-reload', async () => {
    const p = await snapshot(ref.threadId), active = p.runs.find(r => r.status === 'running')
    assert(active, '停止操作必须针对真实活动轮次')
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    let stableSummary
    const stopped = await until(async () => {
      const value = await snapshot(ref.threadId)
      if (!value.runs.every(terminal) || !value.providerTurns.every(terminal)) return null
      const next = JSON.stringify(summary(value)), stable = next === stableSummary
      stableSummary = next
      return stable ? value : null
    }, '停止原生执行并完成运行器收尾', 60000)
    assert(['cancelled', 'interrupted'].includes(stopped.runs.find(r => r.id === active.id)?.status))
    report.feedback = await page.evaluate(() => window.__liteChatProbe.finish())
    const draft = `未发送中文草稿 ${marker}：保留换行与标点。\n下一步先核对资料。`
    await editor().fill(draft)
    await editor().blur()
    // Navigate through an ordinary route, then reload; do not touch localStorage or app stores.
    await page.goto(origin + '/agent-demo.html#/settings/general')
    await page.getByText('当前配置', { exact: true }).waitFor()
    await page.goto(`${origin}/agent-demo.html#/${ref.environmentId}/${ref.threadId}`)
    await editor().waitFor({ state: 'visible' })
    await until(async () => draftText(await editor().innerText()) === draft, '切换后草稿恢复')
    await page.reload(); await editor().waitFor({ state: 'visible' })
    await until(async () => draftText(await editor().innerText()) === draft, '刷新后草稿保持')
    const after = await snapshot(ref.threadId)
    assert.deepEqual(summary(after), summary(stopped), '刷新/草稿不能新增原生轮次、消息或会话')
    const screenshot = await shot('draft-restored')
    await editor().fill(''); await editor().blur()
    return { stoppedRunId: active.id, nativeBefore: summary(stopped), nativeAfter: summary(after), draftRestored: true, screenshot }
  })
  await step('page-errors', async () => { assert.deepEqual(report.pageErrors, []); return { count: 0, screenshot: await shot('final-desktop') } })
} catch (error) { report.fatal = error.message; process.exitCode = 1 }
finally {
  for (const id of owned) {
    const row = { threadId: id }; report.cleanup.push(row)
    try {
      const p = await snapshot(id)
      for (const run of p.runs.filter(r => r.status === 'queued')) await dispatch('queued-run.cancel', id, { runId: run.id })
      if (p.runs.some(r => !terminal(r) && r.status !== 'queued')) await dispatch('thread.stop', id)
      await until(async () => (await snapshot(id)).runs.every(terminal), '清理前本脚本执行已停止', 60000)
      await dispatch('thread.delete', id)
      const deleted = await until(async () => { try { await snapshot(id); return false } catch (error) { if (error.status === 404) return true; throw error } }, '删除本脚本私有对话', 30000)
      row.deleted = deleted
    } catch (error) { row.error = error.message; process.exitCode = 1 }
  }
  report.completedAt = new Date().toISOString()
  report.status = report.fatal || report.cleanup.some(row => !row.deleted) ? 'failed' : 'passed'
  await save(); client.close(); await context.close(); await browser.close()
  console.log(JSON.stringify({ report: path.join(output, 'report.json'), status: report.status, cleanup: report.cleanup }))
}
