import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createApplication } from '../src/server.mjs'

// 使用真实管理接口和模拟 Agent 回报验证界面，不连接任何远程服务器或 Docker。
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cmr-deploy-browser-'))
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
let version = 1
const longBranch = `feature/${'continuous-branch-name-'.repeat(8)}`
const builder = {
  async branches() {
    return {
      branches: ['main', 'test-branch', 'frontend-test', longBranch].map((name) => ({
        name,
        revision: String(version).repeat(40),
      })),
      defaultBranch: 'main',
      refreshedAt: new Date().toISOString(),
    }
  },
  async initialize() {
    await mkdir(dataDirectory, { recursive: true })
    await writeFile(path.join(dataDirectory, 'test.zip'), 'isolated-source')
  },
  async history(source, credential, refresh) {
    if (refresh)
      this.cachedHistory = {
        commits: [
          {
            revision: String(version).repeat(40),
            author: '测试作者',
            subject: `第 ${version} 次提交`,
            at: new Date().toISOString(),
          },
          ...Array.from({ length: 99 }, (_, index) => ({
            revision: createHash('sha1').update(`历史提交-${index}`).digest('hex'),
            author: index === 60 ? 'Alice Example' : '历史作者',
            subject: `历史修复 ${index} [api]`,
            at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
          })),
        ],
        refreshedAt: new Date().toISOString(),
      }
    return this.cachedHistory || { commits: [], refreshedAt: null }
  },
  async build(source, credential, onPhase) {
    for (const phase of ['source_fetch', 'source_resolve', 'source_archive']) await onPhase?.(phase)
    return {
      file: path.join(dataDirectory, 'test.zip'),
      revision: String(version).repeat(40),
      commitSubject:
        version === 1
          ? '修复设备连接超时并优化消息重试，保留失败原因和处理记录，方便排查跨环境部署后的连接问题与异常恢复情况'
          : '修复登录超时',
      sha256: createHash('sha256').update('isolated-source').digest('hex'),
      size: 15,
      cached: false,
    }
  },
}
const { server, service, deployment, workspaces } = await createApplication({
  directory: dataDirectory,
  builder,
  secureCookies: false,
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
deployment.publicOrigin = base
const initialProject = await workspaces.create({ name: 'SOL 标准版' })
await service.saveProject({
  applicationId: initialProject.id,
  name: '独立演示源码',
  repository: 'https://gitee.com/example/demo.git',
  branch: 'main',
  enabled: true,
})
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
const errors = [],
  warnings = []
let diagnostics
async function until(action, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const result = await action()
      if (result) return result
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待失败：${label}；${await diagnostics?.()}`)
}
async function agentRequest(endpoint, body, token) {
  const response = await fetch(`${base}/api/agent/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const value = await response.json()
  assert.ok(response.ok, JSON.stringify(value))
  return value
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
    const value = JSON.parse(event.data)
    if (value.id && pending.has(value.id)) {
      const { resolve, reject, timer } = pending.get(value.id)
      clearTimeout(timer)
      pending.delete(value.id)
      if (value.error) reject(new Error(value.error.message))
      else resolve(value.result)
    }
    if (value.method === 'Runtime.exceptionThrown')
      errors.push(
        value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text,
      )
    if (value.method === 'Log.entryAdded' && value.params.entry.level === 'error')
      warnings.push(value.params.entry.text)
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
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result?.value
  }
  diagnostics = () => evaluate('document.body.innerText.slice(-2200)')
  const animationsSettled = () =>
    evaluate(
      `Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`,
    )
  const query = (selector) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length)`
  const visible = (selector) => until(() => evaluate(`Boolean(${query(selector)})`), selector)
  const click = async (selector) => {
    if (selector.startsWith('[data-view='))
      await until(
        () =>
          evaluate(
            `Boolean(document.querySelector('[data-slot=sidebar-gap]')) === (innerWidth >= 768)`,
          ),
        '响应式导航切换完成',
      )
    if (selector.startsWith('[data-view=') && !(await evaluate(`Boolean(${query(selector)})`))) {
      await evaluate(`document.querySelector('[data-sidebar="trigger"]').click()`)
      await visible(selector)
    }
    await visible(selector)
    await animationsSettled()
    if (
      !(await evaluate(
        `(${query(selector)}).matches('[role=combobox],[data-slot=dropdown-menu-trigger],[data-sidebar=trigger],[role=tab]')`,
      ))
    ) {
      await evaluate(`(${query(selector)}).click()`)
      const nav = /^\[data-view=([^\]]+)\]$/.exec(selector)
      if (nav)
        await until(
          () =>
            evaluate(
              `document.querySelector('#deploy-view')?.dataset.page === ${JSON.stringify(nav[1])} || Boolean(document.querySelector('[role=alertdialog]'))`,
            ),
          '导航 ' + nav[1],
        )
      return
    }
    await evaluate(`(${query(selector)}).scrollIntoView({block:'center'})`)
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    const point = await evaluate(
      `(()=>{const e=${query(selector)};if(e.disabled)throw Error('按钮不可用：'+e.textContent);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    await command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point,
    })
    await command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point,
    })
    const navigation = /^\[data-view=([^\]]+)\]$/.exec(selector)
    if (navigation)
      await until(
        () =>
          evaluate(
            `document.querySelector('#deploy-view')?.dataset.page === ${JSON.stringify(navigation[1])} || Boolean(document.querySelector('[role=alertdialog]'))`,
          ),
        '导航 ' + navigation[1],
      )
  }
  const fill = async (selector, value) => {
    await visible(selector)
    await evaluate(
      `(()=>{const e=${query(selector)};const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    )
  }
  const clickText = async (label, parent = '#deploy-view') => {
    await animationsSettled()
    await evaluate(
      `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(parent)})].filter(e=>e.getClientRects().length).flatMap(r=>[...r.querySelectorAll('button,[role=menuitem],[role=option]')]).find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(label)}); e?.scrollIntoView({block:'center',behavior:'instant'});})()`,
    )
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    const point = await evaluate(
      `(()=>{const roots=[...document.querySelectorAll(${JSON.stringify(parent)})].filter(e=>e.getClientRects().length);const e=roots.flatMap(r=>[...r.querySelectorAll('button,[role=menuitem],[role=option]')]).find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('未找到按钮 '+${JSON.stringify(label)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    await command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point,
    })
    await command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point,
    })
  }
  const choose = async (selector, label) => {
    await click(selector)
    await visible('[role=option]')
    await clickText(label, '[role=listbox]')
    await until(
      () =>
        evaluate(
          `(${query(selector)})?.textContent.includes(${JSON.stringify(label)}) || Boolean(document.querySelector('[role=alertdialog]'))`,
        ),
      '选择 ' + label,
    )
  }
  const go = async (view, extra = '') => {
    await evaluate(
      `location.hash=${JSON.stringify(`/projects/${initialProject.id}/${view}`)}+${JSON.stringify(extra)}`,
    )
    const canonical =
      { applications: 'services', deployments: 'services', configuration: 'service' }[view] || view
    await until(
      () =>
        evaluate(
          `document.querySelector('#deploy-view')?.dataset.page === ${JSON.stringify(canonical)} && !document.querySelector('[aria-label="正在加载"]')`,
        ),
      '进入 ' + view,
    )
  }
  const submit = async () => {
    const invalid = await evaluate(
      `[...document.querySelectorAll('.deploy-dialog :invalid')].map(e=>e.name || e.id).join(',')`,
    )
    if (invalid) throw Error('无效字段：' + invalid)
    await click('.deploy-dialog [type=submit]')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const error = await evaluate(`document.querySelector('.form-error')?.textContent`)
    if (error) throw Error(error)
  }
  const close = async () => {
    await click('.deploy-dialog [data-slot=dialog-close]')
    await until(() => evaluate(`!document.querySelector('.deploy-dialog')`), '关闭配置')
  }
  const menu = async (selector, label) => {
    await click(`${selector} [data-slot=dropdown-menu-trigger]`)
    await visible('[role=menu]')
    await clickText(label, '[role=menu]')
  }
  const dismissPopup = async (selector) => {
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })
    await until(() => evaluate(`!(${query(selector)})`), '关闭浮层')
  }
  const artifactDirectory = path.resolve('.test-artifacts')
  await mkdir(artifactDirectory, { recursive: true })
  async function screenshot(name) {
    await animationsSettled()
    const image = await command('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(artifactDirectory, name), Buffer.from(image.data, 'base64'))
  }
  await command('Runtime.enable')
  await command('Log.enable')
  await command('Page.enable')
  // 显式覆盖宿主机偏好，常规回归检查透明材质，降级模式在后面单独验证。
  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }],
  })
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await command('Page.navigate', { url: base })
  await visible('#bootstrap-field')
  await screenshot('glass-login-desktop.png')
  await fill('#auth-form [name=bootstrapToken]', service.bootstrapToken)
  await fill('#auth-form [name=username]', 'admin')
  await fill('#auth-form [name=password]', 'isolated-browser-password')
  await click('#auth-form [type=submit]')
  await visible('#workspace-home')
  await fill('[aria-label="搜索项目"]', '不存在的项目')
  await visible('[data-slot=empty]')
  await click('[aria-label="清空搜索项目"]')
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), '搜索项目')
  await visible('[data-workspace-id]')
  await click(`[data-workspace-id="${initialProject.id}"] [aria-label="进入 SOL 标准版"]`)
  await visible('[data-onboarding]')
  assert.equal(
    await evaluate(
      `Boolean(document.querySelector('[data-view=applications],[data-view=deployments]'))`,
    ),
    false,
  )
  // 概览与管理页复用真实连接状态，不再把默认下载分支当作仓库状态。
  const repositoryId = service.store.state.projects[0].id
  for (const [connectionStatus, enabled, label] of [
    ['idle', true, '待验证'],
    ['ready', true, '已连接'],
    ['empty', true, '已连接'],
    ['failed', true, '连接失败'],
    ['ready', false, '已停用'],
  ]) {
    await service.store.change((state) => {
      Object.assign(state.projects[0], { connectionStatus, enabled, status: 'failed' })
    })
    for (const view of ['projects', 'overview']) {
      await go(view)
      await until(
        () =>
          evaluate(
            `document.querySelector('[data-repository-id="${repositoryId}"] [data-repository-status]')?.textContent === ${JSON.stringify(label)}`,
          ),
        `${view} 仓库${label}`,
      )
    }
    assert.equal(
      await evaluate(
        `document.querySelector('[data-overview="repositories"]').textContent.includes('main')`,
      ),
      false,
    )
  }
  await service.setEnabled(repositoryId, true)
  await service.branches(repositoryId, true)
  await service.store.change((state) => {
    state.projects[0].status = 'idle'
  })
  await go('projects')
  assert.equal(await evaluate(`!!document.querySelector('.repo-edit')`), false)
  await fill('[aria-label="搜索代码仓库…"]', '不存在的仓库')
  await visible('[data-slot=empty]')
  await click('[aria-label="清空搜索代码仓库…"]')
  await visible(`[data-repository-id="${repositoryId}"]`)
  await click(`[data-repository-id="${repositoryId}"] .repo-name`)
  await visible('#deploy-repository')
  await evaluate(`document.querySelector('#repository-add-credential').focus()`)
  await click('#repository-add-credential')
  await visible('#credential-dialog[role=dialog]')
  await animationsSettled()
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
  })
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
  })
  await evaluate(`document.querySelector('#credential-dialog [data-slot=dialog-close]').focus()`)
  assert.ok(
    await evaluate(
      `(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),s=getComputedStyle(e);return e.dataset.ui==='button'&&r.width>=32&&r.height>=32&&parseFloat(s.borderRadius)>0&&s.outlineStyle!=='none'})()`,
    ),
    '弹窗关闭按钮拥有完整点击区域及圆角键盘焦点',
  )
  await screenshot('glass-dialog-close-focus.png')
  await click('#credential-dialog [data-slot=dialog-close]')
  await until(() => evaluate(`!document.querySelector('#credential-dialog')`), '关闭凭证弹窗')
  assert.equal(await evaluate(`document.activeElement.id`), 'repository-add-credential')
  await close()
  await click('[data-view=servers]')
  await click('#create-button')
  await fill('#deploy-name', '测试服务器 A')
  await submit()
  await visible('#deploy-installCommand')
  const token = (await evaluate(`document.querySelector('#deploy-installCommand').value`)).match(
    /'([A-Za-z0-9_-]{43})'$/,
  )[1]
  const firstAgent = await agentRequest('register', {
    registrationToken: token,
    version: '1.3.0-browser',
    capabilities: ['static-site-v1', 'source-archive-recovery-v1'],
  })
  await close()
  await click('#create-button')
  await fill('#deploy-name', '测试服务器 B')
  await submit()
  await visible('#deploy-installCommand')
  const secondToken = (
    await evaluate(`document.querySelector('#deploy-installCommand').value`)
  ).match(/'([A-Za-z0-9_-]{43})'$/)[1]
  const secondAgent = await agentRequest('register', {
    registrationToken: secondToken,
    version: '1.3.0-browser',
    capabilities: ['static-site-v1', 'source-archive-recovery-v1'],
  })
  await close()
  const metrics = {
    cpuPercent: 18,
    memory: { used: 2 * 1024 ** 3, total: 4 * 1024 ** 3 },
    disk: { used: 17 * 1024 ** 3, total: 50 * 1024 ** 3 },
  }
  await agentRequest('heartbeat', { metrics, containers: [] }, firstAgent.token)
  await agentRequest('heartbeat', { metrics, containers: [] }, secondAgent.token)
  await visible(`[data-server-id="${firstAgent.serverId}"]`)
  assert.equal(
    await evaluate(`document.querySelector('#deploy-view').textContent.includes('查看详情')`),
    false,
  )
  assert.equal(await evaluate(`!!document.querySelector('[data-slot="sheet-content"]')`), false)
  await clickText('解除绑定', `[data-server-id="${firstAgent.serverId}"]`)
  await visible('[role=alertdialog]')
  await clickText('取消', '[role=alertdialog]')

  // 空环境可删除，取消操作保留环境；删除当前环境后地址自动切回有效环境。
  await go('environments')
  await click('#create-button')
  await fill('#deploy-name', '待删除环境')
  await submit()
  const disposableEnv = deployment.data.environments.find((e) => e.name === '待删除环境')
  await visible(`[data-environment-id="${disposableEnv.id}"]`)
  await clickText('编辑', `[data-environment-id="${disposableEnv.id}"]`)
  const longEnvironment = 'EnvironmentWithoutSpaces'.repeat(3)
  await fill('#deploy-name', longEnvironment)
  await submit()
  await go('services')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 1050,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await click('[aria-label="当前环境"]')
  await visible('[data-slot=select-content]')
  await animationsSettled()
  assert.ok(
    await evaluate(
      `(()=>{const p=document.querySelector('[data-slot=select-content]'),r=p.getBoundingClientRect(),item=[...p.querySelectorAll('[role=option]')].find(e=>e.textContent.includes(${JSON.stringify(longEnvironment)}));return r.left>=0&&r.right<=innerWidth&&item.scrollWidth<=item.clientWidth+1})()`,
    ),
    '普通选择器的长环境名称在移动端完整换行',
  )
  await screenshot('glass-long-select-390.png')
  await dismissPopup('[data-slot=select-content]')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await go('environments', `?environment=${disposableEnv.id}`)
  await clickText('删除', `[data-environment-id="${disposableEnv.id}"]`)
  await visible('[role=alertdialog]')
  assert.equal(
    await evaluate(`document.querySelector('[data-confirm-action]').dataset.variant`),
    'destructive',
  )
  assert.equal(
    await evaluate(`document.querySelector('[data-confirm-action]').textContent`),
    '删除环境',
  )
  await clickText('取消', '[role=alertdialog]')
  assert.ok(deployment.data.environments.some((e) => e.id === disposableEnv.id))
  await clickText('删除', `[data-environment-id="${disposableEnv.id}"]`)
  await click('[data-confirm-action]')
  await until(
    () => !deployment.data.environments.some((e) => e.id === disposableEnv.id),
    '删除空环境',
  )
  await until(() => evaluate(`!location.hash.includes('${disposableEnv.id}')`), '自动选择有效环境')
  assert.equal(
    await evaluate(`document.querySelector('#deploy-view').textContent.includes('查看服务')`),
    false,
  )

  // 分步保存、离开确认与继续配置均通过网页执行。
  await click('[data-view=services]')
  await click('#create-button')
  assert.deepEqual(
    await evaluate(
      `[...document.querySelectorAll('[data-service-setup] h1, [data-service-setup] h2')].map(e => e.textContent)`,
    ),
    ['新增服务', '服务信息'],
  )
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('[data-service-setup] button')].some(e => ['返回', '取消'].includes(e.textContent.trim()))`,
    ),
    false,
  )
  await visible('#deploy-name')
  await fill('#deploy-name', 'API 服务')
  await fill('#deploy-module', 'brezze-api')
  await click('[data-view=projects]')
  await visible('[role=alertdialog]')
  await clickText('取消', '[role=alertdialog]')
  assert.equal(await evaluate(`document.querySelector('#deploy-name').value`), 'API 服务')
  await submit()
  await visible('#deploy-sourceProjectId')
  const apiService = deployment.data.services.find((s) => s.name === 'API 服务')
  assert.ok(apiService)
  await clickText('稍后继续')
  await visible(`[data-service-id="${apiService.id}"]`)
  await clickText('继续配置', `[data-service-id="${apiService.id}"]`)
  await visible('#deploy-sourceProjectId')
  await clickText('上一步')
  await visible('#deploy-name')
  assert.equal(await evaluate(`document.querySelector('#deploy-name').value`), 'API 服务')
  await submit()
  await visible('#deploy-sourceProjectId')
  assert.equal(await evaluate(`Boolean(document.querySelector('#deploy-branch'))`), false)
  assert.equal(deployment.data.environmentSources.length, 0)
  await submit()
  await visible('#deploy-buildImage')
  assert.equal(deployment.data.services.filter((s) => s.name === 'API 服务').length, 1)
  assert.equal(deployment.data.tasks.length, 0)
  assert.equal(
    await evaluate(`document.querySelector('#deploy-healthStatus').getClientRects().length`),
    0,
  )
  await fill('#deploy-healthPath', '/api/health')
  assert.match(
    await evaluate(`document.querySelector('#health-check-preview').textContent`),
    /127.0.0.1:8080\/api\/health/,
  )
  await evaluate(`document.querySelector('#health-check-preview').scrollIntoView({block:'center'})`)
  await screenshot('ux-health-after-desktop.png')
  await clickText('成功条件与等待时间')
  await fill('#deploy-healthStatus', '204')
  await fill('#deploy-healthBody', 'UP')
  await fill('#deploy-healthTimeout', '240')
  await fill('#deploy-healthInterval', '7')
  assert.match(
    await evaluate(`document.querySelector('#health-check-preview').textContent`),
    /HTTP 204.*UP.*7.*240/s,
  )
  await clickText('成功条件与等待时间')
  await clickText('运行资源与附加参数')
  await fill('#deploy-args', '--endpoint=shared-nacos.test.internal:8848')
  await clickText('添加端口映射')
  await fill('[aria-label="端口映射 1 服务器端口"]', '18101')
  await submit()
  await visible('.configuration-stack')
  const firstTarget = deployment.data.targets.find((t) => t.serviceId === apiService.id)
  assert.equal(firstTarget.config.ports[0].hostPort, 18101)
  assert.equal(firstTarget.config.runtime.memoryMb, 512)
  assert.deepEqual(firstTarget.config.volumes, [{ name: 'logs', mountPath: '/app/logs' }])
  assert.equal(deployment.data.tasks.length, 0)
  await go('setup', `?environment=${firstTarget.environmentId}&service=${apiService.id}&step=3`)
  await visible('#deploy-buildImage')
  assert.match(
    await evaluate(`document.querySelector('#deploy-serverId').textContent`),
    /测试服务器 B/,
  )
  const templateLabel = `${deployment.data.environments.find((e) => e.id === firstTarget.environmentId).name} / ${deployment.data.servers.find((s) => s.id === firstTarget.serverId).name}`
  await choose('#deploy-configTemplate', templateLabel)
  await fill('#deploy-buildImage', 'maven:custom-before-copy')
  await clickText('应用配置')
  await visible('[role=alertdialog]')
  assert.equal(
    await evaluate(`document.querySelector('[data-confirm-action]').dataset.variant`),
    'default',
  )
  await clickText('取消', '[role=alertdialog]')
  assert.equal(
    await evaluate(`document.querySelector('#deploy-buildImage').value`),
    'maven:custom-before-copy',
  )
  await clickText('应用配置')
  await visible('[role=alertdialog]')
  await click('[data-confirm-action]')
  await until(
    () =>
      evaluate(
        `document.querySelector('#deploy-buildImage').value === ${JSON.stringify(firstTarget.config.buildImage)}`,
      ),
    '复用构建配置',
  )
  assert.equal(await evaluate(`document.querySelector('#deploy-healthStatus').value`), '204')
  assert.equal(await evaluate(`document.querySelector('#deploy-healthTimeout').value`), '240')
  assert.equal(
    await evaluate(`document.querySelector('[aria-label="端口映射 1 服务器端口"]').value`),
    '',
  )
  assert.equal(await evaluate(`document.querySelector('#deploy-healthPath').value`), '/api/health')
  assert.match(
    await evaluate(`document.querySelector('#deploy-serverId').textContent`),
    /测试服务器 B/,
  )
  assert.equal(deployment.data.tasks.length, 0)
  await screenshot('ux-reuse-after-desktop.png')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 950,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await animationsSettled()
  await evaluate(
    `document.querySelector('#deploy-configTemplate').scrollIntoView({block:'center'})`,
  )
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
  await screenshot('ux-reuse-after-mobile.png')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  })
  assert.equal(
    await evaluate(
      `document.querySelector('[aria-label="端口映射 1 服务器端口"]').checkValidity()`,
    ),
    false,
  )
  assert.equal(
    deployment.data.targets.filter((t) => t.serviceId === apiService.id).length,
    1,
    '未填写服务器端口不能保存',
  )
  await fill('[aria-label="端口映射 1 服务器端口"]', '18102')
  await submit()
  await visible('.configuration-stack')
  const secondTarget = deployment.data.targets.find(
    (t) => t.serviceId === apiService.id && t.id !== firstTarget.id,
  )
  assert.ok(secondTarget)
  assert.deepEqual(secondTarget.config, {
    ...firstTarget.config,
    ports: [{ ...firstTarget.config.ports[0], hostPort: 18102 }],
  })
  const containers = [
    {
      targetId: firstTarget.id,
      containerName: firstTarget.containerName,
      status: 'running',
      health: 'healthy',
      observedAt: new Date().toISOString(),
    },
  ]
  await agentRequest('heartbeat', { metrics, containers }, firstAgent.token)
  await go('services')
  await visible(`[data-service-id="${apiService.id}"]`)
  await clickText('选择部署位置', `[data-service-id="${apiService.id}"]`)
  await visible(`[data-target-actions="${firstTarget.id}"]`)
  await screenshot('console-services-multiple-desktop.png')
  await clickText('发布', `[data-target-actions="${firstTarget.id}"]`)
  await visible('#release-branch')
  // 组合触发器保留交互标记与材质标记，浮层关闭后仍能用键盘继续操作。
  assert.equal(await evaluate(`document.querySelector('#release-branch').dataset.ui`), 'button')
  await click('#release-branch')
  await visible('[cmdk-input]')
  await screenshot('glass-branch-menu-desktop.png')
  await dismissPopup('[data-slot=popover-content]')
  assert.equal(await evaluate('document.activeElement.id'), 'release-branch')
  // 无空格的长分支不能被菜单边缘截断，也不能把移动端浮层撑出屏幕。
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 1050,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await click('#release-branch')
  await visible('[cmdk-input]')
  await fill('[cmdk-input]', longBranch)
  await animationsSettled()
  assert.ok(
    await evaluate(
      `(()=>{const p=document.querySelector('[data-slot=popover-content]'),r=p.getBoundingClientRect(),item=p.querySelector('[cmdk-item]');return r.left>=0&&r.right<=innerWidth&&item.scrollWidth<=item.clientWidth+1&&item.textContent.includes(${JSON.stringify(longBranch)})})()`,
    ),
    '移动端长分支完整换行',
  )
  await screenshot('glass-long-branch-390.png')
  await dismissPopup('[data-slot=popover-content]')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await choose('#release-branch', 'test-branch')
  await visible('#confirm-release')
  await until(
    () => evaluate(`!document.querySelector('#confirm-release').disabled`),
    '发布准备完成',
  )
  assert.equal(await evaluate(`document.querySelectorAll('[data-commit]').length`), 100)
  await fill('[aria-label="搜索提交"]', 'ALICE')
  assert.equal(await evaluate(`document.querySelectorAll('[data-commit]').length`), 1)
  assert.equal(
    await evaluate(`document.querySelector('[data-commit]').textContent.includes('最新提交')`),
    false,
  )
  const oldSHA = createHash('sha1').update('历史提交-60').digest('hex')
  await fill('[aria-label="搜索提交"]', oldSHA.slice(0, 12).toUpperCase())
  assert.equal(await evaluate(`document.querySelector('[data-commit]').dataset.commit`), oldSHA)
  await screenshot('ux-commit-search-after-desktop.png')
  await fill('[aria-label="搜索提交"]', '不存在的提交')
  assert.equal(await evaluate(`document.querySelectorAll('[data-commit]').length`), 0)
  assert.equal(
    await evaluate(`document.querySelector('#confirm-release').disabled`),
    false,
    '过滤不清除已选版本',
  )
  await click('[aria-label="清空搜索提交"]')
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), '搜索提交')
  assert.ok(
    await evaluate(
      `!!document.querySelector('[aria-label="选择发布提交"]').closest('[data-slot="scroll-area-viewport"]')`,
    ),
  )
  await fill('[aria-label="搜索提交"]', String(version).repeat(40))
  assert.equal(await evaluate(`document.querySelectorAll('[data-commit]').length`), 1)
  await click('#confirm-release')
  await visible('[role=alertdialog]')
  assert.equal(
    await evaluate(`document.querySelector('[data-confirm-action]').dataset.variant`),
    'default',
  )
  assert.equal(
    await evaluate(`document.querySelector('[data-confirm-action]').textContent.trim()`),
    '确认发布',
  )
  assert.equal(
    await evaluate(`document.querySelectorAll('[data-confirmation-details] dt').length`),
    6,
  )
  await screenshot('ux-publish-confirmation.png')
  await click('[data-confirm-action]')
  await visible('#deploy-task-logs')
  await until(() => deployment.data.tasks.some((t) => t.status === 'queued'), '源码准备')
  const task = (await agentRequest('claim', {}, firstAgent.token)).task
  assert.equal(task.targetId, firstTarget.id)
  assert.equal(task.revision, String(version).repeat(40), '搜索后仍按选中的完整 SHA 创建任务')
  const send = (task, seq, stage, message, status, result) =>
    agentRequest(
      `tasks/${task.id}/events`,
      { seq, stage, message, ...(status ? { status } : {}), ...(result ? { result } : {}) },
      firstAgent.token,
    )
  await send(task, 1, 'downloading', '下载源码并校验')
  await send(task, 2, 'building', '编译公共依赖 <script>window.invalidLog=true</script>')
  await until(
    () => evaluate(`document.querySelector('#deploy-task-logs').textContent.includes('公共依赖')`),
    '实时日志',
  )
  assert.equal(await evaluate('Boolean(window.invalidLog)'), false)
  await send(task, 3, 'deploying', '更新容器')
  const release = {
    id: task.id,
    revision: task.revision,
    image: `cmr/${firstTarget.id}:${task.id}`,
    config: task.config,
  }
  await send(task, 4, 'verifying', '健康检查通过', 'succeeded', { release })
  await until(
    () => evaluate(`document.querySelector('#deploy-task-info').textContent.includes('发布成功')`),
    '首次成功',
  )
  await screenshot('console-task-desktop.png')
  await go('services')
  await clickText('选择部署位置', `[data-service-id="${apiService.id}"]`)
  const commitSelector = `[data-target-id="${firstTarget.id}"] .commit-summary`
  await visible(commitSelector)
  assert.equal(
    await evaluate(`(${query(commitSelector + ' .commit-subject')}).textContent`),
    task.commitSubject,
  )
  await until(
    () => evaluate(`(${query(commitSelector + ' .commit-subject')}).dataset.overflow === 'true'`),
    '超长提交说明渐隐',
  )
  assert.match(
    await evaluate(`getComputedStyle(${query(commitSelector + ' .commit-subject')}).maskImage`),
    /linear-gradient/,
  )
  await evaluate(`(${query(commitSelector)}).focus()`)
  await visible('[role="tooltip"]')
  assert.ok(
    await evaluate(
      `[...document.querySelectorAll('[role="tooltip"]')].some(el=>el.textContent.includes(${JSON.stringify(task.commitSubject)}) && el.textContent.includes(${JSON.stringify(task.revision)}))`,
    ),
  )
  await screenshot('console-commit-summary.png')
  await evaluate('document.activeElement.blur()')
  // 提示框的内容、边界和焦点交互一并验证，避免只检查文字而漏掉材质残留。
  for (const width of [390, 768, 1280, 1920]) {
    await command('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: width < 768,
    })
    await evaluate(`(${query(commitSelector)}).focus()`)
    await visible('[data-slot=tooltip-content]')
    await animationsSettled()
    assert.ok(
      await evaluate(
        `(()=>{const e=document.querySelector('[data-slot=tooltip-content]'),r=e.getBoundingClientRect();return !e.querySelector('svg polygon')&&r.left>=0&&r.right<=innerWidth&&e.scrollWidth<=e.clientWidth+1&&e.textContent.includes(${JSON.stringify(task.revision)})})()`,
      ),
      `提交提示在 ${width}px 完整显示且没有残留箭头`,
    )
    await screenshot(`glass-commit-tooltip-${width}.png`)
    await dismissPopup('[data-slot=tooltip-content]')
    assert.equal(await evaluate(`document.activeElement.matches('.commit-summary')`), true)
    await evaluate('document.activeElement.blur()')
  }
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const publish = async (action, chosenRelease) => {
    await go(
      'release',
      `?environment=${firstTarget.environmentId}&target=${firstTarget.id}&action=${action || 'deploy'}${chosenRelease ? '&release=' + chosenRelease : ''}`,
    )
    await visible('#confirm-release')
    await until(
      () => evaluate(`!document.querySelector('#confirm-release').disabled`),
      '发布可确认',
    )
    await click('#confirm-release')
    await visible('[role=alertdialog]')
    await click('[data-confirm-action]')
    await visible('#deploy-task-logs')
    await until(() => deployment.data.tasks.some((t) => t.status === 'queued'), '任务已排队')
    return (await agentRequest('claim', {}, firstAgent.token)).task
  }
  version = 2
  const next = await publish()
  await send(next, 1, 'verifying', '第二版健康检查通过', 'succeeded', {
    release: {
      id: next.id,
      revision: next.revision,
      image: `cmr/${firstTarget.id}:${next.id}`,
      config: next.config,
    },
  })
  await until(
    () => evaluate(`document.querySelector('#deploy-task-info').textContent.includes('发布成功')`),
    '第二版成功',
  )
  // 从第二页选中的版本必须精确进入回退确认，刷新后仍不能换成默认首项。
  const fillerIds = Array.from({ length: 22 }, () => randomUUID())
  await service.store.change((state) => {
    const original = state.deployments.releases.find((r) => r.id === task.id)
    const at = state.deployments.releases.findIndex((r) => r.id === next.id)
    state.deployments.releases.splice(
      at,
      0,
      ...fillerIds.map((id, i) => ({
        ...original,
        id,
        commitSubject: `历史填充 ${i}`,
        available: i !== 0,
        config: { ...original.config, profile: `history-profile-${i}` },
      })),
    )
  })
  await go(
    'service',
    `?environment=${firstTarget.environmentId}&target=${firstTarget.id}&tab=history`,
  )
  await visible('[data-release-id]')
  assert.equal(
    await evaluate(`document.querySelector('#deploy-view').textContent.includes('回退版本')`),
    false,
  )
  assert.equal(
    await evaluate(`document.querySelector('#deploy-view').textContent.includes('源码已归档')`),
    false,
  )
  assert.equal(
    await evaluate(`Boolean(document.querySelector('[data-release-id="${task.id}"]'))`),
    false,
  )
  await clickText('加载更早版本')
  await visible(`[data-release-id="${task.id}"]`)
  await clickText('回退', `[data-release-id="${task.id}"]`)
  await visible('[data-release-option]')
  assert.ok((await evaluate('location.hash')).includes('release=' + task.id))
  await command('Page.reload')
  await visible('[data-release-option]')
  await until(
    () => evaluate(`!document.querySelector('#confirm-release').disabled`),
    '精确版本回退可确认',
  )
  assert.equal(
    await evaluate(
      `document.querySelector('[data-release-option="${task.id}"]').getAttribute('aria-pressed')`,
    ),
    'true',
  )
  assert.equal(await evaluate(`Boolean(document.querySelector('#deploy-releaseId'))`), false)
  const tasksBeforeSelection = deployment.data.tasks.length
  await click(`[data-release-option="${next.id}"]`)
  assert.equal(
    await evaluate(`document.querySelector('[data-release-option="${next.id}"]').disabled`),
    true,
  )
  assert.equal(
    await evaluate(`document.querySelector('[data-selected-release]').dataset.selectedRelease`),
    task.id,
  )
  // 同一提交的不同发布记录按版本 ID 选择，确认区必须使用该版本的历史配置。
  const alternativeId = fillerIds.at(-1)
  await click(`[data-release-option="${alternativeId}"]`)
  assert.equal(
    await evaluate(`document.querySelector('[data-selected-release]').dataset.selectedRelease`),
    alternativeId,
  )
  assert.match(
    await evaluate(`document.querySelector('.release-review').textContent`),
    /history-profile-21/,
  )
  await fill('[aria-label="搜索已发布版本"]', alternativeId)
  assert.equal(await evaluate(`document.querySelectorAll('[data-release-option]').length`), 1)
  await fill('[aria-label="搜索已发布版本"]', '不存在的历史版本')
  assert.equal(await evaluate(`document.querySelectorAll('[data-release-option]').length`), 0)
  assert.equal(
    await evaluate(`document.querySelector('[data-selected-release]').dataset.selectedRelease`),
    alternativeId,
  )
  await click('[aria-label="清空搜索已发布版本"]')
  await clickText('加载更多历史版本')
  await visible(`[data-release-option="${fillerIds[0]}"]`)
  await click(`[data-release-option="${fillerIds[0]}"]`)
  assert.equal(
    await evaluate(`document.querySelector('[data-release-option="${fillerIds[0]}"]').disabled`),
    true,
  )
  assert.equal(
    await evaluate(`document.querySelector('[data-selected-release]').dataset.selectedRelease`),
    alternativeId,
  )
  await evaluate(`document.querySelector('[data-release-option="${task.id}"]').focus()`)
  assert.equal(await evaluate(`document.activeElement.dataset.releaseOption`), task.id)
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
  })
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  })
  await until(
    () =>
      evaluate(
        `document.querySelector('[data-selected-release]').dataset.selectedRelease === '${task.id}'`,
      ),
    '键盘选择历史版本',
  )
  assert.equal(deployment.data.tasks.length, tasksBeforeSelection)
  await click('#confirm-release')
  await visible('[role=alertdialog]')
  assert.ok(
    (await evaluate(`document.querySelector('[role=alertdialog]').textContent`)).includes(task.id),
  )
  await clickText('取消', '[role=alertdialog]')
  assert.equal(deployment.data.tasks.length, tasksBeforeSelection)
  await click('#confirm-release')
  await visible('[role=alertdialog]')
  await click('[data-confirm-action]')
  await visible('#deploy-task-logs')
  await until(
    () => deployment.data.tasks.some((t) => t.status === 'queued'),
    '列表选择的回退任务已排队',
  )
  const rollback = (await agentRequest('claim', {}, firstAgent.token)).task
  assert.equal(rollback.release.id, task.id)
  await send(rollback, 1, 'verifying', '回退健康检查通过', 'succeeded', {
    release: rollback.release,
  })
  await until(
    () => evaluate(`document.querySelector('#deploy-task-info').textContent.includes('回退成功')`),
    '回退成功',
  )
  await service.store.change((state) => {
    state.deployments.releases = state.deployments.releases.filter((r) => !fillerIds.includes(r.id))
  })
  const restart = await publish('restart')
  assert.equal(restart.action, 'restart')
  await send(restart, 1, 'verifying', '重启健康检查通过', 'succeeded', {
    release: rollback.release,
  })
  await until(
    () => evaluate(`document.querySelector('#deploy-task-info').textContent.includes('重启成功')`),
    '重启成功',
  )
  const failed = await publish()
  await send(failed, 1, 'building', '开始编译')
  await send(failed, 2, 'building', 'Maven 编译失败：测试错误', 'failed')
  await until(() => evaluate(`Boolean(document.querySelector('.stage-step.failed'))`), '失败阶段')
  assert.match(
    await evaluate(`document.querySelector('#deploy-task-result').textContent`),
    /Maven 编译失败/,
  )
  await screenshot('console-task-failed.png')

  // 新旧地址和环境切换保持服务身份，快照不混入待发布配置。
  await go('configuration', `?environment=${firstTarget.environmentId}&target=${firstTarget.id}`)
  await clickText('配置')
  await visible('.configuration-stack')
  await clickText('已部署配置')
  assert.match(await evaluate(`document.querySelector('#deploy-view').textContent`), /test-branch/)
  await clickText('发布记录')
  await until(
    () => evaluate(`document.querySelector('#deploy-view').textContent.includes('当前版本')`),
    '版本记录',
  )
  assert.ok((await evaluate('location.hash')).includes('tab=history'), '点击页签写入地址')
  await go(
    'service',
    `?environment=${firstTarget.environmentId}&target=${firstTarget.id}&tab=config`,
  )
  await visible('.configuration-stack')
  await evaluate('history.back()')
  await until(
    () =>
      evaluate(
        `location.hash.includes('tab=history') && !!document.querySelector('[data-release-id]')`,
      ),
    '后退恢复发布记录',
  )
  await evaluate('history.forward()')
  await visible('.configuration-stack')
  await clickText('发布记录')
  await command('Page.reload')
  await visible('[data-release-id]')
  assert.equal(
    await evaluate(`document.querySelector('[role=tab][data-state=active]').textContent`),
    '发布记录',
    '刷新保留页签',
  )
  await choose('#environment-select', '生产')
  await visible('[data-slot=empty]')
  assert.match(
    await evaluate(`document.querySelector('#deploy-view').textContent`),
    /当前环境尚未配置/,
  )
  await choose('#environment-select', '测试')
  await clickText('配置')
  await visible('.configuration-stack')
  await clickText('编辑部署配置')
  await fill('#deploy-profile', 'changed-unsaved')
  await choose('#environment-select', '生产')
  await visible('[role=alertdialog]')
  await clickText('取消', '[role=alertdialog]')
  assert.equal(await evaluate(`document.querySelector('#deploy-profile').value`), 'changed-unsaved')
  await until(() => evaluate(`!document.querySelector('[role=alertdialog]')`), '取消离开提示已关闭')
  await clickText('返回')
  await visible('[role=alertdialog]')
  await clickText('放弃修改并离开', '[role=alertdialog]')
  await until(() => evaluate(`!document.querySelector('.deploy-dialog')`), '放弃当前输入')
  assert.equal(firstTarget.config.profile, 'test')

  // 静态站点使用同一接入流程，同时保留独立的参数与发布阶段。
  await go('services')
  await click('#create-button')
  await fill('#deploy-name', '管理前端')
  await choose('#deploy-kind', '前端静态站点（Vue / React）')
  await fill('#deploy-module', 'web')
  await submit()
  await visible('#deploy-sourceProjectId')
  await submit()
  await visible('#deploy-healthUrl')
  assert.equal(await evaluate(`Boolean(document.querySelector('#deploy-runtimeImage'))`), false)
  await choose('#deploy-packageManager', 'pnpm')
  await fill('#deploy-packageManagerVersion', '10.11.0')
  await fill('#deploy-buildArgs', '--mode\ntest')
  await fill('#deploy-healthUrl', 'https://app.example.test/')
  await submit()
  await visible('.configuration-stack')
  const staticService = deployment.data.services.find((s) => s.name === '管理前端')
  const staticTarget = deployment.data.targets.find((t) => t.serviceId === staticService.id)
  assert.equal(staticTarget.config.kind, 'static')
  assert.equal(staticTarget.config.runtime, undefined)
  assert.deepEqual(staticTarget.config.buildArgs, ['--mode', 'test'])
  await go('release', `?environment=${staticTarget.environmentId}&target=${staticTarget.id}`)
  await visible('#confirm-release')
  await until(
    () => evaluate(`!document.querySelector('#confirm-release').disabled`),
    '前端发布准备',
  )
  await click('#confirm-release')
  await visible('[role=alertdialog]')
  await click('[data-confirm-action]')
  await visible('#deploy-task-logs')
  await until(() => deployment.data.tasks.some((t) => t.status === 'queued'), '前端任务排队')
  const staticTask = (await agentRequest('claim', {}, firstAgent.token)).task
  await send(staticTask, 1, 'deploying', '切换静态站点')
  await until(
    () =>
      evaluate(`document.querySelector('#deploy-task-progress').textContent.includes('切换站点')`),
    '前端阶段',
  )
  await send(staticTask, 2, 'verifying', '站点校验成功', 'succeeded', {
    release: {
      id: staticTask.id,
      kind: 'static',
      artifact: `static/${staticTarget.id}/${staticTask.id}`,
      revision: staticTask.revision,
      config: staticTask.config,
    },
  })
  await until(
    () => evaluate(`document.querySelector('#deploy-task-info').textContent.includes('发布成功')`),
    '静态发布成功',
  )

  // 同服务静态配置复用保留包管理器，但必须重新填写站点地址。
  await go('setup', `?environment=${staticTarget.environmentId}&service=${staticService.id}&step=3`)
  await visible('#deploy-configTemplate')
  await choose('#deploy-configTemplate', templateLabel)
  await clickText('应用配置')
  await visible('[role=alertdialog]')
  await click('[data-confirm-action]')
  await until(
    () => evaluate(`document.querySelector('#deploy-packageManager').textContent.includes('pnpm')`),
    '复用 pnpm',
  )
  assert.equal(await evaluate(`document.querySelector('#deploy-buildArgs').value`), '--mode\ntest')
  assert.equal(await evaluate(`document.querySelector('#deploy-healthUrl').value`), '')
  assert.match(
    await evaluate(`document.querySelector('#health-check-preview').textContent`),
    /HTTP 200.*发布版本标记/,
  )
  await clickText('稍后继续')
  await visible('[role=alertdialog]')
  await clickText('放弃修改并离开', '[role=alertdialog]')
  assert.equal(deployment.data.targets.filter((t) => t.serviceId === staticService.id).length, 1)

  // 提交选择、日志补读和任务快照继续兼容。
  await go('release', `?environment=${firstTarget.environmentId}&target=${firstTarget.id}`)
  await visible('#refresh-commits')
  await until(
    () => evaluate(`!document.querySelector('#confirm-release').disabled`),
    '按当前版本预选分支',
  )
  assert.ok(
    await evaluate(`document.querySelector('#release-branch').textContent.includes('test-branch')`),
  )
  // 故意让旧分支请求迟到，确认它不能覆盖新分支的提交列表。
  const originalHistory = builder.history
  let releaseOldResponse,
    oldStarted = false,
    oldReturned = false
  const oldResponseGate = new Promise((resolve) => {
    releaseOldResponse = resolve
  })
  builder.history = async function (source, credential, refresh) {
    if (source.branch === 'frontend-test') {
      oldStarted = true
      await oldResponseGate
      oldReturned = true
      return {
        commits: [
          {
            revision: 'e'.repeat(40),
            subject: '迟到分支的提交',
            author: '测试',
            at: new Date().toISOString(),
          },
        ],
        refreshedAt: new Date().toISOString(),
      }
    }
    return originalHistory.call(this, source, credential, refresh)
  }
  await fill('[aria-label="搜索提交"]', '待切换分支的筛选')
  await choose('#release-branch', 'frontend-test')
  assert.equal(await evaluate(`document.querySelector('[aria-label="搜索提交"]').value`), '')
  await until(() => oldStarted, '旧分支请求开始')
  assert.equal(await evaluate(`document.querySelector('#confirm-release').disabled`), true)
  await choose('#release-branch', 'test-branch')
  await until(
    () => evaluate(`!document.querySelector('#confirm-release').disabled`),
    '新分支提交就绪',
  )
  releaseOldResponse()
  await until(() => oldReturned, '旧分支请求返回')
  await evaluate('new Promise(resolve => setTimeout(resolve, 100))')
  assert.equal(
    await evaluate(
      `document.querySelector('#release-workbench').textContent.includes('迟到分支的提交')`,
    ),
    false,
  )
  builder.history = originalHistory
  await click('#refresh-commits')
  await visible('[data-commit]')
  const before = deployment.data.tasks.length
  assert.equal(
    await evaluate(`document.querySelector('[data-commit]').getAttribute('aria-pressed')`),
    'true',
  )
  assert.equal(deployment.data.tasks.length, before)
  version++
  await click('#refresh-commits')
  await until(
    () =>
      evaluate(
        `document.querySelector('#release-workbench').textContent.includes('原提交已不在刷新后的列表中')`,
      ),
    '刷新后过期提交不能自动替换',
  )
  assert.equal(await evaluate(`document.querySelector('#confirm-release').disabled`), true)
  await click('[data-commit]')
  await click('#confirm-release')
  await visible('[role=alertdialog]')
  await click('[data-confirm-action]')
  await visible('#deploy-task-logs')
  await until(() => deployment.data.tasks.some((t) => t.status === 'queued'), '固定提交任务排队')
  const pinned = (await agentRequest('claim', {}, firstAgent.token)).task
  assert.equal(pinned.revision, String(version).repeat(40))
  for (const [seq, stage, message] of [
    [1, 'downloading', '下载'],
    [2, 'building', '编译'],
    [3, 'building', '镜像'],
    [4, 'deploying', '更新'],
  ])
    await send(pinned, seq, stage, message)
  await send(pinned, 5, 'verifying', '验证完成', 'succeeded', {
    release: {
      id: pinned.id,
      revision: pinned.revision,
      image: `cmr/${firstTarget.id}:${pinned.id}`,
      config: pinned.config,
    },
  })
  await until(
    () => evaluate(`document.querySelector('#deploy-task-info').textContent.includes('发布成功')`),
    '固定提交成功',
  )
  await clickText('完整日志', '#task-workbench')
  await until(
    () => evaluate(`document.querySelector('#deploy-task-logs').textContent.includes('验证完成')`),
    '完整日志',
  )
  const logs = await evaluate(`document.querySelector('#deploy-task-logs').textContent`)
  await fill('[aria-label="搜索日志"]', '编译')
  assert.ok(
    (await evaluate(`document.querySelector('#deploy-task-logs').textContent`)).includes('编译'),
  )
  assert.equal(
    await evaluate(`document.querySelector('#deploy-task-logs').textContent.includes('验证完成')`),
    false,
  )
  await screenshot('ux-log-search-after-desktop.png')
  await evaluate(`(() => {
    window.originalCreateObjectURL = URL.createObjectURL;
    window.originalAnchorClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob) => { window.downloadText = blob.text(); return window.originalCreateObjectURL(blob) };
    HTMLAnchorElement.prototype.click = function() { if (this.download) window.downloadName = this.download; else window.originalAnchorClick.call(this) };
  })()`)
  await clickText('下载日志')
  assert.equal(await evaluate('window.downloadName'), `autoops-${pinned.id}.log`)
  assert.equal(
    (await evaluate('window.downloadText')).trimEnd(),
    logs.trimEnd(),
    '下载保留搜索之外的所有已加载日志',
  )
  await evaluate(
    `URL.createObjectURL = window.originalCreateObjectURL; HTMLAnchorElement.prototype.click = window.originalAnchorClick`,
  )
  await fill('[aria-label="搜索日志"]', '[不存在.*]')
  assert.match(
    await evaluate(`document.querySelector('#deploy-task-logs').textContent`),
    /没有匹配/,
  )
  await click('[aria-label="清空搜索日志"]')
  assert.equal(await evaluate(`document.querySelector('#deploy-task-logs').textContent`), logs)

  for (const word of ['下载', '编译', '镜像', '更新', '验证完成']) assert.ok(logs.includes(word))
  const taskUrl = await evaluate('location.href')
  await command('Page.navigate', { url: taskUrl })
  await visible('#deploy-task-logs')
  await until(
    () => evaluate(`document.querySelector('#deploy-task-logs').textContent.includes('验证完成')`),
    '重载日志',
  )
  assert.equal(
    (await evaluate(`document.querySelector('#deploy-task-logs').textContent`)).match(/验证完成/g)
      .length,
    1,
  )

  // 使用真实页面数据检查搜索、排序、分页和卡片摘要。
  for (let i = 0; i < 12; i++)
    await workspaces.saveEntity(initialProject.id, 'services', {
      name: `额外服务 ${String(i).padStart(2, '0')}${i === 11 ? '-LongName'.repeat(6) : ''}`,
      module: '.',
    })
  for (const legacy of ['applications', 'deployments']) {
    await go(legacy)
    await visible('[data-slot=data-table]')
    assert.equal(
      await evaluate(`document.querySelector('#page-title').textContent.trim()`),
      '服务与部署',
    )
  }
  await go('services')
  await visible('[aria-label="下一页"]')
  await click('[aria-label="下一页"]')
  assert.match(
    await evaluate(`document.querySelector('[data-slot=data-table]').textContent`),
    /第 2/,
  )
  await fill('[aria-label="搜索服务、仓库或分支…"]', '额外服务 11')
  await until(
    () =>
      evaluate(
        `document.querySelector('[data-slot=data-table]').textContent.includes('匹配 1 条')`,
      ),
    '搜索筛选',
  )
  await fill('[aria-label="搜索服务、仓库或分支…"]', '')
  await choose('[aria-label="筛选状态"]', '待配置')
  await until(
    () =>
      evaluate(
        `document.querySelector('[data-slot=data-table]').textContent.includes('匹配 12 条')`,
      ),
    '状态筛选',
  )
  await choose('[aria-label="筛选状态"]', '全部状态')
  await clickText('服务')
  await screenshot('console-services-sorted.png')

  // 首页使用真实接口验证：分页覆盖全部服务、卡片等高，资源切换不改变环境服务版本。
  const attentionService = deployment.data.services.find((item) =>
    item.name.startsWith('额外服务 11'),
  )
  const sourceId = workspaces
    .overview(initialProject.id)
    .environmentSources.find((item) => item.serviceId === apiService.id).sourceProjectId
  await workspaces.saveSource(initialProject.id, {
    environmentId: firstTarget.environmentId,
    serviceId: attentionService.id,
    sourceProjectId: sourceId,
  })
  const attentionTarget = await workspaces.saveEntity(initialProject.id, 'targets', {
    environmentId: firstTarget.environmentId,
    serviceId: attentionService.id,
    serverId: firstAgent.serverId,
    mode: 'managed',
  })
  const unknownService = deployment.data.services.find((item) =>
    item.name.startsWith('额外服务 10'),
  )
  await workspaces.saveSource(initialProject.id, {
    environmentId: firstTarget.environmentId,
    serviceId: unknownService.id,
    sourceProjectId: sourceId,
  })
  const unknownTarget = await workspaces.saveEntity(initialProject.id, 'targets', {
    environmentId: firstTarget.environmentId,
    serviceId: unknownService.id,
    serverId: firstAgent.serverId,
    mode: 'managed',
  })
  const currentApi = deployment.data.targets.find((item) => item.id === firstTarget.id)
  await service.store.change((state) => {
    state.deployments.targets.find((item) => item.id === secondTarget.id).currentRelease =
      structuredClone(currentApi.currentRelease)
  })
  await agentRequest(
    'heartbeat',
    {
      metrics: {
        ...metrics,
        cpuPercent: 85,
        disk: { used: 93 * 1024 ** 3, total: 100 * 1024 ** 3 },
      },
      containers: [
        {
          targetId: firstTarget.id,
          state: 'running',
          health: 'healthy',
          revision: currentApi.currentRelease.revision,
        },
        { targetId: attentionTarget.id, state: 'stopped', health: 'unhealthy' },
        { targetId: unknownTarget.id, state: 'running', health: 'healthy' },
      ],
    },
    firstAgent.token,
  )
  await agentRequest(
    'heartbeat',
    {
      metrics,
      containers: [
        {
          targetId: secondTarget.id,
          state: 'running',
          health: 'healthy',
          revision: currentApi.currentRelease.revision,
        },
      ],
    },
    secondAgent.token,
  )
  await click('[data-view=home]')
  await visible('#workspace-home')
  const homeCard = `[data-workspace-id="${initialProject.id}"]`
  const homeApi = `${homeCard} [data-home-service="${apiService.id}"]`
  const homeVersion = `${homeApi} [data-service-version]`
  const homeSize = () =>
    evaluate(
      `(() => { const c=document.querySelector('${homeCard}'),b=c.getBoundingClientRect();return {height:Math.round(b.height*100)/100,width:Math.round(b.width*100)/100}; })()`,
    )
  const firstHomePage = async () => {
    while (
      await evaluate(`!document.querySelector('${homeCard} [aria-label="上一页服务"]').disabled`)
    )
      await click(`${homeCard} [aria-label="上一页服务"]`)
  }
  const showHomeService = async (id) => {
    await firstHomePage()
    for (let i = 0; i < 20; i++) {
      if (
        await evaluate(`Boolean(document.querySelector('${homeCard} [data-home-service="${id}"]'))`)
      )
        return
      if (
        await evaluate(`document.querySelector('${homeCard} [aria-label="下一页服务"]').disabled`)
      )
        break
      await click(`${homeCard} [aria-label="下一页服务"]`)
    }
    throw Error('分页未找到服务 ' + id)
  }
  const assertWholeRows = () =>
    evaluate(
      `(() => {const c=document.querySelector('${homeCard}'),area=c.querySelector('.tile-services').getBoundingClientRect();return [...c.querySelectorAll('[data-home-service]')].every(e=>{const r=e.getBoundingClientRect();return r.top>=area.top-.5&&r.bottom<=area.bottom+.5;});})()`,
    )
  const beforeSize = await homeSize()
  assert.equal(beforeSize.height, 440)
  const footerStyle = await evaluate(
    `(() => {const c=document.querySelector('${homeCard}'),link=getComputedStyle(c.querySelector('.tile-all-services')),name=getComputedStyle(c.querySelector('.tile-service-name'));return {weight:link.fontWeight,size:parseFloat(link.fontSize),nameSize:parseFloat(name.fontSize),color:link.color,pageColor:getComputedStyle(c.querySelector('.tile-pagination > span')).color};})()`,
  )
  assert.equal(footerStyle.weight, '400', '提示组件包裹的页脚按钮仍使用常规字重')
  assert.ok(footerStyle.size < footerStyle.nameSize, '服务计数的视觉层级低于服务名称')
  assert.equal(footerStyle.color, footerStyle.pageColor, '服务计数与分页使用同一辅助色')
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('${homeCard} [role=tab][data-state=active]')).boxShadow`,
    ),
    'none',
    '环境切换不叠加浮起阴影',
  )
  assert.ok(
    !(
      await evaluate(`document.querySelector('${homeCard} .tile-host-heading').innerText`)
    ).includes('整机'),
    '主机范围说明移入资源提示',
  )
  const expectedIds = workspaces.overview(initialProject.id).services.map((item) => item.id),
    displayed = []
  await firstHomePage()
  do {
    await animationsSettled()
    displayed.push(
      ...(await evaluate(
        `[...document.querySelectorAll('${homeCard} [data-home-service]')].map(e=>e.dataset.homeService)`,
      )),
    )
    assert.deepEqual(await homeSize(), beforeSize)
    assert.ok(await assertWholeRows(), '每页服务行必须完整显示')
    if (await evaluate(`document.querySelector('${homeCard} [aria-label="下一页服务"]').disabled`))
      break
    await click(`${homeCard} [aria-label="下一页服务"]`)
  } while (displayed.length <= expectedIds.length)
  assert.deepEqual(displayed, expectedIds, '分页覆盖全部服务并保持固定顺序')
  await showHomeService(unknownService.id)
  const unknownText = await evaluate(
    `document.querySelector('${homeCard} [data-home-service="${unknownService.id}"]').textContent`,
  )
  assert.ok(unknownText.includes('运行中') && unknownText.includes('版本待识别'))
  assert.ok(!unknownText.includes('尚未发布'))
  await showHomeService(attentionService.id)
  assert.ok(
    (
      await evaluate(
        `document.querySelector('${homeCard} [data-home-service="${attentionService.id}"]').textContent`,
      )
    ).includes('异常'),
  )
  await showHomeService(apiService.id)
  assert.match(
    await evaluate(
      `document.querySelector('${homeCard} [aria-label^="查看全部"]').getAttribute('aria-label')`,
    ),
    /待处理/,
  )
  const versionBefore = await evaluate(`document.querySelector('${homeVersion}').textContent`)
  assert.ok(versionBefore.includes(currentApi.currentRelease.sourceSnapshot.branch))
  assert.ok(!versionBefore.includes('尚未发布'))
  assert.ok(!versionBefore.includes('独立演示源码'))
  assert.ok(versionBefore.includes(currentApi.currentRelease.revision.slice(0, 10)))
  assert.ok(
    (await evaluate(`document.querySelector('${homeApi} .tile-runtime').textContent`)).includes(
      '运行中',
    ),
  )
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('${homeCard} [data-resource="CPU"] .tabular-nums')).color`,
    ),
    await evaluate(
      `getComputedStyle(document.querySelector('${homeCard} [data-resource="磁盘"] .tabular-nums')).color`,
    ),
    '资源偏高与紧张均标红',
  )
  assert.match(
    await evaluate(
      `document.querySelector('${homeCard} [data-resource="磁盘"]').getAttribute('aria-label')`,
    ),
    /93%.*空间紧张.*7.0 GB/,
  )
  assert.equal(
    await evaluate(`document.querySelector('${homeCard} [data-resource="磁盘"]').dataset.level`),
    'critical',
  )
  await evaluate(`document.querySelector('${homeCard} [data-resource="磁盘"]').focus()`)
  await visible('[role=tooltip]')
  assert.match(
    await evaluate(`document.querySelector('[role=tooltip]').textContent`),
    /整台服务器资源.*空间紧张.*剩余 7.0 GB.*最近采集/,
  )
  await choose('[aria-label="SOL 标准版的资源服务器"]', '测试服务器 B')
  assert.equal(
    await evaluate(`document.querySelector('${homeVersion}').textContent`),
    versionBefore,
  )
  assert.equal(
    await evaluate(`document.querySelector('${homeCard} [data-resource="磁盘"]').dataset.level`),
    'normal',
  )
  await choose('[aria-label="SOL 标准版的资源服务器"]', '测试服务器 A')
  await menu(homeApi, '测试服务器 B')
  await visible('#release-workbench')
  assert.ok((await evaluate('location.hash')).includes(`target=${secondTarget.id}`))
  await click('[data-view=home]')
  await visible(homeApi)
  await menu(homeApi, '测试服务器 A')
  await visible('#release-workbench')
  assert.ok((await evaluate('location.hash')).includes(`target=${firstTarget.id}`))
  await click('[data-view=home]')
  await visible(homeApi)
  await clickText(apiService.name, homeApi)
  await visible('[aria-label="部署位置"]')
  await click('[data-view=home]')
  await visible(homeApi)
  await showHomeService(attentionService.id)
  await click(`[aria-label="${attentionService.name} · 发布"]`)
  await visible('#release-workbench')
  assert.ok((await evaluate('location.hash')).includes(`target=${attentionTarget.id}`))
  await click('[data-view=home]')
  await showHomeService(apiService.id)
  await visible(homeApi)
  await service.store.change((state) => {
    state.deployments.targets.find((item) => item.id === secondTarget.id).currentRelease = null
  })
  await until(
    () => evaluate(`document.querySelector('${homeVersion}')?.textContent.includes('版本不同')`),
    '多位置版本差异',
  )
  const productionEnv = deployment.data.environments.find(
    (item) => item.applicationId === initialProject.id && item.id !== firstTarget.environmentId,
  )
  await clickText(productionEnv.name, `${homeCard} [role=tablist]`)
  await until(
    () =>
      evaluate(
        `document.querySelector('${homeCard} .tile-services')?.getAttribute('aria-label').includes('${productionEnv.name}')`,
      ),
    '首页环境切换',
  )
  assert.ok(
    !(
      await evaluate(
        `document.querySelector('${homeCard} [aria-label^="查看全部"]').getAttribute('aria-label')`,
      )
    ).includes('待处理'),
  )
  const testEnv = deployment.data.environments.find((item) => item.id === firstTarget.environmentId)
  await clickText(testEnv.name, `${homeCard} [role=tablist]`)
  await showHomeService(apiService.id)
  assert.equal(
    await evaluate(
      `document.querySelectorAll('[data-workspace-id="${initialProject.id}"] [data-home-service]').length`,
    ),
    3,
  )
  assert.equal(
    await evaluate(`getComputedStyle(document.querySelector('.tile-services')).overflowY`),
    'visible',
  )
  const layoutProject = await workspaces.create({ name: '排版验证项目' })
  await visible(`[data-workspace-id="${layoutProject.id}"]`)
  assert.equal(
    await evaluate(
      `Math.round(document.querySelector('[data-workspace-id="${layoutProject.id}"]').getBoundingClientRect().height*100)/100`,
    ),
    beforeSize.height,
    '空项目与多服务项目等高',
  )
  await screenshot('console-home-desktop.png')

  // 玻璃主题必须保留键盘焦点，并遵守系统的减少透明效果及高对比度偏好。
  await command('Page.bringToFront')
  await evaluate(`document.querySelector('[aria-label="搜索项目"]').focus()`)
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
  })
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
  })
  assert.ok(
    await evaluate(
      `document.activeElement.matches(':focus-visible') && parseFloat(getComputedStyle(document.activeElement).outlineWidth) >= 2`,
    ),
    '键盘导航保留可见焦点',
  )
  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  })
  assert.equal(
    await evaluate(`getComputedStyle(document.querySelector('[data-slot=card]')).backdropFilter`),
    'none',
    '减少透明效果时关闭模糊',
  )
  assert.ok(
    await evaluate(
      `!getComputedStyle(document.querySelector('[data-slot=card]')).backgroundColor.includes('/')`,
    ),
    '减少透明效果时使用不透明卡片',
  )
  await screenshot('glass-reduced-transparency.png')
  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'forced-colors', value: 'active' }],
  })
  assert.equal(
    await evaluate(`getComputedStyle(document.body).backgroundImage`),
    'none',
    '高对比度模式清除装饰背景',
  )
  await screenshot('glass-high-contrast.png')
  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }],
  })

  for (const width of [320, 390, 768, 1280, 1920]) {
    await command('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1050,
      deviceScaleFactor: 1,
      mobile: width < 768,
    })
    await click('[data-view=home]')
    await visible('#workspace-home')
    await animationsSettled()
    assert.equal(
      await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),
      true,
      `首页在 ${width}px 溢出`,
    )
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('.project-tile')].every(card => card.scrollWidth <= card.clientWidth + 1)`,
      ),
      true,
      `卡片内容在 ${width}px 溢出`,
    )
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('.project-tile')].every(c=>Math.abs(c.getBoundingClientRect().height-440)<.01)`,
      ),
      true,
      '所有项目卡片等高',
    )
    assert.ok(await assertWholeRows(), `服务行在 ${width}px 完整显示`)
    const cardContentFits = await evaluate(
      `(() => {const c=document.querySelector('${homeCard}');return [...c.querySelectorAll('[data-home-service]')].every(row=>{const version=row.querySelector('[data-service-version]'),actions=row.querySelector('.tile-service-end'),label=row.querySelector('.tile-runtime-label').getBoundingClientRect(),button=row.querySelector('.tile-service-action').getBoundingClientRect();return version.scrollWidth<=version.clientWidth+1&&version.getBoundingClientRect().right<=actions.getBoundingClientRect().left+1&&Math.abs(label.x+label.width/2-button.x-button.width/2)<1;});})()`,
    )
    assert.ok(cardContentFits, `版本信息不与操作区重叠，状态文字在 ${width}px 与发布按钮居中对齐`)
    await screenshot(`console-home-${width}.png`)
    if (width === 390) {
      await click('[data-sidebar="trigger"]')
      await visible('[data-ui=sheet]')
      await screenshot('glass-mobile-navigation.png')
      await dismissPopup('[data-ui=sheet]')
      assert.equal(await evaluate(`document.activeElement.getAttribute('data-sidebar')`), 'trigger')
    }
    for (const view of ['overview', 'services', 'projects', 'environments', 'servers', 'tasks']) {
      await go(view)
      await until(() => evaluate(`!document.querySelector('[aria-label="正在加载"]')`), '页面加载')
      await animationsSettled()
      assert.equal(
        await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),
        true,
        `${view} 在 ${width}px 溢出`,
      )
      if (view === 'overview') {
        assert.equal(
          await evaluate(
            `[...document.querySelectorAll('[data-overview] [data-slot="card-header"]')].every(header => {const title=header.querySelector('[data-slot="card-title"]').getBoundingClientRect(),button=header.querySelector('button').getBoundingClientRect();return Math.abs(title.y+title.height/2-button.y-button.height/2)<1;})`,
          ),
          true,
          '概览管理按钮与标题在同一行',
        )
      }
      if (view === 'environments') {
        assert.equal(
          await evaluate(`document.querySelector('#deploy-view').textContent.includes('查看服务')`),
          false,
        )
        if (width >= 768)
          assert.equal(
            await evaluate(
              `(() => {const table=document.querySelector('#deploy-view table'),head=table.querySelector('th:last-child').getBoundingClientRect(),cell=table.querySelector('td:last-child').getBoundingClientRect();return Math.abs(head.x-cell.x)<1 && getComputedStyle(table.querySelector('td:last-child > div')).justifyContent!=='flex-end';})()`,
            ),
            true,
            '环境操作与表头对齐',
          )
      }
      if (view === 'servers') {
        assert.equal(
          await evaluate(
            `getComputedStyle(document.querySelector('.bind-server')).backgroundColor === getComputedStyle(document.querySelector('#create-button')).backgroundColor`,
          ),
          true,
          '两个接入按钮样式一致',
        )
        assert.equal(
          await evaluate(`document.querySelector('#deploy-view').textContent.includes('查看详情')`),
          false,
        )
        assert.equal(
          await evaluate(
            `[...document.querySelectorAll('.server-card')].every(card => card.scrollWidth <= card.clientWidth + 1)`,
          ),
          true,
        )
      }
      if (['services', 'overview', 'environments', 'servers', 'projects'].includes(view))
        await screenshot(`console-${view}-${width}.png`)
      if (view === 'services' && [390, 1280].includes(width)) {
        await click('[data-slot=dropdown-menu-trigger][aria-label$="更多操作"]')
        await visible('[role=menu]')
        await screenshot(`glass-actions-menu-${width}.png`)
        await dismissPopup('[role=menu]')
        assert.equal(await evaluate('document.activeElement.dataset.ui'), 'button')
      }
    }
    await go(
      'service',
      `?environment=${firstTarget.environmentId}&target=${firstTarget.id}&tab=config`,
    )
    await visible('.configuration-stack')
    assert.equal(
      await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),
      true,
      `配置在 ${width}px 溢出`,
    )
    await screenshot(`console-config-${width}.png`)
    await clickText('发布记录')
    await visible('[data-release-id]')
    assert.equal(
      await evaluate(
        `document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('[data-release-id] [data-slot=badge]')].every(b => b.getBoundingClientRect().height <= 28)`,
      ),
      true,
      '版本状态不拉伸且页面不溢出',
    )
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('[data-release-id]')].every(row=>{const box=row.getBoundingClientRect(),commit=row.querySelector('.commit-summary').getBoundingClientRect();return commit.right<=box.right+.5;})`,
      ),
      true,
      '长提交说明不超出历史记录内容区',
    )
    await screenshot(`console-history-${width}.png`)
    const historyRow = '[data-release-id]:first-child'
    await clickText('版本与构建明细', historyRow)
    assert.equal(
      await evaluate(`document.querySelector('${historyRow} button[aria-expanded]').dataset.state`),
      'open',
    )
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
    await clickText('版本与构建明细', historyRow)
    await go('release', `?environment=${firstTarget.environmentId}&target=${firstTarget.id}`)
    await visible('[aria-label="搜索提交"]')
    await until(
      () => evaluate(`!document.querySelector('[aria-label="搜索提交"]').disabled`),
      '提交检索可用',
    )
    await fill('[aria-label="搜索提交"]', 'ALICE')
    assert.equal(await evaluate(`document.querySelectorAll('[data-commit]').length`), 1)
    assert.equal(
      await evaluate('document.documentElement.scrollWidth <= innerWidth'),
      true,
      `提交检索 ${width}px`,
    )
    await screenshot(`ux-commit-search-${width}.png`)
    await clickText('已发布版本')
    await visible('[data-release-option]')
    assert.equal(
      await evaluate(
        `document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('[data-release-option]')].every(row => row.scrollWidth <= row.clientWidth + 1)`,
      ),
      true,
      `历史版本列表在 ${width}px 完整显示`,
    )
    await screenshot(`ux-release-selection-${width}.png`)
    await clickText('确认回退')
    await visible('[role=alertdialog]')
    assert.equal(
      await evaluate(`document.querySelector('[data-confirm-action]').textContent.trim()`),
      '确认回退',
    )
    assert.equal(
      await evaluate(`document.querySelectorAll('[data-confirmation-details] dt').length`),
      8,
    )
    assert.equal(
      await evaluate(
        `document.querySelector('[role=alertdialog]').scrollWidth <= document.querySelector('[role=alertdialog]').clientWidth + 1`,
      ),
      true,
      `回退确认在 ${width}px 不溢出`,
    )
    await screenshot(`ux-rollback-confirmation-${width}.png`)
    await clickText('取消', '[role=alertdialog]')
    await until(
      () => evaluate(`document.activeElement.id === 'confirm-release'`),
      '关闭回退确认后焦点返回操作按钮',
    )
    await go('tasks', `?environment=${firstTarget.environmentId}&task=${pinned.id}`)
    await visible('#deploy-task-logs')
    await clickText('完整日志', '#task-workbench')
    await fill('[aria-label="搜索日志"]', '编译')
    assert.equal(
      await evaluate('document.documentElement.scrollWidth <= innerWidth'),
      true,
      `日志检索 ${width}px`,
    )
    await evaluate(`document.querySelector('.task-log-card').scrollIntoView({block:'center'})`)
    await screenshot(`ux-log-search-${width}.png`)
    await go(
      'service',
      `?environment=${firstTarget.environmentId}&target=${firstTarget.id}&tab=config`,
    )
    await visible('.configuration-stack')
    await clickText('编辑部署配置')
    await visible('#health-check-preview')
    assert.equal(
      await evaluate('document.documentElement.scrollWidth <= innerWidth'),
      true,
      `健康检查配置 ${width}px`,
    )
    assert.equal(
      await evaluate(`document.querySelector('#deploy-healthStatus').getClientRects().length`),
      0,
    )
    await evaluate(
      `document.querySelector('#health-check-preview').scrollIntoView({block:'center'})`,
    )
    await screenshot(`ux-health-${width}.png`)
    await go('setup')
    await visible('[data-service-setup]')
    assert.equal(
      await evaluate('document.documentElement.scrollWidth <= innerWidth'),
      true,
      `分步配置在 ${width}px 不溢出`,
    )
    await screenshot(`ux-setup-${width}.png`)
  }
  await go('services')
  await visible(`[data-service-id="${apiService.id}"]`)
  await clickText('选择部署位置', `[data-service-id="${apiService.id}"]`)
  await service.store.change((state) => {
    state.deployments.servers.find((s) => s.id === firstAgent.serverId).lastSeenAt = new Date(
      Date.now() - 120000,
    ).toISOString()
  })
  deployment.changed('heartbeat', firstAgent.serverId)
  await until(
    () =>
      evaluate(
        `(${query(`[data-target-id="${firstTarget.id}"]`)}).textContent.includes('状态待确认')`,
      ),
    '失联状态',
  )
  await go('overview')
  await visible('[data-overview=\"repositories\"]')
  assert.equal(
    await evaluate(`!!document.querySelector('[data-onboarding]')`),
    false,
    '接入完成后自动收起引导',
  )

  // 全局撤销记录可以删除，项目解绑不影响共享服务器身份。
  await click('[data-view=system-servers]')
  const disposable = await deployment.createServer({ name: '临时验收待删除' })
  await deployment.revokeServer(disposable.server.id)
  await visible(`[data-server-id="${disposable.server.id}"]`)
  await menu(`[data-server-id="${disposable.server.id}"]`, '删除记录')
  await visible('[role=alertdialog]')
  await clickText('取消', '[role=alertdialog]')
  assert.ok(deployment.data.servers.some((s) => s.id === disposable.server.id))
  await menu(`[data-server-id="${disposable.server.id}"]`, '删除记录')
  await click('[data-confirm-action]')
  await until(
    () => !deployment.data.servers.some((s) => s.id === disposable.server.id),
    '删除临时记录',
  )
  const another = await workspaces.create({ name: '办公项目' })
  // 旧项目的迟到响应不能覆盖切换后的项目内容。
  await evaluate(
    `window.originalWorkspaceFetch = window.fetch; window.delayOldWorkspace = true; window.fetch = async (...args) => { const response = await window.originalWorkspaceFetch(...args); if (window.delayOldWorkspace && String(args[0]) === '/api/workspaces/${initialProject.id}') { window.delayOldWorkspace = false; window.oldWorkspaceResponsePending = true; await new Promise(resolve => { window.releaseOldWorkspaceResponse = resolve; }); } return response; }; location.hash = '/projects/${initialProject.id}/overview';`,
  )
  await until(() => evaluate('window.oldWorkspaceResponsePending'), '延迟旧项目响应')
  await evaluate(`location.hash = '/projects/${another.id}/overview'`)
  await until(
    () => evaluate('document.querySelector("#workspace-name")?.textContent === "办公项目"'),
    '切换第二项目',
  )
  await evaluate(
    'window.releaseOldWorkspaceResponse(); window.fetch = window.originalWorkspaceFetch',
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(await evaluate('document.querySelector("#workspace-name").textContent'), '办公项目')
  assert.equal(
    await evaluate('document.querySelector("#deploy-view").textContent.includes("API 服务")'),
    false,
  )

  await evaluate(`location.hash='/projects/${another.id}/servers'`)
  await visible('.bind-server')
  await click('.bind-server')
  await choose('#deploy-serverId', '测试服务器 B · 在线')
  await submit()
  await visible(`[data-server-id="${secondAgent.serverId}"]`)
  assert.equal(workspaces.overview(another.id).targets.length, 0)
  await clickText('解除绑定', `[data-server-id="${secondAgent.serverId}"]`)
  await click('[data-confirm-action]')
  await until(() => !workspaces.overview(another.id).servers.length, '解除绑定')
  assert.equal(deployment.authenticate(secondAgent.token), secondAgent.serverId)
  assert.equal(await evaluate(`document.body.textContent.includes('仅监控')`), false)
  assert.deepEqual(errors, [])
  assert.ok(
    !warnings.some((w) => /Content Security Policy|Refused to/.test(w)),
    warnings.join('\n'),
  )
  console.log(
    '控制台浏览器验证通过：接入清单、分步保存、未保存保护、多位置发布、重启、回退、失败状态、静态发布、日志、快照、旧地址、筛选分页、五种屏幕宽度、等高首页分页及共享服务器操作。',
  )
  console.log(`截图目录：${artifactDirectory}`)
} catch (error) {
  console.error('浏览器异常：', errors)
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(
        JSON.stringify({
          id: 999999,
          method: 'Runtime.evaluate',
          params: { expression: 'document.body.innerText' },
        }),
      )
    } catch {}
  }
  throw error
} finally {
  socket?.close()
  browser.kill()
  await new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  })
  await deployment.close()
  await service.store.close()
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (
    path.dirname(temporary) === path.resolve(os.tmpdir()) &&
    path.basename(temporary).startsWith('cmr-deploy-browser-')
  )
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
