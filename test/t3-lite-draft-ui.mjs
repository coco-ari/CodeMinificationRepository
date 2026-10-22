import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

const origin = process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887'
assert.equal(new URL(origin).port, '18887', 'Only isolated acceptance data')
const output = '.test-artifacts/t3-lite/draft-stage'
await mkdir(output, { recursive: true })
const c = new T3LiveClient(origin), browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage()
const report = { origin, kind: 'real-native-empty-thread-no-model', pageErrors: [], modelRequests: [] }
page.on('pageerror', error => report.pageErrors.push(error.message))
page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
  try { const f = JSON.parse(String(payload)); if (f.tag === 'orchestration.dispatchCommand' && f.payload?.type === 'message.dispatch') report.modelRequests.push(f.payload.type) } catch {}
}))
const normalize = value => value.trim().replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n')
const text = `未发送中文草稿 ${randomUUID().slice(0, 8)}：保留换行与标点。\n下一步先核对资料。`
const editor = page.getByTestId('composer-editor')
async function readRestored() {
  await editor.waitFor({ timeout: 45000 })
  await page.waitForFunction(first => document.querySelector('[data-testid="composer-editor"]')?.textContent.includes(first), text.split('\n')[0])
  const value = await editor.innerText()
  assert.equal(normalize(value), text)
  return value
}
let threadId
try {
  await c.login(); await c.connect()
  const config = await c.rpc('server.getConfig'), environmentId = config.environment.environmentId
  threadId = randomUUID()
  await c.http('/autoops/thread-bindings', 'POST', { threadId, projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'private' })
  await c.rpc('orchestration.launchThread', { commandId: randomUUID(), threadId, projectId: 'p-autoops', title: '精简草稿验收（无模型，自动清理）', generateTitle: false, modelSelection: c.bootstrap.fixedModel, runtimeMode: 'approval-required', interactionMode: 'default', workspaceStrategy: { type: 'root' } })
  const url = `${origin}/agent-demo.html#/${environmentId}/${threadId}`
  await page.goto(url)
  await page.getByRole('textbox', { name: '用户名' }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await editor.waitFor({ timeout: 60000 })
  await editor.fill(text); await editor.blur()
  report.inputDomText = await editor.innerText()
  assert.equal(normalize(report.inputDomText), text)
  await page.goto(origin + '/agent-demo.html#/settings/general')
  await page.getByText('当前配置', { exact: true }).waitFor()
  await page.goto(url); report.afterSwitchDomText = await readRestored()
  await page.reload(); report.afterReloadDomText = await readRestored()
  await page.screenshot({ path: output + '/restored.png' })
  const projection = await c.projection(threadId)
  assert.equal(projection.runs.length, 0); assert.equal(projection.messages.length, 0)
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.modelRequests, [])
  report.status = 'passed'; report.multilineContentPreserved = true; report.nativeRuns = 0
} catch (error) { report.status = 'failed'; report.error = error.message; report.detail = error.detail; process.exitCode = 1 }
finally {
  if (threadId) {
    try { await c.rpc('orchestration.dispatchCommand', { type: 'thread.delete', commandId: randomUUID(), threadId }); report.testThreadDeleted = true }
    catch (error) { report.cleanupError = error.message; process.exitCode = 1 }
  }
  await writeFile(output + '/report.json', JSON.stringify(report, null, 2)); c.close(); await browser.close()
  console.log(JSON.stringify(report))
}
