import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { act, render } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
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
const view = () => (
  <SidebarProvider>
    <ModuleSidebarProvider>
      <div style={{ display: 'flex', height: 600, width: 1000 }}>
        <ModuleSidebarOutlet />
        <DeploymentsPanel
          projectId="p-one"
          packages={packages}
          navigation={null}
          packageActions={null}
          onRefreshPackages={() => {}}
        />
      </div>
    </ModuleSidebarProvider>
  </SidebarProvider>
)
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
    .element(page.getByRole('button', { name: '添加前端服务', exact: true }))
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
afterEach(() => vi.useRealTimers())

describe('部署撤权隔离', () => {
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
