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
const output = path.resolve(process.env.ARTIFACT_DIR ?? '.test-artifacts/skill-picker')
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
  if (request.method() === 'GET' && url.pathname.endsWith('/skill-library/context'))
    return route.fulfill({
      json: {
        cwd: 'autoops/skill-context/isolated-picker-timeout',
        snapshotId: 'isolated-picker-timeout',
        skills: [
          {
            name: 'autoops-isolated-picker',
            displayName: '隔离技能',
            versionId: 'isolated-version',
          },
        ],
      },
    })
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
        // 本机故障注入：丢弃目录读取请求，不调用模型，不修改服务端技能。
        if (method === 'server.refreshProviders') {
          report.rpcBlocked.push('isolated-skill-refresh')
          return false
        }
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

try {
  await page.goto(`${origin}/agent-demo.html#/draft/${draft}`)
  await page.getByRole('textbox', { name: '用户名' }).fill('admin')
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.AGENT_DEMO_TEST_PASSWORD ?? 'Demo123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const editor = page.getByTestId('composer-editor')
  await editor.waitFor({ timeout: 60000 })
  await editor.fill('$')
  await run('目录读取挂起后显示失败和单一重试按钮', async () => {
    await page.getByRole('alert').filter({ hasText: '技能加载失败' }).waitFor({ timeout: 45000 })
    assert(report.rpcBlocked.includes('isolated-skill-refresh'))
    assert.equal(await editor.innerText(), '$')
    assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 1)
    await screenshot('timeout-light-desktop')
  })
  await run('浅深色与桌面、窄屏短窗口错误行无横向溢出', async () => {
    const draftUrl = page.url()
    for (const dark of [false, true]) {
      if (dark) {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${origin}/#/settings/appearance`)
        await page.getByRole('button', { name: '使用深色模式', exact: true }).click()
        await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
        await page.goto(draftUrl)
        await editor.waitFor()
        await editor.fill('$')
        await page
          .getByRole('alert')
          .filter({ hasText: '技能加载失败' })
          .waitFor({ timeout: 45000 })
      }
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 560 })
        const button = page.getByRole('button', { name: '重试', exact: true })
        await button.waitFor()
        const rect = await button.boundingBox()
        assert(rect && rect.x >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= 560)
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        await screenshot(`timeout-${dark ? 'dark' : 'light'}-${width}`)
      }
    }
  })
  await run('键盘重试保留输入并恢复编辑焦点，Esc 关闭候选', async () => {
    const button = page.getByRole('button', { name: '重试', exact: true })
    await button.focus()
    await page.keyboard.press('Enter')
    await page.getByText('正在读取技能…', { exact: true }).last().waitFor()
    assert.equal(await editor.innerText(), '$')
    assert(
      await editor.evaluate(
        (el) => el === document.activeElement || el.contains(document.activeElement),
      ),
    )
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('[data-composer-command-drawer]').count(), 0)
  })
  assert.equal(report.errors.length, 0)
  assert.equal(report.blockedWrites.length, 0)
  report.simulation = '仅本机授权目录夹具与丢弃 RPC，非真实模型调用'
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
} finally {
  await context.close()
  await browser.close()
}
