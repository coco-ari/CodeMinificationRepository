import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {chromium} from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'

// Run only through the caller's explicit browser-launch approval. This file
// never provisions resources, changes source files or talks to a model. The
// optional UI publish targets an already provisioned isolated validation site.
const base = new URL(process.env.BASE_URL || 'http://192.168.31.157:28887')
assert(['http:', 'https:'].includes(base.protocol) && base.port === '28887', '仅允许独立部署验证端口 28887，禁止正式/验收入口')
assert(['192.168.31.157', '172.29.22.6', '127.0.0.1', 'localhost'].includes(base.hostname), '只能访问已授权的部署验证主机')
assert(!base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'BASE_URL 必须为无凭据的验证源站')
const origin = base.origin, projectId = 'p-autoops', environmentId = 'env-test', targetName = '前端部署验证'
const live = process.env.LIVE_PUBLISH === '1' && process.env.UI_READONLY !== '1'
const api = `/api/agent-demo/t3/autoops/projects/${projectId}`
const artifactRoot = path.resolve('.test-artifacts/deployment-validation')
const output = path.resolve(process.env.ARTIFACT_DIR || path.join(artifactRoot, `ui-${Date.now()}`))
assert(output.startsWith(artifactRoot + path.sep), '截图与报告只能写入本 worktree 的部署验证证据目录')
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.BROWSER_EXECUTABLE_PATH
const password = process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!'
await mkdir(output, {recursive:true})
const report = {origin, projectId, environmentId, targetName, livePublish:live, startedAt:new Date().toISOString(), cases:[], geometry:[],
  blockedRpcMutations:[], blockedHttpMutations:[], permittedNativeMaintenance:{}, pageErrors:[], allowedDeployments:[], observedTaskReads:[], browserDownloads:[],
  localToastDismissals:{closed:0, expiredDuringClick:0, exitAnimationWaits:0}, suppressedTelemetry:0,
  coverage:{existingThreadsActivated:false, modelCalls:0, filesystemWrites:0, syntheticLogs:false, longLogOverflow:false, streamingReadPosition:false, browser:'Chromium 桌面及触屏模拟，不等同于物理手机或 Windows 实机'}, cleanup:{}}
const sessions = []
let page, fixture, selectedTaskId, publishArmed = false, acceptedRequestId
function redact(value) { return String(value).replaceAll(password, '[已隐藏]').replace(/(Bearer\s+)[A-Za-z0-9_.-]+/gi, '$1[已隐藏]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[已隐藏]@') }
async function flush() { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)) }
async function until(read, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(done => setTimeout(done, 100)) }
  throw new Error(label)
}
async function run(name, action) {
  const entry = {name}; report.cases.push(entry)
  try { entry.result = await action(); entry.status = 'passed' }
  catch (error) { entry.status = 'failed'; entry.error = redact(error.stack || error.message); if (page) await screenshot(`${name}-failed`).catch(() => {}); throw error }
  finally { await flush(); console.log(JSON.stringify({case:name, status:entry.status, error:entry.error})) }
}
function assertSafeUrl() {
  const url = new URL(page.url())
  assert.equal(url.origin, origin)
  assert(/^#\/(?:draft\/[^/]+|(?:workspaces|deployments)(?:\?.*)?|settings\/appearance)$/.test(url.hash), '禁止激活任何已存在对话')
}
const panel = () => page.locator('[aria-label="服务发布"]').filter({visible:true})
const details = () => page.locator('[aria-label="部署详情"]').filter({visible:true})
const log = () => page.locator('pre[aria-label="部署增量日志"]').filter({visible:true})
const viewport = () => log().locator('xpath=ancestor::*[@data-slot="scroll-area-viewport"][1]')
const group = label => page.getByRole('group', {name:label, exact:true})
// T3's compatibility layer renders Radix ToggleGroup items with its stable
// data-slot; single selection may expose radio semantics instead of button.
const toggle = (groupLabel, label) => page.locator(`[aria-label="${groupLabel}"] [data-slot="toggle"]`).filter({hasText:label})
async function screenshot(name) {
  assertSafeUrl()
  await page.screenshot({path:path.join(output, `${name}.png`)})
}
function rpcMutation(method, payload = {}) {
  if (!method || !method.includes('.')) return false // Effect transport control frames.
  if (method.startsWith('orchestration.')) return !/^orchestration\.(?:get|list|subscribe)/.test(method)
  // Audited native handlers: preview/ServerBrowser.ts reportProfiles updates
  // only an in-memory browser-capability list; ws.ts assetsCreateUrl signs an
  // authorized resource URL. Neither persists a workspace or starts a turn.
  if (method === 'preview.reportProfiles' || method === 'assets.createUrl') return false
  // ws.ts serverRefreshProviders + AutoOps rpc-policy authorize a background
  // provider/workspace snapshot refresh. Explicit refreshModels is excluded:
  // that separate path rediscovers models and invalidates provider caches.
  if (method === 'server.refreshProviders') return !payload || typeof payload !== 'object' || Array.isArray(payload) ||
    Object.keys(payload).some(key => !['instanceId','cwd','fresh'].includes(key)) ||
    (payload.instanceId !== undefined && payload.instanceId !== 'codex') ||
    (payload.fresh !== undefined && typeof payload.fresh !== 'boolean')
  if (['server.reportClientActivity', 'server.reportHostPowerState'].includes(method)) return false
  return !/\.(?:get|list|read|search|subscribe|observe|browse|stat|probe|resolve|inspect|watch|find|toolInfo|routing|summary|detail|checks|activity|diffFileContents|reviewGuide|linkedThreads)/i.test(method)
}
async function guardContext(context, session) {
  await context.routeWebSocket(url => url.pathname.endsWith('/api/agent-demo/t3/ws'), socket => {
    const server = socket.connectToServer()
    socket.onMessage(payload => {
      let decoded
      try { decoded = JSON.parse(String(payload)) } catch { server.send(payload); return }
      const messages = Array.isArray(decoded) ? decoded : [decoded], allowed = []
      for (const message of messages) {
        const method = message.tag || ''
        if (rpcMutation(method, message.payload)) report.blockedRpcMutations.push({session:session.name, method, type:message.payload?.type || null})
        else {
          if (['preview.reportProfiles','server.refreshProviders','assets.createUrl'].includes(method)) report.permittedNativeMaintenance[method] = (report.permittedNativeMaintenance[method] || 0) + 1
          allowed.push(message)
        }
      }
      if (allowed.length === messages.length) server.send(payload)
      else if (allowed.length) server.send(JSON.stringify(Array.isArray(decoded) ? allowed : allowed[0]))
    })
  })
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue()
    if (url.origin !== origin) {
      report.blockedHttpMutations.push({session:session.name, method:request.method(), path:'非验证源站请求'})
      return route.abort('blockedbyclient')
    }
    if (['GET','HEAD','OPTIONS'].includes(request.method())) {
      if (url.pathname.startsWith(api + '/deployments')) session.deploymentReads++
      const match = new RegExp(`^${api}/deployments/tasks/([a-f0-9-]{36})$`).exec(url.pathname)
      if (match) report.observedTaskReads.push({session:session.name, taskId:match[1], after:Number(url.searchParams.get('after') || 0)})
      return route.continue()
    }
    if (request.method() === 'POST' && url.pathname === '/api/agent-demo/login') return route.continue()
    if (request.method() === 'POST' && url.pathname.endsWith('/api/observability/v1/traces')) { report.suppressedTelemetry++; return route.fulfill({status:204, body:''}) }
    let body
    try { body = request.postDataJSON() } catch {}
    if (request.method() === 'POST' && url.pathname === api + '/deployments/tasks' && live && publishArmed && session.name === 'desktop-admin' &&
        body?.action === 'deploy' && body.service === 'frontend' && body.targetId === fixture?.target.id && body.packageId === fixture?.package.id && body.configKey === fixture?.target.configKey &&
        /^[a-f0-9-]{36}$/.test(body.requestId || '') && (!acceptedRequestId || acceptedRequestId === body.requestId)) {
      acceptedRequestId = body.requestId
      report.allowedDeployments.push({targetId:body.targetId, packageId:body.packageId, requestId:body.requestId})
      return route.continue()
    }
    report.blockedHttpMutations.push({session:session.name, method:request.method(), path:url.pathname})
    return route.fulfill({status:409, json:{error:'部署验证脚本禁止此写操作。'}})
  })
}
async function dismissToasts() {
  const controls = page.getByRole('button', {name:'关闭通知', exact:true}).filter({visible:true})
  for (let index = 0; index < 8; index++) {
    const count = await controls.count(); if (!count) break
    try { await controls.first().click({timeout:1500}); report.localToastDismissals.closed++ }
    catch (error) {
      if ((error.name === 'TimeoutError' || /not attached|detached/i.test(error.message)) && await controls.count() === 0) { report.localToastDismissals.expiredDuringClick++; break }
      throw error
    }
    await until(async () => await controls.count() < count, '通知关闭后应移除', 2500)
  }
  const notices = page.locator('[data-slot="toast-viewport"] [data-slot="toast-title"], [data-slot="toast-viewport-anchored"] [data-slot="toast-title"], [data-sonner-toast]')
  if (await notices.count()) report.localToastDismissals.exitAnimationWaits++
  await until(async () => await notices.count() === 0, '等待 T3 原生通知退出完成', 5000)
}
async function closeSidebar() {
  const sidebar = page.locator('[data-sidebar="sidebar"]').filter({visible:true}).first()
  if (!await sidebar.isVisible()) return
  if (await sidebar.evaluate(element => !!element.closest('[inert]') || element.getBoundingClientRect().right <= 1)) return
  const toggle = sidebar.locator('[data-sidebar="trigger"]').filter({visible:true}).first()
  if (await toggle.isVisible()) await toggle.click()
  else if (await page.evaluate(() => innerWidth < 768)) await page.keyboard.press('Escape')
  else await page.getByRole('button', {name:'切换主侧栏', exact:true}).filter({visible:true}).first().click()
  await until(async () => !await sidebar.isVisible() || await sidebar.evaluate(element => element.getBoundingClientRect().right <= 1), '折叠原生侧栏，截图不包含历史对话列表')
}
async function login(name, touch = false, username = 'admin') {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'autoops-deployment-ui-'))
  const session = {name, profile, touch, username, deploymentReads:0}; sessions.push(session)
  const context = session.context = await chromium.launchPersistentContext(profile, {headless:true, locale:'zh-CN',
    viewport:touch ? {width:390,height:844} : {width:1440,height:900}, isMobile:touch, hasTouch:touch, ...(executablePath ? {executablePath} : {})})
  await guardContext(context, session)
  page = session.page = context.pages()[0] || await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => report.pageErrors.push({session:name, message:redact(error.message), stack:redact(error.stack || '')}))
  await page.goto(origin + '/agent-demo.html#/draft/' + randomUUID())
  await page.getByRole('textbox', {name:'用户名'}).fill(username)
  await page.getByLabel('密码', {exact:true}).fill(password)
  await page.getByRole('button', {name:'登录',exact:true}).click()
  await page.getByTestId('composer-editor').waitFor({timeout:60000})
  assertSafeUrl(); assert.equal((await page.getByTestId('composer-editor').innerText()).trim(), '')
  const response = await get('/api/agent-demo/t3/autoops/bootstrap')
  session.principalId = response.principal.id
  session.project = response.projects.find(item => item.id === projectId)
  assert(session.project, '验证账号必须获授权访问已有 p-autoops 项目')
  await closeSidebar(); await dismissToasts()
  return session
}
async function get(suffix, expectedStatus = 200) {
  assert(suffix.startsWith('/api/agent-demo/'), '只读 API 必须来自当前验证服务')
  const response = await page.request.get(origin + suffix)
  assert.equal(response.status(), expectedStatus, `验证 API 状态异常：${suffix}`)
  return response.json()
}
async function select(label, text) {
  const trigger = page.getByRole('combobox', {name:label, exact:true})
  await trigger.click(); const option = page.getByRole('option', {name:text, exact:true})
  await option.waitFor(); await option.click()
}
async function workspace(session) {
  await page.goto(origin + '/agent-demo.html#/workspaces?projectId=' + projectId)
  await page.getByTestId('workspace-page').waitFor({timeout:60000})
  await closeSidebar(); await dismissToasts()
  assertSafeUrl()
}
async function openModuleSidebar() {
  const sidebar = page.locator('[data-app-sidebar]').filter({visible:true})
  if (!await sidebar.isVisible() || await sidebar.evaluate(element => element.getBoundingClientRect().right <= 1)) {
    await page.getByTestId('project-area-navigation').getByRole('button', {name:'切换主侧栏',exact:true}).click()
    await until(() => sidebar.evaluate(element => element.getBoundingClientRect().right > 40), '主侧栏应展开到可操作区域')
  }
  return sidebar
}
async function deploymentView(name) {
  const sidebar = await openModuleSidebar()
  await sidebar.getByRole('button', {name,exact:true}).click()
  await closeSidebar()
}
async function services(session) {
  await page.goto(origin + '/agent-demo.html#/deployments?projectId=' + projectId)
  await page.getByTestId('deployments-page').waitFor({timeout:60000})
  await deploymentView('服务发布')
  await dismissToasts()
  await panel().waitFor()
  const sidebar = await openModuleSidebar()
  const environmentLabel = session.project.environments.find(item => item.id === environmentId).name
  const environment = sidebar.getByRole('combobox', {name:'部署环境',exact:true})
  await until(async () => await environment.isEnabled(), '部署环境应读取完成')
  if (!(await environment.innerText()).includes(environmentLabel)) await select('部署环境', environmentLabel)
  const target = sidebar.getByRole('button', {name:new RegExp(targetName)})
  await target.waitFor(); await target.click(); await closeSidebar(); await details().waitFor()
  await toggle('部署详情分类','任务日志').click()
  if (selectedTaskId) {
    const overview = await get(api + '/deployments?environmentId=' + environmentId)
    const tasks = overview.tasks.filter(item => item.targetId === fixture.target.id), index = tasks.findIndex(item => item.id === selectedTaskId)
    assert(index >= 0, '指定任务必须存在于当前授权目标中')
    const choice = page.getByRole('combobox', {name:'部署任务',exact:true}); await choice.waitFor()
    await choice.click(); await page.getByRole('option').nth(index).click()
    await until(async () => {
      const selection = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || 'null'), `autoops:deployments:${session.principalId}:${projectId}:selection`)
      return selection?.taskId === selectedTaskId
    }, '任务选择应与当前目标持久化绑定')
  }
  assertSafeUrl()
}
async function preflight(session) {
  const overview = await get(api + '/deployments?environmentId=' + environmentId)
  assert.equal(overview.enabled, true)
  const matches = overview.targets.filter(item => item.name === targetName && item.environmentId === environmentId)
  assert.equal(matches.length, 1, '应预先建立唯一的测试环境前端部署验证目标')
  const target = matches[0], server = overview.servers.find(item => item.id === target.serverId)
  assert(server?.online && !server.revoked && server.capabilities?.includes('static-site-v1'), '真实部署 Agent 必须已在线且支持静态站点')
  const packages = (await get(api + '/workspaces')).releases
  const normalize = value => !value || value === '.' ? '.' : value.replace(/\/$/, '')
  const compatible = packages.filter(item => item.services.some(entry => entry.service === 'frontend') && normalize(item.manifest?.services?.find(entry => entry.service === 'frontend')?.context?.workingDirectory) === normalize(target.config.module))
  const pack = process.env.UI_PACKAGE_ID ? compatible.find(item => item.id === process.env.UI_PACKAGE_ID) : compatible[0]
  assert(pack, '应预先生成与目标构建目录一致的真实前端固定源码包')
  const task = process.env.UI_TASK_ID ? overview.tasks.find(item => item.id === process.env.UI_TASK_ID && item.targetId === target.id) : overview.tasks.find(item => item.targetId === target.id)
  if (process.env.UI_TASK_ID) assert(task, 'UI_TASK_ID 必须属于本次测试目标与环境')
  if (!live) assert(task, '只读验收需要已有真实任务；请先预置或运行 LIVE_PUBLISH=1')
  if (live) assert(!overview.tasks.some(item => item.targetId === target.id && !['succeeded','failed','rolled_back','interrupted'].includes(item.status)), '存在未完成任务，禁止再提交发布')
  fixture = {target, server, package:pack}; selectedTaskId = task?.id
  report.fixture = {targetId:target.id, serverId:server.id, packageId:pack.id, sourceVersionId:pack.sourceVersionId, frontendSha256:pack.services.find(item => item.service === 'frontend').sha256, initialTaskId:selectedTaskId ?? null}
  return report.fixture
}
async function theme(session, mode) {
  await page.goto(origin + '/agent-demo.html#/settings/appearance')
  await page.getByRole('group', {name:'外观模式',exact:true,includeHidden:true}).waitFor({state:'attached'})
  await closeSidebar()
  await group('外观模式').getByRole('button', {name:mode === 'dark' ? '使用深色模式' : '使用浅色模式',exact:true}).click()
  await until(() => page.evaluate(dark => document.documentElement.classList.contains('dark') === dark, mode === 'dark'), '本地主题选择应生效')
  await services(session)
}
async function bounds(locator) {
  return locator.evaluate(element => {
    const r = element.getBoundingClientRect()
    return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height, viewport:{width:innerWidth,height:innerHeight}, document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}}
  })
}
async function geometry(session, label) {
  const box = await bounds(panel()), detail = await bounds(details())
  for (const value of [box,detail]) {
    assert(value.width > 0 && value.height > 0)
    assert(value.left >= -1 && value.right <= value.viewport.width + 1, '部署区域不得水平越界')
    assert(value.top >= -1 && value.bottom <= value.viewport.height + 1, '部署区域不得越出短窗口')
    assert(value.document.width <= value.viewport.width + 1 && value.document.height <= value.viewport.height + 1, '工作区应使用内部滚动，不应扩大整页尺寸')
  }
  const result = {session:session.name,label,panel:box,detail}; report.geometry.push(result)
  await screenshot(`${session.name}-${label}`); return result
}
async function configurationAndDialog() {
  await dismissToasts()
  await toggle('部署详情分类','配置').click()
  await details().getByText('站点检查地址', {exact:true}).waitFor()
  await toggle('部署详情分类','任务日志').click()
  const trigger = panel().getByRole('button', {name:'发布',exact:true})
  await until(async () => await trigger.isEnabled(), '真实 Agent 完成任务后发布入口应恢复')
  await trigger.click()
  const dialog = page.getByRole('dialog', {name:'确认发布',exact:true}); await dialog.waitFor()
  await dialog.getByRole('combobox', {name:'发布源码包',exact:true}).waitFor()
  const box = await bounds(dialog)
  assert(box.left >= -1 && box.right <= box.viewport.width + 1 && box.top >= -1 && box.bottom <= box.viewport.height + 1, '发布 Dialog 必须适应窄屏和短窗口')
  await page.keyboard.press('Tab')
  assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'Tab 焦点应留在原生 Dialog 内')
  await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'})
  await until(() => trigger.evaluate(element => document.activeElement === element), 'Escape 应恢复真实发布触发器焦点')
  return {configurationTab:true, dialogBounds:box, escapeRestoresFocus:true, submitted:false}
}
async function collectTask(taskId) {
  let cursor = 0, task, logs = []
  do {
    const result = await get(`${api}/deployments/tasks/${taskId}?after=${cursor}`)
    task = result.task
    assert.equal(task.targetId, fixture.target.id)
    for (const entry of result.logs) { assert.equal(entry.seq, cursor + 1, '真实任务日志应连续补读'); logs.push({seq:entry.seq,stage:entry.stage,status:entry.status,at:entry.at,message:redact(entry.message)}); cursor = entry.seq }
    assert.equal(result.nextSeq, cursor + 1)
  } while (cursor < (task.lastSeq || 0))
  return {task,logs}
}
async function scrollLogs(label) {
  await log().waitFor()
  const initial = await viewport().evaluate(element => ({top:element.scrollTop,height:element.clientHeight,scrollHeight:element.scrollHeight}))
  if (initial.scrollHeight <= initial.height + 32) return {covered:false, reason:'真实任务日志在此窗口内无需滚动，未生成或注入假日志', ...initial}
  report.coverage.longLogOverflow = true
  const documentTop = await page.evaluate(() => document.scrollingElement.scrollTop)
  await viewport().evaluate(element => {element.scrollTop = 0; element.dispatchEvent(new Event('scroll'))})
  await page.getByRole('button', {name:'回到最新日志',exact:true}).waitFor()
  const count = await log().locator(':scope > span').count()
  await new Promise(done => setTimeout(done, 1400))
  const later = await viewport().evaluate(element => ({top:element.scrollTop,height:element.clientHeight,scrollHeight:element.scrollHeight}))
  assert(later.top < 5, '向上读日志时轮询不得抢回底部')
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), documentTop, '日志滚动不应推动整页')
  const nextCount = await log().locator(':scope > span').count()
  if (nextCount > count) report.coverage.streamingReadPosition = true
  await screenshot(label)
  await page.getByRole('button', {name:'回到最新日志',exact:true}).click()
  await until(() => viewport().evaluate(element => element.scrollHeight-element.clientHeight-element.scrollTop < 32), '回到最新日志应恢复跟随')
  return {covered:true, initial,later,newEntriesWhileReading:nextCount-count, documentStayed:true}
}
async function publish(session) {
  await services(session)
  const button = panel().getByRole('button', {name:'发布',exact:true}); await until(() => button.isEnabled(), '真实发布入口应可用')
  await button.click(); const dialog = page.getByRole('dialog', {name:'确认发布',exact:true}); await dialog.waitFor()
  const choice = dialog.getByRole('combobox', {name:'发布源码包',exact:true})
  await choice.click()
  const date = await page.evaluate(value => new Date(value).toLocaleString('zh-CN'), fixture.package.createdAt)
  const option = page.getByRole('option', {name:`${fixture.package.name} · ${date}`, exact:true}); await option.click()
  await dialog.getByText('SHA-256：' + report.fixture.frontendSha256, {exact:true}).waitFor()
  publishArmed = true
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === origin + api + '/deployments/tasks' && response.request().method() === 'POST'),
    dialog.getByRole('button', {name:'确认发布',exact:true}).click(),
  ])
  publishArmed = false
  assert.equal(response.status(), 202)
  const result = await response.json(); selectedTaskId = result.task.id
  assert(/^[a-f0-9-]{36}$/.test(selectedTaskId)); assert(acceptedRequestId)
  report.publish = {taskId:selectedTaskId,requestId:acceptedRequestId,status:result.task.status,sourceIdentity:result.task.sourceIdentity}
  await dialog.waitFor({state:'hidden'})
  const end = Date.now() + Number(process.env.PUBLISH_TIMEOUT_MS || 900000)
  let attemptedScroll = false, heartbeat = 0, task
  while (Date.now() < end) {
    const current = await collectTask(selectedTaskId); task = current.task
    report.publish.status = task.status; report.publish.lastSeq = task.lastSeq
    await writeFile(path.join(output, 'published-task-logs.json'), JSON.stringify({taskId:selectedTaskId,requestId:acceptedRequestId,status:task.status,logs:current.logs}, null, 2))
    if (!attemptedScroll && await log().isVisible()) {
      const sizes = await viewport().evaluate(element => ({height:element.clientHeight,scrollHeight:element.scrollHeight}))
      if (sizes.scrollHeight > sizes.height + 32) { attemptedScroll = true; report.publish.streamingScroll = await scrollLogs('desktop-live-reading-earlier-logs') }
    }
    if (['succeeded','failed','rolled_back','interrupted'].includes(task.status)) break
    if (Date.now()-heartbeat > 15000) { heartbeat=Date.now(); console.log(JSON.stringify({taskId:selectedTaskId,status:task.status,stage:task.stage,lastSeq:task.lastSeq})); await flush() }
    await new Promise(done => setTimeout(done, 1000))
  }
  assert.equal(task?.status, 'succeeded', '真实发布必须成功，失败详情保留在本次任务日志证据中')
  await page.reload(); await panel().waitFor({timeout:60000})
  await until(async () => {
    const selection = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || 'null'), `autoops:deployments:${session.principalId}:${projectId}:selection`)
    return selection?.taskId === selectedTaskId
  }, '重载后应恢复同一个已接受任务，不得新建任务')
  await log().waitFor(); report.publish.reloadRestoredTask = true
  assert.equal(new Set(report.allowedDeployments.map(item => item.requestId)).size, 1)
  return report.publish
}
async function packages(session) {
  await deploymentView('源码包')
  const sidebar = await openModuleSidebar()
  const date = await page.evaluate(value => new Date(value).toLocaleString('zh-CN'), fixture.package.createdAt)
  await sidebar.getByRole('button', {name:fixture.package.name + ' ' + date, exact:true}).click()
  await openModuleSidebar()
  const link = sidebar.getByRole('link', {name:'下载前端 ZIP',exact:true}); await link.waitFor()
  const href = await link.getAttribute('href')
  assert.equal(href, `${api}/workspaces/packages/${fixture.package.id}/frontend/download`)
  const bytes = await download(link, 'frontend.zip'); assert.equal(createHash('sha256').update(bytes).digest('hex'), report.fixture.frontendSha256)
  let manifestDialog = false
  if (session.touch) { await sidebar.getByRole('button', {name:'查看交付清单',exact:true}).click(); await page.getByRole('dialog', {name:'交付清单',exact:true}).waitFor(); manifestDialog=true }
  const manifestLink = page.getByRole('link', {name:'下载交付清单',exact:true}).filter({visible:true}); await manifestLink.waitFor()
  const manifestHref = await manifestLink.getAttribute('href'); assert.equal(manifestHref, `${api}/workspaces/packages/${fixture.package.id}/manifest`)
  const manifest = JSON.parse((await download(manifestLink, 'manifest.json')).toString('utf8')); assert.equal(manifest.releaseId, fixture.package.id)
  await screenshot(`${session.name}-source-package-manifest`)
  if (manifestDialog) { await page.keyboard.press('Escape'); await page.getByRole('dialog', {name:'交付清单',exact:true}).waitFor({state:'hidden'}); await until(() => page.getByRole('button',{name:'查看交付清单',exact:true}).evaluate(element => element===document.activeElement), '清单Dialog应恢复触发器焦点') }
  await services(session)
  return {frontendDownloadVerified:true, sha256:report.fixture.frontendSha256, manifestDownloadVerified:true, manifestDialog}
}
async function download(link, name) {
  const [file] = await Promise.all([page.waitForEvent('download'), link.click()])
  try {
    assert.equal(await file.failure(), null)
    assert.equal(file.suggestedFilename(), name)
    const temporary = await file.path(); assert(temporary)
    const bytes = await readFile(temporary)
    report.browserDownloads.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),onlyFixturePackage:true,deletedAfterVerification:true})
    return bytes
  } finally { await file.delete() }
}
async function environmentIsolation(session) {
  const prod = session.project.environments.find(item => item.id === 'env-prod'); assert(prod, '验证项目应已有生产环境')
  const real = await get(api + '/deployments?environmentId=env-prod')
  assert.equal(real.targets.length, 0, '仅允许对预先确认为空的生产环境做只读隔离验证')
  assert.equal(real.tasks.length, 0)
  const sidebar = await openModuleSidebar()
  await select('部署环境', prod.name)
  await until(async () => !await sidebar.getByRole('button',{name:new RegExp(targetName)}).isVisible(), '切换空环境不能保留测试环境目标')
  assert.equal(await page.locator('pre[aria-label="部署增量日志"]').filter({visible:true}).count(), 0, '空环境不得串入原任务日志')
  await panel().getByText('还没有可用的部署服务器',{exact:true}).or(panel().getByText('还没有前端服务',{exact:true})).waitFor()
  await closeSidebar()
  await screenshot(`${session.name}-production-empty-readonly`)
  await openModuleSidebar()
  await select('部署环境', session.project.environments.find(item => item.id === environmentId).name)
  await services(session)
  return {productionReadOnly:true,noTargetOrTaskLeak:true}
}

try {
  const desktop = await login('desktop-admin')
  await run('preflight-existing-real-fixture', () => preflight(desktop))
  if (live) await run('live-publish-and-reload', () => publish(desktop))
  else {
    const evidence = await collectTask(selectedTaskId)
    await writeFile(path.join(output,'readonly-task-logs.json'),JSON.stringify({taskId:selectedTaskId,status:evidence.task.status,logs:evidence.logs},null,2))
    report.readonlyTask = {taskId:selectedTaskId,status:evidence.task.status,lastSeq:evidence.task.lastSeq}
  }
  for (const mode of ['light','dark']) await run(`desktop-${mode}-flows`, async () => {
    await page.setViewportSize({width:1440,height:900}); await theme(desktop,mode)
    const geometryResult=await geometry(desktop,mode), interaction=await configurationAndDialog(), scrolling=await scrollLogs(`desktop-${mode}-earlier-logs`)
    return {geometry:geometryResult,interaction,scrolling}
  })
  await run('desktop-short-window-and-artifacts', async () => {
    await page.setViewportSize({width:1440,height:600}); await services(desktop)
    return {geometry:await geometry(desktop,'short-600'),interaction:await configurationAndDialog(),scrolling:await scrollLogs('desktop-short-earlier-logs'),packages:await packages(desktop),environment:await environmentIsolation(desktop)}
  })
  const touch = await login('touch-admin',true)
  for (const mode of ['light','dark']) await run(`touch-${mode}-flows`,async()=>{
    page=touch.page; await theme(touch,mode)
    const result={geometry:await geometry(touch,mode),interaction:await configurationAndDialog(),scrolling:await scrollLogs(`touch-${mode}-earlier-logs`)}
    const sidebar = await openModuleSidebar()
    await sidebar.getByRole('button',{name:new RegExp(targetName)}).waitFor()
    await services(touch); return {...result,mobileListDetail:true}
  })
  await run('touch-source-package-and-environment',async()=>({packages:await packages(touch),environment:await environmentIsolation(touch)}))
  const guest = await login('guest-readonly',false,'guest')
  await run('guest-denied',async()=>{
    await workspace(guest)
    assert.equal(await page.getByTestId('project-area-navigation').getByRole('button',{name:'部署',exact:true}).count(),0)
    assert.equal(await page.getByRole('combobox',{name:'部署环境',exact:true}).count(),0)
    assert.equal(guest.deploymentReads,0,'外部账号界面不应自动访问部署接口')
    await get(api+'/deployments?environmentId='+environmentId,403)
    await screenshot('guest-no-deployment-entry')
    return {entryHidden:true,automaticDeploymentRequests:0,explicitGetStatus:403}
  })
  assert.equal(report.blockedHttpMutations.length,0,'界面不应尝试未授权HTTP写操作')
  assert.equal(report.pageErrors.length,0,'页面不应有运行错误')
  assert.equal(new Set(report.allowedDeployments.map(item=>item.requestId)).size,live?1:0)
  report.coverage.longLogNote=report.coverage.longLogOverflow?'已在真实任务日志中验证内部滚动':'实际日志在所有已测窗口均未溢出；长日志滚动未覆盖，未注入测试内容'
  report.coverage.streamingNote=report.coverage.streamingReadPosition?'上读期间实际新增日志且位置未被抢回':'未在上读期间观察到新日志；只验证实际可用的已完成日志滚动，不宣称实时追加验证通过'
  report.status='passed'
} catch(error) { report.status='failed';report.error=redact(error.stack||error.message);process.exitCode=1;console.error(redact(error.stack||error.message)) }
finally {
  publishArmed=false
  for (const session of sessions) {
    const result=report.cleanup[session.name]={}
    await session.context?.close().then(()=>{result.ownedBrowserClosed=true}).catch(error=>{result.error=redact(error.message);process.exitCode=1;report.status='failed'})
    await rm(session.profile,{recursive:true,force:true});result.onlyOwnedProfileRemoved=true
  }
  report.finishedAt=new Date().toISOString();await flush()
}
