import { describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { act, render } from '../../test/render'
import { AutoOpsRequestError } from './apiClient'
import { useCustomerRuntime } from './customerAgents'
import type { AutoOpsThreadScope } from './hostConfig'
const mocks = vi.hoisted(() => ({ request: vi.fn(), host: vi.fn() }))
vi.mock(import('./apiClient'), async (original) => ({
  ...(await original()),
  autoOpsRequest: mocks.request,
}))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}))
const target = {
  kind: 'customer' as const,
  deviceId: 'test-device',
  registeredWorkspaceId: 'test-directory',
  workspaceBindingRevision: 1,
  runtimeId: 'codex' as const,
}
const scope: AutoOpsThreadScope = {
  projectId: 'test-project',
  environmentId: 'test',
  agentId: 'assistant',
  visibility: 'private',
  executionBinding: target,
}
const catalog = {
  ...target,
  revision: 'one',
  protocolVersion: 1,
  updatedAt: '2026-10-24T00:00:00Z',
  models: [{ id: '私有模型', supportedReasoningEfforts: [] }],
  skills: [{ id: 'private', name: '私有skill', description: '测试目录' }],
}
function Harness({ value = scope }: { value?: AutoOpsThreadScope }) {
  const state = useCustomerRuntime(value)
  return (
    <>
      <output>
        {state.catalog?.models.map((model) => model.id).join(',')}
        {state.catalog?.skills.map((skill) => skill.name).join(',')}
      </output>
      <p>{state.error}</p>
      <button onClick={state.refresh}>刷新能力</button>
    </>
  )
}
function setup() {
  mocks.host.mockReset().mockReturnValue({ principal: { id: 'owner-one' } })
  mocks.request
    .mockReset()
    .mockImplementation(async (path: string) =>
      path.includes('/capabilities?') ? { capabilities: catalog } : { devices: [] },
    )
}
describe('客户候选目录的当前授权', () => {
  it.each([401, 403, 404, 503])('读取失败 %i 后移除旧候选，重试恢复新目录', async (status) => {
    setup()
    await using screen = await render(<Harness />)
    await vi.waitFor(() => expect(screen.container.textContent).toContain('私有模型私有skill'))
    mocks.request.mockRejectedValue(new AutoOpsRequestError('目录不可访问', 'DENIED', status))
    await page.getByRole('button', { name: '刷新能力' }).click()
    await vi.waitFor(() => expect(screen.container.textContent).toContain('目录不可访问'))
    expect(screen.container.textContent).not.toContain('私有模型')
    expect(screen.container.textContent).not.toContain('私有skill')
    mocks.request.mockImplementation(async (path: string) =>
      path.includes('/capabilities?')
        ? { capabilities: { ...catalog, skills: [] } }
        : { devices: [] },
    )
    await page.getByRole('button', { name: '刷新能力' }).click()
    await vi.waitFor(() => expect(screen.container.textContent).toContain('私有模型'))
    expect(screen.container.textContent).not.toContain('私有skill')
  })
  it('切账号并重挂载会话后，旧请求迟到不能恢复旧目录', async () => {
    setup()
    let finish!: (value: unknown) => void
    mocks.request.mockImplementation((path: string) =>
      path.includes('/capabilities?')
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve({ devices: [] }),
    )
    await using screen = await render(<Harness />)
    const oldFinish = finish
    mocks.host.mockReturnValue({ principal: { id: 'owner-two' } })
    mocks.request.mockResolvedValue({ capabilities: null, devices: [] })
    await screen.rerender(<Harness key="owner-two" />)
    await act(() => oldFinish({ capabilities: catalog, devices: [] }))
    expect(screen.container.textContent).not.toContain('私有模型')
    expect(screen.container.textContent).not.toContain('私有skill')
  })
})

const assignedScope: AutoOpsThreadScope = {
  ...scope,
  environmentId: null,
  question: {
    assistantId: 'provided-assistant', presetRevision: 3,
    configuration: { agentId: 'assistant', executionBinding: target,
      environmentId: null, workspaceType: null, visibility: 'private',
      model: { instanceId: 'customer-test-device-codex', model: '私有模型', reasoningEffort: null }, skillIds: [] },
  },
}
const assignedRuntime = {
  target, profile: 'linux-docker-readonly-v1', available: true,
  device: { id: target.deviceId, label: '已分配电脑', status: 'active', online: true },
  workspace: { label: '已授权目录', status: 'active' }, capabilities: catalog,
}
describe('项目获分配助手的候选目录', () => {
  it('只读项目助手接口；撤权清除候选并能通过当前授权重试恢复', async () => {
    setup()
    mocks.request.mockResolvedValue(assignedRuntime)
    await using screen = await render(<Harness value={assignedScope} />)
    await vi.waitFor(() => expect(screen.container.textContent).toContain('私有模型私有skill'))
    expect(mocks.request).toHaveBeenCalledWith('/autoops/customer/assistant-runtime', expect.objectContaining({
      body: { projectId: scope.projectId, question: assignedScope.question },
    }))
    expect(mocks.request.mock.calls.every(([path]) => path === '/autoops/customer/assistant-runtime')).toBe(true)
    mocks.request.mockRejectedValue(new AutoOpsRequestError('提供者已撤回共享', 'ASSISTANT_WITHDRAWN', 403))
    await page.getByRole('button', { name: '刷新能力' }).click()
    await vi.waitFor(() => expect(screen.container.textContent).toContain('提供者已撤回共享'))
    expect(screen.container.textContent).not.toContain('私有模型')
    expect(screen.container.textContent).not.toContain('私有skill')
    mocks.request.mockResolvedValue({ ...assignedRuntime, capabilities: { ...catalog, skills: [] } })
    await page.getByRole('button', { name: '刷新能力' }).click()
    await vi.waitFor(() => expect(screen.container.textContent).toContain('私有模型'))
    expect(screen.container.textContent).not.toContain('私有skill')
  })
  it('原模型下线仍显示合法当前目录和错误，不改原选择或冒称可发送', async () => {
    setup()
    mocks.request.mockResolvedValue({ ...assignedRuntime, available: false,
      reason: { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: '原模型已下线，请调整本次配置' },
      capabilities: { ...catalog, models: [{ id: '明确可选新模型', supportedReasoningEfforts: [] }] },
    })
    await using screen = await render(<Harness value={assignedScope} />)
    await vi.waitFor(() => expect(screen.container.textContent).toContain('明确可选新模型'))
    expect(screen.container.textContent).toContain('原模型已下线，请调整本次配置')
    expect(assignedScope.question?.configuration.model.model).toBe('私有模型')
  })
  it('切换项目和助手后旧请求迟到不能恢复旧模型与skill', async () => {
    setup()
    let complete!: (value: unknown) => void
    mocks.request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await using screen = await render(<Harness value={assignedScope} />)
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    const nextScope: AutoOpsThreadScope = { ...assignedScope, projectId: 'second-project',
      question: { ...assignedScope.question!, assistantId: 'second-assistant', presetRevision: 1 } }
    mocks.request.mockResolvedValue({ ...assignedRuntime, capabilities: { ...catalog,
      models: [{ id: '新项目模型', supportedReasoningEfforts: [] }], skills: [] } })
    await screen.rerender(<Harness value={nextScope} />)
    await vi.waitFor(() => expect(screen.container.textContent).toContain('新项目模型'))
    await act(() => complete(assignedRuntime))
    expect(screen.container.textContent).toContain('新项目模型')
    expect(screen.container.textContent).not.toContain('私有模型')
    expect(screen.container.textContent).not.toContain('私有skill')
  })
})


it.each([true, false])('已保存共享会话按threadId读取原电脑目录，不要求独立分配，存在预设=%s', async (hasPreset) => {
  setup()
  mocks.request.mockResolvedValue({...assignedRuntime, profile: 'self'})
  const bound: AutoOpsThreadScope = {...(hasPreset ? assignedScope : scope), threadId: 'shared-original',
    ownerId: 'someone-else', scopeState: 'locked', scopeLocked: true, visibility: 'project'}
  await using screen = await render(<Harness value={bound} />)
  await vi.waitFor(() => expect(screen.container.textContent).toContain('私有模型私有skill'))
  expect(mocks.request).toHaveBeenCalledWith('/autoops/customer/assistant-runtime', expect.objectContaining({body:{threadId:'shared-original'}}))
  expect(mocks.request.mock.calls.every(([path]) => path === '/autoops/customer/assistant-runtime')).toBe(true)
  mocks.request.mockRejectedValue(new AutoOpsRequestError('会话不存在或无权访问','THREAD_NOT_FOUND',404))
  await page.getByRole('button', {name:'刷新能力'}).click()
  await vi.waitFor(() => expect(screen.container.textContent).not.toContain('私有模型'))
  expect(screen.container.textContent).toContain('会话不存在或无权访问')
})
