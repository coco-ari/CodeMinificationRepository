import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { once } from 'node:events'
import { AUTOOPS_HTML_CSP, isolateBusinessHtml, businessAppToolAllowed, businessAppResourceAllowed } from '../agent-demo/t3-adapters/html-policy.mjs'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'

test('原生富结果保留交互，浏览器实际阻止网络、父窗口存储和嵌套页面访问', async () => {
  let unauthorizedRequests = 0
  const server = http.createServer((req, res) => {
    if (req.url === '/private') { unauthorizedRequests++; return res.end('secret') }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': AUTOOPS_HTML_CSP })
    res.end(isolateBusinessHtml(`<button onclick="this.textContent='已交互'">交互</button><iframe src="/private"></iframe><script>fetch('/private').catch(()=>{});window.storageBlocked=false;try{localStorage.setItem('leak','1')}catch{window.storageBlocked=true}</script>`))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button', { name: '交互', exact: true }).click()
    assert.equal(await page.getByRole('button').innerText(), '已交互')
    assert.equal(await page.evaluate(() => window.storageBlocked), true)
    assert.equal(unauthorizedRequests, 0)
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)) }
})

test('MCP App 的实际 server/tool/resource 均在业务白名单核对', () => {
  assert.equal(businessAppToolAllowed('t3-code', 'query_environment'), true)
  assert.equal(businessAppToolAllowed('external', 'query_environment'), false)
  assert.equal(businessAppToolAllowed('t3-code', 'shell'), false)
  assert.equal(businessAppToolAllowed('t3-code', 'create_report'), false)
  assert.equal(businessAppResourceAllowed('t3-code', 'ui://autoops/status/view.html'), true)
  for (const uri of ['file:///etc/passwd', 'https://remote.example/app', 'ui://autoops/../secret', 'ui://other/app'])
    assert.equal(businessAppResourceAllowed('t3-code', uri), false)
})
