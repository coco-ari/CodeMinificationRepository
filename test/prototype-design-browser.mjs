import assert from 'node:assert/strict'
import { startBrowser } from './helpers/prototype-browser.mjs'

// 这里检查布局边界和工作区链接；设计是否符合预期仍需对照原图人工审阅截图。
const b = await startBrowser('design-review')
async function reloadReady(selector) {
  const previousOrigin = await b.evaluate('performance.timeOrigin')
  await b.command('Page.reload')
  await b.until(
    () =>
      b.evaluate(
        `performance.timeOrigin!==${previousOrigin} && document.readyState==='complete' && Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      ),
    '新文档加载完成',
  )
}
const screens = [
  ['overview', '/p/sol/overview'],
  ['documents', '/p/sol/documents?document=doc-spec-sol'],
  ['artifacts', '/p/sol/artifacts?artifact=sanitized-sol'],
  ['services', '/p/sol/services'],
  ['deployment', '/p/sol/services?service=sol-api&action=deploy&artifact=sanitized-sol'],
  ['conversation', '/p/sol/chat?conversation=conversation-sol-intro'],
  ['tasks', '/p/sol/tasks'],
]
try {
  await b.reset()
  await b.viewport(1440, 1000)
  for (const [name, path] of screens) {
    await b.route(path)
    await b.until(
      () => b.evaluate('document.querySelector("main")?.textContent.trim().length > 20'),
      `${name} 页面内容`,
    )
    assert.equal(await b.evaluate('Boolean(document.querySelector("vite-error-overlay"))'), false)
    await b.assertNoOverflow(`桌面 ${name}`)
    await b.screenshot(`${name}-desktop`)
  }
  b.check('桌面关键工作区加载、无横向溢出；输出与原图同尺寸的审阅截图')

  await b.route('/p/sol/artifacts?artifact=sanitized-sol')
  assert.equal(
    await b.evaluate('document.querySelectorAll(\'nav[aria-label="项目导航"] button\').length'),
    6,
  )
  assert.equal(
    await b.evaluate(
      'document.querySelector(\'[role="tablist"][aria-label="资料与配置"] [data-state="active"]\')?.textContent',
    ),
    '处理产物',
  )
  await b.clickText('研发资料', '[role=tab]')
  assert.ok((await b.evaluate('location.hash')).includes('/documents'))
  await reloadReady('[aria-label="资料与配置"]')
  assert.equal(
    await b.evaluate(
      'document.querySelector(\'[role="tablist"][aria-label="资料与配置"] [data-state="active"]\')?.textContent',
    ),
    '研发资料',
  )
  b.check('统一资料页签支持导航与刷新恢复')

  await b.route('/p/sol/artifacts?artifact=sanitized-sol')
  await b.clickText('用于发布')
  await b.until(
    () => b.evaluate('document.querySelector("main").textContent.includes("请选择要发布的服务")'),
    '产物带入服务选择',
  )
  await b.mouse(
    `Array.from(document.querySelectorAll('.op-service-line')).find(row=>row.textContent.includes('设备接入 API'))?.querySelector('button[data-variant="outline"]')`,
    '为所选产物选择发布服务',
  )
  await b.visible('[aria-label="选择发布产物 sol-api · 脱敏源码"]')
  assert.equal(
    await b.evaluate(
      'document.querySelector(\'[aria-label="选择发布产物 sol-api · 脱敏源码"]\').getAttribute("aria-pressed")',
    ),
    'true',
  )
  await reloadReady('[aria-label="选择发布产物 sol-api · 脱敏源码"]')
  assert.equal(
    await b.evaluate(
      'document.querySelector(\'[aria-label="选择发布产物 sol-api · 脱敏源码"]\').getAttribute("aria-pressed")',
    ),
    'true',
  )
  await b.route('/p/sol/services?service=sol-api&action=deploy&artifact=missing-source')
  await b.until(
    () => b.evaluate('document.body.textContent.includes("链接指定的源码产物已删除或不可用")'),
    '失效产物不静默替换来源',
  )
  assert.equal(
    await b.evaluate(
      'Array.from(document.querySelectorAll("button")).find(el=>el.textContent.trim().startsWith("确认发布")).disabled',
    ),
    true,
  )
  b.check('产物→服务→发布保留指定来源与刷新状态，失效来源阻止发布')

  await b.route('/p/sol/artifacts?artifact=sanitized-sol')
  await b.clickText('Agent 问答')
  await b.visible('[aria-label="源码制品"]')
  assert.equal(
    await b.evaluate('document.querySelector(\'[aria-label="源码制品"]\').value'),
    'sanitized-sol',
  )
  await b.clickText('创建会话')
  await b.until(() => b.evaluate('location.hash.includes("?conversation=")'), '引用产物创建会话')
  let conversationId = (await b.evaluate('location.hash')).split('conversation=')[1]
  assert.equal(
    (await b.storage()).conversations.find((item) => item.id === conversationId).sourceArtifactId,
    'sanitized-sol',
  )
  await b.route('/p/sol/documents?document=doc-spec-sol')
  await b.clickText('带入 Agent 问答')
  await b.visible('[role="dialog"]')
  await b.clickText('创建会话')
  await b.until(() => b.evaluate('location.hash.includes("?conversation=")'), '文档带入会话')
  conversationId = (await b.evaluate('location.hash')).split('conversation=')[1]
  const conversation = (await b.storage()).conversations.find((item) => item.id === conversationId)
  assert.deepEqual(conversation.scopeIds, ['doc-spec-sol'])
  assert.equal(conversation.sourceArtifactId, null)
  b.check('产物和文档可直接带入会话，所选上下文准确保留')

  await b.until(
    () => b.evaluate('!document.querySelector(\'[data-sonner-toast][data-visible="true"]\')'),
    '临时操作提示结束后截取手机基线',
  )
  await b.viewport(390, 844)
  for (const [name, path] of screens) {
    await b.route(path)
    await b.assertNoOverflow(`手机 ${name}`)
    await b.screenshot(`${name}-mobile`)
  }
  await b.click('[aria-label="打开导航"]')
  await b.visible('[data-slot="sidebar"][data-mobile="true"]')
  await b.clickText('资料与配置')
  await b.until(
    () => b.evaluate('!document.querySelector(\'[data-slot="sidebar"][data-mobile="true"]\')'),
    '手机导航选择后关闭',
  )
  await b.assertNoOverflow('手机导航跳转')
  b.check('390px 主要工作区及官方 Sidebar 抽屉可操作')

  for (const width of [768, 1280, 1920]) {
    await b.viewport(width, 1000)
    for (const [name, path] of screens) {
      await b.route(path)
      await b.assertNoOverflow(`${width}px ${name}`)
    }
  }
  b.check('768 / 1280 / 1920px 各工作区布局边界')
  await b.viewport(1440, 1000)
  await b.route('/p/sol/overview')
  await b.command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  })
  await b.screenshot('overview-reduced-transparency')
  await b.command('Emulation.setEmulatedMedia', {
    features: [{ name: 'forced-colors', value: 'active' }],
  })
  await b.screenshot('overview-high-contrast')
  await b.command('Emulation.setEmulatedMedia', { features: [] })
  assert.deepEqual(b.errors, [], '不应有未处理的页面错误')
  assert.deepEqual(b.warnings, [], '不应有浏览器控制台错误')
  b.check('减少透明效果与高对比度审阅截图；无页面运行错误')
} finally {
  await b.close()
}
