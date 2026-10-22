import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

if (process.env.T3_UI_LIVE !== '1') throw Error('T3_UI_LIVE=1 required for real browser verification.')
const origin = new URL(process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').origin
const production = origin === 'http://172.29.22.6:8787' && process.env.T3_MOTION_PRODUCTION_SMOKE === '1'
assert(new URL(origin).port === '18887' || production, 'Use stage or explicitly enable the reported production origin.')
const output = path.resolve(process.env.T3_MOTION_OUTPUT || `.test-artifacts/t3-lite/motion-preference-${Date.now()}`)
await mkdir(output, { recursive: true })
const client = new T3LiveClient(origin), report = { origin, startedAt: new Date().toISOString(), matrix: [], pageErrors: [] }
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce', recordVideo: { dir: output } })
const page = await context.newPage()
page.setDefaultTimeout(30000)
page.on('pageerror', error => report.pageErrors.push(error.message))
const terminal = value => ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status)
const labels = { system: '跟随系统', on: '开启动效', off: '关闭动效' }
let threadId, threadUrl
const appearance = async () => {
  await page.goto(origin + '/agent-demo.html#/settings/appearance')
  await page.getByRole('combobox', { name: '界面动效', exact: true }).waitFor()
}
async function choose(mode) {
  const control = page.getByRole('combobox', { name: '界面动效', exact: true })
  await control.click()
  await page.getByRole('option', { name: labels[mode], exact: true }).click()
  await page.waitForFunction(value => document.documentElement.dataset.motionPreference === value, mode)
  assert((await control.innerText()).includes(labels[mode]))
}
async function resolved(mode, reduced) {
  await page.waitForFunction(({ mode, reduced }) => document.documentElement.dataset.motionPreference === mode && document.documentElement.dataset.reducedMotion === String(reduced), { mode, reduced })
}
const activity = () => page.evaluate(() => [...document.querySelectorAll('.live-activity-focus,.live-tool-shine')].map(element => {
  const style = getComputedStyle(element)
  return { text: element.textContent?.trim(), name: style.animationName, state: style.animationPlayState, time: element.getAnimations()[0]?.currentTime ?? null, transform: style.transform, background: style.backgroundPosition }
}))
async function moving() {
  await page.waitForFunction(() => [...document.querySelectorAll('.live-activity-focus,.live-tool-shine')].some(element => getComputedStyle(element).animationPlayState === 'running' && element.getAnimations().some(animation => typeof animation.currentTime === 'number' && animation.currentTime > 0)))
  const before = await activity()
  await page.waitForTimeout(400)
  const after = await activity()
  assert(after.some(item => before.some(prior => item.text === prior.text && typeof item.time === 'number' && typeof prior.time === 'number' && item.time > prior.time + 100 && (item.transform !== prior.transform || item.background !== prior.background))), 'Native activity must visibly advance while the system requests reduced motion.')
  return { before, after }
}
try {
  await client.login(); await client.connect()
  assert.equal(client.bootstrap.productProfile?.id, 'project-assistant-lite-v1')
  await page.goto(origin + '/agent-demo.html#/settings/appearance')
  await page.getByRole('textbox', { name: '用户名' }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('combobox', { name: '界面动效', exact: true }).waitFor({ timeout: 60000 })
  for (const systemReduced of [true, false]) {
    await page.emulateMedia({ reducedMotion: systemReduced ? 'reduce' : 'no-preference' })
    for (const mode of ['system', 'on', 'off']) {
      await choose(mode)
      const expected = mode === 'off' || (mode === 'system' && systemReduced)
      await resolved(mode, expected)
      report.matrix.push({ systemReduced, mode, resolvedReduced: expected })
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await choose('on'); await page.reload(); await resolved('on', false)
  assert((await page.getByRole('combobox', { name: '界面动效', exact: true }).innerText()).includes('开启动效'))
  report.onPersistsAcrossReload = true
  await choose('off'); await page.reload(); await resolved('off', true)
  report.offPersistsAcrossReload = true
  await choose('system'); await resolved('system', true)
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await resolved('system', false)
  await page.emulateMedia({ reducedMotion: 'reduce' }); await resolved('system', true)
  report.systemChangesApplyLive = true
  await choose('on')
  const search = page.getByRole('combobox', { name: '搜索设置', exact: true })
  await search.fill('界面动效')
  await page.getByRole('option').filter({ hasText: '界面动效' }).first().click()
  await page.getByRole('combobox', { name: '界面动效', exact: true }).waitFor()
  report.settingsSearchWorks = true
  await page.getByRole('group', { name: '外观模式', exact: true }).getByRole('button', { name: '使用深色模式', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
  await page.screenshot({ path: path.join(output, 'appearance-dark.png') })
  await page.getByRole('group', { name: '外观模式', exact: true }).getByRole('button', { name: '使用浅色模式', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('combobox', { name: '界面动效', exact: true }).scrollIntoViewIfNeeded()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  assert.equal(overflow, false)
  await page.screenshot({ path: path.join(output, 'appearance-mobile.png') })
  await page.setViewportSize({ width: 1360, height: 900 })
  await page.screenshot({ path: path.join(output, 'appearance-on.png') })

  const config = await client.rpc('server.getConfig')
  threadId = randomUUID(); report.threadId = threadId
  await client.http('/autoops/thread-bindings', 'POST', { threadId, projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'private' })
  await client.rpc('orchestration.launchThread', { commandId: randomUUID(), threadId, projectId: 'p-autoops', title: '独立动效真实验收（自动清理）', generateTitle: false, modelSelection: client.bootstrap.fixedModel, runtimeMode: 'approval-required', interactionMode: 'default', workspaceStrategy: { type: 'root' } })
  threadUrl = `${origin}/agent-demo.html#/${config.environment.environmentId}/${threadId}`
  await page.goto(threadUrl)
  const editor = page.getByTestId('composer-editor')
  await editor.waitFor()
  // The scope here is animation preferences. Use the native command to start
  // the real turn without racing a freshly mounted empty composer hydration.
  await client.send(threadId, '这是界面动效真实验收。请实际读取当前项目的环境检查手册，然后用中文分24项详细说明测试环境检查步骤，每项至少80字。只读取并分析，不执行变更、不生成文件、不提问。')
  report.realThinkingWithSystemOff = await moving()
  await page.screenshot({ path: path.join(output, 'system-off-app-on.png') })
  await appearance(); await choose('off'); await page.goto(threadUrl)
  await page.getByRole('button', { name: '停止生成', exact: true }).waitFor()
  await resolved('off', true)
  await page.waitForFunction(() => [...document.querySelectorAll('.live-activity-focus')].some(element => getComputedStyle(element).animationName === 'none') || [...document.querySelectorAll('.live-tool-shine')].some(element => getComputedStyle(element).animationName === 'none'))
  report.disabledDuringSameRun = await activity()
  await appearance(); await choose('on'); await page.goto(threadUrl)
  report.reenabledDuringSameRun = await moving()
  const projection = await client.projection(threadId)
  assert.equal(projection.runs.length, 1, 'Changing appearance must not restart or submit another model turn.')
  report.singleNativeRun = true
  assert.deepEqual(report.pageErrors, [])
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error.message; report.detail = error.detail; process.exitCode = 1
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
} finally {
  if (threadId) {
    try {
      let projection = await client.projection(threadId)
      if (projection.runs.some(run => !terminal(run))) await client.rpc('orchestration.dispatchCommand', { type: 'thread.stop', threadId, commandId: randomUUID() })
      const deadline = Date.now() + 45000
      do {
        projection = await client.projection(threadId)
        if (projection.runs.every(terminal) && projection.providerTurns.every(terminal)) break
        await new Promise(resolve => setTimeout(resolve, 200))
      } while (Date.now() < deadline)
      assert(projection.runs.every(terminal) && projection.providerTurns.every(terminal))
      await client.rpc('orchestration.dispatchCommand', { type: 'thread.delete', threadId, commandId: randomUUID() })
      report.testThreadDeleted = true
    } catch (error) { report.cleanupError = error.message; process.exitCode = 1 }
  }
  client.close()
  const video = page.video()
  await context.close(); report.video = await video?.path(); await browser.close()
  report.completedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
