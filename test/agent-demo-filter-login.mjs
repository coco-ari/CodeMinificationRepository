import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isolatedServer } from './agent-demo-helpers.mjs'
import { startBrowser } from './helpers/prototype-browser.mjs'

// 使用隔离临时数据库和演示账号，只验证本机登录，不连接部署机或模型。
const output = path.resolve('.test-artifacts/agent-demo-filter-login')
await mkdir(output, { recursive: true })
const report = {
  testedAt: new Date().toISOString(),
  boundary: '本机隔离服务的真实登录流程；注入已知隐藏规则，不代表安装或验收所有广告扩展。',
  filter: '.ad-field, .ad-context { display: none !important; }',
  modelCalls: 0,
  checks: [],
  failures: [],
}
let server, browser
try {
  server = await isolatedServer()
  assert.equal(new URL(server.origin).hostname, '127.0.0.1')
  process.env.PROTOTYPE_URL = `${server.origin}/agent-demo.html`
  browser = await startBrowser('agent-demo-filter-login')
  await browser.viewport(1280, 900)
  await browser.visible('.workbench-demo-login')
  const inject = `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(report.filter)};document.head.append(s)})()`
  await browser.command('Page.addScriptToEvaluateOnNewDocument', {
    source: `document.addEventListener('DOMContentLoaded',()=>${inject})`,
  })
  await browser.evaluate(inject)
  await browser.fill('[aria-label="用户名"]', 'admin')
  await browser.fill('[aria-label="密码"]', 'Demo123!')
  await browser.clickText('登录')
  await browser.visible('[aria-label="账号菜单"]')
  await browser.visible('.workbench-demo-context')
  report.checks.push('过滤规则生效时，经真实表单登录并显示桌面上下文侧栏')
  await browser.clickText('新建会话')
  await browser.visible('.workbench-demo-new-dialog')
  const form = await browser.evaluate(
    `Array.from(document.querySelectorAll('.workbench-demo-new-dialog .workbench-demo-field')).map(n=>({visible:!!n.getClientRects().length,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height}))`,
  )
  assert(form.length >= 3 && form.every((n) => n.visible && n.width > 0 && n.height > 0))
  report.checks.push('新建会话的表单字段没有被隐藏')
  await browser.screenshot('new-conversation-with-filter')
  await browser.key('Escape', 27)
  await browser.command('Page.reload')
  await browser.visible('[aria-label="账号菜单"]')
  report.checks.push('刷新后登录状态保持')
  await browser.click('[aria-label="账号菜单"]')
  await browser.clickText('退出登录', '[role="menuitem"]')
  await browser.visible('[aria-label="用户名"]')
  report.checks.push('退出后恢复可见登录表单')
  report.assets = await browser.evaluate(
    'Array.from(document.scripts).map(n=>new URL(n.src,location.href).pathname).filter(n=>n.includes("agentDemo-"))',
  )
  report.sourceSha256 = {}
  for (const file of [
    'web/src/agent-demo/App.jsx',
    'web/src/agent-demo/styles.css',
    'agent-demo/server.mjs',
  ])
    report.sourceSha256[file] = createHash('sha256')
      .update(await readFile(file))
      .digest('hex')
} catch (error) {
  report.failures.push(error.stack)
} finally {
  if (browser) {
    report.runtimeErrors = browser.errors
    await browser.close()
  }
  if (server) await server.stop()
  report.temporaryServerAndDataRemoved = !!server
  report.passed = report.failures.length === 0 && !report.runtimeErrors?.length
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({ passed: report.passed, checks: report.checks, failures: report.failures }),
  )
}
if (!report.passed) process.exitCode = 1
