import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { render } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { ProjectAreaTopbar } from './ProjectAreaNavigation'
import { WorkspaceScopeControl } from './WorkspaceScopeControl'
import { ConversationWorkspaceControl } from './ConversationWorkspaceControl'
import type { AutoOpsThreadScope } from './hostConfig'
import type { WorkspaceOverview } from './workspaces'
import '../index.css'

const mocks = vi.hoisted(() => ({
  readHost: vi.fn(),
  load: vi.fn(),
  selectProject: vi.fn(),
  storedScope: vi.fn(),
}))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.readHost,
  readAutoOpsThreadScope: mocks.storedScope,
}))
vi.mock(import('./projectNavigation'), async (original) => ({
  ...(await original()),
  useAutoOpsProjectId: () => 'p-one',
  selectAutoOpsProject: mocks.selectProject,
  autoOpsProjectHref: (area: string, projectId: string) =>
    (area === 'chat' ? '/' : '/' + area) + '?projectId=' + projectId,
}))
vi.mock(import('./workspaces'), async (original) => ({
  ...(await original()),
  loadWorkspaces: mocks.load,
}))
vi.mock(import('./customerAgents'), async (original) => ({
  ...(await original()),
  loadCustomerWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  customerRequest: async <T,>() => ({ devices: [] }) as T,
}))

const permissions = (read = true, manage = true, deploy = true) => ({
  'workspace.read': read,
  'workspace.manage': manage,
  'deployment.read': deploy,
  'deployment.execute': deploy,
})
const project = (id: string, name: string, capabilities = permissions()) => ({
  id,
  name,
  capabilities,
  environments: [{ id: 'env-test', name: '测试环境' }],
  agents: [],
  membership: { role: 'manager', workspaceAccess: 'internal', environmentIds: ['env-test'] },
})
const host = () => ({
  principal: { id: 'owner', displayName: '测试用户' },
  gatewayBasePath: '/api/agent-demo/t3',
  csrfToken: 'isolated-test-token',
  fixedModel: { instanceId: 'codex', model: 'test-model' },
  runtimeMode: 'approval-required',
  capabilities: {},
  projects: [project('p-one', '当前项目'), project('p-two', '目标项目')],
})
const overview = (): WorkspaceOverview => ({
  projectId: 'p-one',
  import: { supported: true, hosts: ['isolated.invalid'], maxBytes: 1000000, maxFiles: 100 },
  internalVersions: [
    {
      id: 'v-one',
      name: '当前工作区版本',
      type: 'internal',
      status: 'published',
      createdAt: '2026-10-23T00:00:00Z',
      fileCount: 1,
      byteLength: 1,
      source: { repositories: [], contentHash: 'test-hash' },
    },
  ],
  externalVersions: [],
  releases: [],
  tasks: [],
})
const scope = (projectId = 'p-one'): AutoOpsThreadScope => ({
  projectId,
  environmentId: 'env-test',
  agentId: 'agent-one',
  visibility: 'private',
  workspaceVersionId: 'v-one',
  workspaceType: 'internal',
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.readHost.mockReturnValue(host())
  mocks.load.mockResolvedValue(overview())
  mocks.storedScope.mockImplementation((_threadId, projectId) => scope(projectId))
})

describe('项目入口使用服务端 capabilities', () => {
  for (const Control of [WorkspaceScopeControl, ConversationWorkspaceControl]) {
    it(Control.name + '在旧会话锁定范围后仍明确新轮读取当前工作区', async () => {
      await using screen = await render(
        <Control
          projectId="p-one"
          scope={{ ...scope(), scopeLocked: true }}
          locked
          disabled={false}
          onChange={vi.fn()}
        />,
      )
      await expect.element(screen.getByText('内部原始 · 当前工作区', { exact: true })).toBeVisible()
      expect(screen.container.textContent).not.toContain('历史输入')
      expect(screen.container.textContent).not.toContain('v-one')
    })
  }
  it('切项目时忽略旧角色显示，仅进入目标项目实际允许的模块', async () => {
    const value = host()
    value.projects[1]!.capabilities = permissions(false, false, false)
    mocks.readHost.mockReturnValue(value)
    await using screen = await render(
      <SidebarProvider>
        <ProjectAreaTopbar />
      </SidebarProvider>,
      { router: '/deployments?projectId=p-one' },
    )
    await screen.getByRole('button', { name: '切换项目' }).click()
    await page.getByRole('option', { name: '目标项目', exact: true }).click()
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe('/'))
    expect(screen.router?.state.location.search).toEqual({ projectId: 'p-two' })
    expect(mocks.selectProject).toHaveBeenCalledWith('p-two')
  })

  it('旧角色为成员但服务端允许部署时，切项目保留部署入口', async () => {
    const value = host()
    value.projects[1]!.membership.role = 'member'
    mocks.readHost.mockReturnValue(value)
    await using screen = await render(
      <SidebarProvider>
        <ProjectAreaTopbar />
      </SidebarProvider>,
      { router: '/deployments?projectId=p-one' },
    )
    await screen.getByRole('button', { name: '切换项目' }).click()
    await page.getByRole('option', { name: '目标项目', exact: true }).click()
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe('/deployments'))
    expect(screen.router?.state.location.search).toEqual({ projectId: 'p-two' })
  })

  it('问答工作区的查看入口绑定原项目，不因旧管理员角色变为管理入口', async () => {
    const value = host()
    value.projects[0]!.capabilities = permissions(true, false, false)
    mocks.readHost.mockReturnValue(value)
    await using screen = await render(
      <WorkspaceScopeControl
        projectId="p-one"
        scope={scope()}
        locked={false}
        disabled={false}
        onChange={vi.fn()}
      />,
    )
    await screen.getByRole('button', { name: '对话工作区' }).click()
    await expect
      .element(page.getByRole('menuitem', { name: '管理工作区', exact: true }))
      .not.toBeInTheDocument()
    await page.getByRole('menuitem', { name: '查看工作区', exact: true }).click()
    await vi.waitFor(() =>
      expect(screen.router?.state.location.search).toEqual({ projectId: 'p-one' }),
    )
  })

  it('缺少读取能力时不请求工作区，也不展示绕过导航的入口', async () => {
    const value = host()
    value.projects[0]!.capabilities = permissions(false, false, false)
    mocks.readHost.mockReturnValue(value)
    await using screen = await render(
      <ConversationWorkspaceControl
        projectId="p-one"
        scope={scope()}
        locked={false}
        disabled={false}
        onChange={vi.fn()}
      />,
    )
    await screen.getByRole('button', { name: '对话工作区' }).click()
    await expect
      .element(page.getByRole('menuitem', { name: '查看平台工作区', exact: true }))
      .not.toBeInTheDocument()
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('无需版本即可选择当前范围，切项目后不携带旧输入身份', async () => {
    const change = vi.fn()
    await using screen = await render(
      <WorkspaceScopeControl
        projectId="p-one"
        scope={{ ...scope(), workspaceVersionId: undefined }}
        locked={false}
        disabled={false}
        onChange={change}
      />,
    )
    await screen.getByRole('button', { name: '对话工作区' }).click()
    await page
      .getByRole('menuitemradio', { name: '外部脱敏 · 当前已发布资料', exact: true })
      .click()
    expect(change).toHaveBeenCalledWith('external')
    expect(mocks.load).not.toHaveBeenCalled()
    const value = host()
    value.projects[1]!.membership.workspaceAccess = 'external'
    mocks.readHost.mockReturnValue(value)
    await screen.rerender(
      <WorkspaceScopeControl
        projectId="p-two"
        scope={{ ...scope('p-two'), workspaceType: 'external', workspaceVersionId: undefined }}
        locked={false}
        disabled={false}
        onChange={change}
      />,
    )
    await screen.getByRole('button', { name: '对话工作区' }).click()
    await expect
      .element(page.getByRole('menuitemradio', { name: '内部原始 · 当前工作区', exact: true }))
      .not.toBeInTheDocument()
    await expect
      .element(page.getByRole('menuitemradio', { name: '外部脱敏 · 当前已发布资料', exact: true }))
      .toBeVisible()
    expect(screen.container.textContent).not.toContain('当前工作区版本')
  })
})
