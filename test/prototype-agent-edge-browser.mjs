import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { startBrowser, storageKey } from './helpers/prototype-browser.mjs'

const b = await startBrowser('agent-edges')
const text = () => b.evaluate('document.body.innerText')
const conversation = async (id) => (await b.storage()).conversations.find((item) => item.id === id)
const done = (id) => b.until(async () => !(await conversation(id))?.active, '当前轮完成', 500)
const agentAction = (name, action) =>
  b.mouse(
    `Array.from(Array.from(document.querySelectorAll('.wb-agent-config-row')).find(el=>el.textContent.includes(${JSON.stringify(name)})).querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(action)})`,
    `${name} / ${action}`,
  )
async function reloadReady(selector) {
  const origin = await b.evaluate('performance.timeOrigin')
  await b.command('Page.reload')
  await b.until(
    () =>
      b.evaluate(
        `performance.timeOrigin!==${origin} && document.readyState==='complete' && Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      ),
    '新文档加载',
  )
}
async function chooseScenario(value) {
  await b.click('[aria-label="会话更多操作"]')
  await b.clickText('演示场景', '[role=menuitem]')
  await b.fill('[aria-label="本轮演示场景"]', value)
  await b.clickText('完成')
}
const hasButton = (label) =>
  b.evaluate(
    `Array.from(document.querySelectorAll('button')).some(el=>el.textContent.trim()===${JSON.stringify(label)})`,
  )

try {
  await b.reset('lin')
  assert.ok((await b.storage()).agents.every((agent) => agent.kind === 'platform'))
  await b.route('/p/sol/agents')
  assert.equal(await hasButton('创建 Agent'), false)
  assert.equal(await hasButton('配置'), false)
  assert.doesNotMatch(await text(), /连接用户 Agent|自有 Agent|主机系统|连接令牌/)
  await agentAction('项目分析助手', '会话')
  await b.visible('[aria-label="会话 Agent"]')
  const memberOptions = await b.evaluate(
    `Array.from(document.querySelector('[aria-label="会话 Agent"]').options).map(option=>option.value)`,
  )
  assert.deepEqual(memberOptions, ['agent-platform-sol'])
  await b.clickText('取消')
  b.check('第一轮初始数据只有平台 Agent；成员可以发起会话，不能创建或配置 Agent')

  // Deliberately load pre-scope-change local data, including an almost completed host task.
  await b.evaluate(`(() => {
    const state=JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}));
    state.agents.push({id:'legacy-external',name:'旧外部 Agent 不应显示',description:'旧电脑连接',kind:'user',ownerId:'lin',sharing:'project',projectId:'sol',status:'online',hostOS:'macOS'});
    state.conversations.push({id:'legacy-external-chat',projectId:'sol',agentId:'legacy-external',creatorId:'lin',environmentId:null,title:'旧外部会话不可恢复',sourceMode:'none',scopeIds:[],createdAt:new Date().toISOString(),messages:[],queue:[{content:'旧外部排队输入',actorId:'lin',attachments:[]}],active:{taskId:'legacy-external-task',actorId:'lin',input:'旧外部执行',elapsed:8400,duration:8500,lastTick:Date.now()-3000,startedAt:new Date().toISOString(),resourceSnapshot:[],response:{content:'不应生成的旧主机回复',steps:[],citations:[],files:[{id:'legacy-output',name:'legacy-output.json',status:'ready',type:'file',content:'旧输出'}],status:'success'}}});
    state.tasks.push({id:'legacy-external-task',projectId:'sol',agentId:'legacy-external',type:'agent',title:'旧外部执行任务',status:'running',progress:98,elapsed:8400,duration:8500,runtimeManaged:true,logs:[],artifactIds:[],createdAt:new Date().toISOString()});
    state.notifications.push({id:'legacy-notice',agentId:'legacy-external',projectId:'sol',title:'旧外部通知不可显示',createdAt:new Date().toISOString(),readBy:[]});
    state.audit.push({id:'legacy-audit',agentId:'legacy-external',projectId:'sol',actorId:'lin',action:'旧外部审计不可显示',object:'旧外部会话不可恢复',result:'完成',createdAt:new Date().toISOString()});
    localStorage.setItem(${JSON.stringify(storageKey)},JSON.stringify(state));
  })()`)
  await reloadReady('h1')
  await b.wait(1800)
  let state = await b.storage()
  assert.equal(state.conversations.find((item) => item.id === 'legacy-external-chat').active, null)
  assert.deepEqual(state.conversations.find((item) => item.id === 'legacy-external-chat').queue, [])
  assert.equal(state.tasks.find((item) => item.id === 'legacy-external-task').status, 'stopped')
  assert.equal(
    state.conversations.find((item) => item.id === 'legacy-external-chat').messages.length,
    0,
  )
  assert.ok(!state.projects.sol.artifacts.some((item) => item.id === 'legacy-output'))
  for (const route of ['/p/sol/agents', '/p/sol/chat', '/p/sol/tasks', '/notifications']) {
    await b.route(route)
    assert.doesNotMatch(await text(), /旧外部/)
  }
  await b.route('/p/sol/tasks')
  await b.clickText('操作审计', '[role=tab]')
  assert.doesNotMatch(await text(), /旧外部/)
  await b.route('/p/sol/chat?conversation=legacy-external-chat')
  assert.match(await text(), /会话不存在或无权访问/)
  assert.equal(
    await b.evaluate('Boolean(document.querySelector(\'[aria-label="输入问题"]\'))'),
    false,
  )
  await b.route('/p/sol/chat?agent=legacy-external')
  await b.until(
    async () => (await text()).includes('此 Agent 不存在或未共享给当前项目'),
    '旧 Agent 链接拒绝',
  )
  assert.equal(
    await b.evaluate('Boolean(document.querySelector(\'[aria-label="会话 Agent"]\'))'),
    false,
  )
  b.check(
    '旧缓存外部 Agent 的任务停止、队列清空且无输出；管理、历史、任务、通知、审计与旧深链接均不可用',
  )

  await b.route('/p/sol/chat?conversation=conversation-sol-intro')
  await b.viewport(390, 844)
  await b.assertNoOverflow('第一轮手机平台会话')
  assert.ok(
    await b.evaluate(
      'document.querySelector(\'[aria-label="输入问题"]\').getBoundingClientRect().bottom < innerHeight',
    ),
  )
  await b.click('[aria-label="打开历史会话"]')
  await b.visible('[role="dialog"] .wb-chat-history-inner')
  assert.doesNotMatch(await text(), /旧外部/)
  await b.clickText('新建会话', '[role="dialog"] button')
  await b.visible('[aria-label="会话 Agent"]')
  assert.deepEqual(
    await b.evaluate(
      `Array.from(document.querySelector('[aria-label="会话 Agent"]').options).map(option=>option.value)`,
    ),
    ['agent-platform-sol'],
  )
  await b.clickText('取消')
  await b.until(() => b.evaluate('!document.querySelector(\'[role="dialog"]\')'), '手机弹窗关闭')
  await b.screenshot('platform-only-mobile')
  await b.viewport()
  b.check('手机保留平台会话和新建流程，旧外部 Agent 不出现在历史或选择器中，输入区保持可见')

  await b.logout()
  await b.login('admin')
  await b.route('/p/sol/agents')
  assert.doesNotMatch(await text(), /旧外部/)
  await b.clickText('创建 Agent')
  assert.equal(
    await b.evaluate('Boolean(document.querySelector(\'[aria-label="Agent 类型"]\'))'),
    false,
  )
  assert.equal(
    await b.evaluate('Boolean(document.querySelector(\'[aria-label="主机系统"]\'))'),
    false,
  )
  assert.equal(
    await b.evaluate('document.querySelector(\'[aria-label="运行时"]\').value'),
    '内置只读运行时',
  )
  await b.fill('[aria-label="Agent 名称"]', '第一轮只读助手')
  await b.fill('[aria-label="角色指令"]', '只读分析项目资料并引用来源')
  await b.clickText('保存')
  const privateId = (await b.storage()).agents.find((agent) => agent.name === '第一轮只读助手').id
  assert.equal((await b.storage()).agents.find((agent) => agent.id === privateId).kind, 'platform')
  await agentAction('第一轮只读助手', '会话')
  await b.fill('[aria-label="会话名称"]', '第一轮私有平台会话')
  await b.fill('[aria-label="会话环境"]', 'sol-test')
  await b.clickText('创建会话')
  const privateConversation = (await b.storage()).conversations.find(
    (item) => item.title === '第一轮私有平台会话',
  ).id
  b.check('管理员创建界面仅保留平台运行时、模型与角色配置，保存为平台 Agent')

  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6F1cAAAAASUVORK5CYII='
  const imagePath = path.join(b.output, 'uploaded.png')
  await writeFile(imagePath, Buffer.from(pngBase64, 'base64'))
  const doc = await b.command('DOM.getDocument')
  const node = await b.command('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: '[aria-label="选择会话附件"]',
  })
  await b.command('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [imagePath] })
  await b.until(async () => (await text()).includes('uploaded.png'), '上传图片')
  await b.evaluate(
    `(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(pngBase64)}),c=>c.charCodeAt(0));const clipboard=new DataTransfer();clipboard.items.add(new File([bytes],'pasted.png',{type:'image/png'}));document.querySelector('[aria-label="输入问题"]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));})()`,
  )
  await b.until(async () => (await text()).includes('pasted.png'), '粘贴图片')
  await b.fill('[aria-label="输入问题"]', '帮我重启服务')
  await b.click('[aria-label="发送"]')
  let item = await conversation(privateConversation)
  assert.equal(item.active.attachments.length, 2)
  assert.ok(item.active.attachments.every((file) => file.mime === 'image/png'))
  assert.ok(
    item.active.response.steps.some(
      (step) => step.name === 'platform.capability.check' && step.status === 'blocked',
    ),
  )
  assert.ok(item.active.response.steps.every((step) => !step.name.startsWith('host.')))
  await done(privateConversation)
  b.check('平台 Agent 保留图片上传和粘贴，变更请求仍被只读边界阻止')

  await chooseScenario('slow')
  await b.fill('[aria-label="输入问题"]', '私有停止不可泄漏')
  await b.click('[aria-label="发送"]')
  await b.route('/p/sol/tasks')
  await b.mouse(
    `Array.from(Array.from(document.querySelectorAll('tr')).find(el=>el.textContent.includes('私有停止不可泄漏')).querySelectorAll('button')).find(el=>el.textContent.trim()==='停止任务')`,
    '停止私有平台任务',
  )
  await b.clickText('操作审计', '[role=tab]')
  assert.match(await text(), /私有停止不可泄漏/)
  assert.equal(
    (await b.storage()).audit.find(
      (entry) => entry.action === '停止任务' && entry.object.includes('私有停止不可泄漏'),
    ).agentId,
    privateId,
  )
  await b.logout()
  await b.login('lin')
  await b.route('/p/sol/tasks')
  assert.doesNotMatch(await text(), /私有停止不可泄漏/)
  await b.clickText('操作审计', '[role=tab]')
  assert.doesNotMatch(await text(), /私有停止不可泄漏/)
  b.check('私有平台任务停止后的审计仍遵守可见范围，其他成员不能读取标题')

  await b.route('/p/sol/chat?conversation=conversation-sol-intro')
  await chooseScenario('failed')
  await b.fill('[aria-label="输入问题"]', '查询测试环境资源')
  await b.click('[aria-label="发送"]')
  await done('conversation-sol-intro')
  item = await conversation('conversation-sol-intro')
  assert.equal(
    item.messages.at(-1).steps.find((step) => step.name === 'mcp.resources.connect').status,
    'failed',
  )
  const taskCount = (await b.storage()).tasks.length
  await b.wait(1000)
  assert.equal((await b.storage()).tasks.length, taskCount)
  await b.clickText('重试上一轮')
  await done('conversation-sol-intro')
  assert.equal((await conversation('conversation-sol-intro')).lastFailed, null)
  assert.ok(
    (await b.storage()).projects.sol.resources
      .filter((resource) => !resource.environmentId || resource.environmentId === 'sol-test')
      .every((resource) => resource.status === 'connected'),
  )
  b.check('平台资源连接失败不会自动重试，显式重试成功后恢复资源状态')

  await b.logout()
  await b.login('admin')
  await b.route('/p/atlas/agents')
  await agentAction('第一轮只读助手', '配置')
  await b.fill('[aria-label="共享范围"]', 'project')
  await b.clickText('保存')
  await b.until(
    async () => (await text()).includes('已有会话属于其他项目，不能跨项目共享历史'),
    '跨项目历史边界',
  )
  assert.equal(
    (await b.storage()).agents.find((agent) => agent.id === privateId).sharing,
    'private',
  )
  assert.equal((await conversation(privateConversation)).projectId, 'sol')
  b.check('平台 Agent 的跨项目历史共享边界保持不变')
  assert.deepEqual(b.errors, [])
  await writeFile(
    path.join(b.output, 'checks.json'),
    JSON.stringify({ checks: b.checks, errors: b.errors, warnings: b.warnings }, null, 2),
  )
  console.log(`第一轮 Agent 边界验收通过：${b.checks.length} 组`)
} catch (error) {
  await b.screenshot('failure').catch(() => {})
  console.error((await text().catch(() => '')).slice(-5000))
  console.error(b.errors)
  throw error
} finally {
  await b.close()
}
