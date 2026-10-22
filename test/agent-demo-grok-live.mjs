import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

// 这是会产生真实模型费用的显式验收入口。仅直接调用已配置桥接，不登录 Demo。
// AGENT_DEMO_LIVE_TEST=1
// BRIDGE_URL=http://127.0.0.1:8791
// TOKEN_FILE=/安全目录/bridge-token（当前用户所有、普通文件、0600/0400）
// 也接受 AGENT_DEMO_BRIDGE_URL / AGENT_DEMO_BRIDGE_TOKEN_FILE。
// 不读取提供方 API key、不搜索其他会话、不启动/部署运行器、不使用场景替身。
if (process.env.AGENT_DEMO_LIVE_TEST !== '1') {
  console.error('未执行：真实验收必须显式设置 AGENT_DEMO_LIVE_TEST=1、BRIDGE_URL 和 TOKEN_FILE。')
  process.exit(2)
}

const rawUrl = process.env.AGENT_DEMO_BRIDGE_URL || process.env.BRIDGE_URL
const tokenFile = process.env.AGENT_DEMO_BRIDGE_TOKEN_FILE || process.env.TOKEN_FILE
assert(rawUrl && tokenFile, '必须显式提供 BRIDGE_URL 和 TOKEN_FILE，不能使用内嵌令牌')
const bridgeUrl = new URL(rawUrl)
assert(
  ['http:', 'https:'].includes(bridgeUrl.protocol) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(bridgeUrl.hostname) &&
    !bridgeUrl.username &&
    !bridgeUrl.password &&
    !bridgeUrl.search &&
    !bridgeUrl.hash &&
    bridgeUrl.pathname === '/',
  'BRIDGE_URL 必须是无凭据、无查询串的回环桥接根地址；远端桥接请使用已授权端口转发',
)
const base = bridgeUrl.origin
const timeoutMs = Number(process.env.AGENT_DEMO_LIVE_TIMEOUT_MS || 120_000)
assert(Number.isInteger(timeoutMs) && timeoutMs >= 30_000 && timeoutMs <= 180_000)
const testId = `grok-live-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const directory = path.resolve(
  process.env.AGENT_DEMO_LIVE_EVIDENCE_DIR || '.test-artifacts/agent-demo-grok-live',
  testId,
)
const reportPath = path.join(directory, 'report.json')
const TERMINAL = new Set(['completed', 'failed', 'interrupted'])
const ALLOWED_TOOLS = new Set([
  'list_project_materials',
  'read_project_document',
  'read_attachment',
  'query_environment',
  'ask_user',
  'create_report',
])
const report = {
  testId,
  startedAt: new Date().toISOString(),
  mode: 'real-provider-bridge',
  requestedProvider: 'cpa',
  requestedModelFamily: 'grok',
  bridge: base,
  nodeVersion: process.version,
  maxRuns: 3,
  runTimeoutMs: timeoutMs,
  runRequestsAccepted: 0,
  providerModelRequestCount: null,
  credentialsEnteredInUI: false,
  demoLoginPerformed: false,
  providerKeyReadByThisScript: false,
  checks: [],
  requests: [],
  runs: [],
  boundary: [
    '三个独立真实 run；工具往返可能产生多次提供方请求，本脚本不虚报模型调用或 token 总数。',
    '仅合成资料、文本附件和明确标识的演示环境快照，不读取生产资源。',
    '首段正文延迟从 POST /runs 发出到客户端收到首个非空 delta，包含工具等待与传输。',
    '同轮引导要求 started、steer 回执与终态的 runnerTurnId 一致，并检查最终文本实际采纳标记。',
    '停止检查客户端收到 HTTP 回执后没有新到达正文，并等待 interrupted；HTTP accepted 本身不等于终态。',
    '只对白名单业务工具的实际可见调用作断言，不据此证明底层文件、网络、命令隔离或所有越权边界。',
    '不覆盖 WebUI、登录、权限、服务端队列、图片/PDF附件、五会话并发或用户主观体验。',
  ],
}
let token = ''
let tokenHandle
const liveRuns = []
const round = (value) => Math.round(value * 1000) / 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nonce = () => randomUUID().replaceAll('-', '')
const newRequestId = () => `request_${randomUUID()}`

function sanitize(value) {
  if (typeof value === 'string') {
    return (token ? value.replaceAll(token, '[REDACTED]') : value)
      .replaceAll(tokenFile, '[TOKEN_FILE]')
      .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
  }
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|cookie|password|token|apiKey|api_key|secret)$/i.test(key)
          ? '[REDACTED]'
          : sanitize(item),
      ]),
    )
  }
  return value
}

function errorRecord(error) {
  return sanitize({ name: error?.name || 'Error', message: String(error?.message || error) })
}

async function save() {
  await writeFile(reportPath, JSON.stringify(sanitize(report), null, 2), { mode: 0o600 })
}

async function request(route, body, run) {
  const start = performance.now()
  const entry = { method: body === undefined ? 'GET' : 'POST', route }
  if (run) entry.runId = run.runId
  try {
    const response = await fetch(base + route, {
      method: entry.method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(35_000),
    })
    const text = await response.text()
    assert(text.length <= 1024 * 1024, '桥接 JSON 响应超过验收限额')
    entry.status = response.status
    entry.ms = round(performance.now() - start)
    const value = JSON.parse(text)
    entry.response = sanitize(value)
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${value.code || 'BRIDGE_ERROR'}`)
    return { value, status: response.status, elapsedMs: entry.ms }
  } catch (error) {
    entry.ms ??= round(performance.now() - start)
    entry.error = errorRecord(error)
    throw error
  } finally {
    report.requests.push(entry)
  }
}

class LiveRun {
  constructor(name, prompt) {
    this.runId = `${testId}_${name}`
    this.name = name
    this.started = performance.now()
    this.deadline = this.started + timeoutMs
    this.events = []
    this.records = []
    this.errors = []
    this.chunks = 0
    this.bytes = 0
    this.closed = false
    this.abort = new AbortController()
    this.documentMarker = `DOC_${nonce()}`
    this.attachmentMarker = `ATTACHMENT_${nonce()}`
    this.snapshotMarker = `SNAPSHOT_${nonce()}`
    this.observedAt = '2026-10-21T00:00:00.000Z'
    this.input = {
      runId: this.runId,
      prompt,
      context: {
        projectId: 'p_live_acceptance',
        projectName: '合成验收项目',
        environmentId: 'env_live_fixture',
        environmentName: '合成测试环境',
        observedAt: this.observedAt,
        documents: [
          {
            id: 'doc_live_note',
            name: '项目说明.txt',
            content: `这是合成资料。文档校验标记：${this.documentMarker}。告警阈值为 30。`,
          },
        ],
        resources: [{ id: 'fixture_service', name: '合成服务', type: 'service' }],
        resourceSnapshot: {
          kind: 'fixture',
          marker: this.snapshotMarker,
          observedValue: 37,
          notice: '验收夹具，非生产实时观测',
        },
      },
      history: [],
      attachments: [
        {
          id: 'attachment_live_note',
          name: '补充说明.txt',
          mime: 'text/plain',
          content: `这是合成文本附件。附件校验标记：${this.attachmentMarker}。建议只读复核。`,
        },
      ],
    }
    this.evidence = { name, runId: this.runId, input: this.input, events: this.records, checks: [] }
    report.runs.push(this.evidence)
    liveRuns.push(this)
  }

  get terminal() {
    return this.events.find((event) => TERMINAL.has(event.type))
  }
  get identity() {
    return this.events.find((event) => event.type === 'started')?.payload
  }
  get text() {
    return this.events
      .filter((event) => event.type === 'delta')
      .map((event) => event.payload.text)
      .join('')
  }
  async begin() {
    const accepted = await request('/runs', this.input, this)
    assert.equal(accepted.status, 202, '独立 runId 应创建新轮次')
    assert.equal(accepted.value.runId, this.runId)
    this.accepted = true
    report.runRequestsAccepted++
    this.evidence.acceptanceMs = accepted.elapsedMs
    this.stream = this.consume().catch((error) => this.errors.push(errorRecord(error)))
  }
  async consume() {
    const timer = setTimeout(() => this.abort.abort(), timeoutMs + 20_000)
    try {
      const response = await fetch(base + `/runs/${this.runId}/events`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: this.abort.signal,
      })
      assert.equal(response.status, 200, '真实事件流必须成功连接')
      assert.match(response.headers.get('content-type') || '', /text\/event-stream/)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const consumeFrames = () => {
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const lines = frame.split('\n')
          const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (!data) continue
          const event = JSON.parse(data)
          const id = lines
            .find((line) => line.startsWith('id:'))
            ?.slice(3)
            .trim()
          assert.equal(event.runId, this.runId, '事件不得跨轮归属')
          assert.equal(event.seq, this.events.length + 1, '事件序号须连续且无重复')
          assert.equal(Number(id), event.seq, 'SSE id 应匹配事件序号')
          assert(!this.terminal, '终态之后不得追加事件')
          this.events.push(event)
          this.records.push({ receivedMs: round(performance.now() - this.started), event })
        }
      }
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        this.chunks++
        this.bytes += chunk.value.length
        assert(this.bytes <= 4 * 1024 * 1024, '小请求事件超过 4MiB，停止验收')
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replaceAll('\r\n', '\n')
        consumeFrames()
      }
      buffer += decoder.decode()
      consumeFrames()
      assert(!buffer.trim(), '事件流以不完整 frame 结束')
      assert(this.terminal, '事件流结束但没有终态')
    } finally {
      clearTimeout(timer)
      this.closed = true
    }
  }
  async waitFor(label, predicate, limitMs) {
    const deadline = Math.min(this.deadline, performance.now() + (limitMs ?? timeoutMs))
    while (performance.now() < deadline) {
      if (this.errors.length) throw new Error(`SSE 错误：${this.errors[0].message}`)
      const value = predicate()
      if (value) return value
      if (this.terminal) throw new Error(`${label} 未出现，轮次已 ${this.terminal.type}`)
      if (this.closed) throw new Error(`${label} 未出现，事件流已关闭`)
      await sleep(15)
    }
    throw new Error(`${label} 超时（本轮上限 ${timeoutMs}ms）`)
  }
  async control(action, body) {
    return request(`/runs/${this.runId}/${action}`, { requestId: newRequestId(), ...body }, this)
  }
  check(name, validate) {
    try {
      validate()
      this.evidence.checks.push({ name, passed: true })
    } catch (error) {
      this.evidence.checks.push({ name, passed: false, error: errorRecord(error) })
    }
  }
  validateCommon(expectedStatus) {
    this.check('唯一 started 与终态保持同一运行器身份', () => {
      assert.equal(this.events.filter((event) => event.type === 'started').length, 1)
      assert(this.identity?.runnerThreadId && this.identity?.runnerTurnId)
      assert.equal(this.terminal?.type, expectedStatus)
      assert.equal(this.terminal.payload.runnerThreadId, this.identity.runnerThreadId)
      assert.equal(this.terminal.payload.runnerTurnId, this.identity.runnerTurnId)
    })
    this.check('可见业务工具全部在白名单内且没有失败', () => {
      const tools = this.events.filter((event) => event.type === 'tool')
      assert(tools.length > 0)
      assert(tools.every((event) => ALLOWED_TOOLS.has(event.payload.name)))
      assert(!tools.some((event) => event.payload.status === 'failed'))
    })
    this.check('事件连接完整且无顺序/解析错误', () => assert.deepEqual(this.errors, []))
  }
  summarize() {
    const deltaRecords = this.records.filter(
      (record) => record.event.type === 'delta' && record.event.payload.text,
    )
    Object.assign(this.evidence, {
      elapsedMs: round(performance.now() - this.started),
      firstTextMs: deltaRecords[0]?.receivedMs ?? null,
      deltaCount: deltaRecords.length,
      streamChunks: this.chunks,
      streamBytes: this.bytes,
      runnerIdentity: this.identity ?? null,
      terminal: this.terminal ?? null,
      assistantText: this.text,
      transportErrors: this.errors,
    })
  }
  async cleanup() {
    if (this.accepted && !this.terminal) {
      try {
        const stopped = await this.control('stop', {
          ...(this.identity ? { expectedRunnerTurnId: this.identity.runnerTurnId } : {}),
        })
        this.evidence.cleanupStop = stopped.value
        const deadline = performance.now() + 10_000
        while (!this.terminal && !this.closed && performance.now() < deadline) await sleep(25)
        if (!this.terminal)
          this.evidence.cleanupError = '清理中未观察到终态；请按记录的独立 runId 核查桥接'
      } catch (error) {
        this.evidence.cleanupError = errorRecord(error)
      }
    }
    this.abort.abort()
    await this.stream
    this.summarize()
  }
}

async function scenario(name, prompt, verify) {
  const run = new LiveRun(name, prompt)
  await save()
  try {
    await run.begin()
    await verify(run)
    const closeDeadline = performance.now() + 3000
    while (!run.closed && performance.now() < closeDeadline) await sleep(15)
    assert(run.closed, '终态后 SSE 未结束')
  } catch (error) {
    run.evidence.checks.push({ name: '真实场景完成', passed: false, error: errorRecord(error) })
  } finally {
    await run.cleanup()
    run.evidence.passed =
      run.evidence.checks.length > 0 &&
      run.evidence.checks.every((check) => check.passed) &&
      !run.evidence.cleanupError &&
      !run.errors.length
    await save()
    console.log(
      JSON.stringify({
        name,
        passed: run.evidence.passed,
        runId: run.runId,
        firstTextMs: run.evidence.firstTextMs,
      }),
    )
  }
}

try {
  tokenHandle = await open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  const metadata = await tokenHandle.stat()
  assert(
    metadata.isFile() && metadata.size >= 32 && metadata.size <= 4096,
    'TOKEN_FILE 必须为小型普通令牌文件',
  )
  assert.equal(metadata.mode & 0o077, 0, 'TOKEN_FILE 不得向其他用户或组开放权限')
  if (process.getuid) assert.equal(metadata.uid, process.getuid(), 'TOKEN_FILE 必须归当前用户所有')
  token = (await tokenHandle.readFile('utf8')).trim()
  assert(token.length >= 32 && !/[\r\n\s]/.test(token), '令牌格式不合法')
  await tokenHandle.close()
  tokenHandle = null
  await mkdir(directory, { recursive: true, mode: 0o700 })
  report.testSha256 = createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex')
  report.localBridgeSourceSha256 = createHash('sha256')
    .update(await readFile(new URL('../agent-demo/codex-bridge.mjs', import.meta.url)))
    .digest('hex')
  report.localBridgeSourceHashIsDeploymentAttestation = false
  await save()
  const health = (await request('/health')).value
  report.initialHealth = health
  assert.equal(health.liveAvailable, true, '桥接尚不可用；不得改用模拟模式')
  assert.equal(health.provider, 'cpa', '必须连接用户选择的 CPA 提供方')
  assert.match(health.model || '', /grok/i, '必须使用已选择的 Grok 模型，不自动替换模型')
  assert(health.version && health.version !== 'not-started', '必须记录实际运行器版本')
  for (const capability of ['steer', 'interrupt', 'question', 'artifact'])
    assert.equal(health.capabilities?.[capability], true, `桥接缺少 ${capability} 能力`)

  await scenario(
    'materials_report',
    '这是小型真实工具验收。先调用 list_project_materials，再分别用 read_project_document 读取 doc_live_note、read_attachment 读取 attachment_live_note、query_environment 查询 env_live_fixture。必须真正调用这四个工具，不能猜正文。然后用 create_report 生成一个不超过300字的 Markdown 报告，包含文档、附件、快照中的三个完整校验标记，观测时间、数值37高于阈值30，以及“演示夹具，非实时观测”。最后用不超过120字的可见回答概括结论并引用已读文档和附件。不请求其他工具，不询问用户。',
    async (run) => {
      await run.waitFor('真实完成终态', () => run.terminal)
      run.validateCommon('completed')
      run.check('真实增量正文而非仅一个完整结果事件', () => {
        assert(
          run.events.filter((event) => event.type === 'delta' && event.payload.text).length >= 2,
        )
        assert(run.text.trim())
      })
      run.check('文档、附件和固定环境通过实际工具读取', () => {
        const completed = run.events.filter(
          (event) => event.type === 'tool' && event.payload.status === 'completed',
        )
        for (const name of [
          'list_project_materials',
          'read_project_document',
          'read_attachment',
          'query_environment',
          'create_report',
        ])
          assert(
            completed.some((event) => event.payload.name === name),
            `缺少 ${name} 成功轨迹`,
          )
        const doc = completed.find(
          (event) => event.payload.name === 'read_project_document',
        ).payload
        const attachment = completed.find(
          (event) => event.payload.name === 'read_attachment',
        ).payload
        const environment = completed.find(
          (event) => event.payload.name === 'query_environment',
        ).payload
        assert.equal(doc.input.id, 'doc_live_note')
        assert(doc.output.content.includes(run.documentMarker))
        assert.equal(attachment.input.id, 'attachment_live_note')
        assert(attachment.output.content.includes(run.attachmentMarker))
        assert.equal(environment.input.environmentId, 'env_live_fixture')
        assert.equal(environment.output.source, 'demo_fixture_snapshot')
        assert.equal(environment.output.resourceSnapshot.marker, run.snapshotMarker)
      })
      run.check('实际报告包含仅工具可见的随机内容与快照边界', () => {
        const artifacts = run.events.filter((event) => event.type === 'artifact')
        assert(artifacts.length > 0, '必须实际调用报告工具，不能仅口头声称生成报告')
        const content = artifacts.map((event) => event.payload.content).join('\n')
        for (const marker of [run.documentMarker, run.attachmentMarker, run.snapshotMarker])
          assert(content.includes(marker), `报告缺少 ${marker.split('_')[0]} 内容证据`)
        assert.match(content, /37/)
        assert.match(content, /30/)
        assert.match(content, /2026-10-21/)
        assert.match(content, /夹具/)
        assert.match(content, /非实时|不是.*实时|并非.*实时/)
      })
      run.check('引用对应已读取资料与附件的站内 URL', () => {
        assert(
          run.text.includes('/api/agent-demo/projects/p_live_acceptance/documents/doc_live_note'),
        )
        assert(run.text.includes('/api/agent-demo/files/attachment_live_note'))
      })
    },
  )

  await scenario(
    'question_steer',
    '这是同轮澄清验收。现在必须调用 ask_user，问题为“请选择分析范围”，选项为“当前测试环境”和“仅文档”；收到回答前等待，不要自行回答或结束。收到答案后按答案以及本轮随后收到的引导输出一行简短确认，保留答案和引导要求的完整校验标记，不创建报告，不调用其他工具。',
    async (run) => {
      const question = await run.waitFor('ask_user 问题', () =>
        run.events.find((event) => event.type === 'question'),
      )
      await run.waitFor('运行器轮次身份', () => run.identity)
      const steerMarker = `STEER_${nonce()}`
      const answerMarker = `ANSWER_${nonce()}`
      run.evidence.controlMarkers = { steerMarker, answerMarker }
      try {
        const steering = await run.control('steer', {
          expectedRunnerTurnId: run.identity.runnerTurnId,
          text: `本轮新增要求：最终确认必须包含完整标记 ${steerMarker}。继续等待刚才 ask_user 的回答，不取消、不另起轮次，也不要重复提问。`,
        })
        run.evidence.steerReceipt = steering
        run.check('等待澄清期间的 steer 回执保持相同 runnerTurnId', () => {
          assert.equal(steering.value.accepted, true)
          assert.equal(steering.value.runnerTurnId, run.identity.runnerTurnId)
        })
      } catch (error) {
        run.evidence.checks.push({
          name: '等待澄清期间的真实 steer',
          passed: false,
          error: errorRecord(error),
        })
      }
      const answer = await run.control('answer', {
        questionId: question.payload.id,
        answer: `当前测试环境。请保留答案校验标记 ${answerMarker}。`,
      })
      run.evidence.answerReceipt = answer
      assert.equal(answer.value.accepted, true)
      assert.equal(answer.value.questionId, question.payload.id)
      await run.waitFor('澄清与引导后的完成终态', () => run.terminal)
      run.validateCommon('completed')
      run.check('ask_user 工具收到真实答案并完成', () => {
        const asked = run.events.find(
          (event) =>
            event.type === 'tool' &&
            event.payload.name === 'ask_user' &&
            event.payload.status === 'completed',
        )
        assert(asked?.payload.output.answer.includes(answerMarker))
      })
      run.check('模型实际采纳本轮引导和用户回答', () => {
        assert(run.text.includes(steerMarker), '引导 HTTP 回执不替代模型采纳证据')
        assert(run.text.includes(answerMarker))
      })
    },
  )

  await scenario(
    'stream_stop',
    '这是流式停止验收。先仅调用 ask_user，问题为“开始输出停止测试文本吗？”，选项为“开始”；收到回答前等待。回答后不要再调用工具，立即连续输出80行很短的中文测试句，每行格式“第N行：这是合成停止测试文本，等待用户随时停止。”，只输出这些文本。',
    async (run) => {
      const question = await run.waitFor('停止测试前的澄清点', () =>
        run.events.find((event) => event.type === 'question'),
      )
      await run.waitFor('运行器轮次身份', () => run.identity)
      await run.control('answer', {
        questionId: question.payload.id,
        answer: '开始，请按要求立即输出。',
      })
      await run.waitFor('回答后的首段流式正文', () =>
        run.events.find(
          (event) => event.seq > question.seq && event.type === 'delta' && event.payload.text,
        ),
      )
      assert(!run.terminal, '停止前模型已结束；本轮不能证明执行中停止，保留失败而不重试加长任务')
      run.evidence.stopRequestedMs = round(performance.now() - run.started)
      const stopped = await run.control('stop', { expectedRunnerTurnId: run.identity.runnerTurnId })
      run.evidence.stopReceiptMs = round(performance.now() - run.started)
      run.evidence.stopReceiptEventSeq = run.events.length
      run.evidence.stopReceipt = stopped
      assert.equal(stopped.value.accepted, true)
      await run.waitFor('interrupted 真实终态', () => run.terminal)
      run.validateCommon('interrupted')
      run.check('停止 HTTP 回执后未收到新正文', () => {
        assert(
          !run.records.some(
            (record) =>
              record.event.seq > run.evidence.stopReceiptEventSeq && record.event.type === 'delta',
          ),
        )
        assert(run.text.trim(), '停止前已有正文必须保留')
      })
      await sleep(1000)
      const after = run.events.length
      const replayResponse = await fetch(base + `/runs/${run.runId}/events?after=${after}`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      })
      const replay = await replayResponse.text()
      run.evidence.postStopObservationMs = 1000
      run.evidence.postTerminalReplay = {
        after,
        status: replayResponse.status,
        bodyBytes: Buffer.byteLength(replay),
      }
      run.check('停止终态后一秒游标重放没有新增事件', () => {
        assert.equal(replayResponse.status, 200)
        assert(!replay.split('\n').some((line) => line.startsWith('data:')))
      })
    },
  )

  report.finalHealth = (await request('/health')).value
  report.checks.push({
    name: '始终使用同一提供方、模型与运行器版本',
    passed:
      report.finalHealth.provider === report.initialHealth.provider &&
      report.finalHealth.model === report.initialHealth.model &&
      report.finalHealth.version === report.initialHealth.version &&
      report.finalHealth.liveAvailable === true,
  })
} catch (error) {
  report.checks.push({ name: '真实验收前置条件或执行', passed: false, error: errorRecord(error) })
} finally {
  await tokenHandle?.close().catch(() => {})
  for (const run of liveRuns) if (!run.closed) await run.cleanup()
  report.finishedAt = new Date().toISOString()
  report.passed =
    report.runs.length === 3 &&
    report.runs.every((run) => run.passed) &&
    report.checks.every((check) => check.passed)
  // 凭据路径及原值均不写入证据；失败也保留独立目录，不覆盖任何旧验收。
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await save()
  console.log(
    JSON.stringify({ passed: report.passed, runs: report.runs.length, evidence: reportPath }),
  )
  if (!report.passed) process.exitCode = 1
}
