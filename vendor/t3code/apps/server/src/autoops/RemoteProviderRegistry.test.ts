// @effect-diagnostics nodeBuiltinImport:off -- 仅以隔离 SQLite、账号和公开 owner 构造共享准入，不执行模型。
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { DEFAULT_SERVER_SETTINGS, ProjectId, ProviderInstanceId, ThreadId } from '@t3tools/contracts'
import type { AutoOpsAccess } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import type { SettingsPreferences } from '../../../../../../agent-demo/t3-adapters/settings-preferences.mjs'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../../../../../../agent-demo/t3-adapters/access.mjs'
import {
  createAssistantDirectory,
  questionConfigurationPolicy,
} from '../../../../../../agent-demo/t3-adapters/assistants/index.ts'
import { sharedProfileVerifier } from '../../../../../../agent-demo/t3-adapters/shared-profile-approvals.ts'
import { authorizeAutoOpsRpc } from '../../../../../../agent-demo/t3-adapters/rpc-policy.mjs'
import { ProviderInstanceAvailability } from '../provider/ProviderInstanceAvailability.ts'
import { CurrentAutoOpsPrincipal } from './RequestScope.ts'
import { RemoteDeviceService, type RemoteDeviceHub } from './RemoteDeviceService.ts'
import { availabilityLayer } from './RemoteProviderRegistry.ts'
import { forThread } from './personalSettings.ts'
import { createSettingsPreferences } from '../../../../../../agent-demo/t3-adapters/settings-preferences.mjs'

const configured = vi.hoisted(() => ({
  access: undefined as AutoOpsAccess | undefined,
  preferences: undefined as SettingsPreferences | undefined,
}))
vi.mock('../../../../../../agent-demo/t3-adapters/access.mjs', async (original) => ({
  ...await original<typeof import('../../../../../../agent-demo/t3-adapters/access.mjs')>(),
  configuredAutoOpsAccess: () => configured.access,
}))
vi.mock('../../../../../../agent-demo/t3-adapters/settings-preferences.mjs', async (original) => ({
  ...await original<typeof import('../../../../../../agent-demo/t3-adapters/settings-preferences.mjs')>(),
  configuredSettingsPreferences: () => configured.preferences,
}))

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
  configured.access = undefined
  configured.preferences = undefined
  delete process.env.AUTOOPS_CUSTOMER_AGENTS
})

function fixture() {
  process.env.AUTOOPS_CUSTOMER_AGENTS = '1'
  const dataDir = mkdtempSync(join(tmpdir(), 'shared-provider-availability-'))
  const sessions = new DatabaseSync(':memory:'),
    bindings = new DatabaseSync(':memory:')
  cleanup.push(() => {
    sessions.close()
    bindings.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  const users = ['provider', 'manager', 'recipient', 'other', 'platform'].map((id) => ({
    id,
    name: id,
    role: id === 'platform' ? 'admin' : 'member',
  }))
  const projects = ['source', 'target'].map((id) => ({
    id,
    name: id,
    memberIds: users.map((user) => user.id),
    memberships: users.map((user) => ({
      userId: user.id,
      role:
        user.id === 'manager' || (id === 'source' && user.id === 'provider')
          ? ('project_admin' as const)
          : ('reader' as const),
      workspaceAccess: 'internal' as const,
      environmentIds: [],
      status: 'active' as const,
      canAdjustChat: false,
    })),
    environments: [],
    documents: [],
    resources: [],
  }))
  const agents = [
    {
      id: 'a-project',
      name: '业务助手',
      description: '',
      capabilities: [],
      projectIds: ['source', 'target'],
    },
  ]
  for (const user of users)
    sessions
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(createHash('sha256').update(user.id).digest('hex'), user.id, 'csrf', 60000)
  let directory: ReturnType<typeof createAssistantDirectory>
  const access = createAutoOpsAccess({
    sessionDb: sessions,
    bindingDb: bindings,
    catalog: { users, projects, agents },
    now: () => 1000,
    questions: () => directory,
  })
  const registry = access.customerRegistry
  configured.access = access
  configured.preferences = createSettingsPreferences({ db: bindings, env: {} })
  cleanup.push(() => configured.preferences?.dispose())
  const paired = registry.consumePairing(registry.createPairing('provider').pairingCode, {
    label: '隔离设备',
  })
  const device = registry.authenticateToken(paired.deviceToken)
  const target = {
    kind: 'customer' as const,
    deviceId: paired.device.id,
    registeredWorkspaceId: 'source-directory',
    workspaceBindingRevision: 1,
    runtimeId: 'codex' as const,
  }
  registry.registerWorkspace(device, {
    registeredWorkspaceId: target.registeredWorkspaceId,
    workspaceBindingRevision: 1,
    runtimeId: 'codex',
    projectId: 'source',
    label: '原来源目录',
  })
  const epoch = registry.markConnected(device)
  const profile = {
    id: 'readonly',
    revision: 1,
    digest: 'a'.repeat(64),
    imageDigest: `sha256:${'b'.repeat(64)}`,
    policy: 'linux-docker-readonly-v1' as const,
    models: [
      { id: 'isolated-model', supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low' },
    ],
    skills: [],
  }
  const capability = {
    registeredWorkspaceId: target.registeredWorkspaceId,
    workspaceBindingRevision: 1,
    runtimeId: 'codex' as const,
    protocolVersion: 1 as const,
    revision: 'fixture-catalog',
    assistantConfiguration: true,
    models: [{ id: 'self-model', supportedReasoningEfforts: ['high'] }],
    skills: [],
    sharedProfile: profile,
  }
  registry.updateCapabilities(device, capability)
  const { models, skills, ...descriptor } = profile
  const approval = join(dataDir, 'approvals.json')
  writeFileSync(
    approval,
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
  const verifySharedProfile = sharedProfileVerifier(() => approval)
  directory = createAssistantDirectory({
    dataDir,
    membership: (actor, project) => access.requireProjectActionForActor(actor, project, 'chat.use'),
    manage: (actor, project) =>
      access.requireProjectActionForActor(actor, project, 'project.manage'),
    validateTarget() {},
    verifySharedProfile,
    providers: { registry: () => registry, displayName: (actor) => actor },
    validate: questionConfigurationPolicy({
      projects: () => projects,
      agents: () => agents,
      customers: () => registry,
      verifySharedProfile,
      models: () => {
        throw new Error('不能使用平台模型')
      },
      skills: () => [],
    }),
  })
  cleanup.push(() => directory.close())
  const preset = directory.saveProvided('provider', null, {
    requestId: 'provided',
    expectedRevision: 0,
    value: {
      name: '共享助手',
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
  directory.shareProvided('provider', preset.id, 'target', {
    requestId: 'share',
    expectedRevision: 0,
    enabled: true,
  })
  directory.assign('manager', 'target', {
    requestId: 'assign',
    expectedRevision: 0,
    target: { kind: 'member', id: 'recipient' },
    assistantIds: [preset.id],
    defaultAssistantId: preset.id,
  })
  const actor = access.authenticateCookie('demo_session=recipient')
  const threadId = ThreadId.make('shared-thread')
  access.reserveThread(actor, {
    threadId,
    projectId: 'target',
    environmentId: null,
    agentId: 'a-project',
    visibility: 'private',
    executionBinding: target,
    question: {
      assistantId: preset.id,
      presetRevision: preset.revision,
      configuration: preset.configuration,
    },
  })
  const layer = availabilityLayer.pipe(
    Layer.provide(Layer.succeed(RemoteDeviceService, { hub: { access } as RemoteDeviceHub })),
  )
  const resolve = (
    user: string | null = 'recipient',
    overrides: { projectId?: string; instanceId?: string; threadId?: string } = {},
  ) => {
    const task = Effect.gen(function* () {
      const availability = yield* ProviderInstanceAvailability
      return yield* availability.resolve({
        projectId: ProjectId.make(overrides.projectId ?? 'target'),
        instanceId: ProviderInstanceId.make(
          overrides.instanceId ?? preset.configuration.model.instanceId,
        ),
        threadId: ThreadId.make(overrides.threadId ?? threadId),
      })
    }).pipe(Effect.provide(layer))
    return Effect.runPromise(
      user === null
        ? task
        : task.pipe(
            Effect.provideService(
              CurrentAutoOpsPrincipal,
              access.authenticateCookie('demo_session=' + user),
            ),
          ),
    )
  }
  return {
    access,
    directory,
    registry,
    device,
    target,
    capability,
    profile,
    approval,
    epoch,
    preset,
    actor,
    threadId,
    projects,
    resolve,
  }
}

it('真实提供者共享、独立管理员分配和当前profile合法时，原绑定可跨项目通过粗可用性检查', async () => {
  const f = fixture()
  expect(f.registry.listWorkspaces('provider', 'target')).toEqual([])
  expect(f.directory.catalog('recipient', 'target').items[0]?.available).toBe(true)
  expect(await f.resolve()).toBe(true)
})

it('共享运行准备沿真实来源校验设备，但个人设置仍属于实际调用者', () => {
  const f = fixture()
  configured.preferences!.update('provider', { responseStreamingMode: 'paragraph' })
  configured.preferences!.update('recipient', { responseStreamingMode: 'turn' })
  const binding = f.access.getThreadBinding(f.threadId)!
  expect(binding.ownerId).toBe('recipient')
  expect(() => f.registry.validateTarget(binding.ownerId, binding.projectId, f.target))
    .toThrow(expect.objectContaining({ code: 'CUSTOMER_DEVICE_NOT_FOUND' }))
  expect(f.access.customerExecutionSource(f.threadId, binding.ownerId))
    .toEqual({ ownerId: 'provider', projectId: 'source' })
  for (const actor of ['provider', 'manager', 'platform', 'other'])
    expect(() => f.access.customerExecutionSource(f.threadId, actor)).toThrow()
  expect(forThread(f.threadId, DEFAULT_SERVER_SETTINGS)).toMatchObject({
    responseStreamingMode: 'turn',
    continueThreadsAfterServerUpdate: false,
    compactIdleThreads: false,
    autoResumeLimitedThreads: false,
    snoozeLimitedThreads: false,
  })
})

it('共享准备逐次核对原调用者的分配与提供者撤回，不以设备来源代替授权', () => {
  const f = fixture()
  expect(() => forThread(f.threadId, DEFAULT_SERVER_SETTINGS)).not.toThrow()
  f.directory.assign('manager', 'target', {
    requestId: 'settings-remove-allocation', expectedRevision: 1,
    target: { kind: 'member', id: 'recipient' }, assistantIds: [], defaultAssistantId: null,
  })
  expect(() => forThread(f.threadId, DEFAULT_SERVER_SETTINGS)).toThrow()
  f.directory.assign('manager', 'target', {
    requestId: 'settings-restore-allocation', expectedRevision: 2,
    target: { kind: 'member', id: 'recipient' }, assistantIds: [f.preset.id],
    defaultAssistantId: f.preset.id,
  })
  expect(() => forThread(f.threadId, DEFAULT_SERVER_SETTINGS)).not.toThrow()
  f.directory.shareProvided('provider', f.preset.id, 'target', {
    requestId: 'settings-withdraw-share', expectedRevision: 1, enabled: false,
  })
  expect(() => forThread(f.threadId, DEFAULT_SERVER_SETTINGS)).toThrow()
})

it.each(['profile', 'membership', 'workspace', 'device', 'model'] as const)(
  '共享准备独立拒绝失效%s，不读取提供者个人设置放行',
  (cause) => {
    const f = fixture()
    expect(() => forThread(f.threadId, DEFAULT_SERVER_SETTINGS)).not.toThrow()
    if (cause === 'profile') writeFileSync(f.approval, '[]', { mode: 0o600 })
    if (cause === 'membership') {
      const membership = f.projects.find((project) => project.id === 'target')!.memberships
        .find((member) => member.userId === 'recipient')!
      Reflect.set(membership, 'status', 'suspended')
    }
    if (cause === 'workspace') f.registry.revokeWorkspace(f.device, f.target.registeredWorkspaceId)
    if (cause === 'device') f.registry.revokeCredential('provider', f.target.deviceId)
    if (cause === 'model') f.registry.updateCapabilities(f.device, {
      ...f.capability, revision: 'settings-model-removed', sharedProfile: { ...f.profile, models: [] },
    })
    expect(() => forThread(f.threadId, DEFAULT_SERVER_SETTINGS)).toThrow()
  },
)

it('私有原thread不能让另一调用者或管理员继承recipient执行权，其他项目和实例也拒绝', async () => {
  const f = fixture()
  const payload = {
    threadId: f.threadId,
    projectId: 'target',
    modelSelection: {
      instanceId: f.preset.configuration.model.instanceId,
      model: 'isolated-model',
      options: [{ id: 'reasoningEffort', value: 'low' }],
    },
    runtimeMode: 'approval-required',
    workspaceStrategy: { type: 'root' },
  }
  expect(() =>
    authorizeAutoOpsRpc(f.access, f.actor, 'orchestration.launchThread', payload),
  ).not.toThrow()
  for (const actor of ['other', 'manager', 'provider', 'platform']) {
    expect(() =>
      authorizeAutoOpsRpc(
        f.access,
        f.access.authenticateCookie('demo_session=' + actor),
        'orchestration.launchThread',
        payload,
      ),
    ).toThrow()
    expect(await f.resolve(actor)).toBe(false)
  }
  expect(await f.resolve('recipient', { projectId: 'source' })).toBe(false)
  expect(await f.resolve('recipient', { instanceId: 'customer-other-device-codex' })).toBe(false)
  expect(await f.resolve('recipient', { threadId: 'unknown-thread' })).toBe(false)
})

it('未共享或未分配不授予跨项目可用性，撤回后原thread立即拒绝，不能借旧绑定继续', async () => {
  const f = fixture()
  f.directory.assign('manager', 'target', {
    requestId: 'remove-allocation',
    expectedRevision: 1,
    target: { kind: 'member', id: 'recipient' },
    assistantIds: [],
    defaultAssistantId: null,
  })
  expect(await f.resolve()).toBe(false)
  f.directory.assign('manager', 'target', {
    requestId: 'restore-allocation',
    expectedRevision: 2,
    target: { kind: 'member', id: 'recipient' },
    assistantIds: [f.preset.id],
    defaultAssistantId: f.preset.id,
  })
  expect(await f.resolve()).toBe(true)
  f.directory.shareProvided('provider', f.preset.id, 'target', {
    requestId: 'withdraw-share',
    expectedRevision: 1,
    enabled: false,
  })
  expect(await f.resolve()).toBe(false)
  expect(await f.resolve(null)).toBe(false)
  const other = f.access.authenticateCookie('demo_session=other')
  expect(() =>
    f.access.reserveThread(other, {
      threadId: 'unshared-new-thread',
      projectId: 'target',
      environmentId: null,
      agentId: 'a-project',
      visibility: 'private',
      executionBinding: f.target,
      question: {
        assistantId: f.preset.id,
        presetRevision: 1,
        configuration: f.preset.configuration,
      },
    }),
  ).toThrow()
  expect(await f.resolve('other', { threadId: 'unshared-new-thread' })).toBe(false)
})

it('当前profile、模型、在线状态和目录撤回逐次重查，不以旧共享事实当执行许可', async () => {
  const f = fixture()
  f.registry.markDisconnected(f.target.deviceId, f.epoch.connectionEpoch)
  expect(await f.resolve()).toBe(false)
  f.registry.markConnected(f.device)
  expect(await f.resolve()).toBe(true)
  f.registry.updateCapabilities(f.device, {
    ...f.capability,
    revision: 'model-removed',
    sharedProfile: { ...f.profile, models: [] },
  })
  expect(await f.resolve()).toBe(false)
  f.registry.updateCapabilities(f.device, { ...f.capability, revision: 'model-restored' })
  expect(await f.resolve()).toBe(true)
  writeFileSync(f.approval, '[]', { mode: 0o600 })
  expect(await f.resolve()).toBe(false)
})

it('原本人电脑自用保持来源项目与真实目录，不要求共享；后台可信父绑定沿实际recipient而非provider', async () => {
  const f = fixture()
  expect(await f.resolve(null)).toBe(true)
  const actor = f.access.authenticateCookie('demo_session=provider')
  const { customerProfile, ...selfConfiguration } = f.preset.configuration
  const selfPreset = f.directory.saveProvided('provider', null, {
    requestId: 'self-preset',
    expectedRevision: 0,
    value: {
      name: '本人电脑',
      description: '',
      instructions: '',
      enabled: true,
      configuration: {
        ...selfConfiguration,
        model: {
          instanceId: f.preset.configuration.model.instanceId,
          model: 'self-model',
          reasoningEffort: 'high',
        },
      },
    },
  })
  f.access.reserveThread(actor, {
    threadId: 'self-thread',
    projectId: 'source',
    environmentId: null,
    agentId: 'a-project',
    visibility: 'private',
    executionBinding: f.target,
    question: {
      assistantId: selfPreset.id,
      presetRevision: selfPreset.revision,
      configuration: selfPreset.configuration,
    },
  })
  expect(await f.resolve('provider', { projectId: 'source', threadId: 'self-thread' })).toBe(true)
  configured.preferences!.update('provider', { responseStreamingMode: 'turn' })
  f.registry.markDisconnected(f.target.deviceId, f.epoch.connectionEpoch)
  expect(forThread('self-thread', DEFAULT_SERVER_SETTINGS)).toMatchObject({
    responseStreamingMode: 'turn', continueThreadsAfterServerUpdate: false,
    compactIdleThreads: false, autoResumeLimitedThreads: false, snoozeLimitedThreads: false,
  })
  f.registry.revokeWorkspace(f.device, f.target.registeredWorkspaceId)
  expect(() => forThread('self-thread', DEFAULT_SERVER_SETTINGS)).toThrow()
  expect(await f.resolve('provider', { projectId: 'source', threadId: 'self-thread' })).toBe(false)
  expect(await f.resolve(null)).toBe(false)
})
