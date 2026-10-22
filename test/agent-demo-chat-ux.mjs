import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'
import { clickComposerAction } from './helpers/agent-demo-composer.mjs'

// Deterministic end-to-end UI timing checks with real HTTP/SSE and an explicit fake runner.
// This does not claim model latency or subjective fluency measurements.
const report = { mode: 'controlled-bridge-browser', realModelCalls: 0, checks: [], failures: [] }
const runs = new Map()
const sockets = new Set()
let browser, child, origin, csrf, conversation
const data = await mkdtemp(path.join(os.tmpdir(), 'autoops-chat-ux-'))
const json = (res, body) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const emit = (run, event) => run.res.write(`data: ${JSON.stringify(event)}\n\n`)
const bridge = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}
  if (req.url === '/health')
    return json(res, { liveAvailable: true, name: '交互测试运行器', capabilities: ['steer'] })
  if (req.url === '/runs') {
    runs.set(body.runId, { ...body })
    return json(res, { ok: true })
  }
  const [, id, action] = req.url.match(/^\/runs\/([^/]+)\/(events|steer|answer|stop)$/) || []
  const run = runs.get(id)
  if (!run) {
    res.writeHead(404)
    return res.end()
  }
  if (action === 'events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    run.res = res
    emit(run, { type: 'started', runnerThreadId: id, runnerTurnId: id })
    return
  }
  if (action === 'steer') {
    emit(run, { type: 'delta', itemId: 'long', text: '\n\n已按补充指令调整。\n\n' })
    await wait(250)
  }
  if (action === 'answer') {
    emit(run, { type: 'delta', itemId: 'answer', text: '\n\n收到澄清，继续检查。\n\n' })
    await wait(100)
  }
  json(res, { accepted: true })
  if (action === 'stop') {
    await wait(500)
    emit(run, { type: 'interrupted' })
    run.res.end()
  }
})
bridge.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})
await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve))
const q = JSON.stringify
async function api(endpoint, method = 'GET', body) {
  const result = await browser.evaluate(
    `(async()=>{const r=await fetch('/api/agent-demo'+${q(endpoint)},{method:${q(method)},headers:{'Content-Type':'application/json','X-Demo-CSRF':${q(csrf || '')}},${body ? `body:JSON.stringify(${q(body)}),` : ''}});return {status:r.status,data:await r.json()}})()`,
  )
  assert.ok(result.status < 300, JSON.stringify(result))
  return result.data
}
const geometry = () =>
  browser.evaluate(
    `(()=>{const n=document.querySelector('.workbench-demo-messages');return {top:n.scrollTop,height:n.scrollHeight,client:n.clientHeight,gap:n.scrollHeight-n.clientHeight-n.scrollTop}})()`,
  )
try {
  child = spawn(process.execPath, ['agent-demo/server.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: data,
      AGENT_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (chunk) => {
    logs += chunk
    const match = logs.match(/"port":(\d+)/)
    if (match) origin = `http://127.0.0.1:${match[1]}`
  })
  child.stderr.on('data', (chunk) => {
    logs += chunk
  })
  await until(() => origin, '测试服务启动')
  process.env.PROTOTYPE_URL = `${origin}/agent-demo.html`
  browser = await startBrowser('agent-demo-chat-ux')
  await browser.viewport(1280, 900)
  await browser.fill('[aria-label="用户名"]', 'admin')
  await browser.fill('[aria-label="密码"]', 'Demo123!')
  await browser.clickText('登录')
  await browser.visible('[aria-label="账号菜单"]')
  const boot = await api('/bootstrap')
  csrf = boot.csrf
  report.testedAt = new Date().toISOString()
  report.serverHealth = await api('/health')
  report.buildAssets = await browser.evaluate(
    'Array.from(document.scripts).map((node) => node.src).filter(Boolean)',
  )
  conversation = (
    await api('/conversations', 'POST', {
      projectId: 'p-autoops',
      environmentId: 'env-test',
      agentId: 'a-project',
      mode: 'live',
      visibility: 'private',
      title: '流式交互验收',
    })
  ).conversation
  await browser.evaluate(`location.hash='conversation=${conversation.id}'`)
  await browser.visible('[aria-label="输入问题"]')
  await until(
    () =>
      browser.evaluate(
        "Boolean(document.querySelector('.workbench-demo-global-connection .is-connected'))",
      ),
    '事件连接',
  )
  await browser.fill('[aria-label="输入问题"]', '检查中文长回复的交互')
  await browser.click('[aria-label="发送"]')
  const run = await until(() => [...runs.values()].find((run) => run.res), '运行器接收')
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-live-state [role=status]')?.textContent === '正在处理'",
      ),
    '上游工作状态提示',
  )
  await wait(12500)
  const waitingStatus = await browser.evaluate(
    "(()=>{const n=document.querySelector('.workbench-demo-live-state');return {text:n?.textContent,time:Boolean(n?.querySelector('time')),label:n?.querySelector('[role=status]')?.getAttribute('aria-label')}})()",
  )
  assert.deepEqual(
    waitingStatus,
    { text: '正在处理', time: false, label: '正在处理' },
    '缺少新事件不生成计时或 12 秒静默提示',
  )
  report.checks.push('首段到达前显示正在处理，持续静默超过 12 秒也不生成计时或假状态')
  emit(run, { type: 'delta', itemId: 'intro', text: '第一段中文说明。' })
  await until(async () => {
    const { conversation: value } = await api(`/conversations/${conversation.id}`)
    return value.turns[0].timeline.at(-1)?.text === '第一段中文说明。'
  }, '无边界文本已通过真实 SSE 到达服务端')
  await wait(180)
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-messages')?.textContent.includes('第一段中文说明。')",
    ),
    false,
    '未完成块应按 OpenChamber 策略暂缓显示',
  )
  const arrival = performance.now()
  emit(run, { type: 'delta', itemId: 'intro', text: '\n\n' })
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-messages')?.textContent.includes('第一段中文说明。')",
      ),
    '首段呈现',
  )
  report.completedBlockVisibleMs = performance.now() - arrival
  assert.ok(report.completedBlockVisibleMs < 800, '已完成的块应及时提交到页面')
  report.checks.push('无边界段落保留，完成段落边界后及时显示；测量值仅为受控渲染延迟')
  const document = run.context.documents[0]
  assert.ok(document?.id && document?.name && document?.content, '使用真实传给运行器的授权项目资料')
  emit(run, {
    type: 'tool',
    id: 'read',
    name: 'read_project_document',
    input: { id: document.id },
    status: 'running',
  })
  await wait(120)
  emit(run, {
    type: 'tool',
    id: 'read',
    name: 'read_project_document',
    status: 'completed',
    output: { id: document.id, name: document.name, content: document.content },
  })
  await browser.visible(`[data-step-id="read"] [aria-label=${q(`查看文件 ${document.name}`)}]`)
  assert.equal(
    await browser.evaluate(
      "document.querySelector('[data-step-id=read]').classList.contains('is-static')",
    ),
    true,
    '有资料目标的 read 使用上游静态文件行',
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('[data-step-id=read] [aria-expanded]') !== null",
    ),
    false,
    '静态 read 不再出现参数与结果折叠层',
  )
  await browser.evaluate(
    "window.__firstParagraph=document.querySelector('.is-assistant .workbench-demo-markdown p');null",
  )
  emit(run, { type: 'delta', itemId: 'long', text: '## 检查结果\n\n' })
  await wait(180)
  assert.equal(
    await browser.evaluate(
      "Array.from(document.querySelectorAll('.workbench-demo-markdown h2')).some(n=>n.textContent==='检查结果')",
    ),
    false,
    '标题等待后续内容块完成，不单独闪出',
  )
  for (let i = 0; i < 25; i++) {
    emit(run, {
      type: 'delta',
      itemId: 'long',
      text: `第 ${i + 1} 项检查：中文流式内容应该稳定保留，用户可以向上阅读已有资料。检查环境与项目记录。\n\n`,
    })
    await wait(35)
  }
  await until(async () => (await geometry()).gap < 8, '流式跟随到底部')
  assert.equal(await browser.evaluate('window.__firstParagraph.isConnected'), true)
  const order = await browser.evaluate(
    "Array.from(document.querySelectorAll('[data-part-type]')).map(n=>n.dataset.partType)",
  )
  assert.deepEqual(order, ['text', 'tool', 'text'])
  assert.ok(
    await browser.evaluate(
      "Array.from(document.querySelectorAll('.workbench-demo-markdown h2')).some(n=>n.textContent==='检查结果')",
    ),
    '标题与完成的正文块一起显示',
  )
  report.checks.push(
    '静态 read 显示资料名；文字、工具、回答保持事件顺序，完成块 DOM 不随新增内容重建',
  )
  const point = await browser.evaluate(
    "(()=>{const r=document.querySelector('.workbench-demo-messages').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()",
  )
  await browser.command('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...point,
    deltaX: 0,
    deltaY: -500,
  })
  await wait(150)
  const reading = await geometry()
  for (let i = 0; i < 12; i++) {
    emit(run, {
      type: 'delta',
      itemId: 'long',
      text: `继续新增第 ${i + 26} 项，保持你正在阅读的位置。\n\n`,
    })
    await wait(30)
  }
  await wait(200)
  const after = await geometry()
  assert.ok(Math.abs(after.top - reading.top) < 4, '上翻阅读不得被新增输出抢回底部')
  report.readingPosition = { before: reading, after }
  await browser.visible('.workbench-demo-back-latest button')
  assert.equal(
    await browser.evaluate("document.querySelector('.workbench-demo-back-status')?.textContent"),
    '正在组织回答',
    '阅读历史时工作状态合并到回到最新按钮',
  )
  assert.equal(
    await browser.evaluate("Boolean(document.querySelector('.workbench-demo-live-state'))"),
    false,
    '阅读历史时不重复显示独立状态行',
  )
  await browser.fill('[aria-label="输入问题"]', '一行\n二行\n三行\n四行\n五行')
  await wait(100)
  assert.ok(Math.abs((await geometry()).top - reading.top) < 4, '输入框变高不移动阅读位置')
  await browser.click('[aria-label="回到最新消息"]')
  await until(async () => (await geometry()).gap < 8, '恢复跟随')
  report.checks.push('上翻暂停跟随，输入框增高不抢位置，回到最新恢复跟随')
  await browser.fill('[aria-label="输入问题"]', '先看生产环境')
  await clickComposerAction(browser, 'steer')
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-messages')?.textContent.includes('已按补充指令调整。')",
      ),
    '引导后续文',
  )
  const steeringOrder = await browser.evaluate(
    "Array.from(document.querySelectorAll('.workbench-demo-message')).map(n=>n.textContent)",
  )
  assert.ok(
    steeringOrder.findIndex((text) => text.includes('先看生产环境')) <
      steeringOrder.findIndex((text) => text.includes('已按补充指令调整。')),
  )
  assert.equal(steeringOrder.filter((text) => text.includes('先看生产环境')).length, 1)
  report.checks.push('引导回执前到达的续文仍在用户指令后，用户消息不重复')
  emit(run, {
    type: 'question',
    id: 'question-ux',
    prompt: '需要检查哪个环境？',
    options: ['生产环境'],
  })
  await browser.visible('[aria-label="澄清回答"]')
  assert.equal(
    await browser.evaluate(
      "Boolean(document.querySelector('.workbench-demo-live-state, .workbench-demo-back-status'))",
    ),
    false,
    '等待用户回答时隐藏工作状态',
  )
  await browser.fill('[aria-label="澄清回答"]', '生产环境')
  await browser.clickText('提交并继续')
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-messages')?.textContent.includes('收到澄清，继续检查。')",
      ),
    '澄清后继续',
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-question-history')?.textContent.includes('已回答')",
    ),
    true,
  )
  report.checks.push('澄清问题保留历史，回答与后续输出按顺序显示')
  await browser.screenshot('desktop-streaming')
  await browser.viewport(390, 844)
  await wait(200)
  const mobile = await browser.evaluate(
    '({width:innerWidth,scroll:document.documentElement.scrollWidth,input:document.querySelector(\'[aria-label="输入问题"]\').getBoundingClientRect().toJSON()})',
  )
  assert.ok(mobile.scroll <= mobile.width + 1, '手机不横向溢出')
  assert.ok(mobile.input.bottom < 844, '手机输入区可见')
  await browser.screenshot('mobile-streaming')
  await browser.click('[aria-label="停止生成"]')
  await until(
    async () => (await api(`/conversations/${conversation.id}`)).conversation.status === 'stopping',
    '停止已接收但尚未返回终态',
  )
  await until(
    () =>
      browser.evaluate(
        "!document.querySelector('.workbench-demo-live-state, .workbench-demo-back-status')",
      ),
    '停止处理中隐藏工作状态',
    6,
  )
  assert.equal(
    (await api(`/conversations/${conversation.id}`)).conversation.status,
    'stopping',
    '状态隐藏发生在停止回执期间，不能等到 interrupted 后才通过',
  )
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-messages').textContent.includes('已停止')",
      ),
    '真实终态到达后展示已停止',
  )
  report.checks.push('手机布局与停止保留内容通过')

  await browser.viewport(1280, 900)
  await browser.fill('[aria-label="输入问题"]', '验证最终答复与活动收束')
  await browser.click('[aria-label="发送"]')
  const finalRun = await until(
    () => [...runs.values()].find((item) => item !== run && item.res),
    '第二轮运行器接收',
  )
  emit(finalRun, {
    type: 'delta',
    itemId: 'progress-final',
    text: '先读取授权资料。\n\n',
    messagePhase: 'commentary',
  })
  emit(finalRun, {
    type: 'tool',
    id: 'read-final',
    name: 'read_project_document',
    input: { id: document.id },
    status: 'running',
  })
  emit(finalRun, {
    type: 'tool',
    id: 'read-final',
    name: 'read_project_document',
    status: 'completed',
    output: { id: document.id, name: document.name, content: document.content },
  })
  emit(finalRun, {
    type: 'delta',
    itemId: 'final-answer',
    text: '最终完成才显示的无换行尾段。',
    messagePhase: 'final_answer',
  })
  await until(async () => {
    const { conversation: value } = await api(`/conversations/${conversation.id}`)
    return value.turns.at(-1)?.timeline.at(-1)?.text === '最终完成才显示的无换行尾段。'
  }, '最终块已接收但未完成')
  await wait(180)
  const finalSelector = `.is-assistant[data-turn-id="${finalRun.runId}"]`
  assert.equal(
    await browser.evaluate(
      `document.querySelector(${q(finalSelector)})?.textContent.includes('最终完成才显示的无换行尾段。')`,
    ),
    false,
    '未结束的最终文本仍遵循按块提交',
  )
  const finalArrival = performance.now()
  emit(finalRun, { type: 'completed' })
  finalRun.res.end()
  await until(
    () =>
      browser.evaluate(
        `document.querySelector(${q(`${finalSelector} [data-activity-final-answer]`)})?.textContent.includes('最终完成才显示的无换行尾段。')`,
      ),
    '终态强制提交无边界尾段',
  )
  report.finalTailVisibleMs = performance.now() - finalArrival
  assert.ok(report.finalTailVisibleMs < 800, '完成后尾段无需继续等待边界')
  await until(
    () =>
      browser.evaluate(
        `document.querySelector(${q(`${finalSelector} [data-live-activity-content]`)})?.textContent === ''`,
      ),
    '最终答复完成后收起并卸载活动正文',
  )
  assert.equal(
    await browser.evaluate(
      `document.querySelector(${q(`${finalSelector} .workbench-demo-activity-toggle`)})?.getAttribute('aria-expanded')`,
    ),
    'false',
  )
  await browser.click(`${finalSelector} .workbench-demo-activity-toggle`)
  await browser.visible('[data-step-id="read-final"]')
  assert.deepEqual(
    await browser.evaluate(
      `Array.from(document.querySelectorAll(${q(`${finalSelector} [data-part-type]`)})).map(n=>n.dataset.partType)`,
    ),
    ['text', 'tool', 'text'],
    '展开后保留过程与最终答复的原始顺序',
  )
  await browser.click(`[data-step-id="read-final"] [aria-label=${q(`查看文件 ${document.name}`)}]`)
  await browser.visible('[role="dialog"]')
  const preview = await browser.evaluate("document.querySelector('[role=dialog]')?.textContent")
  assert.ok(preview.includes(document.name), '静态 read 点击后展示对应资料')
  assert.ok(
    preview.includes(
      document.content
        .replace(/^#+\s*/m, '')
        .split('\n')
        .find((line) => line.trim())
        ?.trim(),
    ),
    '文件预览使用真实授权资料正文',
  )
  await browser.command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
  })
  await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await until(() => browser.evaluate("!document.querySelector('[role=dialog]')"), '关闭资料预览')
  await browser.click(`${finalSelector} .workbench-demo-activity-toggle`)
  await until(
    () =>
      browser.evaluate(
        `document.querySelector(${q(`${finalSelector} [data-live-activity-content]`)})?.textContent === ''`,
      ),
    '恢复默认活动收起状态',
  )
  report.checks.push(
    '最终完成提交未换行尾段，活动默认收起；展开保留顺序，read 可直接预览真实授权文件',
  )
  const beforeRefresh = await browser.evaluate(
    "Array.from(document.querySelectorAll('[data-part-id]')).map(n=>n.dataset.partId)",
  )
  await browser.command('Page.reload')
  await browser.visible('[aria-label="输入问题"]')
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-messages')?.textContent.includes('收到澄清，继续检查。')",
      ),
    '刷新恢复',
  )
  assert.deepEqual(
    await browser.evaluate(
      "Array.from(document.querySelectorAll('[data-part-id]')).map(n=>n.dataset.partId)",
    ),
    beforeRefresh,
  )
  report.checks.push('刷新恢复有序时间线与活动默认收束状态')
} catch (error) {
  report.failures.push(error.stack)
  if (browser) await browser.screenshot('failure').catch(() => {})
} finally {
  if (browser) {
    report.runtimeErrors = browser.errors
    report.passed = !report.failures.length && !browser.errors.length
    await writeFile(path.join(browser.output, 'report.json'), JSON.stringify(report, null, 2))
    await browser.close()
  }
  if (child && child.exitCode === null) {
    const exit = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exit
  }
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => bridge.close(resolve))
  await rm(data, { recursive: true, force: true })
}
console.log(JSON.stringify(report, null, 2))
if (!report.passed) process.exitCode = 1
