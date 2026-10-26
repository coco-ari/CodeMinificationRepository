import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCustomerRegistry } from '../agent-demo/t3-adapters/customer-registry.mjs'
import {
  createAssistantDirectory,
  questionConfigurationPolicy,
} from '../agent-demo/t3-adapters/assistants/index.ts'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../agent-demo/t3-adapters/access.mjs'
import { sharedProfileVerifier } from '../agent-demo/t3-adapters/shared-profile-approvals.ts'

const selection = (preset) => ({
  assistantId: preset.id,
  presetRevision: preset.revision,
  configuration: preset.configuration,
})
function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'autoops-shared-allocations-'))
  const sessionDb = new DatabaseSync(':memory:'),
    bindingDb = new DatabaseSync(':memory:')
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  const member = (userId, role, workspaceAccess = 'internal', environmentIds = []) => ({
    userId,
    role,
    workspaceAccess,
    environmentIds,
    status: 'active',
  })
  const recipient = member('recipient', 'reader', 'internal', ['test'])
  const external = member('external', 'external', 'external')
  const project = (id, memberships) => ({
    id,
    name: id,
    memberships,
    memberIds: memberships.map((m) => m.userId),
    environments: [
      { id: 'test', name: '测试' },
      { id: 'production', name: '生产' },
    ],
    documents: [],
    resources: [],
  })
  const targetProject = project('target', [
    member('admin', 'project_admin'),
    member('provider', 'reader'),
    recipient,
    external,
  ])
  const catalog = {
    users: ['admin', 'provider', 'recipient', 'external', 'not-a-member'].map((id) => ({
      id,
      name: id,
      role: 'member',
      status: 'active',
    })),
    projects: [project('source', [member('provider', 'project_admin')]), targetProject],
    agents: [{ id: 'a-project', projectIds: ['source', 'target'] }],
  }
  let access, directory
  const membership = (actor, project) =>
    access.requireProjectActionForActor(actor, project, 'chat.use')
  const registry = createCustomerRegistry({
    db: bindingDb,
    enabled: () => true,
    requireOwner: (actor) => {
      if (!catalog.users.some((u) => u.id === actor && u.status === 'active'))
        throw new Error('无有效账号')
    },
    requireProjectForUser: membership,
  })
  access = createAutoOpsAccess({
    sessionDb,
    bindingDb,
    catalog,
    customerRegistry: registry,
    questions: () => directory,
  })
  const paired = registry.consumePairing(registry.createPairing('provider').pairingCode, {
    label: '分配回归来源',
  })
  const principal = registry.authenticateToken(paired.deviceToken)
  const target = {
    kind: 'customer',
    deviceId: paired.device.id,
    registeredWorkspaceId: 'provided-source',
    workspaceBindingRevision: 1,
    runtimeId: 'codex',
  }
  registry.registerWorkspace(principal, {
    registeredWorkspaceId: target.registeredWorkspaceId,
    workspaceBindingRevision: 1,
    runtimeId: 'codex',
    projectId: 'source',
    label: '明确共享资料',
  })
  registry.markConnected(principal)
  const profile = {
    id: 'readonly-profile',
    revision: 1,
    digest: 'a'.repeat(64),
    imageDigest: `sha256:${'b'.repeat(64)}`,
    policy: 'linux-docker-readonly-v1',
    models: [
      { id: 'isolated-model', supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low' },
    ],
    skills: [],
  }
  const capability = {
    registeredWorkspaceId: target.registeredWorkspaceId,
    workspaceBindingRevision: 1,
    runtimeId: 'codex',
    revision: 'actual-profile-capability',
    protocolVersion: 1,
    assistantConfiguration: true,
    models: profile.models,
    skills: [],
    sharedProfile: profile,
  }
  registry.updateCapabilities(principal, capability)
  const approvalsFile = join(dataDir, 'verified-profiles.json'),
    { models, skills, ...descriptor } = profile
  writeFileSync(
    approvalsFile,
    JSON.stringify([
      {
        providerId: 'provider',
        sourceProjectId: 'source',
        target,
        profile: descriptor,
        validationId: 'fixture-policy-only-not-os-proof',
        verifiedAt: '2026-10-26T00:00:00Z',
      },
    ]),
    { mode: 0o600 },
  )
  const verifySharedProfile = sharedProfileVerifier(() => approvalsFile)
  const ports = {
    projects: () => catalog.projects,
    agents: () => catalog.agents,
    models: () => ({
      discovered: true,
      models: [{ id: 'platform-model', reasoningLevels: ['low'] }],
    }),
    skills: () => [],
    customers: () => registry,
    verifySharedProfile,
  }
  directory = createAssistantDirectory({
    dataDir,
    membership,
    manage: (actor, project) =>
      access.requireProjectActionForActor(actor, project, 'project.manage'),
    validate: questionConfigurationPolicy(ports),
    validateTarget(project, target) {
      if (
        !catalog.projects.some((p) => p.id === project) ||
        (target.kind === 'member' &&
          !catalog.users.some((u) => u.id === target.id && u.status === 'active'))
      )
        throw new Error('分配目标无效')
    },
    providers: { registry: () => registry, displayName: (actor) => actor },
    verifySharedProfile,
  })
  const provided = directory.saveProvided('provider', null, {
    requestId: 'provided',
    expectedRevision: 0,
    value: {
      name: '已获准只读来源',
      description: '',
      instructions: '',
      enabled: true,
      configuration: {
        agentId: 'a-project',
        executionBinding: target,
        customerProfile: descriptor,
        environmentId: null,
        workspaceType: null,
        visibility: 'private',
        model: {
          instanceId: `customer-${target.deviceId}-codex`,
          model: 'isolated-model',
          reasoningEffort: 'low',
        },
        skillIds: [],
      },
    },
  })
  directory.shareProvided('provider', provided.id, 'target', {
    requestId: 'shared',
    expectedRevision: 0,
    enabled: true,
  })
  const allocate = (requestId, targetId = 'recipient', preset = provided, kind = 'member') => ({
    requestId,
    expectedRevision: 0,
    target: { kind, id: targetId },
    assistantIds: [preset.id],
    defaultAssistantId: preset.id,
  })
  const platform = (requestId, patch = {}) =>
    directory.save('admin', 'target', null, {
      requestId,
      expectedRevision: 0,
      value: {
        name: '平台默认',
        description: '',
        instructions: '',
        enabled: true,
        configuration: {
          agentId: 'a-project',
          executionBinding: { kind: 'platform' },
          environmentId: 'test',
          workspaceType: 'internal',
          visibility: 'private',
          model: { instanceId: 'codex', model: 'platform-model', reasoningEffort: 'low' },
          skillIds: [],
          ...patch,
        },
      },
    })
  const state = new DatabaseSync(join(dataDir, 'assistants/state.sqlite'))
  const facts = () =>
    Object.fromEntries(
      [
        'assistant_allocations',
        'assistant_allocation_sources',
        'assistant_receipts',
        'assistant_audit',
      ].map((table) => [table, state.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]),
    )
  t.after(() => {
    state.close()
    directory.close()
    bindingDb.close()
    sessionDb.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return {
    directory,
    registry,
    principal,
    provided,
    profile,
    capability,
    target,
    approvalsFile,
    allocate,
    platform,
    facts,
    state,
    recipient,
    external,
    targetProject,
    catalog,
  }
}

test('管理候选可分配与当前管理员执行权分开，不能为显示可分配而给管理员运行权', (t) => {
  const f = fixture(t),
    candidate = f.directory.providedForProject('admin', 'target').items[0]
  assert.equal(candidate.available, false)
  assert.equal(candidate.reason.code, 'ASSISTANT_PROVIDER_APPROVAL_REQUIRED')
  assert.equal(candidate.assignable, true)
  assert.equal(candidate.assignmentReason, undefined)
  assert.throws(
    () =>
      f.directory.executionScope('admin', 'target', selection(f.provided), {
        threadId: 'unallocated-admin',
        runId: 'run',
      }),
    { code: 'ASSISTANT_PROVIDER_APPROVAL_REQUIRED' },
  )
  f.directory.assign('admin', 'target', f.allocate('assign-recipient'))
  assert.equal(
    f.directory.executionScope('recipient', 'target', selection(f.provided), {
      threadId: 'recipient-thread',
      runId: 'recipient-run',
    }).actorId,
    'recipient',
  )
  assert.throws(
    () =>
      f.directory.executionScope('admin', 'target', selection(f.provided), {
        threadId: 'still-unallocated',
        runId: 'run',
      }),
    { code: 'ASSISTANT_PROVIDER_APPROVAL_REQUIRED' },
  )
})

test('成员默认以目标真实资料和环境范围验证，失败原子回滚分配确认、审计与收据', (t) => {
  const f = fixture(t),
    before = f.facts()
  assert.throws(
    () => f.directory.assign('admin', 'target', f.allocate('external-default', 'external')),
    { code: 'CUSTOMER_SHARED_EXTERNAL_UNSUPPORTED' },
  )
  assert.deepEqual(f.facts(), before)
  const internalProduction = f.platform('production-preset', { environmentId: 'production' }),
    beforeProduction = f.facts()
  assert.throws(
    () =>
      f.directory.assign(
        'admin',
        'target',
        f.allocate('production-default', 'recipient', internalProduction),
      ),
    { code: 'ASSISTANT_ENVIRONMENT_FORBIDDEN' },
  )
  assert.deepEqual(f.facts(), beforeProduction)
  assert.throws(() =>
    f.directory.assign('admin', 'target', f.allocate('not-a-member-default', 'not-a-member')),
  )
  assert.deepEqual(f.facts(), beforeProduction)
})
test('外部成员及外部角色不能把共享内部来源作为非默认分配绕过边界',t=>{
  const f=fixture(t),before=f.facts()
  for(const kind of ['member','role']) {
    const input={...f.allocate(`external-nondefault-${kind}`,'external',f.provided,kind),defaultAssistantId:null}
    assert.throws(()=>f.directory.assign('admin','target',input),{code:'CUSTOMER_SHARED_EXTERNAL_UNSUPPORTED'})
    assert.deepEqual(f.facts(),before)
  }
})

test('可分配候选仍核对真实隔离许可和来源状态，不以历史执行通过代替当前事实', (t) => {
  const f = fixture(t)
  writeFileSync(f.approvalsFile, '[]')
  const unavailable = f.directory.providedForProject('admin', 'target').items[0]
  assert.equal(unavailable.assignable, false)
  assert.equal(unavailable.assignmentReason.code, 'CUSTOMER_SHARED_ISOLATION_UNVERIFIED')
  const before = f.facts()
  assert.throws(() => f.directory.assign('admin', 'target', f.allocate('no-profile-default')), {
    code: 'CUSTOMER_SHARED_ISOLATION_UNVERIFIED',
  })
  assert.deepEqual(f.facts(), before)
})

test('固定角色默认保留未来成员分配，外部角色不能取得内部或共享电脑资料', (t) => {
  const f = fixture(t)
  f.directory.assign(
    'admin',
    'target',
    f.allocate('reader-role-default', 'reader', f.provided, 'role'),
  )
  const next = { ...f.recipient, userId: 'new-recipient' }
  f.catalog.users.push({ id: next.userId, name: next.userId, role: 'member', status: 'active' })
  f.targetProject.memberships.push(next)
  f.targetProject.memberIds.push(next.userId)
  assert.equal(
    f.directory.executionScope(next.userId, 'target', selection(f.provided), {
      threadId: 'future-member',
      runId: 'run',
    }).actorId,
    next.userId,
  )
  const before = f.facts()
  assert.throws(
    () =>
      f.directory.assign(
        'admin',
        'target',
        f.allocate('external-role-default', 'external', f.provided, 'role'),
      ),
    { code: 'CUSTOMER_SHARED_EXTERNAL_UNSUPPORTED' },
  )
  assert.deepEqual(f.facts(), before)
  const internal = f.platform('internal-platform'),
    beforePlatform = f.facts()
  assert.throws(
    () =>
      f.directory.assign(
        'admin',
        'target',
        f.allocate('external-platform-default', 'external', internal, 'role'),
      ),
    { code: 'ASSISTANT_WORKSPACE_FORBIDDEN' },
  )
  assert.deepEqual(f.facts(), beforePlatform)
  const external = f.platform('external-platform', {
    workspaceType: 'external',
    environmentId: null,
  })
  f.directory.assign('admin', 'target', f.allocate('external-valid', 'external', external, 'role'))
  assert.equal(f.directory.catalog('external', 'target').ready, true)
})

test('分配保存后的原请求在来源离线时恢复事实，不能用同ID替换目标或给成员管理权', (t) => {
  const f = fixture(t),
    input = f.allocate('original-allocation')
  const saved = f.directory.assign('admin', 'target', input),
    after = f.facts()
  f.registry.resetPresence()
  f.catalog.users.find((user) => user.id === 'recipient').status = 'disabled'
  assert.deepEqual(f.directory.assign('admin', 'target', input), saved)
  assert.deepEqual(f.facts(), after)
  assert.throws(
    () =>
      f.directory.assign('admin', 'target', { ...input, target: { kind: 'member', id: 'admin' } }),
    { code: 'ASSISTANT_REQUEST_CONFLICT' },
  )
  f.catalog.users.find((user) => user.id === 'recipient').status = 'active'
  assert.throws(
    () => f.directory.assign('recipient', 'target', f.allocate('member-forged-management')),
    { code: 'PROJECT_ACTION_FORBIDDEN' },
  )
  const candidate = f.directory.providedForProject('admin', 'target').items[0]
  assert.equal(candidate.assignable, false)
  assert.equal(candidate.assignmentReason.code, 'CUSTOMER_DEVICE_OFFLINE')
})

test('提供者给本项目角色设置默认也须验证共享目录，不能拿自用模型证明跨用户可用', (t) => {
  const f = fixture(t)
  f.directory.shareProvided('provider', f.provided.id, 'source', {
    requestId: 'share-source',
    expectedRevision: 0,
    enabled: true,
  })
  f.registry.updateCapabilities(f.principal, {
    ...f.capability,
    sharedProfile: { ...f.profile, models: [] },
  })
  const before = f.facts()
  assert.throws(
    () =>
      f.directory.assign(
        'provider',
        'source',
        f.allocate('self-role-default', 'reader', f.provided, 'role'),
      ),
    { code: 'CUSTOMER_MODEL_UNAVAILABLE' },
  )
  assert.deepEqual(f.facts(), before)
})

test('默认验证通过后的审计异常仍回滚全部分配事实，修复后同请求仅保存一次', (t) => {
  const f = fixture(t),
    input = f.allocate('audit-recovery'),
    before = f.facts()
  f.state.exec(
    "CREATE TRIGGER fail_allocation_audit BEFORE INSERT ON assistant_audit BEGIN SELECT RAISE(ABORT,'isolated allocation audit failure'); END",
  )
  assert.throws(
    () => f.directory.assign('admin', 'target', input),
    /isolated allocation audit failure/,
  )
  assert.deepEqual(f.facts(), before)
  f.state.exec('DROP TRIGGER fail_allocation_audit')
  const saved = f.directory.assign('admin', 'target', input),
    after = f.facts()
  assert.deepEqual(f.directory.assign('admin', 'target', input), saved)
  assert.deepEqual(f.facts(), after)
  assert.equal(saved.revision, 1)
})

test('提供者停用预设后管理候选与新默认均不可用，不留下新分配确认', (t) => {
  const f = fixture(t)
  const { id, projectId, revision, createdBy, updatedAt, providedBy, ...value } = f.provided
  f.directory.saveProvided('provider', id, {
    requestId: 'disable-provided',
    expectedRevision: revision,
    value: { ...value, enabled: false },
  })
  const candidate = f.directory.providedForProject('admin', 'target').items[0]
  assert.equal(candidate.assignable, false)
  assert.equal(candidate.assignmentReason.code, 'ASSISTANT_DISABLED')
  const before = f.facts()
  assert.throws(() => f.directory.assign('admin', 'target', f.allocate('disabled-default')), {
    code: 'ASSISTANT_DISABLED',
  })
  assert.deepEqual(f.facts(), before)
})
