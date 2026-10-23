import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { EnvironmentId } from '@t3tools/contracts'
import { render } from '../../test/render'
import { AppSidebarLayout } from '~/components/AppSidebarLayout'
import { AutoOpsWorkspacesPage } from './WorkspacesPage'
import { AutoOpsDeploymentsPage } from './DeploymentsPage'
import type { WorkspaceOverview } from './workspaces'
import type { DeploymentOverview, StaticDeploymentConfig } from './deployments'
import { AutoOpsRequestError } from './apiClient'
import { saveSelection } from './workspaceViewState'
import '../index.css'
import './theme.css'

vi.mock(import('../localEnvironment'), () => ({ isLocalEnvironmentDisabled: () => true }))

const mocks = vi.hoisted(() => ({
  host: vi.fn(),
  authoring: vi.fn(),
  authoringSend: vi.fn(),
  workspace: vi.fn(),
  deployment: vi.fn(),
  task: vi.fn(),
  releases: vi.fn(),
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
vi.mock(import('./workspaceAuthoring'), async (original) => ({
  ...(await original()),
  loadAuthoring: mocks.authoring,
  submitAuthoring: mocks.authoringSend,
  loadAuthoringContent: vi.fn(async () => ({
    path: 'docs/说明.txt',
    revision: 'content-one',
    size: 15,
    mime: 'text/plain',
    sha256: 'original-hash',
    extraction: {
      status: 'unavailable' as const,
      contentHash: 'original-hash',
      parserVersion: 'parser-one',
    },
    contents: '原件已保存',
  })),
  loadAuthoringCredentials: vi.fn(async () => ({ credentials: [] })),
  loadAuthoringTree: vi.fn(async () => ({
    entries: [{ path: 'docs', name: 'docs', kind: 'directory' as const, size: 0 }],
    truncated: false,
  })),
  searchAuthoringFiles: vi.fn(async () => ({ entries: [], truncated: false })),
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
  mocks.authoring.mockResolvedValue({
    projectId: 'p-one',
    revision: 1,
    sources: [],
    entries: [],
    limits: { maxFileBytes: 8388608, maxFiles: 1000, maxBytes: 67108864 },
    hasUnpublishedChanges: true,
  })
  mocks.authoringSend.mockReset()
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
          {
            router:
              '/' + area + '?projectId=p-one' + (area === 'workspaces' ? '&versionId=v-one' : ''),
          },
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
          await expect
            .element(screen.getByRole('button', { name: '发布', exact: true }))
            .toHaveFocus()
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

describe('当前资料保留满高文件区域和原生操作', () => {
  for (const manager of [true, false]) {
    it('正文提取失败时' + (manager ? '管理员按原件修订重试' : '只读用户只看状态'), async () => {
      await page.viewport(390, 844)
      const data = await mocks.authoring()
      data.entries = [
        {
          id: 'material-one',
          path: 'docs/说明.txt',
          name: '说明.txt',
          kind: 'file',
          revision: 'content-one',
          updatedAt: '2026-10-23T00:00:00Z',
          size: 15,
          mime: 'text/plain',
          editable: true,
          extraction: {
            status: 'unavailable',
            contentHash: 'original-hash',
            parserVersion: 'parser-one',
            message: '解析器暂时不可用',
          },
        },
      ]
      mocks.authoring.mockResolvedValue(data)
      const host = mocks.host()
      host.projects[0].capabilities['workspace.manage'] = manager
      mocks.host.mockReturnValue(host)
      saveSelection('p-one:authoring:file', 'docs/说明.txt')
      mocks.authoringSend.mockRejectedValue(
        new AutoOpsRequestError('连接中断', 'CONNECTION_FAILED', undefined, true),
      )
      await using screen = await render(
        <AppSidebarLayout>
          <AutoOpsWorkspacesPage />
        </AppSidebarLayout>,
        { router: '/workspaces?projectId=p-one' },
      )
      await expect
        .element(page.getByText('原件已保存，正文不可提取：解析器暂时不可用', { exact: true }))
        .toBeVisible()
      const retry = page.getByRole('button', { name: '重新提取正文', exact: true })
      if (manager) {
        await retry.click()
        await vi.waitFor(() => expect(mocks.authoringSend).toHaveBeenCalledTimes(1))
        expect(mocks.authoringSend.mock.calls[0]![1]).toMatchObject({
          command: {
            kind: 'document',
            action: 'extract',
            path: 'docs/说明.txt',
            expectedContentRevision: 'content-one',
          },
          expectedRevision: 1,
        })
        await expect.element(retry).toBeDisabled()
        await expect
          .element(page.getByRole('button', { name: '按原请求核对', exact: true }))
          .toBeVisible()
      } else {
        await expect.element(retry).not.toBeInTheDocument()
        expect(mocks.authoringSend).not.toHaveBeenCalled()
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(391)
    })
  }
  for (const [width, height] of [
    [1440, 600],
    [390, 844],
  ] as const) {
    it('当前资料在 ' + width + 'px 能上传和管理来源，菜单关闭恢复入口焦点', async () => {
      await page.viewport(width, height)
      await using screen = await render(
        <AppSidebarLayout>
          <AutoOpsWorkspacesPage />
        </AppSidebarLayout>,
        { router: '/workspaces?projectId=p-one' },
      )
      await expect
        .element(page.getByRole('button', { name: '上传资料', exact: true }))
        .toBeEnabled()
      expect(
        screen.container.querySelector('section[aria-label="当前资料文件浏览"]'),
      ).not.toBeNull()
      await page.getByRole('button', { name: '工作区操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '添加源码来源', exact: true }).click()
      await expect
        .element(page.getByRole('dialog', { name: '添加源码来源', exact: true }))
        .toBeVisible()
      await page.getByText('关闭', { exact: true }).click()
      await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
      await expect
        .element(page.getByRole('button', { name: '工作区操作', exact: true }))
        .toHaveFocus()
      await page.getByRole('button', { name: '上传资料', exact: true }).click()
      await expect
        .element(page.getByRole('dialog', { name: '上传项目资料', exact: true }))
        .toBeVisible()
      await page.getByText('关闭', { exact: true }).click()
      await expect
        .element(page.getByRole('button', { name: '上传资料', exact: true }))
        .toHaveFocus()
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1)
      expect(screen.container.querySelector('[data-module-error]')).toBeNull()
    })
  }
})
