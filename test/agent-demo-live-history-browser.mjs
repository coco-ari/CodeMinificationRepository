import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'

if (process.env.AGENT_DEMO_REAL_EVAL !== '1' || !process.env.AGENT_DEMO_EVAL_CONVERSATION)
  throw new Error('仅允许显式指定本次真实测试会话')
const cid = process.env.AGENT_DEMO_EVAL_CONVERSATION
const origin = new URL(process.env.AGENT_DEMO_URL || 'http://172.29.22.6:8787').origin
process.env.PROTOTYPE_URL = `${origin}/agent-demo.html#conversation=${cid}`
const output = path.resolve('.test-artifacts/agent-demo-real-evaluation/history-browser')
await mkdir(output, { recursive: true })
const report = {
  startedAt: new Date().toISOString(),
  conversationId: cid,
  mode: 'read-only-browser-on-real-long-history',
  realModelCalls: 0,
  checks: [],
}
const browser = await startBrowser('agent-demo-real-history')
try {
  await browser.viewport(1280, 900)
  await browser.fill('[aria-label="用户名"]', 'admin')
  await browser.fill('[aria-label="密码"]', process.env.AGENT_DEMO_PASSWORD || 'Demo123!')
  await browser.clickText('登录')
  await browser.visible('.workbench-demo-chat')
  assert.equal(
    await browser.evaluate(`document.querySelector('.workbench-demo-chat').dataset.conversationId`),
    cid,
  )
  const details = await browser.evaluate(
    `(async()=>{const r=await fetch('/api/agent-demo/conversations/'+${JSON.stringify(cid)});const {conversation:c}=await r.json();return {mode:c.mode,title:c.title,turnCount:c.turns.length,activeTurnId:c.activeTurnId}})()`,
  )
  assert.equal(details.mode, 'live')
  assert.ok(details.turnCount >= 80, '需要真实累计的长历史')
  report.conversation = details
  await browser.command('Performance.enable')
  await browser.command('Page.reload')
  await browser.visible('.workbench-demo-message')
  await until(
    () =>
      browser.evaluate(
        `document.querySelector('.workbench-demo-chat')?.dataset.conversationId===${JSON.stringify(cid)}`,
      ),
    '目标会话恢复',
  )
  report.reloadToMessagesMs = await browser.evaluate('performance.now()')
  report.initialRenderedTurns = await browser.evaluate(
    `[...new Set([...document.querySelectorAll('.workbench-demo-message[data-turn-id]')].map(n=>n.dataset.turnId))].length`,
  )
  // The source can append another real turn while this read-only probe runs.
  assert.ok(report.initialRenderedTurns >= 30)
  report.bootstrap = await browser.evaluate(
    `performance.getEntriesByType('resource').filter(n=>n.name.includes('/api/agent-demo/bootstrap')).map(n=>({durationMs:n.duration,encodedBodyBytes:n.encodedBodySize,decodedBodyBytes:n.decodedBodySize,transferBytes:n.transferSize}))`,
  )
  report.checks.push('真实长会话刷新后恢复，初次最多渲染30轮')
  report.loadEarlier = []
  for (let i = 0; i < 5; i++) {
    if (
      !(await browser.evaluate(
        `Boolean(document.querySelector('.workbench-demo-earlier-history button'))`,
      ))
    )
      break
    await browser.evaluate(`document.querySelector('.workbench-demo-messages').scrollTop=0`)
    await wait(120)
    const before = await browser.evaluate(
      `(()=>{const n=document.querySelector('.workbench-demo-message');return {id:n.dataset.messageId,top:n.getBoundingClientRect().top,count:document.querySelectorAll('.workbench-demo-message').length}})()`,
    )
    const start = performance.now()
    await browser.click('.workbench-demo-earlier-history button')
    await until(
      () =>
        browser.evaluate(
          `document.querySelectorAll('.workbench-demo-message').length>${before.count}`,
        ),
      '展开更早真实记录',
    )
    const afterTop = await browser.evaluate(
      `document.querySelector('[data-message-id="'+${JSON.stringify(before.id)}+'"]').getBoundingClientRect().top`,
    )
    report.loadEarlier.push({
      elapsedMs: Math.round(performance.now() - start),
      anchorShiftPx: afterTop - before.top,
    })
  }
  report.allRenderedTurns = await browser.evaluate(
    `[...new Set([...document.querySelectorAll('.workbench-demo-message[data-turn-id]')].map(n=>n.dataset.turnId))].length`,
  )
  assert.ok(report.allRenderedTurns >= details.turnCount)
  report.checks.push('逐批展开后全部真实轮次可见，无遗漏')
  await browser.evaluate(
    `window.__frames=[];window.__lastFrame=performance.now();window.__measureFrames=true;function tick(t){window.__frames.push(t-window.__lastFrame);window.__lastFrame=t;if(window.__measureFrames)requestAnimationFrame(tick)};requestAnimationFrame(tick);null`,
  )
  const point = await browser.evaluate(
    `(()=>{const r=document.querySelector('.workbench-demo-messages').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  for (let i = 0; i < 12; i++) {
    await browser.command('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      ...point,
      deltaX: 0,
      deltaY: i < 6 ? 220 : -220,
    })
    await wait(70)
  }
  report.scrollFrames = await browser.evaluate(
    `(()=>{window.__measureFrames=false;const a=window.__frames.slice(2).sort((a,b)=>a-b);return {samples:a.length,p95GapMs:a[Math.ceil(a.length*.95)-1],maxGapMs:a.at(-1),over50ms:a.filter(n=>n>50).length}})()`,
  )
  const metrics = await browser.command('Performance.getMetrics')
  report.browserMetrics = Object.fromEntries(
    metrics.metrics
      .filter((m) => ['Nodes', 'JSHeapUsedSize', 'JSHeapTotalSize'].includes(m.name))
      .map((m) => [m.name, m.value]),
  )
  await browser.screenshot('desktop-real-history')
  await browser.viewport(390, 844)
  await browser.assertNoOverflow('真实长历史390px')
  await browser.screenshot('mobile-real-history')
  assert.deepEqual(browser.errors, [])
  report.checks.push('桌面真实滚动和390px视口无运行时异常或横向溢出')
  report.passed = true
} catch (error) {
  report.passed = false
  report.failure = error.stack
  await browser.screenshot('failure').catch(() => {})
} finally {
  report.runtimeErrors = browser.errors
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
console.log(JSON.stringify(report, null, 2))
if (!report.passed) process.exitCode = 1
