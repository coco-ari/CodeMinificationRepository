import { useLayoutEffect } from 'react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from '@tanstack/react-router'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render, stubGlobal } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { AppSidebarLayout } from '~/components/AppSidebarLayout'
import { ModuleSidebarProvider, ModuleSidebarOutlet } from './ModuleWorkspace'
import { readAppearanceModePreference, readThemePreference, useTheme } from '~/hooks/useTheme'
import { AutoOpsProjectsPage } from './ProjectsPage'
import { AssistantManagementPage } from './AssistantManagementPage'
import { installAutoOpsHost, type AutoOpsT3Bootstrap } from './hostConfig'
import { RepositorySetupNotice } from './deployment/RepositorySetupNotice'
import { Route as ProjectsRoute } from '../routes/_chat.projects'
import { Route as AssistantsRoute } from '../routes/_chat.assistants'
import { Route as DeploymentsRoute } from '../routes/_chat.deployments'
import '../index.css'
import './theme.css'

vi.mock(import('./projectNavigation'), async (original) => ({
  ...(await original()),
  selectAutoOpsProject: vi.fn(),
}))
vi.mock(import('../localEnvironment'), () => ({ isLocalEnvironmentDisabled: () => true }))

function setup(canCreateProject = true) {
  sessionStorage.clear()
  let assigned = false,
    ready = false,
    failDirectory = false
  const project = {
    id: 'new-project',
    name: '新项目',
    description: '',
    revision: 1,
    createdBy: 'new-account',
    createdAt: '2026-10-28T00:00:00Z',
    environments: [],
  }
  const bootstrap = (): AutoOpsT3Bootstrap => ({
    principal: { id: 'new-account', displayName: '新成员' },
    csrfToken: 'isolated-csrf',
    gatewayBasePath: '/api/agent-demo/t3',
    fixedModel: { instanceId: 'codex', model: 'isolated-model' },
    runtimeMode: 'approval-required',
    canCreateProject,
    assistantDirectoryEnabled: true,
    productProfile: { id: 'project-assistant-lite-v1' },
    capabilities: {},
    projects: assigned
      ? [
          {
            ...project,
            agents: [],
            capabilities: {
              'project.manage': canCreateProject,
              'workspace.read': true,
              'workspace.manage': canCreateProject,
              'deployment.read': canCreateProject,
              'deployment.execute': canCreateProject,
            },
            assistants: {
              items: [],
              defaultAssistantId: null,
              canAdjust: canCreateProject,
              ready,
              ...(ready ? {} : { reason: { code: 'ASSISTANT_REQUIRED', message: '尚无可用助手' } }),
            },
          },
        ]
      : [],
  })
  installAutoOpsHost(bootstrap(), location.origin)
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), location.origin).pathname
    if (path.endsWith('/autoops/bootstrap')) return Response.json(bootstrap())
    if (path.endsWith('/api/v1/projects')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        project.name = body.value.name
        project.description = body.value.description
        assigned = true
        return Response.json(project)
      }
      return failDirectory
        ? Response.json({ error: '项目服务暂时不可用' }, { status: 503 })
        : Response.json({ items: assigned ? [project] : [] })
    }
    if (path.endsWith('/assistants/settings'))
      return Response.json({ presets: [], allocations: [] })
    if (path.endsWith('/assistants/choices'))
      return Response.json({ agents: [], sources: [], platformSkills: [] })
    if (path.endsWith('/settings')) return Response.json({ project, members: [], candidates: [] })
    if (path.endsWith('/repositories')) return Response.json({ revision: 0, items: [] })
    if (path.endsWith('/workspace/credentials')) return Response.json({ credentials: [] })
    if (path.endsWith('/workspace/authoring'))
      return Response.json({
        projectId: project.id,
        revision: 0,
        sources: [],
        entries: [],
        limits: { maxFileBytes: 8000000, maxBytes: 50000000, maxFiles: 100 },
      })
    if (path.endsWith('/assistants/provided')) return Response.json({ items: [] })
    return Response.json({ error: `隔离测试没有定义 ${path}` }, { status: 404 })
  })
  return {
    fetch,
    bootstrap,
    assign: () => {
      assigned = true
    },
    ready: () => {
      ready = true
    },
    fail: (value: boolean) => {
      failDirectory = value
    },
  }
}

function App({ dark = false, fullShell = false }: { dark?: boolean; fullShell?: boolean }) {
  const path = useLocation({ select: (location) => location.pathname })
  const { setAppearanceMode } = useTheme()
  useLayoutEffect(() => {
    const previous = readAppearanceModePreference(readThemePreference())
    setAppearanceMode(dark ? 'dark' : 'light')
    return () => {
      setAppearanceMode(previous)
    }
  }, [dark, setAppearanceMode])
  const content = path === '/assistants' ? <AssistantManagementPage /> : <AutoOpsProjectsPage />
  return fullShell ? (
    <AppSidebarLayout>{content}</AppSidebarLayout>
  ) : (
    <SidebarProvider>
      <ModuleSidebarProvider>
        <ModuleSidebarOutlet />
        {content}
      </ModuleSidebarProvider>
    </SidebarProvider>
  )
}

it.each([
  { width: 1440, dark: false },
  { width: 390, dark: true },
])('新成员在 $width px 从空项目创建并进入下一步配置，取消保留焦点', async ({ width, dark }) => {
  await page.viewport(width, 600)
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App dark={dark} fullShell />, { router: '/projects' })
  const entry = screen.getByRole('region', { name: '开始使用项目' })
  await expect.element(entry.getByText('创建第一个项目', { exact: true })).toBeVisible()
  await page.screenshot({
    path: `../../.test-artifacts/project-onboarding/empty-${width}-${dark ? 'dark' : 'light'}.png`,
  })
  const create = entry.getByRole('button', { name: '创建项目', exact: true })
  await create.click()
  await page
    .getByRole('dialog', { name: '创建项目' })
    .getByRole('button', { name: '取消', exact: true })
    .click()
  await expect.element(create).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  const dialog = page.getByRole('dialog', { name: '创建项目' })
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('华东团队业务服务资料项目')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect
    .poll(() => screen.router?.state.location.href)
    .toBe('/projects?projectId=new-project')
  await expect.element(screen.getByRole('region', { name: '开始使用项目' })).not.toBeInTheDocument()
  await expect.element(screen.getByRole('link', { name: '配置助手', exact: true })).toBeVisible()
  await page.screenshot({
    path: `../../.test-artifacts/project-onboarding/created-${width}-${dark ? 'dark' : 'light'}.png`,
  })
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1)
})

it('无创建权限的新成员看到等待分配，刷新后进入实际授权项目', async () => {
  const f = setup(false)
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects' })
  const entry = screen.getByRole('region', { name: '开始使用项目' })
  await expect.element(entry.getByText('尚未分配项目', { exact: true })).toBeVisible()
  await expect
    .element(screen.getByRole('button', { name: '创建项目', exact: true }))
    .not.toBeInTheDocument()
  f.assign()
  await entry.getByRole('button', { name: '刷新项目', exact: true }).click()
  await screen.getByRole('button', { name: '打开', exact: true }).click()
  await expect.element(screen.getByText('尚无可用助手', { exact: true })).toBeVisible()
  await expect
    .element(screen.getByRole('link', { name: '配置助手', exact: true }))
    .not.toBeInTheDocument()
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
})

it('目录请求失败不能伪装成首次使用，原入口重试后才显示引导', async () => {
  const f = setup()
  f.fail(true)
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects' })
  await expect
    .element(screen.getByRole('alert').getByText('项目服务暂时不可用', { exact: true }))
    .toBeVisible()
  await expect.element(screen.getByRole('region', { name: '开始使用项目' })).not.toBeInTheDocument()
  f.fail(false)
  await screen.getByRole('alert').getByRole('button', { name: '重试', exact: true }).click()
  await expect.element(screen.getByRole('region', { name: '开始使用项目' })).toBeVisible()
})

it('零项目助手页面指向项目管理，显式无权项目仍保留访问错误', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/assistants' })
  await expect.element(screen.getByText('先选择一个项目', { exact: true })).toBeVisible()
  await screen.getByRole('link', { name: '前往项目管理', exact: true }).click()
  await expect.element(screen.getByRole('region', { name: '开始使用项目' })).toBeVisible()
  await screen.router!.navigate({ href: '/assistants?projectId=forbidden' })
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('当前项目不可用或无权访问，请从顶部选择授权项目。')
  await expect.element(screen.getByText('先选择一个项目', { exact: true })).not.toBeInTheDocument()
})

it.each(['', 'forbidden'])(
  '项目目录显式无效 projectId=%s 不显示首次创建引导',
  async (projectId) => {
    const f = setup()
    using _fetch = stubGlobal('fetch', f.fetch)
    await using screen = await render(<App />, { router: `/projects?projectId=${projectId}` })
    await expect.element(screen.getByRole('alert')).toHaveTextContent('项目不存在或无权访问')
    await expect
      .element(screen.getByRole('region', { name: '开始使用项目' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '创建项目', exact: true }))
      .not.toBeInTheDocument()
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  },
)

it('项目配置到助手再返回，刷新真实就绪状态后直接进入问答', async () => {
  const f = setup()
  f.assign()
  installAutoOpsHost(f.bootstrap(), location.origin)
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=new-project' })
  await screen.getByRole('link', { name: '配置助手', exact: true }).click()
  await expect
    .poll(() => screen.router?.state.location.href)
    .toBe('/assistants?projectId=new-project&from=projects')
  await screen.getByRole('link', { name: '返回项目配置', exact: true }).click()
  await expect
    .poll(() => screen.router?.state.location.href)
    .toBe('/projects?projectId=new-project')
  f.ready()
  await screen.getByRole('button', { name: '刷新项目', exact: true }).click()
  await screen.getByRole('link', { name: '开始问答', exact: true }).click()
  await expect.poll(() => screen.router?.state.location.href).toBe('/?projectId=new-project')
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
})

it('部署仓库入口往返助手后保留原项目分组和返回部署', async () => {
  const f = setup()
  f.assign()
  installAutoOpsHost(f.bootstrap(), location.origin)
  using _fetch = stubGlobal('fetch', f.fetch)
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <ModuleSidebarProvider>
          <ModuleSidebarOutlet />
          <Outlet />
        </ModuleSidebarProvider>
      </SidebarProvider>
    ),
  })
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '/deployments',
        validateSearch: DeploymentsRoute.options.validateSearch,
        component: () => <RepositorySetupNotice projectId="new-project" />,
      }),
      createRoute({
        getParentRoute: () => root,
        path: '/projects',
        validateSearch: ProjectsRoute.options.validateSearch,
        component: AutoOpsProjectsPage,
      }),
      createRoute({
        getParentRoute: () => root,
        path: '/assistants',
        validateSearch: AssistantsRoute.options.validateSearch,
        component: AssistantManagementPage,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/deployments?projectId=new-project'] }),
    disableGlobalCatchBoundary: true,
  })
  // 使用正式路由的查询解析，避免测试路由保留实际页面会丢弃的字段。
  await using screen = await render(<RouterProvider router={router} />, { router: false })
  await screen.getByRole('link', { name: '配置项目仓库', exact: true }).click()
  await expect.poll(() => router.state.location.href).toBe(
    '/projects?projectId=new-project&section=git&from=deployments',
  )
  await screen.getByRole('link', { name: '配置助手', exact: true }).click()
  await expect.poll(() => router.state.location.pathname).toBe('/assistants')
  await screen.getByRole('button', { name: '我提供的', exact: true }).click()
  await screen.getByRole('button', { name: '当前项目', exact: true }).click()
  await screen.getByRole('link', { name: '返回项目配置', exact: true }).click()
  await expect.poll(() => router.state.location.href).toBe(
    '/projects?projectId=new-project&section=git&from=deployments',
  )
  await expect.element(screen.getByRole('link', { name: '返回部署', exact: true })).toBeVisible()
  await screen.getByRole('link', { name: '返回部署', exact: true }).click()
  await expect.poll(() => router.state.location.href).toBe('/deployments?projectId=new-project')
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
})

it('助手路由仅保留项目返回白名单，不接收任意返回地址或分组', () => {
  const validate = AssistantsRoute.options.validateSearch
  if (typeof validate !== 'function') throw new Error('助手路由未提供查询解析函数')
  expect(
    validate({
      projectId: 'new-project',
      from: 'projects',
      returnSection: 'git',
      returnFrom: 'deployments',
    }),
  ).toEqual({
    projectId: 'new-project',
    from: 'projects',
    returnSection: 'git',
    returnFrom: 'deployments',
  })
  expect(
    validate({
      projectId: 'new-project',
      from: 'projects',
      returnSection: 'other-project',
      returnFrom: 'https://foreign.invalid/projects',
      returnUrl: 'https://foreign.invalid/projects',
    }),
  ).toEqual({ projectId: 'new-project', from: 'projects' })
  expect(
    validate({
      projectId: 'new-project',
      returnSection: 'git',
      returnFrom: 'deployments',
    }),
  ).toEqual({ projectId: 'new-project' })
})
