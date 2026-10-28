import type { ComponentProps, ReactNode, CSSProperties } from 'react'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { render } from '../../test/render'
import { AutoOpsWorkspacesPage } from './WorkspacesPage'
import { SidebarProvider } from '~/components/ui/sidebar'
import { ModuleSidebarProvider, ModuleSidebarOutlet } from './ModuleWorkspace'
import type { WorkspaceOverview } from './workspaces'
import type { WorkspaceFileBrowser } from './WorkspaceFileBrowser'
import type { WorkspaceAuthoring } from './WorkspaceAuthoringPanel'
import '../index.css'
const mocks = vi.hoisted(() => ({
  host: vi.fn(),
  overview: vi.fn(),
  refresh: vi.fn(),
  submit: vi.fn(),
}))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}))
vi.mock(import('./hostSnapshot'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}))
vi.mock(import('./projectNavigation'), async (original) => ({
  ...(await original()),
  useAutoOpsProjectId: () => 'p-one',
}))
vi.mock(import('./useWorkspaceOverview'), () => ({
  useWorkspaceOverview: () => ({
    overview: mocks.overview(),
    loadError: null,
    refreshOverview: mocks.refresh,
  }),
}))
vi.mock(import('./useWorkspaceTaskSubmission'), () => ({
  useWorkspaceTaskSubmission: () => ({
    busy: false,
    error: null,
    submit: mocks.submit,
    pendingLabel: null,
    recoveryPaused: false,
    retryAvailable: false,
    check: async () => false,
    retry: async () => false,
  }),
}))
vi.mock(import('./WorkspaceUpdateDialog'), () => ({ WorkspaceUpdateDialog: () => <></> }))
vi.mock(import('./WorkspaceAuthoringPanel'), () => ({
  WorkspaceAuthoring: ({ navigation, menuItems }: ComponentProps<typeof WorkspaceAuthoring>) => (
    <div>
      {navigation}
      <div role="menu">{menuItems as ReactNode}</div>
    </div>
  ),
}))
vi.mock(import('./WorkspaceFileBrowser'), () => ({
  WorkspaceFileBrowser: ({ version, onRefresh }: ComponentProps<typeof WorkspaceFileBrowser>) => (
    <section aria-label="当前文件">
      <output>{version.id}</output>
      <input aria-label="搜索文件" />
      <button onClick={onRefresh}>刷新文件</button>
    </section>
  ),
}))
const overview: WorkspaceOverview = {
  projectId: 'p-one',
  internalVersions: [],
  externalVersions: [
    {
      id: 'current-one',
      name: '外部脱敏 v003',
      type: 'external',
      status: 'published',
      createdAt: '2026-10-29T00:00:00Z',
      fileCount: 1,
      byteLength: 10,
      source: { repositories: [], contentHash: 'test' },
    },
  ],
  tasks: [],
  releases: [],
  import: { supported: true, hosts: [], maxBytes: 10, maxFiles: 10 },
}
function App() {
  return (
    <SidebarProvider
      style={
        {
          width: 1100,
          height: 700,
          '--workspace-topbar-height': '44px',
          '--workspace-gutter-start': '16px',
          '--workspace-gutter-end': '16px',
        } as CSSProperties
      }
    >
      <ModuleSidebarProvider>
        <aside style={{ width: 180, flexShrink: 0 }}>
          <ModuleSidebarOutlet />
        </aside>
        <AutoOpsWorkspacesPage />
      </ModuleSidebarProvider>
    </SidebarProvider>
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
  mocks.host.mockReturnValue({
    principal: { id: 'owner' },
    projects: [
      {
        id: 'p-one',
        name: '测试项目',
        membership: { workspaceAccess: 'internal' },
        capabilities: {
          'workspace.read': true,
          'workspace.manage': true,
          'workspace.external.publish': true,
        },
      },
    ],
  })
  mocks.overview.mockReturnValue(overview)
  sessionStorage.setItem('autoops:workspaces:owner:p-one:tab', 'external')
})
it('外部只显示当前资料与一次刷新，更新直接提交并保留搜索，不再提供历史复核任务或会话', async () => {
  await using screen = await render(<App />)
  await expect.element(page.getByRole('heading', { name: '外部工作区', exact: true })).toBeVisible()
  expect(screen.container.textContent).not.toMatch(/v003|复核|任务记录|新建对话/)
  await page.getByRole('button', { name: '刷新文件' }).click()
  expect(mocks.refresh).toHaveBeenCalledTimes(1)
  await expect
    .element(page.getByRole('button', { name: '刷新工作区', exact: true }))
    .not.toBeInTheDocument()
  await page.getByRole('textbox', { name: '搜索文件' }).fill('README')
  await page.getByRole('button', { name: '更新外部工作区', exact: true }).click()
  expect(mocks.submit).toHaveBeenCalledWith({ type: 'external' })
  await page.getByRole('button', { name: '外部工作区操作' }).click()
  await expect.element(page.getByRole('menuitem', { name: '更新设置与脱敏规则' })).toBeVisible()
  await expect.element(page.getByRole('menuitem', { name: '任务记录' })).not.toBeInTheDocument()
})
it('外部只读成员保留当前目录和搜索，不出现更新或管理入口', async () => {
  const host = mocks.host()
  host.projects[0].membership.workspaceAccess = 'external'
  host.projects[0].capabilities['workspace.manage'] = false
  host.projects[0].capabilities['workspace.external.publish'] = false
  await using screen = await render(<App />)
  await expect.element(page.getByRole('textbox', { name: '搜索文件' })).toBeVisible()
  await expect
    .element(page.getByRole('button', { name: '更新外部工作区', exact: true }))
    .not.toBeInTheDocument()
  expect(screen.container.textContent).not.toMatch(/内部工作区|任务记录|新建对话/)
})
