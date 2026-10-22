import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'

// Launch this concrete command through the caller's unsandboxed browser approval.
// The only write accepted by the server is authentication. Project selection
// uses useNewThreadHandler's native, unsent local composer draft, never launchThread.
const origin = (process.env.BASE_URL || 'http://192.168.31.157:18887').replace(/\/$/, '')
if (new URL(origin).port === '8787' && process.env.T3_PRODUCTION_SMOKE !== '1') throw new Error('正式入口验收须显式设置 T3_PRODUCTION_SMOKE=1。')
const baseline = process.env.BASELINE === '1'
const output = path.resolve(process.env.ARTIFACT_DIR || `.test-artifacts/t3-project-search/${baseline ? 'before' : 'after'}-${Date.now()}`)
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.BROWSER_EXECUTABLE_PATH
await mkdir(output, { recursive: true })
const report = {
  origin, baseline, startedAt: new Date().toISOString(), cases: [], diagnostics: [], pageErrors: [],
  blockedRpcMutations: [], blockedHttpMutations: [], messageDispatches: 0, initialMessages: 0, filesystemWrites: 0,
  suppressedTelemetry: 0, localToastDismissals: { closed: 0, expiredDuringClick: 0, exitAnimationWaits: 0 },
  coverage: { existingThreadsActivated: false, syntheticProjectData: false, onlyLocalUnsentDrafts: true, themePreference: '隔离浏览器 profile 中的本地外观设置' }, cleanup: {},
}
const sessions = []
let page
async function until(read, message, timeout = 15000) {
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
    if (page) await page.screenshot({ path: path.join(output, `${name}-failed.png`) }).catch(() => {})
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
const sidebar = () => page.locator('[data-sidebar="sidebar"]:visible').first()
const palette = () => page.getByTestId('command-palette').filter({ visible: true })
const search = () => palette().locator('input').first()
const options = () => palette().getByRole('option')
async function assertDraft() {
  assert(new URL(page.url()).hash.startsWith('#/draft/'), '只能进入本次隔离 profile 的本地新草稿，禁止激活旧对话')
  // Empty contenteditables retain a native line-break placeholder. Ignore only
  // surrounding whitespace; any actual user text must still fail this guard.
  assert.equal((await page.getByTestId('composer-editor').innerText()).trim(), '', '未发送输入框应保持空白')
}
async function ensureSidebar(session) {
  if (!await sidebar().isVisible()) await page.getByRole('button', { name: '切换主侧栏', exact: true }).filter({ visible: true }).first().click()
  await sidebar().waitFor()
  if (session.touch) assert.equal(await sidebar().getAttribute('data-mobile'), 'true')
}
async function closeMobileSidebar(session) {
  if (!session.touch || !await sidebar().isVisible()) return
  const toggle = sidebar().locator('[data-sidebar="trigger"]').filter({ visible: true }).first()
  if (await toggle.isVisible()) await toggle.click()
  else await page.keyboard.press('Escape')
  await until(async () => !await sidebar().isVisible(), '原生移动侧栏应关闭，避免 modal inert')
}
async function dismissToasts() {
  const controls = page.getByRole('button', { name: '关闭通知', exact: true }).filter({ visible: true })
  for (let index = 0; index < 8; index++) {
    const count = await controls.count()
    if (!count) break
    try { await controls.first().click({ timeout: 1500 }); report.localToastDismissals.closed++ }
    catch (error) {
      if ((error.name === 'TimeoutError' || /not attached|detached/i.test(error.message)) && await controls.count() === 0) { report.localToastDismissals.expiredDuringClick++; break }
      throw error
    }
    await until(async () => await controls.count() < count, '关闭通知后应消失', 2500)
  }
  assert.equal(await controls.count(), 0)
  const notices = page.locator('[data-slot="toast-viewport"] [data-slot="toast-title"], [data-slot="toast-viewport-anchored"] [data-slot="toast-title"], [data-sonner-toast]')
  if (await notices.count()) report.localToastDismissals.exitAnimationWaits++
  await until(async () => await notices.count() === 0, '等待原生通知退出完成，不能遮挡真实点击区域', 5000)
}
async function login(touch) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'autoops-project-search-'))
  const session = { profile, touch, name: touch ? 'touch-390' : 'desktop', draftHashes: [] }; sessions.push(session)
  const context = session.context = await chromium.launchPersistentContext(profile, {
    headless: true, locale: 'zh-CN', viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: touch, hasTouch: touch, ...(executablePath ? { executablePath } : {}),
  })
  await context.routeWebSocket((url) => url.pathname.endsWith('/api/agent-demo/t3/ws'), (socket) => {
    const server = socket.connectToServer()
    socket.onMessage((payload) => {
      let decoded
      try { decoded = JSON.parse(String(payload)) } catch { server.send(payload); return }
      const messages = Array.isArray(decoded) ? decoded : [decoded], allowed = []
      for (const message of messages) {
        const method = message.tag ?? ''
        if (message.payload?.type === 'message.dispatch') report.messageDispatches++
        if (method === 'orchestration.launchThread' && message.payload?.initialMessage) report.initialMessages++
        if (/^(?:projects|filesystem)\.(?:writeFile|createDirectory|remove|rename)$/.test(method)) report.filesystemWrites++
        if (mutationMethod(method)) report.blockedRpcMutations.push({ session: session.name, method, type: message.payload?.type ?? null })
        else allowed.push(message)
      }
      if (allowed.length === messages.length) server.send(payload)
      else if (allowed.length) server.send(JSON.stringify(Array.isArray(decoded) ? allowed : allowed[0]))
    })
  })
  await context.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url())
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || url.pathname === '/api/agent-demo/login') return route.continue()
    if (request.method() === 'POST' && url.pathname.endsWith('/api/observability/v1/traces')) { report.suppressedTelemetry++; return route.fulfill({ status: 204, body: '' }) }
    report.blockedHttpMutations.push({ session: session.name, method: request.method(), path: url.pathname })
    return route.fulfill({ status: 409, contentType: 'application/json', json: { error: '只读项目搜索验收禁止服务器写入。' } })
  })
  page = session.page = context.pages()[0] || await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => report.pageErrors.push({ session: session.name, message: error.message }))
  await page.goto(`${origin}/agent-demo.html#/draft/${randomUUID()}`)
  await page.getByRole('textbox', { name: '用户名' }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByTestId('composer-editor').waitFor({ timeout: 60000 })
  await assertDraft()
  session.draftUrl = page.url(); session.draftHashes.push(new URL(page.url()).hash)
  const response = await page.request.get(origin + '/api/agent-demo/t3/autoops/bootstrap')
  assert.equal(response.status(), 200)
  session.bootstrap = await response.json()
  session.projectNames = [...new Set(session.bootstrap.projects.map((project) => project.name))]
  assert(session.projectNames.length > 1, '验收需要已存在的真实多项目目录，不得造项目')
  const shellResponse = await page.request.get(origin + '/api/agent-demo/t3/api/orchestration/shell', { headers: { 'x-t3-orchestration-protocol': '2' } })
  assert.equal(shellResponse.status(), 200)
  // Read only authorized project metadata. Discard the shell's unrelated thread
  // metadata; no history/message payload is requested or exported.
  const { projects: nativeProjects } = await shellResponse.json()
  session.projectSearchItems = session.bootstrap.projects.map((project) => {
    const native = nativeProjects.find((candidate) => candidate.id === project.id)
    assert(native, '授权业务项目必须对应真实原生项目目录')
    return { name: project.name, title: native.title, workspaceRoot: native.workspaceRoot }
  })
  return session
}
async function theme(session, mode) {
  await assertDraft(); await closeMobileSidebar(session)
  await page.goto(origin + '/agent-demo.html#/settings/appearance')
  await page.getByRole('group', { name: '外观模式', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
  await closeMobileSidebar(session)
  await page.getByRole('group', { name: '外观模式', exact: true }).getByRole('button', { name: mode === 'dark' ? '使用深色模式' : '使用浅色模式', exact: true }).click()
  await until(() => page.evaluate((dark) => document.documentElement.classList.contains('dark') === dark, mode === 'dark'), '本地主题切换未完成')
  await page.goto(session.draftUrl); await page.getByTestId('composer-editor').waitFor(); await assertDraft()
}
async function openProjects(session) {
  await assertDraft(); await dismissToasts(); await ensureSidebar(session)
  const trigger = sidebar().getByRole('button', { name: /^新建对话/ }).first()
  await trigger.click()
  await palette().waitFor({ timeout: 2500 }).catch(async () => { await page.keyboard.press('ControlOrMeta+k'); await palette().waitFor() })
  // Native sidebar directly opens new-thread-in for multiple project scopes.
  // A single scoped project can leave a fresh draft instead; use the ordinary
  // keyboard command palette and its real submenu action in that case.
  if (!await palette().locator('[data-slot="autocomplete-start-addon"] button[aria-label="返回"]').isVisible()) {
    const action = palette().getByRole('option').filter({ hasText: '选择项目新建对话' })
    if (await action.count()) await action.first().click()
  }
  await palette().locator('[data-slot="autocomplete-start-addon"] button[aria-label="返回"]').waitFor()
  await search().waitFor()
  await until(async () => await search().evaluate((input) => document.activeElement === input), '项目子菜单应自动聚焦搜索输入框')
  await until(async () => await options().count() === session.projectNames.length, '空查询应展示全部已授权真实项目')
}
async function geometry() {
  return palette().evaluate((dialog) => {
    const input = dialog.querySelector('input'), back = dialog.querySelector('button[aria-label="返回"]'), addon = dialog.querySelector('[data-slot="autocomplete-start-addon"]')
    const rect = (element) => { if (!element) return null; const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    const box = input.getBoundingClientRect(), style = getComputedStyle(input), textStart = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
    const backBox = back?.getBoundingClientRect(), icon = addon?.querySelector('svg')
    return { dialog: rect(dialog), input: rect(input), back: rect(back), icon: rect(icon), textStart, paddingLeft: style.paddingLeft, placeholder: input.placeholder, inputSlot: input.dataset.slot ?? null, inputUi: input.dataset.ui ?? null, avoidsAddon: textStart >= (backBox?.right ?? icon?.getBoundingClientRect().right ?? 0) + 4, viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth }
  })
}
async function visibleProjects(session) {
  const texts = await options().allTextContents()
  return texts.map((text) => session.projectNames.find((name) => text.includes(name)) ?? null)
}
async function highlightedProject(session) {
  return palette().getByRole('option').evaluateAll((elements, projectNames) => {
    const active = elements.find((element) => element.hasAttribute('data-highlighted') || element.getAttribute('data-selected') === 'true')
    return active ? projectNames.find((name) => active.textContent.includes(name)) ?? null : null
  }, session.projectNames)
}
async function checkKeyboard(session) {
  await search().fill(''); await until(async () => await options().count() === session.projectNames.length, '清空恢复列表')
  const names = await visibleProjects(session)
  for (const [key, expected] of [['Home', names[0]], ['End', names.at(-1)], ['ArrowUp', names.at(-2)], ['ArrowDown', names.at(-1)], ['Home', names[0]]]) {
    await search().press(key)
    await until(async () => await highlightedProject(session) === expected, `${key} 应高亮真实项目 ${expected}`)
  }
  return { Home: true, End: true, ArrowUp: true, ArrowDown: true }
}
// CommandPalette uses useDeferredValue(query), then its original NFKD/token
// substring filter over display title, native title, workspaceRoot and location.
// Shared deployment paths may legitimately make English AutoOps match both
// projects. Wait for the exact metadata-derived set, never just target presence
// or an assumed reduction in item count.
const normalizeSearch = (value) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
function expectedProjects(session, query) {
  const tokens = normalizeSearch(query).split(' ').filter(Boolean)
  return session.projectSearchItems.filter((project) => {
    const haystack = normalizeSearch([project.name, project.title, project.workspaceRoot, '本地'].join(' '))
    return tokens.every((token) => haystack.includes(token))
  }).map((project) => project.name).sort()
}
async function waitForProjects(session, query) {
  const expected = expectedProjects(session, query)
  await until(async () => {
    const actual = await visibleProjects(session)
    return actual.every(Boolean) && JSON.stringify([...actual].sort()) === JSON.stringify(expected)
  }, `延迟筛选后查询 ${query} 应匹配原生项目元数据集合 ${expected.join('、')}`)
  return { projects: await visibleProjects(session), expected }
}
async function progressiveSearch(session, query, targetName) {
  await search().fill(''); await waitForProjects(session, '')
  const steps = []
  for (const character of Array.from(query)) {
    await search().pressSequentially(character)
    const value = await search().inputValue()
    const matched = await waitForProjects(session, value)
    assert(matched.projects.includes(targetName), `逐字查询 ${value} 应保留目标项目`)
    steps.push({ query: value, ...matched })
  }
  return steps
}
async function closeAndCheckFocus() {
  await page.keyboard.press('Escape'); await palette().waitFor({ state: 'hidden' })
  // CommandPaletteDialog.finalFocus deliberately restores the composer, not a
  // stale sidebar trigger (which is absent after the mobile drawer closes).
  await until(() => page.getByTestId('composer-editor').evaluate((editor) => editor === document.activeElement || editor.contains(document.activeElement)), 'Escape 应按 T3 原流程恢复输入区焦点')
  await assertDraft()
}
async function checkCase(session, mode) {
  await openProjects(session)
  const initial = await geometry()
  report.diagnostics.push({ session: session.name, mode, initial })
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  if (!baseline) {
    assert(initial.avoidsAddon, '返回图标与输入/占位文字重叠')
    assert(/[\u3400-\u9fff]/.test(initial.placeholder), '项目搜索占位符必须中文')
    assert(initial.dialog.left >= -1 && initial.dialog.right <= initial.viewport.width + 1, '弹窗超出视口')
    assert(initial.dialog.top >= -1 && initial.dialog.bottom <= initial.viewport.height + 1, '短窗口弹窗超出视口')
    assert(initial.documentWidth <= initial.viewport.width + 1, '页面出现水平溢出')
  }
  await page.screenshot({ path: path.join(output, `${session.name}-${mode}-project-picker.png`) })
  const englishName = session.projectNames.find((name) => /AutoOps/i.test(name))
  const chineseName = session.projectNames.find((name) => name.includes('机柜'))
  assert(englishName && chineseName, '真实项目目录应包含 AutoOps 与机柜项目')
  const english = await progressiveSearch(session, englishName, englishName)
  assert.deepEqual(english.at(-1).projects, [englishName], '完整真实项目标题应精确收窄到 AutoOps 项目')
  const typed = await geometry()
  if (!baseline) assert(typed.avoidsAddon, '有查询文字时返回图标仍须避让')
  const chinese = await progressiveSearch(session, '机柜', chineseName)
  assert.deepEqual(chinese.at(-1).projects, [chineseName], '机柜中文查询应精确收窄到真实机柜项目')
  await search().fill('zz-不存在的项目-只读验收')
  await until(async () => await options().count() === 0, '不存在项目应返回空结果')
  const emptyNotice = palette().getByText('没有匹配的命令、项目或对话。', { exact: true })
  await emptyNotice.waitFor({ state: 'visible' })
  const empty = { optionCount: await options().count(), emptyVisible: await emptyNotice.isVisible() }
  assert(empty.emptyVisible, '没有匹配项目时必须展示原生空结果提示')
  await search().fill(''); await until(async () => await options().count() === session.projectNames.length, '清空查询应恢复全部项目')
  const keyboard = await checkKeyboard(session)
  await search().press('Backspace')
  await until(async () => !await palette().locator('[data-slot="autocomplete-start-addon"] button[aria-label="返回"]').isVisible(), '空查询 Backspace 应返回根命令面板')
  const rootGeometry = await geometry()
  if (!baseline) assert(rootGeometry.avoidsAddon, '根命令面板搜索图标与文字重叠')
  // This existing action advertises the upstream English searchTerms; use its
  // real supported query while selecting the visible Chinese submenu label.
  await search().fill('new thread')
  const nativeNewThread = palette().getByRole('option').filter({ hasText: '选择项目新建对话' }).first()
  await nativeNewThread.waitFor(); await nativeNewThread.click()
  await palette().locator('[data-slot="autocomplete-start-addon"] button[aria-label="返回"]').waitFor()
  await palette().locator('[data-slot="autocomplete-start-addon"] button[aria-label="返回"]').click()
  await until(async () => !await palette().locator('[data-slot="autocomplete-start-addon"] button[aria-label="返回"]').isVisible(), '返回按钮应返回根视图')
  await closeAndCheckFocus()
  await openProjects(session)
  await search().fill('机柜'); await until(async () => await options().count() === 1, '机柜唯一项目筛选')
  await search().press('Home'); await search().press('Enter')
  await palette().waitFor({ state: 'hidden' }); await page.getByTestId('composer-editor').waitFor(); await assertDraft()
  session.draftUrl = page.url(); session.draftHashes.push(new URL(page.url()).hash)
  const selectedProject = page.locator('[data-draft-project-trigger]').filter({ visible: true }).first()
  await until(async () => await selectedProject.isVisible() && (await selectedProject.innerText()).trim() === chineseName, 'Enter 后原生草稿项目标题必须切换到机柜项目')
  return { initial, typed, rootGeometry, english, chinese, empty, keyboard, backspaceReturnsRoot: true, backButtonReturnsRoot: true, escapeComposerFocus: true, enterLocalDraft: true, selectedProjectHeading: await selectedProject.innerText(), ownDraftHash: new URL(page.url()).hash }
}

try {
  for (const touch of [false, true]) await run(touch ? 'touch-390' : 'desktop-1440', async () => {
    const session = await login(touch), captures = []
    for (const mode of ['light', 'dark']) { await theme(session, mode); captures.push({ mode, ...(await checkCase(session, mode)) }) }
    await page.setViewportSize({ width: touch ? 390 : 1440, height: 600 })
    captures.push({ mode: 'dark-short-600', ...(await checkCase(session, 'dark-short-600')) })
    return { projects: session.projectNames, captures }
  })
  assert.deepEqual(report.pageErrors, [])
  assert.equal(report.messageDispatches, 0); assert.equal(report.initialMessages, 0); assert.equal(report.filesystemWrites, 0)
  assert.deepEqual(report.blockedRpcMutations, [], '发现服务器 mutation 尝试，已在发出前拦截')
  assert.deepEqual(report.blockedHttpMutations, [], '发现业务 HTTP 写入尝试，已拦截')
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.fatal = error.stack; process.exitCode = 1 }
finally {
  for (const session of sessions) {
    const cleanup = report.cleanup[session.name] = {}
    await session.context?.close().then(() => { cleanup.ownedBrowserClosed = true }).catch((error) => { cleanup.error = error.message; report.status = 'failed'; process.exitCode = 1 })
    await rm(session.profile, { recursive: true, force: true }); cleanup.onlyOwnedProfileRemoved = true
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
