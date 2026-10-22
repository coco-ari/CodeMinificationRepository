import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { startBrowser } from './helpers/prototype-browser.mjs'
const b = await startBrowser('core')
const {
  reset,
  click,
  clickText,
  fill,
  select,
  storage,
  route,
  until,
  wait,
  evaluate,
  screenshot,
  key,
  check,
  viewport,
  assertNoOverflow,
  logout,
  login,
} = b
const rowButton = (text, button) =>
  b.mouse(
    `Array.from(document.querySelectorAll('tr,.op-service-line,.op-history-row,.wb-list-row')).find(el=>el.textContent.includes(${JSON.stringify(text)}))?.querySelectorAll('button')&&Array.from(Array.from(document.querySelectorAll('tr,.op-service-line,.op-history-row,.wb-list-row')).find(el=>el.textContent.includes(${JSON.stringify(text)})).querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(button)}&&!el.disabled)`,
    `${text}/${button}`,
  )
const closed = () => until(() => evaluate('!document.querySelector("[role=dialog]")'), '关闭弹窗')
const demo = async (label) => {
  await clickText('演示场景')
  await clickText(label, '[role=menuitemradio]')
  await wait(160)
}
const serviceOperation = async (pid, service, label) => {
  await route(`/p/${pid}/services?service=${service.id}`)
  await click(`[aria-label="更多服务操作 ${service.name}"]`)
  await clickText(label, '[role=menuitem]')
  await clickText('确认')
  await closed()
}

try {
  await reset()
  await assertNoOverflow('桌面项目列表')
  await screenshot('01-projects-desktop')
  await clickText('SOL 设备平台')
  await b.visible('h1')
  await screenshot('02-overview-desktop')
  assert.ok(await evaluate('document.body.textContent.includes("运行中")'))
  check('管理员项目列表、紧凑概览与运行状态')
  await logout()
  await login('lin')
  assert.ok(
    !(await evaluate('document.querySelector("main").textContent.includes("Atlas 研发平台")')),
  )
  await route('/p/atlas/overview')
  assert.ok(await evaluate('document.querySelector("main").textContent.includes("没有访问权限")'))
  await route('/accounts')
  assert.ok(await evaluate('document.querySelector("main").textContent.includes("仅管理员")'))
  await route('/cabinet')
  assert.ok(await evaluate('document.querySelector("main").textContent.includes("机柜")'))
  check('成员项目隔离、管理员入口限制与全局机柜例外')
  await route('/')
  await clickText('创建项目')
  await fill('[aria-label="新项目名称"]', '浏览器验收项目')
  await fill('[aria-label="新项目描述"]', '项目、环境、发布完整验收')
  await clickText('创建并进入')
  await closed()
  const newProject = Object.values((await storage()).projects).find(
    (p) => p.name === '浏览器验收项目',
  )
  assert.equal(newProject.environments.length, 0)
  assert.deepEqual(newProject.memberIds, ['lin'])
  const pid = newProject.id
  await route(`/p/${pid}/settings`)
  await clickText('创建环境')
  await fill('[aria-label="环境名称"]', '联调')
  await fill('[aria-label="机柜鉴权基础地址"]', 'http://integration.example.invalid:8080')
  await clickText('保存环境')
  await closed()
  const eid = (await storage()).projects[pid].environments[0].id
  await clickText('成员', '[role=tab]')
  await select('[aria-label="选择已有用户"]', 'chen')
  await clickText('添加成员')
  assert.ok((await storage()).projects[pid].memberIds.includes('chen'))
  await route('/cabinet')
  await clickText('鉴权目标', '[role=tab]')
  assert.ok(
    await evaluate('document.querySelector("main").textContent.includes("浏览器验收项目-联调")'),
  )
  check('成员创建空项目、自由环境、直接加成员和自动鉴权目标')
  await route(`/p/${pid}/resources`)
  await clickText('添加资源')
  await fill('[aria-label="资源名称"]', '验收主机')
  await select('[aria-label="资源所属环境"]', eid)
  await fill('[aria-label="资源主机地址"]', '192.0.2.80')
  await fill('[aria-label="资源用户名"]', 'deploy')
  await fill('[aria-label="资源密码"]', 'FAKE_SECRET')
  await clickText('保存资源')
  await closed()
  const rid = (await storage()).projects[pid].resources[0].id
  await demo('连接失败')
  await clickText('测试连接')
  await until(
    async () => (await storage()).projects[pid].resources[0].status === 'failed',
    '连接失败',
  )
  await demo('连接成功')
  await clickText('重试连接')
  await until(
    async () => (await storage()).projects[pid].resources[0].status === 'connected',
    '重试成功',
  )
  await clickText('测试连接')
  await clickText('编辑')
  await fill('[aria-label="资源主机地址"]', '192.0.2.81')
  await clickText('保存资源')
  await closed()
  await until(
    async () =>
      !(await storage()).tasks.some((t) => t.resourceId === rid && t.status === 'running'),
    '旧连接任务结束',
  )
  const st = await storage()
  assert.equal(st.projects[pid].resources[0].host, '192.0.2.81')
  assert.equal(st.projects[pid].resources[0].status, 'untested')
  assert.ok(
    st.tasks
      .filter((t) => t.resourceId === rid)
      .every((t) => t.configSnapshot.some((r) => r.host === '192.0.2.80')),
  )
  check('资源立即保存、连接失败重试、运行任务快照及旧连接结果不污染新配置')
  await route(`/p/${pid}/services`)
  await clickText('新建服务')
  await fill('[aria-label="服务名称"]', '容器验收服务')
  await select('[aria-label="发布类型"]', 'image')
  await click('[aria-label="目标主机 验收主机"]')
  await clickText('保存服务')
  await closed()
  await clickText('发布版本')
  await fill('[aria-label="版本 容器验收服务"]', 'v1-failed')
  await demo('健康检查失败')
  await clickText('确认发布')
  await closed()
  await route(`/p/${pid}/settings`)
  await clickText('项目信息', '[role=tab]')
  assert.equal(
    await evaluate(
      'Array.from(document.querySelectorAll("button")).find(x=>x.textContent==="删除项目").disabled',
    ),
    true,
  )
  await until(
    async () =>
      (await storage()).tasks.some((t) => t.title.includes('v1-failed') && t.status === 'failed'),
    '首次发布失败',
  )
  assert.equal((await storage()).projects[pid].services[0].version, null)
  await route(`/p/${pid}/services`)
  await clickText('发布版本')
  await fill('[aria-label="版本 容器验收服务"]', 'v1-success')
  await clickText('确认发布')
  await closed()
  await until(
    async () => (await storage()).projects[pid].services[0].version === 'v1-success',
    '镜像发布成功',
  )
  check('新建容器服务、首次失败无回退、运行任务阻止删项目、成功发布')
  const containerService = (await storage()).projects[pid].services[0]
  await serviceOperation(pid, containerService, '停止服务')
  await until(
    async () => (await storage()).projects[pid].services[0].status === 'stopped',
    '停止服务',
  )
  await serviceOperation(pid, containerService, '启动服务')
  await until(
    async () => (await storage()).projects[pid].services[0].status === 'running',
    '启动服务',
  )
  await serviceOperation(pid, containerService, '重启当前版本')
  await until(
    async () => !(await storage()).tasks.some((t) => t.projectId === pid && t.status === 'running'),
    '重启服务',
  )
  check('服务停止、启动、重启及独立运维任务')
  await route('/p/sol/services')
  await click('[aria-label="选择服务 设备接入 API"]')
  await click('[aria-label="选择服务 运维门户"]')
  await clickText('批量发布（2）')
  await fill('[aria-label="版本 设备接入 API"]', 'batch-api-fail')
  await demo('健康检查失败')
  await clickText('运维门户', '[role=tab]')
  await fill('[aria-label="版本 运维门户"]', 'batch-web-ok')
  await screenshot('03-release-workspace')
  await clickText('确认发布 2 个服务')
  await closed()
  await screenshot('03-batch-deploy-progress')
  await b.command('Page.reload')
  await b.visible('h1')
  await until(
    async () =>
      (await storage()).projects.sol.services.find((s) => s.id === 'sol-web').version ===
      'batch-web-ok',
    '刷新后发布任务恢复',
  )
  const sol = (await storage()).projects.sol
  assert.equal(sol.services.find((s) => s.id === 'sol-api').version, 'v1.8.2')
  assert.ok(
    (await storage()).tasks.some(
      (t) => t.title.includes('batch-api-fail') && t.status === 'rolledback',
    ),
  )
  await route('/p/sol/services?service=sol-web')
  await rowButton('v2.4.0', '回退')
  await clickText('确认回退')
  await clickText('确认')
  await until(
    async () =>
      (await storage()).projects.sol.services.find((s) => s.id === 'sol-web').version === 'v2.4.0',
    '手工版本回退',
  )
  await key('Escape', 27)
  await closed()
  check('Java/静态批量发布独立结果、失败自动恢复、刷新续跑和手工回退')
  await route('/p/sol/tasks')
  await select('[aria-label="任务类型"]', 'deploy')
  await select('[aria-label="任务状态"]', 'rolledback')
  assert.ok(await evaluate('document.querySelector("main").textContent.includes("batch-api-fail")'))
  await clickText('详情')
  await b.visible('.op-log-lines')
  assert.ok(await evaluate('document.querySelector("main").textContent.includes("启动时资源配置")'))
  assert.ok(await evaluate('location.hash.includes("task=")'))
  await b.command('Page.reload')
  await b.visible('.op-task-progress')
  await fill('[aria-label="搜索任务日志"]', '健康检查')
  assert.ok(
    await evaluate('document.querySelector(".op-log-lines").textContent.includes("健康检查")'),
  )
  const logTaskId = await evaluate('new URLSearchParams(location.hash.split("?")[1]).get("task")')
  await clickText('下载', '.op-log-toolbar button')
  const downloadedLog = await until(async () => {
    try {
      return await readFile(path.join(b.downloadDirectory, `${logTaskId}.log`), 'utf8')
    } catch {
      return false
    }
  }, '下载完整任务日志')
  assert.match(downloadedLog, /固定版本/)
  assert.match(downloadedLog, /健康检查/)
  await b.command('Browser.grantPermissions', {
    origin: new URL(b.base).origin,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  })
  await clickText('复制', '.op-log-toolbar button')
  assert.equal(await evaluate('navigator.clipboard.readText()'), downloadedLog)
  await screenshot('03-task-detail')
  await route('/p/sol/tasks')
  await clickText('操作审计', '[role=tab]')
  assert.equal(
    await evaluate(
      'Array.from(document.querySelectorAll("button")).find(x=>x.textContent==="清理审计").disabled',
    ),
    true,
  )
  await route('/notifications')
  await clickText('全部标为已读')
  assert.ok(
    (await storage()).notifications
      .filter((n) => n.projectId === pid || n.projectId === 'sol')
      .every((n) => n.readBy.includes('lin')),
  )
  check('任务筛选、详情快照与完整日志复制下载、成员不可清审计、站内通知')
  await logout()
  await login('chen')
  await route('/')
  assert.ok(await evaluate('document.querySelector("main").textContent.includes("浏览器验收项目")'))
  assert.ok(
    !(await evaluate('document.querySelector("main").textContent.includes("SOL 设备平台")')),
  )
  check('添加成员立即获得该项目访问权限')
  await logout()
  await login('admin')
  await route('/accounts')
  await clickText('创建账号')
  await fill('[aria-label="用户姓名"]', '验收用户')
  await fill('[aria-label="新用户名"]', 'browser-user')
  await fill('[aria-label="初始密码"]', 'DemoPass123!')
  await b.mouse(
    'Array.from(document.querySelectorAll("[role=dialog] button")).find(x=>x.textContent==="创建账号")',
    '提交创建账号',
  )
  await closed()
  assert.ok((await storage()).users.some((u) => u.username === 'browser-user'))
  await rowButton('browser-user', '重置密码')
  await fill('[aria-label="重置新密码"]', 'ResetDemo123!')
  await clickText('确认重置')
  await closed()
  assert.equal(
    (await storage()).users.find((u) => u.username === 'browser-user').password,
    'ResetDemo123!',
  )
  check('管理员创建账号和重置虚构演示密码')
  await viewport(390, 844)
  for (const page of [
    'overview',
    'documents',
    'repositories',
    'artifacts',
    'resources',
    'services',
    'agents',
    'chat',
    'tasks',
    'settings',
  ]) {
    await route(`/p/sol/${page}`)
    await assertNoOverflow(`移动端${page}`)
  }
  await route('/p/sol/overview')
  await screenshot('04-overview-mobile')
  await click('[aria-label="打开导航"]')
  await b.visible('[role=dialog]')
  await screenshot('05-mobile-navigation')
  await key('Escape', 27)
  await route('/p/sol/resources')
  await clickText('添加资源')
  await assertNoOverflow('移动资源表单')
  await screenshot('06-mobile-resource-dialog')
  await key('Escape', 27)
  await viewport()
  await b.command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  })
  await route('/p/sol/services')
  await screenshot('07-reduced-transparency')
  await b.command('Emulation.setEmulatedMedia', {
    features: [{ name: 'forced-colors', value: 'active' }],
  })
  await screenshot('08-high-contrast')
  await assertNoOverflow('高对比')
  await b.command('Emulation.setEmulatedMedia', { features: [] })
  check('所有项目页面390px布局、移动导航/弹窗、减少透明与高对比度')
  assert.deepEqual(b.errors, [], `页面错误 ${b.errors.join('\n')}`)
  assert.deepEqual(b.warnings, [], `控制台错误 ${b.warnings.join('\n')}`)
  console.log(`核心浏览器验收通过：${b.checks.length}组`)
} catch (e) {
  await screenshot('failure').catch(() => {})
  console.error(await evaluate('document.body.innerText').catch(() => ''))
  throw e
} finally {
  await b.close()
}
