import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'

// Read-only against the chosen application: local drafts/preferences live only
// in this disposable browser profile. No message, model or task is dispatched.
const origin = new URL(process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').origin
const output = path.resolve(process.env.T3_ZH_OUTPUT || '.test-artifacts/t3-ui-zh')
await mkdir(output, { recursive: true })
const report = { origin, steps: [], pageErrors: [], modelRequests: [], texts: {} }
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'en-US',
})
const page = await context.newPage()
page.on('pageerror', (error) =>
  report.pageErrors.push({ message: error.message, stack: error.stack, url: page.url() }),
)
page.on('websocket', (socket) =>
  socket.on('framesent', ({ payload }) => {
    try {
      const frame = JSON.parse(String(payload))
      if (
        frame.tag === 'orchestration.dispatchCommand' &&
        frame.payload?.type === 'message.dispatch'
      )
        report.modelRequests.push(frame.payload.type)
      if (frame.tag === 'orchestration.launchThread' && frame.payload?.initialMessage)
        report.modelRequests.push(frame.tag)
    } catch {
      /* Keep-alive frames have no UI significance. */
    }
  }),
)
async function step(name, run) {
  const row = { name }
  report.steps.push(row)
  try {
    row.result = await run()
    row.status = 'passed'
  } catch (error) {
    row.status = 'failed'
    row.error = error.message
    process.exitCode = 1
    await page.screenshot({ path: path.join(output, name + '-failed.png') }).catch(() => {})
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(row))
}
async function settings(route, expected) {
  await page.goto(origin + '/agent-demo.html#/settings/' + route)
  if (page.viewportSize().width >= 768)
    await page.getByRole('combobox', { name: '搜索设置', exact: true }).waitFor({ timeout: 45000 })
  await page.getByText(expected, { exact: true }).first().waitFor()
  const text = await page.locator('body').innerText()
  report.texts[route] = text
  assert(
    !/\b(?:General|Appearance|Keybindings|Archived threads|Search settings|Response streaming|Show finished paragraphs|Follow system)\b/.test(
      text,
    ),
    'Untranslated interface copy',
  )
  return text
}
try {
  await step('native-login-chinese', async () => {
    await page.goto(origin + '/agent-demo.html')
    await page.getByRole('textbox', { name: '用户名' }).fill('admin')
    await page
      .getByLabel('密码', { exact: true })
      .fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--glass-canvas').trim(),
      ),
      '',
    )
    await page.screenshot({ path: path.join(output, 'login.png') })
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByTestId('composer-editor').waitFor({ timeout: 60000 })
    report.texts.chat = await page.locator('body').innerText()
    const interfaceLabels = await page
      .locator('button:visible, input:visible, [data-testid="composer-editor"]')
      .evaluateAll((nodes) =>
        nodes
          .flatMap((node) => [node.getAttribute('aria-label'), node.getAttribute('placeholder')])
          .filter(Boolean),
      )
    assert(
      !interfaceLabels.some((label) =>
        /(?:Ask for changes|Send message|Open stash|New thread|Scroll to end)/.test(label),
      ),
    )
    await page.screenshot({ path: path.join(output, 'chat.png') })
    return { chineseInEnglishBrowser: true, legacyGlassAbsent: true }
  })
  await step('general-settings-chinese', async () => {
    await settings('general', '常规')
    const select = page.getByRole('combobox', { name: '回复流式显示', exact: true })
    await select.click()
    await page.getByRole('option', { name: '显示已完成的段落', exact: true }).waitFor()
    await page.getByRole('option', { name: '等待完整回复', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    assert(await select.evaluate((element) => element === document.activeElement))
    await page.screenshot({ path: path.join(output, 'general.png') })
    return { translatedOptions: true, escapeRestoresFocus: true }
  })
  await step('appearance-theme-and-fonts', async () => {
    await settings('appearance', '外观')
    const mode = page.getByRole('group', { name: '外观模式', exact: true })
    await mode.getByRole('button', { name: '使用深色模式', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
    await page.screenshot({ path: path.join(output, 'appearance-dark.png') })
    await mode.getByRole('button', { name: '使用浅色模式', exact: true }).click()
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'))
    await page.screenshot({ path: path.join(output, 'appearance-light.png') })
    const tokens = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement)
      return Object.fromEntries(
        [
          '--control-radius',
          '--chat-content-max-width',
          '--workspace-topbar-height',
          '--font-sans',
        ].map((k) => [k, s.getPropertyValue(k).trim()]),
      )
    })
    assert.equal(Number.parseFloat(tokens['--control-radius']), 0.5)
    assert.equal(tokens['--chat-content-max-width'], '46rem')
    assert.equal(tokens['--workspace-topbar-height'], '52px')
    return { nativeTokens: tokens, darkAndLight: true }
  })
  await step('settings-search-chinese', async () => {
    const search = page.getByRole('combobox', { name: '搜索设置', exact: true })
    await search.fill('流式')
    await page.getByText('回复流式显示', { exact: true }).first().waitFor()
    report.texts.search = await page.locator('body').innerText()
    await search.fill('')
    return { chineseSearch: true }
  })
  await step('keybindings-and-archive', async () => {
    await settings('keybindings', '快捷键')
    await page.screenshot({ path: path.join(output, 'keybindings.png') })
    await settings('archived', '归档')
    await page.screenshot({ path: path.join(output, 'archive.png') })
    await settings('open-source-licenses', '开源许可证')
    return { licenseLegalTextPreserved: true }
  })
  await step('mobile-chinese-layout', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await settings('appearance', '外观')
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      'Horizontal overflow',
    )
    const clipped = await page
      .locator('input:visible')
      .evaluateAll(
        (elements) =>
          elements.filter((el) => el.getBoundingClientRect().right > innerWidth + 1).length,
      )
    assert.equal(clipped, 0)
    await page.screenshot({ path: path.join(output, 'mobile-appearance.png') })
    return { width: 390, overflow: false, reducedMotion: true }
  })
  await step('no-runtime-regression', async () => {
    assert.deepEqual(report.pageErrors, [])
    assert.deepEqual(report.modelRequests, [])
    return { pageErrors: 0, modelRequests: 0 }
  })
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
