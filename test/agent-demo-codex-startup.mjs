import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { DYNAMIC_TOOLS, RUNNER_CONFIG, buildRunnerConfig } from '../agent-demo/codex-bridge.mjs'

// 只验证真实 CLI 的启动与配置；必须在现有禁止联网的工具沙箱运行。
// 不调用 account/read、turn/start 或任何执行/搜索接口，不使用个人配置与凭据。
assert.equal(process.env.CODEX_SANDBOX, 'seatbelt', '需要现有 macOS 工具沙箱')
assert.equal(process.env.CODEX_SANDBOX_NETWORK_DISABLED, '1', '不得解除网络限制运行此探针')
const binary =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
const useCpa = process.env.AGENT_DEMO_STARTUP_PROVIDER === 'cpa'
const durable = process.env.AGENT_DEMO_STARTUP_DURABLE === '1'
const destination = path.resolve(
  `.test-artifacts/agent-demo-api/${useCpa ? 'codex-cpa-startup' : 'codex-startup'}${durable ? '-durable' : ''}.json`,
)
const temporary = await mkdtemp('/private/tmp/autoops-codex-startup-')
const probeHome = path.join(temporary, 'home')
const probeCwd = path.join(temporary, 'cwd')
const probeTemp = path.join(temporary, 'tmp')
for (const directory of [probeHome, probeCwd, probeTemp]) await mkdir(directory, { mode: 0o700 })
const env = {
  PATH: '/usr/bin:/bin',
  HOME: probeHome,
  CODEX_HOME: probeHome,
  TMPDIR: probeTemp,
  LANG: 'en_US.UTF-8',
  CODEX_SANDBOX: 'seatbelt',
  CODEX_SANDBOX_NETWORK_DISABLED: '1',
}
// 探针提供方不需要鉴权且只指向不可达回环端口，避免初始化模型目录走外部提供方。
// 这是探针配置，绝不作为实际模型选择，也不覆盖业务隔离参数。
const probeConfig = useCpa
  ? buildRunnerConfig({
      provider: 'cpa',
      providerBaseUrl: 'https://127.0.0.1:1/v1',
      model: 'grok-4.6',
    })
  : {
      cli_auth_credentials_store: 'ephemeral',
      model_provider: 'startup_probe',
      'model_providers.startup_probe': {
        name: 'Startup probe without inference',
        base_url: 'http://127.0.0.1:1/v1',
        wire_api: 'responses',
        requires_openai_auth: false,
        request_max_retries: 0,
        stream_max_retries: 0,
      },
    }
const allowedMethods = new Set([
  'initialize',
  'initialized',
  'permissionProfile/list',
  'config/read',
  'thread/start',
  'thread/resume',
  'thread/delete',
])
const evidence = {
  testedAt: new Date().toISOString(),
  mode: 'real-cli-startup-only',
  provider: useCpa ? 'cpa' : 'startup_probe',
  passed: false,
  realModelCalls: 0,
  turnStartCalls: 0,
  accountReadCalls: 0,
  personalCredentialAccessRequested: false,
  sandbox: 'Existing Codex tool seatbelt sandbox; network disabled; no escalation.',
  emptyDirectoryBeforeLaunch: true,
  inheritedEnvironmentKeys: [],
  childEnvironmentKeys: Object.keys(env),
  probeConfig,
  runnerConfig: RUNNER_CONFIG,
  dynamicToolNames: DYNAMIC_TOOLS.map((tool) => tool.name),
  calls: [],
  notifications: [],
  checks: [],
  limits: [
    '仅证明实际 CLI 接受启动命令、配置及 dynamicTools 注册；未执行模型轮次或工具。',
    '外部网络由现有工具沙箱禁用；未用网络解除或个人鉴权绕过初始化限制。',
    '不能替代实际模型、文件/网络工具隔离、引导/停止语义和并发行为验收。',
  ],
}
const scrub = (value) => JSON.stringify(value).replaceAll(temporary, '<temporary>')
const tomlValue = (value) => {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(',')}]`
  return `{${Object.entries(value)
    .map(([key, entry]) => `${JSON.stringify(key)}=${tomlValue(entry)}`)
    .join(',')}}`
}
let child
let exitPromise
let buffer = ''
let stderr = ''
let nextId = 1
const pending = new Map()
function send(method, params, notification = false) {
  assert(allowedMethods.has(method), `非推理探针拒绝调用 ${method}`)
  evidence.calls.push({ method, params: JSON.parse(scrub(params)) })
  if (notification) {
    child.stdin.write(`${JSON.stringify({ method, params })}\n`)
    return
  }
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`等待 ${method} 超时`))
    }, 15_000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}
try {
  assert.deepEqual(await readdir(probeHome), [])
  assert.deepEqual(await readdir(probeCwd), [])
  const version = await promisify(execFile)(binary, ['--version'], {
    env,
    cwd: probeCwd,
    timeout: 10_000,
  })
  evidence.version = version.stdout.trim()
  assert.equal(evidence.version, 'codex-cli 0.159.2')
  const args = ['app-server', '--stdio', '--strict-config']
  for (const [key, value] of Object.entries({ ...RUNNER_CONFIG, ...probeConfig }))
    args.push('-c', `${key}=${tomlValue(value)}`)
  evidence.args = args
  child = spawn(binary, args, { env, cwd: probeCwd, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-64 * 1024)
  })
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.method) {
        evidence.notifications.push(message.method)
        if (message.id !== undefined) {
          child.stdin.write(
            `${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Startup-only probe refuses server requests' } })}\n`,
          )
        }
        continue
      }
      const waiting = pending.get(message.id)
      if (!waiting) continue
      clearTimeout(waiting.timer)
      pending.delete(message.id)
      if (message.error) waiting.reject(new Error(scrub(message.error)))
      else waiting.resolve(message.result)
    }
  })
  child.stdin.on('error', () => {})
  exitPromise = new Promise((resolve) => {
    const end = (code, signal) => {
      evidence.exit = { code, signal }
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer)
        waiting.reject(new Error(`CLI 已结束：${code ?? signal}`))
      }
      pending.clear()
      resolve()
    }
    child.on('exit', end)
    child.on('error', (error) => end(null, error.message))
  })
  evidence.initialize = await send('initialize', {
    clientInfo: { name: 'autoops_startup_probe', title: 'Startup probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })
  send('initialized', {}, true)
  evidence.checks.push('实际 CLI initialize/initialized 握手成功')
  evidence.permissionProfiles = await send('permissionProfile/list', { cwd: probeCwd })
  assert(
    evidence.permissionProfiles.data.some(
      (profile) => profile.id === 'agent_demo' && profile.allowed,
    ),
  )
  evidence.checks.push('命名权限配置可由实际 CLI 列出')
  const configuration = await send('config/read', { cwd: probeCwd, includeLayers: false })
  evidence.effectiveConfig = Object.fromEntries(
    [
      'features',
      'permissions',
      'default_permissions',
      'approval_policy',
      'web_search',
      'agents',
      'skills',
      'mcp_servers',
      'hooks',
      'allow_login_shell',
      'project_doc_max_bytes',
      'analytics',
      'check_for_update_on_startup',
      'model_provider',
      'model_providers',
      'shell_environment_policy',
    ].map((key) => [key, configuration.config?.[key] ?? null]),
  )
  const effective = evidence.effectiveConfig
  for (const name of [
    'shell_tool',
    'shell_snapshot',
    'apps',
    'plugins',
    'memories',
    'multi_agent',
    'request_permissions_tool',
    'skill_mcp_dependency_install',
  ]) {
    assert.equal(effective.features[name], false, `${name} 必须保持禁用`)
  }
  assert.equal(effective.features.code_mode.enabled, false)
  assert.equal(effective.permissions.agent_demo.filesystem[':root'], 'deny')
  assert.equal(effective.permissions.agent_demo.network.enabled, false)
  assert.equal(effective.default_permissions, 'agent_demo')
  assert.equal(effective.approval_policy, 'never')
  assert.equal(effective.web_search, 'disabled')
  assert.equal(effective.agents.enabled, false)
  assert.equal(effective.skills.bundled.enabled, false)
  assert.equal(effective.skills.include_instructions, false)
  assert.deepEqual(effective.mcp_servers, {})
  assert(
    Object.values(effective.hooks).every((hooks) => Array.isArray(hooks) && hooks.length === 0),
  )
  assert.equal(effective.allow_login_shell, false)
  assert.equal(effective.project_doc_max_bytes, 0)
  assert.equal(effective.analytics.enabled, false)
  assert.equal(effective.check_for_update_on_startup, false)
  if (useCpa) {
    assert.equal(effective.model_provider, 'cpa')
    assert.equal(effective.model_providers.cpa.wire_api, 'responses')
    assert.equal(effective.model_providers.cpa.requires_openai_auth, false)
    assert.equal(effective.model_providers.cpa.env_key, 'CPA_API_KEY')
    assert.equal(effective.shell_environment_policy.inherit, 'none')
    evidence.checks.push('CPA Responses 提供方配置被实际 CLI 接受，无需读取 OpenAI 账号或密钥')
  }
  evidence.checks.push('config/read 确认全部指定工具开关与根目录/网络拒绝配置')
  const thread = await send('thread/start', {
    model: useCpa ? 'grok-4.6' : 'startup-probe-no-inference',
    modelProvider: useCpa ? 'cpa' : 'startup_probe',
    allowProviderModelFallback: false,
    cwd: probeCwd,
    runtimeWorkspaceRoots: [],
    approvalPolicy: 'never',
    permissions: 'agent_demo',
    config: { ...RUNNER_CONFIG, ...probeConfig },
    baseInstructions: 'Startup-only validation. Do not execute any task.',
    developerInstructions: 'Do not execute any task.',
    ephemeral: !durable,
    environments: [],
    dynamicTools: DYNAMIC_TOOLS,
  })
  evidence.thread = {
    id: thread.thread.id,
    ephemeral: thread.thread.ephemeral,
    turns: thread.thread.turns,
    model: thread.model,
    modelProvider: thread.modelProvider,
    activePermissionProfile: thread.activePermissionProfile,
    approvalPolicy: thread.approvalPolicy,
    sandbox: thread.sandbox,
    instructionSources: thread.instructionSources,
    runtimeWorkspaceRoots: thread.runtimeWorkspaceRoots,
  }
  assert.equal(thread.thread.ephemeral, !durable)
  assert.equal(thread.modelProvider, useCpa ? 'cpa' : 'startup_probe')
  if (useCpa) assert.equal(thread.model, 'grok-4.6')
  assert.equal(thread.activePermissionProfile?.id, 'agent_demo')
  assert.equal(thread.approvalPolicy, 'never')
  assert.equal(thread.sandbox?.type, 'readOnly')
  assert.equal(thread.sandbox?.networkAccess, false)
  assert.deepEqual(thread.thread.turns, [])
  assert.deepEqual(thread.instructionSources, [])
  assert.deepEqual(thread.runtimeWorkspaceRoots, [])
  assert(!evidence.notifications.some((method) => method.startsWith('turn/')))
  evidence.checks.push(`带六个业务 dynamicTools 的${durable ? '持久' : '临时'} thread/start 被接受`)
  if (durable) {
    await assert.rejects(
      send('thread/resume', {
        threadId: thread.thread.id,
        excludeTurns: true,
        model: useCpa ? 'grok-4.6' : 'startup-probe-no-inference',
        modelProvider: useCpa ? 'cpa' : 'startup_probe',
        cwd: probeCwd,
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'never',
        permissions: 'agent_demo',
        config: { ...RUNNER_CONFIG, ...probeConfig },
        baseInstructions: 'Startup-only validation. Do not execute any task.',
        developerInstructions: 'Do not execute any task.',
      }),
      /no rollout found/,
    )
    evidence.checks.push(
      '真实 CLI 证实首个 turn 之前无 rollout 可 resume；适配层不得把空 thread 当作可重启恢复上下文',
    )
    await send('thread/delete', { threadId: thread.thread.id })
    evidence.checks.push('thread/delete 可清理尚无 rollout 的本探针空线程；不猜测磁盘路径')
  }
  evidence.checks.push('返回 agent_demo / never / readOnly / networkAccess:false')
  evidence.checks.push('未发送 account/read、turn/start 或任何执行请求')
  evidence.passed = true
} catch (error) {
  evidence.error = error.stack
  process.exitCode = 1
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  if (exitPromise) {
    let forceKillTimer
    await Promise.race([
      exitPromise,
      new Promise(
        (resolve) =>
          (forceKillTimer = setTimeout(() => {
            child.kill('SIGKILL')
            resolve()
          }, 1500)),
      ),
    ])
    clearTimeout(forceKillTimer)
  }
  evidence.stderr = stderr.replaceAll(temporary, '<temporary>')
  evidence.bridgeSha256 = createHash('sha256')
    .update(await readFile(new URL('../agent-demo/codex-bridge.mjs', import.meta.url)))
    .digest('hex')
  evidence.testSha256 = createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex')
  await rm(temporary, { recursive: true, force: true })
  evidence.temporaryDirectoriesRemoved = true
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, JSON.stringify(JSON.parse(scrub(evidence)), null, 2))
  console.log(
    JSON.stringify(
      { passed: evidence.passed, report: destination, error: evidence.error },
      null,
      2,
    ),
  )
}
