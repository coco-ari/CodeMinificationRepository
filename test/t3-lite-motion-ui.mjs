import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

if (process.env.T3_UI_LIVE !== '1') throw Error('T3_UI_LIVE=1 is required for the configured-model check.')
const origin = new URL(process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').origin
const production = origin === 'http://172.29.22.6:8787' && process.env.T3_MOTION_PRODUCTION_SMOKE === '1'
assert(new URL(origin).port === '18887' || production, 'Production requires an explicit smoke-test gate for the reported ZeroTier origin.')
const fullTurn = process.env.T3_MOTION_FULL_TURN === '1'
const output = path.resolve(process.env.T3_LITE_MOTION_OUTPUT || `.test-artifacts/t3-lite/motion-${Date.now()}`)
await mkdir(output, { recursive: true })
const client = new T3LiveClient(origin)
const report = { origin, production, startedAt: new Date().toISOString(), pageErrors: [], samples: [], processSamples: [] }
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-CN', reducedMotion: 'no-preference', recordVideo: { dir: output } })
const page = await context.newPage()
page.setDefaultTimeout(45000)
page.on('pageerror', error => report.pageErrors.push(error.message))
const terminal = run => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
const command = (type) => client.rpc('orchestration.dispatchCommand', { type, threadId, commandId: randomUUID() })
let threadId
try {
  await client.login(); await client.connect()
  assert.equal(client.bootstrap.productProfile?.id, 'project-assistant-lite-v1')
  if (production) report.existingThreadIds = (await client.http('/api/orchestration/shell')).threads.map(thread => thread.id)
  const config = await client.rpc('server.getConfig')
  threadId = randomUUID()
  report.threadId = threadId
  await client.http('/autoops/thread-bindings', 'POST', { threadId, projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'private' })
  await client.rpc('orchestration.launchThread', { commandId: randomUUID(), threadId, projectId: 'p-autoops', title: '等待动效验收（自动清理）', generateTitle: false, modelSelection: client.bootstrap.fixedModel, runtimeMode: 'approval-required', interactionMode: 'default', workspaceStrategy: { type: 'root' } })
  await page.goto(`${origin}/agent-demo.html#/${config.environment.environmentId}/${threadId}`)
  await page.getByRole('textbox', { name: '用户名' }).fill('admin')
  await page.getByLabel('密码', { exact: true }).fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const editor = page.getByTestId('composer-editor')
  await editor.waitFor()
  report.scripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')))
  await editor.fill('这是等待动效验收。请先实际读取当前项目的环境检查手册，再用中文概述检查步骤，明确不执行任何环境变更。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const moving = () => page.evaluate(() => {
    const elements = [...document.querySelectorAll('.live-activity-focus')]
    return elements.map(element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect()
      return { text: element.textContent?.trim(), name: style.animationName, state: style.animationPlayState, duration: style.animationDuration, opacity: style.opacity, transform: style.transform, time: element.getAnimations()[0]?.currentTime ?? null, visible: rect.bottom > 0 && rect.top < innerHeight }
    })
  })
  await page.waitForFunction(() => [...document.querySelectorAll('.live-activity-focus')].some(element => getComputedStyle(element).animationPlayState === 'running' && element.getAnimations().some(animation => animation.currentTime > 0)))
  const before = await moving()
  report.samples.push({ kind: 'before', elements: before })
  assert(before.some(item => item.visible && item.name === 'live-activity-focus' && item.state === 'running'))
  await page.screenshot({ path: path.join(output, 'thinking-before.png') })
  // Sample the real animation clock again, without synthesizing activity events.
  await page.waitForTimeout(500)
  const after = await moving()
  report.samples.push({ kind: 'after', elements: after })
  assert(after.some(item => before.some(prior => prior.text === item.text && typeof prior.time === 'number' && typeof item.time === 'number' && item.time > prior.time + 100 && item.transform !== prior.transform)), 'Visible activity must actually move, not only have an animation class.')
  await page.screenshot({ path: path.join(output, 'thinking-after.png') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(() => [...document.querySelectorAll('.live-activity-focus')].some(element => getComputedStyle(element).animationName === 'none' && getComputedStyle(element).opacity === '0'))
  report.samples.push({ kind: 'reduced-motion', elements: await moving() })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(() => [...document.querySelectorAll('.live-activity-focus')].some(element => getComputedStyle(element).animationPlayState === 'running' && getComputedStyle(element).animationName === 'live-activity-focus'))
  report.samples.push({ kind: 'motion-restored', elements: await moving() })
  if (fullTurn) {
    const deadline = Date.now() + 210000
    let finished = false
    const seen = new Set()
    while (Date.now() < deadline) {
      const sample = await page.evaluate(() => ({
        at: Date.now(),
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        forcedColors: matchMedia('(forced-colors: active)').matches,
        visibility: document.visibilityState,
        activity: [...document.querySelectorAll('.live-activity-focus,.live-tool-shine,.visible-animate-spin')].map(element => {
          const style = getComputedStyle(element), rect = element.getBoundingClientRect()
          return { kind: element.classList.contains('live-tool-shine') ? 'tool-or-reasoning' : 'thinking', text: element.textContent?.trim().slice(0, 140), name: style.animationName, state: style.animationPlayState, time: element.getAnimations()[0]?.currentTime ?? null, color: style.color, background: style.backgroundImage, visible: rect.bottom > 0 && rect.top < innerHeight }
        }),
        hasStop: !!document.querySelector('[aria-label="停止生成"]'),
      }))
      report.processSamples.push(sample)
      for (const item of sample.activity) {
        const key = item.kind + ':' + item.text
        if (!seen.has(key)) {
          seen.add(key)
          await page.screenshot({ path: path.join(output, `phase-${seen.size}.png`) })
        }
      }
      const projection = await client.projection(threadId)
      if (projection.runs.length && projection.runs.every(terminal) && projection.providerTurns.every(terminal)) {
        report.finalRuns = projection.runs.map(({ id, status }) => ({ id, status }))
        report.toolItems = projection.turnItems.filter(item => item.type === 'dynamic_tool').map(({ toolName, status }) => ({ toolName, status }))
        report.reasoningItems = projection.turnItems.filter(item => item.type === 'reasoning').length
        assert(projection.runs.every(run => run.status === 'completed'), 'The full real-model round must complete.')
        finished = true
        break
      }
      await page.waitForTimeout(750)
    }
    assert(finished, 'The full real-model round did not finish within the observation window.')
    await page.screenshot({ path: path.join(output, 'completed.png') })
  }
  assert.deepEqual(report.pageErrors, [])
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error.message; report.detail = error.detail; process.exitCode = 1
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
} finally {
  if (threadId) {
    try {
      let projection = await client.projection(threadId)
      if (projection.runs.some(run => !terminal(run))) await command('thread.stop')
      const deadline = Date.now() + 45000
      do {
        projection = await client.projection(threadId)
        if (projection.runs.every(terminal) && projection.providerTurns.every(turn => terminal(turn))) break
        await new Promise(resolve => setTimeout(resolve, 200))
      } while (Date.now() < deadline)
      assert(projection.runs.every(terminal) && projection.providerTurns.every(turn => terminal(turn)), 'Owned test run must terminate before deletion.')
      await command('thread.delete'); report.testThreadDeleted = true
      if (production) {
        const after = (await client.http('/api/orchestration/shell')).threads.map(thread => thread.id)
        assert(report.existingThreadIds.every(id => after.includes(id)), 'Original visible threads must remain present.')
        report.originalThreadsPreserved = true
      }
    } catch (error) { report.cleanupError = error.message; process.exitCode = 1 }
  }
  client.close()
  const video = page.video()
  await context.close()
  report.video = await video?.path()
  await browser.close()
  report.completedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, processSamples: report.processSamples.length }))
}
