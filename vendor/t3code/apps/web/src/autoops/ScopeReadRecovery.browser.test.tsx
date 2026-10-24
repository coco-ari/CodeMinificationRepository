import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render } from '../../test/render'
import { ConversationWorkspaceControl } from './ConversationWorkspaceControl'
import type { AutoOpsThreadScope } from './hostConfig'
const mocks = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock(import('./customerAgents'), async (original) => ({
  ...(await original()),
  loadCustomerWorkspaces: mocks.load,
  customerRequest: vi.fn().mockResolvedValue({ devices: [] }),
}))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: () =>
    ({
      principal: { id: 'owner' },
      projects: [{ id: 'project', capabilities: { 'workspace.read': true } }],
    }) as never,
}))
const scope: AutoOpsThreadScope = {
  projectId: 'project',
  environmentId: 'test',
  agentId: 'assistant',
  visibility: 'private',
  scopeLocked: true,
  executionBinding: {
    kind: 'customer',
    deviceId: 'device',
    registeredWorkspaceId: 'workspace',
    workspaceBindingRevision: 1,
    runtimeId: 'codex',
  },
}
it('客户工作区读取失败后可用键盘重试，恢复显示但不改变固定绑定', async () => {
  const change = vi.fn()
  mocks.load.mockReset().mockRejectedValue(new Error('目录暂时无法读取'))
  await using screen = await render(
    <ConversationWorkspaceControl
      projectId="project"
      scope={scope}
      locked
      disabled={false}
      onChange={change}
    />,
  )
  await expect.element(page.getByRole('button', { name: '工作区读取失败，重试' })).toBeVisible()
  mocks.load.mockResolvedValue({
    workspaces: [{ ...scope.executionBinding, label: '已登记测试目录', status: 'active' }],
  })
  await userEvent.tab()
  await expect.element(page.getByRole('button', { name: '工作区读取失败，重试' })).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(screen.container.textContent).toContain('已登记测试目录'))
  expect(screen.container.querySelector('[role="alert"]')).toBeNull()
  expect(change).not.toHaveBeenCalled()
})
