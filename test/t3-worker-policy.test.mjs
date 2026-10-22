import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildT3WorkerConfiguration, prepareT3Worker } from '../agent-demo/t3-adapters/launcher.mjs'
import { prepareAutoOpsCodexRequest, businessMcpApprovals } from '../agent-demo/t3-adapters/codex-policy.mjs'
import { tokenizeCliArgs } from '../vendor/t3code/packages/shared/src/cliArgs.ts'

test('启动参数沿 T3 tokenizer 完整传递固定权限和 CPA 配置，设置不含密钥', () => {
  const directory = mkdtempSync(join(tmpdir(), 't3-worker-'))
  try {
    const keyPath = join(directory, 'key')
    writeFileSync(keyPath, 'test-provider-secret-only\n', { mode: 0o600 })
    const env = { DATA_DIR: directory, AGENT_DEMO_MODEL: 'grok-4.6', AGENT_DEMO_CODEX_BINARY: '/path with space/codex', AGENT_DEMO_PROVIDER: 'cpa', AGENT_DEMO_CPA_BASE_URL: 'https://provider.example/v1', AGENT_DEMO_CPA_API_KEY_FILE: keyPath, AGENT_DEMO_BRIDGE_TOKEN: 'never-in-native', OPENAI_API_KEY: 'never-in-native' }
    const config = prepareT3Worker(env)
    const args = tokenizeCliArgs(config.settings.providerInstances.codex.config.launchArgs)
    assert.deepEqual(args.slice(0, 2), ['--stdio', '--strict-config'])
    const values = args.filter((_, index) => index > 1 && index % 2 === 1)
    assert.ok(values.includes('features.shell_tool=false'))
    assert.ok(values.includes('default_permissions="agent_demo"'))
    assert.ok(values.some((value) => value.includes('"base_url"="https://provider.example/v1"')))
    assert.equal(config.childEnv.CPA_API_KEY, 'test-provider-secret-only')
    assert.equal(config.childEnv.OPENAI_API_KEY, undefined)
    assert.equal(config.childEnv.AGENT_DEMO_BRIDGE_TOKEN, undefined)
    const text = readFileSync(join(config.baseDir, 'userdata/settings.json'), 'utf8')
    assert.ok(!text.includes('test-provider-secret-only'))
    assert.equal(statSync(join(config.baseDir, 'userdata/settings.json')).mode & 0o777, 0o600)
    assert.throws(() => buildT3WorkerConfiguration({ ...env, AGENT_DEMO_CPA_BASE_URL: 'http://bad.example' }), /HTTPS/)
  } finally { rmSync(directory, { force: true, recursive: true }) }
})

test('原生请求编码后仍强制固定权限，保留原生 MCP 通道，不能由输入覆盖', () => {
  const previous = { data: process.env.AUTOOPS_T3_DATA_DIR, model: process.env.AUTOOPS_T3_MODEL }
  process.env.AUTOOPS_T3_DATA_DIR = '/tmp/policy-only'
  process.env.AUTOOPS_T3_MODEL = 'grok-4.6'
  try {
    const original = { model: 'grok-4.6', sandbox: 'danger-full-access', config: { 'features.shell_tool': true, 'mcp_servers.t3-code': { url: 'http://127.0.0.1:8788/mcp' } } }
    assert.throws(()=>prepareAutoOpsCodexRequest('turn/start',{model:'unregistered'}),/模型/)
    const result = prepareAutoOpsCodexRequest('thread/start', original)
    assert.equal(result.permissions, 'agent_demo')
    assert.deepEqual(result.approvalPolicy, { granular: { sandbox_approval:false, rules:false, skill_approval:false, request_permissions:false, mcp_elicitations:true } })
    assert.deepEqual(prepareAutoOpsCodexRequest('turn/start', { approvalPolicy:'on-request' }).approvalPolicy, result.approvalPolicy)
    assert.equal(result.sandbox, undefined)
    assert.equal(result.model, 'grok-4.6')
    assert.equal(result.config['features.shell_tool'], false)
    assert.deepEqual(result.config.mcp_servers, { 't3-code': original.config['mcp_servers.t3-code'] })
    assert.equal(result.config['mcp_servers.t3-code'], undefined)
    const hostile = prepareAutoOpsCodexRequest('thread/resume', { config: { ...original.config, mcp_servers: { unknown: { command: 'sh' } }, 'mcp_servers.unknown': { command: 'sh' } } })
    assert.deepEqual(hostile.config.mcp_servers, { 't3-code': original.config['mcp_servers.t3-code'] })
    assert.equal(hostile.config['mcp_servers.unknown'], undefined)
    assert.equal(original.config['features.shell_tool'], true)
    assert.strictEqual(prepareAutoOpsCodexRequest('turn/steer', original), original)
    const approvals=businessMcpApprovals()
    assert.equal(approvals.default_tools_approval_mode,'prompt')
    assert.equal(approvals.tools.create_report.approval_mode,'approve')
    assert.equal(approvals.tools.html_render.approval_mode,'approve')
    assert.equal(approvals.tools.shell,undefined)
    assert.ok(!approvals.enabled_tools.includes('shell'))
  } finally {
    for (const [key, value] of [['AUTOOPS_T3_DATA_DIR', previous.data], ['AUTOOPS_T3_MODEL', previous.model]]) value === undefined ? delete process.env[key] : process.env[key] = value
  }
})
