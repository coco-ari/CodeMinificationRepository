import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

// The caller authorizes this concrete browser command outside the restricted launcher.
const origin = (process.env.BASE_URL || process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').replace(/\/$/, '')
if (new URL(origin).port === '8787' && process.env.T3_PRODUCTION_SMOKE !== '1') throw new Error('正式入口验收需要显式设置 T3_PRODUCTION_SMOKE=1。')
const baseline = process.env.SIDEBAR_DENSITY_BASELINE === '1'
const baselineReportPath = process.env.BASELINE_REPORT ? path.resolve(process.env.BASELINE_REPORT) : null
const baselineReport = baselineReportPath ? JSON.parse(await readFile(baselineReportPath, 'utf8')) : null
const phase = baseline ? 'before' : 'after'
const output = path.resolve(process.env.ARTIFACT_DIR || `.test-artifacts/t3-sidebar-density/${phase}-${Date.now()}`)
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.BROWSER_EXECUTABLE_PATH
await mkdir(output, { recursive: true })
const report = {
  origin, baseline, phase, baselineReportPath, startedAt: new Date().toISOString(), cases: [], pageErrors: [],
  messageDispatches: 0, initialMessages: 0, filesystemWrites: 0, suppressedTelemetry: 0, blockedRpcMutations: [], blockedHttpMutations: [],
  coverage: { realExistingRows: true, ownUnsentLocalDraft: true, noExistingThreadActivated: true, synthesizedServerStates: false, themePreferencePersistence: '仅测试隔离 profile 的本地外观，不验证服务器偏好持久化' },
  cleanup: {},
}
const sessions = []
let page

async function until(read, message, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(message)
}
async function run(name, action) {
  const entry = { name }; report.cases.push(entry)
  try { entry.result = await action(); entry.status = 'passed' }
  catch (error) {
    entry.status = 'failed'; entry.error = error.stack
    if (page) {
      await writeFile(path.join(output, `${phase}-${name}-metadata.json`), JSON.stringify({ url: page.url(), geometry: report.geometry ?? [], tailGeometry: report.tailGeometry ?? [] }, null, 2)).catch(() => {})
      await page.screenshot({ path: path.join(output, `${phase}-${name}-failed.png`) }).catch(() => {})
    }
    throw error
  } finally {
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ name, status: entry.status, error: entry.error }))
  }
}
function mutationMethod(method) {
  return /^orchestration\./.test(method) && !/^orchestration\.(?:get|list|subscribe)/.test(method) ||
    /^(?:projects|filesystem)\.(?:write|create|remove|rename|delete|move|copy)/.test(method) ||
    /^(?:server|settings)\.(?:set|update|patch|write|delete)/.test(method)
}
async function login(touch) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'autoops-sidebar-density-'))
  const session = { profile, touch, name: touch ? 'touch-390' : 'desktop', draftId: randomUUID(), snapshots: new Map() }
  session.requestedDraftId = session.draftId
  sessions.push(session)
  const context = session.context = await chromium.launchPersistentContext(profile, {
    headless: true, locale: 'zh-CN', viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: touch, hasTouch: touch, ...(executablePath ? { executablePath } : {}),
  })
  // All server reads remain real. Block accidental native writes before they can touch
  // an existing thread (including mark-read); this test never mocks a mutation success.
  await context.routeWebSocket((url) => url.pathname.endsWith('/api/agent-demo/t3/ws'), (socket) => {
    const server = socket.connectToServer()
    socket.onMessage((payload) => {
      let messages
      try { const decoded = JSON.parse(String(payload)); messages = Array.isArray(decoded) ? decoded : [decoded] } catch { server.send(payload); return }
      const allowed = []
      for (const message of messages) {
        const method = message.tag ?? ''
        if (message.payload?.type === 'message.dispatch') report.messageDispatches++
        if (method === 'orchestration.launchThread' && message.payload?.initialMessage) report.initialMessages++
        if (/^(?:projects|filesystem)\.(?:writeFile|createDirectory|remove|rename)$/.test(method)) report.filesystemWrites++
        if (mutationMethod(method)) report.blockedRpcMutations.push({ session: session.name, method, type: message.payload?.type ?? null })
        else allowed.push(message)
      }
      if (allowed.length === messages.length) server.send(payload)
      else if (allowed.length) server.send(JSON.stringify(Array.isArray(JSON.parse(String(payload))) ? allowed : allowed[0]))
    })
  })
  await context.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url())
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || url.pathname === '/api/agent-demo/login') return route.continue()
    if (request.method() === 'POST' && url.pathname.endsWith('/api/observability/v1/traces')) {
      report.suppressedTelemetry++
      return route.fulfill({ status: 204, body: '' })
    }
    report.blockedHttpMutations.push({ session: session.name, method: request.method(), path: url.pathname })
    return route.fulfill({ status: 409, contentType: 'application/json', json: { error: '只读侧栏验收禁止服务器写入。' } })
  })
  const target = session.page = page = context.pages()[0] || await context.newPage()
  target.setDefaultTimeout(15000)
  target.on('pageerror', (error) => report.pageErrors.push({ session: session.name, message: error.message }))
  session.draftUrl = `${origin}/agent-demo.html#/draft/${session.draftId}`
  session.marker = `侧栏验收 ${session.draftId.slice(0, 8)}：` + '这是一条仅保存在本次隔离浏览器中的未发送长中文草稿，用于验证单行省略和键盘操作。'.repeat(4)
  await target.goto(session.draftUrl)
  await target.getByRole('textbox', { name: '用户名' }).fill('admin')
  await target.getByLabel('密码', { exact: true }).fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
  await target.getByRole('button', { name: '登录', exact: true }).click()
  await target.getByTestId('composer-editor').waitFor({ timeout: 60000 })
  const initialHash = new URL(target.url()).hash
  assert(initialHash.startsWith('#/draft/'), '登录初始化只能进入隔离 profile 的新草稿')
  // Native draft initialization may replace the requested UUID with a fresh local
  // draft. Accept that once, then keep every later navigation on that owned route.
  session.draftId = decodeURIComponent(initialHash.slice('#/draft/'.length).split('?')[0])
  session.draftHash = initialHash
  session.draftUrl = origin + '/agent-demo.html' + initialHash
  assertOwnDraft(session)
  const response = await target.request.get(origin + '/api/agent-demo/t3/autoops/bootstrap')
  assert.equal(response.status(), 200)
  session.bootstrap = await response.json()
  await target.getByTestId('composer-editor').fill(session.marker)
  await until(() => target.evaluate((marker) => Object.keys(localStorage).filter((key) => key.includes('composer')).some((key) => localStorage.getItem(key)?.includes(marker)), session.marker), '自己的草稿必须先由原生编辑器保存到隔离 profile')
  await ensureSidebar(session)
  // The native sidebar freezes the active draft preview while editing. The later
  // appearance round trip remounts it from this already-persisted local draft.
  session.client = new T3LiveClient(origin)
  session.client.cookie = (await context.cookies(origin)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  session.client.bootstrap = session.bootstrap
  await session.client.connect()
  session.environmentId = (await session.client.rpc('server.getConfig')).environment.environmentId
  return session
}
const sidebar = () => page.locator('[data-sidebar="sidebar"]:visible').first()
const allRows = () => sidebar().locator('[data-testid="sidebar-row-slim"], [data-testid="sidebar-row-card"], [data-testid="sidebar-draft-row"]')
const ownDraftRow = (session) => sidebar().getByTestId('sidebar-draft-row').filter({ hasText: session.marker })
function assertOwnDraft(session) {
  assert.equal(new URL(page.url()).hash, session.draftHash, '验收不能激活任何已有对话')
}
async function ensureSidebar(session) {
  if (!await sidebar().isVisible()) await page.getByRole('button', { name: '切换主侧栏', exact: true }).filter({ visible: true }).first().click()
  await sidebar().waitFor()
  if (session.touch) assert.equal(await sidebar().getAttribute('data-mobile'), 'true', '390px 必须使用原生移动侧栏')
}
async function closeMobileSidebar(session) {
  if (!session.touch) return
  const mobile = page.locator('[data-sidebar="sidebar"][data-mobile="true"]:visible').first()
  if (!await mobile.isVisible()) return
  const toggle = mobile.locator('[data-sidebar="trigger"]').filter({ visible: true }).first()
  if (await toggle.isVisible()) await toggle.click()
  else await page.keyboard.press('Escape')
  await until(async () => !await mobile.isVisible(), '移动端原生侧栏应先关闭，避免目标页面被 modal inert')
}
async function theme(session, mode) {
  assertOwnDraft(session)
  await closeMobileSidebar(session)
  await page.goto(origin + '/agent-demo.html#/settings/appearance')
  await page.getByRole('group', { name: '外观模式', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
  await closeMobileSidebar(session)
  const group = page.getByRole('group', { name: '外观模式', exact: true })
  await group.getByRole('button', { name: mode === 'dark' ? '使用深色模式' : '使用浅色模式', exact: true }).click()
  await until(() => page.evaluate((dark) => document.documentElement.classList.contains('dark') === dark, mode === 'dark'), '隔离 profile 外观未切换')
  await page.goto(session.draftUrl)
  await page.getByTestId('composer-editor').waitFor()
  assertOwnDraft(session)
  await ensureSidebar(session)
  await ownDraftRow(session).waitFor()
}
async function measureRows(session) {
  return allRows().evaluateAll((elements, { projectNames }) => elements.flatMap((element) => {
    const rectangle = (rect) => rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null
    const rect = element.getBoundingClientRect(), surface = element.closest('[data-sidebar="sidebar"]')?.getBoundingClientRect()
    const scrollViewport = element.closest('[data-slot="scroll-area-viewport"]')
    const viewport = scrollViewport?.getBoundingClientRect() ?? surface
    if (!surface || !viewport || rect.height <= 0 || rect.top < viewport.top - 1 || rect.bottom > viewport.bottom + 1) return []
    const candidates = [...element.querySelectorAll('.truncate')]
    const title = candidates.find((candidate) => candidate.hasAttribute('aria-hidden')) ?? candidates.at(-1)
    const style = title ? getComputedStyle(title) : null, titleRect = title?.getBoundingClientRect()
    const rightActions = [...element.querySelectorAll('[role="status"], button[aria-label="对话更多操作"], button[aria-label="丢弃草稿"], button[aria-label="丢弃未发送草稿"], [aria-label="取消置顶对话"]')].flatMap((action) => {
      const box = action.getBoundingClientRect(), css = getComputedStyle(action)
      if (action.closest('.sr-only, [hidden]') || box.width <= 0 || box.height <= 0 || css.display === 'none' || css.visibility === 'hidden') return []
      return [{ label: action.getAttribute('aria-label') ?? action.textContent.trim(), rect: rectangle(box), nativeHitAreaRects: [...action.querySelectorAll('span[aria-hidden]')].map((span) => rectangle(span.getBoundingClientRect())).filter((box) => box.width > 0 && box.height > 0) }]
    })
    const texts = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement
      if (!parent || title?.contains(parent) || parent.closest('.sr-only, [hidden]')) continue
      const box = parent.getBoundingClientRect(), css = getComputedStyle(parent), text = node.textContent.trim()
      if (text && box.width > 2 && box.height > 2 && css.display !== 'none' && css.visibility !== 'hidden' && Number(css.opacity) > 0) texts.push(text)
    }
    return [{
      testId: element.getAttribute('data-testid'), key: element.closest('[data-thread-item]')?.getAttribute('data-thread-item') ?? null,
      height: rect.height, width: rect.width, title: title?.textContent?.trim() ?? '',
      rowRect: rectangle(rect), sidebarRect: rectangle(surface), viewportRect: rectangle(viewport), titleRect: rectangle(titleRect), rightActions,
      viewportClientWidth: scrollViewport?.clientWidth ?? viewport.width, viewportScrollWidth: scrollViewport?.scrollWidth ?? viewport.width, viewportScrollLeft: scrollViewport?.scrollLeft ?? 0,
      titleHeight: titleRect?.height ?? null, lineHeight: style ? Number.parseFloat(style.lineHeight) : null,
      whiteSpace: style?.whiteSpace, textOverflow: style?.textOverflow, overflowX: style?.overflowX,
      titleClientWidth: title?.clientWidth ?? null, titleScrollWidth: title?.scrollWidth ?? null,
      ariaLabel: element.getAttribute('aria-label'), current: element.getAttribute('aria-current'), tabIndex: element.tabIndex,
      visibleProjectLabels: texts.filter((text) => projectNames.includes(text)),
      statusLabels: [...element.querySelectorAll('[role="status"], [aria-label]')].map((item) => item.getAttribute('aria-label') || item.textContent.trim()).filter(Boolean),
      pinned: Boolean(element.querySelector('[aria-label="取消置顶对话"], [aria-label="已置顶"]')),
    }]
  }), { projectNames: session.bootstrap.projects.map((project) => project.name) })
}
function previousRow(session, mode, row) {
  if (!baselineReport) return null
  const sameViewport = (item) => item.session === session.name && item.mode === mode && item.media?.width === (session.touch ? 390 : 1440)
  const previous = (baselineReport.geometry ?? baselineReport.cases?.flatMap((entry) => entry.result?.captures ?? []) ?? []).find(sameViewport)
  // Server row identities are real and environment-qualified. Never compare
  // unrelated stage/production rows, nor persist a synthetic server fixture.
  return row.key ? previous?.rows.find((item) => item.key === row.key) ?? null : previous?.rows.find((item) => !item.key && item.testId === 'sidebar-draft-row') ?? null
}
async function measureTail(row) {
  return row.evaluate((element) => {
    const rectangle = (rect) => rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null
    const effectiveOpacity = (item) => {
      if (!item) return 0
      let opacity = 1
      for (let current = item; current && current !== element.parentElement; current = current.parentElement) {
        const css = getComputedStyle(current)
        if (css.display === 'none' || css.visibility === 'hidden') return 0
        opacity *= Number(css.opacity)
      }
      return opacity
    }
    const shown = (item) => {
      if (!item) return false
      const rect = item.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && effectiveOpacity(item) > 0.9
    }
    const clippedRectangle = (item) => {
      const source = item.getBoundingClientRect()
      let left = source.left, right = source.right, top = source.top, bottom = source.bottom
      for (let parent = item.parentElement; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent), box = parent.getBoundingClientRect()
        if (/hidden|clip|scroll|auto/.test(css.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right) }
        if (/hidden|clip|scroll|auto/.test(css.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom) }
      }
      return { left, right, top, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
    }
    const titleCandidates = [...element.querySelectorAll('.truncate')]
    const title = element.querySelector('[data-slot="sidebar-row-title"]') ?? titleCandidates.find((item) => item.hasAttribute('aria-hidden')) ?? titleCandidates.at(-1)
    const tail = element.querySelector('[data-slot="sidebar-row-tail"]')
    const statusSlot = element.querySelector('[data-slot="sidebar-row-tail-status"]')
    const actionsSlot = element.querySelector('[data-slot="sidebar-row-tail-actions"]')
    const statuses = [...element.querySelectorAll('[role="status"]')]
    const completedStatus = statuses.find((item) => (item.getAttribute('aria-label') ?? item.textContent).includes('已完成'))
    const more = element.querySelector('button[aria-label="对话更多操作"]')
    const discard = element.querySelector('button[aria-label="丢弃草稿"], button[aria-label="丢弃未发送草稿"]')
    const action = more ?? discard
    const actionBounds = [...statuses, ...element.querySelectorAll('button[aria-label="对话更多操作"], button[aria-label="丢弃草稿"], button[aria-label="丢弃未发送草稿"], [aria-label="取消置顶对话"]')].map((item) => item.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0)
    const rowRect = element.getBoundingClientRect(), titleRect = title?.getBoundingClientRect(), tailRect = tail?.getBoundingClientRect()
    const viewportRect = (element.closest('[data-slot="scroll-area-viewport"]') ?? element.closest('[data-sidebar="sidebar"]')).getBoundingClientRect()
    const hitAreaElements = action ? [action, ...action.querySelectorAll('span[aria-hidden]')] : []
    const hitAreas = hitAreaElements.map(clippedRectangle).filter((rect) => rect.width > 0 && rect.height > 0)
    const hit = action ? document.elementFromPoint(action.getBoundingClientRect().left + action.getBoundingClientRect().width / 2, action.getBoundingClientRect().top + action.getBoundingClientRect().height / 2) : null
    const boundaryPoints = action && titleRect ? [
      { boundary: 'title', x: titleRect.right - 1, y: rowRect.top + rowRect.height / 2 },
      { boundary: 'previous-row', x: action.getBoundingClientRect().left + action.getBoundingClientRect().width / 2, y: rowRect.top - 1 },
      { boundary: 'next-row', x: action.getBoundingClientRect().left + action.getBoundingClientRect().width / 2, y: rowRect.bottom + 1 },
    ].map((point) => {
      const target = document.elementFromPoint(point.x, point.y)
      return { ...point, hitsOwnAction: Boolean(target && (action === target || action.contains(target))) }
    }) : []
    return {
      rowRect: rectangle(rowRect), viewportRect: rectangle(viewportRect), titleRect: rectangle(titleRect), tailRect: rectangle(tailRect),
      sideReservedWidth: titleRect ? rowRect.right - titleRect.right : null,
      actionEnvelopeWidth: actionBounds.length ? Math.max(...actionBounds.map((rect) => rect.right)) - Math.min(...actionBounds.map((rect) => rect.left)) : 0,
      tailPresent: Boolean(tail), tailDisplay: tail ? getComputedStyle(tail).display : null,
      statusPresent: statuses.length > 0, completedStatusPresent: Boolean(completedStatus), completedStatusVisible: shown(completedStatus),
      statusSlotVisible: shown(statusSlot), actionVisible: shown(action), actionOpacity: effectiveOpacity(action), actionFocused: action === document.activeElement,
      statusGridArea: statusSlot ? getComputedStyle(statusSlot).gridArea : null,
      actionsGridArea: actionsSlot ? getComputedStyle(actionsSlot).gridArea : null,
      slotsShareParent: Boolean(statusSlot && actionsSlot && statusSlot.parentElement === actionsSlot.parentElement),
      actionsOverlayGrid: Boolean(tail && statusSlot && actionsSlot && getComputedStyle(tail).display.endsWith('grid') && getComputedStyle(statusSlot).gridArea === getComputedStyle(actionsSlot).gridArea),
      completedStatusRect: rectangle(completedStatus?.getBoundingClientRect()),
      actionRect: rectangle(action?.getBoundingClientRect()), actionHitAreaRects: hitAreas,
      rawActionHitAreaRects: hitAreaElements.map((item) => rectangle(item.getBoundingClientRect())),
      actionCenterHit: Boolean(action && hit && (action === hit || action.contains(hit))), boundaryHitProbes: boundaryPoints,
    }
  })
}
function assertTailBounds(geometry, session) {
  assert(geometry.tailPresent, '原生紧凑行必须存在唯一共享尾槽')
  assert(geometry.tailRect.left >= geometry.titleRect.right - 1 && geometry.tailRect.right <= geometry.rowRect.right + 1, '尾槽必须位于标题后且在本行内')
  assert(geometry.tailRect.left >= geometry.viewportRect.left - 1 && geometry.tailRect.right <= geometry.viewportRect.right + 1, '尾槽必须完整留在内部滚动视窗')
  if (session.touch) {
    assert(geometry.actionVisible && geometry.actionCenterHit, '触屏原生更多/删除入口必须可见，中心点击命中自己的按钮')
    assert(geometry.actionRect.width >= 44 && geometry.actionRect.height >= 44, '触屏原生操作按钮必须有至少 44px 的实际命中区域')
    assert(geometry.boundaryHitProbes.every((point) => !point.hitsOwnAction), '标题及相邻行实际坐标不能命中本行的操作扩展区域')
    if (geometry.completedStatusPresent) assert(geometry.completedStatusRect.right <= geometry.actionRect.left + 1, '触屏真实完成状态与更多按钮必须分开可读')
    for (const box of geometry.actionHitAreaRects) {
      assert(box.left >= geometry.titleRect.right - 1, '触屏操作扩展命中区域不能跨入标题')
      assert(box.left >= geometry.viewportRect.left - 1 && box.right <= geometry.viewportRect.right + 1, '触屏操作扩展命中区域不能溢出视窗')
      assert(box.top >= geometry.rowRect.top - 1 && box.bottom <= geometry.rowRect.bottom + 1, '触屏操作扩展命中区域不能跨入相邻行')
    }
  }
}
async function verifyTail(session, mode, sample) {
  const row = sample.key
    ? sidebar().locator(`[data-thread-item=${JSON.stringify(sample.key)}]`).getByTestId('sidebar-row-slim')
    : ownDraftRow(session)
  const result = { session: session.name, mode, key: sample.key, ownDraft: !sample.key, states: {} }
  report.tailGeometry ??= []; report.tailGeometry.push(result)
  await page.mouse.move(0, 0)
  // Focus another owned row to clear :focus-within without activating a real
  // conversation. This keeps the default measurement independent of theme UI.
  if (sample.key) await ownDraftRow(session).focus()
  else await sidebar().getByRole('combobox', { name: '搜索对话', exact: true }).focus()
  if (!baseline && !session.touch) await until(async () => (await measureTail(row)).actionOpacity <= 0.01, '桌面默认态低频操作应在离开后收起')
  result.states.default = await measureTail(row)
  if (!baseline) {
    assertTailBounds(result.states.default, session)
    if (result.states.default.completedStatusPresent) assert(result.states.default.completedStatusVisible, '真实未读完成状态在默认态必须可读')
    if (!session.touch) assert.equal(result.states.default.actionVisible, false, '桌面默认不显示低频操作，尾槽保留稳定占位')
  }
  if (!session.touch) {
    await row.hover()
    if (!baseline) await until(async () => (await measureTail(row)).actionVisible, '桌面 hover 必须显示原更多/删除操作')
    result.states.hover = await measureTail(row)
    await page.mouse.move(0, 0)
    await page.keyboard.press('Tab'); await row.focus()
    if (!baseline) await until(async () => (await measureTail(row)).actionVisible, '桌面键盘聚焦必须显示原更多/删除操作')
    result.states.focus = await measureTail(row)
    const action = row.getByRole('button', { name: sample.key ? '对话更多操作' : '丢弃草稿', exact: true })
    if (!baseline) {
      await action.focus()
      result.states.actionFocus = await measureTail(row)
      assert(result.states.actionFocus.actionVisible && result.states.actionFocus.actionFocused, '操作自身必须能获得键盘焦点且保持可见')
      for (const [state, geometry] of Object.entries(result.states)) {
        assertTailBounds(geometry, session)
        assert(Math.abs(geometry.titleRect.width - result.states.default.titleRect.width) <= 1, `桌面 ${state} 不能使标题宽度跳动`)
        assert(Math.abs(geometry.tailRect.width - result.states.default.tailRect.width) <= 1, `桌面 ${state} 不能使尾槽宽度跳动`)
        if (geometry.completedStatusPresent) {
          assert(geometry.slotsShareParent && geometry.actionsOverlayGrid, '真实完成状态与低频操作必须共用同一 grid 单元，不再占独立 flex 列')
          if (state !== 'default') assert.equal(geometry.completedStatusVisible, false, '非交互完成提示在 hover/focus 时让位给同槽操作')
        }
      }
    }
  } else if (!baseline && result.states.default.completedStatusPresent) {
    assert(result.states.default.completedStatusVisible && result.states.default.actionVisible, '触屏必须同时保留真实完成状态与更多入口')
  }
  const previous = previousRow(session, mode, sample)
  result.comparison = previous ? {
    sameRealRow: Boolean(sample.key), sameViewport: true,
    beforeTitleWidth: previous.titleRect.width, afterTitleWidth: result.states.default.titleRect.width,
    titleWidthGain: result.states.default.titleRect.width - previous.titleRect.width,
    beforeSideReservedWidth: previous.rowRect.right - previous.titleRect.right,
    afterSideReservedWidth: result.states.default.sideReservedWidth,
    sideReservedWidthReduction: previous.rowRect.right - previous.titleRect.right - result.states.default.sideReservedWidth,
    ownDraftComparison: sample.key ? null : '各隔离 profile 原生未发送草稿的相同布局，不比较不同草稿内容',
  } : { skipped: baselineReport ? '该基线中没有同 viewport 的相同真实 row；不比较不同环境数据' : '未指定 BASELINE_REPORT' }
  result.coverage = { realCompletedStatus: result.states.default.completedStatusPresent, noSynthesizedStatus: true, missingStateReason: result.states.default.completedStatusPresent ? null : '本视窗没有真实已完成状态，此项不造数据' }
  assertOwnDraft(session)
  await page.mouse.move(0, 0)
  if (sample.key) await ownDraftRow(session).focus()
  else await sidebar().getByRole('combobox', { name: '搜索对话', exact: true }).focus()
  return result
}
async function capture(session, mode) {
  await page.mouse.move(0, 0)
  const media = await page.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, fine: matchMedia('(pointer: fine)').matches, width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, touchPoints: navigator.maxTouchPoints }))
  if (session.touch) { assert.equal(media.coarse, true); assert(media.touchPoints > 0); assert.equal(media.width, 390) }
  const rows = await until(async () => { const rows = await measureRows(session); return rows.some((row) => row.key) && rows.some((row) => row.title === session.marker) ? rows : null }, '需要现有真实会话及本次未发送草稿来测量侧栏')
  const scope = sidebar().getByTestId('sidebar-project-scope-label')
  const scopeCount = await scope.count(), scopeText = scopeCount ? await scope.innerText() : null
  const measurement = { session: session.name, mode, media, scopeCount, scopeText, rows, densityAssertionsSkipped: baseline }
  // Preserve the actual geometry even when a new layout assertion fails before
  // the enclosing case can return, so clipped internal scroll areas are diagnosable.
  report.geometry ??= []; report.geometry.push(measurement)
  if (!baseline) {
    assert.equal(scopeCount, 1, '项目范围应在列表上方只显示一次')
    assert(scopeText?.trim(), '项目范围标题不能为空')
    assert(media.scrollWidth <= media.width + 1, '侧栏不得导致页面横向溢出')
    for (const row of rows) {
      assert(session.touch ? row.height >= 44 : row.height >= 36 && row.height <= 40, `实际侧栏行高不符合密度：${row.testId} ${row.height}px`)
      assert(row.width <= row.viewportRect.width + 1, `行宽不得撑大内部滚动内容：${row.width}px > viewport ${row.viewportRect.width}px`)
      assert(row.rowRect.left >= row.viewportRect.left - 1 && row.rowRect.right <= row.viewportRect.right + 1, '行左右边界必须留在侧栏滚动视窗内')
      assert(row.titleRect && row.titleRect.width > 0 && row.titleRect.width <= row.viewportRect.width + 1, '标题必须有受侧栏约束的可用宽度')
      assert(row.titleRect.left >= row.rowRect.left - 1 && row.titleRect.right <= row.rowRect.right + 1, '标题不能溢出本行边界')
      assert(row.titleClientWidth <= row.viewportClientWidth + 1, '标题 clientWidth 不能继承内部 table 的最大内容宽')
      for (const action of row.rightActions) {
        assert(action.rect.left >= row.viewportRect.left - 1 && action.rect.right <= row.viewportRect.right + 1, `右侧状态或操作被裁出视窗：${action.label}`)
        assert(action.rect.left >= row.titleRect.right - 1, `右侧状态或操作不得与标题重叠：${action.label}`)
        if (session.touch) for (const hitArea of action.nativeHitAreaRects) assert(hitArea.left >= row.viewportRect.left - 1 && hitArea.right <= row.viewportRect.right + 1, `触屏操作扩展区域被裁出视窗：${action.label}`)
      }
      if (row.key) assert.equal(row.testId, 'sidebar-row-slim', '真实对话必须沿用原生 slim 行')
      assert.equal(row.whiteSpace, 'nowrap', '标题必须单行')
      assert.equal(row.textOverflow, 'ellipsis', '长标题必须省略')
      assert.equal(row.overflowX, 'hidden', '标题省略不得撑宽侧栏')
      assert(row.titleHeight <= row.lineHeight + 1, '标题实际高度不得超过一行')
      assert.deepEqual(row.visibleProjectLabels, [], '每行不得重复显示项目名；ARIA 与 tooltip 可保留完整范围')
      assert.equal(row.tabIndex, 0, '行必须保留原生键盘焦点')
    }
    const own = rows.find((row) => row.title === session.marker)
    assert(own.titleScrollWidth > own.titleClientWidth, '自己的长草稿必须实际触发省略，不能只检查 class')
  }
  await page.mouse.move(0, 0)
  await page.screenshot({ path: path.join(output, `${phase}-${session.name}-${mode}.png`) })
  return measurement
}
async function compareProjection(session, rows) {
  const checked = []
  for (const row of rows.filter((row) => row.key?.startsWith(session.environmentId + ':')).slice(0, 5)) {
    const threadId = row.key.slice(session.environmentId.length + 1)
    const projection = await session.client.projection(threadId), thread = projection.thread
    assert(row.ariaLabel?.includes(thread.title), '压缩后 ARIA 必须保留真实完整标题')
    if (!baseline) assert.equal(row.pinned, Boolean(thread.pinnedAt), '已有置顶状态必须保留，无需在测试中切换置顶')
    const latestRun = [...projection.runs].sort((a, b) => b.ordinal - a.ordinal)[0]
    const pendingKinds = projection.runtimeRequests.filter((request) => request.status === 'pending').map((request) => request.kind)
    const metadata = { title: thread.title, pinnedAt: thread.pinnedAt ?? null, lastVisitedAt: thread.lastVisitedAt ?? null, archivedAt: thread.archivedAt, settledOverride: thread.settledOverride }
    session.snapshots.set(threadId, metadata)
    checked.push({ threadId, pinned: Boolean(thread.pinnedAt), lastVisitedAt: thread.lastVisitedAt ?? null, latestRunStatus: latestRun?.status ?? null, pendingRequestKinds: pendingKinds, displayedAriaLabel: row.ariaLabel, displayedStatuses: row.statusLabels })
  }
  return { checked, limitation: '只记录真实出现的状态；未出现的运行/失败/授权状态不造数据，也不声称已验证。' }
}
async function verifyMenuKeyboard(session, trigger, suffix) {
  const menu = page.getByRole('menu')
  await menu.waitFor()
  const state = () => menu.locator('[role="menuitem"]').evaluateAll((elements) => {
    const enabled = elements.filter((element) => element.getAttribute('aria-disabled') !== 'true' && !element.hasAttribute('disabled') && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().height > 0)
    return { labels: enabled.map((element) => element.textContent.trim()), focusedIndex: enabled.findIndex((element) => element === document.activeElement || element.contains(document.activeElement)) }
  })
  const initial = await until(async () => { const value = await state(); return value.labels.length && value.focusedIndex === 0 ? value : null }, '菜单打开后首个可用项必须获得真实键盘焦点')
  const transitions = [{ key: 'open', focusedIndex: initial.focusedIndex }]
  for (const [key, expectedIndex] of [['ArrowDown', initial.labels.length > 1 ? 1 : 0], ['ArrowUp', 0], ['End', initial.labels.length - 1], ['Home', 0]]) {
    await page.keyboard.press(key)
    await until(async () => (await state()).focusedIndex === expectedIndex, `菜单 ${key} 没有导航到正确的可用项`)
    transitions.push({ key, focusedIndex: expectedIndex })
  }
  await page.screenshot({ path: path.join(output, `${phase}-${session.name}-${suffix}.png`) })
  await page.keyboard.press('Escape')
  await until(async () => !await menu.isVisible(), 'Escape 应关闭菜单，不执行任何动作')
  await until(() => trigger.evaluate((element) => element === document.activeElement), 'Escape 关闭菜单后必须恢复触发器焦点')
  assertOwnDraft(session)
  return { labels: initial.labels, transitions, firstItemActuallyFocused: true, escapeRestoresTriggerFocus: true, noActionActivated: true }
}
async function interaction(session, sample) {
  const row = sidebar().locator(`[data-thread-item=${JSON.stringify(sample.key)}]`).locator('[data-testid="sidebar-row-slim"]')
  await page.keyboard.press('Tab')
  await row.focus()
  assert(await row.evaluate((element) => element === document.activeElement && element.matches(':focus-visible')), '键盘焦点必须可见且不能激活已有对话')
  assertOwnDraft(session)
  await page.screenshot({ path: path.join(output, `${phase}-${session.name}-keyboard-focus.png`) })
  const more = row.getByRole('button', { name: '对话更多操作', exact: true })
  let touchMoreGeometry = null
  if (session.touch) {
    touchMoreGeometry = await more.evaluate((element) => {
      const rectangle = (rect) => ({ left: rect.left, right: rect.right, width: rect.width, height: rect.height })
      const viewport = element.closest('[data-slot="scroll-area-viewport"]') ?? element.closest('[data-sidebar="sidebar"]')
      return {
        buttonRect: rectangle(element.getBoundingClientRect()), viewportRect: rectangle(viewport.getBoundingClientRect()),
        nativeHitAreaRects: [...element.querySelectorAll('span[aria-hidden]')].map((span) => rectangle(span.getBoundingClientRect())).filter((box) => box.width > 0 && box.height > 0),
        opacity: Number(getComputedStyle(element).opacity), scrollLeftBefore: viewport.scrollLeft, documentScrollLeftBefore: document.documentElement.scrollLeft,
      }
    })
    assert(touchMoreGeometry.buttonRect.height > 0 && touchMoreGeometry.opacity > 0, '触屏更多入口必须常驻并可点按；行触摸高度另行严格验证')
    for (const box of [touchMoreGeometry.buttonRect, ...touchMoreGeometry.nativeHitAreaRects]) assert(box.left >= touchMoreGeometry.viewportRect.left - 1 && box.right <= touchMoreGeometry.viewportRect.right + 1, '点按前更多入口及其原生触摸区域必须完整在侧栏视窗内')
    await more.tap()
    const after = await row.evaluate((element) => ({ scrollLeftAfter: (element.closest('[data-slot="scroll-area-viewport"]') ?? element.closest('[data-sidebar="sidebar"]')).scrollLeft, documentScrollLeftAfter: document.documentElement.scrollLeft }))
    Object.assign(touchMoreGeometry, after)
    assert.equal(after.scrollLeftAfter, touchMoreGeometry.scrollLeftBefore, '点按更多入口不得依赖 Playwright 横向滚动内部视窗')
    assert.equal(after.documentScrollLeftAfter, touchMoreGeometry.documentScrollLeftBefore, '点按更多入口不得横向滚动页面')
  } else { await row.hover(); await more.click() }
  const moreMenu = await verifyMenuKeyboard(session, more, 'row-menu-keyboard')
  await row.focus(); await row.press('Shift+F10')
  const rowKeyboardMenu = await verifyMenuKeyboard(session, row, 'row-shift-f10-menu')
  const own = ownDraftRow(session)
  await own.focus(); await own.press('Shift+F10')
  const draftKeyboardMenu = await verifyMenuKeyboard(session, own, 'draft-shift-f10-menu')
  const search = sidebar().getByRole('combobox', { name: '搜索对话', exact: true })
  const query = Array.from(sample.title).slice(0, 12).join('')
  await search.fill(query)
  const result = page.getByRole('listbox', { name: '对话搜索结果', exact: true })
  await result.locator(`[data-search-result-key=${JSON.stringify(sample.key)}]`).waitFor()
  await search.press('ArrowDown'); await search.press('ArrowUp')
  const activeId = await search.getAttribute('aria-activedescendant')
  assert(activeId && await result.locator(`[id=${JSON.stringify(activeId)}][role="option"]`).count() === 1, '原生搜索键盘高亮应指向真实选项')
  await page.screenshot({ path: path.join(output, `${phase}-${session.name}-search.png`) })
  await search.press('Escape')
  let searchEscapeClosesMobileSidebar = false, searchQueryAfterReopen = null
  if (session.touch) {
    // The native mobile Sheet owns capture-phase Escape. Observe its real exit
    // instead of assuming the now-inert search input handled and cleared it.
    await until(async () => !await sidebar().isVisible(), '移动端 Escape 应退出原生侧栏抽屉')
    searchEscapeClosesMobileSidebar = true
    assertOwnDraft(session)
    await ensureSidebar(session)
    searchQueryAfterReopen = await search.inputValue()
    await page.screenshot({ path: path.join(output, `${phase}-${session.name}-search-reopened-after-escape.png`) })
    if (searchQueryAfterReopen) await sidebar().getByRole('button', { name: '清除对话搜索', exact: true }).click()
    else await search.fill('')
    await until(async () => await search.inputValue() === '' && !await result.isVisible(), '重新打开移动侧栏后应能显式清空本地搜索')
  } else {
    await until(async () => await search.inputValue() === '' && !await result.isVisible(), '桌面 Escape 应清空原生搜索')
  }
  assertOwnDraft(session)
  return { keyboardFocusVisible: true, moreMenu, rowKeyboardMenu, draftKeyboardMenu, menuOpenedAndEscapedOnly: true, touchMoreButtonTapped: session.touch, touchMoreGeometry, searchQuery: query, searchKeyboardHighlight: true, searchEscapeClosesMobileSidebar, searchQueryAfterReopen, searchExplicitlyClearedAfterReopen: session.touch, desktopEscapeClearsSearch: !session.touch, searchExcerptHeightNotConstrained: true, noExistingThreadActivated: true }
}

try {
  for (const touch of [false, true]) await run(touch ? 'touch-390-density' : 'desktop-density', async () => {
    const session = await login(touch)
    const captures = [], tailChecks = []
    const check = async (mode) => {
      const measurement = await capture(session, mode)
      captures.push(measurement)
      const targetId = process.env.SIDEBAR_TARGET_THREAD_ID
      const sample = targetId
        ? measurement.rows.find((row) => row.key?.endsWith(':' + targetId))
        : measurement.rows.find((row) => row.key && row.statusLabels.some((label) => label.includes('已完成'))) ?? measurement.rows.find((row) => row.key)
      assert(sample, '真实会话行必须在本次视窗内，显式指定目标时不能替换成其他对话')
      tailChecks.push(await verifyTail(session, mode, sample))
      tailChecks.push(await verifyTail(session, mode, measurement.rows.find((row) => row.title === session.marker)))
    }
    for (const mode of ['light', 'dark']) { await theme(session, mode); await check(mode) }
    const projection = await compareProjection(session, captures[0].rows)
    const sample = captures.at(-1).rows.find((row) => row.key && row.statusLabels.some((label) => label.includes('已完成'))) ?? captures.at(-1).rows.find((row) => row.key)
    const interactions = baseline ? { skipped: '基线仅记录旧版截图与几何' } : await interaction(session, sample)
    if (!session.touch) {
      await page.setViewportSize({ width: 1440, height: 560 })
      await check('dark-short')
      const shortSample = captures.at(-1).rows.find((row) => row.key)
      interactions.shortWindow = baseline ? { skipped: '基线只测量' } : await interaction(session, shortSample)
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    assertOwnDraft(session)
    return { requestedDraftId: session.requestedDraftId, nativeOwnedDraftId: session.draftId, captures, tailChecks, projection, interactions }
  })
  assert.deepEqual(report.pageErrors, [])
  assert.equal(report.messageDispatches, 0)
  assert.equal(report.initialMessages, 0)
  assert.equal(report.filesystemWrites, 0)
  assert.deepEqual(report.blockedRpcMutations, [], '有原生服务器写入尝试，已在发出前阻止')
  assert.deepEqual(report.blockedHttpMutations, [], '有 HTTP 写入尝试，已阻止')
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.fatal = error.stack; process.exitCode = 1 }
finally {
  for (const session of sessions) {
    const cleanup = report.cleanup[session.name] = {}
    try {
      if (session.client) {
        cleanup.readOnlyMetadataChecks = []
        for (const [threadId, before] of session.snapshots) {
          const { thread } = await session.client.projection(threadId)
          const after = { title: thread.title, pinnedAt: thread.pinnedAt ?? null, lastVisitedAt: thread.lastVisitedAt ?? null, archivedAt: thread.archivedAt, settledOverride: thread.settledOverride }
          cleanup.readOnlyMetadataChecks.push({ threadId, unchanged: JSON.stringify(before) === JSON.stringify(after) })
        }
      }
      page = session.page
      if (page && new URL(page.url()).hash === session.draftHash) {
        if (session.touch && await sidebar().isVisible()) await page.getByRole('button', { name: '切换主侧栏', exact: true }).filter({ visible: true }).first().click()
        const editor = page.getByTestId('composer-editor')
        await editor.click(); await editor.press('ControlOrMeta+A'); await editor.press('Backspace'); await editor.press('Escape')
        await until(async () => (await editor.innerText()).trim() === '', '自己的未发送草稿未清空')
        cleanup.ownLocalDraftCleared = true
      }
    } catch (error) { cleanup.error = error.message; process.exitCode = 1; report.status = 'failed' }
    finally {
      session.client?.close()
      await session.context?.close().catch((error) => { cleanup.browserError = error.message; process.exitCode = 1; report.status = 'failed' })
      await rm(session.profile, { recursive: true, force: true })
      cleanup.onlyOwnedProfileRemoved = true
    }
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
