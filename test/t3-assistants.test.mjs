import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'
import { createAssistantDirectory, questionConfigurationPolicy, questionConfigurationChoices } from '../agent-demo/t3-adapters/assistants/index.ts'
import { createCustomerRegistry } from '../agent-demo/t3-adapters/customer-registry.mjs'
import { readBusinessModels } from '../agent-demo/t3-adapters/models.mjs'
import { resolveSkillLibrary } from '../agent-demo/t3-adapters/skill-library.mjs'

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'assistant-directory-'))
  const sessionDb = new DatabaseSync(':memory:'), bindingDb = new DatabaseSync(':memory:')
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  const reader = { userId: 'reader', role: 'reader', status: 'active', environmentIds: ['test'], workspaceAccess: 'internal', canAdjustChat: false }
  const developer = { ...reader, userId: 'developer', role: 'developer', canAdjustChat: true }
  const external = { ...reader, userId: 'external', role: 'external', workspaceAccess: 'external', environmentIds: [] }
  const catalog = { users: [{ id: 'admin', name: '管理员', role: 'admin' }, ...[reader, developer, external].map(m => ({ id: m.userId, name: m.userId, role: 'member', ...(m.userId === 'external' ? { kind: 'external' } : {}) }))], projects: [{ id: 'project', name: '项目', memberships: [reader, developer, external], memberIds: ['admin', 'reader', 'developer', 'external'], environments: [{ id: 'test', name: '测试' }, { id: 'production', name: '生产' }], documents: [], resources: [] }], agents: [{ id: 'a-project', projectIds: ['project'], name: '开发助手' }] }
  let access
  const registry = createCustomerRegistry({ db: bindingDb, enabled: () => true, requireOwner: () => {}, requireProjectForUser: (actor, project) => access.requireProjectActionForActor(actor, project, 'chat.use') })
  access = createAutoOpsAccess({ sessionDb, bindingDb, catalog, customerRegistry: registry })
  mkdirSync(join(dataDir, 't3'))
  const models = [{ id: 'actual-model', name: '真实目录模型', reasoningLevels: ['low', 'high'], defaultReasoning: 'low', inputModalities: ['text'], contextWindow: null, supportsReasoningEffortUpdates: true }]
  writeFileSync(join(dataDir, 't3/models-catalog.json'), JSON.stringify({ version: 1, source: 'https://catalog.example/models', models }))
  let assistants
  const ports = { projects: () => catalog.projects, agents: () => catalog.agents, models: () => readBusinessModels(dataDir, 'actual-model'), skills: (projectId, agentId, workspaceType) => resolveSkillLibrary(dataDir, { projectId, agentId, workspaceType }), customers: () => access.customerRegistry }
  const open = () => assistants = createAssistantDirectory({ dataDir,
    membership: (actor, project) => access.requireProjectActionForActor(actor, project, 'chat.use'),
    manage: (actor, project) => access.requireProjectActionForActor(actor, project, 'project.manage'),
    validate: questionConfigurationPolicy(ports),
    choices: (actor, project) => questionConfigurationChoices(ports, actor, project),
    validateTarget(project, target) { if (project !== 'project' || target.kind === 'member' && !catalog.users.some(user => user.id === target.id)) throw Object.assign(new Error('目标无效'), { code: 'TARGET_INVALID' }) },
  })
  open()
  t.after(() => { assistants.close(); sessionDb.close(); bindingDb.close(); rmSync(dataDir, { recursive: true, force: true }) })
  return { dataDir, reader, developer, external, access, open, get assistants() { return assistants } }
}
const config = patch => ({ agentId: 'a-project', executionBinding: { kind: 'platform' }, environmentId: 'test', workspaceType: 'internal', visibility: 'private', model: { instanceId: 'codex', model: 'actual-model', reasoningEffort: 'low' }, skillIds: [], ...patch })
const details = patch => ({ name: '测试排障', description: '已登记来源', instructions: '按真实资料回答', enabled: true, configuration: config(), ...patch })
const save = (requestId, value = details(), expectedRevision = 0) => ({ requestId, expectedRevision, value })
const select = preset => ({ assistantId: preset.id, presetRevision: preset.revision, configuration: preset.configuration })
const allocate = (requestId, assistantIds, defaultAssistantId, target = { kind: 'role', id: 'reader' }, expectedRevision = 0) => ({ requestId, assistantIds, defaultAssistantId, target, expectedRevision })

test('助手配置持久化与原请求恢复，不用夹具覆盖，重放篡改和普通成员管理被拒绝', t => {
  const f = fixture(t), command = save('create-preset')
  const created = f.assistants.save('admin', 'project', null, command)
  assert.equal(created.revision, 1)
  assert.deepEqual(f.assistants.save('admin', 'project', null, command), created)
  assert.throws(() => f.assistants.save('admin', 'project', null, { ...command, value: details({ name: '改写原请求' }) }), { code: 'ASSISTANT_REQUEST_CONFLICT' })
  assert.throws(() => f.assistants.settings('reader', 'project'), { code: 'PROJECT_ACTION_FORBIDDEN' })
  f.assistants.close(); f.open()
  assert.deepEqual(f.assistants.settings('admin', 'project').presets, [created])
  assert.throws(() => f.assistants.save('admin', 'project', created.id, save('bad-revision', details(), 0)), { code: 'ASSISTANT_REVISION_CONFLICT' })
  assert.throws(() => f.assistants.save('admin', 'project', null, save('bad-field', { ...details(), ownerId: 'admin' })), { code: 'ASSISTANT_INPUT_INVALID' })
})

test('受限成员必须有有效默认助手，实际预设全部参数只读且来源不能伪造', t => {
  const f = fixture(t), preset = f.assistants.save('admin', 'project', null, save('new'))
  assert.equal(f.assistants.catalog('reader', 'project').ready, false)
  assert.throws(() => f.assistants.validateSelection('reader', 'project', select(preset)), { code: 'DEFAULT_ASSISTANT_REQUIRED' })
  f.assistants.assign('admin', 'project', allocate('role', [preset.id], preset.id))
  assert.equal(f.assistants.catalog('reader', 'project').ready, true)
  assert.deepEqual(f.assistants.validateSelection('reader', 'project', select(preset)), select(preset))
  for (const patch of [{ environmentId: null }, { workspaceType: 'external' }, { visibility: 'project' }, { model: { ...preset.configuration.model, reasoningEffort: 'high' } }, { skillIds: ['forged-skill'] }])
    assert.throws(() => f.assistants.validateSelection('reader', 'project', { ...select(preset), configuration: config(patch) }), { code: 'ASSISTANT_PARAMETERS_FIXED' })
  assert.throws(() => f.assistants.validateSelection('reader', 'project', { ...select(preset), configuration: config({ executionBinding: { kind: 'customer', deviceId: 'forged-device', registeredWorkspaceId: 'root', workspaceBindingRevision: 1, runtimeId: 'codex' } }) }), { code: 'ASSISTANT_SOURCE_FIXED' })
})

test('角色分配和成员默认优先，撤回后立即阻止提交，合法会话阅读不由助手准入裁决', t => {
  const f = fixture(t), first = f.assistants.save('admin', 'project', null, save('one')), second = f.assistants.save('admin', 'project', null, save('two', details({ name: '另一个助手' })))
  f.assistants.assign('admin', 'project', allocate('role', [first.id], first.id))
  f.assistants.assign('admin', 'project', allocate('member', [second.id], second.id, { kind: 'member', id: 'reader' }))
  assert.equal(f.assistants.catalog('reader', 'project').defaultAssistantId, second.id)
  assert.equal(f.assistants.catalog('reader', 'project').items.length, 2)
  f.assistants.assign('admin', 'project', allocate('withdraw', [], null, { kind: 'member', id: 'reader' }, 1))
  assert.equal(f.assistants.catalog('reader', 'project').defaultAssistantId, first.id)
  assert.throws(() => f.assistants.validateSelection('reader', 'project', select(second)), { code: 'ASSISTANT_NOT_ASSIGNED' })
})

test('有调整权者按最终配置执行，不把模型强度、范围和共享重新套回预设，不写回公共值', t => {
  const f = fixture(t), preset = f.assistants.save('admin', 'project', null, save('new'))
  f.assistants.assign('admin', 'project', allocate('dev', [preset.id], null, { kind: 'role', id: 'developer' }))
  const actual = { ...select(preset), configuration: config({ environmentId: null, workspaceType: 'external', visibility: 'project', model: { ...preset.configuration.model, reasoningEffort: 'high' } }) }
  assert.deepEqual(f.assistants.validateSelection('developer', 'project', actual), actual)
  assert.deepEqual(f.assistants.settings('admin', 'project').presets[0], preset)
  assert.throws(() => f.assistants.validateSelection('developer', 'project', { ...actual, configuration: config({ environmentId: 'production' }) }), { code: 'ASSISTANT_ENVIRONMENT_FORBIDDEN' })
  f.developer.canAdjustChat = false
  assert.throws(() => f.assistants.validateSelection('developer', 'project', actual), { code: 'DEFAULT_ASSISTANT_REQUIRED' })
})

test('预设更新仅影响新会话，已接受参数按原修订核验，停用立即阻止后续执行', t => {
  const f = fixture(t), old = f.assistants.save('admin', 'project', null, save('new'))
  f.assistants.assign('admin', 'project', allocate('role', [old.id], old.id))
  const updated = f.assistants.save('admin', 'project', old.id, save('update', details({ configuration: config({ model: { ...old.configuration.model, reasoningEffort: 'high' } }) }), 1))
  assert.throws(() => f.assistants.validateSelection('reader', 'project', select(old)), { code: 'ASSISTANT_PRESET_CHANGED' })
  assert.deepEqual(f.assistants.validateSelection('reader', 'project', select(old), true), select(old))
  f.assistants.save('admin', 'project', old.id, save('disable', { ...details(), enabled: false }, updated.revision))
  assert.throws(() => f.assistants.validateSelection('reader', 'project', select(old), true), { code: 'DEFAULT_ASSISTANT_REQUIRED' })
})

test('成员缩减环境或变为外部前校验默认助手，不通过旧分配扩权', t => {
  const f = fixture(t), preset = f.assistants.save('admin', 'project', null, save('new'))
  f.assistants.assign('admin', 'project', allocate('role', [preset.id], preset.id))
  assert.doesNotThrow(() => f.assistants.validateMember('project', 'reader', f.reader))
  for (const patch of [{ environmentIds: [] }, { workspaceAccess: 'external', role: 'external', environmentIds: [] }])
    assert.throws(() => f.assistants.validateMember('project', 'reader', { ...f.reader, ...patch }), { code: 'PROJECT_DEFAULT_ASSISTANT_REQUIRED' })
  assert.doesNotThrow(() => f.assistants.validateMember('project', 'reader', { ...f.reader, status: 'disabled' }))
})

test('真实能力缺失、非法模型/强度/技能不能就绪，不使用平台默认替换实际选择', t => {
  const f = fixture(t)
  const cases = [
    [{ model: { instanceId: 'codex', model: 'guessed', reasoningEffort: 'low' } }, 'ASSISTANT_MODEL_FORBIDDEN'],
    [{ model: { instanceId: 'codex', model: 'actual-model', reasoningEffort: null } }, 'ASSISTANT_REASONING_FORBIDDEN'],
    [{ skillIds: ['missing'] }, 'ASSISTANT_SKILL_FORBIDDEN'],
  ]
  for (const [index, [patch, code]] of cases.entries())
    assert.throws(() => f.assistants.save('admin', 'project', null, save('invalid-' + index, details({ configuration: config(patch) }))), { code })
  const accepted = f.assistants.save('admin', 'project', null, save('accepted-before-outage'))
  rmSync(join(f.dataDir, 't3/models-catalog.json'))
  assert.equal(f.assistants.save('admin', 'project', null, save('accepted-before-outage')).id, accepted.id)
  assert.throws(() => f.assistants.save('admin', 'project', null, save('no-catalog')), { code: 'ASSISTANT_MODELS_UNAVAILABLE' })
  const disabled = f.assistants.save('admin', 'project', null, save('draft', details({ enabled: false })))
  assert.equal(f.assistants.catalog('admin', 'project').items.find(row => row.preset.id === disabled.id).available, false)
})

test('审计失败原子回滚预设及收据，修复后原请求可恢复且无重复版本', t => {
  const f = fixture(t), db = new DatabaseSync(join(f.dataDir, 'assistants/state.sqlite'))
  t.after(() => db.close())
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON assistant_audit BEGIN SELECT RAISE(ABORT,'isolated audit failure'); END")
  assert.throws(() => f.assistants.save('admin', 'project', null, save('atomic')), /isolated audit failure/)
  assert.equal(f.assistants.settings('admin', 'project').presets.length, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assistant_versions').get().n, 0)
  db.exec('DROP TRIGGER fail_audit')
  const stored = f.assistants.save('admin', 'project', null, save('atomic'))
  assert.equal(f.assistants.save('admin', 'project', null, save('atomic')).id, stored.id)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assistant_versions').get().n, 1)
})


test('用户来源只使用登记能力中的模型和技能，目录身份保留，跨用户仍拒绝未验证隔离', t => {
  const f = fixture(t), registry = f.access.customerRegistry
  const pairing = registry.createPairing('admin'), device = registry.consumePairing(pairing.pairingCode, { label: '自己的电脑' })
  const principal = registry.authenticateToken(device.deviceToken)
  const target = { kind: 'customer', deviceId: device.device.id, registeredWorkspaceId: 'existing:workspace.1', workspaceBindingRevision: 1, runtimeId: 'codex' }
  registry.registerWorkspace(principal, { registeredWorkspaceId: target.registeredWorkspaceId, projectId: 'project', label: '现有目录', workspaceBindingRevision: 1, runtimeId: 'codex' })
  registry.markConnected(principal)
  registry.updateCapabilities(principal, { registeredWorkspaceId: target.registeredWorkspaceId, workspaceBindingRevision: 1, runtimeId: 'codex', revision: 'capability-one', protocolVersion: 1, models: [{ id: 'customer-only-model', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high' }], skills: [{ id: 'customer:skill', name: '本机技能', description: '已有技能' }] })
  const configuration = config({ executionBinding: target, environmentId: null, workspaceType: null, skillIds: ['customer:skill'], model: { instanceId: `customer-${device.device.id}-codex`, model: 'customer-only-model', reasoningEffort: 'high' } })
  const preset = f.assistants.save('admin', 'project', null, save('self-preset', details({ configuration })))
  rmSync(join(f.dataDir, 't3/models-catalog.json'))
  assert.deepEqual(f.assistants.validateSelection('admin', 'project', select(preset)), select(preset))
  f.assistants.assign('admin', 'project', allocate('share-without-isolation', [preset.id], null, { kind: 'role', id: 'developer' }))
  const other = f.assistants.catalog('developer', 'project')
  assert.equal(other.items[0].available, false)
  assert.equal(other.items[0].reason.code, 'CUSTOMER_SHARED_ISOLATION_UNVERIFIED')
  assert.throws(() => f.assistants.validateSelection('developer', 'project', select(preset)), { code: 'ASSISTANT_REQUIRED' })
  registry.setDeviceStatus('admin', device.device.id, 'disabled')
  assert.throws(() => f.assistants.validateSelection('admin', 'project', select(preset)), { code: 'ASSISTANT_REQUIRED' })
})


test('配置候选复用实际模型与技能目录，只显示自己的电脑且不返回物理路径或凭据', t => {
  const f = fixture(t), registry = f.access.customerRegistry
  for (const owner of ['admin', 'developer']) {
    const pair = registry.createPairing(owner), device = registry.consumePairing(pair.pairingCode, { label: owner === 'admin' ? '自己的电脑' : '别人私有电脑' })
    const actor = registry.authenticateToken(device.deviceToken)
    registry.registerWorkspace(actor, { registeredWorkspaceId: owner + '-workspace', projectId: 'project', label: '登记目录', workspaceBindingRevision: 1, runtimeId: 'codex' })
  }
  const choices = f.assistants.choices('admin', 'project'), encoded = JSON.stringify(choices)
  assert.equal(choices.sources[0].models[0].id, 'actual-model')
  assert.equal(choices.sources.length, 2)
  assert.equal(encoded.includes('自己的电脑'), true)
  for (const forbidden of ['别人私有电脑', f.dataDir, 'packageRoot', 'tokenHash', 'deviceToken']) assert.equal(encoded.includes(forbidden), false)
  assert.throws(() => f.assistants.choices('reader', 'project'), { code: 'PROJECT_ACTION_FORBIDDEN' })
  registry.setDeviceStatus('admin', registry.listDevices('admin')[0].id, 'disabled')
  const disabled = f.assistants.choices('admin', 'project')
  assert.equal(disabled.sources[0].available, true)
  assert.equal(disabled.sources[1].available, false)
})
