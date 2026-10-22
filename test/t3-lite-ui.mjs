import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'

// A disposable browser only; no message, model or business task is dispatched.
const origin = new URL(process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').origin
const output = path.resolve(process.env.T3_LITE_OUTPUT || '.test-artifacts/t3-lite/ui')
await mkdir(output, { recursive: true })
const report = { origin, steps: [], pageErrors: [], dispatches: [], texts: {} }
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
const page = await context.newPage()
page.on('pageerror', error => report.pageErrors.push(error.message))
page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
  try {
    const frame = JSON.parse(String(payload))
    if (frame.tag === 'orchestration.dispatchCommand' && frame.payload?.type !== 'thread.visit') report.dispatches.push(frame.payload?.type)
    if (frame.tag === 'orchestration.launchThread') report.dispatches.push(frame.tag)
  } catch { /* Heartbeats are not application commands. */ }
}))
const save = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
async function step(name, fn) {
  const row = { name }
  report.steps.push(row)
  try { row.result = await fn(); row.status = 'passed' }
  catch (error) {
    row.status = 'failed'; row.error = error.message; process.exitCode = 1
    await page.screenshot({ path: path.join(output, name + '-failed.png') }).catch(() => {})
  }
  await save(); console.log(JSON.stringify(row))
}
async function settings(route, sentinel) {
  await page.goto(origin + '/agent-demo.html#/settings/' + route)
  await page.getByText(sentinel, { exact: true }).first().waitFor({ timeout: 45000 })
  report.texts[route] = await page.locator('body').innerText()
}
async function select(label, option) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}
async function css(name) {
  return page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name)
}
async function range(label, token) {
  const slider = page.getByRole('slider', { name: label, exact: true })
  const before = await slider.inputValue()
  const min = Number(await slider.getAttribute('min'))
  await slider.focus(); await page.keyboard.press(Number(before) > min ? 'ArrowLeft' : 'ArrowRight')
  const after = await slider.inputValue()
  assert.notEqual(after, before)
  if (token) await page.waitForFunction(({ token, after }) => getComputedStyle(document.documentElement).getPropertyValue(token).trim() === after + '%', { token, after })
  return { before, after, token: token ? await css(token) : undefined }
}
try {
  await step('login-and-profile', async () => {
    await page.goto(origin + '/agent-demo.html')
    await page.getByRole('textbox', { name: '用户名' }).fill('admin')
    await page.getByLabel('密码', { exact: true }).fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByTestId('composer-editor').waitFor({ timeout: 60000 })
    const bootstrap = await page.evaluate(async () => (await fetch('/api/agent-demo/t3/autoops/bootstrap')).json())
    assert.equal(bootstrap.productProfile.id, 'project-assistant-lite-v1')
    for (const feature of ['threadFork', 'planMode', 'historyRollback', 'subagents', 'interactiveArtifacts', 'customKeybindings']) assert.equal(bootstrap.capabilities[feature], false)
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
    assert.equal(await page.getByRole('button', { name: /使用量|用量总览/ }).count(), 0)
    await page.screenshot({ path: path.join(output, 'chat.png') })
    return { profile: bootstrap.productProfile.id, advancedCapabilitiesDisabled: true }
  })
  await step('general-only-supported-controls', async () => {
    await settings('general', '当前配置')
    const controls = await page.locator('button[role="combobox"]:visible, [role="switch"]:visible').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
    assert.deepEqual(controls.sort(), ['发送快捷键', '追问处理方式'].sort())
    const text = report.texts.general
    for (const label of ['模型', '受控执行', '版本', '开源许可']) assert(text.includes(label), label)
    for (const label of ['回复流式显示', '重启后继续对话', '压缩空闲', '工作树', '后台活动', '自动收起']) assert(!text.includes(label), label)
    await page.screenshot({ path: path.join(output, 'general.png') })
    return { editableControls: controls, fixedRuntimeVisible: true }
  })
  await step('settings-deep-links-and-search', async () => {
    for (const route of ['keybindings', 'diagnostics', 'providers']) {
      await page.goto(origin + '/agent-demo.html#/settings/' + route)
      await page.getByText('当前配置', { exact: true }).waitFor({ timeout: 20000 })
      assert(!page.url().endsWith('/' + route))
    }
    await page.goto(origin + '/agent-demo.html#/usage')
    await page.getByTestId('composer-editor').waitFor({ timeout: 20000 })
    assert(!page.url().endsWith('/usage'))
    await settings('appearance', '字体排版')
    const search = page.getByRole('combobox', { name: '搜索设置', exact: true })
    await search.fill('主题')
    await page.getByRole('option').filter({ hasText: '主题' }).first().waitFor()
    await search.fill('重启后继续')
    await page.getByText('未找到设置', { exact: true }).waitFor()
    await search.fill(''); await page.keyboard.press('Escape')
    return { hiddenDeepLinksBlocked: true, visibleSearchWorks: true, hiddenSearchRemoved: true }
  })
  await step('appearance-actual-css-and-local-preferences', async () => {
    await settings('appearance', '字体排版')
    const modes = page.getByRole('group', { name: '外观模式', exact: true })
    await modes.getByRole('button', { name: '使用深色模式', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
    await page.screenshot({ path: path.join(output, 'appearance-dark.png') })
    await modes.getByRole('button', { name: '使用浅色模式', exact: true }).click()
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'))
    const contrast = await range('对比度', '--appearance-contrast-base')
    const opacity = await range('玻璃透明度', '--glass-opacity')
    const animation = await range('面板动画时长')
    await select('对话宽度', '宽')
    await page.waitForFunction(() => document.documentElement.dataset.chatWidth === 'wide')
    await select('界面字号', '17 px')
    await page.waitForFunction(() => document.documentElement.style.fontSize === '17px')
    const advanced = page.getByRole('switch', { name: '显示高级字体设置', exact: true })
    if (await advanced.getAttribute('aria-checked') !== 'true') await advanced.click()
    await select('输入字号', '18 px')
    await select('代码字号', '15 px')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--font-size-prompt').trim() === '18px')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--font-size-code').trim() === '15px')
    for (const label of ['数学公式渲染', '默认将代码、表格、差异和文件预览自动换行']) {
      const control = page.getByRole('switch', { name: label, exact: true }), previous = await control.getAttribute('aria-checked')
      await control.click(); assert.notEqual(await control.getAttribute('aria-checked'), previous)
    }
    await page.reload(); await page.getByRole('combobox', { name: '界面字号', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.style.fontSize), '17px')
    assert.equal(await css('--font-size-prompt'), '18px'); assert.equal(await css('--font-size-code'), '15px')
    await page.screenshot({ path: path.join(output, 'appearance-light.png') })
    return { darkAndLight: true, contrast, opacity, animation, fontSizesPersistAcrossReload: true, chatWidth: await css('--chat-content-max-width') }
  })
  await step('local-theme-import-export', async () => {
    await page.getByRole('button', { name: '添加主题', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: '主题 JSON', exact: true }).fill(JSON.stringify({ name: '精简验收主题', type: 'light', colors: { 'editor.background': '#f4f7fa', 'editor.foreground': '#15293a', 'button.background': '#2455aa' } }))
    assert.equal(await dialog.getByPlaceholder(/搜索.*主题/).count(), 0)
    await dialog.getByRole('button', { name: '添加主题', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const exportButton = page.getByRole('button', { name: '导出 精简验收主题', exact: true })
    await exportButton.waitFor()
    const pending = page.waitForEvent('download')
    await exportButton.click(); const download = await pending
    assert(download.suggestedFilename().endsWith('.json'))
    await download.saveAs(path.join(output, 'theme-export.json'))
    await page.reload(); await exportButton.waitFor()
    await page.getByRole('button', { name: '复制 精简验收主题', exact: true }).click()
    await page.getByRole('heading', { name: '创建主题', exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭主题编辑器', exact: true }).click()
    await page.getByRole('heading', { name: '创建主题', exact: true }).waitFor({ state: 'hidden' })
    return { importedAndRetained: true, exportedJson: true, duplicateEditorOpened: true, onlineMarketplaceHidden: true }
  })
  await step('archive-and-licenses', async () => {
    await settings('archived', '归档')
    await page.screenshot({ path: path.join(output, 'archive.png') })
    await settings('open-source-licenses', '开源许可证')
    return { nativeArchiveAndLicenseRoutes: true }
  })
  await step('mobile-layout', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' })
    await settings('appearance', '字体排版')
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await page.screenshot({ path: path.join(output, 'mobile-appearance.png') })
    return { width: 390, overflow: false }
  })
  await step('no-runtime-work-or-page-errors', async () => {
    assert.deepEqual(report.dispatches, []); assert.deepEqual(report.pageErrors, [])
    return { newModelRequests: 0, mutations: 0, pageErrors: 0 }
  })
} finally { await save(); await browser.close() }
