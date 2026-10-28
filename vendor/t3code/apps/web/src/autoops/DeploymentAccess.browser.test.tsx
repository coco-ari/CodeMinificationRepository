import { useLayoutEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { act, render } from '../../test/render'
import { AppSidebarLayout } from '~/components/AppSidebarLayout'
import { SidebarProvider } from '~/components/ui/sidebar'
import { readAppearanceModePreference, readThemePreference, useTheme } from '~/hooks/useTheme'
import { installAutoOpsHost } from './hostConfig'
import { ModuleSidebarOutlet, ModuleSidebarProvider } from './ModuleWorkspace'
import { DeploymentsPanel } from './DeploymentsPanel'
import {
  DeploymentRequestError,
  type DeploymentOverview,
  type DeploymentTaskDetails,
  type StaticDeploymentConfig,
} from './deployments'
import type { WorkspaceRelease } from './workspaces'
import '../index.css'
import './theme.css'

const mocks = vi.hoisted(() => ({
  host: vi.fn(),
  load: vi.fn(),
  releases: vi.fn(),
  logs: vi.fn(),
  submit: vi.fn(),
}))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}))
vi.mock(import('./projectNavigation'), async (original) => ({
  ...(await original()),
  useAutoOpsProjectId: () => 'p-one',
}))
vi.mock(import('./apiClient'), async original => ({
  ...(await original()),
  autoOpsRequest: vi.fn(async () => { const value = await mocks.releases(); return {...value,total:value.releases.length,nextOffset:null} }),
}))
vi.mock(import('./deployments'), async (original) => ({
  ...(await original()),
  loadDeployments: mocks.load,
  loadDeploymentReleases: mocks.releases,
  loadDeploymentTask: mocks.logs,
  submitDeployment: mocks.submit,
}))
const config: StaticDeploymentConfig = {
  kind: 'static',
  module: 'frontend',
  artifactPath: 'frontend/dist',
  buildImage: 'node:24-bookworm-slim',
  packageManager: 'npm',
  packageManagerVersion: '10.9.9',
  buildScript: 'build',
  buildArgs: [],
  build: { cpus: 1, memoryMb: 1024 },
  health: {
    url: 'http://private-deployment.invalid/',
    bodyIncludes: '',
    status: 200,
    timeoutSeconds: 180,
    intervalSeconds: 5,
  },
}
const overview = (): DeploymentOverview => ({
  enabled: true,
  services: [{id:'service-one',name:'撤权服务',kind:'static',module:config.module,configKey:'service-config'}],
  environments: [{ id: 'env-one', name: '隔离环境' }],
  servers: [
    {
      id: 'server-one',
      name: '隔离节点',
      environmentId: 'env-one',
      online: true,
      capabilities: ['static-site-v1'],
    },
  ],
  targets: [
    {
      id: 'target-one',
      serviceId: 'service-one',
      name: '撤权服务',
      environmentId: 'env-one',
      serverId: 'server-one',
      configKey: 'config-one',
      config,
    },
  ],
  tasks: [
    {
      id: 'task-one',
      targetId: 'target-one',
      status: 'succeeded',
      stage: 'complete',
      createdAt: '2026-10-23T00:00:00Z',
    },
  ],
})
const logs = (): DeploymentTaskDetails => ({
  task: { ...overview().tasks[0]!, lastSeq: 1 },
  logs: [{ seq: 1, message: '撤权后不可继续显示的日志' }],
  nextSeq: 2,
})
const packages: WorkspaceRelease[] = [
  {
    id: 'package-one',
    name: '隔离包',
    sourceVersionId: 'v-one',
    createdAt: '2026-10-23T00:00:00Z',
    services: [{ service: 'frontend', name: 'frontend.zip', size: 10, sha256: 'isolated' }],
    manifest: { services: [{ service: 'frontend', context: { workingDirectory: 'frontend' } }] },
  },
]
const pendingKey = 'autoops:deployments:owner-one:p-one:pending'
const pending = {
  kind: 'task',
  input: {
    targetId: 'target-one',
    action: 'deploy',
    service: 'frontend',
    configKey: 'config-one',
    packageId: 'package-one',
    requestId: 'fixed-unknown-request',
  },
}
const denied = (status = 403) =>
  new DeploymentRequestError('部署访问已被拒绝', false, status, 'ACCESS_DENIED')
const view = (width = 1000, height = 600) => (
  <SidebarProvider>
    <ModuleSidebarProvider>
      <div style={{ display: 'flex', height, width }}>
        {width >= 768 ? <ModuleSidebarOutlet /> : null}
        <DeploymentsPanel
          projectId="p-one"
          packages={packages}
          sources={[]}
          sourcesError={null}
          navigation={null}
          packageActions={null}
          onRefreshPackages={() => {}}
        />
      </div>
    </ModuleSidebarProvider>
  </SidebarProvider>
)

it('发布缺少仓库时直达项目配置，保留部署选择且不提交任务', async () => {
  const host = mocks.host()
  host.projects[0].capabilities['project.manage'] = true
  mocks.host.mockReturnValue(installAutoOpsHost({
    ...host, csrfToken: 'test-csrf', gatewayBasePath: '/api/agent-demo/t3',
    fixedModel: { instanceId: 'codex', model: 'test-model' }, runtimeMode: 'approval-required', capabilities: {},
  }, window.location.origin))
  await using screen = await render(view(), { router: '/deployments?projectId=p-one' })
  await screen.getByRole('button', { name: '发布', exact: true }).click()
  await page.getByRole('combobox', { name: '发布来源', exact: true }).click()
  await page.getByRole('option', { name: 'Git 仓库', exact: true }).click()
  const selection = sessionStorage.getItem('autoops:deployments:owner-one:p-one:selection')
  await page.getByRole('link', { name: '配置项目仓库', exact: true }).click()
  await expect.poll(() => screen.router?.state.location.href).toBe('/projects?projectId=p-one&section=git&from=deployments')
  expect(JSON.parse(selection!)).toMatchObject({ environmentId: 'env-one', serviceId: 'service-one', targetId: 'target-one' })
  expect(sessionStorage.getItem('autoops:deployments:owner-one:p-one:selection')).toBe(selection)
  expect(mocks.submit).not.toHaveBeenCalled()
})

it('主区域直接展示已确认版本，并保留最新任务运行结果未知的提示', async () => {
  const value = overview()
  value.targets[0]!.currentRelease = {
    id: 'confirmed-release', targetId: 'target-one', revision: 'a'.repeat(40),
    createdAt: '2026-10-22T00:00:00Z',
    sourceIdentity: { repositories: [{ path: '.', commit: 'a'.repeat(40) }] },
    sourceSelection: { sources: [{ sourceId: 'repo', refKind: 'branch', ref: 'release/v2', mountPath: '.' }], contexts: [] },
  }
  value.tasks[0] = { ...value.tasks[0]!, status: 'interrupted', stage: 'deploy' }
  mocks.load.mockResolvedValue(value)
  await using screen = await render(view())
  const summary = screen.getByRole('region', { name: '已确认部署版本', exact: true })
  await expect.element(summary.getByText('aaaaaaaaaaaa', { exact: true })).toBeVisible()
  await expect.element(summary.getByText('release/v2', { exact: true })).toBeVisible()
  await expect.element(screen.getByText('切换或恢复期间任务中断，当前运行状态待核对。')).toBeVisible()
  expect(mocks.submit).not.toHaveBeenCalled()
})

it.each([{ width: 1440, dark: false }, { width: 390, dark: true }])('在 $width px 直接阅读长分支版本并查看固定 Commit，关闭详情恢复焦点', async ({ width, dark }) => {
  await page.viewport(width, 600)
  const host = mocks.host()
  mocks.host.mockReturnValue(installAutoOpsHost({
    ...host, csrfToken: 'test-csrf', gatewayBasePath: '/api/agent-demo/t3',
    fixedModel: { instanceId: 'codex', model: 'test-model' }, runtimeMode: 'approval-required', capabilities: {},
  }, window.location.origin))
  const value = overview()
  value.targets[0]!.currentRelease = {
    id: 'confirmed-release', targetId: 'target-one', revision: 'a'.repeat(40), createdAt: '2026-10-22T00:00:00Z',
    sourceIdentity: { repositories: [{ path: '.', commit: 'a'.repeat(40) }] },
    sourceSelection: { sources: [{ sourceId: 'repo', refKind: 'branch', ref: 'release/华东区域生产服务长分支名称与历史固定资料', mountPath: '.' }], contexts: [] },
  }
  mocks.load.mockResolvedValue(value)
  await using screen = await render(<ThemedShell dark={dark}><DeploymentsPanel projectId="p-one" packages={packages} sources={[]} sourcesError={null} navigation={null} packageActions={null} onRefreshPackages={() => {}} /></ThemedShell>, { router: '/deployments?projectId=p-one' })
  if (width >= 768) await screen.getByRole('button', { name: '切换主侧栏' }).click()
  const summary = screen.getByRole('region', { name: '已确认部署版本', exact: true })
  await expect.element(summary.getByText('aaaaaaaaaaaa', { exact: true })).toBeVisible()
  const details = summary.getByRole('button', { name: '版本来源', exact: true })
  await details.click()
  await expect.element(page.getByRole('dialog').getByText('a'.repeat(40), { exact: true })).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await expect.element(details).toHaveFocus()
  expect(summary.element().getBoundingClientRect().right).toBeLessThanOrEqual(width)
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1)
  await page.screenshot({ path: `../../.test-artifacts/ui-refinement/deployment-version-${width}.png` })
})

it('没有项目管理权限时保留缺少仓库的原因，不提供无权使用的配置入口', async () => {
  const host = mocks.host()
  mocks.host.mockReturnValue(installAutoOpsHost({
    ...host, csrfToken: 'test-csrf', gatewayBasePath: '/api/agent-demo/t3',
    fixedModel: { instanceId: 'codex', model: 'test-model' }, runtimeMode: 'approval-required', capabilities: {},
  }, window.location.origin))
  await using screen = await render(view())
  await screen.getByRole('button', { name: '发布', exact: true }).click()
  await page.getByRole('combobox', { name: '发布来源', exact: true }).click()
  await page.getByRole('option', { name: 'Git 仓库', exact: true }).click()
  await expect.element(page.getByText('项目尚未配置 Git 仓库，请联系项目管理员。', { exact: true })).toBeVisible()
  await expect.element(page.getByRole('link', { name: '配置项目仓库', exact: true })).not.toBeInTheDocument()
  await expect.element(page.getByRole('button', { name: '确认发布', exact: true })).toBeDisabled()
  expect(mocks.submit).not.toHaveBeenCalled()
})
function ThemedShell({ dark, children }: { dark: boolean; children: ReactNode }) {
  const { setAppearanceMode } = useTheme()
  useLayoutEffect(() => {
    const previous = readAppearanceModePreference(readThemePreference())
    const rootBackground = document.documentElement.style.backgroundColor
    const bodyBackground = document.body.style.backgroundColor
    setAppearanceMode(dark ? 'dark' : 'light')
    return () => {
      setAppearanceMode(previous)
      document.documentElement.style.backgroundColor = rootBackground
      document.body.style.backgroundColor = bodyBackground
    }
  }, [dark, setAppearanceMode])
  return <AppSidebarLayout>{children}</AppSidebarLayout>
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(
    (element) =>
      element.getAttribute('aria-label') === label || element.textContent?.trim() === label,
  )
  expect(button, label).toBeTruthy()
  await act(() => button!.click())
}
async function cleared() {
  await vi.waitFor(() => expect(document.querySelector('[aria-label="部署详情"]')).toBeNull())
  expect(document.body.textContent).not.toContain('撤权后不可继续显示的日志')
  expect(document.body.textContent).not.toContain(config.health.url)
  expect(document.body.textContent).not.toContain('撤权服务')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await expect.element(page.getByRole('button', { name: '发布', exact: true })).toBeDisabled()
  await expect
    .element(page.getByRole('button', { name: '添加服务', exact: true }))
    .toBeDisabled()
}
beforeEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
  mocks.host.mockReturnValue({
    principal: { id: 'owner-one', displayName: '隔离用户' },
    projects: [
      {
        id: 'p-one',
        name: '隔离项目',
        capabilities: {
          'workspace.read': true,
          'workspace.manage': true,
          'deployment.read': true,
          'deployment.execute': true,
        },
        environments: [{ id: 'env-one', name: '隔离环境' }],
        agents: [],
      },
    ],
  })
  mocks.load.mockResolvedValue(overview())
  mocks.releases.mockResolvedValue({ releases: [] })
  mocks.logs.mockResolvedValue(logs())
})
afterEach(async () => {
  vi.useRealTimers()
  document.documentElement.classList.remove('dark')
  await page.viewport(1280, 720)
})

describe('部署撤权隔离', () => {
  it.each([{ width: 390, dark: true }, { width: 1440, dark: false }])(
    '部署环境在 $width px 主区域可见并可从读取失败恢复',
    async ({ width, dark }) => {
      await page.viewport(width, 600)
      const host = mocks.host()
      const environments = [{ id: 'env-one', name: '隔离环境' }, { id: 'env-two', name: '生产环境' }]
      host.projects[0].environments = environments
      mocks.host.mockReturnValue(installAutoOpsHost({
        ...host, csrfToken: 'test-csrf', gatewayBasePath: '/api/agent-demo/t3',
        fixedModel: { instanceId: 'codex', model: 'test-model' }, runtimeMode: 'approval-required',
        capabilities: {},
      }, window.location.origin))
      let rejectEnvironment!: (cause: Error) => void
      mocks.load.mockImplementation((_project: string, environment: string) =>
        environment === 'env-two'
          ? new Promise<DeploymentOverview>((_resolve, reject) => { rejectEnvironment = reject })
          : Promise.resolve({ ...overview(), environments }),
      )
      await using screen = await render(
        <ThemedShell dark={dark}>
          <DeploymentsPanel projectId="p-one" packages={packages} sources={[]} sourcesError={null}
            navigation={null} packageActions={null} onRefreshPackages={() => {}} />
        </ThemedShell>, { router: '/deployments?projectId=p-one' },
      )
      await expect.element(screen.getByRole('heading', { name: '撤权服务' })).toBeVisible()
      if (width >= 768) await screen.getByRole('button', { name: '切换主侧栏' }).click()
      await page.screenshot({ path: `../../.test-artifacts/ui-refinement/deployment-context-${width}.png` })
      const environment = screen.getByRole('combobox', { name: '部署环境' })
      await expect.element(environment).toBeVisible()
      const bounds = environment.element().getBoundingClientRect()
      expect(bounds.top).toBeGreaterThanOrEqual(52)
      expect(bounds.bottom).toBeLessThanOrEqual(220)
      expect(bounds.width).toBeGreaterThanOrEqual(120)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1)
      if (width >= 768) {
        const log = screen.getByLabelText('部署增量日志').element()
        const viewport = log.closest('[data-slot="scroll-area-viewport"]')!
        const header = screen.container.querySelector('[data-module-header]')!
        expect(viewport.getBoundingClientRect().height / (600 - header.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(0.6)
      }
      const runtimeInfo = screen.getByRole('button', { name: '运行信息', exact: true })
      await runtimeInfo.click()
      await expect.element(page.getByLabelText('部署运行记录')).toBeVisible()
      await userEvent.keyboard('{Escape}')
      await expect.element(runtimeInfo).toHaveFocus()
      await environment.click()
      await page.getByRole('option', { name: '生产环境' }).click()
      await expect.element(environment).toHaveTextContent('生产环境')
      await expect.element(screen.getByText('正在读取部署服务…')).toBeVisible()
      await act(() => rejectEnvironment(new Error('隔离的网络中断')))
      await expect.element(screen.getByRole('alert').getByText('隔离的网络中断', { exact: true })).toBeVisible()
      await expect.element(environment).toBeEnabled()
      await environment.click()
      await page.getByRole('option', { name: '隔离环境' }).click()
      await expect.element(screen.getByRole('heading', { name: '撤权服务' })).toBeVisible()
      await environment.click()
      await userEvent.keyboard('{Escape}')
      await expect.element(environment).toHaveFocus()
      expect(mocks.load.mock.calls.some((call) => call[1] === 'env-two')).toBe(true)
      expect(mocks.submit).not.toHaveBeenCalled()
    },
  )
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 390]) {
      it(`${theme} ${width}px 短窗口的未知结果提示保留完整核对按钮`, async () => {
        await page.viewport(width, 420)
        document.documentElement.classList.toggle('dark', theme === 'dark')
        sessionStorage.setItem(pendingKey, JSON.stringify(pending))
        await using screen = await render(view(width, 420))
        await vi.waitFor(() => expect(screen.container.textContent).toContain('撤权服务'))
        await expect.element(page.getByRole('button', { name: '核对并重试原请求' })).toBeEnabled()
        await expect.element(page.getByRole('combobox', { name: '部署环境' })).toBeDisabled()
        const alert = screen.container.querySelector<HTMLElement>('[role="alert"]')!
        const button = alert.querySelector('button')!
        const title = alert.querySelector<HTMLElement>('[data-slot="alert-title"]')!
        const bounds = alert.getBoundingClientRect()
        const actionBounds = button.getBoundingClientRect()
        expect(actionBounds.left).toBeGreaterThanOrEqual(bounds.left)
        expect(actionBounds.right).toBeLessThanOrEqual(bounds.right)
        expect(actionBounds.bottom).toBeLessThanOrEqual(bounds.bottom)
        expect(actionBounds.top).toBeGreaterThanOrEqual(title.getBoundingClientRect().bottom)
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
        expect(sessionStorage.getItem(pendingKey)).toBe(JSON.stringify(pending))
        expect(mocks.submit).not.toHaveBeenCalled()
        await page.screenshot({
          path: `../../.test-artifacts/second-wave-responsive/deployment-pending-${theme}-${width}.png`,
        })
      })
    }
  }
  for (const status of [401, 403, 404]) {
    it(`${status} 清除配置和弹窗并停止自动轮询`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await using screen = await render(view())
      await vi.waitFor(() =>
        expect(screen.container.textContent).toContain('撤权后不可继续显示的日志'),
      )
      await click('配置')
      expect(screen.container.textContent).toContain(config.health.url)
      await click('发布')
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
      mocks.load.mockRejectedValue(denied(status))
      await vi.advanceTimersByTimeAsync(5000)
      await cleared()
      const requests = mocks.load.mock.calls.length
      await vi.advanceTimersByTimeAsync(20000)
      expect(mocks.load).toHaveBeenCalledTimes(requests)
      expect(mocks.submit).not.toHaveBeenCalled()
    })
  }
  it('发布记录撤权取消并拒绝迟到总览，不能恢复旧服务', async () => {
    await using screen = await render(view())
    await vi.waitFor(() => expect(screen.container.textContent).toContain('撤权服务'))
    let resolve!: (value: DeploymentOverview) => void
    mocks.load.mockImplementationOnce(
      () =>
        new Promise<DeploymentOverview>((deliver) => {
          resolve = deliver
        }),
    )
    mocks.releases.mockRejectedValue(denied())
    await click('刷新部署状态')
    await cleared()
    const signal = mocks.load.mock.calls.at(-1)![2] as AbortSignal
    expect(signal.aborted).toBe(true)
    await act(() => resolve(overview()))
    await cleared()
  })
  it('日志轮询撤权立即清除服务与日志并停止读取', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mocks.logs.mockResolvedValueOnce({ ...logs(), task: { ...logs().task, status: 'running' } })
    await using screen = await render(view())
    await vi.waitFor(() =>
      expect(screen.container.textContent).toContain('撤权后不可继续显示的日志'),
    )
    mocks.logs.mockRejectedValue(denied())
    await vi.advanceTimersByTimeAsync(1000)
    await cleared()
    const calls = [mocks.logs.mock.calls.length, mocks.load.mock.calls.length]
    await vi.advanceTimersByTimeAsync(20000)
    expect([mocks.logs.mock.calls.length, mocks.load.mock.calls.length]).toEqual(calls)
  })
  it('原请求核对被拒绝时保留未知收据，重新验证权限成功后仍使用同一标识', async () => {
    sessionStorage.setItem(pendingKey, JSON.stringify(pending))
    mocks.submit.mockRejectedValue(denied())
    await using screen = await render(view())
    await vi.waitFor(() => expect(screen.container.textContent).toContain('撤权服务'))
    await click('核对并重试原请求')
    await cleared()
    expect(sessionStorage.getItem(pendingKey)).toBe(JSON.stringify(pending))
    await expect.element(page.getByRole('button', { name: '核对并重试原请求' })).toBeDisabled()
    let resolve!: (value: DeploymentOverview) => void
    mocks.load.mockImplementationOnce(
      () =>
        new Promise<DeploymentOverview>((deliver) => {
          resolve = deliver
        }),
    )
    await click('刷新部署状态')
    await expect.element(page.getByRole('button', { name: '核对并重试原请求' })).toBeDisabled()
    expect(mocks.submit).toHaveBeenCalledTimes(1)
    await act(() => resolve(overview()))
    await vi.waitFor(() => expect(screen.container.textContent).toContain('撤权服务'))
    mocks.submit.mockResolvedValue({ task: overview().tasks[0] })
    await click('核对并重试原请求')
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2))
    expect(mocks.submit.mock.calls.map((call) => call[1].requestId)).toEqual([
      'fixed-unknown-request',
      'fixed-unknown-request',
    ])
    await vi.waitFor(() => expect(sessionStorage.getItem(pendingKey)).toBeNull())
  })
})
