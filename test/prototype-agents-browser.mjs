import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { startBrowser } from './helpers/prototype-browser.mjs'

const browser = await startBrowser('agents')
const {
  command,
  evaluate,
  click,
  clickText,
  mouse,
  fill,
  visible,
  storage,
  route,
  screenshot,
  check,
  assertNoOverflow,
  viewport,
  reset,
  logout: rawLogout,
  login,
  until,
  wait,
  downloadDirectory,
  output,
} = browser
const text = () => evaluate('document.body.innerText')
const logout = async () => {
  await wait(350)
  await rawLogout()
}
const activeConversation = async (id) =>
  (await storage()).conversations.find((item) => item.id === id)
const pickConversation = (title) =>
  mouse(
    `Array.from(document.querySelectorAll('.wb-conversation-button')).find(el=>el.getClientRects().length&&el.textContent.includes(${JSON.stringify(title)}))`,
    title,
  )
const agentAction = (name, action) =>
  mouse(
    `Array.from(document.querySelectorAll('.wb-agent-config-row')).find(el=>el.textContent.includes(${JSON.stringify(name)}))?.querySelectorAll('button') && Array.from(Array.from(document.querySelectorAll('.wb-agent-config-row')).find(el=>el.textContent.includes(${JSON.stringify(name)})).querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(action)})`,
    `${name} / ${action}`,
  )
const waitComplete = (id) =>
  until(async () => !(await activeConversation(id))?.active, 'Agent 回复完成', 800)
async function reloadReady(selector) {
  const previousOrigin = await evaluate('performance.timeOrigin')
  await command('Page.reload')
  await until(
    () =>
      evaluate(
        `performance.timeOrigin!==${previousOrigin} && document.readyState==='complete' && Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      ),
    '刷新后新文档准备完成',
  )
}
async function openDemo() {
  await click('[aria-label="会话更多操作"]')
  await clickText('演示场景', '[role=menuitem]')
}
async function chooseScenario(value) {
  await openDemo()
  await fill('[aria-label="本轮演示场景"]', value)
  await clickText('完成')
}
async function download(name) {
  await rm(path.join(downloadDirectory, name), { force: true })
  await click(`[aria-label="下载 ${name}"]`)
  return until(async () => {
    const files = await readdir(downloadDirectory)
    const candidate = files.find((file) => file === name)
    if (!candidate) return false
    return readFile(path.join(downloadDirectory, candidate))
  }, `下载 ${name}`)
}

try {
  await reset('admin')
  assert.ok((await storage()).agents.every((agent) => agent.kind === 'platform'))
  let current
  await route('/p/sol/agents')
  await clickText('创建 Agent')
  await fill('[aria-label="Agent 名称"]', '验收私有分析助手')
  await fill('[aria-label="Agent 描述"]', '验证私有范围、报告和历史会话共享')
  await fill('[aria-label="角色指令"]', '检索项目资料并进行只读分析，引用来源。')
  await clickText('保存')
  const platformId = (await storage()).agents.find((item) => item.name === '验收私有分析助手').id
  await agentAction('验收私有分析助手', '会话')
  await visible('[aria-label="会话名称"]')
  await fill('[aria-label="会话名称"]', '验收固定会话')
  await fill('[aria-label="会话环境"]', 'sol-test')
  await fill('[aria-label="项目资料范围"]', 'selected')
  await click('#scope-folder-ops-sol')
  await clickText('创建会话')
  const conversationId = (await storage()).conversations.find(
    (item) => item.title === '验收固定会话',
  ).id
  assert.ok((await evaluate('location.hash')).includes(`conversation=${conversationId}`))
  current = await activeConversation(conversationId)
  assert.equal(current.environmentId, 'sol-test')
  assert.equal(current.agentId, platformId)
  assert.equal(current.sourceMode, 'sanitized')
  assert.deepEqual(current.scopeIds, ['folder-ops-sol'])
  await click('[aria-label="更换 Agent / 环境"]')
  await fill('[aria-label="会话环境"]', 'sol-prod')
  await clickText('取消')
  assert.equal((await activeConversation(conversationId)).environmentId, 'sol-test')
  check('会话固定 Agent 与环境；调整环境只能创建新会话，取消不改变原会话')

  const attachmentPath = path.join(output, '验收附件.md')
  await writeFile(attachmentPath, '# 验收附件\n\n只允许读取和分析。\n')
  const documentNode = await command('DOM.getDocument')
  const fileNode = await command('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector: '[aria-label="选择会话附件"]',
  })
  await command('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [attachmentPath] })
  await until(async () => (await text()).includes('验收附件.md'), '附件显示')
  await fill('[aria-label="输入问题"]', '请生成分析报告，提供 Markdown、PDF 和 CSV 文件')
  await click('[aria-label="发送"]')
  await until(
    async () => Boolean((await activeConversation(conversationId)).active),
    '平台 Agent 开始',
  )
  current = await activeConversation(conversationId)
  assert.equal(current.active.attachments[0].name, '验收附件.md')
  assert.equal(
    current.active.response.citations.filter((item) => item.kind === 'document').length,
    1,
  )
  assert.equal(current.active.response.citations[0].label, '发布检查.txt')
  assert.ok(current.active.response.steps.some((item) => item.name === 'mcp.resources.connect'))
  assert.ok(current.active.resourceSnapshot.every((item) => !Object.hasOwn(item, 'password')))
  await fill('[aria-label="输入问题"]', '继续核对发布前资料')
  await click('[aria-label="排队到下一轮"]')
  assert.equal((await activeConversation(conversationId)).queue.length, 1)
  assert.equal(
    (await storage()).tasks.filter(
      (item) => item.agentId === platformId && item.status === 'running',
    ).length,
    1,
  )
  await until(async () => (await text()).includes('正在生成'), '可观察流式输出', 400)
  await waitComplete(conversationId)
  await until(
    async () => {
      const conversation = await activeConversation(conversationId)
      return (
        !conversation.active &&
        conversation.queue.length === 0 &&
        conversation.messages.filter((item) => item.role === 'assistant').length === 2
      )
    },
    '队列顺序执行完成',
    800,
  )
  current = await activeConversation(conversationId)
  const reportFiles = current.messages.find((message) => message.files?.length === 3).files
  assert.ok(reportFiles.every((file) => !file.savedToProject))
  const md = await download('项目分析报告.md')
  const pdf = await download('项目分析报告.pdf')
  const csv = await download('资料索引.csv')
  assert.match(md.toString(), /^# SOL 设备平台分析报告/)
  assert.match(pdf.toString(), /^%PDF-1.4/)
  const pdfOffset = Number(pdf.toString().match(/startxref\n(\d+)/)[1])
  assert.equal(pdf.toString().slice(pdfOffset, pdfOffset + 4), 'xref')
  assert.match(csv.toString(), /"类型","名称","环境"/)
  assert.match(csv.toString(), /发布检查.txt/)
  check(
    '文件夹范围含后代文档；显式附件、只读工具轨迹、流式回复、单轮队列与真实 MD/PDF/CSV 导出通过',
  )

  await clickText('存入项目')
  await clickText('保存并分享')
  assert.ok((await storage()).projects.sol.artifacts.some((item) => item.id === reportFiles[0].id))
  await logout()
  await login('lin')
  await route(`/p/sol/chat?conversation=${conversationId}`)
  assert.match(await text(), /会话不存在或无权访问/)
  assert.doesNotMatch(await text(), /验收固定会话/)
  assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="输入问题"]'))`), false)
  await route('/p/sol/tasks')
  assert.doesNotMatch(await text(), /验收私有分析助手/)
  await route('/notifications')
  assert.doesNotMatch(await text(), /验收私有分析助手/)
  check('私有平台 Agent 会话、任务与通知仅所有者可见；报告显式保存后进入项目')
  await logout()
  await login('admin')

  await route('/p/sol/agents')
  await agentAction('验收私有分析助手', '配置')
  await fill('[aria-label="共享范围"]', 'project')
  await clickText('保存')
  await until(async () => (await text()).includes('1 个已有会话'), '历史共享影响提示')
  assert.match(await text(), /消息和附件/)
  await clickText('确认更改共享范围')
  assert.equal((await storage()).agents.find((item) => item.id === platformId).sharing, 'project')
  await logout()
  await login('lin')
  await route('/p/sol/chat')
  await pickConversation('验收固定会话')
  assert.match(await text(), /验收附件.md/)
  await route('/p/sol/tasks')
  assert.match(await text(), /验收私有分析助手/)
  await route('/notifications')
  assert.match(await text(), /验收私有分析助手/)
  await route('/p/sol/chat')
  await pickConversation('验收固定会话')
  await fill('[aria-label="输入问题"]', '生成共享报告')
  await click('[aria-label="发送"]')
  await waitComplete(conversationId)
  current = await activeConversation(conversationId)
  const sharedFiles = current.messages.at(-1).files
  assert.equal(sharedFiles.length, 3)
  assert.ok(sharedFiles.every((file) => file.savedToProject))
  const savedState = await storage()
  assert.ok(
    sharedFiles.every((file) =>
      savedState.projects.sol.artifacts.some((item) => item.id === file.id),
    ),
  )
  check('私有改共享明确影响旧会话、任务与通知；其他成员可接续，共享报告自动回存项目')

  await chooseScenario('clarify')
  await fill('[aria-label="输入问题"]', '帮我分析目前情况')
  await click('[aria-label="发送"]')
  await waitComplete(conversationId)
  assert.ok((await activeConversation(conversationId)).pendingClarification?.length)
  await clickText('部署前状态检查')
  await clickText('提交并继续')
  await until(async () => Boolean((await activeConversation(conversationId)).active), '澄清后继续')
  await click('[aria-label="停止生成"]')
  await until(async () => !(await activeConversation(conversationId)).active, '停止本轮')
  assert.ok((await activeConversation(conversationId)).lastStopped)
  await clickText('继续此轮')
  await until(async () => Boolean((await activeConversation(conversationId)).active), '停止后继续')
  await openDemo()
  await clickText('模拟中心断线')
  await clickText('完成')
  const beforePause = (await activeConversation(conversationId)).active.elapsed
  await wait(1200)
  assert.equal((await activeConversation(conversationId)).active.elapsed, beforePause)
  await fill('[aria-label="输入问题"]', '断线时不应入队')
  await click('[aria-label="排队到下一轮"]')
  assert.equal((await activeConversation(conversationId)).queue.length, 0)
  await reloadReady('[aria-label="输入问题"]')
  assert.ok((await evaluate('location.hash')).includes(`conversation=${conversationId}`))
  assert.ok((await activeConversation(conversationId)).active)
  await waitComplete(conversationId)
  check('澄清、成员停止/继续、断线暂停、拒绝断线输入及刷新恢复均通过')

  await fill('[aria-label="输入问题"]', '帮我部署并重启服务，迁移机柜')
  await click('[aria-label="发送"]')
  await waitComplete(conversationId)
  current = await activeConversation(conversationId)
  assert.ok(
    current.messages
      .at(-1)
      .steps.some((item) => item.name === 'platform.capability.check' && item.status === 'blocked'),
  )
  await viewport(390, 844)
  await assertNoOverflow('移动会话')
  assert.ok(
    await evaluate(`(() => {
      const rect = document.querySelector('[aria-label="输入问题"]').getBoundingClientRect()
      return rect.top > 0 && rect.bottom < innerHeight
    })()`),
    '移动端输入区始终在视口内',
  )
  await click('[aria-label="打开历史会话"]')
  await visible('[role="dialog"] .wb-conversation-button')
  await pickConversation('验收固定会话')
  await click('[aria-label="打开本轮上下文"]')
  await visible('[role="dialog"] .wb-chat-context-section')
  await clickText('关闭', '[role="dialog"] button')
  await until(() => evaluate('!document.querySelector(\'[role="dialog"]\')'), '上下文抽屉关闭完成')
  await screenshot('mobile-chat')
  await viewport()
  await screenshot('desktop-chat')
  check('平台 Agent 拒绝变更操作；移动输入区固定可见，历史与上下文抽屉可用且无横向溢出')

  await logout()
  await login('admin')
  await route('/p/sol/agents')
  await agentAction('验收私有分析助手', '模拟离线')
  await route('/p/sol/chat')
  await pickConversation('验收固定会话')
  const oldTaskCount = (await storage()).tasks.length
  await fill('[aria-label="输入问题"]', '离线时不要提交')
  await click('[aria-label="发送"]')
  assert.equal((await storage()).tasks.length, oldTaskCount)
  assert.equal((await activeConversation(conversationId)).queue.length, 0)
  assert.match(await text(), /Agent 离线/)
  await openDemo()
  await clickText('模拟 Agent 重新连接', '[role="dialog"] button')
  await clickText('完成')
  await route('/p/sol/agents')
  await agentAction('验收私有分析助手', '配置')
  await fill('[aria-label="共享范围"]', 'private')
  await clickText('保存')
  await clickText('确认更改共享范围')
  await logout()
  await login('lin')
  await route('/p/sol/chat')
  assert.doesNotMatch(await text(), /验收固定会话/)
  await route('/p/sol/tasks')
  assert.doesNotMatch(await text(), /验收私有分析助手/)
  check('离线发送不建任务、不排队；共享改私有即时收回历史会话和任务访问')

  await logout()
  await login('admin')
  await route('/p/atlas/artifacts')
  await click('[aria-label="atlas-api · 脱敏源码 操作菜单"]')
  await clickText('删除产物', '[role=menuitem]')
  await clickText('删除文件')
  await route('/p/atlas/chat')
  await clickText('新建会话')
  await fill('[aria-label="会话 Agent"]', 'agent-platform-atlas')
  await clickText('创建会话')
  assert.ok(await evaluate("Boolean(document.querySelector('[role=dialog]'))"))
  assert.match(await text(), /没有可用的脱敏源码制品/)
  await fill('[aria-label="源码策略"]', 'raw')
  await fill('[aria-label="会话名称"]', '显式原始源码验收')
  await clickText('创建会话')
  const rawConversation = (await storage()).conversations.find(
    (item) => item.title === '显式原始源码验收',
  )
  assert.equal(rawConversation.sourceMode, 'raw')
  assert.equal(rawConversation.sourceArtifactId, 'source-atlas')
  check('缺少脱敏制品时禁止自动回退；只有显式选择原始源码才能创建对应会话')

  const beforeLinkedConversations = (await storage()).conversations.length
  await route('/p/sol/chat?document=doc-spec-sol')
  await visible('[aria-label="会话名称"]')
  assert.equal(await evaluate('document.querySelector(\'[aria-label="源码策略"]\').value'), 'none')
  assert.equal(
    await evaluate('document.querySelector("#scope-doc-spec-sol").getAttribute("aria-checked")'),
    'true',
  )
  assert.equal((await storage()).conversations.length, beforeLinkedConversations)
  await fill('[aria-label="会话名称"]', '从文档准备的新会话')
  await clickText('创建会话')
  const linkedDocument = (await storage()).conversations.find(
    (item) => item.title === '从文档准备的新会话',
  )
  assert.deepEqual(linkedDocument.scopeIds, ['doc-spec-sol'])
  assert.equal(linkedDocument.messages.length, 0)
  await route('/p/sol/chat?artifact=sanitized-sol')
  await visible('[aria-label="会话名称"]')
  assert.equal(
    await evaluate('document.querySelector(\'[aria-label="源码策略"]\').value'),
    'sanitized',
  )
  assert.equal(
    await evaluate('document.querySelector(\'[aria-label="源码制品"]\').value'),
    'sanitized-sol',
  )
  await clickText('取消')
  await route('/p/sol/chat?artifact=source-sol')
  await visible('#confirm-linked-raw')
  const beforeRawConfirmation = (await storage()).conversations.length
  await clickText('创建会话')
  assert.ok(await evaluate('Boolean(document.querySelector("#confirm-linked-raw"))'))
  assert.equal((await storage()).conversations.length, beforeRawConfirmation)
  await until(async () => (await text()).includes('请明确确认'), '原始源码需要明确确认')
  await click('#confirm-linked-raw')
  await fill('[aria-label="会话名称"]', '从源码链接明确确认')
  await clickText('创建会话')
  const linkedRaw = (await storage()).conversations.find(
    (item) => item.title === '从源码链接明确确认',
  )
  assert.equal(linkedRaw.sourceMode, 'raw')
  assert.equal(linkedRaw.sourceArtifactId, 'source-sol')
  assert.equal(linkedRaw.messages.length, 0)
  await route('/p/sol/chat?agent=agent-platform-sol')
  await visible('[aria-label="会话 Agent"]')
  assert.equal(
    await evaluate('document.querySelector(\'[aria-label="会话 Agent"]\').value'),
    'agent-platform-sol',
  )
  await clickText('取消')
  await route(`/p/sol/chat?conversation=${linkedRaw.id}`)
  await reloadReady('[aria-label="输入问题"]')
  assert.match(await text(), /从源码链接明确确认/)
  check(
    '文档、脱敏制品及 Agent 深链接只打开新会话准备；原始源码链接需勾选确认，会话 URL 刷新保持选中',
  )

  assert.deepEqual(browser.errors, [], `浏览器异常：${browser.errors.join('\n')}`)
  await writeFile(
    path.join(output, 'checks.json'),
    JSON.stringify(
      { checks: browser.checks, errors: browser.errors, warnings: browser.warnings },
      null,
      2,
    ),
  )
  console.log(`Agent 验收通过：${browser.checks.length} 项；产物目录 ${output}`)
} catch (error) {
  await screenshot('failure').catch(() => {})
  console.error('浏览器状态：', (await text().catch(() => '')).slice(-6500))
  console.error('浏览器异常：', browser.errors)
  throw error
} finally {
  await browser.close()
}
