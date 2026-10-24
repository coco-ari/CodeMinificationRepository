import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'

// 只读取验证环境，禁止业务写入和模型调用，所有草稿仅存在于独立浏览器上下文。
const topbarOnly = process.env.T3_MODULE_SHELL_CASE === 'topbar'
const origin = process.env.BASE_URL ?? 'http://127.0.0.1:31887'
assert(
  ['127.0.0.1', 'localhost'].includes(new URL(origin).hostname),
  '公共框架验收仅运行于本机预览',
)
const output = path.resolve(process.env.ARTIFACT_DIR ?? '.test-artifacts/module-shell/ui')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
  headless: true,
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
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
async function geometry(area) {
  await nav().waitFor()
  await page.locator('main[data-slot="sidebar-inset"]').waitFor()
  const frame = await page.evaluate(() => {
    const rect = (element) => {
      if (!element) return null
      const r = element.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    const main = document.querySelector('main[data-slot="sidebar-inset"]')
    return {
      main: rect(main),
      top: rect(document.querySelector('[data-testid="project-area-navigation"]')),
      sidebar: rect(document.querySelector('[data-slot="sidebar-gap"]')),
      header: rect(main.querySelector('header')),
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
  assert.equal(frame.top.height, 52)
  assert.equal(frame.main.y, 52)
  assert.equal(frame.header.height, 52)
  assert.equal(frame.overflow, false)
  if (!['chat', 'settings'].includes(area)) {
    assert.equal(await page.getByLabel('搜索对话', { exact: true }).count(), 0)
    if (await page.evaluate(() => innerWidth >= 768))
      assert.equal(await page.locator('[data-module-sidebar]').count(), 1)
  }
  report.geometry.push({ area, ...frame })
  return frame
}
async function openSettingsPage(label = '常规设置') {
  const target = { 常规设置: '常规', 外观设置: '外观', 归档对话: '归档' }[label]
  if (!new URL(page.url().split('#')[1], origin).pathname.startsWith('/settings')) {
    if (!(await page.getByRole('button', { name: '设置', exact: true }).isVisible()))
      await nav().getByRole('button', { name: '切换主侧栏', exact: true }).click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
  }
  const button = page.getByRole('button', { name: target, exact: true })
  if (!(await button.isVisible()))
    await nav().getByRole('button', { name: '切换主侧栏', exact: true }).click()
  await button.click()
  const popup = page
    .locator('[data-sidebar="sidebar"][data-mobile="true"]')
    .filter({ visible: true })
  if (await popup.count()) await page.keyboard.press('Escape')
}
async function topbarChecks() {
  const response = await page.request.get(origin + '/api/agent-demo/t3/autoops/bootstrap')
  assert.equal(response.status(), 200)
  const host = await response.json()
  const projectIds = host.projects.map((project) => project.id)
  const labels = ['问答', '工作区', '部署', '技能库']
  const paths = {
    问答: '/draft/',
    工作区: '/workspaces',
    部署: '/deployments',
    技能库: '/skills',
    我的电脑: '/devices',
  }
  const current = () => new URL(page.url().split('#')[1] || '/', origin)
  const initialDraftPath = current().pathname
  async function choose(label) {
    const button = nav().locator(`button[aria-label="${label}"]`)
    if (await button.count()) await button.click()
    else {
      await nav()
        .getByRole('button', {
          name: page.viewportSize().width >= 1024 ? '更多功能' : '切换模块',
          exact: true,
        })
        .click()
      await page.getByRole('option', { name: label, exact: true }).click()
    }
    await page.waitForURL((url) =>
      new URL(url.hash.slice(1), origin).pathname.startsWith(paths[label]),
    )
    await page.locator('main[data-slot="sidebar-inset"]').waitFor()
  }
  async function measure(name) {
    const data = await nav().evaluate((element) => {
      const box = (el) => {
        const r = el.getBoundingClientRect()
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          right: r.right,
          bottom: r.bottom,
        }
      }
      const buttons = [...element.querySelectorAll('button')].filter(
        (el) => el.getBoundingClientRect().width > 0,
      )
      return {
        viewport: innerWidth,
        header: box(element),
        scroll: element.scrollWidth,
        controls: buttons.map((el) => ({ label: el.getAttribute('aria-label'), ...box(el) })),
        project: box(element.querySelector('[aria-label="切换项目"]')),
      }
    })
    assert.equal(data.header.height, 52)
    assert(data.scroll <= data.header.width + 1, '顶栏不能横向溢出')
    for (const control of data.controls)
      assert(
        control.x >= 0 &&
          control.right <= data.viewport + 1 &&
          control.y >= 0 &&
          control.bottom <= 53,
        '顶栏按钮必须完整可见：' + control.label,
      )
    if (data.viewport >= 1024) {
      assert(data.project.width <= 208, '项目选择器应收紧')
      const skills = data.controls.find((c) => c.label === '技能库'),
        more = data.controls.find((c) => c.label === '更多功能')
      if (more) assert(more.x - skills.right < 24, '更多入口应紧邻常用模块')
    }
    report.geometry.push({ name, ...data })
  }
  await run('四个常用模块直接切换并保留原草稿', async () => {
    for (const label of labels) {
      await choose(label)
      assert.equal(await nav().locator('[aria-current="page"]').getAttribute('aria-label'), label)
    }
    await choose('问答')
    assert.equal(current().pathname, initialDraftPath)
    await measure('desktop-light')
    await screenshot('topbar-desktop-light')
  })
  await run('项目切换保留模块且前进后退与刷新一致', async () => {
    await choose('工作区')
    for (const id of projectIds.slice(0, 2)) {
      await nav().getByRole('button', { name: '切换项目', exact: true }).click()
      await page
        .getByRole('option', { name: host.projects.find((p) => p.id === id).name, exact: true })
        .click()
      await page.waitForURL(
        (url) => new URL(url.hash.slice(1), origin).searchParams.get('projectId') === id,
      )
      assert.equal(current().pathname, '/workspaces')
    }
    const expected = current().href
    await page.reload()
    await nav().waitFor()
    assert.equal(current().href, expected)
    await page.goBack()
    await nav().waitFor()
    await page.goForward()
    await nav().waitFor()
    assert.equal(current().href, expected)
  })
  await run('更多仅保留低频模块且空集合不显示', async () => {
    const more = nav().getByRole('button', { name: '更多功能', exact: true })
    assert.equal(await more.count(), host.customerAgentsEnabled ? 1 : 0)
    if (!host.customerAgentsEnabled) return
    await more.click()
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['我的电脑'])
    await page.keyboard.press('Escape')
    await page.waitForFunction((el) => document.activeElement === el, await more.elementHandle())
    await choose('我的电脑')
    assert.match(await more.innerText(), /我的电脑/)
  })
  await run('设置外观归档与退出保留侧栏入口', async () => {
    await openSettingsPage('常规设置')
    assert.equal(current().pathname, '/settings/general')
    await openSettingsPage('归档对话')
    assert.equal(current().pathname, '/settings/archived')
    assert.equal(await page.getByRole('button', { name: /^退出登录/ }).count(), 1)
    await openSettingsPage('外观设置')
    await page
      .getByRole('group', { name: '外观模式', exact: true })
      .getByRole('button', { name: '使用深色模式', exact: true })
      .click()
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
  })
  for (const mode of ['dark', 'light'])
    await run('主题与视口导航：' + mode, async () => {
      if (mode === 'light') {
        await page.setViewportSize({ width: 1440, height: 900 })
        await openSettingsPage('外观设置')
        await page.getByRole('button', { name: '使用浅色模式', exact: true }).click()
        await page.waitForFunction(() => !document.documentElement.classList.contains('dark'))
      }
      for (const viewport of [
        { width: 1440, height: 600 },
        { width: 1024, height: 700 },
        { width: 900, height: 700 },
        { width: 390, height: 844 },
        { width: 390, height: 480 },
        { width: 320, height: 568 },
      ]) {
        await page.setViewportSize(viewport)
        for (const label of labels) await choose(label)
        await measure(`${mode}-${viewport.width}-${viewport.height}`)
        if (viewport.width < 1024) {
          const trigger = nav().getByRole('button', { name: '切换模块', exact: true })
          await trigger.click()
          for (const label of labels)
            assert.equal(await page.getByRole('option', { name: label, exact: true }).count(), 1)
          for (const label of ['常规设置', '外观设置', '归档对话', '退出登录'])
            assert.equal(await page.getByRole('option', { name: label, exact: true }).count(), 0)
          await page.keyboard.press('Escape')
          await page.waitForFunction(
            (el) => document.activeElement === el,
            await trigger.elementHandle(),
          )
        }
        await screenshot(`topbar-${mode}-${viewport.width}-${viewport.height}`)
      }
    })
  await run('长项目名称省略与项目弹层键盘恢复', async () => {
    const handler = async (route) => {
      const response = await route.fetch(),
        data = await response.json()
      data.projects = data.projects.map((project) => ({
        ...project,
        name: project.name + ' · 长名称用于验证导航宽度与省略'.repeat(6),
      }))
      await route.fulfill({ response, json: data })
    }
    await page.route('**/api/agent-demo/t3/autoops/bootstrap', handler)
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.reload()
      await nav().waitFor()
      await measure('long-project-name')
      const trigger = nav().getByRole('button', { name: '切换项目', exact: true })
      await trigger.press('Enter')
      const search = page
        .getByRole('combobox', { name: '搜索项目', exact: true })
        .filter({ visible: true })
      await search.waitFor()
      await search.fill(host.projects[0].name)
      assert.equal(await page.getByRole('option').count(), 1)
      await search.press('ArrowDown')
      await page.keyboard.press('Escape')
      await page.waitForFunction(
        (el) => document.activeElement === el,
        await trigger.elementHandle(),
      )
      await screenshot('topbar-long-project-name')
      await page.setViewportSize({ width: 390, height: 480 })
      await measure('long-project-name-narrow')
      await screenshot('topbar-long-project-name-narrow')
    } finally {
      await page.unroute('**/api/agent-demo/t3/autoops/bootstrap', handler)
    }
    report.longNameFixture = '仅在隔离浏览器替换项目显示名称，未写服务端项目资料'
  })
}

async function openArea(area) {
  if (['常规设置', '外观设置', '归档对话'].includes(area)) return openSettingsPage(area)
  const common = nav().locator(`button[aria-label="${area}"]`)
  if (['问答', '工作区', '部署', '技能库'].includes(area) && (await common.count()))
    await common.click()
  else {
    await nav()
      .getByRole('button', { name: /^(更多功能|切换模块)$/ })
      .click()
    await page
      .getByRole('combobox', { name: '搜索功能', exact: true })
      .filter({ visible: true })
      .fill(area)
    await page.getByRole('option', { name: area, exact: true }).click()
  }
  await page.waitForFunction(
    () => !document.querySelector('main')?.innerText.includes('正在加载页面'),
  )
  if (area === '工作区') {
    await page.locator('[data-readonly-workspace]').waitFor({ timeout: 60000 })
    await page
      .locator('[data-readonly-workspace]')
      .getByRole('treeitem')
      .first()
      .waitFor({ timeout: 60000 })
  }
  if (area === '部署') {
    await page.getByTestId('deployments-page').waitFor()
    if (await page.getByRole('heading', { name: '源码包', exact: true }).count()) {
      if (!(await sidebar().isVisible()))
        await nav().getByRole('button', { name: '切换主侧栏', exact: true }).click()
      await sidebar().getByRole('button', { name: '服务发布', exact: true }).click()
    }

    await page.getByLabel('部署详情', { exact: true }).waitFor({ timeout: 60000 })
    await page
      .locator('pre[aria-label="部署增量日志"]')
      .filter({ visible: true })
      .getByText('前端发布失败', { exact: false })
      .first()
      .waitFor({ timeout: 60000 })
      .catch(async () => {
        if (!(await page.locator('pre[aria-label="部署增量日志"] span').count()))
          throw new Error('部署日志应实际加载')
      })
  }
  if (area === '技能库')
    await page.getByLabel('技能列表', { exact: true }).waitFor({ timeout: 60000 })
  if (area === '我的电脑')
    await page.waitForFunction(
      () => !document.querySelector('[data-customer-devices]')?.innerText.includes('正在读取设备'),
    )
  await page.evaluate(() => document.fonts.ready)
}

try {
  await page.goto(`${origin}/agent-demo.html#/draft/${draft}`)
  await page.getByRole('textbox', { name: '用户名' }).fill('admin')
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.AGENT_DEMO_TEST_PASSWORD ?? 'Demo123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByTestId('composer-editor').waitFor({ timeout: 60000 })
  if (topbarOnly) await topbarChecks()
  else {
    await run('问答基准', async () => {
      await geometry('chat')
      await screenshot('01-chat-light')
    })
    const baseline = report.geometry[0]
    for (const [name, area] of [
      ['工作区', 'workspaces'],
      ['部署', 'deployments'],
      ['技能库', 'skills'],
      ['我的电脑', 'devices'],
      ['常规设置', 'settings'],
    ]) {
      await run('跨模块框架：' + name, async () => {
        await openArea(name)
        const frame = await geometry(area)
        assert.equal(frame.main.x, baseline.main.x)
        assert.equal(frame.sidebar.width, baseline.sidebar.width)
        if (area === 'workspaces')
          await page.getByLabel('搜索工作区版本', { exact: true }).waitFor()
        if (area === 'deployments') await page.getByLabel('搜索服务', { exact: true }).waitFor()
        await screenshot(`02-${area}-light`)
      })
    }
    await run('折叠偏好跨模块保持并可刷新恢复', async () => {
      await nav().getByRole('button', { name: '切换主侧栏', exact: true }).click()
      for (const area of ['工作区', '部署', '技能库']) {
        await openArea(area)
        await page.waitForFunction(
          () => document.querySelector('main')?.getBoundingClientRect().x < 2,
        )
      }
      await page.reload()
      await nav().waitFor()
      await page.waitForFunction(
        () => document.querySelector('main')?.getBoundingClientRect().x < 2,
      )
      await nav().getByRole('button', { name: '切换主侧栏', exact: true }).click()
    })
    await run('部署配置、发布确认与源码包切换', async () => {
      await openArea('部署')
      await page.locator('[aria-label="部署详情分类"] button').filter({ hasText: /配置/ }).click()
      await page.getByText('站点检查地址', { exact: true }).waitFor()
      const publish = page.getByRole('button', { name: '发布', exact: true })
      await publish.click()
      await page.getByRole('dialog', { name: '确认发布', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: '确认发布', exact: true }).waitFor({ state: 'hidden' })
      await page.waitForFunction(
        (element) => element === document.activeElement,
        await publish.elementHandle(),
        { timeout: 5000 },
      )
      await sidebar().getByRole('button', { name: '源码包', exact: true }).click()
      await page.getByLabel('交付清单预览', { exact: true }).waitFor()
      await page
        .getByLabel('交付清单预览', { exact: true })
        .locator('diffs-container')
        .waitFor({ timeout: 60000 })
      await geometry('packages')
      await screenshot('03-packages-light')
    })
    await run('深色主题跨模块一致', async () => {
      await openArea('外观设置')
      await page
        .getByRole('group', { name: '外观模式', exact: true })
        .getByRole('button', { name: '使用深色模式', exact: true })
        .click()
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
      for (const [name, area] of [
        ['工作区', 'workspaces'],
        ['部署', 'deployments'],
        ['技能库', 'skills'],
        ['我的电脑', 'devices'],
      ]) {
        await openArea(name)
        const frame = await geometry(area)
        assert.equal(frame.main.x, baseline.main.x)
        await screenshot('04-' + area + '-dark')
      }
      await page.goto(`${origin}/agent-demo.html#/deployments?projectId=p-autoops`)
      await sidebar().getByRole('button', { name: '服务发布', exact: true }).click()
      await page.getByLabel('部署详情', { exact: true }).waitFor()
      await geometry('deployments')
      await screenshot('04-deployments-dark')
    })
    await run('短窗口与窄屏公共抽屉及实际点击', async () => {
      await page.setViewportSize({ width: 1440, height: 600 })
      await geometry('deployments')
      await screenshot('05-deployments-short')
      await page.setViewportSize({ width: 390, height: 844 })
      for (const [name, area] of [
        ['工作区', 'workspaces'],
        ['部署', 'deployments'],
        ['技能库', 'skills'],
        ['我的电脑', 'devices'],
      ]) {
        await openArea(name)
        const frame = await geometry(area)
        assert.equal(frame.main.x, 0)
        await nav().getByRole('button', { name: '切换主侧栏', exact: true }).click()
        await sidebar().waitFor()
        const box = await sidebar().boundingBox()
        assert(box && box.y >= 52 && box.x >= 0 && box.width <= 390)
        await screenshot('06-' + area + '-mobile-sidebar')
        await page.keyboard.press('Escape')
        await sidebar().waitFor({ state: 'hidden' })
        for (const button of await page.locator('main header button').all()) {
          if (!(await button.isVisible())) continue
          const hit = await button.evaluate((element) => {
            const r = element.getBoundingClientRect()
            const center = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
            return (
              r.x >= 0 &&
              r.right <= innerWidth &&
              r.y >= 52 &&
              !!center &&
              (center === element || element.contains(center))
            )
          })
          assert(hit, '窄屏头部按钮应完整可见且实际可点击')
        }
        await screenshot('06-' + area + '-mobile')
      }
    })
  }
  assert.equal(report.errors.length, 0, report.errors.join('\n'))
  assert.equal(report.blockedWrites.length, 0, '框架切换不应发起业务写入')
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
