import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startBrowser, until } from './helpers/prototype-browser.mjs'

// 仅在具体演示账号登录已获授权后执行。键入和控制操作使用真实 CDP 输入，不改业务状态。
assert(process.env.AGENT_DEMO_URL, '请设置已授权测试站点 AGENT_DEMO_URL')
assert(process.env.AGENT_DEMO_TEST_PASSWORD, '请注入已获授权的演示账号密码')
process.env.PROTOTYPE_URL = process.env.AGENT_DEMO_URL
const output = path.resolve('.test-artifacts/agent-demo-feedback')
await mkdir(output, { recursive: true })
const report = {
  testedAt: new Date().toISOString(),
  url: process.env.AGENT_DEMO_URL,
  mode: 'scenario',
  realModelCalls: 0,
  targetP95Ms: 100,
  plannedAttemptsPerAction: 20,
  samples: [],
  failures: [],
  cleanupErrors: [],
  methodology: [
    '起点为捕获阶段收到的真实 DOM click 事件，记录 isTrusted；不包含点击前定位与滚动等待。',
    '终点为点击后的 requestAnimationFrame 中仍可见的该按钮 pending 信号，或可唯一关联的成功结果。',
    'pending 与 accepted/final 分开计数；回执快到 pending 未到绘制帧时，不排除最快的成功反馈。',
    '成功结果按会话、唯一输入标记、相同 turnId/queueId/questionId 关联；无关 DOM 变化不参与计时。',
    '仅观察真实 fetch Promise 与响应副本，不改变响应、请求、时序或业务状态；回执与终态单独记录。',
    'API 只建立私有会话、启动 hold/clarify 和清理；五类受测控件均通过真实 CDP 输入与鼠标点击。',
    '这是桌面 Chrome 下一动画帧的可见 DOM 近似，不是硬件实际绘制或手机软键盘测量。',
  ],
}
let browser
let csrf
const created = []
let scenarioProject
let scenarioAgent

function installFeedbackProbe() {
  const round = (n) => Math.round(n * 1000) / 1000
  const visible = (node) => {
    if (!node?.isConnected || !node.getClientRects().length) return false
    const rect = node.getBoundingClientRect()
    let left = Math.max(0, rect.left)
    let right = Math.min(innerWidth, rect.right)
    let top = Math.max(0, rect.top)
    let bottom = Math.min(innerHeight, rect.bottom)
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
        return false
      if (parent !== node && /(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowY)) {
        const bounds = parent.getBoundingClientRect()
        left = Math.max(left, bounds.left)
        right = Math.min(right, bounds.right)
        top = Math.max(top, bounds.top)
        bottom = Math.min(bottom, bounds.bottom)
      }
    }
    return right > left && bottom > top
  }
  const state = { active: null, samples: [], longTasks: [] }
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      state.longTasks.push({ startTime: entry.startTime, duration: entry.duration })
  }).observe({ type: 'longtask', buffered: true })
  const successSignal = (sample) => {
    const root = document.querySelector('.workbench-demo-chat')
    if (root?.dataset.conversationId !== sample.conversationId) return null
    if (sample.action === 'queue') {
      const row = Array.from(root.querySelectorAll('.workbench-demo-queue-item')).find(
        (node) => node.querySelector('.workbench-demo-queue-text p')?.textContent === sample.marker,
      )
      return row && visible(row.querySelector('.workbench-demo-queue-text p'))
        ? {
            signalKind: 'accepted',
            selector: `.workbench-demo-queue-item[data-queue-id="${row.dataset.queueId}"]`,
            queueId: row.dataset.queueId,
            visibleText: sample.marker,
          }
        : null
    }
    if (sample.action === 'stop') {
      const row = root.querySelector(
        `.workbench-demo-message.is-assistant[data-turn-id="${sample.expectedTurnId}"]`,
      )
      const status = row?.querySelector('.workbench-demo-message-state')
      return row?.dataset.status === 'interrupted' &&
        status?.textContent.includes('已停止') &&
        visible(status)
        ? {
            signalKind: 'final',
            selector: `.workbench-demo-message.is-assistant[data-turn-id="${sample.expectedTurnId}"] .workbench-demo-message-state`,
            turnId: sample.expectedTurnId,
            visibleText: status.textContent,
          }
        : null
    }
    const row = Array.from(root.querySelectorAll('.workbench-demo-message.is-user')).find(
      (node) => {
        const body = node.querySelector('.workbench-demo-message-body')
        return (
          body?.textContent.trim() === sample.marker &&
          (!sample.expectedTurnId || node.dataset.turnId === sample.expectedTurnId) &&
          (sample.action !== 'steer' ||
            node.querySelector('.workbench-demo-message-kind')?.textContent === '本轮引导') &&
          (sample.action !== 'answer' ||
            node.querySelector('.workbench-demo-message-kind')?.textContent === '补充回答')
        )
      },
    )
    return row && visible(row.querySelector('.workbench-demo-message-body'))
      ? {
          signalKind: 'accepted',
          selector: `.workbench-demo-message[data-message-id="${row.dataset.messageId}"] .workbench-demo-message-body`,
          turnId: row.dataset.turnId,
          messageId: row.dataset.messageId,
          visibleText: sample.marker,
        }
      : null
  }
  const pendingSignal = (sample) => {
    const button = sample.button
    if (!button?.disabled || !visible(button)) return null
    if (['send', 'steer', 'queue'].includes(sample.action)) {
      const status = document.querySelector('.workbench-demo-composer-meta span')
      if (status?.textContent !== '等待服务器确认…' || !visible(status)) return null
      return {
        signalKind: 'pending',
        selector: `${sample.buttonSelector}:disabled`,
        statusSelector: '.workbench-demo-composer-meta > span:first-child',
        visibleText: status.textContent,
        disabled: true,
      }
    }
    if (!button.querySelector('.workbench-demo-spin')) return null
    return {
      signalKind: 'pending',
      selector: `${sample.buttonSelector}:disabled .workbench-demo-spin`,
      visibleText: button.textContent || button.getAttribute('aria-label'),
      disabled: true,
    }
  }
  const matchRequest = (sample, url, method, body) => {
    if (!sample?.clickAt || sample.done || method !== 'POST') return false
    const pathname = new URL(url, location.href).pathname
    if (pathname !== sample.requestPath) return false
    if (['send', 'steer', 'queue'].includes(sample.action))
      return body.text === sample.marker && body.delivery === sample.action
    if (sample.action === 'answer')
      return body.answer === sample.marker && body.expectedTurnId === sample.expectedTurnId
    return body.expectedTurnId === sample.expectedTurnId
  }
  const extractOutcome = (sample, body) => {
    const conversation = body.conversation
    if (conversation?.id !== sample.conversationId) return { verified: false }
    const turn = conversation.turns.find((item) => item.id === sample.expectedTurnId)
    if (sample.action === 'stop')
      return {
        verified: turn?.status === 'interrupted' && conversation.queuePaused === true,
        turnId: turn?.id,
        status: turn?.status,
        queuePaused: conversation.queuePaused,
      }
    if (sample.action === 'queue') {
      const queued = conversation.queue.find((item) => item.text === sample.marker)
      return {
        verified: Boolean(queued && queued.id === body.receipt?.id),
        queueId: queued?.id,
        status: body.receipt?.status,
      }
    }
    const message = conversation.messages.find((item) => item.content === sample.marker)
    return {
      verified: Boolean(
        message &&
        (!sample.expectedTurnId || message.turnId === sample.expectedTurnId) &&
        (sample.action !== 'answer' ||
          (turn?.question?.id === sample.questionId && turn.question.status === 'answered')),
      ),
      messageId: message?.id,
      turnId: message?.turnId,
      status: message?.status,
      questionStatus: sample.action === 'answer' ? turn?.question?.status : undefined,
    }
  }
  const nativeFetch = window.fetch
  window.fetch = function (...args) {
    const started = performance.now()
    const promise = nativeFetch.apply(this, args)
    const sample = state.active
    let body
    try {
      body = JSON.parse(args[1]?.body || '{}')
    } catch {
      return promise
    }
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url
    if (!matchRequest(sample, url, args[1]?.method || 'GET', body)) return promise
    sample.requestId = body.requestId
    sample.requestStartMs = round(started - sample.clickAt)
    promise.then(
      (response) => {
        sample.server = {
          status: response.status,
          headersMs: round(performance.now() - sample.clickAt),
        }
        response
          .clone()
          .json()
          .then(
            (value) => {
              sample.server.bodyMs = round(performance.now() - sample.clickAt)
              sample.server.outcome = extractOutcome(sample, value)
              sample.server.errorCode = value.code || null
              sample.ackComplete = true
            },
            (error) => {
              sample.server.error = error.message
              sample.ackComplete = true
            },
          )
      },
      (error) => {
        sample.server = {
          error: error.message,
          failedMs: round(performance.now() - sample.clickAt),
        }
        sample.ackComplete = true
      },
    )
    return promise
  }
  document.addEventListener(
    'click',
    (event) => {
      const sample = state.active
      const button = sample && event.target.closest(sample.buttonSelector)
      if (!sample || sample.clickAt || !button) return
      sample.clickAt = performance.now()
      sample.clickEventTimestamp = event.timeStamp
      sample.trustedClick = event.isTrusted
      sample.button = button
      const inspectFrame = (timestamp) => {
        const now = performance.now()
        const elapsed = now - sample.clickAt
        sample.framesObserved = (sample.framesObserved || 0) + 1
        const pending = pendingSignal(sample)
        const accepted = successSignal(sample)
        if (!sample.feedback && (pending || accepted)) {
          sample.feedback = {
            ...(pending || accepted),
            ms: round(elapsed),
            frameTimestamp: timestamp,
          }
        }
        if (!sample.resultFrame && accepted)
          sample.resultFrame = { ...accepted, ms: round(elapsed), frameTimestamp: timestamp }
        if (elapsed >= 5000) {
          sample.feedbackTimeout = !sample.feedback
          sample.ackTimeout = !sample.ackComplete
          sample.done = true
          return
        }
        if (sample.feedback && sample.ackComplete) {
          sample.done = true
          return
        }
        requestAnimationFrame(inspectFrame)
      }
      requestAnimationFrame(inspectFrame)
    },
    true,
  )
  window.__agentDemoFeedback = {
    arm(spec) {
      if (state.active && !state.active.done) throw new Error('上一条反馈采样尚未结束')
      state.active = { ...spec, armedAt: performance.now() }
      state.samples.push(state.active)
    },
    current() {
      if (!state.active) return null
      const { button, ...value } = state.active
      return value
    },
    collect() {
      return {
        samples: state.samples.map(({ button, ...value }) => value),
        longTasks: state.longTasks,
      }
    },
  }
}

async function api(endpoint, method = 'GET', body) {
  const value = await browser.evaluate(`(async()=>{
    const response=await fetch('/api/agent-demo'+${JSON.stringify(endpoint)},{
      method:${JSON.stringify(method)},credentials:'same-origin',
      headers:{'Content-Type':'application/json','X-Demo-CSRF':${JSON.stringify(csrf || '')}},
      ${body === undefined ? '' : `body:JSON.stringify(${JSON.stringify(body)}),`}
    });return {status:response.status,data:await response.json()};
  })()`)
  assert(value.status >= 200 && value.status < 300, JSON.stringify(value))
  return value.data
}
async function type(selector, text) {
  await browser.click(selector)
  await browser.command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: 4,
  })
  await browser.command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: 4,
  })
  await browser.command('Input.insertText', { text })
  await until(
    () =>
      browser.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(text)}`,
      ),
    '真实输入值已更新',
  )
}
async function stopSetup(conversationId) {
  const current = (await api(`/conversations/${conversationId}`)).conversation
  if (current.activeTurnId) {
    await api(`/conversations/${conversationId}/stop`, 'POST', {
      requestId: randomUUID(),
      expectedTurnId: current.activeTurnId,
    })
  }
}
async function controlled(conversationId, kind) {
  const result = await api(`/conversations/${conversationId}/messages`, 'POST', {
    requestId: randomUUID(),
    text: `反馈采样 setup ${kind}`,
    attachmentIds: [],
    delivery: 'send',
    scenario: { kind, stepDelayMs: 10 },
  })
  const turnId = result.receipt.turnId
  await until(
    () => browser.evaluate(`Boolean(document.querySelector('[data-turn-id="${turnId}"]'))`),
    '受控轮次已由真实SSE显示',
  )
  return turnId
}
async function measure(action, conversationId, index, options = {}) {
  const labels = {
    send: '发送',
    steer: '引导当前执行',
    queue: '排队到下一轮',
    stop: '停止生成',
  }
  const marker = action === 'stop' ? null : `反馈测量 ${action} ${index} ${randomUUID()}`
  const selector =
    action === 'answer' ? '.workbench-demo-question > button' : `[aria-label="${labels[action]}"]`
  if (action !== 'stop')
    await type(action === 'answer' ? '[aria-label="澄清回答"]' : '[aria-label="输入问题"]', marker)
  const suffix =
    action === 'stop'
      ? '/stop'
      : action === 'answer'
        ? `/questions/${options.questionId}`
        : '/messages'
  const spec = {
    action,
    attempt: index,
    conversationId,
    marker,
    buttonSelector: selector,
    requestPath: `/api/agent-demo/conversations/${conversationId}${suffix}`,
    ...options,
    version: report.version,
  }
  await browser.evaluate(`window.__agentDemoFeedback.arm(${JSON.stringify(spec)})`)
  await browser.click(selector)
  await until(
    () => browser.evaluate('window.__agentDemoFeedback.current()?.done'),
    `${action}对应反馈和回执`,
  )
  const sample = await browser.evaluate('window.__agentDemoFeedback.current()')
  report.samples.push(sample)
  console.log(
    `${index} ${action}: ${sample.feedback?.signalKind || '不可归因'} ${sample.feedback?.ms ?? '-'}ms; ack ${sample.server?.bodyMs ?? '-'}ms`,
  )
  assert(sample.trustedClick, '必须由真实浏览器鼠标事件触发')
  assert(sample.server?.outcome?.verified, `${action}真实服务器结果未通过关联核对`)
  return sample
}
const distribution = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const at = (percentile) => sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? null
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null }
}

try {
  browser = await startBrowser('agent-demo-feedback')
  await browser.viewport(1280, 900)
  await type('[aria-label="用户名"]', 'admin')
  await type('[aria-label="密码"]', process.env.AGENT_DEMO_TEST_PASSWORD)
  await browser.clickText('登录')
  await browser.visible('[aria-label="账号菜单"]')
  const bootstrap = await api('/bootstrap')
  csrf = bootstrap.csrf
  scenarioProject = bootstrap.projects[0]
  scenarioAgent = bootstrap.agents.find(
    (agent) =>
      agent.projectIds.includes(scenarioProject.id) && agent.capabilities.includes('steer'),
  )
  assert(scenarioAgent, '需要支持同轮引导的演示Agent')
  report.version = {
    scripts: await browser.evaluate('Array.from(document.scripts).map(n=>n.src).filter(Boolean)'),
    stylesheets: await browser.evaluate(
      `Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(n=>n.href)`,
    ),
    health: await api('/health'),
  }
  await browser.evaluate(`(${installFeedbackProbe.toString()})()`)
  for (let index = 1; index <= report.plannedAttemptsPerAction; index++) {
    const createdConversation = await api('/conversations', 'POST', {
      title: `反馈定向测量 ${index} ${randomUUID().slice(0, 8)}`,
      projectId: scenarioProject.id,
      environmentId: scenarioProject.environments[0].id,
      agentId: scenarioAgent.id,
      visibility: 'private',
      mode: 'scenario',
    })
    const conversationId = createdConversation.conversation.id
    created.push(conversationId)
    await browser.evaluate(`location.hash='conversation='+${JSON.stringify(conversationId)}`)
    await until(
      () =>
        browser.evaluate(
          `document.querySelector('.workbench-demo-chat')?.dataset.conversationId===${JSON.stringify(conversationId)}`,
        ),
      '测量会话已选中',
    )
    await measure('send', conversationId, index)
    await stopSetup(conversationId)
    const heldTurn = await controlled(conversationId, 'hold')
    await measure('steer', conversationId, index, { expectedTurnId: heldTurn })
    await measure('queue', conversationId, index, { expectedTurnId: heldTurn })
    await measure('stop', conversationId, index, { expectedTurnId: heldTurn })
    const questionTurn = await controlled(conversationId, 'clarify')
    await browser.visible('.workbench-demo-question')
    const questionId = await browser.evaluate(
      `document.querySelector('.workbench-demo-question').dataset.questionId`,
    )
    await measure('answer', conversationId, index, { expectedTurnId: questionTurn, questionId })
    await stopSetup(conversationId)
    await api(`/conversations/${conversationId}`, 'DELETE')
  }
} catch (error) {
  report.failures.push({ error: error.stack })
  if (browser) {
    const image = await browser
      .command('Page.captureScreenshot', { format: 'png' })
      .catch(() => null)
    if (image) await writeFile(path.join(output, 'failure.png'), Buffer.from(image.data, 'base64'))
  }
} finally {
  if (browser) {
    const raw = await browser.evaluate('window.__agentDemoFeedback?.collect()').catch(() => null)
    if (raw) {
      report.samples = raw.samples
      report.longTasks = raw.longTasks
    }
    for (const conversationId of created) {
      try {
        const response = await browser.evaluate(
          `fetch('/api/agent-demo/conversations/'+${JSON.stringify(conversationId)}).then(r=>r.status)`,
        )
        if (response === 404) continue
        await stopSetup(conversationId)
        await api(`/conversations/${conversationId}`, 'DELETE')
      } catch (error) {
        report.cleanupErrors.push({ conversationId, error: error.message })
      }
    }
    report.runtimeErrors = browser.errors
    report.browserWarnings = browser.warnings
    await browser.close()
  }
  report.summary = Object.fromEntries(
    ['send', 'steer', 'queue', 'stop', 'answer'].map((action) => {
      const samples = report.samples.filter((sample) => sample.action === action)
      return [
        action,
        {
          attempts: samples.length,
          feedback: distribution(samples.map((sample) => sample.feedback?.ms)),
          pending: distribution(
            samples
              .filter((sample) => sample.feedback?.signalKind === 'pending')
              .map((s) => s.feedback.ms),
          ),
          acceptedOrFinal: distribution(
            samples
              .filter((sample) => ['accepted', 'final'].includes(sample.feedback?.signalKind))
              .map((s) => s.feedback.ms),
          ),
          serverHeaders: distribution(samples.map((sample) => sample.server?.headersMs)),
          serverBody: distribution(samples.map((sample) => sample.server?.bodyMs)),
          unobservable: samples.filter((sample) => !sample.feedback).length,
          over100ms: samples.filter((sample) => sample.feedback?.ms > report.targetP95Ms).length,
          verifiedServerOutcomes: samples.filter((sample) => sample.server?.outcome?.verified)
            .length,
        },
      ]
    }),
  )
  report.passed =
    report.failures.length === 0 &&
    report.cleanupErrors.length === 0 &&
    !report.runtimeErrors?.length &&
    Object.values(report.summary).every(
      (summary) =>
        summary.attempts === report.plannedAttemptsPerAction &&
        summary.feedback.n === report.plannedAttemptsPerAction &&
        summary.feedback.p95 <= report.targetP95Ms &&
        summary.verifiedServerOutcomes === report.plannedAttemptsPerAction,
    )
  report.completedAt = new Date().toISOString()
  report.testSha256 = createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex')
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify(
      { passed: report.passed, report: path.join(output, 'report.json'), summary: report.summary },
      null,
      2,
    ),
  )
}
if (!report.passed) process.exitCode = 1
