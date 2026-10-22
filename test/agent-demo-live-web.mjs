import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'
import { clickComposerAction } from './helpers/agent-demo-composer.mjs'

if (process.env.AGENT_DEMO_LIVE_WEB !== '1' || !process.env.AGENT_DEMO_URL)
  throw new Error('真实模型网页验收需显式设置 AGENT_DEMO_LIVE_WEB=1 和 AGENT_DEMO_URL')
process.env.PROTOTYPE_URL = process.env.AGENT_DEMO_URL
const report = {
  startedAt: new Date().toISOString(),
  mode: 'real-grok-browser',
  checks: [],
  failures: [],
}
const browser = await startBrowser(process.env.AGENT_DEMO_LIVE_WEB_NAME || 'agent-demo-live-web')
let csrf, cid
const q = JSON.stringify
async function api(endpoint, method = 'GET', body) {
  const result = await browser.evaluate(
    `(async()=>{const r=await fetch('/api/agent-demo'+${q(endpoint)},{method:${q(method)},headers:{'Content-Type':'application/json','X-Demo-CSRF':${q(csrf || '')}},${body ? `body:JSON.stringify(${q(body)}),` : ''}});return {status:r.status,data:await r.json()}})()`,
  )
  assert.ok(result.status < 300, JSON.stringify(result))
  return result.data
}
const read = async () => (await api(`/conversations/${cid}`)).conversation
async function untilConversation(predicate, label) {
  return until(
    async () => {
      const c = await read()
      return predicate(c) && c
    },
    label,
    2400,
  )
}
try {
  await browser.viewport(1280, 900)
  await browser.fill('[aria-label="用户名"]', 'admin')
  await browser.fill('[aria-label="密码"]', process.env.AGENT_DEMO_PASSWORD || 'Demo123!')
  await browser.clickText('登录')
  await browser.visible('[aria-label="账号菜单"]')
  const boot = await api('/bootstrap')
  csrf = boot.csrf
  assert.equal(boot.runtime.liveAvailable, true)
  report.runtime = boot.runtime
  report.health = await api('/health')
  report.assets = await browser.evaluate(
    "Array.from(document.scripts).map(n=>n.src).filter(n=>n.includes('agentDemo-'))",
  )
  const created = await api('/conversations', 'POST', {
    projectId: 'p-autoops',
    environmentId: 'env-test',
    agentId: 'a-project',
    mode: 'live',
    visibility: 'private',
    title: 'Grok 网页交互验收',
  })
  cid = created.conversation.id
  await browser.evaluate(`location.hash='conversation=${cid}'`)
  await browser.visible('[aria-label="输入问题"]')
  await until(
    () =>
      browser.evaluate(
        "Boolean(document.querySelector('.workbench-demo-global-connection .is-connected'))",
      ),
    '事件连接',
  )
  await browser.evaluate(
    `window.__liveUx={started:performance.now(),firstTextMs:null,mutations:0};const observer=new MutationObserver(()=>{const n=document.querySelector('.is-assistant .workbench-demo-markdown');if(n?.textContent.trim()&&window.__liveUx.firstTextMs===null)window.__liveUx.firstTextMs=performance.now()-window.__liveUx.started;window.__liveUx.mutations++});observer.observe(document.querySelector('.workbench-demo-message-column'),{subtree:true,childList:true,characterData:true});null`,
  )
  await browser.fill(
    '[aria-label="输入问题"]',
    '这是一次真实网页交互验收。先读取项目设计资料和环境检查手册，然后必须调用 ask_user 询问“输出详细还是简要？”，选项是“详细”和“简要”，等待我的回答后再继续。收到回答后查询测试环境，输出约600字的中文检查说明，含一个5行的Markdown表格和一个JSON代码块。不创建报告，不执行写操作。',
  )
  await browser.evaluate('window.__liveUx.started=performance.now();null')
  await browser.click('[aria-label="发送"]')
  await browser.visible('.workbench-demo-live-state')
  await browser.screenshot('waiting-for-model')
  const waiting = await untilConversation((c) => c.status === 'waiting', 'Grok 提出澄清问题')
  const firstTurnId = waiting.activeTurnId
  report.checks.push('真实 Grok 读取资料并调用澄清工具，网页及时显示执行活动和问题')
  await browser.fill(
    '[aria-label="输入问题"]',
    '补充本轮要求：只分析测试环境，用中文，结论放在最前面。',
  )
  await clickComposerAction(browser, 'steer')
  await untilConversation((c) => c.turns[0].guidance.length > 0, '真实引导已接收')
  await browser.fill('[aria-label="澄清回答"]', '详细')
  await browser.clickText('提交并继续')
  await untilConversation((c) => c.turns[0].question.status === 'answered', '澄清回答已接收')
  await browser.fill(
    '[aria-label="输入问题"]',
    '请继续读取项目资料，逐项复核所有检查点，最后列出详细的环境核查清单。',
  )
  await clickComposerAction(browser, 'queue')
  await untilConversation((c) => c.queue.length > 0 || c.turns.length > 1, '下一轮进入队列')
  report.checks.push('澄清期间真实同轮引导成功，回答后继续执行并接受下一轮队列')
  await browser.screenshot('question-and-guidance')
  const second = await untilConversation(
    (c) => c.turns.length > 1 && c.turns[1].runnerTurnId,
    '首轮完成且队列启动',
  )
  assert.equal(second.turns[0].status, 'completed')
  await browser.click('[aria-label="停止生成"]')
  const stopped = await untilConversation((c) => !c.activeTurnId, '真实停止完成')
  assert.equal(stopped.turns[1].status, 'interrupted')
  assert.equal(stopped.turns[0].id, firstTurnId)
  assert.ok(stopped.turns[0].timeline.some((part) => part.type === 'tool'))
  assert.ok(stopped.turns[0].timeline.some((part) => part.type === 'text'))
  assert.equal(stopped.turns[0].question.status, 'answered')
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-markdown table') && document.querySelector('.workbench-demo-code-block')",
      ),
    '真实Markdown表格和代码',
  )
  report.checks.push('首轮真实回答完成，表格和代码可读；服务器自动启动队列，网页停止成功')
  const texts = await browser.evaluate(
    "Array.from(document.querySelectorAll('.workbench-demo-message')).map(n=>({id:n.dataset.messageId,text:n.textContent}))",
  )
  const steerIndex = texts.findIndex((row) => row.text.includes('补充本轮要求：'))
  const answerIndex = texts.findIndex((row) => row.text.includes('补充回答'))
  assert.ok(steerIndex >= 0 && answerIndex > steerIndex)
  assert.ok(texts.slice(answerIndex + 1).some((row) => row.text.includes('项目助手')))
  report.timings = await browser.evaluate('window.__liveUx')
  report.turns = stopped.turns.map((turn) => ({
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    steps: turn.steps.map((s) => ({ name: s.name, status: s.status })),
    timeline: turn.timeline.map((p) => ({
      id: p.id,
      type: p.type,
      characters: p.text?.length,
      messagePhase: p.messagePhase,
    })),
    usage: turn.usage || null,
  }))
  report.reasoningReturned = stopped.turns.some((turn) =>
    turn.timeline.some((part) => part.type === 'reasoning' && part.text),
  )
  report.usageReturned = stopped.turns.some((turn) => Number.isFinite(turn.usage?.totalTokens))
  await browser.screenshot('desktop-real-completed')
  await browser.viewport(390, 844)
  await wait(200)
  await browser.screenshot('mobile-real-completed')
  await browser.command('Page.reload')
  await browser.visible('[aria-label="输入问题"]')
  await until(
    () =>
      browser.evaluate("document.querySelectorAll('.workbench-demo-activity-toggle').length > 0"),
    '刷新恢复活动',
  )
  await browser.evaluate(
    "document.querySelectorAll('.workbench-demo-activity-toggle[aria-expanded=false]').forEach(node => node.click())",
  )
  await until(
    () =>
      browser.evaluate(
        "[...document.querySelectorAll('.workbench-demo-question-history')].some(node => node.textContent.includes('已回答'))",
      ),
    '刷新恢复真实历史',
  )
  report.checks.push('真实引导、问题、回答和续文顺序正确，桌面/手机可见，刷新后保留')
} catch (error) {
  report.failures.push(error.stack)
  await browser.screenshot('failure').catch(() => {})
} finally {
  if (cid) {
    try {
      const current = await read()
      if (current.activeTurnId)
        await api(`/conversations/${cid}/stop`, 'POST', {
          requestId: crypto.randomUUID(),
          expectedTurnId: current.activeTurnId,
        })
      await untilConversation((c) => !c.activeTurnId, '清理前停止')
      await api(`/conversations/${cid}`, 'DELETE')
      report.onlyTestConversationRemoved = true
    } catch (error) {
      report.cleanupError = error.message
    }
  }
  report.runtimeErrors = browser.errors
  report.passed = !report.failures.length && !browser.errors.length && !report.cleanupError
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(browser.output, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
console.log(JSON.stringify(report, null, 2))
if (!report.passed) process.exitCode = 1
