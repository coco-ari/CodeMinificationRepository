import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startBrowser, until } from './helpers/prototype-browser.mjs'

// 新前端的小范围补验，保留独立报告，不覆盖完整16组回归及其版本边界。
if (!process.env.AGENT_DEMO_URL) throw new Error('请设置 AGENT_DEMO_URL')
process.env.PROTOTYPE_URL = process.env.AGENT_DEMO_URL
const browser = await startBrowser('agent-demo-ui-supplement')
const { evaluate, command, fill, click, clickText, visible, viewport } = browser
const report = { mode: 'scenario', realModelCalls: 0, checks: [], screenshots: [], failures: [] }
let csrf
let conversationId
async function api(url, method = 'GET', body) {
  const result = await evaluate(`(async()=>{
    const r=await fetch('/api/agent-demo'+${JSON.stringify(url)},{
      method:${JSON.stringify(method)},credentials:'same-origin',
      headers:{'Content-Type':'application/json','X-Demo-CSRF':${JSON.stringify(csrf || '')}},
      ${body === undefined ? '' : `body:JSON.stringify(${JSON.stringify(body)}),`}
    });return {status:r.status,data:await r.json()};
  })()`)
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result))
  return result.data
}
async function settle() {
  await evaluate(
    `Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`,
  )
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
}
async function capture(name) {
  await settle()
  await browser.screenshot(name)
  report.screenshots.push(path.join(browser.output, `${name}.png`))
}
async function verify(name, action) {
  try {
    await action()
    report.checks.push(name)
    console.log(`✓ ${name}`)
  } catch (error) {
    report.failures.push({ name, error: error.stack })
    await capture(`failure-${report.failures.length}`)
    console.error(`✗ ${name}: ${error.message}`)
    if (
      await evaluate(
        `Array.from(document.querySelectorAll('[role="dialog"]')).some(n=>n.getClientRects().length)`,
      )
    )
      await escape().catch(() => {})
  }
}
async function escape() {
  await browser.key('Escape', 27)
  await until(
    () =>
      evaluate(
        `!Array.from(document.querySelectorAll('[role="dialog"]')).some(n=>n.getClientRects().length)`,
      ),
    'Escape关闭弹层',
  )
  await settle()
}
async function focusCheck(trigger, panel) {
  await click(trigger)
  await visible(panel)
  await settle()
  await evaluate(`window.__agentDemoPreviousFocus=document.activeElement;null`)
  await browser.key('Tab', 9)
  assert.equal(
    await evaluate(`document.activeElement!==window.__agentDemoPreviousFocus`),
    true,
    'Tab必须移动焦点',
  )
  assert.equal(
    await evaluate(
      `document.querySelector(${JSON.stringify(panel)}).contains(document.activeElement)`,
    ),
    true,
    'Tab后焦点必须在弹层内',
  )
  await escape()
  const returned = await evaluate(
    `document.activeElement===document.querySelector(${JSON.stringify(trigger)})`,
  )
  report.focusTransitions ||= []
  report.focusTransitions.push({
    trigger,
    returned,
    active: await evaluate(`({
      tag:document.activeElement.tagName,label:document.activeElement.getAttribute('aria-label')
    })`),
  })
  assert.equal(returned, true, 'Escape后焦点必须返回原触发按钮')
}

try {
  await viewport(1280, 900)
  await visible('[aria-label="用户名"]')
  await fill('[aria-label="用户名"]', 'admin')
  await fill('[aria-label="密码"]', 'Demo123!')
  await clickText('登录')
  await visible('[aria-label="账号菜单"]')
  const bootstrap = await api('/bootstrap')
  csrf = bootstrap.csrf
  const project = bootstrap.projects[0]
  const agent = bootstrap.agents.find((item) => item.projectIds.includes(project.id))
  const created = await api('/conversations', 'POST', {
    projectId: project.id,
    environmentId: project.environments[0].id,
    agentId: agent.id,
    visibility: 'private',
    mode: 'scenario',
    title: `结果与键盘补验 ${new Date().toISOString()}`,
  })
  conversationId = created.conversation.id
  await evaluate(`location.hash='conversation='+${JSON.stringify(conversationId)}`)
  await until(
    () =>
      evaluate(
        `document.querySelector('.workbench-demo-chat')?.dataset.conversationId===${JSON.stringify(conversationId)}`,
      ),
    '补验会话选中',
  )
  for (let index = 0; index < 2; index++) {
    await api(`/conversations/${conversationId}/messages`, 'POST', {
      requestId: randomUUID(),
      text: '整理一份项目检查报告',
      attachmentIds: [],
      delivery: 'send',
      scenario: { kind: 'normal', stepDelayMs: 20 },
    })
    await until(async () => {
      const current = (await api(`/conversations/${conversationId}`)).conversation
      return !current.activeTurnId && current.artifacts.length === index + 1
    }, '同名报告已生成')
  }
  await clickText('结果2', '.workbench-demo-context [role="tab"]')
  await verify('同名结果包含不同轮次与时分秒', async () => {
    report.resultMetadata = await evaluate(
      `Array.from(document.querySelectorAll('.workbench-demo-context .workbench-demo-artifact-row small')).map(n=>n.textContent)`,
    )
    assert.equal(report.resultMetadata.length, 2)
    assert.match(report.resultMetadata[0], /第\s*1\s*轮.*\d{2}:\d{2}:\d{2}/)
    assert.match(report.resultMetadata[1], /第\s*2\s*轮.*\d{2}:\d{2}:\d{2}/)
    assert.notEqual(report.resultMetadata[0], report.resultMetadata[1])
  })
  await capture('desktop-results-metadata')
  await verify('新建会话弹窗Tab焦点约束与Escape焦点恢复', () =>
    focusCheck('[aria-label="新建会话"]', '[role="dialog"]'),
  )
  await viewport(390, 844)
  await verify('手机上下文抽屉Tab焦点约束与Escape焦点恢复', () =>
    focusCheck('[aria-label="打开会话上下文"]', '.workbench-demo-context-sheet'),
  )
  await verify('手机历史抽屉Tab焦点约束与Escape焦点恢复', () =>
    focusCheck('[aria-label="打开历史会话"]', '.workbench-demo-history-sheet'),
  )
  await verify('资料入口打开上下文后焦点返回原资料按钮', () =>
    focusCheck('.workbench-demo-reference-button', '.workbench-demo-context-sheet'),
  )
  await verify('手机历史内新建取消后焦点返回仍可见的历史入口', async () => {
    await click('[aria-label="打开历史会话"]')
    await visible('.workbench-demo-history-sheet')
    await settle()
    await click('.workbench-demo-history-sheet [aria-label="新建会话"]')
    await visible('.workbench-demo-new-dialog')
    await settle()
    await escape()
    const returned = await evaluate(
      `document.activeElement===document.querySelector('[aria-label="打开历史会话"]')`,
    )
    report.focusTransitions.push({
      trigger: '手机历史内新建→关闭→[aria-label="打开历史会话"]',
      returned,
    })
    assert.equal(returned, true, '已卸载触发按钮应回退到可见的历史入口')
  })
  await click('[aria-label="打开会话上下文"]')
  await visible('.workbench-demo-context-sheet')
  await clickText('结果2', '.workbench-demo-context-sheet [role="tab"]')
  await verify('手机结果下载链接触控区域至少40×40', async () => {
    await settle()
    report.mobileDownloadRects = await evaluate(
      `Array.from(document.querySelectorAll('.workbench-demo-context-sheet .workbench-demo-artifact-row a[download]')).map(n=>{const r=n.getBoundingClientRect();return {label:n.getAttribute('aria-label'),width:r.width,height:r.height}})`,
    )
    assert.equal(report.mobileDownloadRects.length, 2)
    assert.ok(report.mobileDownloadRects.every((rect) => rect.width >= 40 && rect.height >= 40))
  })
  await capture('mobile-results-download-targets')
  await escape()
  await viewport(1280, 900)
  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  })
  await verify('减少透明度媒体偏好生效且工作区无背景模糊', async () => {
    report.reducedTransparency = await evaluate(`({
      matched:matchMedia('(prefers-reduced-transparency: reduce)').matches,
      styles:Array.from(document.querySelectorAll('.workbench-demo-workspace,.workbench-demo-chat,.workbench-demo-composer,.workbench-demo-history,.workbench-demo-context')).map(n=>({
        className:n.className,backdropFilter:getComputedStyle(n).backdropFilter,
        background:getComputedStyle(n).backgroundColor
      }))
    })`)
    assert.equal(report.reducedTransparency.matched, true)
    assert.ok(report.reducedTransparency.styles.every((item) => item.backdropFilter === 'none'))
  })
  await capture('reduced-transparency-results')
  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'forced-colors', value: 'active' }],
  })
  await verify('强制颜色媒体偏好使用系统颜色且移除背景装饰', async () => {
    report.forcedColors = await evaluate(`({
      matched:matchMedia('(forced-colors: active)').matches,
      bodyBackgroundImage:getComputedStyle(document.body).backgroundImage,
      glassBlur:getComputedStyle(document.documentElement).getPropertyValue('--glass-blur').trim(),
      inputBorder:getComputedStyle(document.querySelector('.workbench-demo-input-box')).borderColor,
      textColor:getComputedStyle(document.querySelector('.workbench-demo-chat')).color
    })`)
    assert.equal(report.forcedColors.matched, true)
    assert.equal(report.forcedColors.bodyBackgroundImage, 'none')
    assert.equal(report.forcedColors.glassBlur, 'none')
  })
  await capture('forced-colors-results')
  report.assets = await evaluate(`Array.from(document.scripts).map(n=>n.src).filter(Boolean)`)
  report.stylesheets = await evaluate(
    `Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(n=>n.href)`,
  )
  const fullSuitePath = path.resolve('.test-artifacts/prototype-v2/agent-demo/report.json')
  const fullSuite = await readFile(fullSuitePath, 'utf8')
    .then(JSON.parse)
    .catch(() => null)
  report.fullSuiteReference = {
    report: fullSuitePath,
    frontendAssets: fullSuite?.buildAssets || [],
    backend: fullSuite?.serverHealth?.buildHash || null,
    testedAt: fullSuite?.testedAt || null,
    passed: fullSuite?.passed ?? null,
    scope: '本报告补验结果展示、焦点及媒体偏好；完整浏览器回归以所引用报告的实际版本和结果为准。',
  }
  report.health = await api('/health')
} catch (error) {
  report.failures.push({ name: '补验流程', error: error.stack })
  await capture('failure-flow').catch(() => {})
} finally {
  report.passed = report.failures.length === 0 && browser.errors.length === 0
  report.errors = browser.errors
  report.warnings = browser.warnings
  report.testedAt = new Date().toISOString()
  report.boundary = '桌面Chrome媒体与尺寸模拟；未测试真实手机软键盘、系统辅助技术或全部色彩对比度。'
  if (conversationId) {
    try {
      const current = (await api(`/conversations/${conversationId}`)).conversation
      if (current.activeTurnId)
        await api(`/conversations/${conversationId}/stop`, 'POST', {
          requestId: randomUUID(),
          expectedTurnId: current.activeTurnId,
        })
      await api(`/conversations/${conversationId}`, 'DELETE')
    } catch (error) {
      report.cleanupError = error.message
    }
  }
  const destination = path.join(browser.output, 'report.json')
  await writeFile(destination, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, report: destination }, null, 2))
  await browser.close()
}
if (!report.passed) process.exitCode = 1
