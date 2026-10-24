import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'

// 只读取验证环境，禁止业务写入和模型调用，所有草稿仅存在于独立浏览器上下文。
const origin = process.env.BASE_URL ?? 'http://127.0.0.1:29687'
assert(
  ['127.0.0.1', 'localhost'].includes(new URL(origin).hostname),
  '公共框架验收仅运行于本机预览',
)
const output = path.resolve(process.env.ARTIFACT_DIR ?? '.test-artifacts/ui-language')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
  headless: true,
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
})
const report = {
  cases: [],
  errors: [],
  blockedWrites: [],
  geometry: [],
  rpcBlocked: [],
  screenshots: [],
}
await context.route('**/*', async (route) => {
  const request = route.request(),
    url = new URL(request.url())
  if (!['http:', 'https:'].includes(url.protocol)) return route.continue()
  if (url.origin !== origin) return route.abort()
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue()
  if (request.method() === 'POST' && url.pathname === '/api/agent-demo/login')
    return route.continue()
  if (url.pathname.endsWith('/api/observability/v1/traces'))
    return route.fulfill({ status: 204, body: '' })
  report.blockedWrites.push({ method: request.method(), path: url.pathname })
  return route.fulfill({ status: 409, json: { error: '本机框架验收只允许读取。' } })
})
await context.routeWebSocket(
  (url) => url.pathname.endsWith('/api/agent-demo/t3/ws'),
  (socket) => {
    const remote = socket.connectToServer()
    socket.onMessage((payload) => {
      let value
      try {
        value = JSON.parse(String(payload))
      } catch {
        remote.send(payload)
        return
      }
      const messages = Array.isArray(value) ? value : [value]
      const allowed = messages.filter((message) => {
        const method = message.tag ?? ''
        const permitted =
          !method.includes('.') ||
          (/^orchestration\.(get|list|subscribe)/.test(method) &&
            !/^orchestration\.(getThread|subscribeThread)/.test(method)) ||
          (!method.startsWith('orchestration.') &&
            (/\.(get|list|read|search|subscribe|observe|browse|stat|probe|resolve|inspect|watch|find|toolInfo|routing|summary|detail|checks|activity|diffFileContents|reviewGuide|linkedThreads)/i.test(
              method,
            ) ||
              [
                'preview.reportProfiles',
                'assets.createUrl',
                'server.refreshProviders',
                'server.reportClientActivity',
                'server.reportHostPowerState',
              ].includes(method)))
        if (!permitted) report.rpcBlocked.push(method)
        return permitted
      })
      if (allowed.length === messages.length) remote.send(payload)
      else if (allowed.length)
        remote.send(JSON.stringify(Array.isArray(value) ? allowed : allowed[0]))
    })
  },
)
const page = await context.newPage()
page.setDefaultTimeout(20000)
page.on('pageerror', (error) => report.errors.push(error.message))
const draft = randomUUID()
const nav = () => page.getByTestId('project-area-navigation')
const sidebar = () => page.locator('[data-app-sidebar]').filter({ visible: true })
async function screenshot(name) {
  const file = path.join(output, name + '.png')
  await page.screenshot({ path: file, mask: [page.locator('[data-thread-item]')] })
  report.screenshots.push(file)
}
async function run(name, action) {
  try {
    await action()
    report.cases.push({ name, passed: true })
    console.log('通过：' + name)
  } catch (error) {
    report.cases.push({ name, passed: false, error: error.message })
    await screenshot('failure')
    throw error
  } finally {
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  }
}
async function settings(section) {
  await page.goto(`${origin}/#/settings/${section}`)
  await page
    .getByRole('heading', { name: section === 'general' ? '当前配置' : '颜色与主题', exact: true })
    .waitFor()
}
try {
  await page.goto(`${origin}/agent-demo.html#/draft/${draft}`)
  await page.getByRole('textbox', { name: '用户名' }).fill('admin')
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.AGENT_DEMO_TEST_PASSWORD ?? 'Demo123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByTestId('composer-editor').waitFor({ timeout: 60000 })
  await run('英文浏览器仍显示中文服务错误，详情保留原始诊断', async () => {
    await page.getByText('模型服务暂时不可用，请稍后重试。', { exact: true }).waitFor()
    await page.getByText('查看错误详情', { exact: true }).click()
    const detail = page.locator('details[open] p')
    await detail.waitFor()
    assert((await detail.innerText()).trim().length > 0)
    await screenshot('provider-error-details')
    assert.equal(await page.locator('[aria-label="Notifications (F8)"]').count(), 0)
    await page.getByText('查看错误详情', { exact: true }).click()
  })
  await run('常规设置用语与开源声明', async () => {
    await settings('general')
    await page.getByText('AutoOps 使用的开源组件、资源及许可证。', { exact: true }).waitFor()
    assert.doesNotMatch(await page.locator('main').innerText(), /T3 Code 使用|Agent 执行期间/)
    await screenshot('general-light')
  })
  await run('内置主题改名保留选择与键盘关闭', async () => {
    await settings('appearance')
    await page.getByRole('button', { name: '使用 默认 主题', exact: true }).waitFor()
    await page.getByRole('button', { name: '使用 柔和 主题', exact: true }).waitFor()
    assert.equal(
      await page.getByRole('button', { name: '使用 T3 Code 主题', exact: true }).count(),
      0,
    )
    await page.getByRole('button', { name: '添加主题', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    await page
      .getByText('拖入主题 .json 文件（支持 T3 Code / VS Code 格式）', { exact: true })
      .waitFor()
    await screenshot('theme-import')
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.textContent?.includes('添加主题'))
  })
  for (const mode of ['深色', '浅色'])
    await run(mode + '与窄屏短窗口', async () => {
      await page.getByRole('button', { name: `使用${mode}模式`, exact: true }).click()
      await page.waitForFunction(
        (dark) => document.documentElement.classList.contains('dark') === dark,
        mode === '深色',
      )
      for (const viewport of [
        { width: 1440, height: 600 },
        { width: 390, height: 480 },
      ]) {
        await page.setViewportSize(viewport)
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        )
        await screenshot(`${mode}-${viewport.width}`)
      }
      await page.setViewportSize({ width: 1440, height: 900 })
    })
  await run('断网显示中文原因，恢复网络后自动连接', async () => {
    await page.goto(`${origin}/#/draft/${draft}`)
    await page.getByTestId('composer-editor').waitFor()
    await page.getByText('模型服务暂时不可用，请稍后重试。', { exact: true }).waitFor()
    await page.waitForLoadState('networkidle')
    await context.setOffline(true)
    await page.getByText('对话服务连接已断开', { exact: true }).waitFor({ timeout: 25000 })
    await page.getByText('当前设备未连接网络', { exact: true }).waitFor()
    await screenshot('offline')
    assert.doesNotMatch(
      await page.locator('main').innerText(),
      /is reconnecting|is offline|This device is offline/,
    )
    await context.setOffline(false)
    await page
      .getByText('对话服务连接已断开', { exact: true })
      .waitFor({ state: 'hidden', timeout: 30000 })
    await page
      .getByText('正在重新连接对话服务…', { exact: true })
      .waitFor({ state: 'hidden', timeout: 30000 })
    await screenshot('recovered')
  })
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.blockedWrites, [])
  assert.deepEqual(report.rpcBlocked, [])
} finally {
  await context.setOffline(false)
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
