import type { ReactNode } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { render } from '../../test/render'
import { SidebarProvider } from '../components/ui/sidebar'
import type { AutoOpsHost } from '../autoops/hostSnapshot'
import '../index.css'

type Projects = ReturnType<typeof import('../state/entities').readProjects>
const mocks = vi.hoisted(() => ({
  host: vi.fn<() => AutoOpsHost | undefined>(),
  createThread: vi.fn(),
  projects: [] as Projects,
  selectedProjectId: '',
  bootstrapped: true,
  authStatus: 'authenticated',
  environmentsReady: true,
}))

// 保留真实路由导航，只隔离本页面所属父路由的认证上下文。
vi.mock(import('@tanstack/react-router'), async (original) => ({
  ...(await original()),
  createFileRoute: (() => (options: { component: () => ReactNode }) => ({
    options,
    useRouteContext: () => ({ authGateState: { status: mocks.authStatus } }),
  })) as never,
}))
vi.mock(import('../autoops/hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
  useAutoOpsHost: mocks.host,
}))
vi.mock(import('../autoops/projectNavigation'), async (original) => ({
  ...(await original()),
  useAutoOpsProjectId: () => mocks.selectedProjectId,
}))
// 原生实体订阅和创建草稿入口由其他用例覆盖；此处核对是否错误调用。
vi.mock(import('../state/entities'), async (original) => ({
  ...(await original()),
  useProjects: () => mocks.projects,
  useThreadShells: () => [],
  useAllEnvironmentShellsBootstrapped: () => mocks.bootstrapped,
  readProject: (ref: { environmentId: string; projectId: string }) =>
    mocks.projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    ) ?? null,
}))
vi.mock(import('../hooks/useHandleNewThread'), () => ({
  useNewThreadHandler: () => mocks.createThread,
}))
vi.mock(import('../state/environments'), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [], isReady: mocks.environmentsReady })) as never,
}))
// 独立 T3 的资源连接流程不属于本批次，保留可见标记以验证没有错误接管。
vi.mock(import('../components/NoProjectsHero'), () => ({
  NoProjectsHero: () => <p>独立 T3 项目入口</p>,
}))
vi.mock(import('../components/HostedEmptyState'), () => ({
  HostedEmptyState: () => <p>独立 T3 连接入口</p>,
}))

import { Route } from '../routes/_chat.index'

const IndexPage = Route.options.component!
const nativeProject = {
  id: 'existing-project',
  environmentId: 'native-environment',
  title: '已有项目',
  createdAt: '2026-10-28T00:00:00Z',
  updatedAt: '2026-10-28T00:00:00Z',
} as Projects[number]

function setup({ canCreateProject = true, existing = false, hosted = true } = {}) {
  mocks.createThread.mockReset().mockResolvedValue({ draftId: 'new-draft', threadId: 'new-thread' })
  mocks.projects = existing ? [nativeProject] : []
  mocks.selectedProjectId = existing ? nativeProject.id : ''
  mocks.bootstrapped = true
  mocks.authStatus = 'authenticated'
  mocks.environmentsReady = true
  mocks.host.mockReset().mockReturnValue(
    hosted
      ? {
          principal: { id: 'onboarding-member', displayName: '新成员' },
          gatewayBasePath: '/api/agent-demo/t3',
          httpBaseUrl: 'https://isolated.invalid/api/agent-demo/t3',
          wsBaseUrl: 'wss://isolated.invalid/api/agent-demo/t3/ws',
          csrfToken: 'isolated-onboarding-token',
          fixedModel: { instanceId: 'codex', model: 'isolated-model' },
          runtimeMode: 'approval-required',
          canCreateProject,
          capabilities: {},
          projects: existing
            ? [{ id: nativeProject.id, name: '已有项目', environments: [], agents: [] }]
            : [],
        }
      : undefined,
  )
}

function App() {
  return (
    <SidebarProvider>
      <IndexPage />
    </SidebarProvider>
  )
}

it.each([true, false])(
  '零项目新账号进入项目引导且替换首页历史，创建权限为 %s',
  async (canCreateProject) => {
    setup({ canCreateProject })
    await using screen = await render(<App />, { router: '/' })
    await expect.poll(() => screen.router?.state.location.pathname).toBe('/projects')
    expect(screen.router?.history.length).toBe(1)
    expect(mocks.createThread).not.toHaveBeenCalled()
  },
)

it.each([
  { existing: false, query: 'projectId=forbidden' },
  { existing: false, query: 'projectId=' },
  { existing: true, query: 'projectId=forbidden' },
])(
  '显式不可访问项目保持拒绝且不改到引导或其他项目：$query，已有项目 $existing',
  async ({ existing, query }) => {
    setup({ existing })
    mocks.selectedProjectId = ''
    const href = `/?${query}`
    await using screen = await render(<App />, { router: href })
    await expect.element(screen.getByText('项目不可用或无权访问', { exact: true })).toBeVisible()
    expect(screen.router?.state.location.href).toBe(href)
    expect(mocks.createThread).not.toHaveBeenCalled()
  },
)

it('已有项目沿用原生草稿入口，不跳项目引导且只启动一次', async () => {
  setup({ existing: true })
  await using screen = await render(<App />, { router: '/' })
  await expect.poll(() => mocks.createThread.mock.calls.length).toBe(1)
  expect(mocks.createThread).toHaveBeenCalledWith(
    { environmentId: 'native-environment', projectId: 'existing-project' },
    { replace: true },
  )
  expect(screen.router?.state.location.pathname).toBe('/')
})

it('尚未安装宿主上下文时不推断为零项目账号', async () => {
  setup({ hosted: false })
  await using screen = await render(<App />, { router: '/' })
  await expect.element(screen.getByText('独立 T3 项目入口', { exact: true })).toBeVisible()
  expect(screen.router?.state.location.pathname).toBe('/')
  expect(mocks.createThread).not.toHaveBeenCalled()
})

it('独立 T3 已有项目继续通过原生入口启动草稿', async () => {
  setup({ hosted: false, existing: true })
  await using screen = await render(<App />, { router: '/' })
  await expect.poll(() => mocks.createThread.mock.calls.length).toBe(1)
  expect(mocks.createThread).toHaveBeenCalledWith(
    { environmentId: 'native-environment', projectId: 'existing-project' },
    { replace: true },
  )
  expect(screen.router?.state.location.pathname).toBe('/')
})

it('认证未进入已认证态时保留连接入口，不当成项目配置缺失', async () => {
  setup()
  mocks.authStatus = 'hosted-static'
  await using screen = await render(<App />, { router: '/' })
  await expect.element(screen.getByText('独立 T3 连接入口', { exact: true })).toBeVisible()
  expect(screen.router?.state.location.pathname).toBe('/')
  expect(mocks.createThread).not.toHaveBeenCalled()
})
