import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
export const storageKey = 'autoops:interactive-prototype:v2'
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export async function until(action, label, attempts = 240) {
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await action()
      if (result) return result
    } catch (e) {
      last = e
    }
    await wait(50)
  }
  throw new Error(`等待失败：${label}${last ? `；${last.message}` : ''}`)
}
export async function startBrowser(name = 'v2') {
  const base = process.env.PROTOTYPE_URL || 'http://127.0.0.1:5173/prototype.html'
  const output = path.resolve('.test-artifacts/prototype-v2', name)
  const downloadDirectory = path.join(output, 'downloads')
  await mkdir(downloadDirectory, { recursive: true })
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'workbench-v2-'))
  const browserDirectory = path.join(temporary, 'browser')
  const candidates = [
    process.env.BROWSER_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  let executable
  for (const candidate of candidates) {
    try {
      await access(candidate)
      executable = candidate
      break
    } catch {}
  }
  if (!executable) throw new Error('需要 Chrome 或 Edge，或设置 BROWSER_PATH')
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
    { stdio: 'ignore' },
  )
  let socket
  const errors = [],
    warnings = [],
    checks = []
  let command, evaluate
  async function close() {
    socket?.close()
    browser.kill('SIGTERM')
    await wait(300)
    await rm(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  }
  try {
    await until(async () => (await fetch(base)).ok, '原型服务')
    const port = await until(
      async () =>
        Number(
          (await readFile(path.join(browserDirectory, 'DevToolsActivePort'), 'utf8')).split(
            '\n',
          )[0],
        ),
      'Chrome启动',
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
      if (data.method === 'Runtime.exceptionThrown')
        errors.push(
          data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text,
        )
      if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error')
        warnings.push(data.params.entry.text)
    })
    command = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`浏览器命令超时 ${method}`))
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
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description || result.exceptionDetails.text,
        )
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
    async function mouse(expression, label) {
      await until(
        () =>
          evaluate(`Boolean((${expression})?.getClientRects().length)&&!(${expression}).disabled`),
        label,
      )
      await evaluate(
        `Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`,
      )
      await evaluate(
        `new Promise(resolve=>{(${expression}).scrollIntoView({block:'center',inline:'nearest'});requestAnimationFrame(()=>requestAnimationFrame(resolve))})`,
      )
      await wait(90)
      const point = await evaluate(
        `(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      )
      for (const type of ['mousePressed', 'mouseReleased'])
        await command('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    }
    const click = (selector) =>
      mouse(`document.querySelector(${JSON.stringify(selector)})`, selector)
    const clickText = (text, selector = 'button') =>
      mouse(
        `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.textContent.trim()===${JSON.stringify(text)}&&el.getClientRects().length&&!el.disabled)`,
        text,
      )
    async function fill(selector, value) {
      await visible(selector)
      await evaluate(
        `(()=>{const input=document.querySelector(${JSON.stringify(selector)});const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      )
    }
    async function key(key, code) {
      for (const type of ['keyDown', 'keyUp'])
        await command('Input.dispatchKeyEvent', {
          type,
          key,
          code: key,
          windowsVirtualKeyCode: code,
        })
    }
    const storage = () =>
      evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`)
    const route = async (value) => {
      await evaluate(`location.hash=${JSON.stringify(value)}`)
      await wait(160)
    }
    const screenshot = async (name) => {
      const r = await command('Page.captureScreenshot', { format: 'png' })
      await writeFile(path.join(output, `${name}.png`), Buffer.from(r.data, 'base64'))
    }
    const check = (message) => {
      checks.push(message)
      console.log(`✓ ${message}`)
    }
    async function assertNoOverflow(label) {
      const size = await evaluate(
        '({scroll:document.documentElement.scrollWidth,width:innerWidth})',
      )
      assert.ok(size.scroll <= size.width + 1, `${label} 溢出 ${JSON.stringify(size)}`)
    }
    async function viewport(width = 1440, height = 1000) {
      await command('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 760,
      })
      await wait(100)
    }
    async function reset(user = 'admin') {
      await command('Page.navigate', { url: base })
      await visible('body')
      await evaluate(`localStorage.removeItem(${JSON.stringify(storageKey)});location.hash='/'`)
      await command('Page.reload')
      await visible('[aria-label="用户名"]')
      await fill('[aria-label="用户名"]', user)
      await fill('[aria-label="密码"]', 'Demo123!')
      await clickText('登录')
      await until(async () => (await storage())?.userId === user, '登录完成')
      await visible('h1')
    }
    async function logout() {
      await click('[aria-label="账号菜单"]')
      await clickText('退出登录', '[role=menuitem]')
      await visible('[aria-label="用户名"]')
    }
    async function login(user) {
      await fill('[aria-label="用户名"]', user)
      await fill('[aria-label="密码"]', 'Demo123!')
      await clickText('登录')
      await until(async () => (await storage())?.userId === user, '切换用户')
    }
    await command('Runtime.enable')
    await command('Log.enable')
    await command('Page.enable')
    await command('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDirectory,
    })
    await viewport()
    await command('Page.navigate', { url: base })
    await visible('body')
    return {
      base,
      output,
      downloadDirectory,
      command,
      evaluate,
      visible,
      mouse,
      click,
      clickText,
      fill,
      select: fill,
      key,
      storage,
      route,
      screenshot,
      check,
      assertNoOverflow,
      viewport,
      reset,
      logout,
      login,
      until,
      wait,
      errors,
      warnings,
      checks,
      close,
    }
  } catch (e) {
    await close()
    throw e
  }
}
