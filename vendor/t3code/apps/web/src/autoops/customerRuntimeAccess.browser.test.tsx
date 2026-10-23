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
  skills: [{ id: 'private', name: '私有技能', description: '测试目录' }],
}
function Harness() {
  const state = useCustomerRuntime(scope)
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
  for (const status of [401, 403, 404, 503]) {
    it(`读取失败 ${status} 后移除旧候选，重试恢复新目录`, async () => {
      setup()
      await using screen = await render(<Harness />)
      await vi.waitFor(() => expect(screen.container.textContent).toContain('私有模型私有技能'))
      mocks.request.mockRejectedValue(new AutoOpsRequestError('目录不可访问', 'DENIED', status))
      await page.getByRole('button', { name: '刷新能力' }).click()
      await vi.waitFor(() => expect(screen.container.textContent).toContain('目录不可访问'))
      expect(screen.container.textContent).not.toContain('私有模型')
      expect(screen.container.textContent).not.toContain('私有技能')
      mocks.request.mockImplementation(async (path: string) =>
        path.includes('/capabilities?')
          ? { capabilities: { ...catalog, skills: [] } }
          : { devices: [] },
      )
      await page.getByRole('button', { name: '刷新能力' }).click()
      await vi.waitFor(() => expect(screen.container.textContent).toContain('私有模型'))
      expect(screen.container.textContent).not.toContain('私有技能')
    })
  }
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
    expect(screen.container.textContent).not.toContain('私有技能')
  })
})
