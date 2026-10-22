import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

// Run only through the caller's authorized browser command, with its own profiles.
const origin = (process.env.BASE_URL || process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').replace(/\/$/, '')
const production = new URL(origin).port === '8787'
if (production && process.env.T3_PRODUCTION_SMOKE !== '1') throw new Error('正式入口验收需要 T3_PRODUCTION_SMOKE=1。')
const baseline = process.env.BASELINE === '1'
const output = path.resolve(process.env.ARTIFACT_DIR || `.test-artifacts/t3-read-watermark/${baseline ? 'before' : 'after'}-${Date.now()}`)
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.BROWSER_EXECUTABLE_PATH
const explicitTargetId = process.env.TARGET_THREAD_ID || process.env.T3_READ_THREAD_ID
if (!production && !explicitTargetId) throw new Error('预发布验收必须显式设置 TARGET_THREAD_ID 为已有已完成对话；本脚本不自动选择或创建运行数据。')
const targetId = explicitTargetId || '70c4cf9a-c227-4655-b2e5-7e1794716293'
await mkdir(output, { recursive: true })
const report = { origin, baseline, startedAt: new Date().toISOString(), targetId, targetSelection: explicitTargetId ? 'explicit' : 'authorized-production-default', cases: [], visits: [], pageErrors: [], blockedRpcMutations: [], blockedHttpMutations: [], suppressedTelemetry: 0, messageDispatches: 0, initialMessages: 0, filesystemWrites: 0, cleanup: {} }
const sessions = []
let page
const ms = (value) => value ? Date.parse(value) : Number.NEGATIVE_INFINITY
async function until(read, message, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error(message)
}
const save = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
async function run(name, action) {
  const entry = { name }; report.cases.push(entry)
  try { entry.result = await action(); entry.status = 'passed' }
  catch (error) { entry.status = 'failed'; entry.error = error.message; await page?.screenshot({ path: path.join(output, name + '-failed.png') }).catch(() => {}); throw error }
  finally { await save(); console.log(JSON.stringify({ name, status: entry.status, error: entry.error })) }
}
function isMutation(method) {
  return /^orchestration\./.test(method) && !/^orchestration\.(?:get|list|search|subscribe)/.test(method) ||
    /^(?:projects|filesystem)\.(?:write|create|remove|rename|delete|move|copy)/.test(method) ||
    /^(?:server|settings)\.(?:set|update|patch|write|delete)/.test(method)
}
async function login(name) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'autoops-read-watermark-'))
  const session = { name, profile, visits: [] }; sessions.push(session)
  const context = session.context = await chromium.launchPersistentContext(profile, { headless: true, locale: 'zh-CN', viewport: { width: 1440, height: 900 }, ...(executablePath ? { executablePath } : {}) })
  await context.routeWebSocket((url) => url.pathname.endsWith('/api/agent-demo/t3/ws'), (socket) => {
    const server = socket.connectToServer(), pending = new Map()
    socket.onMessage((payload) => {
      let decoded
      try { decoded = JSON.parse(String(payload)) } catch { server.send(payload); return }
      const messages = Array.isArray(decoded) ? decoded : [decoded], allowed = []
      for (const message of messages) {
        const method = message.tag ?? '', command = message.payload
        if (command?.type === 'message.dispatch') report.messageDispatches++
        if (method === 'orchestration.launchThread' && command?.initialMessage) report.initialMessages++
        if (/^(?:projects|filesystem)\.(?:writeFile|createDirectory|remove|rename)$/.test(method)) report.filesystemWrites++
        if (method === 'orchestration.dispatchCommand' && command?.type === 'thread.visit' && targetId && command.threadId === targetId) {
          const visit = { profile: name, requestId: String(message.id), payload: { type: command.type, commandId: command.commandId, threadId: command.threadId, visitedAt: command.visitedAt }, sentAt: new Date().toISOString() }
          session.visits.push(visit); report.visits.push(visit); pending.set(String(message.id), visit); allowed.push(message)
        } else if (isMutation(method)) report.blockedRpcMutations.push({ profile: name, method, type: command?.type ?? null, threadId: command?.threadId ?? null })
        else allowed.push(message)
      }
      if (allowed.length === messages.length) server.send(payload)
      else if (allowed.length) server.send(JSON.stringify(Array.isArray(decoded) ? allowed : allowed[0]))
    })
    server.onMessage((payload) => {
      try {
        const decoded = JSON.parse(String(payload))
        for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
          const visit = pending.get(String(message.requestId))
          if (visit && message._tag === 'Exit') {
            visit.completedAt = new Date().toISOString(); visit.successful = message.exit?._tag === 'Success'
            visit.response = visit.successful ? message.exit.value : { errorTag: message.exit?._tag ?? 'unknown' }
            pending.delete(String(message.requestId))
          }
        }
      } catch {}
      socket.send(payload)
    })
  })
  await context.route('**/api/**', async (route) => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || pathname === '/api/agent-demo/login') return route.continue()
    if (request.method() === 'POST' && pathname.endsWith('/api/observability/v1/traces')) { report.suppressedTelemetry++; return route.fulfill({ status: 204, body: '' }) }
    report.blockedHttpMutations.push({ profile: name, method: request.method(), path: pathname })
    return route.fulfill({ status: 409, json: { error: '阅读水位验收仅允许指定对话的原生阅读回执。' } })
  })
  const target = session.page = page = context.pages()[0] || await context.newPage()
  target.setDefaultTimeout(15000)
  target.on('pageerror', (error) => report.pageErrors.push({ profile: name, message: error.message }))
  await target.goto(origin + '/agent-demo.html#/draft/' + randomUUID())
  await target.getByRole('textbox', { name: '用户名' }).fill('admin')
  await target.getByLabel('密码', { exact: true }).fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
  await target.getByRole('button', { name: '登录', exact: true }).click()
  await target.getByTestId('composer-editor').waitFor({ timeout: 60000 })
  assert(new URL(target.url()).hash.startsWith('#/draft/'), '初始化只允许进入本次隔离 profile 的新草稿')
  session.draftHash = new URL(target.url()).hash
  const response = await target.request.get(origin + '/api/agent-demo/t3/autoops/bootstrap')
  assert.equal(response.status(), 200); session.bootstrap = await response.json()
  session.client = new T3LiveClient(origin)
  session.client.cookie = (await context.cookies(origin)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  session.client.bootstrap = session.bootstrap; await session.client.connect()
  session.environmentId = (await session.client.rpc('server.getConfig')).environment.environmentId
  return session
}
async function summary(session) {
  const projection = await session.client.projection(targetId)
  const latestRun = [...projection.runs].sort((a, b) => b.ordinal - a.ordinal)[0]
  return { threadId: projection.thread.id, updatedAt: projection.thread.updatedAt, completedAt: latestRun?.completedAt ?? null, lastVisitedAt: projection.thread.lastVisitedAt ?? null, latestRunId: latestRun?.id ?? null, latestRunStatus: latestRun?.status ?? null }
}
const requiredReadAt = (state) => Math.max(ms(state.updatedAt), ms(state.completedAt))
const threadRow = (session) => page.locator(`[data-thread-item=${JSON.stringify(`${session.environmentId}:${targetId}`)}]`).locator('[data-testid="sidebar-row-slim"], [data-testid="sidebar-row-card"]').first()
async function badge(session) {
  return threadRow(session).evaluate((element) => ({
    completedBadgeVisible: [...element.querySelectorAll('[role="status"], span')].some((item) => item.textContent.trim() === '已完成' && !item.closest('.sr-only') && item.getBoundingClientRect().width > 0 && getComputedStyle(item).visibility !== 'hidden'),
    current: element.getAttribute('aria-current'),
  }))
}
async function openedThreadReady() {
  return until(async () => {
    if (await page.getByText('此历史对话仅支持查看。', { exact: true }).first().isVisible()) return 'readonly-history'
    if (await page.getByTestId('composer-editor').isVisible()) return 'editable-composer'
    return null
  }, '授权对话应显示编辑器或原生只读历史提示', 60000)
}
async function clickAndObserve(session) {
  const before = await summary(session)
  assert.equal(before.latestRunStatus, 'completed', '目标必须是现有已完成对话，本验收不创建或推进运行')
  const row = threadRow(session)
  await row.waitFor(); await row.scrollIntoViewIfNeeded()
  const badgeBefore = await badge(session)
  const observation = { profile: session.name, before, badgeBefore }
  report.observations ??= []; report.observations.push(observation)
  await page.screenshot({ path: path.join(output, `${session.name}-before-click.png`) })
  // The row center may land on its nested unpin/action buttons. Click the
  // native visual title itself so only the row's navigation handler receives it.
  await row.locator('span[aria-hidden].truncate').first().click()
  observation.clickTarget = 'native-title-span'
  await until(() => new URL(page.url()).hash === `#/${session.environmentId}/${targetId}`, '必须由真实侧栏点击进入唯一授权对话')
  observation.readyAfterClick = await openedThreadReady()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const needsVisit = ms(before.lastVisitedAt) < (baseline ? ms(before.updatedAt) : requiredReadAt(before))
  if (needsVisit) await until(() => session.visits.some((visit) => visit.successful), '授权目标的原生 thread.visit 未成功返回')
  let after
  if (baseline) after = await summary(session)
  else {
    after = await until(async () => { const current = await summary(session); observation.latestObservedAfter = current; return ms(current.lastVisitedAt) >= requiredReadAt(current) ? current : null }, '阅读水位必须覆盖线程更新时间与最后完成时间的较大值')
    observation.after = after
    await until(async () => !(await badge(session)).completedBadgeVisible, '个人水位更新后已完成未读徽标应消失')
  }
  const badgeAfter = await badge(session)
  Object.assign(observation, { after, badgeAfter })
  await page.screenshot({ path: path.join(output, `${session.name}-after-click.png`) })
  const result = { before, badgeBefore, after, badgeAfter, expectedReadAt: new Date(requiredReadAt(after)).toISOString(), nativeVisitCount: session.visits.length, baselineObservedBug: baseline ? ms(after.lastVisitedAt) < requiredReadAt(after) && badgeAfter.completedBadgeVisible : undefined }
  if (!baseline) {
    await page.reload(); result.readyAfterRefresh = await openedThreadReady(); await threadRow(session).waitFor()
    result.afterRefresh = await until(async () => { const current = await summary(session); return ms(current.lastVisitedAt) >= requiredReadAt(current) && !(await badge(session)).completedBadgeVisible ? current : null }, '刷新后个人已读状态必须保持')
    result.badgeAfterRefresh = await badge(session)
    await page.screenshot({ path: path.join(output, `${session.name}-after-refresh.png`) })
  }
  return result
}

try {
  const primary = await login('primary')
  await run('native-sidebar-read-watermark', () => clickAndObserve(primary))
  if (!baseline && process.env.SECOND_PROFILE !== '0') await run('independent-profile-server-read-persistence', async () => {
    const secondary = await login('secondary')
    const beforeOpening = await summary(secondary)
    assert(ms(beforeOpening.lastVisitedAt) >= requiredReadAt(beforeOpening), '第二个隔离 profile 在打开目标前就应读到服务器个人已读水位')
    return { beforeOpening, result: await clickAndObserve(secondary) }
  })
  assert.deepEqual(report.pageErrors, [])
  assert.equal(report.messageDispatches, 0); assert.equal(report.initialMessages, 0); assert.equal(report.filesystemWrites, 0)
  assert.deepEqual(report.blockedRpcMutations, [], '脚本触发了白名单以外的原生变更，已在发出前阻止')
  assert.deepEqual(report.blockedHttpMutations, [], '脚本触发了服务器 HTTP 写入，已阻止')
  assert(report.visits.every((visit) => visit.payload.threadId === targetId && visit.payload.type === 'thread.visit'), '只能更新授权目标当前用户的个人阅读水位')
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.fatal = error.message; process.exitCode = 1 }
finally {
  for (const session of sessions) {
    session.client?.close()
    await session.context?.close().catch((error) => { report.cleanup[session.name] = { error: error.message }; report.status = 'failed'; process.exitCode = 1 })
    await rm(session.profile, { recursive: true, force: true })
    report.cleanup[session.name] = { ...report.cleanup[session.name], onlyOwnedProfileRemoved: true, noServerRecordsCreated: true, targetReadStateLeftAsObserved: true }
  }
  report.finishedAt = new Date().toISOString(); await save()
}
