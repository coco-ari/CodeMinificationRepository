import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { startBrowser } from './helpers/prototype-browser.mjs'

function png(width, height, red = 60) {
  const chunk = (kind, data) => {
    const type = Buffer.from(kind)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(Buffer.concat([type, data])))
    return Buffer.concat([length, type, data, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const raw = Buffer.alloc(height * (width * 3 + 1))
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + x * 3 + 1
      raw[offset] = red
      raw[offset + 1] = 140
      raw[offset + 2] = 180
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const b = await startBrowser('cabinet')
const recordCheck = b.check
b.check = (message) => {
  assert.deepEqual(b.errors, [], `${message} 阶段无运行时异常`)
  recordCheck(message)
}
const imei = '860000000000001'
const deviceId = 'cabinet-1'
const getDevice = async () =>
  (await b.storage()).cabinet.devices.find((device) => device.id === deviceId)
const dialogClose = async () => {
  await b.key('Escape', 27)
  await b.wait(220)
}
const tab = async (name) => {
  await b.clickText(name, '[role=tab]')
  await b.wait(100)
}
const upload = async (file) => {
  const document = await b.command('DOM.getDocument')
  const input = await b.command('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: '[aria-label="上传机柜照片文件"]',
  })
  await b.command('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] })
}
const rowAction = (text, action) =>
  b.mouse(
    `Array.from(document.querySelectorAll('tr')).find(row=>row.textContent.includes(${JSON.stringify(text)}))?.querySelectorAll('button') && Array.from(Array.from(document.querySelectorAll('tr')).find(row=>row.textContent.includes(${JSON.stringify(text)})).querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(action)})`,
    `${text} ${action}`,
  )
const confirmEnabled = () =>
  b.evaluate(
    `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='确认重置 / 解绑')?.disabled===false`,
  )

try {
  await b.reset('lin')
  await b.route('/cabinet')
  await b.visible('[data-testid="cabinet-page"]')
  assert.ok(
    await b.evaluate(
      `document.querySelector('[aria-label="批量分配目标"]').textContent.includes('Atlas 研发平台-预发布')`,
    ),
  )
  assert.equal((await b.storage()).projects.atlas.memberIds.includes('lin'), false)
  await b.assertNoOverflow('机柜桌面')
  await b.screenshot('desktop-cabinet')
  await tab('重置配置')
  assert.equal(
    await b.evaluate(`document.querySelector('[aria-label="机柜 MySQL 主机"]').disabled`),
    true,
  )
  assert.equal(
    await b.evaluate(
      `Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='保存重置配置')`,
    ),
    false,
  )
  b.check('普通成员可见全局跨项目目标，不能修改管理员重置配置')

  await tab('鉴权目标')
  await b.clickText('新增手动目标')
  await b.fill('[aria-label="手动目标名称"]', '端到端验证平台')
  await b.fill('[aria-label="手动目标 URL"]', 'https://manual.example.invalid:8443/custom/auth')
  await b.clickText('保存目标')
  await b.until(() => b.evaluate(`!document.querySelector("[role=dialog]")`), '目标弹窗关闭')
  const manual = (await b.storage()).cabinet.manualTargets.find(
    (target) => target.name === '端到端验证平台',
  )
  assert.ok(manual)
  await b.click('[aria-label="启用目标 端到端验证平台"]')
  assert.equal(
    (await b.storage()).cabinet.manualTargets.find((target) => target.id === manual.id).enabled,
    false,
  )
  await b.click('[aria-label="启用目标 端到端验证平台"]')
  b.check('成员可创建完整 URL 手动鉴权目标并启停')

  await tab('机柜池')
  await b.clickText('选择本页')
  await b.select('[aria-label="批量分配目标"]', manual.id)
  await b.clickText('分配 / 迁移')
  await b.clickText('保存分配')
  await b.until(() => b.evaluate(`!document.querySelector("[role=dialog]")`), '分配弹窗关闭')
  assert.ok(
    (await b.storage()).cabinet.devices
      .slice(0, 5)
      .every((device) => device.targetId === manual.id),
  )
  assert.ok((await getDevice()).lastAuth.targetUrl.includes('sol-test'))
  assert.equal(
    await b.evaluate(`document.querySelector('[aria-label="机柜二维码 ${imei}"]').disabled`),
    true,
  )
  await b.clickText('体验中心 A ↗')
  await b.clickText('鉴权演示')
  await b.clickText('模拟下次鉴权')
  await b.until(
    async () => (await getDevice()).lastAuth.targetUrl === manual.url,
    '下一次鉴权采用新目标',
  )
  assert.equal((await getDevice()).lastAuth.status, 'success')
  assert.ok((await getDevice()).lastAuth.mqttEndpoint.includes('manual.example.invalid'))
  b.check('选择本页仅迁移当前 5 台，分配等待下一次鉴权生效，未提前生成二维码')

  await b.clickText('二维码')
  await b.clickText('下载 PNG')
  const qrName = await b.until(
    async () =>
      (await readdir(b.downloadDirectory)).find(
        (file) => file.startsWith(`机柜-${imei}`) && file.endsWith('.png'),
      ),
    '二维码 PNG 下载',
  )
  const qr = await readFile(path.join(b.downloadDirectory, qrName))
  assert.deepEqual([...qr.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.ok(qr.length > 1000)
  await b.screenshot('qr-preview')
  await dialogClose()
  const photoPath = path.join(b.output, 'cabinet-photo.png')
  await writeFile(photoPath, png(1800, 900))
  await b.clickText('上传照片')
  await upload(photoPath)
  await b.until(async () => Boolean((await getDevice()).photo), '照片保存')
  assert.equal((await getDevice()).photo.width, 1600)
  assert.equal((await getDevice()).photo.height, 800)
  const secondPhoto = path.join(b.output, 'cabinet-photo-replaced.png')
  await writeFile(secondPhoto, png(24, 16, 220))
  await b.clickText('替换照片')
  await upload(secondPhoto)
  await b.until(
    async () => (await getDevice()).photo.name === 'cabinet-photo-replaced.png',
    '照片替换',
  )
  b.check('二维码为可下载 PNG；照片可上传替换，长边自动限制到 1600')

  await b.clickText('重置平台 / 解绑')
  await b.clickText('只读预览')
  await b.fill('[aria-label="确认重置机柜 IMEI"]', imei.slice(1))
  assert.equal(await confirmEnabled(), false)
  await b.fill('[aria-label="确认重置机柜 IMEI"]', imei)
  assert.equal(await confirmEnabled(), true)
  await b.clickText('确认重置 / 解绑')
  await b.until(async () => (await getDevice()).platform.platformId === 2, '机柜解绑完成')
  const reset = await getDevice()
  assert.equal(reset.platform.agentId, null)
  assert.equal(reset.platform.bindTime, null)
  assert.ok(reset.platform.positions.every((slot) => slot.platformId === 2))
  assert.equal(reset.targetId, manual.id)
  assert.equal(reset.photo.name, 'cabinet-photo-replaced.png')
  await b.clickText('重新预览')
  await b.fill('[aria-label="确认重置机柜 IMEI"]', imei)
  await b.clickText('确认重置 / 解绑')
  await b.until(
    () => b.evaluate(`document.body.textContent.includes('无需变更：机柜与所有仓位')`),
    '已重置状态 noop',
  )
  await b.clickText('重新预览')
  await b.fill('[aria-label="确认重置机柜 IMEI"]', imei)
  await b.clickText('过期与冲突演示')
  await b.clickText('模拟凭证过期')
  assert.equal(await confirmEnabled(), false)
  await b.clickText('重新预览')
  await b.fill('[aria-label="确认重置机柜 IMEI"]', imei)
  await b.clickText('过期与冲突演示')
  await b.clickText('模拟绑定发生变化')
  assert.equal(await confirmEnabled(), false)
  b.check('重置严格校验完整 IMEI；重置只改约定字段；noop、过期与快照变化均正确拦截')

  await b.clickText('重置演示场景')
  await b.select('[aria-label="重置演示情境"]', 'unknown')
  await b.key('Escape')
  await b.clickText('只读预览')
  await b.fill('[aria-label="确认重置机柜 IMEI"]', imei)
  await b.clickText('确认重置 / 解绑')
  await b.until(
    () => b.evaluate(`document.body.textContent.includes('结果待核查：模拟事务提交后连接中断')`),
    '未知结果提示',
  )
  const unknownCount = (await b.storage()).audit.filter(
    (entry) => entry.action === '机柜重置 / 解绑',
  ).length
  await b.wait(900)
  assert.equal(
    (await b.storage()).audit.filter((entry) => entry.action === '机柜重置 / 解绑').length,
    unknownCount,
  )
  assert.equal(
    await b.evaluate(
      `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='重新预览').disabled`,
    ),
    true,
  )
  await b.clickText('模拟只读核查')
  assert.equal(
    await b.evaluate(
      `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='重新预览').disabled`,
    ),
    false,
  )
  await b.screenshot('reset-unknown')
  b.check('事务未知结果不会自动重试，先完成只读核查才能重新预览')
  await b.clickText('重置演示场景')
  await b.select('[aria-label="重置演示情境"]', 'conflict')
  await b.key('Escape')
  await b.clickText('只读预览')
  assert.ok(await b.evaluate(`document.body.textContent.includes('仓位存在多个平台，拒绝重置')`))
  await b.clickText('重置演示场景')
  await b.select('[aria-label="重置演示情境"]', 'success')
  await b.select('[aria-label="重置 DNS 情境"]', 'mixed')
  await b.key('Escape')
  await b.clickText('只读预览')
  assert.ok(
    await b.evaluate(
      `document.body.textContent.includes('目标 DNS 解析结果未全部匹配允许 IP，不能预览或执行重置')`,
    ),
  )
  b.check('混合平台仓位和部分 DNS 匹配均在只读预览阶段拒绝')
  await dialogClose()
  await dialogClose()

  await b.route('/p/sol/settings')
  await rowAction('测试', '编辑')
  await b.fill('[aria-label="环境名称"]', '联调验收')
  await b.fill('[aria-label="机柜鉴权基础地址"]', 'http://acceptance.example.invalid:8081')
  await b.clickText('保存环境')
  await b.route('/cabinet')
  await tab('鉴权目标')
  assert.ok(
    await b.evaluate(
      `document.body.textContent.includes('SOL 设备平台-联调验收') && document.body.textContent.includes('http://acceptance.example.invalid:8081/communication/ybt/api/iot/client/con')`,
    ),
  )
  await tab('机柜池')
  await b.click(`[aria-label="选择机柜 ${imei}"]`)
  await b.select('[aria-label="批量分配目标"]', 'env:sol:sol-test')
  await b.clickText('分配 / 迁移')
  await b.clickText('保存分配')
  await b.until(() => b.evaluate(`!document.querySelector("[role=dialog]")`), '分配弹窗关闭')
  await b.route('/p/sol/settings')
  await rowAction('联调验收', '删除')
  await b.clickText('确认删除')
  const unassigned = await getDevice()
  assert.equal(unassigned.targetId, null)
  assert.equal(unassigned.photo.name, 'cabinet-photo-replaced.png')
  await b.route('/cabinet')
  await tab('鉴权目标')
  assert.equal(
    await b.evaluate(`document.body.textContent.includes('SOL 设备平台-联调验收')`),
    false,
  )
  assert.ok((await b.storage()).cabinet.manualTargets.some((target) => target.id === manual.id))
  b.check('项目环境改名/地址自动同步目标，删除环境只取消分配并保留机柜照片与手动目标')

  await tab('机柜池')
  await b.clickText('体验中心 A ↗')
  await b.clickText('删除注册')
  await b.fill('[aria-label="确认删除机柜 IMEI"]', imei.slice(0, 14))
  assert.equal(
    await b.evaluate(
      `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='确认删除注册').disabled`,
    ),
    true,
  )
  await b.fill('[aria-label="确认删除机柜 IMEI"]', imei)
  await b.clickText('确认删除注册')
  await b.until(() => b.evaluate(`!document.querySelector('[role=dialog]')`), '删除弹窗关闭')
  assert.equal(await getDevice(), undefined)
  assert.ok(
    (await b.storage()).audit.some(
      (entry) => entry.action === '删除机柜注册' && entry.object === imei,
    ),
  )
  await b.clickText('演示场景')
  await b.clickText('模拟设备接入')
  await b.fill('[aria-label="接入机柜 IMEI"]', imei)
  await b.fill('[aria-label="接入机柜名称"]', '已删除后重连')
  await b.clickText('发送模拟请求')
  await b.until(() => b.evaluate(`!document.querySelector('[role=dialog]')`), '接入弹窗关闭')
  const reconnected = (await b.storage()).cabinet.devices.find((device) => device.imei === imei)
  assert.ok(reconnected)
  assert.notEqual(reconnected.id, deviceId)
  assert.equal(reconnected.targetId, null)
  assert.equal(reconnected.photo, null)
  assert.equal(reconnected.lastAuth.status, 'unassigned')
  b.check('删除注册要求完整 IMEI，保留审计；重连自动注册为无照片的未分配设备')

  await b.viewport(390, 844)
  await b.wait(4200)
  await b.assertNoOverflow('机柜移动布局')
  await b.screenshot('mobile-cabinet')
  await rowAction('已删除后重连', '详情')
  await b.assertNoOverflow('机柜移动详情')
  await b.screenshot('mobile-detail')
  await dialogClose()
  await tab('鉴权目标')
  await b.assertNoOverflow('鉴权目标移动布局')
  await b.screenshot('mobile-targets')
  await b.click('[aria-label="启用目标 端到端验证平台"]')
  assert.equal(
    (await b.storage()).cabinet.manualTargets.find((target) => target.id === manual.id).enabled,
    false,
  )
  await b.click('[aria-label="启用目标 端到端验证平台"]')
  b.check('390px 移动端无页面溢出，机柜详情与目标启停直接可用')
  await b.viewport()
  await b.logout()
  await b.login('admin')
  await b.route('/cabinet')
  await tab('重置配置')
  assert.equal(
    await b.evaluate(`document.querySelector('[aria-label="机柜 MySQL 主机"]').disabled`),
    false,
  )
  await b.fill('[aria-label="机柜 MySQL 主机"]', 'unreachable.example.invalid')
  await b.clickText('保存重置配置')
  await b.clickText('测试连接')
  assert.equal((await b.storage()).cabinet.settings.status, 'failed')
  await b.fill('[aria-label="机柜 MySQL 主机"]', 'cabinet-mysql.example.invalid')
  await b.clickText('保存重置配置')
  await b.clickText('测试连接')
  assert.equal((await b.storage()).cabinet.settings.status, 'connected')
  await tab('操作审计')
  assert.ok(
    (await b.storage()).audit.some(
      (entry) => entry.actorId === 'lin' && entry.action.includes('机柜'),
    ),
  )
  await b.screenshot('cabinet-audit')
  b.check('管理员可以即时保存配置并测试失败/重试；全局审计保存操作人、对象和结果')
  assert.deepEqual(b.errors, [], '没有浏览器运行时异常')
  assert.deepEqual(b.warnings, [], '没有浏览器错误日志')
  await writeFile(
    path.join(b.output, 'report.json'),
    JSON.stringify({ checks: b.checks, errors: b.errors, warnings: b.warnings }, null, 2),
  )
  console.log(`机柜端到端验收完成：${b.checks.length} 项，证据位于 ${b.output}`)
} catch (error) {
  await b.screenshot('failure').catch(() => {})
  console.error(await b.evaluate('document.body.innerText').catch(() => ''))
  throw error
} finally {
  await b.close()
}
