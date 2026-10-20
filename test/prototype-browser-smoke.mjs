import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { crc32 } from 'node:zlib'

const base = process.env.PROTOTYPE_URL || 'http://127.0.0.1:5173/prototype.html'
const artifactDirectory = path.resolve('.test-artifacts/prototype')
const downloadDirectory = path.join(artifactDirectory, 'downloads')
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cmr-prototype-browser-'))
const browserDirectory = path.join(temporary, 'browser')
const storageKey = 'autoops:interactive-prototype:v1'
const candidates = [
  process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean)

let executable
for (const candidate of candidates) {
  try {
    await access(candidate)
    executable = candidate
    break
  } catch {}
}
if (!executable) throw new Error('未找到浏览器，请设置 BROWSER_PATH 后重试')

await mkdir(downloadDirectory, { recursive: true })
const browser = spawn(
  executable,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${browserDirectory}`,
    'about:blank',
  ],
  { windowsHide: true, stdio: 'ignore' },
)
let socket
let command
let evaluate
const errors = []
const warnings = []
const checks = []
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function until(action, label, attempts = 240) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await action()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await wait(50)
  }
  throw new Error(`等待失败：${label}${lastError ? `；${lastError.message}` : ''}`)
}

function verifyZip(buffer) {
  let offset = 0
  const files = []
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6)
    const method = buffer.readUInt16LE(offset + 8)
    const checksum = buffer.readUInt32LE(offset + 14)
    const size = buffer.readUInt32LE(offset + 18)
    const uncompressedSize = buffer.readUInt32LE(offset + 22)
    const nameSize = buffer.readUInt16LE(offset + 26)
    const extraSize = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 30, offset + 30 + nameSize).toString('utf8')
    const dataOffset = offset + 30 + nameSize + extraSize
    const data = buffer.subarray(dataOffset, dataOffset + size)
    assert.equal(method, 0, '示例 ZIP 应使用可验证的无压缩格式')
    assert.equal(flags & 0x0800, 0x0800, 'ZIP 文件名应声明 UTF-8')
    assert.equal(data.length, uncompressedSize, 'ZIP 文件长度应与文件头一致')
    assert.equal(crc32(data), checksum, `ZIP 文件内容校验失败：${name}`)
    assert.ok(!name.split('/').includes('..'), 'ZIP 文件路径不得逃出解压目录')
    files.push({ name, content: data.toString('utf8') })
    offset = dataOffset + size
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'ZIP 应包含中央目录')
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50, 'ZIP 应包含结束记录')
  assert.equal(buffer.readUInt16LE(buffer.length - 12), files.length, 'ZIP 记录数量应正确')
  assert.ok(
    files.some((file) => file.name === 'README.md'),
    'ZIP 应包含输入源码',
  )
  return files
}

try {
  await until(async () => (await fetch(base)).ok, `原型服务 ${base}`, 600)
  const port = await until(
    async () =>
      Number(
        (await readFile(path.join(browserDirectory, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
      ),
    '浏览器启动',
  )
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data)
    if (data.id && pending.has(data.id)) {
      const { resolve, reject, timer } = pending.get(data.id)
      clearTimeout(timer)
      pending.delete(data.id)
      if (data.error) reject(new Error(data.error.message))
      else resolve(data.result)
    }
    if (data.method === 'Runtime.exceptionThrown') {
      errors.push(
        data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text,
      )
    }
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') {
      warnings.push(data.params.entry.text)
    }
  })
  command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`浏览器命令超时：${method}`))
      }, 15000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text,
      )
    }
    return result.result?.value
  }
  const visible = (selector) =>
    until(
      () =>
        evaluate(
          `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`,
        ),
      selector,
    )
  const buttonExpression = (text, selector = 'button') =>
    `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el => el.textContent.trim() === ${JSON.stringify(text)} && el.getClientRects().length && !el.disabled)`
  async function mouseExpression(expression, label) {
    await until(() => evaluate(`Boolean((${expression})?.getClientRects().length)`), label)
    await evaluate(
      `Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`,
    )
    await evaluate(
      `new Promise(resolve => { (${expression}).scrollIntoView({block:'center',inline:'nearest'}); requestAnimationFrame(() => requestAnimationFrame(resolve)); })`,
    )
    const point = await evaluate(
      `(() => { const r = (${expression}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
    )
    await command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    })
    await command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    })
  }
  const click = (selector) =>
    mouseExpression(`document.querySelector(${JSON.stringify(selector)})`, selector)
  const clickText = (text, selector = 'button') =>
    mouseExpression(buttonExpression(text, selector), text)
  const clickCardButton = (title, text) =>
    mouseExpression(
      `Array.from(document.querySelectorAll('[data-slot=card]')).find(card => card.querySelector('[data-slot=card-title]')?.textContent === ${JSON.stringify(title)})?.querySelectorAll('button') && Array.from(Array.from(document.querySelectorAll('[data-slot=card]')).find(card => card.querySelector('[data-slot=card-title]')?.textContent === ${JSON.stringify(title)}).querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)})`,
      `${title} · ${text}`,
    )
  async function key(key, keyCode) {
    for (const type of ['keyDown', 'keyUp']) {
      await command('Input.dispatchKeyEvent', {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: keyCode,
      })
    }
  }
  async function fill(selector, value) {
    await visible(selector)
    await evaluate(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()`,
    )
  }
  const storage = () => evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`)
  const project = async () => (await storage()).projects.sol
  const route = async (hash) => {
    await evaluate(`location.hash = ${JSON.stringify(hash)}`)
    await until(() => evaluate(`location.hash === ${JSON.stringify(hash)}`), hash)
    await wait(120)
  }
  async function screenshot(name) {
    const result = await command('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(artifactDirectory, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  async function dismissToasts() {
    await evaluate(
      `document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(button => button.click())`,
    )
    await wait(250)
  }
  async function checkOverflow(label) {
    const dimensions = await evaluate(
      `({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth, offenders: [...document.querySelectorAll('main *')].filter(el => { const r=el.getBoundingClientRect(); return r.width>0 && r.right>window.innerWidth+1 && !el.closest('[data-slot=table-container]') && !el.closest('[role=tablist]'); }).slice(0,5).map(el => ({tag:el.tagName,class:el.className,text:el.textContent.slice(0,60)})) })`,
    )
    assert.ok(
      dimensions.scroll <= dimensions.viewport + 1,
      `${label}存在页面级横向溢出：${JSON.stringify(dimensions)}`,
    )
  }
  await command('Runtime.enable')
  await command('Log.enable')
  await command('Page.enable')
  await command('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory })
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await command('Page.navigate', { url: base })
  await visible('[aria-label="切换项目"]')
  await until(() => evaluate('document.querySelector("h1")?.textContent === "SOL 标准版"'), '概览')
  await checkOverflow('桌面概览')
  await screenshot('01-overview-desktop')
  checks.push('项目概览与导航')

  const documentName = '浏览器验收资料.md'
  await clickText('资料与配置')
  await clickText('研发资料', '[role=tab]')
  await clickText('新增资料')
  await fill('#document-name', documentName)
  await fill('#document-content', '# 浏览器验收资料\n\n设备离线时先检查心跳和项目分组。')
  await clickText('保存资料')
  await until(
    async () => (await project()).documents.some((item) => item.name === documentName),
    '新增资料',
  )
  await until(() => evaluate('!document.querySelector("[role=dialog]")'), '保存资料后关闭弹窗')
  checks.push('新增研发资料并存入当前项目')

  await clickText('插件配置', '[role=tab]')
  await click('[aria-label="启用日志分析"]')
  await fill('#plugin-retention', '14')
  await clickText('保存草稿')
  await until(async () => (await project()).draft.plugins.logs.enabled, '保存插件草稿')
  assert.equal((await project()).config.plugins.logs.enabled, false, '草稿不应提前影响生效配置')
  assert.equal(Number((await project()).draft.plugins.logs.retention), 14)
  await clickText('应用配置')
  await until(async () => (await project()).config.plugins.logs.enabled, '应用插件配置')
  assert.equal(Number((await project()).config.plugins.logs.retention), 14)
  assert.equal((await project()).configVersion, 13)
  await screenshot('02-plugin-config-desktop')
  checks.push('插件启用、保存草稿、应用配置及版本隔离')

  await clickText('源码与产物', '[role=tab]')
  const beforeCount = (await project()).artifacts.length
  await clickText('生成产物')
  await click('#artifact-action')
  await clickText('生成 ZIP 压缩包', '[role=option]')
  const archiveName = `browser-check-${Date.now()}.zip`
  await fill('#artifact-name', archiveName)
  await clickText('开始生成')
  await until(
    async () => (await project()).artifacts.some((item) => item.name === archiveName),
    '生成 ZIP 产物',
  )
  assert.equal((await project()).artifacts.length, beforeCount + 1)
  const generated = (await project()).artifacts.find((item) => item.name === archiveName)
  assert.equal(generated.sourceId, 'sanitized-v12')
  await until(() => evaluate('!document.querySelector("[role=dialog]")'), '产物完成后关闭弹窗')
  await clickText('下载产物')
  const downloaded = await until(async () => {
    const names = await readdir(downloadDirectory)
    return names.includes(archiveName) ? path.join(downloadDirectory, archiveName) : null
  }, 'ZIP 下载')
  const archiveFiles = verifyZip(await readFile(downloaded))
  assert.ok(archiveFiles[0].content.includes('SOL 标准版'))
  await clickText('查看内容')
  await visible('[role=dialog] pre')
  assert.ok(
    await evaluate(
      'document.querySelector("[role=dialog] pre").textContent.includes("SOL 标准版")',
    ),
  )
  await key('Escape', 27)
  await until(() => evaluate('!document.querySelector("[role=dialog]")'), 'Escape 关闭预览')
  await screenshot('03-artifacts-desktop')
  checks.push('生成独立产物、来源引用、文件预览及实际 ZIP 下载校验')

  await clickText('带入问答')
  await visible('[aria-label="向 Agent 提问"]')
  await dismissToasts()
  await fill('[aria-label="向 Agent 提问"]', '检查设备状态并生成分析报告')
  await clickText('发送')
  await until(
    async () => (await project()).conversations[0]?.activeTurn?.state === 'waiting',
    'Agent 澄清问题',
  )
  await visible('[aria-label="设备检查范围"]')
  await command('Page.reload')
  await visible('[aria-label="设备检查范围"]')
  assert.equal((await project()).conversations[0].activeTurn.state, 'waiting')
  await clickText('确认并继续')
  await until(
    async () => (await project()).conversations[0]?.activeTurn?.state === 'complete',
    'Agent 完成回答',
  )
  const reportId = await until(async () => {
    const conversation = (await project()).conversations[0]
    return conversation.messages.find((item) => item.role === 'assistant' && item.artifactId)
      ?.artifactId
  }, 'Agent 报告登记')
  assert.ok((await project()).artifacts.some((item) => item.id === reportId))
  await visible('[aria-label="向 Agent 提问"]')
  await screenshot('04-agent-desktop')
  await clickText('查看报告')
  await visible('[role=dialog]')
  await clickText('在产物中查看', '[role=dialog] button')
  await until(() => evaluate(`location.hash.includes(${JSON.stringify(reportId)})`), '报告返回产物')
  await until(
    () => evaluate('document.querySelector("h1")?.textContent === "源码与产物"'),
    '产物页面',
  )
  checks.push('产物带入问答、澄清刷新恢复、完成回答和报告回到产物')

  const conversationId = (await project()).conversations[0].id
  await route(`#/chat/session/${conversationId}`)
  await visible('[aria-label="向 Agent 提问"]')
  await dismissToasts()
  await fill('[aria-label="向 Agent 提问"]', '总结当前项目的架构与资料')
  await clickText('发送')
  await until(
    async () => (await project()).conversations[0]?.activeTurn?.state === 'running',
    '新一轮执行',
  )
  await clickText('停止')
  await until(
    async () => (await project()).conversations[0]?.activeTurn?.state === 'cancelled',
    '停止任务',
  )
  await clickText('继续本轮')
  await until(
    async () => (await project()).conversations[0]?.activeTurn?.state === 'running',
    '恢复任务',
  )
  const queuedQuestion = '解释源码脱敏和产物处理流程'
  await fill('[aria-label="向 Agent 提问"]', queuedQuestion)
  await clickText('加入下一轮')
  await until(
    async () =>
      (await project()).conversations[0].queue.some((item) => item.text === queuedQuestion),
    '补充问题进入队列',
  )
  await until(
    async () => {
      const entry = (await project()).conversations[0]
      return (
        entry.activeTurn.question === queuedQuestion &&
        entry.activeTurn.state === 'complete' &&
        entry.queue.length === 0
      )
    },
    '排队问题依次完成',
    400,
  )
  assert.equal(
    (await project()).conversations[0].messages.filter(
      (item) => item.role === 'user' && item.content === queuedQuestion,
    ).length,
    1,
    '排队消息只能消费一次',
  )
  checks.push('Agent 停止、继续、运行中补充及队列单次消费')

  await route('#/connections')
  await clickCardButton('测试业务库', '断开连接')
  await until(
    async () => (await project()).connectionStates?.['mysql-test'] === false,
    '数据库断开',
  )
  await clickText('项目概览')
  await clickText('MCP 与连接')
  assert.equal((await project()).connectionStates['mysql-test'], false, '连接状态应跨页面保留')
  await route(`#/chat/session/${conversationId}`)
  await fill('[aria-label="向 Agent 提问"]', '检查设备状态')
  await clickText('发送')
  await until(async () => {
    const entry = (await project()).conversations[0]
    return entry.activeTurn.question === '检查设备状态' && entry.activeTurn.state === 'complete'
  }, 'MCP 断开后设备查询阻断')
  assert.ok((await project()).conversations[0].messages.at(-1).content.includes('尚未连接'))
  await route('#/connections')
  await clickCardButton('测试业务库', '测试并连接')
  await until(async () => (await project()).connectionStates?.['mysql-test'] === true, '数据库恢复')

  await route('#/materials/plugins/cabinet')
  await click('[aria-label="停用设备路由"]')
  await clickText('应用配置')
  await until(
    async () => (await project()).config.plugins.cabinet.enabled === false,
    '停用设备插件',
  )
  await route(`#/chat/session/${conversationId}`)
  await fill('[aria-label="向 Agent 提问"]', '检查设备插件状态')
  await clickText('发送')
  await until(async () => {
    const entry = (await project()).conversations[0]
    return entry.activeTurn.question === '检查设备插件状态' && entry.activeTurn.state === 'complete'
  }, '停用插件后查询阻断')
  assert.ok((await project()).conversations[0].messages.at(-1).content.includes('插件未启用'))
  await route('#/materials/plugins/cabinet')
  await click('[aria-label="启用设备路由"]')
  await clickText('应用配置')
  await until(async () => (await project()).config.plugins.cabinet.enabled === true, '恢复设备插件')
  checks.push('MCP 断开状态跨页持久化，以及依赖断开、插件停用后的 Agent 查询阻断')

  await route(`#/chat/session/${conversationId}`)
  await click('[aria-label="选择 Agent"]')
  await clickText('代码顾问 · Codex', '[role=option]')
  await until(async () => (await project()).conversations[0].agentId === 'codex', '切换会话 Agent')
  await route('#/hosts')
  await clickCardButton('陶涛的主机', '模拟断开')
  await until(
    async () => !(await project()).agents.find((item) => item.id === 'codex').online,
    '主机离线',
  )
  await route(`#/chat/session/${conversationId}`)
  await fill('[aria-label="向 Agent 提问"]', '离线后不应执行')
  assert.equal(
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '发送').disabled`,
    ),
    true,
  )
  const beforeOffline = (await project()).conversations[0].messages.length
  await click('[aria-label="向 Agent 提问"]')
  await key('Enter', 13)
  assert.equal(
    (await project()).conversations[0].messages.length,
    beforeOffline,
    '离线 Agent 不应通过键盘发起任务',
  )
  await click('[aria-label="选择 Agent"]')
  await clickText('项目助手 · 内置 Agent', '[role=option]')
  await route('#/hosts')
  await clickCardButton('陶涛的主机', '模拟连接')
  await until(
    async () => (await project()).agents.find((item) => item.id === 'codex').online,
    '恢复主机',
  )
  checks.push('会话 Agent 离线后同时阻断按钮与键盘发送')

  await route('#/services/release/api-service')
  await visible('[aria-label="发布源码快照"]')
  await clickText('确认模拟发布')
  await until(async () => (await project()).releases.length > 0, '模拟发布完成')
  assert.equal((await project()).releases[0].sourceId, 'source-v12')
  assert.equal((await project()).releases[0].commit, '38e20cf')
  assert.equal(
    (await project()).services.find((item) => item.id === 'api-service').commit,
    '38e20cf',
  )
  await clickText('完成', '[role=dialog] button')
  checks.push('模拟发布固定源码快照并追溯原始提交')

  await route('#/overview')
  await command('Page.reload')
  await visible('[aria-label="切换项目"]')
  assert.ok((await project()).documents.some((item) => item.name === documentName))
  assert.equal((await project()).config.plugins.logs.enabled, true)
  assert.ok((await project()).artifacts.some((item) => item.id === reportId))
  await click('[aria-label="切换项目"]')
  await clickText('星河开放平台', '[role=option]')
  await until(async () => (await storage()).projectId === 'demo', '切换第二个项目')
  const other = (await storage()).projects.demo
  assert.ok(!other.documents.some((item) => item.name === documentName))
  assert.equal(other.config.plugins.logs.enabled, false)
  assert.equal(other.artifacts.length, 4)
  assert.equal(other.conversations.length, 0)
  await click('[aria-label="切换项目"]')
  await clickText('SOL 标准版', '[role=option]')
  await until(async () => (await storage()).projectId === 'sol', '返回原项目')
  assert.ok((await project()).artifacts.some((item) => item.id === reportId))
  checks.push('刷新持久化与资料、插件、产物、对话的项目隔离')

  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await route('#/overview')
  await click('[data-sidebar="trigger"]')
  await visible('[data-mobile="true"]')
  await clickText('资料与配置', '[data-mobile="true"] button')
  await until(
    () => evaluate('!document.querySelector("[data-mobile=true]")'),
    '手机点击导航后关闭抽屉',
  )
  assert.ok(await evaluate('location.hash.startsWith("#/materials")'))
  for (const [label, hash] of [
    ['05-overview-mobile', '#/overview'],
    ['06-materials-mobile', '#/materials/documents'],
    ['07-plugins-mobile', '#/materials/plugins'],
    ['08-artifacts-mobile', '#/materials/artifacts'],
    ['09-agent-mobile', `#/chat/session/${conversationId}`],
  ]) {
    await route(hash)
    await checkOverflow(label)
    await screenshot(label)
  }
  checks.push('Escape 关闭预览、手机导航关闭抽屉、390px 五个主要页面无页面级横向溢出')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await route('#/overview')
  for (const [name, value, filename] of [
    ['prefers-reduced-transparency', 'reduce', '10-reduced-transparency'],
    ['forced-colors', 'active', '11-high-contrast'],
  ]) {
    await command('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name, value }],
    })
    await visible('[aria-label="切换项目"]')
    await checkOverflow(filename)
    await screenshot(filename)
  }
  await command('Emulation.setEmulatedMedia', { features: [] })
  checks.push('减少透明效果与系统高对比度下的布局及可见导航')
  assert.deepEqual(errors, [], `浏览器运行异常：${errors.join('\n')}`)
  assert.ok(
    !warnings.some((entry) => /Content Security Policy|Refused to|404/.test(entry)),
    warnings.join('\n'),
  )
  await writeFile(
    path.join(artifactDirectory, 'results.json'),
    JSON.stringify({ base, passedAt: new Date().toISOString(), checks, errors, warnings }, null, 2),
  )
  await Promise.all(
    ['failure.png', 'failure.txt'].map((name) =>
      rm(path.join(artifactDirectory, name), { force: true }),
    ),
  )
  console.log(`前端原型浏览器验收通过：\n${checks.map((item) => `- ${item}`).join('\n')}`)
  console.log(`截图与下载验收产物：${artifactDirectory}`)
} catch (error) {
  if (command) {
    try {
      const screenshot = await command('Page.captureScreenshot', { format: 'png' })
      await writeFile(
        path.join(artifactDirectory, 'failure.png'),
        Buffer.from(screenshot.data, 'base64'),
      )
      const body = await evaluate('document.body.innerText')
      await writeFile(
        path.join(artifactDirectory, 'failure.txt'),
        `${error.stack}\n\n${body}\n\n${errors.join('\n')}`,
      )
    } catch {}
  }
  throw error
} finally {
  socket?.close()
  browser.kill()
  await wait(1000)
  // 仅清理本次创建且位于系统临时目录内的浏览器配置目录。
  if (
    path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir()) &&
    path.basename(temporary).startsWith('cmr-prototype-browser-')
  ) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }
}
