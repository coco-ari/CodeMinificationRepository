import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'
import { clickComposerAction, expandQueue } from './helpers/agent-demo-composer.mjs'

// 所有会话、草稿和场景控制均经过真实 API；不构造 localStorage 业务数据。
// 仅测试明确标识的 scenario 模式，不调用模型，也不把场景结果当成 live 验收。
if (!process.env.AGENT_DEMO_URL) throw new Error('请设置 AGENT_DEMO_URL 指向本轮部署地址')
process.env.PROTOTYPE_URL = process.env.AGENT_DEMO_URL
const browser = await startBrowser('agent-demo')
const { evaluate, command, fill, click, clickText, visible, viewport, screenshot, check } = browser
// Chrome 允许覆盖同名下载；每轮独立目录保证不会把旧文件当成本轮完成信号。
browser.downloadDirectory = path.join(browser.downloadDirectory, randomUUID())
await mkdir(browser.downloadDirectory, { recursive: true })
await command('Page.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: browser.downloadDirectory,
})
const input = '[aria-label="输入问题"]'
// 可显式传入上次失败时本脚本留下的会话 ID，供本轮结束后定点清理。
const created = (process.env.AGENT_DEMO_PREVIOUS_TEST_IDS || '').split(',').filter(Boolean)
const samples = []
const screenshots = []
const downloadedFiles = []
let inputEchoSamples = []
const uiMetrics = { requests: [], renders: [], interactions: [], longTasks: [] }
const delayedIntervals = []
const probe = `(()=>{
  window.__agentDemoBrowserProbe={interactions:[],longTasks:[],requestOffset:0,renderOffset:0};
  const p=window.__agentDemoBrowserProbe;
  try { new PerformanceObserver(list=>{
    for(const item of list.getEntries())p.longTasks.push({duration:item.duration,startTime:item.startTime});
  }).observe({type:'longtask',buffered:true}); } catch {}
  for(const type of ['input','click'])document.addEventListener(type,event=>{
    const started=performance.now();
    const target=event.target.closest?.('[aria-label],button,textarea,input')||event.target;
    const sample={type,label:target.getAttribute?.('aria-label')||target.textContent?.slice(0,60)||target.tagName,at:Date.now()};
    let changed=false;
    const observer=new MutationObserver(()=>{
      if(changed)return;
      changed=true;
      sample.domMutation=performance.now()-started;
      requestAnimationFrame(()=>{sample.nextFrame=performance.now()-started;p.interactions.push(sample);observer.disconnect()});
    });
    observer.observe(document.getElementById('root')||document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    setTimeout(()=>observer.disconnect(),1000);
  },true);
})()`
await command('Page.addScriptToEvaluateOnNewDocument', { source: probe })
await evaluate(probe)
const prefix = `浏览器验收 ${new Date().toISOString()}`
let failed
let context
let primary
const quoted = (value) => JSON.stringify(value)
const selected = () =>
  evaluate(`document.querySelector('.workbench-demo-chat')?.dataset.conversationId || null`)
const value = () => evaluate(`document.querySelector(${quoted(input)})?.value`)
const waitText = (text) =>
  until(() => evaluate(`document.body.innerText.includes(${quoted(text)})`), text)
const connected = () =>
  until(
    () =>
      evaluate(
        `Boolean(document.querySelector('.workbench-demo-global-connection .is-connected'))`,
      ),
    '会话事件连接',
  )
async function api(endpoint, method = 'GET', body) {
  const result = await evaluate(`(async()=>{
    const started=performance.now();
    const response=await fetch('/api/agent-demo'+${quoted(endpoint)}, {
      method:${quoted(method)},credentials:'same-origin',
      headers:{'Content-Type':'application/json',...(window.__agentDemoTestCsrf?{'X-Demo-CSRF':window.__agentDemoTestCsrf}:{})},
      ${body === undefined ? '' : `body:JSON.stringify(${quoted(body)}),`}
    });
    const data=await response.json();
    return {status:response.status,data,ms:performance.now()-started};
  })()`)
  if (method !== 'GET') samples.push({ endpoint, method, ms: result.ms })
  assert.ok(result.status >= 200 && result.status < 300, `${endpoint}: ${quoted(result.data)}`)
  return result.data
}
async function bootstrap() {
  const result = await api('/bootstrap')
  await evaluate(`window.__agentDemoTestCsrf=${quoted(result.csrf)}`)
  return result
}
async function login(username = 'admin') {
  await visible('[aria-label="用户名"]')
  await fill('[aria-label="用户名"]', username)
  await fill('[aria-label="密码"]', 'Demo123!')
  await clickText('登录')
  await visible('[aria-label="账号菜单"]')
  await connected()
  return bootstrap()
}
async function read(id = primary.id) {
  return (await api(`/conversations/${id}`)).conversation
}
async function waitConversation(test, label, id = primary.id) {
  return until(async () => {
    const conversation = await read(id)
    return test(conversation) ? conversation : null
  }, label)
}
async function select(id) {
  await evaluate(`location.hash='conversation='+${quoted(id)}`)
  await until(async () => (await selected()) === id, '选择会话')
  await visible(input)
  await connected()
}
async function create(title) {
  const result = await api('/conversations', 'POST', {
    projectId: context.projects[0].id,
    environmentId: context.projects[0].environments[0].id,
    agentId: context.agents.find((agent) => agent.projectIds.includes(context.projects[0].id)).id,
    visibility: 'private',
    mode: 'scenario',
    title: `${prefix} ${title}`,
  })
  created.push(result.conversation.id)
  return result.conversation
}
async function send(text, delivery = 'send') {
  await fill(input, text)
  await clickComposerAction(browser, delivery)
  await until(async () => (await value()) === '', '服务器接收后清空匹配草稿')
}
async function startControlled(kind, text, id = primary.id) {
  const result = await api(`/conversations/${id}/messages`, 'POST', {
    requestId: randomUUID(),
    text,
    attachmentIds: [],
    delivery: 'send',
    scenario: { kind, stepDelayMs: 45 },
  })
  await until(
    () => evaluate(`Boolean(document.querySelector('[data-turn-id="${result.receipt.turnId}"]'))`),
    '真实 SSE 显示受控轮次',
  )
  return result.receipt.turnId
}
async function capture(name) {
  await evaluate(
    `Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`,
  )
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
  await screenshot(name)
  screenshots.push(path.join(browser.output, `${name}.png`))
}
async function reload(id = primary.id) {
  await collectMetrics()
  await command('Page.reload')
  await until(async () => (await selected()) === id, '刷新后恢复当前会话')
  await connected()
  await bootstrap()
}
async function collectMetrics() {
  const values = await evaluate(`(()=>{
    const m=window.__agentDemoMetrics||{requests:[],renders:[]};
    const p=window.__agentDemoBrowserProbe;
    if(!p)return {requests:[],renders:[],interactions:[],longTasks:[]};
    const values={requests:m.requests.slice(p.requestOffset),renders:m.renders.slice(p.renderOffset),interactions:p.interactions.splice(0),longTasks:p.longTasks.splice(0)};
    p.requestOffset=m.requests.length;p.renderOffset=m.renders.length;
    return values;
  })()`)
  for (const key of Object.keys(uiMetrics)) uiMetrics[key].push(...values[key])
}
async function closeDialog() {
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await until(
    () =>
      evaluate(
        `!Array.from(document.querySelectorAll('[role="dialog"]')).some(n=>n.getClientRects().length)`,
      ),
    '关闭弹窗',
  )
}

try {
  await viewport(1280, 900)
  context = await login()
  check('演示账号通过服务端 Cookie 登录，事件连接可用')
  await click('[aria-label="新建会话"]')
  await visible('[aria-label="会话名称"]')
  await fill('[aria-label="会话名称"]', `${prefix} 主会话`)
  await fill('[aria-label="运行模式"]', 'scenario')
  await fill('[aria-label="可见范围"]', 'private')
  await clickText('创建会话')
  await visible(input)
  await until(
    () =>
      evaluate(
        `document.querySelector('.workbench-demo-chat h1')?.textContent===${quoted(`${prefix} 主会话`)}`,
      ),
    '新建会话已被选中',
  )
  primary = await read(await selected())
  created.push(primary.id)
  assert.equal(primary.mode, 'scenario')
  check('新建私有场景会话，项目、环境和 Agent 由 API 保存')

  // 组合输入阶段的 Enter 不能产生请求；这里发真实 DOM 输入法事件。
  await fill(input, '中文输入法验收')
  await evaluate(`(()=>{
    const n=document.querySelector(${quoted(input)});
    n.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'}));
    n.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',code:'Enter'}));
    n.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
    n.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',code:'Enter',isComposing:true}));
  })()`)
  await wait(180)
  assert.equal((await read()).messages.length, 0)
  assert.equal(await value(), '中文输入法验收')
  check('中文输入法组合期及 isComposing Enter 都不发送')

  await fill(input, '先问我需要检查哪项，然后整理报告')
  await click('[aria-label="发送"]')
  await visible('[aria-label="澄清回答"]')
  const waiting = await waitConversation((c) => c.status === 'waiting', '服务端等待澄清')
  await fill('[aria-label="澄清回答"]', '生成检查报告')
  await clickText('提交并继续')
  const answered = await waitConversation((c) => !c.activeTurnId, '澄清后完成')
  assert.equal(answered.turns[0].id, waiting.activeTurnId)
  assert.equal(answered.turns[0].question.answer, '生成检查报告')
  assert.equal(answered.messages.filter((m) => m.kind === 'answer' && m.role === 'user').length, 1)
  assert.equal(answered.artifacts.length, 1)
  check('发送、澄清回答、同轮恢复和报告文件均由真实 API 完成')
  await click(
    '.workbench-demo-message.is-assistant .workbench-demo-markdown a[href*="/api/agent-demo/projects/"]',
  )
  await visible('.workbench-demo-preview-dialog')
  await waitText(context.projects[0].documents[0].name)
  await capture('body-reference-preview')
  const sourceDocument = (
    await api(`/projects/${primary.projectId}/documents/${context.projects[0].documents[0].id}`)
  ).document
  const beforeDownload = new Set(await readdir(browser.downloadDirectory))
  const downloadHref = await evaluate(
    `Array.from(document.querySelectorAll('.workbench-demo-preview-dialog a')).find(n=>n.textContent.includes('下载原文件'))?.href`,
  )
  assert.ok(
    downloadHref?.startsWith('blob:'),
    '已授权项目资料应从正文 Blob 下载，不应请求文件存储 ID',
  )
  await clickText('下载原文件', '.workbench-demo-preview-dialog a')
  const documentDownload = await until(async () => {
    const files = (await readdir(browser.downloadDirectory)).filter(
      (name) => !beforeDownload.has(name) && !name.endsWith('.crdownload'),
    )
    for (const name of files) {
      const target = path.join(browser.downloadDirectory, name)
      if ((await readFile(target, 'utf8')) === sourceDocument.content) return target
    }
    return false
  }, '下载资料内容与授权文档一致')
  downloadedFiles.push(documentDownload)
  await closeDialog()
  check('正文授权资料引用打开预览，实际下载文件与授权正文一致')

  // 网络延迟只改变传输时序；不替换 API，不改应用状态。
  await command('Network.enable')
  const delayStarted = Date.now()
  await command('Network.emulateNetworkConditions', {
    offline: false,
    latency: 350,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  await fill(input, '发送回执期间保留新草稿')
  await click('[aria-label="发送"]')
  await fill(input, '这是发送后继续输入的新草稿')
  await waitConversation(
    (c) => c.messages.some((m) => m.content === '发送回执期间保留新草稿'),
    '延迟请求已被接收',
  )
  await wait(500)
  assert.equal(await value(), '这是发送后继续输入的新草稿')
  await command('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  delayedIntervals.push([delayStarted, Date.now()])
  await waitConversation((c) => !c.activeTurnId, '延迟场景完成')
  check('发送回执迟到不清除提交后的新输入')
  const second = await create('独立草稿')
  await select(second.id)
  await fill(input, '另一个会话的草稿')
  await select(primary.id)
  assert.equal(await value(), '这是发送后继续输入的新草稿')
  await reload()
  await until(async () => (await value()) === '这是发送后继续输入的新草稿', '刷新恢复草稿')
  await select(second.id)
  await until(async () => (await value()) === '另一个会话的草稿', '恢复另一个会话草稿')
  await select(primary.id)
  await fill(input, '')
  check('切换会话及刷新后个人草稿相互独立')

  // 让首次草稿 GET 遇到真实网络失败，恢复后重试必须显示远端正文。
  const retryDraft = await create('草稿重试')
  await api(`/conversations/${retryDraft.id}/draft`, 'PUT', {
    text: '首次读取失败后应恢复的服务器草稿',
    attachmentIds: [],
    revision: 0,
  })
  await command('Network.setBlockedURLs', {
    urls: [`*/api/agent-demo/conversations/${retryDraft.id}/draft`],
  })
  await select(retryDraft.id)
  await waitText('重试同步')
  await command('Network.setBlockedURLs', { urls: [] })
  await clickText('重试同步')
  await until(
    async () => (await value()) === '首次读取失败后应恢复的服务器草稿',
    '重试恢复服务器正文',
  )
  await select(primary.id)
  check('草稿首次请求网络失败，重试恢复完整服务器草稿')

  const heldTurn = await startControlled('hold', '保持运行，用于引导、队列和停止验收')
  await waitConversation(
    (c) => c.messages.find((m) => m.role === 'assistant' && m.turnId === heldTurn)?.content,
    '受控场景已有部分正文',
  )
  await send('先看资源状态，暂时不要生成报告', 'steer')
  let current = await read()
  assert.equal(current.activeTurnId, heldTurn)
  assert.equal(current.turns.at(-1).guidance.at(-1).status, 'accepted')
  await waitText('引导已接收')
  await send('队列第一项', 'queue')
  await send('队列第二项', 'queue')
  current = await waitConversation((c) => c.queue.length === 2, '两项服务端队列')
  const [firstQueued, secondQueued] = current.queue
  await expandQueue(browser)
  await click(`[aria-label="上移排队消息 ${secondQueued.id}"]`)
  await waitConversation((c) => c.queue[0]?.id === secondQueued.id, '排队顺序已保存')
  await click(`[aria-label="编辑排队消息 ${secondQueued.id}"]`)
  await fill('[aria-label="排队消息内容"]', '队列第二项已编辑')
  await clickText('保存修改')
  await waitConversation((c) => c.queue[0]?.text === '队列第二项已编辑', '排队编辑已保存')
  await click(`[aria-label="移除排队消息 ${firstQueued.id}"]`)
  await waitConversation((c) => c.queue.length === 1, '排队移除已保存')
  await capture('1280-active-queue')
  const stopDelayStarted = Date.now()
  await command('Network.emulateNetworkConditions', {
    offline: false,
    latency: 800,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  await fill(input, '独立停止验收：这个引导正在等待确认')
  await clickComposerAction(browser, 'steer')
  assert.equal(
    await evaluate(`document.querySelector('[aria-label="停止生成"]').disabled`),
    false,
    '引导等待确认时停止仍应独立可用',
  )
  await click('[aria-label="停止生成"]')
  const stopped = await waitConversation((c) => !c.activeTurnId, '停止终态')
  await command('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  delayedIntervals.push([stopDelayStarted, Date.now()])
  assert.equal(stopped.turns.at(-1).status, 'interrupted')
  assert.equal(stopped.queuePaused, true)
  const partial = stopped.messages.find(
    (m) => m.turnId === heldTurn && m.role === 'assistant',
  ).content
  await wait(200)
  assert.equal(
    (await read()).messages.find((m) => m.turnId === heldTurn && m.role === 'assistant').content,
    partial,
  )
  await reload()
  const restored = await read()
  assert.equal(restored.queue.length, 1)
  assert.equal(restored.queuePaused, true)
  const guidanceIds = restored.messages
    .filter((m) => m.kind === 'steer' && m.turnId === heldTurn)
    .map((m) => m.id)
  assert.equal(guidanceIds.length, 2)
  assert.equal(new Set(guidanceIds).size, 2)
  await clickText('恢复队列')
  await waitConversation((c) => !c.activeTurnId && !c.queue.length, '恢复并完成排队任务')
  check('同轮引导回执、排队编辑排序删除、停止暂停队列及刷新恢复正确')

  const failedTurn = await startControlled('fail', '验证中断后继续')
  const failedConversation = await waitConversation((c) => c.status === 'failed', '受控失败')
  assert.ok(
    failedConversation.messages.find((m) => m.turnId === failedTurn && m.role === 'assistant')
      .content,
  )
  await click('[aria-label="继续此轮"]')
  const continued = await waitConversation(
    (c) => !c.activeTurnId && c.turns.at(-1).id !== failedTurn,
    '继续生成完成',
  )
  assert.equal(continued.turns.length, failedConversation.turns.length + 1)
  assert.equal(continued.turns.at(-1).status, 'completed')
  check('执行失败保留部分正文，继续操作创建独立新轮次并完成')

  // 用足够长的真实用户消息制造可滚动区域，再释放受控流验证阅读锚点。
  const longPrompt = [
    '检查阅读锚点和 Markdown 表格。',
    '| 条目 | 内容 |',
    '| --- | --- |',
    ...Array.from({ length: 22 }, (_, i) => `| ${i + 1} | 这是第 ${i + 1} 条项目核对项 |`),
    '```text',
    'long_line_'.repeat(80),
    '```',
    '<img src=x onerror="window.__agentDemoUnsafe=1">',
    '[危险链接](javascript:window.__agentDemoUnsafe=1)',
  ].join('\n')
  const scrollTurn = await startControlled('hold', longPrompt)
  await waitConversation(
    (c) => c.messages.find((m) => m.turnId === scrollTurn && m.role === 'assistant')?.content,
    '滚动测试流式正文',
  )
  await evaluate(
    `(()=>{const n=document.querySelector('.workbench-demo-messages');n.scrollTop=0;n.dispatchEvent(new Event('scroll',{bubbles:true}))})()`,
  )
  await waitText('回到最新消息')
  const before = await evaluate(`document.querySelector('.workbench-demo-messages').scrollTop`)
  await api(`/conversations/${primary.id}/messages`, 'POST', {
    requestId: randomUUID(),
    text: 'release',
    delivery: 'steer',
    attachmentIds: [],
    expectedTurnId: scrollTurn,
  })
  await waitConversation((c) => !c.activeTurnId, '流式锚点场景完成')
  assert.ok(
    Math.abs(
      (await evaluate(`document.querySelector('.workbench-demo-messages').scrollTop`)) - before,
    ) < 4,
  )
  assert.equal(await evaluate(`Boolean(window.__agentDemoUnsafe)`), false)
  assert.equal(
    await evaluate(
      `document.querySelectorAll('.workbench-demo-markdown a[href^="javascript:"]').length`,
    ),
    0,
  )
  await clickText('回到最新消息')
  check('上翻后流式内容不拉回底部，显式回到最新恢复跟随；HTML 和脚本链接不执行')

  const attachmentPath = path.join(browser.output, '浏览器验收附件.md')
  await writeFile(
    attachmentPath,
    '# 附件预览验收\n\n这是上传后授权读取的文本。\n\n```js\nconst value = "<safe>";\n```\n',
  )
  const { root } = await command('DOM.getDocument')
  const { nodeId } = await command('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '[aria-label="选择会话附件"]',
  })
  await command('DOM.setFileInputFiles', { nodeId, files: [attachmentPath] })
  await visible('.workbench-demo-pending-file')
  await click('.workbench-demo-pending-file button')
  await waitText('这是上传后授权读取的文本。')
  await capture('attachment-preview')
  await closeDialog()
  await send('根据附件整理报告')
  const filesDone = await waitConversation(
    (c) => !c.activeTurnId && c.artifacts.length > 1,
    '附件报告完成',
  )
  assert.equal(filesDone.messages.at(-2).attachments.length, 1)
  await clickText(`结果${filesDone.artifacts.length}`, '[role="tab"]')
  await click('.workbench-demo-artifact-open')
  await waitText('项目检查报告')
  await capture('report-preview')
  await closeDialog()
  check('附件上传、授权文本预览、带附件发送和报告预览可用')

  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1280, 900],
    [1920, 1080],
  ]) {
    await viewport(width, height)
    await browser.assertNoOverflow(`${width}px`)
    const geometry = await evaluate(`(()=>{
      const n=document.querySelector(${quoted(input)}).getBoundingClientRect();
      return {top:n.top,bottom:n.bottom,left:n.left,right:n.right,w:innerWidth,h:innerHeight};
    })()`)
    assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.h + 1, `${width}px 输入框被裁切`)
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.w + 1, `${width}px 输入框横向被裁切`)
    await capture(`layout-${width}`)
    await evaluate(
      `document.querySelector('.workbench-demo-code-block').scrollIntoView({block:'center'})`,
    )
    await browser.assertNoOverflow(`${width}px 长代码`)
    await capture(`long-code-${width}`)
    await evaluate(
      `(()=>{const n=document.querySelector('.workbench-demo-messages');n.scrollTop=n.scrollHeight})()`,
    )
    if (width === 390) {
      await fill(input, '手机 Enter 应换行')
      await click(input)
      await command('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
        unmodifiedText: '\r',
      })
      await command('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      })
      assert.ok((await value()).includes('\n'))
      await click('[aria-label="打开历史会话"]')
      await visible('.workbench-demo-history-sheet')
      await capture('390-history-drawer')
      await closeDialog()
      await click('[aria-label="打开会话上下文"]')
      await visible('.workbench-demo-context-sheet')
      await capture('390-context-drawer')
      await closeDialog()
      await fill(input, '')
    }
  }
  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  await capture('1920-reduced-motion')
  check('390/768/1280/1920 布局无页面横向溢出，输入常驻可见，手机抽屉和 Enter 换行可用')

  // 定向记录原生 beforeinput 到下一帧的 textarea 值，避免归因给无关 DOM 变化。
  await fill(input, '')
  await click(input)
  await evaluate(`(()=>{
    const node=document.querySelector(${quoted(input)});
    window.__agentDemoInputEcho=[];
    let started=0;
    const before=()=>{started=performance.now()};
    const after=()=>{
      const from=started, expected=node.value;
      requestAnimationFrame(()=>window.__agentDemoInputEcho.push({
        duration:performance.now()-from,valueMatches:node.value===expected,length:expected.length
      }));
    };
    node.addEventListener('beforeinput',before,true);
    node.addEventListener('input',after,true);
    window.__agentDemoStopEcho=()=>{
      node.removeEventListener('beforeinput',before,true);
      node.removeEventListener('input',after,true);
    };
  })()`)
  const echoText = Array.from('输入回显测试这段文字用于测量每次键入响应').slice(0, 20)
  for (const [index, character] of echoText.entries()) {
    await command('Input.insertText', { text: character })
    await until(() => evaluate(`window.__agentDemoInputEcho.length>${index}`), '下一帧输入回显')
  }
  inputEchoSamples = await evaluate(`window.__agentDemoStopEcho();window.__agentDemoInputEcho`)
  assert.equal(inputEchoSamples.length, echoText.length)
  assert.ok(inputEchoSamples.every((sample) => sample.valueMatches))
  await fill(input, '')
  check('定向原生输入逐字采样：下一帧 textarea 值与本次键入一致')

  await viewport(1280, 900)
  await reload()
  const uniqueIds = await evaluate(
    `Array.from(document.querySelectorAll('[data-message-id]')).map(n=>n.dataset.messageId)`,
  )
  assert.equal(new Set(uniqueIds).size, uniqueIds.length)
  const reloaded = await read()
  // A single server assistant message now spans ordered UI segments around
  // accepted user inputs. Validate identities/content parts instead of assuming
  // one article for each legacy message record.
  for (const message of reloaded.messages.filter((item) => item.role === 'user'))
    assert.equal(uniqueIds.filter((id) => id === message.id).length, 1)
  const partIds = await evaluate(
    `Array.from(document.querySelectorAll('[data-part-id]')).map(n=>n.dataset.partId)`,
  )
  const expectedParts = reloaded.turns.flatMap((turn) =>
    (turn.timeline || []).filter((entry) => entry.type !== 'user').map((entry) => entry.id),
  )
  assert.equal(new Set(partIds).size, partIds.length)
  assert.deepEqual(partIds.sort(), expectedParts.sort())
  check('重新连接后用户消息与执行时间线完整，无重复消息或片段')

  // 模拟另一个标签页使账号会话失效，不通过 React 内部或存储改变登录状态。
  await clickText(`结果${(await read()).artifacts.length}`, '[role="tab"]')
  await click('.workbench-demo-artifact-open')
  await visible('.workbench-demo-preview-dialog')
  await api('/logout', 'POST', {})
  await evaluate(`window.dispatchEvent(new Event('online'))`)
  await visible('[aria-label="用户名"]')
  await login('lin')
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('.workbench-demo-preview-dialog')).some(n=>n.getClientRects().length)`,
    ),
    false,
  )
  const denied = await evaluate(
    `fetch('/api/agent-demo/conversations/${primary.id}',{credentials:'same-origin'}).then(r=>r.status)`,
  )
  assert.equal(denied, 404)
  await click('[aria-label="账号菜单"]')
  await clickText('退出登录', '[role="menuitem"]')
  await login('admin')
  check('会话失效后切换账号不重现旧私有预览，私有会话 API 拒绝新账号')
  assert.deepEqual(browser.errors, [], '浏览器存在未捕获异常')
} catch (error) {
  failed = error
  try {
    await capture('failure')
  } catch {}
} finally {
  await collectMetrics().catch(() => {})
  await bootstrap().catch(() => {})
  // 仅删除本脚本创建的会话；不会清理用户其他会话或 localStorage。
  for (const id of created) {
    try {
      const conversation = await read(id)
      if (conversation.activeTurnId) {
        await api(`/conversations/${id}/stop`, 'POST', {
          requestId: randomUUID(),
          expectedTurnId: conversation.activeTurnId,
        })
        await waitConversation((c) => !c.activeTurnId, '清理测试轮次', id)
      }
      await api(`/conversations/${id}`, 'DELETE')
    } catch (error) {
      browser.warnings.push(`测试会话清理失败 ${id}: ${error.message}`)
    }
  }
  const latency = samples.map((sample) => sample.ms).sort((a, b) => a - b)
  const stats = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    return {
      count: sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      max: sorted.at(-1),
    }
  }
  const normalRequests = uiMetrics.requests.filter(
    (sample) =>
      sample.status >= 200 &&
      sample.status < 300 &&
      !delayedIntervals.some(([start, end]) => sample.at >= start && sample.at <= end),
  )
  const report = {
    url: browser.base,
    testedAt: new Date().toISOString(),
    buildAssets: await evaluate(`Array.from(document.scripts).map(n=>n.src).filter(Boolean)`).catch(
      () => [],
    ),
    serverHealth: await api('/health').catch(() => null),
    runtime: context?.runtime,
    mode: 'scenario',
    realModelCalls: 0,
    passed: !failed,
    error: failed?.stack,
    checks: browser.checks,
    errors: browser.errors,
    warnings: browser.warnings,
    screenshots,
    downloadedFiles,
    uiTiming: {
      note: 'scenario LAN 浏览器样本；event→rAF 为收到事件至批次后的帧回调近似，不是像素呈现硬件时间。交互记录事件后观察到的 DOM 变化与下一帧；未证明每个变化均仅由该事件引起。桌面 Chrome 响应式模拟不代表真实手机软键盘。',
      normalRequests: stats(normalRequests.map((sample) => sample.duration)),
      eventToFrame: stats(uiMetrics.renders.map((sample) => sample.duration)),
      inputToDOM: stats(
        uiMetrics.interactions
          .filter((sample) => sample.type === 'input')
          .map((sample) => sample.domMutation),
      ),
      clickToDOM: stats(
        uiMetrics.interactions
          .filter((sample) => sample.type === 'click')
          .map((sample) => sample.domMutation),
      ),
      targetedInputEcho: {
        note: '桌面 Chrome CDP 原生 insertText 的 beforeinput→下一帧 textarea 值检查；仅为输入回显近似，不含物理键盘、真实手机软键盘或显示器呈现延迟。',
        ...stats(inputEchoSamples.map((sample) => sample.duration)),
        samples: inputEchoSamples,
      },
      longTasks: stats(uiMetrics.longTasks.map((sample) => sample.duration)),
      delayedIntervals,
      raw: uiMetrics,
    },
    apiTiming: {
      note: '浏览器内真实 API 往返样本；包含人为网络延迟场景和测试清理请求，不代表纯 LAN 延迟。',
      count: latency.length,
      p50: latency[Math.floor(latency.length * 0.5)],
      p95: latency[Math.min(latency.length - 1, Math.floor(latency.length * 0.95))],
      max: latency.at(-1),
      samples,
    },
  }
  await writeFile(path.join(browser.output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify(
      { passed: !failed, report: path.join(browser.output, 'report.json'), screenshots },
      null,
      2,
    ),
  )
  await browser.close()
}
if (failed) throw failed
