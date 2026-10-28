import { StrictMode, useLayoutEffect } from 'react'
import { useLocation } from '@tanstack/react-router'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { fakeTimers, render, stubGlobal } from '../../test/render'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { projectAssistantReceiptIntent } from '../../../../../../autoops/contracts/project-management-receipts.ts'
import { SidebarProvider } from '~/components/ui/sidebar'
import { AppSidebarLayout } from '~/components/AppSidebarLayout'
import { readAppearanceModePreference, readThemePreference, useTheme } from '~/hooks/useTheme'
import { ModuleSidebarProvider, ModuleSidebarOutlet } from './ModuleWorkspace'
import { AutoOpsProjectsPage } from './ProjectsPage'
import { DeploymentsPanel } from './DeploymentsPanel'
import type { ProjectRepositoryConnection } from './projectRepositories'
import type { StaticDeploymentConfig } from './deployments'
import { installAutoOpsHost, readAutoOpsHost } from './hostConfig'
import { prepareProjectMutation, prepareProjectWrite, submitProjectWrite, readPendingProjectWrite } from "./projectDirectory";
import '../index.css'
import './theme.css'

const mocks = vi.hoisted(() => ({ select: vi.fn() }))
vi.mock(import('./projectNavigation'), async (original) => ({ ...(await original()), selectAutoOpsProject: mocks.select,
}))
function setup({ manage = true, failFirst = false, loseResponse = false, manageNodes = false, projectName = '原项目', lite = false } = {}) {
  mocks.select.mockReset()
  window.sessionStorage.clear()
  let fail = failFirst, lost = loseResponse, writes = 0,
    receiptMode: "completed" | "missing" | "unavailable" | "mismatch" = "completed",
    currentManage = manage,
    revokeOnReceipt = false;
  const queries: string[] = [],
    receipts = new Map<string, object>();
  const bodies: object[] = []
  const project = { id: 'directory-project', name: projectName, description: '', revision: 1, createdBy: 'directory-owner', createdAt: '2026-10-26T00:00:00Z', environments: [{ id: 'test', name: '测试环境', revision: 1 }],
  }
  const bootstrap = () => ({
    canManageDeploymentNodes: manageNodes,
    ...(lite ? { productProfile: { id: 'project-assistant-lite-v1' as const } } : {}),
    principal: { id: 'directory-owner', displayName: '目录用户' }, csrfToken: 'test-csrf', gatewayBasePath: '/api/agent-demo/t3', fixedModel: { instanceId: 'codex', model: 'test-model' }, runtimeMode: 'approval-required' as const, canCreateProject: true, capabilities: {},
    projects: [{ ...project, agents: [], capabilities: { 'project.manage': currentManage, 'workspace.read': true, 'workspace.manage': currentManage, 'deployment.read': true, 'deployment.execute': currentManage,
        },
      },
    ],
  })
  installAutoOpsHost(bootstrap(), window.location.origin)
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/projects/receipts/")) {
      queries.push(url);
      if (receiptMode === "missing") return Response.json(null);
      if (receiptMode === "unavailable")
        return Response.json({ error: "收据服务暂不可用" }, { status: 503 });
      if (revokeOnReceipt) currentManage = false;
      const result = receipts.get(decodeURIComponent(url.split("/").at(-1)!));
      return Response.json(
        !currentManage
          ? { ...result, available: false, result: undefined }
          : receiptMode === "mismatch"
            ? { ...result, publicIntent: { expectedRevision: 99 } }
            : (result ?? null),
      );
    }
    if (url.endsWith('/assistants/choices')) return Response.json({ agents: [], sources: [], platformSkills: [] })
    if (url.endsWith('/assistants/settings')) return Response.json({ presets: [], allocations: [] })
    if (url.endsWith('/autoops/bootstrap')) return Response.json(bootstrap())
    if (url.endsWith('/repositories')) return Response.json({ revision: 0, items: [] })
    if (new URL(url, window.location.origin).pathname.endsWith('/deployments')) return Response.json({ enabled: true, services: [], targets: [], servers: [], environments: project.environments, tasks: [] })
    if (url.endsWith('/workspace/authoring')) return Response.json({ projectId: project.id, revision: 0, sources: [], entries: [], limits: { maxFileBytes: 8000000, maxBytes: 50000000, maxFiles: 100 },
      })
    if (url.endsWith('/workspace/credentials')) return Response.json({ credentials: [] })
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { requestId: string;
        expectedRevision: number;
        value: { name: string; description: string } }
      bodies.push(body)
      if (fail) { fail = false; return Response.json({ code: 'PROJECT_REVISION_CONFLICT', error: '配置已经修改，请核对' }, { status: 409 },
        ) }
      if (writes === 0) { writes++; project.name = body.value.name; project.revision++ }
      receipts.set(body.requestId, {
        state: "completed",
        requestId: body.requestId,
        actorId: "directory-owner",
        projectId: project.id,
        environmentId: null,
        operation: url.endsWith("/projects") ? "project.create" : "project.save",
        saved: true,
        available: true,
        publicIntent: { expectedRevision: body.expectedRevision, value: body.value },
        createdAt: "2026-10-27T00:00:00Z",
        nativeSynchronization: "current-verified",
        result: { ...project },
      });
      if (lost) { lost = false; throw new TypeError('隔离测试丢失响应') }
      return Response.json(project)
    }
    if (url.endsWith('/settings')) return Response.json({ project, members: [{ userId: 'pending-user', name: '待分配成员', role: 'reader', authorizationPending: true, environmentIds: ['test'], status: 'active', environmentRoles: {}, revision: 1, kind: 'internal', canAdjustChat: true,
          },
        ], candidates: [],
      })
    return Response.json({ items: [project] })
  })
  return { fetch, bodies,
    queries,
    project, writes: () => writes,
    setReceiptMode: (value: typeof receiptMode) => {
      receiptMode = value;
    },
    setManage: (value: boolean) => {
      currentManage = value;
    },
    revokeDuringRecovery: () => {
      revokeOnReceipt = true;
    },
  }
}
function App() {
  return (
    <StrictMode>
      <SidebarProvider>
        <ModuleSidebarProvider>
          <ModuleSidebarOutlet />
          <AutoOpsProjectsPage />
        </ModuleSidebarProvider>
      </SidebarProvider>
    </StrictMode>
  );
}

function ThemedProjectPage({ dark }: { dark: boolean }) {
  const { setAppearanceMode } = useTheme()
  useLayoutEffect(() => {
    const previous = readAppearanceModePreference(readThemePreference())
    setAppearanceMode(dark ? 'dark' : 'light')
    return () => { setAppearanceMode(previous) }
  }, [dark, setAppearanceMode])
  return <AppSidebarLayout><AutoOpsProjectsPage /></AppSidebarLayout>
}

it('从部署进入仓库配置后直接定位，保留返回当前项目部署的入口', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project&section=git&from=deployments' })
  await expect.element(screen.getByRole('button', { name: '添加仓库', exact: true })).toBeEnabled()
  await expect.element(screen.getByRole('region', { name: '仓库与凭证' })).toHaveFocus()
  await screen.getByRole('link', { name: '返回部署', exact: true }).click()
  await expect.poll(() => screen.router?.state.location.href).toBe('/deployments?projectId=directory-project')
  expect(f.bodies).toHaveLength(0)
})

it.each([{ width: 1440, dark: false }, { width: 390, dark: true }])('配置概览在 $width px 展示真实配置并直达已有管理入口', async ({ width, dark }) => {
  await page.viewport(width, 600)
  const f = setup({ projectName: '华东区域生产服务项目' })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<ThemedProjectPage dark={dark} />, { router: '/projects?projectId=directory-project' })
  const summary = screen.getByRole('region', { name: '项目配置概览', exact: true })
  await expect.element(summary.getByText('尚未配置仓库', { exact: true })).toBeVisible()
  await expect.element(summary.getByText('0 个资料文件 · 0 个源码来源', { exact: true })).toBeVisible()
  await expect.element(summary.getByText('1 个环境 · 0 个节点绑定', { exact: true })).toBeVisible()
  await expect.element(summary.getByText('0 个启用助手 · 0 项分配规则 · 1 位成员待分配', { exact: true })).toBeVisible()
  await expect.element(summary.getByRole('link', { name: '打开工作区', exact: true })).toBeEnabled()
  const repositoryReads = f.fetch.mock.calls.filter(([input]) => String(input).endsWith('/repositories')).length
  await summary.getByRole('button', { name: '配置仓库', exact: true }).click()
  await expect.element(screen.getByRole('region', { name: '仓库与凭证' })).toHaveFocus()
  expect(f.fetch.mock.calls.filter(([input]) => String(input).endsWith('/repositories'))).toHaveLength(repositoryReads)
  await screen.getByRole('navigation', { name: '项目配置分组' }).getByRole('button', { name: '基本信息' }).click()
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1)
  expect(f.bodies).toHaveLength(0)
  await page.screenshot({ path: `../../.test-artifacts/ui-refinement/project-overview-${width}.png` })
})

it('配置概览区分目录与文件，并展示凭证、同步和节点的实际状态', async () => {
  const f = setup()
  const original = f.fetch.getMockImplementation()!
  const timestamp = '2026-10-28T00:00:00Z'
  f.fetch.mockImplementation(async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path.endsWith('/repositories')) return Response.json({ revision: 1, items: [{ id: 'repository', name: '业务仓库', url: 'https://isolated.invalid/business.git', credentialId: 'revoked-credential' }] })
    if (path.endsWith('/workspace/credentials')) return Response.json({ credentials: [{ id: 'revoked-credential', projectId: f.project.id, name: '旧凭证', revision: 1, version: 1, revoked: true, createdAt: timestamp, updatedAt: timestamp }] })
    if (path.endsWith('/workspace/authoring')) return Response.json({
      projectId: f.project.id, revision: 1,
      sources: [{ id: 'repository', name: '业务仓库', role: 'backend', url: 'https://isolated.invalid/business.git', refKind: 'branch', ref: 'main', mountPath: '.' }],
      sourceStatus: [{ sourceId: 'repository', status: 'failed', error: { code: 'WORKSPACE_GIT_TIMEOUT', message: '同步超时' } }],
      entries: [
        { id: 'docs', path: 'docs', name: 'docs', kind: 'directory', revision: '1', updatedAt: timestamp, size: 0, mime: '', editable: false },
        { id: 'readme', path: 'docs/README.md', name: 'README.md', kind: 'file', revision: '1', updatedAt: timestamp, size: 12, mime: 'text/markdown', editable: true },
      ],
      limits: { maxFileBytes: 8000000, maxBytes: 50000000, maxFiles: 100 },
    })
    if (path.endsWith('/deployments')) return Response.json({ enabled: true, services: [], targets: [], servers: [{ id: 'server', name: '业务节点', environmentId: 'test', online: false }], environments: f.project.environments, tasks: [] })
    return original(input, init)
  })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const summary = screen.getByRole('region', { name: '项目配置概览', exact: true })
  await expect.element(summary.getByText('1 个仓库已配置 · 1 个仓库凭证不可用', { exact: true })).toBeVisible()
  await expect.element(summary.getByText('1 个资料文件 · 1 个源码来源 · 0 个已同步 · 1 个同步失败', { exact: true })).toBeVisible()
  await expect.element(summary.getByText('1 个环境 · 1 个节点绑定', { exact: true })).toBeVisible()
  await expect.element(summary.getByRole('link', { name: '打开工作区', exact: true })).toBeEnabled()
  expect(f.fetch.mock.calls.some(([input]) => /\/(refs|commits|check)(?:\?|$)/.test(String(input)))).toBe(false)
  expect(f.bodies).toHaveLength(0)
})

it('概览的资料读取失败不阻塞其他配置，局部重试恢复且不重新读取仓库', async () => {
  const f = setup()
  const original = f.fetch.getMockImplementation()!
  let rejectWorkspace = true
  f.fetch.mockImplementation(async (input, init) => {
    if (String(input).endsWith('/workspace/authoring') && rejectWorkspace) return Response.json({ error: '资料状态暂不可用' }, { status: 503 })
    return original(input, init)
  })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const summary = screen.getByRole('region', { name: '项目配置概览', exact: true })
  await expect.element(summary.getByRole('alert')).toHaveTextContent('资料状态暂不可用')
  await expect.element(screen.getByRole('button', { name: '添加仓库', exact: true })).toBeEnabled()
  const repositoryReads = f.fetch.mock.calls.filter(([input]) => String(input).endsWith('/repositories')).length
  rejectWorkspace = false
  await summary.getByRole('button', { name: '重试资料状态' }).click()
  await expect.element(summary.getByText('0 个资料文件 · 0 个源码来源', { exact: true })).toBeVisible()
  await expect.element(summary.getByRole('alert')).not.toBeInTheDocument()
  expect(f.fetch.mock.calls.filter(([input]) => String(input).endsWith('/repositories'))).toHaveLength(repositoryReads)
  expect(f.bodies).toHaveLength(0)
})

it('只读角色不读取管理概览或展示仓库管理入口', async () => {
  const f = setup({ manage: false })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project&section=git&from=deployments' })
  await expect.element(screen.getByRole('region', { name: '基本信息', exact: true })).toBeVisible()
  await expect.element(screen.getByRole('region', { name: '项目配置概览' })).not.toBeInTheDocument()
  expect(f.fetch.mock.calls.some(([input]) => /\/(repositories|workspace\/authoring|deployments)$/.test(String(input)))).toBe(false)
})

it('从生产环境的指定服务配置仓库后返回，恢复原环境与服务并可继续发布', async () => {
  await page.viewport(1440, 600)
  const f = setup()
  f.project.environments.push({ id: 'production', name: '生产环境', revision: 1 })
  const repositories: ProjectRepositoryConnection[] = []
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  const original = f.fetch.getMockImplementation()!
  const config: StaticDeploymentConfig = {
    kind: 'static', module: '.', artifactPath: 'dist', buildImage: 'node:24', packageManager: 'npm', packageManagerVersion: '10.8.2', buildScript: 'build', buildArgs: [], build: { cpus: 1, memoryMb: 512 },
    health: { url: 'https://isolated.invalid', bodyIncludes: '', status: 200, timeoutSeconds: 180, intervalSeconds: 5 },
  }
  f.fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.origin)
    if (url.pathname.endsWith('/repositories')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        writes.push({ path: url.pathname, body })
        const repository = { id: 'new-repository', ...body.value }
        repositories.push(repository)
        return Response.json({ revision: 1, requestId: body.requestId, repository })
      }
      return Response.json({ revision: repositories.length, items: repositories })
    }
    if (url.pathname.endsWith('/deployments')) {
      const environmentId = url.searchParams.get('environmentId') ?? 'test'
      return Response.json({
        enabled: true, environments: f.project.environments,
        services: [{ id: 'api', name: '接口服务', kind: 'static', module: '.', configKey: 'api-config' }, { id: 'portal', name: '用户门户', kind: 'static', module: '.', configKey: 'portal-config' }],
        targets: ['api', 'portal'].map((serviceId) => ({ id: `${serviceId}-${environmentId}`, name: serviceId, serviceId, environmentId, serverId: 'server', configKey: `${serviceId}-config`, config })),
        servers: [{ id: 'server', name: '隔离部署节点', environmentId, online: true, capabilities: ['static-site-v1'] }], tasks: [],
      })
    }
    if (url.pathname.endsWith('/releases')) return Response.json({ releases: [], total: 0, nextOffset: null })
    return original(input, init)
  })
  using _fetch = stubGlobal('fetch', f.fetch)
  function Flow() {
    const location = useLocation()
    return <AppSidebarLayout>{location.pathname === '/projects' ? <AutoOpsProjectsPage /> : <DeploymentsPanel projectId={f.project.id} packages={[]} sources={repositories} sourcesError={null} navigation={null} packageActions={null} onRefreshPackages={() => {}} />}</AppSidebarLayout>
  }
  await using screen = await render(<Flow />, { router: '/deployments?projectId=directory-project' })
  await screen.getByRole('combobox', { name: '部署环境', exact: true }).click()
  await page.getByRole('option', { name: '生产环境', exact: true }).click()
  await screen.getByText('用户门户', { exact: true }).click()
  await expect.element(screen.getByRole('heading', { name: '用户门户', exact: true })).toBeVisible()
  await screen.getByRole('link', { name: '配置项目仓库', exact: true }).click()
  const git = screen.getByRole('region', { name: '仓库与凭证', exact: true })
  await expect.element(git).toHaveFocus()
  await git.getByRole('button', { name: '添加仓库', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加仓库', exact: true })
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('门户源码')
  await dialog.getByRole('textbox', { name: 'HTTPS 仓库地址', exact: true }).fill('https://isolated.invalid/portal.git')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(dialog).not.toBeInTheDocument()
  await screen.getByRole('link', { name: '返回部署', exact: true }).click()
  await expect.element(screen.getByRole('combobox', { name: '部署环境', exact: true })).toHaveTextContent('生产环境')
  await expect.element(screen.getByRole('heading', { name: '用户门户', exact: true })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: '发布', exact: true })).toBeEnabled()
  expect(writes).toHaveLength(1)
  expect(writes[0]!.body.value).toEqual({ name: '门户源码', url: 'https://isolated.invalid/portal.git' })
  expect(f.fetch.mock.calls.some(([input, init]) => String(input).includes('/deployments/tasks') && init?.method === 'POST')).toBe(false)
})

it('窄屏项目页保留可辨认的名称和管理入口', async () => {
  await page.viewport(390, 600)
  const f = setup({ manageNodes: true, projectName: '华东区域生产服务项目' })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<AppSidebarLayout><AutoOpsProjectsPage /></AppSidebarLayout>, { router: '/projects?projectId=directory-project' })
  await expect.element(screen.getByRole('button', { name: '编辑项目', exact: true })).toBeEnabled()
  await page.screenshot({ path: '../../.test-artifacts/ui-refinement/project-mobile-after.png' })
  const heading = screen.getByRole('heading', { name: f.project.name, exact: true }).element()
  expect(heading.getBoundingClientRect().width).toBeGreaterThanOrEqual(120)
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(391)
  await screen.getByRole('button', { name: '编辑项目', exact: true }).click()
  await expect.element(page.getByRole('dialog', { name: '编辑项目', exact: true })).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await expect.element(screen.getByRole('button', { name: '编辑项目', exact: true })).toHaveFocus()
})

it.each([{ width: 1440, dark: false }, { width: 390, dark: true }])(
  '配置分组在 $width px 直达原表单，保留焦点与当前资料且不重复读取',
  async ({ width, dark }) => {
    await page.viewport(width, 600)
    const f = setup({ manageNodes: true, projectName: '华东区域生产服务项目', lite: true })
    using _fetch = stubGlobal('fetch', f.fetch)
    await using screen = await render(<ThemedProjectPage dark={dark} />, { router: '/projects?projectId=directory-project' })
    await expect.element(screen.getByText('暂无助手', { exact: true })).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '添加仓库', exact: true })).toBeEnabled()
    const configReads = () => f.fetch.mock.calls.filter(([input]) => String(input).includes('/projects/')).length
    const initialReads = configReads()
    const navigation = screen.getByRole('navigation', { name: '项目配置分组' })
    await navigation.getByRole('button', { name: '仓库与凭证' }).click()
    const repository = screen.getByRole('region', { name: '仓库与凭证' })
    await expect.element(repository).toHaveFocus()
    const navBottom = navigation.element().getBoundingClientRect().bottom
    expect(repository.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(navBottom)
    const addRepository = repository.getByRole('button', { name: '添加仓库', exact: true })
    await userEvent.keyboard('{Tab}')
    await expect.element(addRepository).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByRole('dialog', { name: '添加仓库', exact: true })).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(addRepository).toHaveFocus()
    await navigation.getByRole('button', { name: '助手与成员' }).click()
    await expect.element(screen.getByRole('region', { name: '助手与成员' })).toHaveFocus()
    await expect.element(screen.getByText('待管理员分配')).toBeVisible()
    expect(configReads()).toBe(initialReads)
    expect(f.bodies).toHaveLength(0)
    await navigation.getByRole('button', { name: '环境', exact: true }).click()
    await expect.element(screen.getByRole('region', { name: '环境', exact: true })).toHaveFocus()
    await expect.element(screen.getByRole('button', { name: '管理测试环境 MCP' })).toBeEnabled()
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1)
    await page.screenshot({ path: `../../.test-artifacts/ui-refinement/project-${width}-${dark ? 'dark' : 'light'}.png` })
  },
)

it('项目A保存未知后切到项目B仍能正常保存，不核对或覆盖A的原请求', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const f = setup()
  f.fetch.mockRejectedValueOnce(new TypeError('隔离项目A响应丢失'))
  using _fetch = stubGlobal('fetch', f.fetch)
  const original = prepareProjectWrite('/api/v1/projects/other/settings', 1, {
    name: '待核对项目A',
    description: '',
  })
  await expect(submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const edit = screen.getByRole('button', { name: '编辑项目', exact: true })
  await expect.element(edit).toBeEnabled()
  await userEvent.click(edit)
  await expect.element(page.getByRole('dialog', { name: '编辑项目', exact: true })).toBeVisible()
  await userEvent.click(page.getByRole('button', { name: '保存', exact: true }))
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(edit).toHaveFocus()
  expect(f.bodies).toHaveLength(1)
  expect(f.queries).toHaveLength(0)
  expect(readPendingProjectWrite({ projectId: 'other' })).toEqual(original)
})

it('核对一项项目配置后仍显示同项目另一项未知结果，不提前解锁删除或丢弃原UUID', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const f = setup()
  let seeding = true
  const queries: string[] = []
  let original: ReturnType<typeof prepareProjectWrite>
  let assistant: ReturnType<typeof prepareProjectMutation>
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (seeding) throw new TypeError('隔离原写回复丢失')
    const url = String(input)
    if (url.endsWith(`/projects/receipts/${original.body.requestId}`)) {
      queries.push(url)
      const { requestId, ...publicIntent } = original.body
      return Response.json({
        state: 'completed',
        actorId: original.actorId,
        requestId,
        projectId: f.project.id,
        environmentId: null,
        operation: 'project.save',
        saved: true,
        available: true,
        publicIntent,
        createdAt: '2026-10-27T00:00:00Z',
        nativeSynchronization: 'current-verified',
        result: f.project,
      })
    }
    if (url.endsWith(`/projects/directory-project/assistants/receipts/${assistant.body.requestId}`)) {
      queries.push(url)
      return Response.json({
        state: 'completed', actorId: assistant.actorId, requestId: assistant.body.requestId,
        projectId: f.project.id, operation: 'allocation.save:member:member', saved: true,
        available: false, createdAt: '2026-10-27T00:00:00Z',
        publicIntent: { algorithm: 'sha256', digest: bytesToHex(sha256(new TextEncoder().encode(projectAssistantReceiptIntent('allocation.save:member:member', assistant.body)))) },
      })
    }
    return f.fetch(input, init)
  })
  using _fetch = stubGlobal('fetch', fetcher)
  original = prepareProjectWrite('/api/v1/projects/directory-project/settings', 1, {
    name: f.project.name,
    description: '',
  })
  await expect(submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  assistant = prepareProjectMutation(
    '/api/v1/projects/directory-project/assistant-allocations',
    0,
    {
      target: { kind: 'member', id: 'member' },
      assistantIds: ['helper'],
      defaultAssistantId: null,
    },
  )
  await expect(submitProjectWrite(assistant)).rejects.toMatchObject({ uncertain: true })
  seeding = false
  const first = readPendingProjectWrite({ projectId: 'directory-project' })!
  const remaining = first.body.requestId === original.body.requestId ? assistant : original
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const retry = screen.getByRole('button', { name: '重试', exact: true })
  await expect.element(retry).toBeEnabled()
  await userEvent.click(retry)
  await vi.waitFor(() => expect(queries).toHaveLength(1))
  await vi.waitFor(() =>
    expect(readPendingProjectWrite({ projectId: 'directory-project' })).toEqual(remaining),
  )
  expect(queries[0]).toContain(`/receipts/${first.body.requestId}`)
  await expect
    .element(screen.getByRole('button', { name: `管理项目 ${f.project.name}`, exact: true }))
    .toBeDisabled()
  await expect.element(screen.getByText('上一次保存结果尚待确认', { exact: true })).toBeVisible()
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
})

it('项目A保存未知后关闭表单继续保存B，返回A只核原收据且不重发', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const f = setup({ loseResponse: true })
  f.setReceiptMode('missing')
  const second = { ...f.project, id: 'other-project', name: '另一项目', environments: [] }
  const host = readAutoOpsHost()!
  const secondWrites: Array<Record<string, unknown>> = []
  const bootstrap = () => ({
    ...host,
    projects: [
      { ...host.projects[0]!, name: f.project.name },
      { ...host.projects[0]!, id: second.id, name: second.name, environments: [] },
    ],
  })
  installAutoOpsHost(bootstrap(), window.location.origin)
  using _fetch = stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname
      if (path.endsWith('/autoops/bootstrap')) return Response.json(bootstrap())
      if (path.endsWith('/api/v1/projects')) {
        const items = [f.project, second]
        expect(new Set(items.map((project) => project.id)).size).toBe(items.length)
        return Response.json({ items })
      }
      if (path.endsWith('/projects/other-project/settings')) {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { value: { name: string } }
          secondWrites.push(body)
          second.name = body.value.name
          second.revision++
          return Response.json(second)
        }
        return Response.json({ project: second, members: [], candidates: [] })
      }
      if (path.endsWith('/projects/other-project/workspace/authoring'))
        return Response.json({
          projectId: second.id,
          revision: 0,
          sources: [],
          entries: [],
          limits: { maxFileBytes: 8000000, maxBytes: 50000000, maxFiles: 100 },
        })
      return f.fetch(input, init)
    }),
  )
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  await expect.element(screen.getByRole('button', { name: '编辑项目', exact: true })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: '编辑项目', exact: true }))
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('待核对的项目A')
  await userEvent.click(page.getByRole('button', { name: '保存', exact: true }))
  const dialog = page.getByRole('dialog', { name: '编辑项目', exact: true })
  await expect.element(dialog).toBeVisible()
  await expect.element(dialog.getByRole('button', { name: '重试', exact: true })).toBeEnabled()
  const original = readPendingProjectWrite({ projectId: 'directory-project' })!
  await expect
    .element(dialog.getByRole('button', { name: '关闭', exact: true }).filter({ hasText: '关闭' }))
    .toBeEnabled()
  await userEvent.keyboard('{Escape}')
  await expect.element(dialog).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '刷新项目', exact: true })).toHaveFocus()
  expect(readPendingProjectWrite({ projectId: 'directory-project' })).toEqual(original)
  await userEvent.click(screen.getByRole('button', { name: '另一项目', exact: true }))
  await vi.waitFor(() =>
    expect(screen.router?.state.location.search).toMatchObject({ projectId: 'other-project' }),
  )
  await expect.element(screen.getByRole('button', { name: '编辑项目', exact: true })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: '编辑项目', exact: true }))
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('已保存的项目B')
  await userEvent.click(page.getByRole('button', { name: '保存', exact: true }))
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(secondWrites).toHaveLength(1)
  expect(readPendingProjectWrite({ projectId: 'directory-project' })).toEqual(original)
  f.setReceiptMode('completed')
  await userEvent.click(screen.getByRole('button', { name: '待核对的项目A', exact: true }))
  await userEvent.click(screen.getByRole('button', { name: '重试', exact: true }))
  await vi.waitFor(() =>
    expect(readPendingProjectWrite({ projectId: 'directory-project' })).toBeNull(),
  )
  expect(f.bodies).toHaveLength(1)
  expect(f.queries).toHaveLength(2)
  expect(f.queries[0]).toBe(f.queries[1])
  expect(f.queries[1]).toContain(original.body.requestId)
})

it('管理员编辑项目到可见保存结果，保留待分配成员，关闭表单恢复入口焦点', async () => {
  await page.viewport(390, 500)
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const edit = screen.getByRole('button', { name: '编辑项目', exact: true })
  await expect.element(edit).toBeVisible()
  await expect.element(screen.getByText('待管理员分配')).toBeVisible()
  await edit.click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('调整后的项目')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(screen.getByText('调整后的项目', { exact: true }).first()).toBeVisible()
  await expect.element(edit).toHaveFocus()
  expect(f.bodies).toHaveLength(1)
  expect(f.writes()).toBe(1)
})

it('修订冲突保留填写内容及真实错误，取消与 Esc 恢复焦点', async () => {
  const f = setup({ failFirst: true })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const edit = screen.getByRole('button', { name: '编辑项目', exact: true })
  await expect.element(edit).toBeVisible(); await edit.click()
  const name = page.getByRole('textbox', { name: '名称', exact: true })
  await name.fill('保留这个输入')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(name).toHaveValue('保留这个输入')
  await expect.element(page.getByRole('dialog').getByRole('alert')).toHaveTextContent('配置已经修改，请核对')
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(edit).toHaveFocus()
  expect(f.writes()).toBe(0)
})

it("保存响应丢失自动GET原收据，不发送第二次POST并恢复焦点", async () => {
  const f = setup({ loseResponse: true })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const edit = screen.getByRole('button', { name: '编辑项目', exact: true })
  await expect.element(edit).toBeVisible(); await edit.click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('断线保存')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.bodies).toHaveLength(1)
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]).toBe(
    `/api/agent-demo/t3/api/v1/projects/receipts/${(f.bodies[0] as { requestId: string }).requestId}`,
  )
  expect(f.writes()).toBe(1)
})

it('只读成员可以查看项目和已分配环境，不请求成员设置或展示管理动作', async () => {
  const f = setup({ manage: false })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  await expect.element(screen.getByText('测试环境', { exact: true })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: '编辑项目', exact: true })).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '添加环境' })).not.toBeInTheDocument()
  const navigation = screen.getByRole('navigation', { name: '项目配置分组' })
  await expect.element(navigation.getByRole('button', { name: '仓库与凭证' })).not.toBeInTheDocument()
  await expect.element(navigation.getByRole('button', { name: '助手与成员' })).not.toBeInTheDocument()
  await navigation.getByRole('button', { name: '环境', exact: true }).click()
  await expect.element(screen.getByRole('region', { name: '环境', exact: true })).toHaveFocus()
  expect(f.fetch.mock.calls.some(([url]) => String(url).endsWith('/settings'))).toBe(false)
})

it('从全部项目打开创建表单，提交名称并进入原返回项目，不额外提交环境创建', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects' })
  await screen.getByRole('button', { name: '创建项目', exact: true }).click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('新的空项目')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await vi.waitFor(() => expect(screen.router?.state.location.search).toEqual({ projectId: 'directory-project' }),
  )
  expect(mocks.select).toHaveBeenCalledWith('directory-project')
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(f.bodies[0]).toMatchObject({ expectedRevision: 0, value: { name: '新的空项目', description: '' },
  })
});

it.each(['missing', 'unavailable', 'mismatch'] as const)(
  '原收据%s允许关闭表单但保留原标识，手动核对仅GET同收据后恢复',
  async (mode) => {
    using _timers = fakeTimers({ shouldAdvanceTime: true })
    const f = setup({ loseResponse: true })
    f.setReceiptMode(mode)
    using _fetch = stubGlobal('fetch', f.fetch)
    await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
    const edit = screen.getByRole('button', { name: '编辑项目', exact: true })
    await expect.element(edit).toBeVisible()
    await edit.click()
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('原未知修改')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect.element(dialog.getByRole('button', { name: '重试', exact: true })).toBeEnabled()
    await expect
      .element(
        dialog.getByRole('button', { name: '关闭', exact: true }).filter({ hasText: '关闭' }),
      )
      .toBeEnabled()
    const original = readPendingProjectWrite()
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '刷新项目', exact: true }))
      .toHaveFocus()
    expect(readPendingProjectWrite()).toEqual(original)
    expect(original?.submitted).toBe(true)
    expect(f.bodies).toHaveLength(1)
    expect(f.queries).toHaveLength(1)
    f.setReceiptMode('completed')
    await userEvent.click(screen.getByRole('button', { name: '重试', exact: true }))
    await expect.element(dialog).not.toBeInTheDocument()
    await expect.element(edit).toBeEnabled()
    expect(f.queries).toEqual([f.queries[0], f.queries[0]])
    expect(f.bodies).toHaveLength(1)
    expect(readPendingProjectWrite()).toBeNull()
  },
)

it("原写已保存后撤权只确认最小事实，关闭旧编辑并移除管理入口不再次POST", async () => {
  const f = setup({ loseResponse: true });
  f.revokeDuringRecovery();
  using _fetch = stubGlobal("fetch", f.fetch);
  await using screen = await render(<App />, { router: "/projects?projectId=directory-project" });
  const edit = screen.getByRole("button", { name: "编辑项目", exact: true });
  await expect.element(edit).toBeVisible();
  await edit.click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("已保存但现已撤权");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "编辑项目", exact: true }))
    .not.toBeInTheDocument();
  expect(f.bodies).toHaveLength(1);
  expect(f.queries).toHaveLength(1);
  expect(readPendingProjectWrite()).toBeNull();
});


it('页面重开原项目已退出活动目录时，核原收据后仍能显式继续同一删除', async () => {
  const f = setup()
  const original = prepareProjectMutation('/api/v1/projects/directory-project', 1, {}, 'DELETE')
  let completed = false
  const resumes: unknown[] = [], deletes: unknown[] = [], queries: string[] = [], previews: string[] = []
  const originalReceipt = () => ({ state: completed ? 'completed' : 'pending', actorId: 'directory-owner', projectId: 'directory-project', environmentId: null, requestId: original.body.requestId, operation: 'project.delete', saved: true, available: false, canResume: !completed, publicIntent: { expectedRevision: 1 }, nativeSynchronization: 'not-required', createdAt: '2026-10-27T00:00:00Z', ...(completed ? { result: { deleted: true, projectId: 'directory-project' } } : {}) })
  using _fetch = stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'DELETE') { deletes.push(JSON.parse(String(init.body))); throw new TypeError('原删除已接受但响应丢失') }
    if (url.endsWith('/resume')) { resumes.push(JSON.parse(String(init?.body))); completed = true; return Response.json(originalReceipt()) }
    if (url.includes('/projects/receipts/')) { queries.push(url); return Response.json(originalReceipt()) }
    if (url.endsWith('/deletion-preview')) { previews.push(url); return Response.json({ error: '原项目已不在活动目录' }, { status: 404 }) }
    if (url.endsWith('/projects')) return Response.json({ items: [] })
    return f.fetch(input, init)
  }))
  await expect(submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  await using screen = await render(<App />, { router: '/projects' })
  await expect.element(screen.getByText('没有可见项目', { exact: true })).toBeVisible()
  await screen.getByRole('button', { name: '重试', exact: true }).click()
  await expect.element(page.getByRole('dialog', { name: '删除项目', exact: true })).toBeVisible()
  await expect.element(page.getByRole('button', { name: '继续删除', exact: true })).toBeEnabled()
  expect(resumes).toHaveLength(0)
  expect(previews).toHaveLength(0)
  await page.getByRole('button', { name: '继续删除', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '创建项目', exact: true })).toBeEnabled()
  expect(resumes).toEqual([{ operation: 'project.delete', projectId: 'directory-project', publicIntent: { expectedRevision: 1 } }])
  expect(deletes).toHaveLength(1)
  expect(queries).toHaveLength(2)
  expect(queries[0]).toBe(queries[1])
  expect(readPendingProjectWrite()).toBeNull()
})
