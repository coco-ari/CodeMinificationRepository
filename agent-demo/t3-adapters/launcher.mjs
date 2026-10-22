import { resolveProductProfile } from './product-profile.mjs'
import { businessNativePolicy, prepareBusinessNativePolicy } from './native-catalog.mjs'
import { spawn } from 'node:child_process'
import { assertNativeRolloutPaths } from '../migrations/t3-native-paths.mjs'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRunnerConfig } from '../runtime-policy.mjs'
import { readBusinessModels } from './models.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tomlValue = (value) => typeof value === 'string' ? JSON.stringify(value)
  : typeof value === 'boolean' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? `[${value.map(tomlValue).join(',')}]`
  : `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}=${tomlValue(entry)}`).join(',')}}`
// This is the inverse of T3's tokenizeCliArgs, not a shell command.
const quoteArgument = (value) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'

export function buildT3WorkerConfiguration(env = process.env) {
  resolveProductProfile(env)
  const dataDir = resolve(env.DATA_DIR || join(root, 'agent-demo/data'))
  const baseDir = resolve(env.AUTOOPS_T3_BASE_DIR || join(dataDir, 't3'))
  const model = env.AGENT_DEMO_MODEL || env.AUTOOPS_T3_MODEL
  if (!model) throw new Error('必须配置已验证的内置 Agent 模型')
  const binaryPath = resolve(env.AGENT_DEMO_CODEX_BINARY || join(root, 'agent-demo/runtime/codex'))
  const homePath = resolve(env.AGENT_DEMO_CODEX_HOME || join(baseDir, 'codex-home'))
  const runnerConfig = { ...buildRunnerConfig({ provider: env.AGENT_DEMO_PROVIDER || 'cpa', providerBaseUrl: env.AGENT_DEMO_CPA_BASE_URL, model }), ...businessNativePolicy(dataDir,homePath,model,env) }
  const launch = ['--stdio', '--strict-config']
  for (const [key, value] of Object.entries(runnerConfig)) launch.push('-c', `${key}=${tomlValue(value)}`)
  const selection = { instanceId: 'codex', model }
  return {
    dataDir, baseDir, homePath, binaryPath,
    settings: {
      providerInstances: { codex: { driver: 'codex', enabled: true, config: { binaryPath, homePath, launchArgs: launch.map(quoteArgument).join(' '), customModels: readBusinessModels(dataDir,model).models.map(entry=>entry.id) } } },
      defaultModelSelection: selection, textGenerationModelSelection: selection,
      defaultRuntimeMode: 'approval-required', responseStreamingMode: 'paragraph',
      enableProviderUpdateChecks: false, continueThreadsAfterServerUpdate: false,
      enableAgentBrowserAccess: false, enableDeviceSupport: false, autoResumeLimitedThreads: false,
    },
  }
}

export function prepareT3Worker(env = process.env) {
  const config = buildT3WorkerConfiguration(env)
  for (const directory of [config.dataDir, config.baseDir, config.homePath, join(config.baseDir, 'userdata')]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertNativeRolloutPaths(config.homePath)
  prepareBusinessNativePolicy(config.dataDir,config.homePath,config.settings.defaultModelSelection.model,env)
  const settingsPath = join(config.baseDir, 'userdata/settings.json')
  let previous = {}
  if (existsSync(settingsPath)) previous = JSON.parse(readFileSync(settingsPath, 'utf8'))
  const next = { ...previous, ...config.settings }
  const temporary = settingsPath + `.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, settingsPath)
  chmodSync(settingsPath, 0o600)
  const childEnv = { ...env, AUTOOPS_T3_DATA_DIR: config.dataDir, AUTOOPS_T3_CODEX_HOME: config.homePath, AUTOOPS_BUSINESS_RESOURCES_DIR: join(root, 'agent-demo/t3-adapters'), AUTOOPS_T3_MODEL: config.settings.defaultModelSelection.model, T3CODE_TELEMETRY_ENABLED: 'false' }
  if ((env.AGENT_DEMO_PROVIDER || 'cpa') === 'cpa') {
    const keyPath = env.AGENT_DEMO_CPA_API_KEY_FILE
    if (!keyPath) throw new Error('缺少 CPA 专用密钥文件路径')
    const stat = lstatSync(keyPath)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 16384)
      throw new Error('CPA 密钥文件必须是仅属主可读的常规文件')
    const key = readFileSync(keyPath, 'utf8').trim()
    if (key.length < 8 || /[\r\n\0]/.test(key)) throw new Error('CPA 专用密钥文件格式无效')
    childEnv.CPA_API_KEY = key
  }
  // These belong to the retired bridge and must not enter the native worker.
  delete childEnv.AGENT_DEMO_BRIDGE_TOKEN
  delete childEnv.AGENT_BRIDGE_TOKEN
  delete childEnv.OPENAI_API_KEY
  delete childEnv.ANTHROPIC_API_KEY
  return { ...config, childEnv }
}

export function startT3Worker(env = process.env) {
  const config = prepareT3Worker(env)
  const port = Number(env.AUTOOPS_T3_PORT || 8788)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('内部 T3 端口无效')
  const bundled = join(root, 'vendor/t3code/apps/server/dist/bin.mjs')
  const entry = env.AUTOOPS_T3_ENTRY || (existsSync(bundled) ? bundled : join(root, 'vendor/t3code/apps/server/src/bin.ts'))
  return spawn(process.execPath, [entry, '--host', '127.0.0.1', '--port', String(port), '--base-dir', config.baseDir, '--no-browser'], {
    cwd: join(root, 'vendor/t3code'), env: config.childEnv, stdio: 'inherit',
  })
}
