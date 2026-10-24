import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

// Launch only with approval for this exact browser command. Each profile and
// skill belongs to this run; conversation, workspace and deployment writes are blocked.
const base = new URL(process.env.BASE_URL || 'http://192.168.31.157:18897')
assert(['http:', 'https:'].includes(base.protocol) && base.port === '18897', '只允许技能合并预览端口 18897')
assert(['172.29.22.6', '192.168.31.157', '127.0.0.1', 'localhost'].includes(base.hostname), '只允许已授权测试主机')
assert(!base.username && !base.password && base.pathname === '/' && !base.search && !base.hash)
assert.equal(process.env.T3_SKILL_LIBRARY_MUTATIONS, '1', '必须显式开启 UUID 自有技能验收')
const origin = base.origin, api = '/api/agent-demo/t3/autoops', marker = `skill-nav-${randomUUID()}`
const artifactRoot = path.resolve('.test-artifacts/skill-module-navigation')
const output = path.resolve(process.env.ARTIFACT_DIR || path.join(artifactRoot, marker))
assert(output.startsWith(artifactRoot + path.sep), '证据只能写入本 worktree 验收目录')
const password = process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!'
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.BROWSER_EXECUTABLE_PATH
const resumeFrom = process.env.T3_SKILL_NAV_FROM
assert(!resumeFrom || resumeFrom === 'settings', '仅支持从已验证前四项后的 settings 检查继续')
const targetedCase = process.env.T3_SKILL_NAV_CASE
assert(!targetedCase || targetedCase === 'delayed-import-refresh', '未知的技能导航定向检查')
assert(!(resumeFrom && targetedCase), '继续检查与定向检查不能同时使用')
const verifiedBeforeSettings = new Set(['skills-enters-through-unified-more-menu', 'native-card-agent-and-project-toggle-round-trip', 'project-view-follows-top-project-with-history-and-refresh', 'accepted-version-import-cannot-navigate-later-project'])
const report = { origin, marker, startedAt: new Date().toISOString(), cases: [], mutations: [], blockedMutations: [], blockedThreadReads: [], pageErrors: [], geometry: [], cleanup: {}, coverage: { modelCalls: 0, existingThreadsOpened: false, touch: 'Chromium 390px 触屏模拟，非物理手机' } }
if (resumeFrom) report.continuedFrom = resumeFrom
if (targetedCase) report.targetedCase = targetedCase
const sessions = [], ownedSkills = new Set(), ownedAssignments = new Set(), admin = new T3LiveClient(origin)
let page, session, originalCatalog, currentCatalog, skill, projectA, projectB, agent
const redact = value => String(value).replaceAll(password, '[已隐藏]').replace(/(Bearer\s+)[A-Za-z0-9_.-]+/gi, '$1[已隐藏]')
const navigation = () => page.getByTestId('project-area-navigation').filter({ visible: true })
const picker = () => navigation().getByRole('button', { name: '切换项目', exact: true })
const featureTrigger = () => navigation().getByRole('button', { name: page.viewportSize().width < 1024 ? '切换模块' : '更多功能', exact: true })
const featureSearch = () => page.getByRole('combobox', { name: '搜索功能', exact: true }).filter({ visible: true })
const library = () => page.locator('[data-skill-library]')
const card = () => page.locator(`[data-skill-card="${skill.id}"]`)
const target = (type, id) => `[data-skill-target-type="${type}"][data-skill-target-id="${id}"]`
const skillHref = (projectId, view = 'library') => `/skills?projectId=${encodeURIComponent(projectId)}&skillView=${view}`
async function until(read, message, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error(message) }
async function save() { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)) }
async function capture(name) { await page.screenshot({ path: path.join(output, `${name}.png`), mask: [page.locator('[data-thread-item]'), page.getByTestId('sidebar-draft-row')] }) }
async function run(name, action) {
  if (resumeFrom === 'settings' && verifiedBeforeSettings.has(name)) return
  const entry = { name }; report.cases.push(entry)
  try { entry.result = await action(); entry.status = 'passed' }
  catch (error) { entry.status = 'failed'; entry.error = redact(error.stack); await capture(`${name}-failed`).catch(() => {}); throw error }
  finally { await save(); console.log(JSON.stringify({ name, status: entry.status, error: entry.error })) }
}
function routeState() {
  const url = new URL(page.url()); assert.equal(url.origin, origin)
  const route = new URL(url.hash.slice(1) || '/', 'http://route.invalid')
  assert(/^\/(?:skills|workspaces|deployments|settings(?:\/(?:general|appearance))?)?$/.test(route.pathname), '技能验收不得打开既有会话')
  return { pathname: route.pathname, projectId: route.searchParams.get('projectId'), view: route.searchParams.get('skillView') }
}
function captureOwned(value) {
  currentCatalog = value
  for (const item of value.skills) if (item.name === marker) ownedSkills.add(item.id)
  for (const item of value.assignments) if (ownedSkills.has(item.skillId)) ownedAssignments.add(item.id)
  report.ownedSkillIds = [...ownedSkills]
  return value
}
async function catalog() { return captureOwned(await admin.http('/autoops/skill-library')) }
function ownsMutation(body) {
  if (body.action === 'import-markdown') return (!body.skillId || ownedSkills.has(body.skillId)) && body.contents?.includes(`name: ${marker}\n`)
  if (body.action === 'unassign') return ownedAssignments.has(body.assignmentId)
  return ['assign', 'delete', 'set-enabled'].includes(body.action) && ownedSkills.has(body.skillId)
}
async function ownedMutation(body) {
  assert(ownsMutation(body), '仅允许本轮 UUID 技能与分配写操作')
  const before = await catalog()
  return captureOwned(await admin.http('/autoops/skill-library', 'POST', { revision: before.revision, ...body }))
}
async function uiMutation(action, click) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === api + '/skill-library' && response.request().method() === 'POST' && response.request().postDataJSON()?.action === action)
  void pending.catch(() => {})
  await click(); const response = await pending, value = await response.json()
  report.mutations.push({ action, status: response.status(), body: response.request().postDataJSON() })
  assert.equal(response.status(), 200, JSON.stringify(value)); captureOwned(value)
  await until(() => library().getAttribute('data-skill-library-revision').then(revision => revision === value.revision), '页面应反映已保存的技能库版本')
  return value
}
function rpcMutation(method, payload = {}) {
  if (!method || !method.includes('.')) return false
  if (method.startsWith('orchestration.')) return !/^orchestration\.(?:get|list|subscribe)/.test(method)
  if (['preview.reportProfiles', 'assets.createUrl', 'server.reportClientActivity', 'server.reportHostPowerState'].includes(method)) return false
  if (method === 'server.refreshProviders') return Object.keys(payload).some(key => !['instanceId', 'cwd', 'fresh'].includes(key)) || (payload.instanceId !== undefined && payload.instanceId !== 'codex')
  return !/\.(?:get|list|read|search|subscribe|observe|browse|stat|probe|resolve|inspect|watch|find|toolInfo|routing|summary|detail|checks|activity|diffFileContents|reviewGuide|linkedThreads)/i.test(method)
}
async function guards(context, owner) {
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue()
    if (url.origin === origin && ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue()
    if (url.origin === origin && request.method() === 'POST') {
      if (url.pathname === '/api/agent-demo/login') return route.continue()
      if (url.pathname.endsWith('/api/observability/v1/traces')) return route.fulfill({ status: 204, body: '' })
      if (url.pathname === api + '/skill-library' && ownsMutation(request.postDataJSON() || {})) {
        owner.skillWrites++; return route.continue()
      }
    }
    report.blockedMutations.push({ session: owner.name, method: request.method(), path: url.origin === origin ? url.pathname : '非测试源站' })
    return route.fulfill({ status: 409, json: { error: '验收禁止修改非本轮创建的数据。' } })
  })
  await context.routeWebSocket(url => url.pathname.endsWith('/api/agent-demo/t3/ws'), socket => {
    const server = socket.connectToServer()
    socket.onMessage(payload => {
      let decoded; try { decoded = JSON.parse(String(payload)) } catch { server.send(payload); return }
      const messages = Array.isArray(decoded) ? decoded : [decoded], allowed = []
      for (const message of messages) {
        if (/^orchestration\.(?:getThread|subscribeThread)/.test(message.tag || '') && message.payload?.threadId) { report.blockedThreadReads.push({ session: owner.name, method: message.tag }); continue }
        if (rpcMutation(message.tag, message.payload)) { report.blockedMutations.push({ session: owner.name, method: message.tag }); continue }
        allowed.push(message)
      }
      if (allowed.length === messages.length) server.send(payload)
      else if (allowed.length) server.send(JSON.stringify(Array.isArray(decoded) ? allowed : allowed[0]))
    })
  })
}
async function login(name, username = 'admin', touch = false) {
  const owner = { name, username, touch, skillWrites: 0, profile: await mkdtemp(path.join(os.tmpdir(), 'autoops-skill-navigation-')) }; sessions.push(owner)
  owner.context = await chromium.launchPersistentContext(owner.profile, { headless: true, locale: 'zh-CN', viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: touch, hasTouch: touch, ...(executablePath ? { executablePath } : {}) })
  await guards(owner.context, owner)
  session = owner; page = owner.page = owner.context.pages()[0] || await owner.context.newPage(); page.setDefaultTimeout(20000)
  page.on('pageerror', error => report.pageErrors.push({ session: name, message: redact(error.message) }))
  await page.goto(`${origin}/agent-demo.html#/skills`)
  await page.getByRole('textbox', { name: '用户名' }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await library().waitFor({ timeout: 60000 }); await navigation().waitFor()
  const response = await page.request.get(origin + api + '/bootstrap'); assert.equal(response.status(), 200)
  owner.bootstrap = await response.json(); await ready(); return owner
}
async function ready() { await library().waitFor({ timeout: 60000 }); await until(() => page.getByRole('button', { name: '刷新技能库', exact: true }).isEnabled(), '技能库读取完成') }
async function dismissToasts() {
  const close = page.getByRole('button', { name: '关闭通知', exact: true }).filter({ visible: true })
  for (let index = 0; index < 8 && await close.count(); index++) {
    try { await close.first().click({ timeout: 1000 }) } catch (error) { if (await close.count()) throw error }
  }
  await until(async () => await page.locator('[data-slot="toast-viewport"] [data-slot="toast-title"], [data-slot="toast-viewport-anchored"] [data-slot="toast-title"], [data-sonner-toast]').count() === 0, '原生通知退出动画完成', 6000)
}
async function chooseFeature(label) {
  await dismissToasts(); await featureTrigger().click(); await featureSearch().waitFor(); await featureSearch().fill(label)
  await page.getByRole('option', { name: label, exact: true }).click()
}
async function selectProject(id) {
  const expected = session.bootstrap.projects.find(project => project.id === id); assert(expected)
  const before = routeState()
  await picker().click(); const search = page.getByRole('combobox', { name: '搜索项目', exact: true }).filter({ visible: true }); await search.fill(expected.name)
  const option = page.getByRole('option').filter({ hasText: expected.name }); assert.equal(await option.count(), 1); await option.click()
  await until(async () => { const current = routeState(); return current.pathname === before.pathname && (before.pathname.startsWith('/settings') ? !current.projectId || current.projectId === id : current.projectId === id) && (await picker().innerText()).includes(expected.name) }, '切项目必须保留模块并同步浏览上下文和顶栏')
  if (before.pathname === '/skills') await ready()
}
async function assertSkills(projectId, view) {
  await until(() => { const state = routeState(); return state.pathname === '/skills' && state.projectId === projectId && (!view || state.view === view) }, '技能模块、项目与筛选应保持指定 URL')
  await ready(); const current = routeState()
  assert.equal(await page.getByTestId('project-area-navigation').count(), 1)
  assert((await picker().innerText()).includes(session.bootstrap.projects.find(project => project.id === projectId).name))
  assert.equal(await page.locator('[data-app-sidebar], [data-sidebar="sidebar"], [data-sidebar-control], [data-slot="sidebar-gap"]').count(), 0, '技能页不应挂载会话侧栏或空占位')
  assert.equal(await page.getByLabel('搜索对话', { exact: true }).count(), 0)
  assert.equal(await page.getByTestId('sidebar-draft-row').count(), 0)
  assert.equal(await page.getByRole('combobox', { name: '技能范围项目', exact: true }).count(), 0, '项目范围统一使用顶栏，不重复项目选择器')
  assert.equal(await navigation().locator('button[aria-label="技能库"]').count(), 0, '技能不得成为第四个常用顶部按钮')
  if (page.viewportSize().width >= 1024) for (const name of ['问答', '工作区', '部署发布']) assert.equal(await navigation().locator(`button[aria-label="${name}"]`).count(), session.username === 'admin' || name !== '部署发布' ? 1 : 0)
  return current
}
async function central() {
  const back = page.getByRole('button', { name: '返回技能库', exact: true }); if (await back.isVisible()) await back.click()
  await page.locator('[aria-label="技能管理"]').getByText('全部技能', { exact: true }).click(); await ready()
}
async function projectView() { await page.locator('[aria-label="技能管理"]').getByText('项目分配', { exact: true }).click(); await until(() => routeState().view === 'project', '项目技能筛选应持久化到 URL'); await ready() }
async function refresh() { await page.getByRole('button', { name: '刷新技能库', exact: true }).click(); await ready() }
async function menu(action) { await page.getByRole('button', { name: '技能操作', exact: true }).click(); await page.getByRole('menuitem', { name: action, exact: true }).click() }
async function closeSettingsSidebar() {
  const sidebar = page.locator('[data-sidebar="sidebar"][data-mobile="true"]').filter({ visible: true })
  if (await sidebar.count() && await sidebar.first().evaluate(element => !element.closest('[inert]') && element.getBoundingClientRect().right > 1)) await page.keyboard.press('Escape')
}
async function settingsBack() {
  const back = page.locator('[data-sidebar="sidebar"]').getByRole('button', { name: '返回', exact: true }).filter({ visible: true }).first()
  if (!await back.isVisible()) await page.getByRole('button', { name: '切换主侧栏', exact: true }).filter({ visible: true }).first().click()
  await back.click(); await ready()
}
async function theme(mode) {
  await chooseFeature('外观设置'); await page.getByRole('group', { name: '外观模式', exact: true, includeHidden: true }).waitFor({ state: 'attached' }); await closeSettingsSidebar()
  await page.getByRole('group', { name: '外观模式', exact: true }).getByRole('button', { name: mode === 'dark' ? '使用深色模式' : '使用浅色模式', exact: true }).click()
  await until(() => page.evaluate(dark => document.documentElement.classList.contains('dark') === dark, mode === 'dark'), '真实外观设置应生效')
  await settingsBack(); await assertSkills(projectA.id)
}
async function geometry(name) {
  await dismissToasts(); const value = await page.evaluate(() => {
    const rect = element => { const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth } }
    const header = document.querySelector('[data-testid="project-area-navigation"]'), main = document.querySelector('[data-skill-library]')
    const controls = [...header.querySelectorAll('button')].filter(element => element.getClientRects().length).map(element => { const box = rect(element), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return { label: element.getAttribute('aria-label') || element.textContent.trim(), ...box, receivesPointer: element === hit || element.contains(hit) } })
    const list = main.querySelector('[aria-label="技能列表"] [data-slot="scroll-area-viewport"]')
    return { viewport: { width: innerWidth, height: innerHeight }, document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, header: rect(header), main: rect(main), controls, scroll: list ? { ...rect(list), clientHeight: list.clientHeight, scrollHeight: list.scrollHeight } : null }
  })
  assert(Math.abs(value.header.x) <= 1 && Math.abs(value.header.y) <= 1 && Math.abs(value.header.height - 52) <= 1)
  assert(Math.abs(value.header.width - value.viewport.width) <= 1)
  assert(Math.abs(value.main.x) <= 1 && Math.abs(value.main.y - 52) <= 1 && Math.abs(value.main.bottom - value.viewport.height) <= 2, '技能页应填满顶栏后的剩余空间')
  assert(value.document.width <= value.viewport.width + 1 && value.document.height <= value.viewport.height + 1, '技能页只能内部滚动')
  assert(value.scroll && value.scroll.scrollWidth <= value.scroll.clientWidth + 1)
  for (const control of value.controls) assert(control.x >= -1 && control.right <= value.viewport.width + 1 && control.bottom <= 53 && control.receivesPointer, `顶部控件应可点击且不越界：${control.label}`)
  await card().scrollIntoViewIfNeeded()
  const cardControls = await card().locator('button').evaluateAll(elements => elements.filter(element => element.getClientRects().length).map(element => { const b = element.getBoundingClientRect(), parent = element.closest('[data-skill-card]').getBoundingClientRect(); return { label: element.getAttribute('aria-label') || element.textContent.trim(), inside: b.left >= parent.left - 1 && b.right <= parent.right + 1 } }))
  assert(cardControls.every(control => control.inside), '长标题卡片内操作不得越过真实边界')
  report.geometry.push({ name, ...value, cardControls }); await capture(name)
  const trigger = featureTrigger(); await trigger.focus(); await page.keyboard.press('Enter'); await featureSearch().waitFor(); await featureSearch().fill('技能'); assert.equal(await page.getByRole('option', { name: '技能库', exact: true }).count(), 1)
  await page.keyboard.press('Escape'); await until(() => trigger.evaluate(element => element === document.activeElement), '原生模块菜单应恢复键盘焦点')
  return value
}

async function delayedImportRefresh() {
  await ownedMutation({ action: 'assign', skillId: skill.id, versionId: skill.latestVersionId, targetType: 'project', targetId: projectA.id, workspaceTypes: ['internal', 'external'] })
  // Two existing versions let the native Select change value for real; picking
  // its already-selected latest entry does not set an explicit reading version.
  await ownedMutation({ action: 'import-markdown', skillId: skill.id, contents: `---\nname: ${marker}\ndescription: 只读检查已授权资料并引用真实来源\nmetadata:\n  display-name: ${skill.displayName}\nallowed-tools:\n  - list_project_materials\n---\n\n只读取当前授权项目资料并引用来源，不执行命令。\n\n${marker} existing-second-version\n` })
  skill = currentCatalog.skills.find(item => item.id === skill.id)
  await refresh(); await projectView(); await assertSkills(projectA.id, 'project')
  await page.locator(`[data-skill-row="${skill.id}"]`).click(); await menu('导入新版本')
  const dialog = page.getByRole('dialog', { name: '导入技能新版本', exact: true }); await dialog.waitFor()
  const contentsMarker = `${marker} delayed-request-new-version`
  await dialog.locator('[aria-label="技能导入方式"]').getByText('粘贴正文', { exact: true }).click()
  await dialog.getByRole('textbox', { name: 'SKILL.md 正文', exact: true }).fill(`---\nname: ${marker}\ndescription: 只读检查已授权资料并引用真实来源\nmetadata:\n  display-name: ${skill.displayName}\nallowed-tools:\n  - list_project_materials\n---\n\n只读取当前授权项目资料并引用来源，不执行命令。\n\n${contentsMarker}\n`)
  const before = await catalog(), previous = before.skills.find(item => item.id === skill.id)
  assert(previous)
  const pinnedReadingVersion = previous.versions.find(item => item.id !== previous.latestVersionId)?.id; assert(pinnedReadingVersion)
  const assigned = before.assignments.find(item => item.skillId === skill.id && item.targetType === 'project' && item.targetId === projectA.id); assert(assigned)
  let release, completed, heldBody, routeError, claimed = false, sent = false
  const held = new Promise(resolve => { release = resolve }), finished = new Promise(resolve => { completed = resolve })
  const handler = async route => {
    const request = route.request()
    if (request.method() !== 'POST' || request.postDataJSON()?.action !== 'import-markdown' || claimed) return route.fallback()
    claimed = true
    try {
      heldBody = request.postDataJSON(); assert(ownsMutation(heldBody) && heldBody.skillId === skill.id)
      // Keep the original browser request unsent until B has fetched and shown
      // the old catalog. Forward the real server response without substitution.
      await held; sent = true; session.skillWrites++
      const response = await route.fetch(); assert.equal(response.status(), 200)
      report.mutations.push({ action: 'import-markdown', status: response.status(), heldBeforeTransmission: true, body: heldBody })
      await route.fulfill({ response })
    } catch (error) { routeError = error; await route.abort().catch(() => {}) }
    finally { completed() }
  }
  const clientResponse = page.waitForResponse(response => new URL(response.url()).pathname === api + '/skill-library' && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'import-markdown')
  void clientResponse.catch(() => {})
  const resourceReads = []
  const observeFile = response => { const url = new URL(response.url()); if (url.pathname.startsWith(`${api}/skill-library/${skill.id}/versions/`) && url.pathname.endsWith('/content')) resourceReads.push({ url: url.pathname, status: response.status() }) }
  page.on('response', observeFile)
  await page.route('**/autoops/skill-library', handler)
  try {
    await dialog.getByRole('button', { name: '导入并检查', exact: true }).click()
    await until(() => { if (routeError) throw routeError; return heldBody }, 'UI 应发出本轮新版本请求，但尚未向服务端发送')
    assert.equal(sent, false)
    const oldGet = page.waitForResponse(response => new URL(response.url()).pathname === api + '/skill-library' && response.request().method() === 'GET')
    void oldGet.catch(() => {})
    await page.evaluate(href => { window.location.hash = href }, skillHref(projectB.id, 'library'))
    const oldResponse = await oldGet; assert.equal(oldResponse.status(), 200); const oldCatalog = await oldResponse.json()
    assert.equal(oldCatalog.skills.find(item => item.id === skill.id).latestVersionId, previous.latestVersionId)
    await assertSkills(projectB.id, 'library'); await dialog.waitFor({ state: 'hidden' })
    await until(() => library().getAttribute('data-skill-library-revision').then(revision => revision === before.revision), 'B 中央库应先载入服务器旧版本')
    await page.locator(`[data-skill-row="${skill.id}"]`).click()
    const versionPicker = page.getByRole('combobox', { name: '查看技能版本', exact: true })
    await until(async () => (await versionPicker.innerText()).includes(previous.latestVersionId.slice(0, 8)), 'B 的真实详情应先显示旧版本')
    await versionPicker.click()
    await page.getByRole('option').filter({ hasText: pinnedReadingVersion.slice(0, 8) }).click()
    await until(async () => (await versionPicker.innerText()).includes(pinnedReadingVersion.slice(0, 8)), '实际切换到非最新旧版，固定当前阅读版本')
    assert.equal(sent, false); assert.deepEqual(await catalog(), before, '释放前请求不得到达服务端')
    await capture('delayed-import-project-b-old-version')
    const automaticGet = page.waitForResponse(response => new URL(response.url()).pathname === api + '/skill-library' && response.request().method() === 'GET')
    void automaticGet.catch(() => {})
    release(); await finished; if (routeError) throw routeError
    const post = await clientResponse; assert.equal(post.status(), 200); await post.finished()
    const refreshed = await automaticGet; assert.equal(refreshed.status(), 200); const nextCatalog = await refreshed.json()
    const next = nextCatalog.skills.find(item => item.id === skill.id)
    assert.equal(next.versions.length, previous.versions.length + 1); assert.notEqual(next.latestVersionId, previous.latestVersionId)
    await until(() => library().getAttribute('data-skill-library-revision').then(revision => revision === nextCatalog.revision), '旧页面成功事件应驱动当前 B 页面自动刷新')
    assert((await versionPicker.innerText()).includes(pinnedReadingVersion.slice(0, 8)), '自动刷新不能改变用户显式固定阅读的旧版本')
    await versionPicker.click()
    const newVersion = page.getByRole('option').filter({ hasText: next.latestVersionId.slice(0, 8) })
    await newVersion.waitFor(); await newVersion.click()
    await until(async () => (await versionPicker.innerText()).includes(next.latestVersionId.slice(0, 8)), '用户选择后应展示刚被自动刷新发现的新版本')
    await page.locator('[aria-label="技能详情"]').getByText(contentsMarker, { exact: false }).waitFor()
    assert(resourceReads.some(read => read.status === 200 && read.url.includes(`/versions/${next.latestVersionId}/`)), '详情应实际请求新版本文件内容')
    assert.deepEqual(routeState(), { pathname: '/skills', projectId: projectB.id, view: 'library' })
    assert((await picker().innerText()).includes(projectB.name), '新版本详情仍须属于当前 B 浏览上下文')
    const after = await catalog(); assert.deepEqual(after.assignments, before.assignments, '库刷新不能自动升级原有项目分配')
    assert.equal(after.assignments.find(item => item.id === assigned.id).versionId, assigned.versionId)
    await capture('delayed-import-project-b-refreshed-version')
    return { heldBeforeTransmission: true, oldCatalogLoadedInB: true, automaticCatalogGet: true, explicitReadingVersionPreserved: true, pinnedReadingVersion, newVersionOptionAppeared: true, actualDetailContentUpdated: true, projectBPreserved: true, oldVersion: previous.latestVersionId, newVersion: next.latestVersionId, assignmentVersionPinned: assigned.versionId, resourceReads }
  } finally { release(); if (claimed) await finished; await page.unroute('**/autoops/skill-library', handler); page.off('response', observeFile) }
}

await mkdir(output, { recursive: true })
try {
  await admin.login(); originalCatalog = await catalog(); assert.equal(originalCatalog.canManage, true)
  projectA = admin.bootstrap.projects.find(project => project.id === 'p-autoops'); projectB = admin.bootstrap.projects.find(project => project.id === 'p-cabinet'); assert(projectA && projectB)
  agent = originalCatalog.agents.find(item => item.projectIds.includes(projectA.id)); assert(agent)
  await ownedMutation({ action: 'import-markdown', contents: `---\nname: ${marker}\ndescription: 只读检查已授权资料并引用真实来源\nmetadata:\n  display-name: ${('技能导航 ' + marker + ' 长标题用于验证控件边界').slice(0, 76)}\nallowed-tools:\n  - list_project_materials\n---\n\n只读取当前授权项目资料并引用来源，不执行命令。\n` })
  skill = currentCatalog.skills.find(item => item.name === marker); assert(skill)
  const desktop = await login('desktop-admin')
  if (targetedCase === 'delayed-import-refresh') {
    await run('delayed-import-refreshes-current-project-without-changing-assignment', delayedImportRefresh)
  } else {
  await run('skills-enters-through-unified-more-menu', async () => {
    await page.goto(`${origin}/agent-demo.html#/workspaces?projectId=${projectA.id}`); await navigation().waitFor()
    await chooseFeature('技能库'); const state = await assertSkills(projectA.id); await central(); await card().waitFor(); return state
  })
  await run('native-card-agent-and-project-toggle-round-trip', async () => {
    await card().scrollIntoViewIfNeeded(); const agentButton = card().locator(target('agent', agent.id))
    await uiMutation('assign', () => agentButton.click()); assert(currentCatalog.assignments.some(item => item.skillId === skill.id && item.targetType === 'agent' && item.targetId === agent.id))
    await uiMutation('unassign', () => agentButton.click()); assert(!currentCatalog.assignments.some(item => item.skillId === skill.id))
    const trigger = card().getByRole('button', { name: `项目分配：${skill.displayName}`, exact: true }); await trigger.click()
    const projectButton = page.locator('[aria-label="项目分配列表"]').locator(target('project', projectA.id))
    await uiMutation('assign', () => projectButton.click()); await uiMutation('unassign', () => projectButton.click())
    await page.keyboard.press('Escape'); await until(() => trigger.evaluate(element => element === document.activeElement), '项目浮层关闭应恢复焦点')
    assert(!currentCatalog.assignments.some(item => item.skillId === skill.id)); return { assistantRoundTrip: true, projectRoundTrip: true }
  })
  await ownedMutation({ action: 'assign', skillId: skill.id, versionId: skill.latestVersionId, targetType: 'project', targetId: projectA.id, workspaceTypes: ['internal', 'external'] })
  await refresh()
  await run('project-view-follows-top-project-with-history-and-refresh', async () => {
    await projectView(); await assertSkills(projectA.id, 'project'); await card().waitFor()
    await selectProject(projectB.id); await assertSkills(projectB.id, 'project'); assert.equal(await card().count(), 0, 'B 项目不得显示只分配给 A 的自有技能')
    await page.goBack(); await assertSkills(projectA.id, 'project'); await card().waitFor()
    await page.goForward(); await assertSkills(projectB.id, 'project'); assert.equal(await card().count(), 0)
    await page.reload(); await assertSkills(projectB.id, 'project'); assert.equal(await card().count(), 0)
    await selectProject(projectA.id); await card().waitFor(); return { projectViewFollowsTopbar: true, backForward: true, refresh: true }
  })
  await run('accepted-version-import-cannot-navigate-later-project', async () => {
    await assertSkills(projectA.id, 'project'); await page.locator(`[data-skill-row="${skill.id}"]`).click(); await menu('导入新版本')
    const dialog = page.getByRole('dialog', { name: '导入技能新版本', exact: true }); await dialog.waitFor()
    await dialog.locator('[aria-label="技能导入方式"]').getByText('粘贴正文', { exact: true }).click()
    await dialog.getByRole('textbox', { name: 'SKILL.md 正文', exact: true }).fill(`---\nname: ${marker}\ndescription: 只读检查已授权资料并引用真实来源\nmetadata:\n  display-name: ${skill.displayName}\nallowed-tools:\n  - list_project_materials\n---\n\n只读取当前授权项目资料并引用来源，不执行命令。\n\n本轮导航验收的第二个不可变版本。\n`)
    const before = await catalog(), previous = before.skills.find(item => item.id === skill.id)
    const assignment = before.assignments.find(item => item.skillId === skill.id && item.targetType === 'project' && item.targetId === projectA.id)
    assert(assignment && previous)
    let release, completed, received, routeError, claimed = false
    const held = new Promise(resolve => { release = resolve }), finished = new Promise(resolve => { completed = resolve })
    const handler = async route => {
      const request = route.request()
      if (request.method() !== 'POST' || request.postDataJSON()?.action !== 'import-markdown' || claimed) return route.fallback()
      claimed = true
      try {
        assert(ownsMutation(request.postDataJSON()) && request.postDataJSON().skillId === skill.id)
        session.skillWrites++
        const response = await route.fetch()
        assert.equal(response.status(), 200)
        received = await response.json()
        report.mutations.push({ action: 'import-markdown', status: response.status(), heldActualResponse: true, body: request.postDataJSON() })
        await held
        await route.fulfill({ response })
      } catch (error) { routeError = error; await route.abort().catch(() => {}) }
      finally { completed() }
    }
    const clientResponse = page.waitForResponse(response => new URL(response.url()).pathname === api + '/skill-library' && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'import-markdown')
    void clientResponse.catch(() => {})
    await page.route('**/autoops/skill-library', handler)
    try {
      await dialog.getByRole('button', { name: '导入并检查', exact: true }).click()
      await until(() => { if (routeError) throw routeError; return received }, '服务端应先接受新版本，客户端响应仍被暂缓')
      const accepted = await catalog(), next = accepted.skills.find(item => item.id === skill.id)
      assert.equal(next.versions.length, previous.versions.length + 1)
      assert.notEqual(next.latestVersionId, previous.latestVersionId)
      assert.deepEqual(accepted.assignments, before.assignments, '新版本入库不能自动升级现有分配')
      await page.evaluate(href => { window.location.hash = href }, skillHref(projectB.id, 'project'))
      await assertSkills(projectB.id, 'project'); await dialog.waitFor({ state: 'hidden' })
      release(); await finished
      if (routeError) throw routeError
      const response = await clientResponse; await response.finished(); assert.equal(response.status(), 200)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await assertSkills(projectB.id, 'project'); assert.equal(await card().count(), 0, '旧响应不得将页面带回 A 或切回中央库')
      const after = await catalog(); assert.deepEqual(after.assignments, before.assignments)
      assert.equal(after.assignments.find(item => item.id === assignment.id).versionId, assignment.versionId)
      skill = after.skills.find(item => item.id === skill.id)
      await capture('accepted-import-stays-project-b')
    } finally { release(); if (claimed) await finished; await page.unroute('**/autoops/skill-library', handler) }
    await selectProject(projectA.id); await assertSkills(projectA.id, 'project'); await card().waitFor()
    return { realPostAcceptedBeforeNavigation: true, unmodifiedResponseForwarded: true, laterProjectPreserved: true, assignmentVersionPinned: assignment.versionId }
  })
  if (resumeFrom === 'settings') { await selectProject(projectA.id); await projectView() }
  await run('settings-return-keeps-skill-module-and-project', async () => {
    await chooseFeature('常规设置'); await until(() => routeState().pathname === '/settings/general', '进入原生常规设置')
    await settingsBack(); await assertSkills(projectA.id, 'project'); await card().waitFor()
    await chooseFeature('常规设置'); await until(() => routeState().pathname === '/settings/general', '进入原生常规设置'); await closeSettingsSidebar()
    await selectProject(projectB.id); await settingsBack(); await assertSkills(projectB.id, 'project'); assert.equal(await card().count(), 0)
    await page.reload(); await assertSkills(projectB.id, 'project'); await selectProject(projectA.id)
    return { nativeSettingsReturn: true, projectSwitchInsideSettings: true, viewPreserved: true }
  })
  await run('pending-assignment-closes-on-project-navigation-without-write', async () => {
    await central(); await page.locator(`[data-skill-row="${skill.id}"]`).click(); await menu('分配技能')
    const dialog = page.getByRole('dialog', { name: '分配技能', exact: true }); await dialog.waitFor()
    await dialog.locator('[aria-label="技能分配范围"]').getByText('项目', { exact: true }).click()
    await dialog.getByRole('combobox', { name: '分配目标项目', exact: true }).click(); await page.getByRole('option', { name: projectA.name, exact: true }).click()
    const before = await catalog(), writes = session.skillWrites
    // Native modal focus prevents clicking the background topbar. A browser
    // hash navigation changes the project in the same mounted SPA without reload.
    await page.evaluate(href => { window.location.hash = href }, skillHref(projectB.id, 'project'))
    await assertSkills(projectB.id, 'project'); await dialog.waitFor({ state: 'hidden' }); assert.equal(await page.getByRole('button', { name: '保存分配', exact: true }).count(), 0)
    assert.equal(session.skillWrites, writes, '切项目不得提交旧分配弹窗'); assert.deepEqual(await catalog(), before, '切项目不能改变技能库')
    await selectProject(projectA.id); await central(); return { sameDocumentNavigation: true, pendingDialogClosed: true, writes: 0 }
  })
  await run('invalid-project-never-falls-back', async () => {
    const invalid = `unavailable-${randomUUID()}`, writes = session.skillWrites
    await page.goto(`${origin}/agent-demo.html#${skillHref(invalid, 'project')}`); await page.getByTestId('skill-project-unavailable').waitFor({ timeout: 60000 })
    assert.equal(routeState().projectId, invalid); assert.equal(await library().count(), 0); assert.equal(session.skillWrites, writes)
    await page.reload(); await page.getByTestId('skill-project-unavailable').waitFor({ timeout: 60000 }); assert.equal(routeState().projectId, invalid)
    await capture('invalid-project'); await page.goto(`${origin}/agent-demo.html#${skillHref(projectA.id)}`); await assertSkills(projectA.id)
    return { fallbackPrevented: true, refreshKeepsInvalidIdentity: true }
  })
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['short', { width: 1440, height: 600 }]]) {
    await page.setViewportSize(viewport)
    for (const mode of ['light', 'dark']) await run(`${name}-${mode}-navigation-layout-keyboard`, async () => { await theme(mode); await central(); await assertSkills(projectA.id); return geometry(`${name}-${mode}`) })
  }
  await login('touch-admin', 'admin', true); await page.goto(`${origin}/agent-demo.html#${skillHref(projectA.id)}`); await ready()
  for (const mode of ['light', 'dark']) await run(`touch-${mode}-navigation-layout-keyboard`, async () => { await theme(mode); await central(); await assertSkills(projectA.id); return geometry(`touch-${mode}`) })
  await run('touch-project-view-and-history', async () => { await projectView(); await selectProject(projectB.id); await assertSkills(projectB.id, 'project'); assert.equal(await card().count(), 0); await page.goBack(); await assertSkills(projectA.id, 'project'); await card().waitFor(); return { touchProjectContext: true } })
  for (const [username, project] of [['lin', projectA], ['chen', projectB]]) {
    if (username === 'chen') await ownedMutation({ action: 'assign', skillId: skill.id, versionId: skill.latestVersionId, targetType: 'project', targetId: projectB.id, workspaceTypes: ['internal', 'external'] })
    await login(`member-${username}`, username)
    await run(`${username}-authorized-library-read-and-management403`, async () => {
      await page.goto(`${origin}/agent-demo.html#${skillHref(project.id)}`); await assertSkills(project.id); await central(); await card().waitFor()
      const response = await page.request.get(origin + api + '/skill-library'); assert.equal(response.status(), 200); const visible = await response.json()
      assert.equal(visible.canManage, false); assert(visible.skills.some(item => item.id === skill.id)); assert(!visible.projects.some(item => item.id === (project.id === projectA.id ? projectB.id : projectA.id)))
      assert.equal(await page.getByRole('button', { name: '导入技能', exact: true }).count(), 0)
      for (const button of await card().locator('[data-skill-target-type]').all()) assert(await button.isDisabled(), '成员卡片分配开关必须禁用')
      const before = await catalog()
      const denied = await page.request.post(origin + api + '/skill-library', { headers: { origin, 'x-demo-csrf': session.bootstrap.csrfToken }, data: { action: 'set-enabled', revision: visible.revision, skillId: skill.id, enabled: false } })
      assert.equal(denied.status(), 403); assert.equal((await denied.json()).code, 'SKILL_MANAGEMENT_FORBIDDEN'); assert.deepEqual(await catalog(), before, '拒绝成员写入后目录必须完全不变')
      await capture(`member-${username}`); return { realLogin: true, canManage: false, authorizedSkillVisible: true, disabledTargets: true, write403: true }
    })
  }
  }
  session = desktop; page = desktop.page
  assert.deepEqual(report.blockedMutations, []); assert.deepEqual(report.blockedThreadReads, []); assert.deepEqual(report.pageErrors, [])
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = redact(error.stack); process.exitCode = 1; console.error(redact(error.stack)) }
finally {
  try {
    if (originalCatalog) {
      let current = await catalog()
      for (const assignment of current.assignments.filter(item => ownedSkills.has(item.skillId))) current = await ownedMutation({ action: 'unassign', assignmentId: assignment.id })
      for (const item of current.skills.filter(item => ownedSkills.has(item.id) && item.name === marker)) current = await ownedMutation({ action: 'delete', skillId: item.id })
      const withoutRevision = ({ revision, ...rest }) => rest
      assert.deepEqual(withoutRevision(current), withoutRevision(originalCatalog), '除版本修订号外，技能目录必须完整恢复原状')
      report.cleanup.catalogDeepEqual = true; report.cleanup.ownedSkillsRemoved = !current.skills.some(item => ownedSkills.has(item.id))
    }
  } catch (error) { report.cleanup.error = redact(error.stack); report.status = 'failed'; process.exitCode = 1 }
  admin.close()
  for (const owner of sessions) {
    await owner.context?.close().catch(error => { report.cleanup[owner.name] = redact(error.message); report.status = 'failed'; process.exitCode = 1 })
    await rm(owner.profile, { recursive: true, force: true })
  }
  report.finishedAt = new Date().toISOString(); await save()
}
