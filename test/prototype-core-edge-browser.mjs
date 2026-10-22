import assert from 'node:assert/strict'
import { startBrowser } from './helpers/prototype-browser.mjs'
const b = await startBrowser('core-edge')
const { reset, click, clickText, fill, select, storage, route, until, evaluate, key, check } = b
const rowButton = (text, label, selector = 'tr,.op-service-line') =>
  b.mouse(
    `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(x=>x.textContent.includes(${JSON.stringify(text)}))?.querySelectorAll('button')&&Array.from(Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(x=>x.textContent.includes(${JSON.stringify(text)})).querySelectorAll('button')).find(x=>x.textContent.trim()===${JSON.stringify(label)})`,
    `${text}/${label}`,
  )
const closed = () => until(() => evaluate('!document.querySelector("[role=dialog]")'), '对话框关闭')
try {
  await reset()
  await route('/p/sol/services')
  await clickText('新建服务')
  await fill('[aria-label="服务名称"]', '尚未发布')
  await select('[aria-label="发布类型"]', 'image')
  await click('[aria-label="目标主机 应用主机"]')
  await clickText('保存服务')
  await closed()
  await click('[aria-label="更多服务操作 尚未发布"]')
  assert.ok(
    await evaluate(
      `Array.from(document.querySelectorAll('[role=menuitem]')).filter(item=>['启动服务','重启当前版本'].includes(item.textContent.trim())).every(item=>item.getAttribute('aria-disabled')==='true')`,
    ),
  )
  await key('Escape', 27)
  check('没有成功发布版本的服务不能凭空启动或重启')
  await route('/p/sol/resources')
  await rowButton('生产主机', '编辑')
  await select('[aria-label="资源类型"]', 'MySQL')
  await clickText('保存资源')
  assert.equal(
    (await storage()).projects.sol.resources.find((r) => r.id === 'sol-prod-server').type,
    'Server',
  )
  assert.ok(await evaluate('!!document.querySelector("[role=dialog]")'))
  await select('[aria-label="资源类型"]', 'Server')
  await select('[aria-label="资源所属环境"]', 'sol-test')
  await clickText('保存资源')
  assert.equal(
    (await storage()).projects.sol.resources.find((r) => r.id === 'sol-prod-server').environmentId,
    'sol-prod',
  )
  await clickText('取消')
  await closed()
  check('被服务引用的Server禁止改类型或移到错误环境')
  await clickText('添加资源')
  await fill('[aria-label="资源名称"]', '备用主机')
  await fill('[aria-label="资源主机地址"]', '192.0.2.90')
  await select('[aria-label="资源所属环境"]', 'sol-prod')
  await clickText('保存资源')
  await closed()
  await route('/p/sol/services')
  await click('[aria-label="更多服务操作 设备接入 API"]')
  await clickText('服务配置', '[role=menuitem]')
  await click('[aria-label="目标主机 备用主机"]')
  await clickText('保存服务')
  await closed()
  await rowButton('设备接入 API', '发布版本')
  await fill('[aria-label="版本 设备接入 API"]', 'multi-host-v1')
  await clickText('确认发布')
  await closed()
  assert.ok(await evaluate('location.hash.includes("/tasks?task=")'))
  assert.ok(
    !(await evaluate('document.querySelector(".op-log-lines").textContent.includes("→ 200")')),
    '发布启动时不应提前显示未来健康检查成功日志',
  )
  await route('/p/sol/resources')
  await rowButton('生产主机', '编辑')
  await fill('[aria-label="资源主机地址"]', '192.0.2.99')
  await clickText('保存资源')
  await closed()
  await until(
    async () =>
      (await storage()).projects.sol.services.find((s) => s.id === 'sol-api').version ===
      'multi-host-v1',
    '多主机发布',
  )
  let s = await storage()
  const service = s.projects.sol.services.find((x) => x.id === 'sol-api')
  assert.equal(service.targetResults.length, 2)
  assert.equal(service.targetResults[0].host, '192.0.2.21')
  assert.equal(service.targetResults[1].host, '192.0.2.90')
  assert.equal(s.projects.sol.resources.find((r) => r.id === 'sol-prod-server').status, 'untested')
  assert.equal(s.projects.sol.resources.find((r) => r.name === '备用主机').status, 'connected')
  assert.equal(service.versions[0].configSnapshot.hostIds.length, 2)
  check('多主机结果与保留版本快照，旧发布结果不标记新地址为已连接')
  await route('/p/sol/services')
  await rowButton('设备接入 API', '发布版本')
  await fill('[aria-label="版本 设备接入 API"]', 'cancel-v2')
  await clickText('确认发布')
  await closed()
  await clickText('停止任务')
  await until(
    async () =>
      (await storage()).tasks.some((t) => t.title.includes('cancel-v2') && t.status === 'stopped'),
    '停止发布',
  )
  assert.equal(
    (await storage()).projects.sol.services.find((x) => x.id === 'sol-api').version,
    'multi-host-v1',
  )
  check('停止发布保留当前运行版本，不应用未完成结果')
  const previous = await storage()
  const cabinetIds = previous.cabinet.devices
    .filter((d) => d.targetId?.startsWith('env:sol:'))
    .map((d) => d.id)
  assert.ok(cabinetIds.length > 0)
  await route('/p/sol/settings')
  await clickText('项目信息', '[role=tab]')
  await clickText('删除项目')
  await fill('[aria-label="确认项目名称"]', '错误名称')
  await clickText('确认删除')
  assert.ok((await storage()).projects.sol)
  await fill('[aria-label="确认项目名称"]', 'SOL 设备平台')
  await clickText('确认删除')
  await closed()
  s = await storage()
  assert.ok(!s.projects.sol)
  assert.ok(s.projects.atlas)
  assert.ok(!s.tasks.some((t) => t.projectId === 'sol'))
  assert.ok(!s.conversations.some((t) => t.projectId === 'sol'))
  for (const id of cabinetIds) {
    assert.ok(s.cabinet.devices.some((d) => d.id === id))
    assert.equal(s.cabinet.devices.find((d) => d.id === id).targetId, null)
  }
  assert.equal(s.cabinet.devices.length, previous.cabinet.devices.length)
  check('完整项目名确认删除、清理平台记录、全局机柜保留并解除分配')
  await reset()
  const assigned = (await storage()).cabinet.devices
    .filter((d) => d.targetId === 'env:sol:sol-test')
    .map((d) => d.id)
  assert.ok(assigned.length)
  await route('/p/sol/settings')
  await rowButton('测试', '编辑')
  await fill('[aria-label="机柜鉴权基础地址"]', '')
  await clickText('保存环境')
  await closed()
  assert.ok(
    (await storage()).cabinet.devices
      .filter((d) => assigned.includes(d.id))
      .every((d) => !d.targetId),
  )
  await rowButton('测试', '编辑')
  await fill('[aria-label="机柜鉴权基础地址"]', 'https://sol-test.example.invalid')
  await clickText('保存环境')
  await closed()
  assert.ok(
    (await storage()).cabinet.devices
      .filter((d) => assigned.includes(d.id))
      .every((d) => !d.targetId),
  )
  check('移除自动鉴权地址解除分配，再添加地址不会恢复旧分配')
  assert.deepEqual(b.errors, [])
  assert.deepEqual(b.warnings, [])
  console.log(`核心边界验收通过：${b.checks.length}组`)
} catch (e) {
  await b.screenshot('failure').catch(() => {})
  console.error(await evaluate('document.body.innerText').catch(() => ''))
  throw e
} finally {
  await b.close()
}
