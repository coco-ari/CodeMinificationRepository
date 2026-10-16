import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createApplication } from '../src/server.mjs'

const temporary = await mkdtemp(path.join(os.tmpdir(), 'cmr-browser-'))
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

const dataDirectory = path.join(temporary, 'data')
const builder = {
  async branches() {
    return {
      branches: [{ name: 'release/vietnam', revision: 'a'.repeat(40) }],
      defaultBranch: 'release/vietnam',
      refreshedAt: new Date().toISOString(),
    }
  },
  async initialize() {
    await mkdir(dataDirectory, { recursive: true })
    await writeFile(path.join(dataDirectory, 'test.zip'), 'test')
  },
  async build() {
    await new Promise((resolve) => setTimeout(resolve, 100))
    return {
      file: path.join(dataDirectory, 'test.zip'),
      revision: 'abcdef12'.repeat(5),
      sha256: '1'.repeat(64),
      size: 4,
      cached: false,
    }
  },
}
const { server, service } = await createApplication({
  directory: dataDirectory,
  builder,
  secureCookies: false,
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const browserDirectory = path.join(temporary, 'browser')
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
const errors = []
const warnings = []
async function until(action, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const result = await action()
      if (result) return result
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待失败：${label}`)
}
try {
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
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text)
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error')
      warnings.push(data.params.entry.text)
  })
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`浏览器命令超时：${method}`))
      }, 10000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  }
  const animationsSettled = () =>
    evaluate(
      `Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`,
    )
  const mouseClick = async (selector) => {
    await animationsSettled()
    await evaluate(
      `new Promise(resolve => { document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'}); requestAnimationFrame(() => requestAnimationFrame(resolve)); })`,
    )
    const point = await evaluate(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
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
  const key = async (key, code) => {
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: key,
      windowsVirtualKeyCode: code,
    })
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: key,
      windowsVirtualKeyCode: code,
    })
  }
  const fill = (selector, value) =>
    evaluate(
      `(()=>{const input=document.querySelector(${JSON.stringify(selector)}); const prototype = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    )
  const click = async (selector) => {
    if (
      selector.startsWith('[data-view=') &&
      !(await evaluate(
        `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`,
      ))
    ) {
      await evaluate(`document.querySelector('[data-sidebar="trigger"]').click()`)
      await visible(selector)
    }
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  const visible = (selector) =>
    until(
      () =>
        evaluate(
          `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`,
        ),
      selector,
    )
  await command('Runtime.enable')
  await command('Log.enable')
  await command('Page.enable')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await command('Page.navigate', { url: base })
  await visible('#bootstrap-field')
  await fill('#auth-form [name=bootstrapToken]', service.bootstrapToken)
  await fill('#auth-form [name=username]', 'admin')
  await fill('#auth-form [name=password]', 'browser-test-password')
  await click('#auth-form [type=submit]')
  await visible('#app-view')
  await click('[data-view=credentials]')
  await visible('#credential-list')
  await click('#create-button')
  await visible('#credential-dialog')
  await fill('#credential-form [name=name]', 'Gitee 交付专用账号')
  await fill('#credential-form [name=username]', 'delivery-reader')
  await fill('#credential-form [name=password]', 'test-only-password')
  await click('#credential-form [type=submit]')
  await until(() => evaluate('!document.querySelector("#credential-dialog")'), '保存凭证')
  await click('[data-view=home]')
  await visible('#workspace-home')
  await click('#create-button')
  await visible('.deploy-dialog[data-state=open]')
  await fill('.deploy-dialog[data-state=open] [name=name]', 'SOL 交付项目')
  await click('.deploy-dialog[data-state=open] [type=submit]')
  await until(
    () => evaluate('document.querySelector("#workspace-name").textContent === "SOL 交付项目"'),
    '创建项目并进入空间',
  )
  await click('[data-view=projects]')
  await visible('#project-list')
  await click('#create-button')
  await visible('#project-dialog')
  await fill('#project-form [name=name]', '越南 SOL 标准版')
  await fill('#project-form [name=repository]', 'https://gitee.com/example/sol-standard.git')
  assert.equal(
    await evaluate('Boolean(document.querySelector("#project-form [name=branch]"))'),
    false,
  )
  await mouseClick('#repository-add-credential')
  await visible('#credential-dialog')
  await fill('#credential-form [name=name]', '项目内新建凭证')
  await fill('#credential-form [name=username]', 'project-reader')
  await fill('#credential-form [name=password]', 'inline-test-only-password')
  await click('#credential-form [type=submit]')
  await until(() => evaluate('!document.querySelector("#credential-dialog")'), '项目内创建凭证')
  assert.equal(
    await evaluate('document.querySelector("#project-form [name=name]").value'),
    '越南 SOL 标准版',
  )
  assert.equal(
    await evaluate('document.querySelector("#project-credential").textContent'),
    '项目内新建凭证',
  )
  await click('#project-form [type=submit]')
  await visible('#secret-dialog')
  const secret = await evaluate('document.querySelector("#secret-value").value')
  assert.equal(secret.length, 43)
  const publicUrl = await evaluate('document.querySelector("#secret-page").value')
  await click('#secret-dialog [data-close]')
  await until(() => evaluate('!document.querySelector("#secret-value")'), '关闭弹窗后清除密码')
  await click('[aria-label="刷新仓库信息"]')
  await until(
    () => evaluate('document.querySelector(".project-card .badge").textContent === "已连接"'),
    '手动同步',
  )
  assert.equal(service.store.state.projects.length, 1)
  assert.equal(service.store.state.projects[0].branch, 'release/vietnam')
  assert.ok(!(await evaluate('document.body.textContent.includes("test-only-password")')))
  // 仓库配置使用完整页面；嵌入的共享凭证仍使用 Radix 对话框。
  await mouseClick('[data-repository-menu]')
  await visible('[role=menu]')
  await evaluate(
    'Array.from(document.querySelectorAll("[role=menuitem]")).find(b=>b.textContent.includes("编辑仓库")).click()',
  )
  await visible('#project-dialog')
  assert.equal(
    await evaluate('Boolean(document.querySelector("#project-dialog[role=dialog]"))'),
    false,
  )
  await mouseClick('#repository-add-credential')
  await visible('#credential-dialog')
  for (let i = 0; i < 12; i++) {
    await key('Tab', 9)
    assert.equal(
      await evaluate(
        'document.querySelector("#credential-dialog").contains(document.activeElement)',
      ),
      true,
    )
  }
  await key('Escape', 27)
  await until(
    () => evaluate('!document.querySelector("#credential-dialog")'),
    'Escape 关闭凭证对话框',
  )
  await until(
    () =>
      evaluate('document.activeElement === document.querySelector("#repository-add-credential")'),
    '焦点返回新增凭证按钮',
  )
  await click('#project-dialog [data-slot=dialog-close]')
  await until(() => evaluate('!document.querySelector("#project-dialog")'), '返回仓库列表')
  await mouseClick('[data-repository-menu]')
  await visible('[role=menu]')
  await evaluate(
    'Array.from(document.querySelectorAll("[role=menuitem]")).find(b=>b.textContent === "重置下载密码").click()',
  )
  await visible('[role=alertdialog]')
  await evaluate(
    'Array.from(document.querySelector("[role=alertdialog]").querySelectorAll("button")).find(b=>b.textContent === "取消").click()',
  )
  await until(() => evaluate('!document.querySelector("[role=alertdialog]")'), '取消重置密码')
  await until(
    () => evaluate('getComputedStyle(document.body).pointerEvents !== "none"'),
    '关闭确认后恢复页面交互',
  )
  service.authorizeDownload(service.store.state.projects[0].id, secret)
  await mouseClick('#project-list table [role=switch]')
  await until(() => !service.store.state.projects[0].enabled, '停用源码下载')
  await until(
    () => evaluate('!document.querySelector("#project-list table [role=switch]").disabled'),
    '停用完成',
  )
  await mouseClick('#project-list table [role=switch]')
  await until(() => service.store.state.projects[0].enabled, '恢复源码下载')
  service.authorizeDownload(service.store.state.projects[0].id, secret)
  await mouseClick('[data-slot=dropdown-menu-trigger]')
  await visible('[role=menu]')
  await evaluate(
    'Array.from(document.querySelectorAll("[role=menuitem]")).find(b=>b.textContent.includes("修改密码")).click()',
  )
  await visible('[name=currentPassword]')
  await key('Escape', 27)
  await until(
    () => evaluate('!document.querySelector("[name=currentPassword]")'),
    '关闭账号密码弹窗',
  )

  const artifactDirectory = path.resolve('.test-artifacts')
  await mkdir(artifactDirectory, { recursive: true })
  await animationsSettled()
  let screenshot = await command('Page.captureScreenshot', { format: 'png' })
  await writeFile(
    path.join(artifactDirectory, 'dashboard-desktop.png'),
    Buffer.from(screenshot.data, 'base64'),
  )
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  })
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true)
  await animationsSettled()
  screenshot = await command('Page.captureScreenshot', { format: 'png' })
  await writeFile(
    path.join(artifactDirectory, 'dashboard-mobile.png'),
    Buffer.from(screenshot.data, 'base64'),
  )
  await mouseClick('#project-list .md\\:hidden [data-repository-menu]')
  await visible('[role=menu]')
  await evaluate(
    'Array.from(document.querySelectorAll("[role=menuitem]")).find(b=>b.textContent === "编辑仓库").click()',
  )
  await visible('#project-dialog')
  assert.equal(
    await evaluate('Boolean(document.querySelector("#project-form [name=branch]"))'),
    false,
  )
  await command('Page.navigate', { url: publicUrl })
  await visible('#download-view')
  assert.equal(await evaluate('!document.querySelector("#app-view")'), true)
  await fill('#download-form [name=token]', 'invalid')
  await click('#download-form [type=submit]')
  await until(
    () => evaluate('document.querySelector("#download-error").textContent.includes("密码无效")'),
    '无效下载密码',
  )
  assert.deepEqual(errors, [])
  assert.ok(
    !warnings.some((item) => /Content Security Policy|Refused to/.test(item)),
    warnings.join('\n'),
  )
  console.log(
    '浏览器验证通过：初始化、凭证配置、新增项目、密码显示与清理、手动同步、桌面与手机布局、下载页鉴权。',
  )
  console.log(`截图目录：${artifactDirectory}`)
} finally {
  socket?.close()
  browser.kill()
  await new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  if (
    path.dirname(temporary) === path.resolve(os.tmpdir()) &&
    path.basename(temporary).startsWith('cmr-browser-')
  ) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }
}
