import { expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { render } from '../../test/render'
import { ConversationWorkspaceControl } from './ConversationWorkspaceControl'
import type { AutoOpsThreadScope } from './hostConfig'
import type { WorkspaceOverview } from './workspaces'
const mocks = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock(import('./workspaces'), async (original) => ({
  ...(await original()),
  loadWorkspaces: mocks.load,
}))
vi.mock(import('./customerAgents'), async (original) => ({
  ...(await original()),
  loadCustomerWorkspaces: async () => ({ workspaces: [] }),
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
  workspaceType: 'internal',
  workspaceVersionId: 'version',
}
it('固定会话读取失败后可重试，恢复显示但不改变绑定', async () => {
  const change = vi.fn()
  const initialize = vi.fn()
  mocks.load.mockReset().mockRejectedValue(new Error('目录暂时无法读取'))
  await using screen = await render(
    <ConversationWorkspaceControl
      threadId="thread"
      projectId="project"
      scope={scope}
      locked
      disabled={false}
      onChange={change}
      onInitialize={initialize}
    />,
  )
  await expect.element(page.getByRole('button', { name: '工作区读取失败，重试' })).toBeVisible()
  mocks.load.mockResolvedValue({
    projectId: 'project',
    internalVersions: [
      { id: 'version', name: '已绑定版本', type: 'internal', status: 'published' },
    ],
    externalVersions: [],
  } as unknown as WorkspaceOverview)
  await page.getByRole('button', { name: '工作区读取失败，重试' }).click()
  await vi.waitFor(() => expect(screen.container.textContent).toContain('已绑定版本'))
  expect(screen.container.querySelector('[role="alert"]')).toBeNull()
  expect(change).not.toHaveBeenCalled()
  expect(initialize).not.toHaveBeenCalled()
})
