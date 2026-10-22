import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

// Invoke this script through the authorized browser-test command, never inside a restricted launcher.
const origin = (process.env.BASE_URL || process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').replace(/\/$/, '')
if (new URL(origin).port === '8787' && process.env.T3_PRODUCTION_SMOKE !== '1') throw new Error('正式入口验收需要显式设置 T3_PRODUCTION_SMOKE=1。')
const output = path.resolve(process.env.ARTIFACT_DIR || '.test-artifacts/t3-workspace-files/stage')
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.BROWSER_EXECUTABLE_PATH
await mkdir(output, { recursive: true })
const report = { origin, startedAt: new Date().toISOString(), cases: [], pageErrors: [], messageDispatches: 0, filesystemWrites: 0, cleanup: {} }
const sessions = []
let page, admin, guest, projectId, internal, external, workspaceBase

async function until(read, message, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(message)
}
async function run(name, action) {
  if (process.env.T3_WORKSPACE_UI_FOCUS === 'chat' && ['native-tree-search-and-readonly-preview','pending-binary-native-preview-and-publish'].includes(name)) return
  const result = { name }
  report.cases.push(result)
  try { result.result = await action(); result.status = 'passed' }
  catch (error) { result.status = 'failed'; result.error = error.stack; if(page) await writeFile(path.join(output, name + '-dom.txt'), await page.locator('body').innerText()); await page?.screenshot({ path: path.join(output, name + '-failed.png') }).catch(() => {}); throw error }
  finally { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ name, status: result.status, error: result.error })) }
}
async function login(username) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'autoops-workspace-files-'))
  const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1440, height: 900 }, locale: 'zh-CN', ...(executablePath ? { executablePath } : {}) })
  const target = context.pages()[0] || await context.newPage(), ownedThreads = new Set()
  page = target
  target.on('console', message => { if (message.type() === 'error') { report.consoleErrors ??= []; report.consoleErrors.push(message.text()) } })
  target.setDefaultTimeout(15000)
  target.on('pageerror', (error) => report.pageErrors.push(error.message))
  target.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
    try { const decoded = JSON.parse(String(payload)); for (const message of Array.isArray(decoded) ? decoded : [decoded]) if (['projects.listEntries','projects.searchEntries','filesystem.getMetadata'].includes(message.tag)) { report.fileRpcRequests ??= []; report.fileRpcRequests.push({ method:message.tag, payload:message.payload }) } } catch {}
    if (String(payload).includes('"message.dispatch"')) report.messageDispatches++
    if (/"(?:projects|filesystem)\.(?:writeFile|createDirectory|remove|rename)"/.test(String(payload))) report.filesystemWrites++
  }))
  target.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/autoops/thread-bindings')) {
      try { const input = request.postDataJSON(); if (typeof input.threadId === 'string') ownedThreads.add(input.threadId) } catch {}
    }
  })
  const session = { context, page: target, profile, ownedThreads, username }
  sessions.push(session)
  await target.goto(origin + '/agent-demo.html#/draft/' + randomUUID())
  await target.getByRole('textbox', { name: '用户名' }).fill(username)
  await target.getByLabel('密码', { exact: true }).fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
  await target.getByRole('button', { name: '登录', exact: true }).click()
  await target.getByTestId('composer-editor').waitFor({ timeout: 60000 })
  const response = await target.request.get(origin + '/api/agent-demo/t3/autoops/bootstrap')
  assert.equal(response.status(), 200)
  session.bootstrap = await response.json()
  session.initialDark = await target.evaluate(() => document.documentElement.classList.contains('dark'))
  return session
}
async function request(suffix = '', body) {
  const response = await page.request.fetch(origin + workspaceBase + suffix, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'x-t3-orchestration-protocol': '2', 'content-type': 'application/json', 'x-demo-csrf': admin.bootstrap.csrfToken },
    ...(body === undefined ? {} : { data: body }),
  })
  const value = await response.json()
  assert(response.ok(), `管理接口失败 ${response.status()}: ${JSON.stringify(value)}`)
  return value
}
async function finish(task) {
  return until(async () => {
    const state = await request(), current = state.tasks.find((entry) => entry.id === task.id)
    if (['failed', 'interrupted'].includes(current?.status)) throw new Error(current.error || current.message)
    return current?.status === 'completed' ? { state, task: current } : null
  }, '平台工作区任务没有完成', 120000)
}
const tab = (name) => page.locator('[aria-label="工作区分类"]').getByText(name, { exact: true })
async function choose(label, text) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option').filter({ hasText: text }).first().click()
}
async function management(type = 'internal', version = internal) {
  await page.goto(origin + '/agent-demo.html#/workspaces')
  await page.getByRole('combobox', { name: '工作区项目', exact: true }).waitFor({ timeout: 60000 })
  const project = admin.bootstrap.projects.find((entry) => entry.id === projectId)
  if (projectId !== admin.bootstrap.projects[0].id) await choose('工作区项目', project.name)
  await tab(type === 'external' ? '外部工作区' : '内部工作区').click()
  const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === workspaceBase)
  await page.getByRole('button', { name: '刷新工作区', exact: true }).click()
  await refreshed
  await choose(type === 'internal' ? '内部版本' : '外部版本', version.name)
  await page.locator('[data-file-browser-panel]').waitFor()
}
const surface = () => page.locator('[data-readonly-workspace]').first()
const row = (name) => surface().locator(`[role="treeitem"][data-item-path=${JSON.stringify(name)}], [role="treeitem"][data-item-path=${JSON.stringify(name + '/')} ]`).first()
async function expand(directory) {
  const item = row(directory)
  await item.waitFor()
  if (await item.getAttribute('aria-expanded') !== 'true') { await item.focus(); await item.press('ArrowRight') }
}
async function sourceContains(text) {
  return surface().evaluate((element, text) => {
    function read(root) {
      let content = root.textContent || ''
      for (const child of root.querySelectorAll('*')) if (child.shadowRoot) content += read(child.shadowRoot)
      return content
    }
    return read(element).includes(text)
  }, text)
}
async function noOverflow() {
  const result = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
  assert(result.content <= result.width + 1, `横向溢出 ${JSON.stringify(result)}`)
  return result
}
const shot = (name) => page.screenshot({ path: path.join(output, `${name}.png`) })

try {
  await run('admin-isolated-session', async () => {
    admin = await login('admin'); page = admin.page
    const project = admin.bootstrap.projects.find((entry) => entry.membership?.workspaceAccess === 'internal' && entry.membership.role === 'manager')
    assert(project, '管理员需要明确的内部项目管理员授权')
    projectId = project.id
    workspaceBase = `${admin.bootstrap.gatewayBasePath}/autoops/projects/${projectId}/workspaces`
    const state = await request()
    internal = state.internalVersions.find((entry) => entry.isExample && entry.status === 'published')
    external = state.externalVersions.find((entry) => entry.isExample && entry.status === 'published' && entry.sourceVersionId === internal?.id)
    assert(internal, '只测试明确标识的示例，不使用用户原始资料')
    return { projectId, internalVersionId: internal.id, noMessageSent: true }
  })
  await run('native-tree-search-and-readonly-preview', async () => {
    await management()
    await row('frontend').waitFor()
    await row('backend').waitFor()
    await row('docs').waitFor()
    assert.equal(await surface().locator('[role="treeitem"][data-item-path^="autoops/"]').count(), 0)
    await expand('frontend')
    await row('frontend/package.json').click()
    await until(() => sourceContains('autoops-workspace-example-frontend'), '原生高亮预览没有显示实际源码')
    assert.equal(await surface().locator('[contenteditable="true"], textarea').count(), 0)
    assert.equal(await surface().getByRole('button', { name: '添加到对话', exact: true }).count(), 0, '管理页不隐式引用到其他对话')
    const search = surface().getByRole('searchbox')
    await search.fill('server.mjs')
    await row('backend/server.mjs').waitFor()
    await row('backend/server.mjs').click()
    await until(() => sourceContains('createServer'), '搜索选中文件后没有使用同屏预览')
    await search.press('Escape')
    await shot('native-tree-source-desktop')
    return { nativePierreTree: true, relativeRoot: true, sameSurfacePreview: true, search: true, readonly: true, bounds: await noOverflow() }
  })
  await run('pending-binary-native-preview-and-publish', async () => {
    const existing = (await request()).externalVersions.find((entry) => entry.isExample && entry.sourceVersionId === internal.id && entry.status === 'pending_review')
    if (existing) external = existing
    else { const completed = await finish(await request('/external', { sourceVersionId: internal.id, rules: [], requestId: 'files-ui-' + randomUUID() })); external = completed.state.externalVersions.find((entry) => entry.id === completed.task.versionId) }
    assert.equal(external.status, 'pending_review')
    await management('external', external)
    await surface().getByRole('searchbox').fill('示例图片.png')
    await row('prototypes/示例图片.png').click()
    await until(() => surface().getByRole('img', { name: '示例图片.png', exact: true }).evaluate((image) => image.complete && image.naturalWidth > 0), '待复核图片没有使用原生图片预览')
    assert(await page.getByRole('button', { name: '确认并发布版本', exact: true }).isDisabled())
    await shot('pending-image-native-preview')
    await surface().getByRole('searchbox').fill('页面原型.html')
    await row('prototypes/页面原型.html').click()
    await surface().frameLocator('iframe[title="页面原型.html"]').getByRole('heading', { name: '项目工作区', exact: true }).waitFor()
    await surface().getByLabel('显示 HTML 源码', { exact: true }).click()
    await until(() => sourceContains('<!doctype html>'), '原生切换未显示实际 HTML 源码')
    await surface().getByLabel('显示页面预览', { exact: true }).click()
    await surface().frameLocator('iframe[title="页面原型.html"]').getByRole('heading', { name: '项目工作区', exact: true }).waitFor()
    await shot('pending-html-native-preview')
    for (const pending of external.report.pendingFiles) await choose(`复核 ${pending.path}`, '排除文件')
    await page.getByRole('button', { name: '确认并发布版本', exact: true }).click()
    external = await until(async () => (await request()).externalVersions.find((entry) => entry.id === external.id && entry.status === 'published'), '人工复核后没有发布外部版本')
    return { versionId: external.id, binaryPreview: true, sandboxedHtmlPreview: true, pendingBeforeConfirmation: true, publishedAfterExplicitReview: true }
  })
  await run('chat-tree-preview-and-explicit-reference', async () => {
    await management('internal', internal)
    await page.locator('button[data-ui="button"]').filter({ hasText: '新建对话' }).click()
    const editor = page.getByTestId('composer-editor')
    await editor.waitFor({ timeout: 60000 })
    await until(async () => (await page.getByRole('button', { name: '对话工作区', exact: true }).getAttribute('aria-description'))?.includes(internal.name), '新草稿没有固定内部版本')
    await page.getByLabel('切换右侧面板', { exact: true }).click()
    await surface().waitFor()
    await expand('frontend')
    await row('frontend/package.json').click()
    await until(() => sourceContains('autoops-workspace-example-frontend'), '对话文件预览未完成')
    assert.equal((await editor.innerText()).trim(), '', '单击预览不能自动引用或发送')
    await surface().getByRole('button', { name: '添加到对话', exact: true }).click()
    await until(async () => (await editor.innerText()).trim().length > 0, '明确添加后没有插入资料引用')
    assert((await editor.innerHTML()).includes(internal.id), '引用保持固定版本的canonical身份')
    await editor.fill('@frontend/package')
    const suggestions = page.locator('[data-composer-command-drawer="true"]')
    await suggestions.waitFor()
    await page.getByRole('listbox', { name: '文件与文件夹', exact: true }).waitFor()
    assert(!(await suggestions.innerText()).includes('autoops/'), '候选应显示项目相对目录')
    await suggestions.locator('[data-composer-item-id]').filter({ hasText: 'package.json' }).first().click()
    assert((await editor.innerHTML()).includes(internal.id), '@选择必须保持固定输入版本')
    await shot('chat-readonly-tree-and-reference')
    await editor.fill('')
    return { previewWithoutReference: true, explicitAdd: true, explicitAtReference: true, fixedVersionId: internal.id, noMessageSent: true, bounds: await noOverflow() }
  })
  await run('composer-boundaries-and-real-first-acceptance', async () => {
    const editor = page.getByTestId('composer-editor')
    const oldUrl = page.url(), text = '内部合成草稿：不要带入外部工作区。'
    await editor.fill(text)
    await page.getByRole('button', { name: '对话工作区', exact: true }).click()
    await page.getByRole('menuitemradio').filter({ hasText: external.name }).click()
    await until(() => page.url() !== oldUrl, '切换资料范围没有创建新草稿')
    const cleanUrl = page.url()
    assert.equal((await editor.innerText()).trim(), '')
    assert(!(await editor.innerHTML()).includes(internal.id), '内部引用不可带到外部')
    await page.goto(oldUrl)
    await until(async () => (await editor.innerText()).includes(text), '旧草稿没有保留')
    await page.goto(cleanUrl)
    await until(async () => (await page.getByRole('button', { name: '对话工作区', exact: true }).getAttribute('aria-description'))?.includes(external.name), '新草稿外部版本未保存')
    await page.getByRole('button', { name: '业务环境', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '生产环境', exact: true }).click()
    assert.equal(page.url(), cleanUrl, '空草稿应原地选择环境')
    await page.getByRole('button', { name: '会话可见范围', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '项目共享', exact: true }).click()
    const client = new T3LiveClient(origin)
    client.cookie = (await admin.context.cookies(origin)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    client.bootstrap = admin.bootstrap
    try {
      await editor.fill('请实际调用资料工具读取固定外部工作区 WORKSPACE.md，用两句话说明工作区类型和项目名称，不生成文件。这是合成示例。')
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await until(() => !new URL(page.url()).hash.startsWith('#/draft/'), '真实消息没有被原生服务接受', 60000)
      const threadId = new URL(page.url()).hash.split('/')[2]
      assert(threadId); admin.ownedThreads.add(threadId)
      await until(async () => (await page.locator('[data-autoops-scope-locked="true"]').count()) === 4, '首条消息接受后范围未锁定')
      const binding = (await client.http('/autoops/thread-bindings/' + threadId)).binding
      assert.equal(binding.workspaceVersionId, external.id); assert.equal(binding.environmentId, 'env-prod'); assert.equal(binding.visibility, 'project'); assert.equal(binding.scopeState, 'locked')
      const projection = await until(async () => { const value = (await client.http('/api/orchestration/threads/' + threadId)).projection; const run = value.runs.at(-1); return run && ['completed','failed','interrupted','cancelled'].includes(run.status) ? value : null }, '真实问答未完成', 180000)
      assert.equal(projection.runs.at(-1).status, 'completed')
      assert(projection.turnItems.some((item) => item.type === 'dynamic_tool' && item.status === 'completed' && /read_project_document|read_project_material/.test(item.toolName)), '必须实际读取项目文件')
      await shot('composer-real-accepted-locked')
      await page.setViewportSize({ width: 390, height: 844 })
      await noOverflow()
      await shot('composer-real-accepted-locked-390')
      await page.setViewportSize({ width: 1440, height: 900 })
      await writeFile(path.join(output, 'synthetic-real-projection.json'), JSON.stringify({ binding, projection }, null, 2))
      return { dirtyDraftPreserved: true, cleanExternalDraft: true, contextControlsNativeMenu: true, realFirstMessageAccepted: true, scopeLocked: true, versionId: external.id, environmentId: 'env-prod', visibility: 'project', bounds: await noOverflow() }
    } finally { client.close() }
  })
  await run('dark-390-directory-to-file-and-keyboard', async () => {
    await page.goto(origin + '/agent-demo.html#/settings/appearance')
    await page.getByRole('button', { name: '使用深色模式', exact: true }).click()
    admin.themeChanged = true
    await page.setViewportSize({ width: 390, height: 844 })
    await management()
    await row('WORKSPACE.md').click()
    await until(() => sourceContains('最小示例'), '窄屏文件没有打开')
    assert.equal(await surface().locator('[data-file-browser-panel]:visible').count(), 0, '窄屏文件正文与目录不得挤成三栏')
    await shot('readonly-dark-390-file')
    await surface().getByLabel('返回文件目录', { exact: true }).click()
    await row('frontend').waitFor()
    const first = surface().getByRole('treeitem').first()
    await first.focus(); await first.press('ArrowDown')
    const treeFocus = await surface().evaluate((element) => {
      let active = document.activeElement
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
      return active?.getAttribute('role') === 'treeitem'
    })
    assert(treeFocus, '原生文件树方向键应保留树项焦点')
    await shot('readonly-dark-390-directory')
    const bounds = await noOverflow()
    await page.goto(origin + '/agent-demo.html#/settings/appearance')
    await page.getByRole('button', { name: admin.initialDark ? '使用深色模式' : '使用浅色模式', exact: true }).click()
    admin.themeChanged = false
    return { mobileDirectoryNavigation: true, nativeTreeKeyboard: true, darkMode: true, bounds }
  })
  await run('guest-only-published-external-files', async () => {
    guest = await login('guest'); page = guest.page
    const project = guest.bootstrap.projects.find((entry) => entry.id === projectId)
    assert.equal(project?.membership?.workspaceAccess, 'external')
    await page.goto(origin + '/agent-demo.html#/workspaces')
    await tab('外部工作区').waitFor({ timeout: 60000 })
    for (const label of ['内部工作区', '部署发布']) assert.equal(await tab(label).count(), 0)
    for (const label of ['导入仓库', '生成外部版本', '生成部署包', '确认并发布版本']) assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0)
    await choose('外部版本', external.name)
    await surface().getByRole('searchbox').fill('需求说明.md')
    await row('docs/需求说明.md').click()
    await until(() => sourceContains('内部地址已脱敏'), '外部成员没有读取已脱敏的固定资料')
    assert.equal(await surface().locator('[role="treeitem"][data-item-path*=".git/"]').count(), 0)
    await shot('guest-external-native-preview')
    return { externalOnly: true, noManagementControls: true, publishedVersionId: external.id, redactedFiles: true, bounds: await noOverflow() }
  })
  assert.deepEqual(report.pageErrors, [])
  assert(!(report.consoleErrors || []).some((message) => /Error:|React error/.test(message)), '控制台不能存在组件或预览错误')
  assert.equal(report.messageDispatches, 0, '本次UI首条消息应走原生launch，不能意外重复dispatch')
  assert.equal(report.filesystemWrites, 0, '只读文件预览不得发送文件写入命令')
} catch (error) { report.fatal = error.stack; process.exitCode = 1 }
finally {
  for (const session of sessions) {
    if (session.themeChanged) {
      await session.page.goto(origin + '/agent-demo.html#/settings/appearance').then(() => session.page.getByRole('button', { name: session.initialDark ? '使用深色模式' : '使用浅色模式', exact: true }).click()).catch((error) => { report.cleanup.themeRestoreError = error.message; process.exitCode = 1 })
    }
    if (session.bootstrap && session.ownedThreads.size) {
      const client = new T3LiveClient(origin)
      try {
        client.cookie = (await session.context.cookies(origin)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
        client.bootstrap = session.bootstrap
        await client.connect()
        for (const threadId of session.ownedThreads) await client.rpc('orchestration.dispatchCommand', { type: 'thread.delete', threadId, commandId: randomUUID() })
        report.cleanup[session.username] = { deletedOwnedThreads: [...session.ownedThreads] }
      } catch (error) { report.cleanup[session.username] = { error: error.message }; process.exitCode = 1 }
      finally { client.close() }
    }
    await session.context.close().catch((error) => { report.cleanup.browserError = error.message })
    await rm(session.profile, { recursive: true, force: true })
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
