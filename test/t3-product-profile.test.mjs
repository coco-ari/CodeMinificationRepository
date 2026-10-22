import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { resolveProductProfile } from '../agent-demo/t3-adapters/product-profile.mjs'
import { authorizeProductRpc, authorizeAutoOpsRpc } from '../agent-demo/t3-adapters/rpc-policy.mjs'
import { createSettingsPreferences } from '../agent-demo/t3-adapters/settings-preferences.mjs'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'
import { prepareBusinessNativePolicy, assertBusinessNativeConfig } from '../agent-demo/t3-adapters/native-catalog.mjs'
import { buildT3WorkerConfiguration } from '../agent-demo/t3-adapters/launcher.mjs'
import { saveAuthorizedPlan } from '../agent-demo/t3-adapters/plan-materials.mjs'
import { businessMcpApprovals, prepareAutoOpsCodexRequest } from '../agent-demo/t3-adapters/codex-policy.mjs'

const lite = { AUTOOPS_DEMO_PROFILE: 'project-assistant-lite-v1' }
const full = { AUTOOPS_DEMO_PROFILE: 't3-demo-full-v1' }
const withEnv = (t, values) => {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key]
    t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous)
    process.env[key] = value
  }
}

test('缺省兼容完整模式，错误部署值启动失败；精简模式不覆盖外观与发送习惯', () => {
  assert.equal(resolveProductProfile({}).id, 't3-demo-full-v1')
  assert.equal(resolveProductProfile(full).capabilities.subagents, true)
  assert.equal(resolveProductProfile(lite).capabilities.subagents, false)
  assert.equal(resolveProductProfile(full).capabilities.onlineThemes, false)
  for (const id of ['', 'lite', '__proto__']) assert.throws(() => resolveProductProfile({ AUTOOPS_DEMO_PROFILE: id }), /未知/)
  assert.throws(() => buildT3WorkerConfiguration({ AUTOOPS_DEMO_PROFILE: 'bad' }), /未知/)
  const overrides = resolveProductProfile(lite).clientSettingsOverrides
  for (const key of ['theme', 'fontFamily', 'fontSize', 'sendShortcut', 'followUpBehavior']) assert.equal(Object.hasOwn(overrides, key), false)
  assert.equal(overrides.confirmThreadDelete, true)
})

test('精简有效偏好覆盖旧值，禁止重新启用，切回完整模式恢复原值', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const env = { ...full }, store = createSettingsPreferences({ db, env })
    store.update('user', { responseStreamingMode: 'turn', autoResumeLimitedThreads: true, sidebarAutoSettleAfterDays: 2 })
    const original = store.read('user')
    env.AUTOOPS_DEMO_PROFILE = lite.AUTOOPS_DEMO_PROFILE
    const effective = store.overlay('user', { continueThreadsAfterServerUpdate: true })
    assert.equal(effective.responseStreamingMode, 'paragraph')
    assert.equal(effective.autoResumeLimitedThreads, false)
    assert.equal(effective.sidebarAutoSettleAfterDays, null)
    assert.equal(effective.continueThreadsAfterServerUpdate, false)
    assert.throws(() => store.update('user', { autoResumeLimitedThreads: true }), /精简版/)
    store.update('user', { responseStreamingMode: 'paragraph', autoResumeLimitedThreads: false })
    assert.deepEqual(store.read('user'), original)
    env.AUTOOPS_DEMO_PROFILE = full.AUTOOPS_DEMO_PROFILE
    assert.equal(store.overlay('user', {}).responseStreamingMode, 'turn')
    assert.equal(store.overlay('user', {}).autoResumeLimitedThreads, true)
  } finally { db.close() }
})

test('精简 RPC 禁新高级流程但保留基础会话管理、队列和旧状态解除', () => {
  const command = (type, extra = {}) => authorizeProductRpc('orchestration.dispatchCommand', { type, ...extra }, lite)
  for (const type of ['thread.fork', 'checkpoint.rollback', 'thread.snooze', 'thread.settle', 'thread.auto-settle']) assert.throws(() => command(type), /精简版/)
  assert.throws(() => command('thread.auto-settle.set', { enabled: true }))
  assert.throws(() => command('thread.interaction-mode.set', { interactionMode: 'plan' }))
  assert.throws(() => command('message.dispatch', { sourcePlanRef: { threadId: 'old', planId: 'p' } }))
  assert.throws(() => authorizeProductRpc('orchestration.launchThread', { initialMessage: { sourcePlanRef: { threadId: 'old', planId: 'p' } } }, lite))
  for (const type of ['thread.pin', 'thread.unpin', 'thread.pin.reorder', 'thread.active.reorder', 'thread.unsnooze', 'thread.unsettle', 'thread.archive', 'thread.unarchive', 'thread.stop', 'run.interrupt', 'queued-run.edit', 'queued-run.cancel', 'queued-run.reorder', 'queued-message.promote-to-steer', 'queue.resume', 'message.dispatch']) assert.doesNotThrow(() => command(type))
  assert.doesNotThrow(() => command('thread.auto-settle.set', { enabled: false }))
  assert.doesNotThrow(() => command('thread.interaction-mode.set', { interactionMode: 'default' }))
  assert.throws(() => command('thread.metadata.update', { limitRecovery: { autoResume: true } }))
  assert.doesNotThrow(() => command('thread.metadata.update', { limitRecovery: { autoResume: false } }))
  assert.doesNotThrow(() => command('thread.metadata.update', { limitRecovery: null }))
  for (const method of ['server.getUsageSummary', 'server.upsertKeybinding', 'server.removeKeybinding', 'mcpApps.callTool', 'mcpApps.updateModelContext']) assert.throws(() => authorizeProductRpc(method, {}, lite))
  for (const method of ['orchestration.getThreadProjection', 'orchestration.getTurnItem', 'assets.createUrl', 'mcpApps.readResource']) assert.doesNotThrow(() => authorizeProductRpc(method, {}, lite))
  assert.doesNotThrow(() => authorizeProductRpc('orchestration.dispatchCommand', { type: 'thread.fork' }, full))
})

test('业务 bootstrap 与真实 ACL 入口使用同一产品配置，旧绑定不变', t => {
  withEnv(t, lite)
  const db = new DatabaseSync(':memory:'), sessions = new DatabaseSync(':memory:')
  t.after(() => { db.close(); sessions.close() })
  initializeAutoOpsAccessSchema(db)
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('profile-test').digest('hex'), 'u-admin', 'csrf', Date.now() + 60000)
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: db })
  const principal = access.authenticateCookie('demo_session=profile-test')
  const binding = access.bindThread(principal, { threadId: 'old-plan', projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'private' })
  const bootstrap = access.bootstrap(principal)
  assert.deepEqual(bootstrap.productProfile, { id: lite.AUTOOPS_DEMO_PROFILE })
  assert.equal(bootstrap.capabilities.planMode, false)
  assert.equal(bootstrap.clientSettingsOverrides.planModeEnabled, false)
  assert.throws(() => authorizeAutoOpsRpc(access, principal, 'orchestration.dispatchCommand', { type: 'thread.interaction-mode.set', threadId: binding.threadId, interactionMode: 'plan' }))
  assert.doesNotThrow(() => authorizeAutoOpsRpc(access, principal, 'orchestration.dispatchCommand', { type: 'message.dispatch', threadId: binding.threadId, text: '继续普通问答', attachments: [] }))
  assert.deepEqual(access.getThreadBinding(binding.threadId), binding)
})

test('精简原生配置真实禁 multi_agent，不能通过旧配置重新启用；完整模式保留角色', t => {
  const directory = mkdtempSync(join(tmpdir(), 't3-lite-native-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, 't3'))
  const home = join(directory, 't3/codex-home')
  const env = { ...lite, AUTOOPS_T3_DATA_DIR: directory, AUTOOPS_T3_MODEL: 'grok-4.6' }
  const { policy } = prepareBusinessNativePolicy(directory, home, 'grok-4.6', env)
  const config = { model: 'grok-4.6', model_catalog_json: policy.model_catalog_json, features: { multi_agent: false }, agents: { enabled: false, max_depth: 1, default_subagent_model: 'grok-4.6', ...Object.fromEntries(['default', 'explorer', 'worker'].map(role => [role, policy[`agents.${role}`]])) } }
  assert.equal(policy['features.multi_agent'], false)
  assert.equal(policy['agents.enabled'], false)
  assert.doesNotThrow(() => assertBusinessNativeConfig({ config }, env))
  assert.throws(() => assertBusinessNativeConfig({ config: { ...config, features: { multi_agent: true } } }, env), /开关/)
  assert.throws(() => assertBusinessNativeConfig({ config: { ...config, agents: { ...config.agents, enabled: true } } }, env), /限制/)
  const fullPolicy = prepareBusinessNativePolicy(directory, home, 'grok-4.6', full).policy
  assert.equal(fullPolicy['features.multi_agent'], true)
  assert.equal(fullPolicy['agents.enabled'], true)
})

test('精简 MCP 不授权 HTML 工具；原生恢复请求重加受限配置', t => {
  const directory = mkdtempSync(join(tmpdir(), 't3-lite-request-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  withEnv(t, { ...lite, AUTOOPS_T3_DATA_DIR: directory, AUTOOPS_T3_MODEL: 'grok-4.6' })
  const approvals = businessMcpApprovals()
  assert.equal(approvals.enabled_tools.includes('html_render'), false)
  assert.equal(approvals.enabled_tools.includes('html_preview'), false)
  assert.equal(approvals.enabled_tools.includes('ask_user'), true)
  assert.equal(approvals.enabled_tools.includes('create_report'), true)
  const request = prepareAutoOpsCodexRequest('thread/resume', { config: { 'features.multi_agent': true, 'agents.enabled': true, 'mcp_servers.t3-code': { url: 'http://127.0.0.1/mcp' } } })
  assert.equal(request.config['features.multi_agent'], false)
  assert.equal(request.config['agents.enabled'], false)
  assert.equal(request.permissions, 'agent_demo')
})


test('未知 profile 在网关打开旧数据或监听端口之前失败', t => {
  const directory = mkdtempSync(join(tmpdir(), 't3-profile-startup-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const data = join(directory, 'untouched-data')
  const result = spawnSync(process.execPath, ['agent-demo/server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: data, AGENT_DEMO_ENGINE: 't3', AUTOOPS_DEMO_PROFILE: 'typo-profile' }, encoding: 'utf8', timeout: 5000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /未知的 AutoOps 产品配置/)
  assert.equal(existsSync(data), false)
})

test('精简版计划资料服务不能绕过 HTTP 门禁生成新文件', t => {
  withEnv(t, lite)
  let touched = false
  assert.throws(() => saveAuthorizedPlan({ access: { requireThread() { touched = true } }, input: { threadId: 'old-plan' } }), /精简版/)
  assert.equal(touched, false)
})
