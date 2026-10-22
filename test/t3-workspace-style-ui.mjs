import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'

// Run only through the explicitly authorized browser-test command with an isolated profile.
const origin = (process.env.BASE_URL || process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').replace(/\/$/, '')
if (new URL(origin).port === '8787' && process.env.T3_PRODUCTION_SMOKE !== '1') throw new Error('正式入口验收需要显式设置 T3_PRODUCTION_SMOKE=1。')
const baseline = process.env.BASELINE === '1'
const phase = baseline ? 'before' : 'after'
const output = path.resolve(process.env.ARTIFACT_DIR || `.test-artifacts/t3-workspace-style/${phase}-${Date.now()}`)
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.BROWSER_EXECUTABLE_PATH
await mkdir(output, { recursive: true })
const sessions = []
const report = {
  origin, baseline, phase, startedAt: new Date().toISOString(), cases: [], geometry: [], pageErrors: [],
  messageDispatches: 0, initialMessages: 0, filesystemWrites: 0, suppressedTelemetry: 0,
  blockedRpcMutations: [], blockedHttpMutations: [], cleanup: {},
  coverage: { existingExampleVersions: true, noExistingThreadActivated: true, noWorkspaceWrites: true, synthesizedServerStates: false, themePreferencePersistence: '仅隔离 profile 的原生本地外观，不验证服务器偏好持久化' },
}
let page

async function until(read, message, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(message)
}
async function run(name, action) {
  const entry = { name }; report.cases.push(entry)
  try { entry.result = await action(); entry.status = 'passed' }
  catch (error) {
    entry.status = 'failed'; entry.error = error.stack
    await page?.screenshot({ path: path.join(output, `${phase}-${name}-failed.png`) }).catch(() => {})
    if (page) await writeFile(path.join(output, `${phase}-${name}-dom.txt`), await page.locator('body').innerText()).catch(() => {})
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
async function login(username = 'admin', touch = false) {
  const session = { username, touch, name: `${username}-${touch ? 'touch-390' : 'desktop'}`, profile: await mkdtemp(path.join(os.tmpdir(), 'autoops-workspace-style-')) }
  sessions.push(session)
  const context = session.context = await chromium.launchPersistentContext(session.profile, {
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
    if (request.method() === 'POST' && url.pathname.endsWith('/api/observability/v1/traces')) {
      report.suppressedTelemetry++
      return route.fulfill({ status: 204, body: '' })
    }
    report.blockedHttpMutations.push({ session: session.name, method: request.method(), path: url.pathname })
    return route.fulfill({ status: 409, contentType: 'application/json', json: { error: '只读工作区样式验收禁止服务器写入。' } })
  })
  page = session.page = context.pages()[0] || await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => report.pageErrors.push({ session: session.name, message: error.message }))
  await page.goto(`${origin}/agent-demo.html#/draft/${randomUUID()}`)
  await page.getByRole('textbox', { name: '用户名' }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByTestId('composer-editor').waitFor({ timeout: 60000 })
  assert(new URL(page.url()).hash.startsWith('#/draft/'), '登录只允许进入自己的空草稿')
  const response = await page.request.get(origin + '/api/agent-demo/t3/autoops/bootstrap')
  assert.equal(response.status(), 200)
  session.bootstrap = await response.json()
  session.project = session.bootstrap.projects.find((entry) => username === 'admin' ? entry.membership?.workspaceAccess === 'internal' && entry.membership?.role === 'manager' : entry.membership?.workspaceAccess === 'external')
  assert(session.project, `${username} 缺少用于验收的明确工作区授权`)
  session.workspaceBase = `${session.bootstrap.gatewayBasePath}/autoops/projects/${session.project.id}/workspaces`
  session.overview = await api(session)
  session.internal = session.overview.internalVersions.find((version) => version.isExample && version.status === 'published')
  session.external = session.overview.externalVersions.find((version) => version.status === 'published' && version.isExample && (!session.internal || version.sourceVersionId === session.internal.id))
  session.pending = session.overview.externalVersions.find((version) => version.status === 'pending_review' && (version.isExample || version.sourceVersionId === session.internal?.id))
  return session
}
async function api(session, suffix = '') {
  const response = await session.page.request.get(origin + session.workspaceBase + suffix, { headers: { origin, 'x-t3-orchestration-protocol': '2' } })
  assert.equal(response.status(), 200, `工作区只读 API ${suffix}`)
  return response.json()
}
async function closeMobileSidebar(session) {
  if (!session.touch) return
  const mobile = page.locator('[data-sidebar="sidebar"][data-mobile="true"]:visible').first()
  if (!await mobile.isVisible()) return
  const toggle = mobile.locator('[data-sidebar="trigger"]').filter({ visible: true }).first()
  if (await toggle.isVisible()) await toggle.click()
  else await page.keyboard.press('Escape')
  await until(async () => !await mobile.isVisible(), '应先关闭移动侧栏，避免主页面处于 inert')
}
async function dismissToasts() {
  const controls = page.getByRole('button', { name: '关闭通知', exact: true }).filter({ visible: true })
  for (let index = 0; index < 8; index++) {
    const count = await controls.count()
    if (count === 0) return
    try {
      await controls.first().click({ timeout: 1500 })
    } catch (error) {
      const expiredDuringClick = error.name === 'TimeoutError' || /not attached|detached/i.test(error.message)
      if (expiredDuringClick && await controls.count() === 0) return
      throw error
    }
    await until(async () => await controls.count() < count, '通知关闭后应消失，截图前不能保留遮挡', 2500)
  }
  assert.equal(await controls.count(), 0, '截图前仍有未关闭通知')
}
async function choose(label, text) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option').filter({ hasText: text }).first().click()
}
const tab = (label) => page.locator('[aria-label="工作区分类"]').getByText(label, { exact: true })
async function management(session, type = 'internal', version = session.internal) {
  page = session.page
  await closeMobileSidebar(session)
  await page.goto(origin + '/agent-demo.html#/workspaces')
  await page.getByRole('combobox', { name: '工作区项目', exact: true }).waitFor({ timeout: 60000 })
  await closeMobileSidebar(session)
  if (session.project.id !== session.bootstrap.projects[0].id) await choose('工作区项目', session.project.name)
  if (await tab(type === 'external' ? '外部工作区' : type === 'packages' ? '部署发布' : '内部工作区').isVisible()) await tab(type === 'external' ? '外部工作区' : type === 'packages' ? '部署发布' : '内部工作区').click()
  if (version && type !== 'packages') {
    const label = type === 'internal' ? '内部版本' : '外部版本'
    await page.getByRole('combobox', { name: label, exact: true }).waitFor()
    await choose(label, version.name)
  }
  if (type !== 'packages') await page.locator('[data-readonly-workspace]').first().waitFor()
  await dismissToasts()
}
async function theme(session, mode) {
  page = session.page
  await closeMobileSidebar(session)
  await page.goto(origin + '/agent-demo.html#/settings/appearance')
  await page.getByRole('group', { name: '外观模式', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
  await closeMobileSidebar(session)
  await page.getByRole('group', { name: '外观模式', exact: true }).getByRole('button', { name: mode === 'dark' ? '使用深色模式' : '使用浅色模式', exact: true }).click()
  await until(() => page.evaluate((dark) => document.documentElement.classList.contains('dark') === dark, mode === 'dark'), '隔离 profile 原生外观未切换')
}
async function capture(session, name, fileExpected = true) {
  await dismissToasts()
  const measurement = await page.evaluate(({ fileExpected }) => {
    const rect = (element) => {
      if (!element) return null
      const box = element.getBoundingClientRect(), style = getComputedStyle(element)
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, maxHeight: style.maxHeight, overflowX: style.overflowX, overflowY: style.overflowY }
    }
    const files = document.querySelector('[data-readonly-workspace]'), toolbar = document.querySelector('[aria-label="工作区工具栏"]')
    const tree = files?.querySelector('[role="tree"]'), viewport = tree?.closest('[data-slot="scroll-area-viewport"]')
    const controls = [...(toolbar?.querySelectorAll('button') ?? [])].filter((element) => { const box = element.getBoundingClientRect(); return box.width && box.height }).map((element) => ({ label: element.getAttribute('aria-label') || element.textContent.trim(), rect: rect(element) }))
    return { viewport: { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, coarse: matchMedia('(pointer: coarse)').matches, touchPoints: navigator.maxTouchPoints }, files: rect(files), fileRegion: rect(files?.closest('section')), toolbar: rect(toolbar), treeViewport: rect(viewport), controls, fileExpected }
  }, { fileExpected })
  report.geometry.push({ session: session.name, name, ...measurement })
  if (session.touch) { assert.equal(measurement.viewport.coarse, true); assert.equal(measurement.viewport.width, 390); assert(measurement.viewport.touchPoints > 0) }
  if (!baseline) {
    assert(measurement.viewport.documentWidth <= measurement.viewport.width + 1, '页面不能横向溢出')
    assert(measurement.viewport.documentHeight <= measurement.viewport.height + 1, '主页面须在视窗内管理滚动')
    if (fileExpected) {
      assert(measurement.files?.height > 0, '文件主区域必须可见')
      assert(measurement.files.bottom >= measurement.viewport.height - 3 && measurement.files.bottom <= measurement.viewport.height + 1, '文件主区域应填满剩余窗口')
      assert(measurement.files.height >= measurement.viewport.height * 0.55, '文件区域不能被管理表单挤成嵌入卡片')
      assert.equal(measurement.fileRegion.maxHeight, 'none', '文件区域不能固定 max-height')
      assert(measurement.files.scrollWidth <= measurement.files.clientWidth + 1, '文件区不能撑宽内部视窗')
    }
    if (measurement.toolbar) for (const control of measurement.controls) assert(control.rect.left >= measurement.toolbar.left - 1 && control.rect.right <= measurement.toolbar.right + 1, `工具栏操作裁切：${control.label}`)
    if (measurement.treeViewport) assert(measurement.treeViewport.scrollWidth <= measurement.treeViewport.clientWidth + 1, '目录滚动视窗不能继承最大内容宽度')
  }
  await page.screenshot({ path: path.join(output, `${phase}-${name}.png`) })
  return measurement
}

const surface = () => page.locator('[data-readonly-workspace]').first()
const row = (name) => surface().locator(`[role="treeitem"][data-item-path=${JSON.stringify(name)}], [role="treeitem"][data-item-path=${JSON.stringify(name + '/')}]`).first()
async function sourceContains(text) {
  return surface().evaluate((element, expected) => {
    function read(root) {
      let value = root.textContent || ''
      for (const child of root.querySelectorAll('*')) if (child.shadowRoot) value += read(child.shadowRoot)
      return value
    }
    return read(element).includes(expected)
  }, text)
}
async function fileFlow(session) {
  await management(session)
  assert(!(await page.locator('main[data-slot="sidebar-inset"]').innerText()).includes(session.internal.source.contentHash), '内容校验不能常驻主内容区域')
  await row('frontend').waitFor()
  if (await row('frontend').getAttribute('aria-expanded') !== 'true') { await row('frontend').focus(); await row('frontend').press('ArrowRight') }
  await row('frontend/package.json').click()
  await until(() => sourceContains('autoops-workspace-example-frontend'), '目录选中文件后须显示实际源码')
  assert.equal(await surface().locator('[contenteditable="true"], textarea').count(), 0, '文件浏览不可挂载编辑器')
  assert.equal(await surface().getByRole('button', { name: '添加到对话', exact: true }).count(), 0, '管理页面不隐式引用到现有对话')
  const source = await capture(session, `${session.name}-native-source`)
  if (session.touch) await surface().getByRole('button', { name: '返回文件目录', exact: true }).click()
  const search = surface().getByRole('searchbox')
  await search.fill('页面原型.html')
  await row('prototypes/页面原型.html').click()
  await surface().frameLocator('iframe[title="页面原型.html"]').getByRole('heading', { name: '项目工作区', exact: true }).waitFor()
  await surface().getByLabel('显示 HTML 源码', { exact: true }).click()
  await until(() => sourceContains('<!doctype html>'), 'HTML 源码切换须读取真实文件')
  await surface().getByLabel('显示页面预览', { exact: true }).click()
  await surface().frameLocator('iframe[title="页面原型.html"]').getByRole('heading', { name: '项目工作区', exact: true }).waitFor()
  const html = await capture(session, `${session.name}-native-html`)
  return { nativeTreeKeyboard: true, sourcePreview: true, sandboxedHtmlAndSource: true, readOnly: true, geometry: [source, html] }
}
async function openDialog(session, entry, title = entry) {
  const name = entry === '任务记录' ? /^(?:任务记录|\d+ 个任务执行中)/ : entry
  let trigger = page.getByRole('button', { name, exact: true }).filter({ visible: true }).first()
  let focusLabel = entry
  if (!await trigger.isVisible()) {
    trigger = page.getByRole('button', { name: '工作区操作', exact: true })
    focusLabel = '工作区操作'
    await trigger.focus(); await trigger.press('Enter')
    const item = page.getByRole('menuitem', { name, exact: true })
    await item.focus(); await item.press('Enter')
  } else {
    focusLabel = await trigger.getAttribute('aria-label') || (await trigger.innerText()).trim()
    await trigger.focus(); await trigger.press('Enter')
  }
  const dialog = page.getByRole('dialog', { name: title, exact: true })
  await dialog.waitFor()
  await until(() => dialog.evaluate((element) => element.contains(document.activeElement)), `${title} 应将焦点移入原生弹窗`)
  return { dialog, focusLabel, title }
}
async function dialogGeometry(handle, name, requireScroll = false) {
  await dismissToasts()
  const { dialog } = handle
  const geometry = await dialog.evaluate((element) => {
    const bounds = (target) => {
      const rect = target.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, clientWidth: target.clientWidth, scrollWidth: target.scrollWidth, clientHeight: target.clientHeight, scrollHeight: target.scrollHeight, scrollTop: target.scrollTop }
    }
    return { viewport: { width: innerWidth, height: innerHeight }, popup: bounds(element), scrollViews: [...element.querySelectorAll('[data-slot="scroll-area-viewport"]')].map(bounds), footer: element.querySelector('[data-slot="dialog-footer"]') ? bounds(element.querySelector('[data-slot="dialog-footer"]')) : null }
  })
  report.geometry.push({ name, dialog: geometry })
  assert(geometry.popup.left >= -1 && geometry.popup.right <= geometry.viewport.width + 1, `${handle.title} 不能溢出横向视窗`)
  assert(geometry.popup.top >= -1 && geometry.popup.bottom <= geometry.viewport.height + 1, `${handle.title} 不能溢出纵向视窗`)
  assert(geometry.popup.scrollWidth <= geometry.popup.clientWidth + 1, `${handle.title} 内容不能撑宽弹窗`)
  if (geometry.footer) assert(geometry.footer.bottom <= geometry.popup.bottom + 1, `${handle.title} 底部操作须始终可见`)
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press(index % 3 === 0 ? 'Shift+Tab' : 'Tab')
    assert(await dialog.evaluate((element) => element.contains(document.activeElement)), `${handle.title} Tab 焦点须留在弹窗中`)
  }
  if (requireScroll) {
    const viewport = dialog.locator('[data-slot="scroll-area-viewport"]').filter({ visible: true }).first()
    const before = await viewport.evaluate((element) => ({ scrollTop: element.scrollTop, max: element.scrollHeight - element.clientHeight }))
    assert(before.max > 20, `${handle.title} 长表单须使用原生内部滚动`)
    await viewport.hover()
    await page.mouse.wheel(0, before.scrollTop > before.max / 2 ? -600 : 600)
    await until(async () => Math.abs(await viewport.evaluate((element) => element.scrollTop) - before.scrollTop) > 2, `${handle.title} 内部滚动须真实响应滚轮`)
    geometry.realInternalScroll = true
  }
  await page.screenshot({ path: path.join(output, `${phase}-${name}.png`) })
  return geometry
}
async function closeDialog(handle) {
  await page.keyboard.press('Escape')
  await handle.dialog.waitFor({ state: 'hidden' })
  await until(() => page.evaluate((label) => {
    const element = document.activeElement
    return element?.getAttribute('aria-label') === label || element?.textContent?.trim() === label
  }, handle.focusLabel), `${handle.title} 关闭后须恢复入口焦点`)
}
async function dialogFlow(session) {
  await management(session)
  const captures = []
  let handle = await openDialog(session, '版本详情')
  assert(!(await handle.dialog.innerText()).includes(session.internal.source.contentHash), '完整版本校验须默认折叠')
  await handle.dialog.getByRole('button', { name: '完整版本信息', exact: true }).click()
  await until(async () => (await handle.dialog.innerText()).includes(session.internal.source.contentHash), '完整信息展开后须有真实版本校验')
  captures.push(await dialogGeometry(handle, `${session.name}-version-details`))
  await closeDialog(handle)
  handle = await openDialog(session, '任务记录')
  captures.push(await dialogGeometry(handle, `${session.name}-tasks`))
  await closeDialog(handle)
  handle = await openDialog(session, '导入仓库')
  const importButton = handle.dialog.getByRole('button', { name: '导入并保存版本', exact: true })
  assert(await importButton.isDisabled(), '空仓库地址不可提交')
  if (session.overview.import?.supported !== false) {
    await handle.dialog.getByRole('textbox', { name: 'HTTPS 仓库地址', exact: true }).fill('https://github.com/example/readonly-ui-check.git')
    assert(await importButton.isEnabled(), '完整导入表单应保留业务提交入口')
  }
  captures.push(await dialogGeometry(handle, `${session.name}-import`))
  await closeDialog(handle)
  await management(session, 'external', session.external)
  handle = await openDialog(session, '生成外部版本')
  await choose('来源内部版本', session.internal.name)
  for (let index = 0; index < 20; index++) await handle.dialog.getByRole('button', { name: '添加替换', exact: true }).click()
  await handle.dialog.getByRole('textbox', { name: '规则 1 原始文本', exact: true }).fill('只读验收，不提交')
  await handle.dialog.getByRole('textbox', { name: '规则 1 替换文本', exact: true }).fill('仅本地表单')
  assert(await handle.dialog.getByRole('button', { name: '生成外部版本', exact: true }).isEnabled(), '外部生成操作须保留')
  captures.push(await dialogGeometry(handle, `${session.name}-external-long-form`, true))
  await closeDialog(handle)
  if (session.external) {
    handle = await openDialog(session, '脱敏检查', '脱敏复核')
    assert.equal(await handle.dialog.getByRole('button', { name: '确认并发布版本', exact: true }).count(), 0, '已发布版本不可重复显示发布按钮')
    assert((await handle.dialog.innerText()).includes('此版本已通过检查并固定保存'))
    captures.push(await dialogGeometry(handle, `${session.name}-published-review`))
    await closeDialog(handle)
  }
  let pendingReview = { tested: false, reason: '没有来源于示例内部版本的既有待复核版；只读样式验收不新增版本。' }
  if (session.pending?.report?.pendingFiles.length) {
    await management(session, 'external', session.pending)
    handle = await openDialog(session, '复核并发布', '脱敏复核')
    const submit = handle.dialog.getByRole('button', { name: '确认并发布版本', exact: true })
    assert(await submit.isDisabled(), '待复核文件未逐项选择时禁止发布')
    for (const file of session.pending.report.pendingFiles) await choose(`复核 ${file.path}`, '排除文件')
    assert(await submit.isEnabled(), '逐项完成选择后应允许明确发布')
    captures.push(await dialogGeometry(handle, `${session.name}-pending-review-no-submit`))
    await closeDialog(handle)
    assert.equal((await api(session)).externalVersions.find((version) => version.id === session.pending.id).status, 'pending_review', '关闭本地选择不能发布工作区')
    pendingReview = { tested: true, versionId: session.pending.id, disabledBeforeDecisions: true, enabledAfterDecisions: true, noPublishSubmitted: true }
  }
  await management(session, 'packages', null)
  handle = await openDialog(session, '生成部署包')
  await choose('来源内部版本', session.internal.name)
  for (const label of ['前端源码包', '后端源码包']) {
    const checkbox = handle.dialog.getByRole('checkbox', { name: label, exact: true })
    if (await checkbox.isChecked()) await checkbox.uncheck()
  }
  assert(await handle.dialog.getByRole('button', { name: '生成部署包', exact: true }).isDisabled(), '未选择打包类型时不能提交')
  await handle.dialog.getByRole('checkbox', { name: '前端源码包', exact: true }).check()
  assert(await handle.dialog.getByRole('button', { name: '生成部署包', exact: true }).isEnabled(), '选中打包类型后业务入口须可用')
  captures.push(await dialogGeometry(handle, `${session.name}-packages`))
  await closeDialog(handle)
  return { captures, pendingReview, noBusinessSubmit: true, nativeFocusTrapAndRestoration: true, sourceSelection: true }
}
async function packageFlow(session) {
  await management(session, 'packages', null)
  const release = session.overview.releases.find((entry) => entry.sourceVersionId === session.internal.id)
  if (!release) return { tested: false, reason: '没有来自示例内部版本的既有交付；只读验收不生成部署包。' }
  const delivery = page.locator('[aria-label="部署交付"]')
  const selected = delivery.locator('button[aria-pressed]').filter({ hasText: release.name }).first()
  await selected.click()
  assert.equal(await selected.getAttribute('aria-pressed'), 'true', '连续交付列表须标明真实选中记录')
  const urls = []
  for (const service of release.services) {
    const link = delivery.getByRole('link', { name: service.service === 'frontend' ? '下载前端 ZIP' : '下载后端 ZIP', exact: true })
    const href = await link.getAttribute('href')
    assert(href?.includes(encodeURIComponent(release.id)), '部署包下载须对应选中的交付记录')
    urls.push({ service: service.service, href })
  }
  let manifest, handle
  if (session.touch) {
    handle = await openDialog(session, '查看交付清单', '交付清单')
    manifest = handle.dialog
  } else manifest = page.getByRole('region', { name: '交付清单预览', exact: true })
  await until(() => manifest.evaluate((element, expected) => {
    function read(root) {
      let value = root.textContent || ''
      for (const child of root.querySelectorAll('*')) if (child.shadowRoot) value += read(child.shadowRoot)
      return value
    }
    return read(element).includes(expected)
  }, release.sourceVersionId), '交付清单须显示所选记录实际的内部来源版本')
  const download = manifest.getByRole('link', { name: '下载交付清单', exact: true })
  const href = await download.getAttribute('href')
  assert(href?.includes(encodeURIComponent(release.id)), 'manifest 下载须对应选中交付记录')
  const response = await page.request.get(new URL(href, origin).toString())
  assert.equal(response.status(), 200)
  const actual = await response.json()
  assert.equal(actual.sourceVersionId, release.sourceVersionId)
  assert.equal(actual.status, 'packaged', '源码包不能显示成已部署成功')
  const geometry = handle ? await dialogGeometry(handle, `${session.name}-manifest`) : await capture(session, `${session.name}-manifest`, false)
  if (handle) await closeDialog(handle)
  return { tested: true, releaseId: release.id, sourceVersionId: actual.sourceVersionId, packageLinks: urls.map(({ service }) => service), realManifestDownloaded: true, geometry }
}

try {
  await run('admin-login', async () => {
    const session = await login('admin')
    assert(session.internal, '验收只使用已标识的示例内部版本')
    return { isolatedProfile: true, noMessageSent: true, projectId: session.project.id, internalVersionId: session.internal.id }
  })
  const desktop = sessions[0]
  await run('desktop-theme-and-height', async () => {
    const captures = []
    for (const mode of ['light', 'dark']) {
      await theme(desktop, mode)
      await management(desktop)
      captures.push(await capture(desktop, `internal-${mode}-1440`))
    }
    await page.setViewportSize({ width: 1280, height: 600 })
    captures.push(await capture(desktop, 'internal-dark-short'))
    await page.setViewportSize({ width: 1440, height: 900 })
    if (desktop.external) { await management(desktop, 'external', desktop.external); captures.push(await capture(desktop, 'external-dark-1440')) }
    await management(desktop, 'packages', null)
    captures.push(await capture(desktop, 'packages-dark-1440', false))
    return { captures, densityAssertionsSkipped: baseline }
  })
  if (!baseline) {
    await run('desktop-native-files', () => fileFlow(desktop))
    await run('desktop-management-dialogs', () => dialogFlow(desktop))
    await run('desktop-native-delivery', () => packageFlow(desktop))
    await run('short-window-dialog', async () => {
      await page.setViewportSize({ width: 1280, height: 600 })
      await management(desktop)
      const handle = await openDialog(desktop, '版本详情')
      await handle.dialog.getByRole('button', { name: '完整版本信息', exact: true }).click()
      const geometry = await dialogGeometry(handle, 'desktop-short-version-details')
      await closeDialog(handle)
      await page.setViewportSize({ width: 1440, height: 900 })
      return { geometry }
    })
  }
  await run('coarse-touch-theme-and-height', async () => {
    const touch = await login('admin', true), captures = []
    for (const mode of ['light', 'dark']) {
      await theme(touch, mode)
      await management(touch)
      captures.push(await capture(touch, `internal-${mode}-390`))
    }
    if (touch.external) { await management(touch, 'external', touch.external); captures.push(await capture(touch, 'external-dark-390')) }
    await management(touch, 'packages', null)
    captures.push(await capture(touch, 'packages-dark-390', false))
    if (!baseline) {
      const files = await fileFlow(touch)
      const dialogs = await dialogFlow(touch)
      const delivery = await packageFlow(touch)
      return { captures, files, dialogs, delivery, isolatedTouchProfile: true }
    }
    return { captures, isolatedTouchProfile: true }
  })
  await run('guest-published-external', async () => {
    const guest = await login('guest')
    assert.equal(guest.overview.internalVersions.length, 0, '外部身份不能读取内部版本目录')
    assert(guest.external, '需要现有的已发布示例外部版本')
    await management(guest, 'external', guest.external)
    const geometry = await capture(guest, 'guest-published-external')
    if (!baseline) {
      for (const label of ['导入仓库', '生成外部版本', '生成部署包', '脱敏检查']) assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0, `外部成员不能看到管理操作：${label}`)
    }
    return { externalVersionId: guest.external.id, internalVersions: 0, geometry }
  })
  assert.deepEqual(report.pageErrors, [], '不能出现未处理页面错误')
  assert.equal(report.messageDispatches, 0, '不能发送消息')
  assert.equal(report.initialMessages, 0, '不能通过 launchThread 调用模型')
  assert.equal(report.filesystemWrites, 0, '不能写入工作区文件')
  assert.deepEqual(report.blockedRpcMutations, [], '原生服务器写入尝试已在发出前阻止，须查明原因')
  assert.deepEqual(report.blockedHttpMutations, [], 'HTTP 业务写入尝试已被阻止，须查明原因')
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.fatal = error.stack; process.exitCode = 1 }
finally {
  for (const session of sessions) {
    const cleanup = report.cleanup[session.name] = {}
    await session.context?.close().catch((error) => { cleanup.browserError = error.message; process.exitCode = 1; report.status = 'failed' })
    await rm(session.profile, { recursive: true, force: true })
    cleanup.onlyOwnedProfileRemoved = true
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
