import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizeAutoOpsRpc } from '../agent-demo/t3-adapters/rpc-policy.mjs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'
import { createAssistantDirectory, questionConfigurationPolicy, questionConfigurationChoices } from '../agent-demo/t3-adapters/assistants/index.ts'
import { createCustomerRegistry } from '../agent-demo/t3-adapters/customer-registry.mjs'
import { readBusinessModels } from '../agent-demo/t3-adapters/models.mjs'
import { prepareScopedBusinessSkills } from '../agent-demo/t3-adapters/scoped-skills.mjs'
import { resolveBusinessSkillMentions } from '../agent-demo/t3-adapters/skills.mjs'
import { createSkillLibrary, resolveSkillLibrary } from '../agent-demo/t3-adapters/skill-library.mjs'

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
  access = createAutoOpsAccess({ sessionDb, bindingDb, catalog, customerRegistry: registry, questions: () => assistants })
  mkdirSync(join(dataDir, 't3'))
  const models = [{ id: 'actual-model', name: '真实目录模型', reasoningLevels: ['low', 'high'], defaultReasoning: 'low', inputModalities: ['text'], contextWindow: null, supportsReasoningEffortUpdates: true }]
  writeFileSync(join(dataDir, 't3/models-catalog.json'), JSON.stringify({ version: 1, source: 'https://catalog.example/models', models }))
  for (const user of catalog.users) sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(user.id).digest('hex'), user.id, 'csrf', Date.now() + 60_000)
  let assistants
  const ports = { projects: () => catalog.projects, agents: () => catalog.agents, models: () => readBusinessModels(dataDir, 'actual-model'), skills: (projectId, agentId, workspaceType) => resolveSkillLibrary(dataDir, { projectId, agentId, workspaceType }), customers: () => access.customerRegistry }
  const open = () => assistants = createAssistantDirectory({ dataDir,
    membership: (actor, project) => access.requireProjectActionForActor(actor, project, 'chat.use'),
    manage: (actor, project) => access.requireProjectActionForActor(actor, project, 'project.manage'),
    validate: questionConfigurationPolicy(ports),
    choices: (actor, project) => questionConfigurationChoices(ports, actor, project),
    providers: { registry: () => registry, displayName: actor => catalog.users.find(user => user.id === actor)?.name ?? '提供者' },
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

test('有调整权限的成员无任何助手也能直接问答，保存原配置且收回权限立即阻止继续', t => {
  const f = fixture(t), principal = f.access.authenticateCookie('demo_session=developer')
  const question = { assistantId: null, presetRevision: null, configuration: config({ environmentId: null }) }
  const input = { threadId: 'direct-question', projectId: 'project', environmentId: null, agentId: 'a-project', workspaceType: 'internal', visibility: 'private', question }
  assert.deepEqual(f.assistants.catalog('developer', 'project').items, [])
  assert.deepEqual(f.assistants.validateQuestion('developer', 'project', question), question)
  const binding = f.access.reserveThread(principal, input)
  assert.deepEqual(binding.question, question)
  assert.equal(f.access.questionInstructions('developer', input.threadId), '')
  f.access.markThreadAccepted(input.threadId)
  assert.equal(f.access.requireQuestionForActor('developer', input.threadId, { instanceId: 'codex', model: 'actual-model', options: [{ id: 'reasoningEffort', value: 'high' }] }).configuration.model.reasoningEffort, 'high')
  f.assistants.close(); f.open()
  assert.deepEqual(f.access.requireThread(principal, input.threadId).question, question)
  f.developer.canAdjustChat = false
  assert.throws(() => f.access.requireQuestionForActor('developer', input.threadId), { code: 'QUESTION_CONFIGURATION_FORBIDDEN' })
  assert.throws(() => f.access.reserveThread(principal, { ...input, threadId: 'direct-after-revocation' }), { code: 'QUESTION_CONFIGURATION_FORBIDDEN' })
  assert.equal(f.access.requireThread(principal, input.threadId).threadId, input.threadId)
})

test('直接配置不绕过受限预设、环境、资料及模型校验，不能伪造电脑来源或不完整预设身份', t => {
  const f = fixture(t), direct = { assistantId: null, presetRevision: null, configuration: config() }
  assert.throws(() => f.assistants.validateQuestion('reader', 'project', direct), { code: 'QUESTION_CONFIGURATION_FORBIDDEN' })
  for (const [patch, code] of [
    [{ environmentId: 'production' }, 'ASSISTANT_ENVIRONMENT_FORBIDDEN'],
    [{ model: { ...config().model, model: 'unknown' } }, 'ASSISTANT_MODEL_FORBIDDEN'],
    [{ model: { ...config().model, reasoningEffort: 'ultra' } }, 'ASSISTANT_REASONING_FORBIDDEN'],
    [{ agentId: 'other-agent' }, 'QUESTION_SOURCE_FORBIDDEN'],
    [{ executionBinding: { kind: 'customer', deviceId: 'forged', registeredWorkspaceId: 'root', workspaceBindingRevision: 1, runtimeId: 'codex' } }, 'QUESTION_SOURCE_FORBIDDEN'],
  ]) assert.throws(() => f.assistants.validateQuestion('developer', 'project', { ...direct, configuration: config(patch) }), { code })
  assert.throws(() => f.assistants.validateQuestion('developer', 'project', { ...direct, presetRevision: 1 }), { code: 'ASSISTANT_INPUT_INVALID' })
  f.external.canAdjustChat = true
  assert.throws(() => f.assistants.validateQuestion('external', 'project', { ...direct, configuration: config({ environmentId: null }) }), { code: 'ASSISTANT_WORKSPACE_FORBIDDEN' })
  assert.doesNotThrow(() => f.assistants.validateQuestion('external', 'project', { ...direct, configuration: config({ environmentId: null, workspaceType: 'external' }) }))
})

test('直接配置只继承平台和项目skill，不继承助手专属分配', t => {
  const f = fixture(t), preset = f.assistants.save('admin', 'project', null, save('exclusive-skill'))
  const library = createSkillLibrary(f.dataDir)
  const imported = library.importMarkdown({ revision: library.catalog().revision, contents: '---\nname: exclusive-review\ndescription: 仅用于分配边界验收\n---\n读取已授权资料。\n' })
  const skill = imported.skills.find(skill => skill.name === 'exclusive-review')
  const assignment = { revision: library.catalog().revision, skillId: skill.id, versionId: skill.latestVersionId, targetType: 'assistant', targetId: preset.id, projectId: 'project', workspaceTypes: ['internal'], enabled: true }
  library.assign(assignment)
  const scope = { projectId: 'project', agentId: 'a-project', workspaceType: 'internal', question: select(preset) }
  assert.ok(resolveSkillLibrary(f.dataDir, scope).some(entry => entry.id === skill.id))
  const direct = { ...scope, question: { assistantId: null, presetRevision: null, configuration: config() } }
  assert.ok(!resolveSkillLibrary(f.dataDir, direct).some(entry => entry.id === skill.id))
  library.assign({ ...assignment, revision: library.catalog().revision, targetType: 'project', targetId: 'project' })
  assert.ok(resolveSkillLibrary(f.dataDir, direct).some(entry => entry.id === skill.id))
})

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
  const updated = f.assistants.save('admin', 'project', old.id, save('update', details({ instructions: '新的公共指令', configuration: config({ model: { ...old.configuration.model, reasoningEffort: 'high' } }) }), 1))
  assert.throws(() => f.assistants.validateSelection('reader', 'project', select(old)), { code: 'ASSISTANT_PRESET_CHANGED' })
  assert.deepEqual(f.assistants.validateSelection('reader', 'project', select(old), true), select(old))
  assert.equal(f.assistants.instructions('reader', 'project', select(old)), '按真实资料回答')
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

test('真实能力缺失、非法模型/强度不能就绪，不使用平台默认替换实际选择', t => {
  const f = fixture(t)
  const cases = [
    [{ model: { instanceId: 'codex', model: 'guessed', reasoningEffort: 'low' } }, 'ASSISTANT_MODEL_FORBIDDEN'],
    [{ model: { instanceId: 'codex', model: 'actual-model', reasoningEffort: null } }, 'ASSISTANT_REASONING_FORBIDDEN'],
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
  registry.updateCapabilities(principal, { registeredWorkspaceId: target.registeredWorkspaceId, workspaceBindingRevision: 1, runtimeId: 'codex', revision: 'capability-one', protocolVersion: 1, assistantConfiguration: true, models: [{ id: 'customer-only-model', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high' }], skills: [{ id: 'customer:skill', name: '本机技能', description: '已有技能' }] })
  const configuration = config({ executionBinding: target, environmentId: null, workspaceType: null, skillIds: ['customer:skill'], model: { instanceId: `customer-${device.device.id}-codex`, model: 'customer-only-model', reasoningEffort: 'high' } })
  const known = registry.getCapabilities('admin', target), {deviceId: _device, updatedAt: _time, ...capability} = known
  registry.updateCapabilities(principal, {...capability, assistantConfiguration:false})
  assert.throws(() => f.assistants.save('admin', 'project', null, save('old-connector', details({configuration}))), {code:'CUSTOMER_CONNECTOR_UPDATE_REQUIRED'})
  registry.updateCapabilities(principal, {...capability, assistantConfiguration:true})
  const preset = f.assistants.save('admin', 'project', null, save('self-preset', details({ configuration })))
  rmSync(join(f.dataDir, 't3/models-catalog.json'))
  assert.deepEqual(f.assistants.validateSelection('admin', 'project', select(preset)), select(preset))
  assert.throws(() => f.assistants.assign('admin', 'project', allocate('share-without-isolation', [preset.id], null, { kind: 'role', id: 'developer' })), {code:'ASSISTANT_PROVIDER_SHARE_REQUIRED'})
  f.assistants.shareProvided('admin',preset.id,'project',{requestId:'provider-consent',expectedRevision:0,enabled:true})
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


test('会话保存服务端核验后的最终助手参数，外层范围篡改被拒绝，既有修订不可重绑', t => {
  const f = fixture(t), preset = f.assistants.save('admin', 'project', null, save('binding-preset'))
  f.assistants.assign('admin', 'project', allocate('dev-assign', [preset.id], null, { kind: 'role', id: 'developer' }))
  const principal = f.access.authenticateCookie('demo_session=developer')
  const question = { ...select(preset), configuration: config({ environmentId: null, workspaceType: 'external', visibility: 'project', model: { ...preset.configuration.model, reasoningEffort: 'high' } }) }
  const input = { threadId: 'question-thread', projectId: 'project', environmentId: null, agentId: 'a-project', workspaceType: 'external', visibility: 'project', question }
  const binding = f.access.reserveThread(principal, input)
  assert.deepEqual(binding.question, question)
  assert.equal(f.access.questionInstructions('developer', binding.threadId), '按真实资料回答')
  assert.deepEqual(f.access.requireQuestionForActor('developer', binding.threadId, { instanceId: 'codex', model: 'actual-model', options: [{ id: 'reasoningEffort', value: 'low' }] }).configuration.model, { instanceId: 'codex', model: 'actual-model', reasoningEffort: 'low' })
  assert.throws(() => f.access.reserveThread(principal, { ...input, threadId: 'forged-scope', workspaceType: 'internal' }), { code: 'QUESTION_SCOPE_MISMATCH' })
  f.access.markThreadAccepted(binding.threadId)
  assert.throws(() => f.access.reserveThread(principal, { ...input, question: { ...question, configuration: config() } }), { code: 'QUESTION_SCOPE_MISMATCH' })
  assert.deepEqual(f.access.getThreadBinding(binding.threadId).question, question)
})

test('共享历史可读不授予管理员调整后的参数，受限成员和撤回后的调用被拒绝', t => {
  const f = fixture(t), preset = f.assistants.save('admin', 'project', null, save('restricted-preset', details({ configuration: config({ visibility: 'project' }) })))
  f.assistants.assign('admin', 'project', allocate('reader-assign', [preset.id], preset.id))
  const reader = f.access.authenticateCookie('demo_session=reader'), admin = f.access.authenticateCookie('demo_session=admin')
  const input = { threadId: 'shared-question', projectId: 'project', environmentId: 'test', agentId: 'a-project', workspaceType: 'internal', visibility: 'project', question: { ...select(preset), configuration: config({ visibility: 'project', model: { ...preset.configuration.model, reasoningEffort: 'high' } }) } }
  f.access.reserveThread(admin, input); f.access.markThreadAccepted(input.threadId)
  assert.equal(f.access.requireThread(reader, input.threadId).threadId, input.threadId)
  assert.throws(() => f.access.requireQuestionForActor('reader', input.threadId, { instanceId: 'codex', model: 'actual-model', options: [{ id: 'reasoningEffort', value: 'high' }] }), { code: 'ASSISTANT_PARAMETERS_FIXED' })
  const own = { ...input, threadId: 'reader-question', question: select(preset) }
  f.access.reserveThread(reader, own); f.access.markThreadAccepted(own.threadId)
  assert.throws(() => f.access.requireQuestionForActor('reader', own.threadId, { instanceId: 'codex', model: 'actual-model', options: [{ id: 'reasoningEffort', value: 'high' }] }), { code: 'ASSISTANT_PARAMETERS_FIXED' })
  f.assistants.assign('admin', 'project', allocate('reader-revoke', [], null, { kind: 'role', id: 'reader' }, 1))
  assert.equal(f.access.requireThread(reader, own.threadId).threadId, own.threadId)
  assert.throws(() => f.access.requireQuestionForActor('reader', own.threadId), { code: 'DEFAULT_ASSISTANT_REQUIRED' })
})


test('RPC 启动和继续使用最终预设合同，篡改强度与撤回后执行拒绝，仍可停止', t => {
  const f = fixture(t), preset = f.assistants.save('admin', 'project', null, save('rpc-preset', details({ configuration: config({ visibility: 'project' }) })))
  f.assistants.assign('admin', 'project', allocate('rpc-allocation', [preset.id], preset.id))
  const principal = f.access.authenticateCookie('demo_session=reader')
  const input = { threadId: 'rpc-thread', projectId: 'project', environmentId: 'test', agentId: 'a-project', workspaceType: 'internal', visibility: 'project', question: select(preset) }
  f.access.reserveThread(principal, input)
  const previous = { DATA_DIR: process.env.DATA_DIR, AUTOOPS_T3_MODEL: process.env.AUTOOPS_T3_MODEL, AUTOOPS_T3_DATA_DIR: process.env.AUTOOPS_T3_DATA_DIR }
  process.env.DATA_DIR = f.dataDir; process.env.AUTOOPS_T3_MODEL = 'actual-model'; delete process.env.AUTOOPS_T3_DATA_DIR
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
  const modelSelection = { instanceId: 'codex', model: 'actual-model', options: [{ id: 'reasoningEffort', value: 'low' }] }
  const launch = { threadId: input.threadId, projectId: 'project', modelSelection, runtimeMode: 'approval-required', initialMessage: { text: '分析资料', attachments: [] } }
  assert.doesNotThrow(() => authorizeAutoOpsRpc(f.access, principal, 'orchestration.launchThread', launch))
  const forged = { ...modelSelection, options: [{ id: 'reasoningEffort', value: 'high' }] }
  for (const type of ['message.dispatch', 'thread.model-selection.set']) assert.throws(() => authorizeAutoOpsRpc(f.access, principal, 'orchestration.dispatchCommand', { type, threadId: input.threadId, modelSelection: forged, text: '分析资料', attachments: [] }), { code: 'ASSISTANT_PARAMETERS_FIXED' })
  f.access.markThreadAccepted(input.threadId)
  f.assistants.assign('admin', 'project', allocate('rpc-revoke', [], null, { kind: 'role', id: 'reader' }, 1))
  assert.throws(() => authorizeAutoOpsRpc(f.access, principal, 'orchestration.dispatchCommand', { type: 'message.dispatch', threadId: input.threadId, modelSelection, text: '继续', attachments: [] }), { code: 'DEFAULT_ASSISTANT_REQUIRED' })
  assert.doesNotThrow(() => authorizeAutoOpsRpc(f.access, principal, 'orchestration.dispatchCommand', { type: 'run.interrupt', threadId: input.threadId, runId: 'original-run' }))
})


test('平台对话的原生目录和调用统一继承三级范围，不再受预设旧清单限制', t => {
  const f = fixture(t), skills = resolveSkillLibrary(f.dataDir, { projectId: 'project', agentId: 'a-project', workspaceType: 'internal' })
  assert.ok(skills.length >= 2)
  const selected = skills[0], other = skills[1], configuration = config({ skillIds: [selected.id] })
  const preset = f.assistants.save('admin', 'project', null, save('skill-preset', details({ configuration })))
  const principal = f.access.authenticateCookie('demo_session=admin')
  const binding = f.access.reserveThread(principal, { threadId: 'skill-thread', projectId: 'project', environmentId: 'test', agentId: 'a-project', workspaceType: 'internal', visibility: 'private', question: select(preset) })
  const context = prepareScopedBusinessSkills(f.dataDir, binding)
  assert.deepEqual(context.skills.map(skill => skill.id).sort(), skills.map(skill => skill.id).sort())
  const env = { AUTOOPS_T3_DATA_DIR: f.dataDir }
  assert.equal(resolveBusinessSkillMentions('$' + selected.name, env, binding)[0].name, selected.name)
  assert.equal(resolveBusinessSkillMentions('$' + other.name, env, binding)[0].name, other.name)
  const empty = { ...binding, threadId: 'no-skills', question: { ...binding.question, configuration: { ...configuration, skillIds: [] } } }
  assert.deepEqual(prepareScopedBusinessSkills(f.dataDir, empty).skills.map(skill => skill.id).sort(), skills.map(skill => skill.id).sort())
})

test('删除助手清除版本、分配与原配置收据，并可核对同一删除请求', (t) => {
  const f = fixture(t),
    preset = f.assistants.save('admin', 'project', null, save('remove-create'))
  const other = f.assistants.save(
    'admin',
    'project',
    null,
    save('keep-create', details({ name: '保留助手' })),
  )
  f.assistants.assign(
    'admin',
    'project',
    allocate('remove-allocation', [preset.id, other.id], preset.id),
  )
  const input = { requestId: 'remove-assistant', expectedRevision: preset.revision }
  assert.throws(() => f.assistants.remove('reader', 'project', preset.id, input), {
    code: 'PROJECT_ACTION_FORBIDDEN',
  })
  assert.throws(
    () => f.assistants.remove('admin', 'project', preset.id, { ...input, expectedRevision: 0 }),
    { code: 'ASSISTANT_REVISION_CONFLICT' },
  )
  const result = f.assistants.remove('admin', 'project', preset.id, input)
  assert.deepEqual(f.assistants.remove('admin', 'project', preset.id, input), result)
  assert.equal(
    f.assistants.projectReceipt('admin', 'project', input.requestId).result.deleted,
    true,
  )
  const settings = f.assistants.settings('admin', 'project')
  assert.deepEqual(
    settings.presets.map((item) => item.id),
    [other.id],
  )
  assert.deepEqual(settings.allocations[0].assistantIds, [other.id])
  assert.equal(settings.allocations[0].defaultAssistantId, null)
  const db = new DatabaseSync(join(f.dataDir, 'assistants/state.sqlite'), { readOnly: true })
  try {
    for (const table of [
      'assistant_versions',
      'assistant_provider_shares',
      'assistant_allocation_sources',
    ])
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE assistant_id=?`).get(preset.id).n,
        0,
      )
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM assistant_receipts WHERE operation='preset.save:new' AND json_extract(result,'$.id')=?",
        )
        .get(preset.id).n,
      0,
    )
  } finally {
    db.close()
  }
})
