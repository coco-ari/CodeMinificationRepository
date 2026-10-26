import { ProviderInstanceId } from '@t3tools/contracts'
import type { AssistantSelection } from '../../../../../../autoops/contracts/assistants.ts'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type { AssistantPreset } from './projectAssistants'
const preset = (): AssistantPreset => ({
  id: 'approved-helper',
  projectId: 'project',
  name: '获准助手',
  description: '',
  instructions: '',
  enabled: true,
  revision: 3,
  createdBy: 'admin',
  updatedAt: 'now',
  configuration: {
    agentId: 'a-project',
    executionBinding: { kind: 'platform' },
    environmentId: 'test',
    workspaceType: 'internal',
    visibility: 'private',
    model: { instanceId: 'codex', model: 'actual-model', reasoningEffort: 'low' },
    skillIds: ['allowed-skill'],
  },
})
const bootstrap = (adjust = false) => ({
  principal: { id: 'question-user', displayName: '问答用户' },
  csrfToken: 'csrf',
  gatewayBasePath: '/api/agent-demo/t3',
  fixedModel: { instanceId: 'codex', model: 'wrong-platform-default' },
  runtimeMode: 'approval-required' as const,
  assistantDirectoryEnabled: true,
  capabilities: {},
  projects: [
    {
      id: 'project',
      name: '项目',
      environments: [{ id: 'test', name: '测试' }],
      agents: [{ id: 'a-project', name: '业务助手' }],
      capabilities: {
        'workspace.read': true,
        'workspace.manage': false,
        'deployment.read': false,
        'deployment.execute': false,
        'chat.configure': adjust,
      },
      membership: {
        role: 'reader' as const,
        workspaceAccess: 'internal' as const,
        environmentIds: ['test'],
        canAdjustChat: adjust,
      },
      assistants: {
        items: [{ preset: preset(), available: true }],
        defaultAssistantId: 'approved-helper',
        canAdjust: adjust,
        ready: true,
      },
    },
  ],
})
function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
    clear: () => values.clear(),
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('受限默认助手带入同一草稿合同，配置只读，撤回后不能发送但保留原选择', async () => {
  const host = await import('./hostConfig'),
    policy = await import('./questionConfiguration')
  const value = bootstrap()
  host.installAutoOpsHost(value, 'https://work.test')
  const scope = host.readAutoOpsThreadScope('new', 'project')!
  expect(scope.question).toEqual({
    assistantId: 'approved-helper',
    presetRevision: 3,
    configuration: preset().configuration,
  })
  expect(policy.questionCanAdjust(scope)).toBe(false)
  expect(policy.questionSendDisabledReason(scope)).toBeNull()
  const withdrawn = bootstrap()
  withdrawn.projects[0]!.assistants.items = []
  host.installAutoOpsHost(withdrawn, 'https://work.test')
  expect(policy.questionSendDisabledReason(scope)).toBe('此助手分配已撤回，请刷新后选择。')
  expect(scope.question?.assistantId).toBe('approved-helper')
})

it('唯一默认缺失时不选择列表首项，即使有一个候选也不能启用受限问答', async () => {
  const host = await import('./hostConfig'),
    policy = await import('./questionConfiguration')
  const value = bootstrap()
  Object.assign(value.projects[0]!.assistants, {
    ready: false,
    defaultAssistantId: null,
    reason: { code: 'DEFAULT_ASSISTANT_REQUIRED', message: '请管理员设置默认助手' },
  })
  host.installAutoOpsHost(value, 'https://work.test')
  const scope = host.readAutoOpsThreadScope('without-default', 'project')!
  expect(scope.question).toBeUndefined()
  expect(policy.questionSendDisabledReason(scope)).toBe('请管理员设置默认助手')
})

it('新建发送带入实际调整后的模型和强度，既不覆盖为预设，也不取平台默认', async () => {
  vi.stubGlobal('window', { localStorage: storage(), location: { origin: 'https://work.test' } })
  const host = await import('./hostConfig'),
    runtime = await import('@t3tools/client-runtime/host-integration')
  host.installAutoOpsHost(bootstrap(true), 'https://work.test')
  const original = preset(),
    desired = host.scopeFromAssistant(original)
  host.setAutoOpsThreadScope('adjusted-draft', desired)
  const bodies: Array<{ question?: AssistantSelection }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      if (init?.method !== 'POST')
        return Response.json({ code: 'THREAD_NOT_FOUND', error: '未预约' }, { status: 404 })
      const body = JSON.parse(init.body)
      bodies.push(body)
      return Response.json({ binding: { ...body, scopeState: 'draft' } })
    }),
  )
  expect(runtime.readHostTurnConfiguration({ threadId: 'adjusted-draft' })).toEqual({
    runtimeMode: 'approval-required',
  })
  await runtime.prepareHostThreadLaunch({
    threadId: 'adjusted-draft',
    projectId: 'project',
    modelSelection: {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'actual-model',
      options: [{ id: 'reasoningEffort', value: 'high' }],
    },
  })
  expect(bodies[0]?.question).toMatchObject({
    assistantId: 'approved-helper',
    presetRevision: 3,
    configuration: {
      model: { instanceId: 'codex', model: 'actual-model', reasoningEffort: 'high' },
    },
  })
  expect(original.configuration.model.reasoningEffort).toBe('low')
})

it('首条接受后的预设更新不改写旧参数，当前停用仍阻止发送', async () => {
  const host = await import('./hostConfig'),
    policy = await import('./questionConfiguration')
  const value = bootstrap(true),
    scope = { ...host.scopeFromAssistant(preset()), scopeState: 'locked' as const }
  const item = value.projects[0]!.assistants.items[0]!
  item.preset = {
    ...item.preset,
    revision: 4,
    configuration: {
      ...item.preset.configuration,
      model: { ...item.preset.configuration.model, reasoningEffort: 'high' },
    },
  }
  host.installAutoOpsHost(value, 'https://work.test')
  expect(policy.questionSendDisabledReason(scope)).toBeNull()
  expect(scope.question?.configuration.model.reasoningEffort).toBe('low')
  item.preset = { ...item.preset, enabled: false }
  host.installAutoOpsHost(value, 'https://work.test')
  expect(policy.questionSendDisabledReason(scope)).toBe('助手已停用，请联系项目管理员。')
})
