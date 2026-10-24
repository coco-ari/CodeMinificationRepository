import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
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
  external: vi.fn(),
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
  generateExternalWorkspace: mocks.external,
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
    sources: [
      {
        id: 'source-one',
        name: '前端源码',
        url: 'https://github.com/example/frontend.git',
        refKind: 'default',
        ref: '',
        role: 'frontend',
        mountPath: 'frontend',
      },
    ],
    entries: [],
    limits: { maxFileBytes: 8388608, maxFiles: 1000, maxBytes: 67108864 },
    hasUnpublishedChanges: true,
  })
  mocks.authoringSend.mockReset()
  mocks.external.mockReset()
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
            router: '/' + area + '?projectId=p-one',
          },
        )
        await vi.waitFor(() =>
          expect(screen.container.querySelector('[data-module-error]')).toBeNull(),
        )
        if (area === 'workspaces') {
          await screen.getByRole('button', { name: '工作区操作', exact: true }).click()
          await expect
            .element(page.getByRole('menuitem', { name: '新建对话', exact: true }))
            .toBeVisible()
          await userEvent.keyboard('{Escape}')
          await expect
            .element(screen.getByRole('button', { name: '上传资料', exact: true }))
            .toBeEnabled()
          expect(screen.container.textContent).not.toContain('固定版本')
          if (width < 1000) {
            await screen.getByRole('button', { name: '工作区操作', exact: true }).click()
            await page.getByRole('menuitem', { name: '添加源码来源', exact: true }).click()
            await expect
              .element(page.getByRole('dialog', { name: '添加源码来源', exact: true }))
              .toBeVisible()
            await page.getByText('关闭', { exact: true }).click()
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
          if (width < 640) {
            const title = screen
              .getByRole('heading', { name: '前端部署验证', exact: true })
              .element()
            expect(title.clientWidth).toBeGreaterThanOrEqual(title.scrollWidth)
            const more = screen.getByRole('button', { name: '部署更多操作', exact: true })
            await more.click()
            await expect
              .element(page.getByRole('menuitem', { name: '刷新部署状态', exact: true }))
              .toBeVisible()
            await expect
              .element(page.getByRole('menuitem', { name: '源码包任务记录', exact: true }))
              .toBeDisabled()
            await page.getByRole('menuitem', { name: '生成部署包', exact: true }).click()
            await expect
              .element(page.getByRole('dialog', { name: '生成部署包', exact: true }))
              .toBeVisible()
            await userEvent.keyboard('{Escape}')
            await expect.element(more).toHaveFocus()
          }
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

describe('部署运行记录与所选详情分离', () => {
  it('恢复失败跨日志、配置和记录保持可见，新的成功收据才解除提示', async () => {
    await page.viewport(1440, 600)
    const data = deployment()
    data.tasks[0] = {
      ...data.tasks[0]!,
      status: 'failed',
      stage: 'rollback',
      result: { rollback: { status: 'failed' } },
    }
    mocks.deployment.mockResolvedValue(data)
    await using screen = await render(
      <AppSidebarLayout>
        <AutoOpsDeploymentsPage />
      </AppSidebarLayout>,
      { router: '/deployments?projectId=p-one' },
    )
    await expect.element(screen.getByText('运行状态待核对', { exact: true })).toBeVisible()
    await expect
      .element(screen.getByText('上次确认版本：36bccae65190', { exact: true }))
      .toBeVisible()
    for (const name of ['配置', '发布记录', '任务日志']) {
      await screen.getByRole('radio', { name, exact: true }).click()
      await expect.element(screen.getByText('运行状态待核对', { exact: true })).toBeVisible()
    }
    await screen.getByRole('button', { name: '查看待核对任务', exact: true }).click()
    const release = {
      ...data.targets[0]!.currentRelease!,
      id: 'release-recovered',
      revision: 'recovered1234',
      createdAt: '2026-10-24T00:00:00Z',
    }
    mocks.deployment.mockResolvedValue({
      ...data,
      targets: [{ ...data.targets[0], currentRelease: release }],
      tasks: [
        {
          ...data.tasks[0],
          id: 'task-recovered',
          status: 'succeeded',
          createdAt: release.createdAt,
          updatedAt: release.createdAt,
          result: { release },
        },
        ...data.tasks,
      ],
    })
    await screen.getByRole('button', { name: '刷新部署状态', exact: true }).click()
    await expect
      .element(screen.getByText('上次确认版本：recovered123', { exact: true }))
      .toBeVisible()
    await expect
      .element(screen.getByText('运行状态待核对', { exact: true }))
      .not.toBeInTheDocument()
  })
})

describe('部署与源码包分别使用服务端写权限', () => {
  for (const view of ['服务发布', '源码包'] as const) {
    it(view + '已加载后源码读取被拒绝，清理旧内容并关闭生成表单', async () => {
      await page.viewport(1440, 600)
      await using screen = await render(
        <AppSidebarLayout>
          <AutoOpsDeploymentsPage />
        </AppSidebarLayout>,
        { router: '/deployments?projectId=p-one' },
      )
      await expect
        .element(screen.getByRole('heading', { name: '前端部署验证', exact: true }))
        .toBeVisible()
      if (view === '源码包') {
        await screen.getByRole('button', { name: '源码包', exact: true }).click()
        await expect
          .element(screen.getByRole('button', { name: /^示例前端源码包\s/ }))
          .toBeVisible()
      }
      const generate = page.getByRole('button', { name: '生成部署包', exact: true })
      await expect.element(generate).toBeEnabled()
      mocks.authoring.mockRejectedValue(
        new AutoOpsRequestError('源码读取权限已撤回', 'FORBIDDEN', 403),
      )
      await generate.click()
      await expect.element(screen.getByText('源码读取权限已撤回', { exact: true })).toBeVisible()
      await expect
        .element(page.getByRole('dialog', { name: '生成部署包', exact: true }))
        .not.toBeInTheDocument()
      await expect
        .element(screen.getByRole('heading', { name: '前端部署验证', exact: true }))
        .not.toBeInTheDocument()
      await expect
        .element(screen.getByRole('button', { name: /^示例前端源码包\s/ }))
        .not.toBeInTheDocument()
      await expect
        .element(page.getByRole('button', { name: '发布', exact: true }))
        .not.toBeInTheDocument()
      await expect.element(generate).not.toBeInTheDocument()
      expect(screen.container.querySelector('[data-module-error]')).toBeNull()
    })
  }
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
        await expect.element(page.getByRole('button', { name: '重试', exact: true })).toBeVisible()
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
      const header = screen.container.querySelector<HTMLElement>('[data-module-header]')!
      const files = screen.container.querySelector<HTMLElement>('[data-file-browser-panel]')!
      expect(
        files.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
      ).toBeLessThanOrEqual(1)
      expect(screen.container.querySelectorAll('[data-surface-subheader]')).toHaveLength(1)
      expect(
        header.contains(page.getByRole('button', { name: '上传资料', exact: true }).element()),
      ).toBe(true)
      expect(
        header.contains(page.getByRole('button', { name: '同步源码', exact: true }).element()),
      ).toBe(true)
      await expect
        .element(page.getByRole('button', { name: '刷新当前资料', exact: true }))
        .not.toBeInTheDocument()
      const beforeRefresh = mocks.authoring.mock.calls.length
      await page.getByRole('button', { name: '刷新工作区文件', exact: true }).click()
      await vi.waitFor(() =>
        expect(mocks.authoring.mock.calls.length).toBeGreaterThan(beforeRefresh),
      )
      await page.getByRole('button', { name: '工作区操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '任务记录', exact: true }).click()
      await expect
        .element(page.getByRole('dialog', { name: '任务记录', exact: true }))
        .toBeVisible()
      await userEvent.keyboard('{Escape}')
      await expect
        .element(page.getByRole('button', { name: '工作区操作', exact: true }))
        .toHaveFocus()
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

for (const width of [390, 1440]) {
  it(`当前资料在 ${width}px 将子目录路径与搜索放在同一工具栏`, async () => {
    await page.viewport(width, 600)
    saveSelection('p-one:authoring:file', 'docs')
    await using screen = await render(
      <AppSidebarLayout>
        <AutoOpsWorkspacesPage />
      </AppSidebarLayout>,
      { router: '/workspaces?projectId=p-one' },
    )
    const search = page.getByRole('searchbox', { name: '搜索 当前资料 的文件' })
    await expect.element(search).toBeVisible()
    const path = page.getByRole('navigation', { name: '文件路径' })
    await expect.element(path).toBeVisible()
    await vi.waitFor(() => {
      const toolbar = search.element().closest('[data-surface-subheader]')!
      expect(toolbar.contains(path.element())).toBe(true)
      expect(screen.container.querySelectorAll('[data-surface-subheader]')).toHaveLength(1)
      expect(search.element().getBoundingClientRect().width).toBeGreaterThan(80)
    })
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1)
  })
  it(`工作区在 ${width}px 一次点击提交同步与外部更新，次要脱敏设置保留`, async () => {
    await page.viewport(width, 600)
    mocks.authoringSend.mockImplementation(async (_project, input) => ({
      requestId: input.requestId,
      task: {
        id: 'sync-new',
        type: 'sync',
        status: 'completed',
        stage: 'completed',
        createdAt: '2026-10-24T00:00:00Z',
      },
    }))
    mocks.external.mockImplementation(async (_project, _source, _rules, requestId) => ({
      id: 'external-new',
      requestId,
      type: 'external',
      status: 'queued',
      stage: 'queued',
      createdAt: '2026-10-24T00:00:00Z',
    }))
    await using screen = await render(
      <AppSidebarLayout>
        <AutoOpsWorkspacesPage />
      </AppSidebarLayout>,
      { router: '/workspaces?projectId=p-one' },
    )
    await page.getByRole('button', { name: '同步源码', exact: true }).click()
    expect(mocks.authoringSend).toHaveBeenCalledTimes(1)
    expect(mocks.authoringSend.mock.calls[0]![1].command).toEqual({ kind: 'sync' })
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    if (width < 768) await page.getByRole('button', { name: '切换主侧栏', exact: true }).click()
    await page.getByRole('radio', { name: '外部工作区', exact: true }).click()
    if (width < 768) await userEvent.keyboard('{Escape}')
    await page.getByRole('button', { name: '更新外部工作区', exact: true }).click()
    expect(mocks.external).toHaveBeenCalledTimes(1)
    expect(mocks.external.mock.calls[0]![2]).toEqual([])
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    await page.getByRole('button', { name: '外部工作区操作' }).click()
    await page.getByRole('menuitem', { name: '自定义脱敏' }).click()
    await expect.element(page.getByRole('dialog', { name: '更新外部工作区' })).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('button', { name: '外部工作区操作' })).toHaveFocus()
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
  })
}
