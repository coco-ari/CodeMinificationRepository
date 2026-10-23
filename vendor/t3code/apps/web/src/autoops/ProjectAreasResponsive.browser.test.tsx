import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { EnvironmentId } from '@t3tools/contracts'
import { render } from '../../test/render'
import { AppSidebarLayout } from '~/components/AppSidebarLayout'
import { AutoOpsWorkspacesPage } from './WorkspacesPage'
import { AutoOpsDeploymentsPage } from './DeploymentsPage'
import type { WorkspaceOverview } from './workspaces'
import type { DeploymentOverview, StaticDeploymentConfig } from './deployments'
import '../index.css'
import './theme.css'

vi.mock(import('../localEnvironment'), () => ({ isLocalEnvironmentDisabled: () => true }))

const mocks = vi.hoisted(() => ({
  host: vi.fn(),
  workspace: vi.fn(),
  deployment: vi.fn(),
  task: vi.fn(),
  releases: vi.fn(),
}))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}))
vi.mock(import('./projectNavigation'), async (original) => ({
  ...(await original()),
  useAutoOpsProjectId: () => 'p-one',
  selectAutoOpsProject: vi.fn(),
  rememberAutoOpsChatLocation: vi.fn(),
}))
vi.mock(import('../state/environments'), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make('isolated-preview'),
}))
vi.mock(import('./workspaces'), async (original) => ({
  ...(await original()),
  loadWorkspaces: mocks.workspace,
  loadWorkspaceTree: vi.fn(async () => ({
    entries: [
      { path: 'README.md', name: 'README.md', kind: 'file' as const, size: 64 },
      { path: 'frontend', name: 'frontend', kind: 'directory' as const, size: 0 },
    ],
    truncated: false,
  })),
  searchWorkspaceFiles: vi.fn(async () => ({ entries: [], truncated: false })),
}))
vi.mock(import('./deployments'), async (original) => ({
  ...(await original()),
  loadDeployments: mocks.deployment,
  loadDeploymentTask: mocks.task,
  loadDeploymentReleases: mocks.releases,
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
    url: 'http://isolated.invalid/',
    bodyIncludes: '',
    status: 200,
    timeoutSeconds: 180,
    intervalSeconds: 5,
  },
}
const workspace = (): WorkspaceOverview => ({
  projectId: 'p-one',
  internalVersions: [
    {
      id: 'v-one',
      name: '内部示例 v001',
      type: 'internal',
      status: 'published',
      createdAt: '2026-10-23T00:00:00Z',
      fileCount: 46,
      byteLength: 213231,
      source: { repositories: [], contentHash: 'isolated-content' },
    },
  ],
  externalVersions: [],
  import: { supported: true, hosts: ['isolated.invalid'], maxBytes: 1000000, maxFiles: 1000 },
  tasks: [],
  releases: [
    {
      id: 'package-one',
      name: '示例前端源码包',
      sourceVersionId: 'v-one',
      createdAt: '2026-10-23T00:00:00Z',
      services: [
        { service: 'frontend', name: 'frontend.zip', size: 2000, sha256: 'isolated-hash' },
      ],
      manifest: { services: [{ service: 'frontend', context: { workingDirectory: 'frontend' } }] },
    },
  ],
})
const deployment = (): DeploymentOverview => ({
  enabled: true,
  environments: [{ id: 'env-test', name: '测试环境' }],
  servers: [
    {
      id: 'server-one',
      name: '部署验证节点',
      online: true,
      environmentId: 'env-test',
      capabilities: ['static-site-v1'],
    },
  ],
  targets: [
    {
      id: 'target-one',
      name: '前端部署验证',
      environmentId: 'env-test',
      serverId: 'server-one',
      configKey: 'config-v1',
      config,
      currentRelease: {
        id: 'release-one',
        targetId: 'target-one',
        createdAt: '2026-10-22T00:00:00Z',
        revision: '36bccae65190',
        sourceIdentity: { sourceVersionId: 'v-one' },
      },
    },
  ],
  tasks: [
    {
      id: 'task-one',
      targetId: 'target-one',
      status: 'rolled_back',
      stage: 'verify',
      action: 'deploy',
      createdAt: '2026-10-23T00:00:00Z',
      sourceIdentity: { sourceVersionId: 'v-one' },
      error: '站点检查失败，已恢复上一版本',
      result: { error: '首页缺少预期版本标识', rollback: { status: 'succeeded' } },
      stageHistory: [
        { stage: 'queued' },
        { stage: 'download' },
        { stage: 'build' },
        { stage: 'verify' },
      ],
      lastSeq: 30,
    },
  ],
})
beforeEach(() => {
  sessionStorage.clear()
  localStorage.removeItem('autoops.workspace-sidebar-open')
  mocks.host.mockReturnValue({
    principal: { id: 'isolated-owner', displayName: '隔离验收用户' },
    gatewayBasePath: '/api/agent-demo/t3',
    httpBaseUrl: location.origin,
    wsBaseUrl: 'ws://isolated.invalid',
    csrfToken: 'isolated-test-token',
    fixedModel: { instanceId: 'codex', model: 'test-model' },
    runtimeMode: 'approval-required',
    productProfile: { id: 'project-assistant-lite-v1' },
    capabilities: {},
    projects: [
      {
        id: 'p-one',
        name: 'AutoOps 工作台',
        capabilities: {
          'workspace.read': true,
          'workspace.manage': true,
          'deployment.read': true,
          'deployment.execute': true,
        },
        environments: [{ id: 'env-test', name: '测试环境' }],
        agents: [],
        membership: { role: 'manager', workspaceAccess: 'internal', environmentIds: ['env-test'] },
      },
    ],
  })
  mocks.workspace.mockResolvedValue(workspace())
  const data = deployment()
  mocks.deployment.mockResolvedValue(data)
  mocks.releases.mockResolvedValue({
    releases: [{ ...data.targets[0]!.currentRelease, current: true }],
  })
  mocks.task.mockResolvedValue({
    task: data.tasks[0],
    logs: Array.from({ length: 30 }, (_, index) => ({
      seq: index + 1,
      message: '构建与站点检查的隔离日志记录 ' + (index + 1),
      at: '2026-10-23T00:00:00Z',
    })),
    nextSeq: 31,
  })
})

describe('现有模块的公共框架响应式布局', () => {
  for (const [width, height] of [
    [1440, 600],
    [390, 844],
  ] as const) {
    for (const area of ['workspaces', 'deployments'] as const) {
      it(area + ' 在 ' + width + 'px 保留操作且不产生页面横向溢出', async () => {
        await page.viewport(width, height)
        await using screen = await render(
          <AppSidebarLayout>
            {area === 'workspaces' ? <AutoOpsWorkspacesPage /> : <AutoOpsDeploymentsPage />}
          </AppSidebarLayout>,
          { router: '/' + area + '?projectId=p-one' },
        )
        await vi.waitFor(() =>
          expect(screen.container.querySelector('[data-module-error]')).toBeNull(),
        )
        if (area === 'workspaces') {
          await expect
            .element(screen.getByRole('button', { name: '新建对话', exact: true }))
            .toBeVisible()
          if (width < 1000) {
            await screen.getByRole('button', { name: '工作区操作', exact: true }).click()
            await expect
              .element(page.getByRole('menuitem', { name: '导入仓库', exact: true }))
              .toBeVisible()
            await page.getByRole('menuitem', { name: '导入仓库', exact: true }).click()
            await expect
              .element(page.getByRole('dialog', { name: '导入仓库', exact: true }))
              .toBeVisible()
            await page.getByRole('button', { name: '取消', exact: true }).click()
          }
        } else {
          await expect
            .element(screen.getByRole('button', { name: '发布', exact: true }))
            .toBeVisible()
          await vi.waitFor(() =>
            expect(screen.container.textContent).toContain('站点检查失败，已恢复上一版本'),
          )
          await screen.getByRole('button', { name: '发布', exact: true }).click()
          await expect
            .element(page.getByRole('dialog', { name: '确认发布', exact: true }))
            .toBeVisible()
          await page.getByRole('button', { name: '取消', exact: true }).click()
          await expect.element(screen.getByRole('button', { name: '发布', exact: true })).toHaveFocus()
        }
        await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1)
        const body = screen.container.querySelector<HTMLElement>('[data-autoops-body]')!
        expect(body.getBoundingClientRect().right).toBeLessThanOrEqual(width + 1)
        expect(screen.container.querySelector('[data-module-error]')).toBeNull()
        if (area === 'deployments') {
          const picker = screen.container.querySelector<HTMLElement>(
            '[data-deployment-task-picker] [data-slot="select-trigger"]',
          )!
          const icon = picker.querySelector<HTMLElement>('[data-slot="select-icon"]')!
          expect(icon.getBoundingClientRect().right).toBeLessThanOrEqual(
            picker.getBoundingClientRect().right + 1,
          )
        }
        await page.screenshot({
          path: '../../.test-artifacts/second-wave-responsive/' + area + '-' + width + '.png',
        })
      })
    }
  }
})

describe('部署与源码包分别使用服务端写权限', () => {
  for (const capability of ['deployment.execute', 'workspace.manage'] as const) {
    it('缺少 ' + capability + ' 时保留阅读并禁用对应写操作', async () => {
      await page.viewport(1440, 600)
      const host = mocks.host()
      host.projects[0].capabilities[capability] = false
      mocks.host.mockReturnValue(host)
      await using screen = await render(
        <AppSidebarLayout>
          <AutoOpsDeploymentsPage />
        </AppSidebarLayout>,
        { router: '/deployments?projectId=p-one' },
      )
      await vi.waitFor(() =>
        expect(screen.container.textContent).toContain('站点检查失败，已恢复上一版本'),
      )
      const release = page.getByRole('button', { name: '发布', exact: true })
      const packages = page.getByRole('button', { name: '生成部署包', exact: true })
      if (capability === 'deployment.execute') {
        await expect.element(release).toBeDisabled()
        await expect
          .element(page.getByRole('button', { name: '添加前端服务', exact: true }))
          .toBeDisabled()
        await expect.element(packages).toBeEnabled()
      } else {
        await expect.element(packages).toBeDisabled()
        await expect.element(release).toBeEnabled()
      }
      expect(screen.container.querySelector('[data-module-error]')).toBeNull()
    })
  }
})
