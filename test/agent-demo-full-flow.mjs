import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'
import { clickComposerAction } from './helpers/agent-demo-composer.mjs'
import {
  clickMessageAction,
  hoverMessageAction,
  movePointerOutsideMessages,
} from './helpers/agent-demo-message-actions.mjs'

// Deterministic end-to-end UI timing checks with real HTTP/SSE and an explicit fake runner.
// This does not claim model latency or subjective fluency measurements.
const report = {
  mode: 'full-conversation-flows-controlled-browser',
  realModelCalls: 0,
  checks: [],
  failures: [],
}
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
  browser = await startBrowser('agent-demo-full-flow')
  await browser.viewport(1280, 900)
  await browser.fill('[aria-label="用户名"]', 'admin')
  await browser.fill('[aria-label="密码"]', 'Demo123!')
  await browser.clickText('登录')
  await browser.visible('[aria-label="账号菜单"]')
  report.testedAt = new Date().toISOString()
  report.serverHealth = await api('/health')
  report.buildAssets = await browser.evaluate('[...document.scripts].map(s=>s.src).filter(Boolean)')
  const boot = await api('/bootstrap')
  csrf = boot.csrf
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
        "document.querySelector('.workbench-demo-live-state')?.textContent.includes('正在处理')",
      ),
    '上游工作状态在首段前反馈运行中',
  )
  assert.equal(
    await browser.evaluate("document.querySelector('.workbench-demo-live-state time') === null"),
    true,
    '上游工作状态不显示自定义等待计时',
  )
  report.checks.push('首段尚未到达时显示上游正在处理状态，不添加自定义等待计时')
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.is-assistant .workbench-demo-answer-actions') === null",
    ),
    true,
    '空的运行中助手占位不能显示复制或分支操作',
  )

  emit(run, {
    type: 'reasoning',
    itemId: 'thought-1',
    text: '> 初步检查模型返回的内容。',
    mode: 'delta',
    kind: 'text',
    status: 'running',
  })
  await browser.visible('[aria-label="展开思考过程"]')
  assert.equal(
    await browser.evaluate(
      'document.querySelector(\'.is-assistant [aria-label="分支菜单"]\') === null',
    ),
    true,
    '思考流式过程不显示分支',
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-reasoning-toggle').getAttribute('aria-expanded')",
    ),
    'false',
    '上游思考默认折叠；流式状态允许挂载隐藏正文，不能以DOM不存在判断折叠',
  )
  emit(run, {
    type: 'reasoning',
    itemId: 'thought-1',
    text: '摘要关键词：确认项目资料与环境状态。',
    mode: 'replace',
    kind: 'summary',
    status: 'running',
  })
  await browser.click('[aria-label="展开思考过程"]')
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-reasoning-body')?.textContent.includes('摘要关键词') || false",
    ),
    false,
    'OpenChamber保留尚未完成的短段落，不能逐token提前暴露',
  )
  emit(run, {
    type: 'reasoning',
    itemId: 'thought-1',
    // Upstream cleanReasoningText removes empty lines. A list boundary, which
    // survives that cleanup, releases the completed block before the list.
    text: '\n\n- 继续核验。',
    mode: 'delta',
    kind: 'summary',
    status: 'running',
  })
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-reasoning-body')?.textContent.includes('摘要关键词')",
      ),
    '摘要替换原始片段',
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-reasoning-body').textContent.includes('初步检查')",
    ),
    false,
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-reasoning-body').textContent.includes('继续核验')",
    ),
    false,
    '已完成摘要段落可见，仍在生成的尾段继续保留',
  )
  emit(run, {
    type: 'reasoning',
    itemId: 'thought-1',
    text: '',
    mode: 'delta',
    kind: 'summary',
    status: 'completed',
  })
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-reasoning-body')?.textContent.includes('继续核验') && document.querySelector('.workbench-demo-reasoning-toggle')?.getAttribute('aria-expanded') === 'true'",
      ),
    '思考完成时冲刷尾段，并保留用户主动展开直到父Activity收起',
  )
  emit(run, {
    type: 'delta',
    itemId: 'response',
    messagePhase: 'final_answer',
    text: '这里是正文答案，包含 **中文搜索词**。',
  })
  await until(
    async () =>
      (await api(`/conversations/${conversation.id}`)).conversation.turns[0].timeline.some(
        (part) => part.type === 'text' && part.text.includes('中文搜索词'),
      ),
    '服务端已接收未完成正文段落',
  )
  await wait(100)
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-messages').textContent.includes('中文搜索词')",
    ),
    false,
    '正文同样采用上游按完整块揭示，而非只在思考区应用',
  )
  emit(run, {
    type: 'delta',
    itemId: 'response',
    messagePhase: 'final_answer',
    text: '\n\n| 项目 | 状态 |\n| --- | --- |\n| WebUI | 正常 |\n',
  })
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-messages').textContent.includes('中文搜索词')",
      ),
    '完整正文段落在执行过程中出现',
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('[data-live-turn-activity]')?.dataset.activitySettled",
    ),
    'false',
    'final_answer的首段已出现，整轮未结束时活动仍显示',
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.is-assistant .workbench-demo-answer-actions') === null",
    ),
    true,
    '正文仍在流式生成时不得出现终态操作栏',
  )
  emit(run, {
    type: 'usage',
    inputTokens: 150,
    outputTokens: 44,
    totalTokens: 194,
    last: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
    modelContextWindow: 100000,
  })
  emit(run, { type: 'completed' })
  run.res.end()
  await until(
    () => browser.evaluate("!document.querySelector('.workbench-demo-live-state')"),
    '完成首轮',
  )
  await browser.visible('[aria-label="重新生成"]')
  assert.ok(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-usage')?.textContent.includes('100')",
    ),
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-activity-toggle').getAttribute('aria-expanded')",
    ),
    'false',
    '最终答复完成后按上游收起活动，最终正文保持在外',
  )
  await until(
    () => browser.evaluate("document.querySelector('.workbench-demo-reasoning') === null"),
    '活动关闭动画结束后卸载中间活动',
  )
  assert.ok(
    await browser.evaluate(
      "document.querySelector('[data-activity-final-answer] table')?.textContent.includes('WebUI')",
    ),
  )
  await browser.click('.workbench-demo-activity-toggle')
  await browser.visible('[aria-label="展开思考过程"]')
  await browser.click('[aria-label="展开思考过程"]')
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-reasoning-body')?.textContent.includes('继续核验')",
      ),
    '重新展开活动和思考可读到完整历史',
  )
  const snapshot = (await api(`/conversations/${conversation.id}`)).conversation
  assert.equal(
    snapshot.messages.find((m) => m.role === 'assistant').content.includes('摘要关键词'),
    false,
  )
  report.checks.push(
    '思考默认折叠、摘要replace不重复、思考与正文按完整块揭示；最终完成收起Activity，展开恢复完整历史，用量与正文分离',
  )

  await browser.click('.workbench-demo-activity-toggle')
  await until(
    () => browser.evaluate("document.querySelector('.workbench-demo-reasoning') === null"),
    '搜索前先收起并卸载父活动',
  )
  await browser.click('[aria-label="搜索对话"]')
  await browser.fill('[aria-label="搜索当前对话"]', '摘要关键词')
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-reasoning-toggle')?.getAttribute('aria-expanded') === 'true'",
      ),
    '搜索先打开父活动再展开折叠思考',
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-activity-toggle').getAttribute('aria-expanded')",
    ),
    'true',
  )
  await wait(250)
  report.searchDiagnostics = await browser.evaluate(
    "({supports: 'Highlight' in window, keys: [...CSS.highlights.keys()], sizes: [...CSS.highlights.values()].map(h=>h.size), texts: [...document.querySelectorAll('.workbench-demo-reasoning-body .workbench-demo-markdown')].map(n=>n.innerHTML), ids: [...document.querySelectorAll('[data-message-id]')].map(n=>n.dataset.messageId)})",
  )
  await until(
    () => browser.evaluate("CSS.highlights.get('workbench-demo-search-current')?.size > 0"),
    '搜索高亮不改写Markdown',
  )
  await browser.fill('[aria-label="搜索当前对话"]', '中文搜索词')
  await until(
    () => browser.evaluate("CSS.highlights.get('workbench-demo-search-current')?.size > 0"),
    '正文搜索',
  )
  await browser.click('[aria-label="关闭对话搜索"]')
  assert.equal(await browser.evaluate("CSS.highlights.has('workbench-demo-search')"), false)
  report.checks.push('当前对话正文/折叠思考搜索、定位和CSS高亮清理')

  await browser.evaluate(
    `window.__exportBlob=null;window.__exportName=null;window.__oldObjectURL=URL.createObjectURL;URL.createObjectURL=(blob)=>{window.__exportBlob=blob;return window.__oldObjectURL(blob)};document.addEventListener('click',e=>{const a=e.target.closest('a[download]');if(a){window.__exportName=a.download;e.preventDefault()}},true);null`,
  )
  await browser.click('[aria-label="对话显示与导出"]')
  await browser.click('[role="menuitem"]')
  const exported = await browser.evaluate(
    '(async()=>({name:window.__exportName,text:await window.__exportBlob.text()}))()',
  )
  assert.ok(exported.name.endsWith('.md'))
  assert.ok(exported.text.includes('摘要关键词') && exported.text.includes('中文搜索词'))
  assert.ok(exported.text.indexOf('摘要关键词') < exported.text.indexOf('中文搜索词'))
  report.checks.push('Markdown导出真实文件内容，时间线顺序及思考配置保持一致')

  await browser.click('[aria-label="对话显示与导出"]')
  await browser.click('[role="menuitemcheckbox"]')
  assert.equal(
    await browser.evaluate("document.querySelector('.workbench-demo-reasoning') === null"),
    true,
  )
  await browser.command('Page.reload')
  await browser.visible('[aria-label="输入问题"]')
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-messages')?.textContent.includes('中文搜索词')",
      ),
    '恢复完成记录',
  )
  assert.equal(
    await browser.evaluate("document.querySelector('.workbench-demo-reasoning') === null"),
    true,
  )
  await browser.click('[aria-label="对话显示与导出"]')
  await browser.click('[role="menuitemcheckbox"]')
  await browser.visible('.workbench-demo-activity-toggle')
  await browser.click('.workbench-demo-activity-toggle')
  await browser.visible('[aria-label="展开思考过程"]')
  report.checks.push('刷新后保留显示偏好、思考历史和正文')

  await browser.click('[aria-label="输入问题"]')
  await movePointerOutsideMessages(browser)
  await until(
    () =>
      browser.evaluate(
        "[...document.querySelectorAll('.workbench-demo-message-action-icons')].every(n=>getComputedStyle(n).opacity==='0'&&getComputedStyle(n).pointerEvents==='none')",
      ),
    '桌面非悬停图标行隐藏且不接受指针',
  )
  await hoverMessageAction(browser, '.is-user [aria-label="复制消息"]')
  await browser.click('.is-user [aria-label="复制消息"]')
  await movePointerOutsideMessages(browser)
  await browser.key('Tab', 9)
  assert.equal(
    await browser.evaluate("document.activeElement?.getAttribute('aria-label')"),
    '编辑并重发',
    '真实键盘Tab可进入图标操作',
  )
  assert.equal(
    await browser.evaluate(
      "getComputedStyle(document.activeElement.closest('.workbench-demo-message-action-icons')).opacity",
    ),
    '1',
    '离开指针后键盘focus-within仍显示操作',
  )
  report.checks.push('桌面消息操作默认隐藏，真实鼠标悬停出现，键盘focus-within保持可见')
  await clickMessageAction(browser, '.is-user [aria-label="编辑并重发"]')
  await browser.fill('[aria-label="编辑消息内容"]', '改写后从这里开始检查')
  await browser.clickText('创建分支并发送')
  const branchRun = await until(
    () => [...runs.values()].find((r) => r.runId !== run.runId && r.res),
    '编辑分支运行',
  )
  assert.equal(branchRun.prompt, '改写后从这里开始检查')
  const branchId = await until(
    () =>
      browser.evaluate(
        `(()=>{const id=document.querySelector('.workbench-demo-chat')?.dataset.conversationId;return id&&id!==${q(conversation.id)}?id:null})()`,
      ),
    '进入新分支',
  )
  assert.equal((await api(`/conversations/${conversation.id}`)).conversation.turns.length, 1)
  assert.equal(branchRun.history.length, 0)
  emit(branchRun, { type: 'delta', itemId: 'branch-answer', text: '分支检查结果。' })
  emit(branchRun, { type: 'completed' })
  branchRun.res.end()
  await browser.visible('[aria-label="重新生成"]')
  report.checks.push('编辑原消息创建新私有分支并发送，原对话和旧回答保持不变')

  await clickMessageAction(browser, '[aria-label="重新生成"]')
  const retryRun = await until(
    () => [...runs.values()].find((r) => ![run.runId, branchRun.runId].includes(r.runId) && r.res),
    '重新生成运行',
  )
  assert.equal(retryRun.prompt, branchRun.prompt)
  assert.equal(retryRun.history.length, 0, '重试不能把被重试的回答放入历史')
  emit(retryRun, { type: 'delta', itemId: 'retry-answer', text: '重新生成的结果。' })
  emit(retryRun, { type: 'completed' })
  retryRun.res.end()
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-messages')?.textContent.includes('重新生成的结果') && !document.querySelector('.workbench-demo-live-state')",
      ),
    '重新生成结果',
  )
  report.checks.push('重新生成复用原输入与上下文，保留原回答，最新轮次动作正确')

  const beforeForkCount = (await api('/bootstrap')).conversations.length
  const beforeForkRuns = runs.size
  await clickMessageAction(browser, '.is-assistant:last-child [aria-label="分支菜单"]')
  await browser.visible('[role="menuitem"]')
  assert.equal(
    (await api('/bootstrap')).conversations.length,
    beforeForkCount,
    '打开分支菜单不应创建会话',
  )
  assert.equal(runs.size, beforeForkRuns, '打开菜单不应调用模型')
  await browser.key('Escape', 27)
  await until(
    () => browser.evaluate("document.activeElement?.getAttribute('aria-label') === '分支菜单'"),
    '菜单关闭动画后焦点恢复到分支触发器',
  )
  await clickMessageAction(browser, '.is-assistant:last-child [aria-label="分支菜单"]')
  await browser.clickText('从这里分支', '[role="menuitem"]')
  const forkId = await until(
    () =>
      browser.evaluate(
        `(()=>{const id=document.querySelector('.workbench-demo-chat')?.dataset.conversationId;return id&&id!==${q(branchId)}?id:null})()`,
      ),
    '从回答分支',
  )
  assert.equal(runs.size, 3, '只创建分支不会自动调用模型')
  assert.equal(
    (await api('/bootstrap')).conversations.length,
    beforeForkCount + 1,
    '选中分支选项恰好创建一次会话',
  )
  const fork = (await api(`/conversations/${forkId}`)).conversation
  assert.equal(fork.turns.length, 2)
  report.checks.push(
    '助手分支图标只打开菜单，Escape恢复焦点；选择一次恰好创建一个历史分支，不自动启动轮次',
  )

  for (let index = 0; index < 35; index++) {
    const sent = await api(`/conversations/${forkId}/messages`, 'POST', {
      text: `历史窗口第${index}轮`,
      delivery: 'send',
      requestId: randomUUID(),
    })
    const historyRun = await until(
      () =>
        runs.get(sent.conversation.activeTurnId)?.res && runs.get(sent.conversation.activeTurnId),
      '历史运行器连接',
    )
    if (index === 0)
      emit(historyRun, {
        type: 'reasoning',
        itemId: `history-thought-${index}`,
        text: '旧历史思考命中：定位隐藏轮次。',
        mode: 'delta',
        kind: 'summary',
        status: 'completed',
      })
    emit(historyRun, {
      type: 'delta',
      itemId: `history-answer-${index}`,
      text: `历史窗口第${index}轮的答案。`,
    })
    emit(historyRun, { type: 'completed' })
    historyRun.res.end()
    await until(
      async () => !(await api(`/conversations/${forkId}`)).conversation.activeTurnId,
      '历史轮次完成',
    )
  }
  await browser.command('Page.reload')
  await browser.visible('[aria-label="输入问题"]')
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-earlier-history')?.textContent.includes('加载更早消息')",
      ),
    '完整轮次历史窗口',
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelectorAll('.workbench-demo-message.is-assistant').length",
    ),
    30,
  )
  await browser.click('[aria-label="搜索对话"]')
  await browser.fill('[aria-label="搜索当前对话"]', '旧历史思考命中')
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-reasoning-body')?.textContent.includes('旧历史思考命中') && CSS.highlights.get('workbench-demo-search-current')?.size > 0",
      ),
    '搜索先加载隐藏轮次再展开思考高亮',
  )
  await browser.click('[aria-label="关闭对话搜索"]')
  report.checks.push('整页37轮只先显示30轮，搜索可加载更早轮次并展开其中思考，流式节点分片高亮正常')

  await browser.fill('[aria-label="搜索会话"]', '历史窗口第0轮的答案')
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-history-list')?.textContent.includes('历史窗口第0轮的答案')",
      ),
    '跨会话正文检索',
  )
  await browser.fill('[aria-label="搜索会话"]', '')
  await browser.click(`[aria-label="会话操作 ${forkId}"]`)
  await browser.clickText('置顶会话', '[role="menuitem"]')
  await until(async () => (await api(`/conversations/${forkId}`)).conversation.pinned, '个人置顶')
  await browser.click(`[aria-label="会话操作 ${forkId}"]`)
  await browser.clickText('归档会话', '[role="menuitem"]')
  await until(
    () => browser.evaluate(`!document.querySelector('[aria-label="会话操作 ${forkId}"]')`),
    '归档移出默认列表',
  )
  await browser.click('[aria-label="查看已归档会话"]')
  await browser.visible(`[aria-label="会话操作 ${forkId}"]`)
  await browser.click(`[aria-label="会话操作 ${forkId}"]`)
  await browser.clickText('移出归档', '[role="menuitem"]')
  await browser.click('[aria-label="返回会话列表"]')
  await browser.visible(`[aria-label="会话操作 ${forkId}"]`)
  assert.equal((await api(`/conversations/${forkId}`)).conversation.pinned, true)
  report.checks.push('跨会话正文检索、个人置顶、归档列表与恢复，恢复保留置顶')
  await browser.viewport(390, 844)
  await wait(150)
  const mobile = await browser.evaluate(
    '({width:innerWidth,scroll:document.documentElement.scrollWidth,input:document.querySelector(\'[aria-label="输入问题"]\').getBoundingClientRect().toJSON()})',
  )
  assert.ok(mobile.scroll <= mobile.width + 1)
  assert.ok(mobile.input.bottom < 844)
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-message-action-icons') === null",
    ),
    true,
  )
  const lastUserId = await browser.evaluate(
    "[...document.querySelectorAll('.is-user[data-message-id]')].at(-1).dataset.messageId",
  )
  const mobileUserMore = `[data-message-id="${lastUserId}"] [aria-label="更多消息操作"]`
  await browser.click(mobileUserMore)
  await browser.visible('.workbench-demo-message-sheet')
  await browser.evaluate(
    'Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))',
  )
  const sheetActions = await browser.evaluate(
    "[...document.querySelectorAll('.workbench-demo-message-sheet-actions button')].map(n=>({text:n.textContent.trim(),height:n.getBoundingClientRect().height}))",
  )
  assert.deepEqual(
    sheetActions.map((action) => action.text),
    ['复制消息', '编辑并重发', '从这里分支'],
  )
  assert.ok(
    sheetActions.every((action) => action.height >= 44),
    JSON.stringify(sheetActions),
  )
  await browser.screenshot('mobile-message-sheet')
  await browser.click('.workbench-demo-message-sheet [data-slot="sheet-close"]')
  await until(
    () =>
      browser.evaluate(`document.activeElement === document.querySelector(${q(mobileUserMore)})`),
    '关闭移动Sheet恢复焦点到原触发器',
  )
  const beforeSheetEdit = {
    conversations: (await api('/bootstrap')).conversations.length,
    runs: runs.size,
  }
  await browser.click(mobileUserMore)
  await browser.clickText('编辑并重发', '.workbench-demo-message-sheet-actions button')
  await browser.visible('[aria-label="编辑消息内容"]')
  await wait(400)
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.workbench-demo-edit-dialog')?.contains(document.activeElement)",
    ),
    true,
    '关闭Sheet不能抢走新编辑Dialog的焦点',
  )
  assert.equal(
    await browser.evaluate(
      'document.querySelector(\'.workbench-demo-message-sheet[data-state="open"]\') === null',
    ),
    true,
  )
  await browser.fill('[aria-label="编辑消息内容"]', '仅检查移动端编辑焦点，不发送')
  await browser.clickText('取消', '.workbench-demo-edit-dialog button')
  assert.equal((await api('/bootstrap')).conversations.length, beforeSheetEdit.conversations)
  assert.equal(runs.size, beforeSheetEdit.runs)
  report.messageSheetActions = sheetActions
  report.checks.push(
    '移动端仅更多入口，文字Sheet动作至少44px；关闭恢复焦点，编辑交接Dialog后不被关闭Sheet抢焦点，取消不创建分支',
  )
  await browser.screenshot('mobile-actions')
  await browser.viewport(1280, 900)
  await browser.screenshot('desktop-actions')
  report.checks.push('390px手机与桌面完整消息操作布局，无横向溢出')
  await browser.command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await until(
    () =>
      browser.evaluate(
        "matchMedia('(any-pointer: coarse)').matches && document.querySelector('.workbench-demo-message-action-icons') === null",
      ),
    '1280px宽触屏仍使用Sheet而非依赖hover',
  )
  await browser.click(mobileUserMore)
  await browser.visible('.workbench-demo-message-sheet')
  await browser.evaluate(
    'Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))',
  )
  report.wideTouchSheetActions = await browser.evaluate(
    "[...document.querySelectorAll('.workbench-demo-message-sheet-actions button')].map(n=>({text:n.textContent.trim(),height:n.getBoundingClientRect().height,minHeight:getComputedStyle(n).minHeight}))",
  )
  assert.ok(
    report.wideTouchSheetActions.every((action) => action.height >= 44),
    JSON.stringify(report.wideTouchSheetActions),
  )
  await browser.click('.workbench-demo-message-sheet [data-slot="sheet-close"]')
  await until(
    () => browser.evaluate("document.querySelector('.workbench-demo-message-sheet') === null"),
    '宽触屏Sheet关闭',
  )
  await browser.command('Emulation.setTouchEmulationEnabled', { enabled: false })
  await until(
    () =>
      browser.evaluate("Boolean(document.querySelector('.workbench-demo-message-action-icons'))"),
    '恢复桌面pointer操作',
  )
  report.checks.push('1280px宽触屏按any-pointer coarse使用44px文字Sheet，切回鼠标恢复图标行')

  const boundaryConversation = (
    await api('/conversations', 'POST', {
      projectId: 'p-autoops',
      environmentId: 'env-test',
      agentId: 'a-project',
      mode: 'live',
      visibility: 'private',
      title: '消息操作边界验收',
    })
  ).conversation
  await browser.evaluate(`location.hash='conversation=${boundaryConversation.id}'`)
  await until(
    () =>
      browser.evaluate(
        `document.querySelector('.workbench-demo-chat')?.dataset.conversationId === ${q(boundaryConversation.id)}`,
      ),
    '进入独立消息操作边界会话',
  )
  await browser.fill('[aria-label="输入问题"]', '检查工具与引导分段操作边界')
  await browser.click('[aria-label="发送"]')
  const boundaryRun = await until(
    () =>
      [...runs.values()].find(
        (entry) => entry.prompt === '检查工具与引导分段操作边界' && entry.res,
      ),
    '边界运行器接收',
  )
  emit(boundaryRun, {
    type: 'tool',
    id: 'boundary-read',
    name: 'read_project_document',
    status: 'running',
    input: { id: 'doc-workbench-design' },
  })
  await until(
    () =>
      browser.evaluate(
        'Boolean(document.querySelector(\'.is-assistant [data-part-type="tool"]\'))',
      ),
    '工具事件已显示',
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.is-assistant .workbench-demo-answer-actions') === null",
    ),
    true,
    '只有工具的运行中segment没有消息操作栏',
  )
  emit(boundaryRun, {
    type: 'tool',
    id: 'boundary-read',
    name: 'read_project_document',
    status: 'completed',
    input: { id: 'doc-workbench-design' },
    output: { name: '边界检查.md', content: '仅用于受控浏览器测试。' },
  })
  emit(boundaryRun, {
    type: 'delta',
    itemId: 'before-steer',
    messagePhase: 'commentary',
    text: '已读取资料，准备检查。\n\n',
  })
  await browser.fill('[aria-label="输入问题"]', '继续看测试环境')
  await clickComposerAction(browser, 'steer')
  await until(
    () =>
      browser.evaluate(
        "document.querySelectorAll('.workbench-demo-message.is-assistant').length === 2",
      ),
    '引导分隔出两个助手segment',
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.is-assistant .workbench-demo-answer-actions') === null",
    ),
    true,
  )
  emit(boundaryRun, {
    type: 'delta',
    itemId: 'after-steer-final',
    messagePhase: 'final_answer',
    text: '最终检查已完成。',
  })
  emit(boundaryRun, { type: 'completed' })
  boundaryRun.res.end()
  await until(
    () =>
      browser.evaluate(
        "document.querySelectorAll('.is-assistant .workbench-demo-answer-actions').length === 1",
      ),
    '最终segment唯一操作栏',
  )
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.is-assistant')?.querySelector('.workbench-demo-answer-actions') === null",
    ),
    true,
    '引导前的中间segment不得出现分支',
  )
  assert.equal(
    await browser.evaluate(
      'document.querySelectorAll(\'.is-assistant [aria-label="分支菜单"]\').length',
    ),
    1,
  )
  report.checks.push(
    '工具与流式中间segment不显示操作，引导分段后仅最终助手segment显示一个终态分支入口',
  )

  const attachment = (
    await api(`/conversations/${boundaryConversation.id}/attachments`, 'POST', {
      name: '仅附件消息.txt',
      mime: 'text/plain',
      data: Buffer.from('附件-only消息操作验收').toString('base64'),
    })
  ).attachment
  const attachmentSend = (
    await api(`/conversations/${boundaryConversation.id}/messages`, 'POST', {
      text: '',
      attachmentIds: [attachment.id],
      delivery: 'send',
      requestId: randomUUID(),
    })
  ).conversation
  const attachmentTurn = attachmentSend.turns.at(-1)
  const attachmentRun = await until(
    () => runs.get(attachmentTurn.id)?.res && runs.get(attachmentTurn.id),
    '纯附件运行器接收',
  )
  const attachmentRow = `[data-message-id="${attachmentTurn.inputMessageId}"]`
  await browser.visible(`${attachmentRow} [aria-label="编辑并重发"]`)
  // Existing send semantics supply a model prompt for attachment-only input.
  // Copy follows that persisted text; this request is not stored as empty.
  const attachmentUser = attachmentSend.messages.find(
    (entry) => entry.id === attachmentTurn.inputMessageId,
  )
  assert.equal(attachmentUser.content, '请分析所附文件。')
  assert.equal(attachmentUser.attachments.length, 1)
  await browser.visible(`${attachmentRow} [aria-label="复制消息"]`)
  assert.ok(
    await browser.evaluate(
      `Boolean(document.querySelector(${q(`${attachmentRow} [aria-label="从这里分支"]`)}))`,
    ),
    '纯附件用户消息仍保留分支入口',
  )
  const previousAssistantMenu = '.is-assistant [aria-label="分支菜单"]'
  // A real reader scroll releases live following before reaching an older
  // answer. Programmatic scrollIntoView alone intentionally does not do that.
  const readerPoint = await browser.evaluate(
    "(()=>{const r=document.querySelector('.workbench-demo-messages').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+80}})()",
  )
  await browser.command('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...readerPoint,
    deltaX: 0,
    deltaY: -500,
  })
  await hoverMessageAction(browser, previousAssistantMenu)
  assert.equal(
    await browser.evaluate(`document.querySelector(${q(previousAssistantMenu)}).disabled`),
    true,
    '新轮运行中禁用旧回答的分支菜单',
  )
  const disabledMenuPoint = await browser.evaluate(
    `(()=>{const r=document.querySelector(${q(previousAssistantMenu)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  for (const type of ['mousePressed', 'mouseReleased'])
    await browser.command('Input.dispatchMouseEvent', {
      type,
      ...disabledMenuPoint,
      button: 'left',
      clickCount: 1,
    })
  assert.equal(
    await browser.evaluate('document.querySelector(\'[role="menu"][data-state="open"]\') === null'),
    true,
    '真实指针点击禁用按钮不会打开菜单',
  )
  emit(attachmentRun, { type: 'failed', error: '受控运行器在正文前失败' })
  attachmentRun.res.end()
  const emptyAssistant = `.is-assistant[data-turn-id="${attachmentTurn.id}"]`
  await browser.visible(`${emptyAssistant} [aria-label="重新生成"]`)
  assert.equal(
    await browser.evaluate(
      `document.querySelector(${q(`${emptyAssistant} .workbench-demo-answer-actions`)}) === null`,
    ),
    true,
    '空失败不显示无意义复制或分支栏',
  )
  assert.equal(
    await browser.evaluate(
      `document.querySelector(${q(`${attachmentRow} [aria-label="从这里分支"]`)}).disabled`,
    ),
    false,
  )
  await browser.click(`${emptyAssistant} [aria-label="重新生成"]`)
  const recoveredRun = await until(
    () =>
      [...runs.values()].find(
        (entry) =>
          entry.runId !== attachmentRun.runId && entry.prompt === attachmentRun.prompt && entry.res,
      ),
    '纯附件空失败恢复',
  )
  assert.equal(recoveredRun.attachments.length, 1)
  emit(recoveredRun, {
    type: 'delta',
    itemId: 'recovered-answer',
    messagePhase: 'final_answer',
    text: '附件重试已恢复。',
  })
  emit(recoveredRun, { type: 'completed' })
  recoveredRun.res.end()
  await until(
    () =>
      browser.evaluate(
        "document.querySelector('.workbench-demo-messages')?.textContent.includes('附件重试已恢复')",
      ),
    '恢复结果',
  )
  report.checks.push(
    '纯附件用户消息保留编辑/分支入口；活动轮禁用旧回答菜单；正文前失败仅显示独立重试并保留附件完成恢复',
  )
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
