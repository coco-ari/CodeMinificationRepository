import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { startBrowser, storageKey } from './helpers/prototype-browser.mjs'

// 验证交互原型的状态转换，不代表真实 Agent 运行器已经接入或通过验收。
const b = await startBrowser('agent-interaction')
const primaryId = 'conversation-sol-intro'
const secondId = 'conversation-interaction-second'
const inputSelector = '[aria-label="输入问题"]'
const layoutSnapshots = []
const text = () => b.evaluate('document.body.innerText')
const conversation = async (id = primaryId) =>
  (await b.storage()).conversations.find((item) => item.id === id)
const inputValue = () =>
  b.evaluate(`document.querySelector(${JSON.stringify(inputSelector)}).value`)
const openConversation = async (id) => {
  await b.route(`/p/sol/chat?conversation=${id}`)
  await b.visible(inputSelector)
}

async function reloadReady() {
  const origin = await b.evaluate('performance.timeOrigin')
  await b.command('Page.reload')
  await b.until(
    () =>
      b.evaluate(
        `performance.timeOrigin !== ${origin} && document.readyState === 'complete' && Boolean(document.querySelector(${JSON.stringify(inputSelector)}))`,
      ),
    '会话刷新完成',
  )
}

async function fixture(mutate) {
  // 同一次浏览器调用中写入夹具并刷新，避免旧页面的调度器覆盖夹具。
  const origin = await b.evaluate('performance.timeOrigin')
  await b.evaluate(`(() => {
    const state = JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}));
    (${mutate.toString()})(state);
    localStorage.setItem(${JSON.stringify(storageKey)}, JSON.stringify(state));
    location.reload();
  })()`)
  await b.until(
    () =>
      b.evaluate(
        `performance.timeOrigin !== ${origin} && document.readyState === 'complete' && Boolean(document.querySelector(${JSON.stringify(inputSelector)}))`,
      ),
    '夹具会话加载完成',
  )
}

async function selectFile(name, content) {
  const filePath = path.join(b.output, name)
  await writeFile(filePath, content)
  const document = await b.command('DOM.getDocument')
  const node = await b.command('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: '[aria-label="选择会话附件"]',
  })
  await b.command('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filePath] })
}

async function upload(name, content) {
  await selectFile(name, content)
  await b.until(
    () =>
      b.evaluate(
        `Boolean(document.querySelector(${JSON.stringify(`[aria-label="移除 ${name}"]`)}))`,
      ),
    `附件 ${name} 读取完成`,
  )
}

async function chooseScenario(value) {
  await b.click('[aria-label="会话更多操作"]')
  await b.clickText('演示场景', '[role=menuitem]')
  await b.fill('[aria-label="本轮演示场景"]', value)
  await b.clickText('完成')
}

async function expandQueue() {
  const trigger = '.wb-chat-queue button[aria-expanded]'
  await b.visible(trigger)
  if (
    (await b.evaluate(
      `document.querySelector(${JSON.stringify(trigger)}).getAttribute('aria-expanded')`,
    )) !== 'true'
  )
    await b.click(trigger)
}

async function collapseQueue() {
  const trigger = '.wb-chat-queue button[aria-expanded]'
  if (
    await b.evaluate(
      `document.querySelector(${JSON.stringify(trigger)})?.getAttribute('aria-expanded') === 'true'`,
    )
  )
    await b.click(trigger)
}

async function assertButtonsInViewport(labels, label) {
  for (const name of labels) {
    const selector = `[aria-label="${name}"]`
    await b.visible(selector)
    const bounds = await b.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    })()`)
    assert.ok(
      bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= bounds.viewportWidth + 1 &&
        bounds.bottom <= bounds.viewportHeight + 1 &&
        bounds.width >= 24 &&
        bounds.height >= 24,
      `${label} / ${name}: ${JSON.stringify(bounds)}`,
    )
  }
  await b.assertNoOverflow(label)
}

async function assertWorkspaceLayout(label) {
  await b.evaluate(
    'Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))',
  )
  await b.evaluate(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
  const snapshot = await b.evaluate(`(() => {
    const measure = selector => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop,
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height },
        display: style.display, overflowY: style.overflowY, gridTemplateRows: style.gridTemplateRows };
    };
    return { viewport: { width: innerWidth, height: innerHeight },
      workspace: measure('.wb-agent-workspace'), chat: measure('.wb-agent-chat'),
      header: measure('.wb-chat-header'), composer: measure('.wb-chat-composer'),
      history: measure('.wb-chat-history'), historyEntry: measure('.wb-chat-history .wb-conversation-button'),
      messages: measure('[aria-label="会话消息"]') };
  })()`)
  layoutSnapshots.push({ label, ...snapshot })
  await writeFile(path.join(b.output, 'layout.json'), JSON.stringify(layoutSnapshots, null, 2))
  const detail = `${label}: ${JSON.stringify(snapshot)}`
  assert.ok(
    snapshot.header.rect.top >= snapshot.workspace.rect.top - 1,
    `会话标题不能被容器滚动裁掉。${detail}`,
  )
  assert.ok(
    Math.abs(snapshot.workspace.rect.bottom - snapshot.composer.rect.bottom) <= 30,
    `输入区应贴近工作区底部，不能留下大块空白。${detail}`,
  )
  if (snapshot.viewport.width >= 1024) {
    assert.notEqual(snapshot.history.display, 'none', `桌面会话历史应可见。${detail}`)
    assert.ok(
      snapshot.historyEntry.rect.top >= snapshot.workspace.rect.top - 1 &&
        snapshot.historyEntry.rect.bottom <= snapshot.workspace.rect.bottom,
      `桌面历史会话应位于工作区内。${detail}`,
    )
  }
}

async function stop() {
  await b.click('[aria-label="停止生成"]')
  await b.until(async () => !(await conversation()).active, '当前轮停止')
}

try {
  await b.reset('admin')
  await openConversation(primaryId)
  await assertWorkspaceLayout('初始桌面会话')
  await fixture((state) => {
    const source = state.conversations.find((item) => item.id === 'conversation-sol-intro')
    state.conversations.push({
      ...structuredClone(source),
      id: 'conversation-interaction-second',
      title: '交互验收第二会话',
      messages: [],
      queue: [],
      active: null,
      pendingClarification: null,
      lastStopped: null,
    })
  })

  await b.fill(inputSelector, '核对当前测试环境，先阅读附件')
  await upload('original-evidence.md', '# 本轮原始附件\n只读核对测试环境。\n')
  await openConversation(secondId)
  assert.equal(await inputValue(), '')
  assert.equal(
    await b.evaluate(
      'Boolean(document.querySelector(\'[aria-label="移除 original-evidence.md"]\'))',
    ),
    false,
  )
  await b.fill(inputSelector, '第二会话独立草稿')
  await openConversation(primaryId)
  assert.equal(await inputValue(), '核对当前测试环境，先阅读附件')
  await b.visible('[aria-label="移除 original-evidence.md"]')
  await reloadReady()
  assert.equal(await inputValue(), '核对当前测试环境，先阅读附件')
  await b.visible('[aria-label="移除 original-evidence.md"]')
  await openConversation(secondId)
  assert.equal(await inputValue(), '第二会话独立草稿')
  await openConversation(primaryId)
  await assertWorkspaceLayout('草稿切换与刷新后')
  b.check('文本和附件草稿按会话保存，切换与刷新后保持，其他会话不会读到附件')

  await openConversation(secondId)
  await b.evaluate(`(() => {
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function(file) {
      if (file.name !== 'slow-switch.txt') return original.call(this, file);
      const reader = this;
      window.__releaseInteractionFileRead = () => new Promise((resolve, reject) => {
        FileReader.prototype.readAsDataURL = original;
        reader.addEventListener('loadend', resolve, { once: true });
        reader.addEventListener('error', reject, { once: true });
        original.call(reader, file);
      });
    };
  })()`)
  const tasksBeforeUpload = (await b.storage()).tasks.length
  const messagesBeforeUpload = (await conversation(secondId)).messages.length
  await selectFile('slow-switch.txt', '异步读取完成后只能属于发起上传的会话。')
  await b.until(
    () => b.evaluate('typeof window.__releaseInteractionFileRead === "function"'),
    '真实附件读取已被延迟',
  )
  assert.equal(await b.evaluate('document.querySelector(\'[aria-label="发送"]\').disabled'), true)
  await b.evaluate(`document.querySelector(${JSON.stringify(inputSelector)}).focus()`)
  await b.key('Enter', 13)
  await b.evaluate(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
  assert.equal((await b.storage()).tasks.length, tasksBeforeUpload)
  assert.equal((await conversation(secondId)).messages.length, messagesBeforeUpload)
  assert.equal((await conversation(secondId)).active, null)
  assert.equal((await conversation(secondId)).queue.length, 0)
  assert.equal(await inputValue(), '第二会话独立草稿')
  await openConversation(primaryId)
  await b.evaluate('window.__releaseInteractionFileRead().then(() => true)')
  await b.until(
    () =>
      b.evaluate(`Object.keys(localStorage).filter(key => key.startsWith('wb:v2:conversation-draft:')).some(key => {
        const draft = JSON.parse(localStorage.getItem(key));
        return draft.scope?.[2] === 'conversation-interaction-second'
          && draft.attachments.some(file => file.name === 'slow-switch.txt');
      })`),
    '后台完成的附件已保存到原会话',
  )
  assert.equal(await inputValue(), '核对当前测试环境，先阅读附件')
  assert.equal(
    await b.evaluate('Boolean(document.querySelector(\'[aria-label="移除 slow-switch.txt"]\'))'),
    false,
  )
  await openConversation(secondId)
  await b.visible('[aria-label="移除 slow-switch.txt"]')
  assert.equal(await inputValue(), '第二会话独立草稿')
  await b.click('[aria-label="移除 slow-switch.txt"]')
  await openConversation(primaryId)
  await assertWorkspaceLayout('慢附件跨会话完成后')
  b.check('附件读取中 Enter 不会漏附件发送；切换后完成的上传只回到原会话草稿')

  await chooseScenario('slow')
  await b.click('[aria-label="发送"]')
  await b.until(async () => Boolean((await conversation()).active), '开始本轮')
  assert.equal(await inputValue(), '')
  assert.equal((await conversation()).active.attachments[0].name, 'original-evidence.md')
  // 延长当前轮次，使队列交互验收不受机器速度或浏览器启动耗时影响。
  await fixture((state) => {
    const item = state.conversations.find((value) => value.id === 'conversation-sol-intro')
    item.active.duration = 180000
    item.active.elapsed = 100000
    item.active.lastTick = Date.now()
    const task = state.tasks.find((value) => value.id === item.active.taskId)
    task.duration = item.active.duration
    task.elapsed = item.active.elapsed
  })
  await b.until(
    () =>
      b.evaluate(
        `Boolean(document.querySelector('.wb-chat-message-assistant[aria-live] .wb-chat-markdown')?.textContent.trim())`,
      ),
    '可见的部分回复',
  )
  const initial = await conversation()
  const activeId = initial.active.id
  const taskId = initial.active.taskId
  const taskCount = (await b.storage()).tasks.length
  await b.fill(inputSelector, '先检查连接失败原因，暂时不要生成报告')
  await assertButtonsInViewport(
    ['引导当前执行', '排队到下一轮', '停止生成'],
    '桌面运行中的三种操作',
  )
  await b.click('[aria-label="引导当前执行"]')
  await b.until(async () => (await conversation()).active.guidance?.length === 1, '引导已接收')
  let item = await conversation()
  assert.equal(item.active.id, activeId)
  assert.equal(item.active.taskId, taskId)
  assert.equal((await b.storage()).tasks.length, taskCount)
  assert.equal(item.queue.length, 0)
  assert.ok(
    item.messages.some(
      (message) =>
        message.role === 'user' &&
        message.kind === 'steer' &&
        message.content === '先检查连接失败原因，暂时不要生成报告',
    ),
  )
  assert.equal(await inputValue(), '')
  await assertWorkspaceLayout('桌面引导提交后')
  b.check('引导补充到当前轮，保留同一个轮次与任务，不新建任务或误入队列')

  await upload('queued-evidence.txt', '下一轮专用附件，停止后仍应保留。')
  await b.fill(inputSelector, '下一轮整理检查结果')
  await b.click('[aria-label="排队到下一轮"]')
  await b.until(async () => (await conversation()).queue.length === 1, '首条消息入队')
  const queuedId = (await conversation()).queue[0].id
  assert.equal((await conversation()).queue[0].attachments[0].name, 'queued-evidence.txt')
  assert.equal((await conversation()).active.id, activeId)
  assert.equal((await conversation()).active.guidance.length, 1)
  assert.equal((await b.storage()).tasks.length, taskCount)
  await expandQueue()
  await b.click(`[aria-label="编辑排队消息 ${queuedId}"]`)
  await b.fill('[aria-label="排队消息内容"]', '下一轮整理连接问题清单')
  await b.clickText('保存修改')
  await b.until(
    async () => (await conversation()).queue[0].content === '下一轮整理连接问题清单',
    '队列编辑保存',
  )
  assert.equal((await conversation()).queue[0].attachments[0].name, 'queued-evidence.txt')

  await b.fill(inputSelector, '这条排队消息应删除')
  await b.click('[aria-label="排队到下一轮"]')
  await b.until(async () => (await conversation()).queue.length === 2, '第二条消息入队')
  const removedId = (await conversation()).queue[1].id
  await expandQueue()
  await b.click(`[aria-label="移除排队消息 ${removedId}"]`)
  await b.until(async () => (await conversation()).queue.length === 1, '移除排队消息')
  assert.equal((await conversation()).queue[0].id, queuedId)

  await b.fill(inputSelector, '这条补充立即用于当前分析')
  await b.click('[aria-label="排队到下一轮"]')
  await b.until(async () => (await conversation()).queue.length === 2, '待转引导消息入队')
  const promotedId = (await conversation()).queue[1].id
  await expandQueue()
  await b.click(`[aria-label="引导排队消息 ${promotedId}"]`)
  await b.until(async () => {
    const current = await conversation()
    return current.queue.length === 1 && current.active.guidance.length === 2
  }, '排队消息转为当前引导')
  item = await conversation()
  assert.equal(item.active.id, activeId)
  assert.equal(item.active.taskId, taskId)
  assert.equal(item.queue[0].id, queuedId)
  assert.equal(
    item.messages.filter(
      (message) => message.kind === 'steer' && message.content === '这条补充立即用于当前分析',
    ).length,
    1,
  )
  await assertWorkspaceLayout('队列展开编辑删除转引导后')
  b.check('排队不打断当前轮；队列支持编辑、删除和转为引导，编辑保留附件且不重复发送')

  const beforeStop = await conversation()
  await stop()
  item = await conversation()
  const partial = item.messages.find(
    (message) =>
      message.role === 'assistant' && message.status === 'interrupted' && message.taskId === taskId,
  )
  assert.ok(partial?.content?.trim(), '停止应保存已经显示的部分回复')
  assert.ok(
    partial.content.length < beforeStop.active.response.content.length,
    '停止不得把尚未输出的完整回复作为已完成内容',
  )
  assert.ok(item.lastStopped.content.startsWith('核对当前测试环境，先阅读附件'))
  assert.ok(item.lastStopped.content.includes('先检查连接失败原因，暂时不要生成报告'))
  assert.equal(item.lastStopped.attachments[0].name, 'original-evidence.md')
  assert.equal(item.queuePaused, true)
  assert.equal(item.queue[0].id, queuedId)
  assert.equal(item.queue[0].attachments[0].name, 'queued-evidence.txt')
  assert.equal((await b.storage()).tasks.find((task) => task.id === taskId).status, 'stopped')
  await reloadReady()
  item = await conversation()
  assert.equal(item.active, null)
  assert.equal(item.queuePaused, true)
  assert.ok(item.messages.some((message) => message.id === partial.id))
  assert.equal(item.queue[0].id, queuedId)
  await assertWorkspaceLayout('停止并刷新后')
  b.check('停止保存部分输出和原输入附件，暂停并保留待发队列，刷新后不会偷偷继续')

  await b.fill(inputSelector, '这是仍未提交的新草稿')
  await upload('unrelated-draft.md', '# 新草稿附件\n不能混入恢复执行。\n')
  await b.clickText('继续此轮')
  await b.until(async () => Boolean((await conversation()).active), '继续已停止轮次')
  item = await conversation()
  assert.deepEqual(
    item.active.attachments.map((file) => file.name),
    ['original-evidence.md'],
  )
  assert.ok(item.active.input.includes('核对当前测试环境，先阅读附件'))
  assert.equal(item.queue[0].id, queuedId)
  assert.equal(await inputValue(), '这是仍未提交的新草稿')
  await b.click('[aria-label="移除 unrelated-draft.md"]')
  await b.fill(inputSelector, '')
  await stop()
  await b.clickText('恢复队列')
  await b.until(
    async () => (await conversation()).active?.input === '下一轮整理连接问题清单',
    '恢复队列后执行首条消息',
  )
  item = await conversation()
  assert.equal(item.queue.length, 0)
  assert.deepEqual(
    item.active.attachments.map((file) => file.name),
    ['queued-evidence.txt'],
  )
  await assertWorkspaceLayout('继续后停止并恢复队列')
  b.check('继续此轮使用原始附件；显式恢复队列才启动保留的首条输入及其附件')

  // 用足够长的历史与回复观察滚动位置，无须先执行大量完整会话。
  await fixture((state) => {
    const current = state.conversations.find((value) => value.id === 'conversation-sol-intro')
    current.messages.unshift(
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `interaction-history-${index}`,
        role: 'assistant',
        content: `历史记录 ${index + 1}。\n\n${'这是一段可回看的历史分析内容。'.repeat(8)}`,
        at: new Date().toISOString(),
        steps: [],
        citations: [],
        files: [],
      })),
    )
    current.active.duration = 120000
    current.active.elapsed = 65000
    current.active.lastTick = Date.now()
    current.active.response.content = '正在持续生成的分析结果。\n\n'.repeat(300)
    const task = state.tasks.find((value) => value.id === current.active.taskId)
    task.duration = current.active.duration
    task.elapsed = current.active.elapsed
  })
  await b.until(
    () =>
      b.evaluate(
        `(() => { const el = document.querySelector('[aria-label="会话消息"]'); return el.scrollHeight > el.clientHeight * 2 })()`,
      ),
    '长消息历史加载',
  )
  await assertWorkspaceLayout('长历史和流式回复载入后')
  await b.evaluate(`(() => {
    const el = document.querySelector('[aria-label="会话消息"]');
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  })()`)
  await b.until(async () => (await text()).includes('回到最新消息'), '保持历史阅读位置')
  const elapsedBefore = (await conversation()).active.elapsed
  await b.until(
    async () => (await conversation()).active.elapsed > elapsedBefore + 1500,
    '后台继续产生流式回复',
  )
  assert.ok(
    await b.evaluate('document.querySelector(\'[aria-label="会话消息"]\').scrollTop < 10'),
    '阅读历史时，流式更新不能把视口拉到底部',
  )
  await assertWorkspaceLayout('长历史上翻后')
  await b.clickText('回到最新消息')
  await b.until(
    () =>
      b.evaluate(
        `(() => { const el = document.querySelector('[aria-label="会话消息"]'); return el.scrollHeight - el.scrollTop - el.clientHeight < 80 })()`,
      ),
    '显式回到最新消息',
  )
  await assertWorkspaceLayout('点击回到最新消息后')
  b.check('用户上翻后仍有流式更新，阅读位置保持；只有点击回到最新消息才跟随底部')

  await collapseQueue()
  await b.viewport(390, 844)
  await b.fill(inputSelector, '手机端补充要求')
  await assertButtonsInViewport(
    ['引导当前执行', '排队到下一轮', '停止生成'],
    '390 像素手机运行中的操作',
  )
  await assertWorkspaceLayout('切换 390 像素手机后')
  const mobileTurnId = (await conversation()).active.id
  await b.click('[aria-label="引导当前执行"]')
  await b.until(
    async () =>
      (await conversation()).messages.some(
        (message) => message.kind === 'steer' && message.content === '手机端补充要求',
      ),
    '手机引导提交',
  )
  assert.equal((await conversation()).active.id, mobileTurnId)
  await b.fill(inputSelector, '手机端排队输入')
  await b.click('[aria-label="排队到下一轮"]')
  await b.until(
    async () => (await conversation()).queue.some((entry) => entry.content === '手机端排队输入'),
    '手机消息入队',
  )
  await b.assertNoOverflow('手机入队后')
  await assertWorkspaceLayout('手机引导及排队后')
  await b.until(
    () => b.evaluate('!document.querySelector("[data-sonner-toast]")'),
    '提示自然关闭后截图，避免遮住会话标题',
  )
  await b.screenshot('mobile-running')
  await b.viewport()
  await assertWorkspaceLayout('恢复桌面视口后')
  await b.screenshot('desktop-running')
  b.check('桌面和 390 像素手机均可直接引导、排队和停止，按钮在视口内且页面无横向溢出')

  // 另一个可执行会话证明调度器确实推进过，同时待澄清会话仍阻止队列抢跑。
  await fixture((state) => {
    const current = state.conversations.find((value) => value.id === 'conversation-sol-intro')
    const control = state.conversations.find(
      (value) => value.id === 'conversation-interaction-second',
    )
    for (const item of [current, control]) {
      if (item.active) {
        const task = state.tasks.find((value) => value.id === item.active.taskId)
        if (task) task.status = 'stopped'
      }
      item.active = null
      item.lastStopped = null
      item.queuePaused = false
      item.queue = [
        {
          id: `clarification-queue-${item.id}`,
          content: item === current ? '澄清完成后再处理的输入' : '调度器对照轮次',
          attachments: [],
          actorId: 'admin',
          scenario: 'slow',
        },
      ]
    }
    current.pendingClarification = ['部署前状态检查', '整理资料']
    control.pendingClarification = null
  })
  await b.until(
    async () => (await conversation(secondId)).active?.elapsed > 1200,
    '对照会话已开始执行',
  )
  item = await conversation()
  assert.equal(item.active, null)
  assert.equal(item.queue.length, 1)
  assert.deepEqual(item.pendingClarification, ['部署前状态检查', '整理资料'])
  await b.clickText('部署前状态检查')
  await b.clickText('提交并继续')
  await b.until(async () => Boolean((await conversation()).active), '明确回答澄清后继续')
  item = await conversation()
  assert.equal(item.active.input, '部署前状态检查')
  assert.equal(item.pendingClarification, null)
  assert.equal(item.queue.length, 1)
  b.check('等待澄清时调度器不会抢跑队列；用户明确作答后先处理回答，保留下一轮输入')

  assert.deepEqual(b.errors, [], `浏览器异常：${b.errors.join('\n')}`)
  await writeFile(
    path.join(b.output, 'checks.json'),
    JSON.stringify({ checks: b.checks, errors: b.errors, warnings: b.warnings }, null, 2),
  )
  console.log(`Agent 交互验收通过：${b.checks.length} 组；产物目录 ${b.output}`)
} catch (error) {
  await b.screenshot('failure').catch(() => {})
  console.error('浏览器状态：', (await text().catch(() => '')).slice(-6500))
  console.error('浏览器异常：', b.errors)
  throw error
} finally {
  await b.close()
}
