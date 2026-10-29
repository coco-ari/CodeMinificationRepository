import { expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { render, act } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { ModuleSidebarProvider, ModuleSidebarOutlet } from './ModuleWorkspace'
import { DeploymentsPanel } from './DeploymentsPanel'
import { DeploymentRequestError } from './deployments'
import type {
  DeploymentOverview,
  DeploymentService,
  DeploymentTarget,
  DeploymentServiceSource,
  DeploymentSubmission,
} from './deployments'
import '../index.css'

const mocks = vi.hoisted(() => ({
  host: vi.fn(),
  load: vi.fn(),
  refs: vi.fn(),
  history: vi.fn(),
  submit: vi.fn(),
  saveService: vi.fn(),
  saveSource: vi.fn(),
  createTarget: vi.fn(),
  receipt: vi.fn(),
  logs: vi.fn(),
  remove: vi.fn(),
}))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}))
vi.mock(import('./deployments'), async (original) => ({
  ...(await original()),
  loadDeployments: mocks.load,
  loadDeploymentRepositoryRefs: mocks.refs,
  loadDeploymentRepositoryHistory: mocks.history,
  submitDeployment: mocks.submit,
  saveDeploymentService: mocks.saveService,
  saveDeploymentServiceSource: mocks.saveSource,
  createDeploymentTarget: mocks.createTarget,
  loadDeploymentRequest: mocks.receipt,
  loadDeploymentTask: mocks.logs,
  removeDeploymentConfiguration: mocks.remove,
}))

function setup(admin = false) {
  vi.resetAllMocks()
  sessionStorage.clear()
  const environment = {
    read: true,
    configure: true,
    publish: true,
    restart: true,
    rollback: true,
    sourceDownload: true,
    sourceClear: admin,
    nodeBind: admin,
  }
  const service: DeploymentService = {
    id: 'service-api',
    name: '后端服务',
    kind: 'java',
    module: '.',
    configKey: 'service-key',
    hasTargets: true,
  }
  const target: DeploymentTarget = {
    id: 'target-api',
    name: service.name,
    serviceId: service.id,
    serverId: 'node-one',
    environmentId: 'test',
    configKey: 'target-key',
    config: {
      kind: 'java',
      module: '.',
      artifactPath: 'target/*.jar',
      buildImage: 'maven:3.9.9-eclipse-temurin-8',
      runtimeImage: 'eclipse-temurin:8-jre',
      profile: 'test',
      jvmArgs: [],
      args: [],
      ports: [],
      networks: [],
      volumes: [],
      build: { cpus: 1, memoryMb: 1024 },
      runtime: { cpus: 0.5, memoryMb: 512 },
      health: {
        path: '/health',
        port: 8080,
        status: 200,
        bodyIncludes: '',
        timeoutSeconds: 180,
        intervalSeconds: 5,
      },
    },
  }
  const source: DeploymentServiceSource = {
    serviceId: service.id,
    environmentId: 'test',
    sources: [{ sourceId: 'repo-one', refKind: 'branch', ref: 'main', mountPath: 'repository' }],
    contexts: [{ service: 'backend', root: 'repository', workingDirectory: '.' }],
    configKey: 'source-key',
  }
  const state: DeploymentOverview = {
    enabled: true,
    environments: [
      { id: 'test', name: '测试环境' },
      { id: 'prod', name: '生产环境' },
    ],
    servers: [
      {
        id: 'node-one',
        name: '隔离节点',
        environmentId: 'test',
        online: true,
        capabilities: ['static-site-v1'],
      },
    ],
    services: [service],
    serviceSources: [source],
    targets: [target],
    tasks: [],
    capabilities: {
      serviceManage: admin,
      environments: {
        test: environment,
        prod: { ...environment, configure: false, publish: false, restart: false, rollback: false },
      },
    },
  }
  const catalog = [service]
  mocks.host.mockReturnValue({
    principal: { id: 'workbench-test' },
    projects: [
      {
        id: 'p-one',
        name: '项目',
        environments: state.environments,
        capabilities: { 'deployment.read': true, 'deployment.execute': true },
      },
    ],
  })
  mocks.load.mockImplementation(async (_project, env, _signal, include) => ({
    ...structuredClone(state),
    services: env === 'prod' ? [] : state.services,
    targets: state.targets.filter((row) => row.environmentId === env),
    serviceSources: state.serviceSources?.filter((row) => row.environmentId === env),
    ...(include ? { availableServices: structuredClone(catalog) } : {}),
  }))
  mocks.refs.mockResolvedValue({
    sourceId: 'repo-one',
    defaultRef: 'main',
    branches: [
      { name: 'main', commit: 'a'.repeat(40) },
      { name: 'feature', commit: 'b'.repeat(40) },
    ],
    tags: [],
    truncated: false,
  })
  mocks.history.mockResolvedValue({
    sourceId: 'repo-one',
    refKind: 'branch',
    ref: 'main',
    defaultRef: 'main',
    commit: 'a'.repeat(40),
    commits: [
      { revision: 'a'.repeat(40), subject: '修复订单', authoredAt: '2026-10-29T12:00:00Z' },
    ],
    truncated: false,
  })
  mocks.submit.mockImplementation(async (_project, input: DeploymentSubmission) => ({
    task: {
      id: 'task-accepted',
      targetId: input.targetId,
      status: 'running',
      stage: 'building',
      createdAt: '2026-10-30T00:00:00Z',
    },
  }))
  mocks.logs.mockResolvedValue({
    task: {
      id: 'task-accepted',
      targetId: target.id,
      status: 'succeeded',
      stage: 'verifying',
      action: 'deploy',
      createdAt: '2026-10-30T00:00:00Z',
      lastSeq: 1,
      stageHistory: [
        {
          stage: 'building',
          startedAt: '2026-10-30T00:00:00Z',
          finishedAt: '2026-10-30T00:00:01Z',
        },
        {
          stage: 'verifying',
          startedAt: '2026-10-30T00:00:01Z',
          finishedAt: '2026-10-30T00:00:02Z',
        },
      ],
    },
    logs: [{ seq: 1, stage: 'verifying', message: '健康检查通过' }],
    nextSeq: 2,
  })
  mocks.saveService.mockImplementation(async (_project, input) => {
    const row = { ...input, id: 'new-service', configKey: 'new-service-key' }
    catalog.push(row)
    return { service: row }
  })
  mocks.saveSource.mockImplementation(async (_project, id, env, input) => {
    const row = { ...input, serviceId: id, environmentId: env, configKey: 'new-source-key' }
    state.serviceSources!.push(row)
    state.services.push(catalog.find((row) => row.id === id)!)
    return { source: row }
  })
  mocks.createTarget.mockImplementation(async (_project, input) => {
    const row = { ...input, id: 'new-target', name: '新服务', configKey: 'new-target-key' }
    state.targets.push(row)
    return { target: row }
  })
  const repositories = [
    { id: 'repo-one', name: '企业仓库', url: 'https://example.invalid/repository.git' },
  ]
  const ui = (
    <SidebarProvider>
      <ModuleSidebarProvider>
        <div style={{ display: 'flex', height: 700, width: '100%' }}>
          <ModuleSidebarOutlet />
          <DeploymentsPanel
            projectId="p-one"
            packages={[]}
            sources={repositories}
            sourcesError={null}
            navigation={null}
            packageActions={null}
            onRefreshPackages={() => {}}
          />
        </div>
      </ModuleSidebarProvider>
    </SidebarProvider>
  )
  return { ui, state, catalog, repositories }
}

it('从环境服务选择具体提交，一次确认后固定 SHA 并显示真实阶段', async () => {
  const f = setup()
  await using screen = await render(f.ui, { router: '/deployments?projectId=p-one' })
  await expect.element(screen.getByRole('button', { name: /修复订单/ })).toBeVisible()
  await screen.getByRole('button', { name: /修复订单/ }).click()
  await screen.getByRole('button', { name: '发布', exact: true }).click()
  await expect.element(page.getByRole('dialog')).toBeVisible()
  expect(mocks.submit).not.toHaveBeenCalled()
  await page.getByText('查看本次采用的配置', { exact: true }).click()
  await expect
    .element(page.getByText('maven:3.9.9-eclipse-temurin-8', { exact: true }))
    .toBeVisible()
  await page.getByRole('button', { name: '确认发布', exact: true }).click()
  await expect.element(screen.getByRole('list', { name: '发布执行流程' })).toBeVisible()
  expect(mocks.submit).toHaveBeenCalledTimes(1)
  expect(mocks.submit.mock.calls[0]![1]).toMatchObject({
    sourceSelection: { sources: [{ refKind: 'commit', ref: 'a'.repeat(40) }] },
    sourceRefs: [{ sourceId: 'repo-one', refKind: 'branch', ref: 'main', commit: 'a'.repeat(40) }],
  })
  expect(screen.router?.state.location.href).toContain('taskId=task-accepted')
})

it('生产只读环境不显示测试服务，环境运维不能新建共享服务', async () => {
  const f = setup()
  await using screen = await render(f.ui, {
    router: '/deployments?projectId=p-one&deploymentEnvironmentId=prod',
  })
  await expect.element(screen.getByText('当前环境还没有服务', { exact: true })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: '添加服务', exact: true })).toBeDisabled()
  expect(screen.container.textContent).not.toContain('后端服务')
  await act(() =>
    screen.router!.navigate({
      href: '/deployments?projectId=p-one&deploymentEnvironmentId=test&setupStep=1&serviceId=new',
    }),
  )
  await expect.element(screen.getByRole('combobox', { name: '复用项目已有服务' })).toBeVisible()
  expect(screen.container.querySelector('input[maxlength="100"]')).toBeNull()
  expect(mocks.saveService).not.toHaveBeenCalled()
})

it.each(['static', 'java'] as const)(
  '管理员分步保存 %s 服务并可从配置步骤继续，保存不发布',
  async (kind) => {
    const f = setup(true)
    await using screen = await render(f.ui, {
      router:
        '/deployments?projectId=p-one&deploymentEnvironmentId=test&setupStep=1&serviceId=new&targetId=new',
    })
    await screen.getByRole('textbox', { name: '服务名称', exact: true }).fill('新服务')
    if (kind === 'java') {
      await screen.getByRole('combobox', { name: '服务类型' }).click()
      await page.getByRole('option', { name: 'Java / Maven' }).click()
    }
    await screen
      .getByRole('button', { name: '添加服务', exact: true })
      .filter({ hasText: '添加服务' })
      .last()
      .click()
    await expect.element(screen.getByRole('button', { name: '保存来源配置' })).toBeVisible()
    expect(screen.router?.state.location.href).toContain('setupStep=2')
    const pointer = sessionStorage.getItem('autoops:deployments:workbench-test:p-one:setup')!
    expect(JSON.parse(pointer)).toMatchObject({ serviceId: 'new-service', setupStep: 2 })
    expect(pointer).not.toContain('sources')
    await screen.getByRole('button', { name: '保存来源配置' }).click()
    await expect
      .element(
        screen.getByRole('textbox', { name: kind === 'static' ? '站点检查地址' : '健康检查路径' }),
      )
      .toBeVisible()
    if (kind === 'static')
      await screen.getByRole('textbox', { name: '站点检查地址' }).fill('http://example.invalid/')
    await screen.getByRole('button', { name: '添加位置', exact: true }).click()
    await expect.poll(() => screen.router?.state.location.href.includes('setupStep')).toBe(false)
    expect(mocks.saveService).toHaveBeenCalledTimes(1)
    expect(mocks.saveSource).toHaveBeenCalledTimes(1)
    expect(mocks.createTarget).toHaveBeenCalledTimes(1)
    expect(mocks.submit).not.toHaveBeenCalled()
  },
)

it('当前环境保留五个服务，环境切换及前进后退恢复选中的服务和页签', async () => {
  const f = setup()
  for (let index = 2; index <= 5; index++)
    f.state.services.push({
      ...f.state.services[0]!,
      id: `service-${index}`,
      name: `服务 ${index}`,
    })
  await using screen = await render(f.ui, {
    router:
      '/deployments?projectId=p-one&deploymentEnvironmentId=test&serviceId=service-5&tab=config',
  })
  await expect.element(screen.getByRole('heading', { name: '服务 5', exact: true })).toBeVisible()
  expect(screen.container.textContent).toContain('服务 2')
  expect(screen.container.textContent).toContain('服务 4')
  await screen.getByRole('combobox', { name: '部署环境' }).click()
  await page.getByRole('option', { name: '生产环境', exact: true }).click()
  await expect.element(screen.getByText('当前环境还没有服务', { exact: true })).toBeVisible()
  await act(() => {
    screen.router!.history.back()
  })
  await expect.element(screen.getByRole('heading', { name: '服务 5', exact: true })).toBeVisible()
  expect(screen.router!.state.location.href).toContain('tab=config')
  await act(() => {
    screen.router!.history.forward()
  })
  await expect.element(screen.getByText('当前环境还没有服务', { exact: true })).toBeVisible()
  expect(mocks.submit).not.toHaveBeenCalled()
})

it('发布响应丢失后只查询原请求，不在刷新或核对时重复发布', async () => {
  const f = setup()
  mocks.submit.mockRejectedValue(new DeploymentRequestError('连接中断，结果待核对', true))
  mocks.receipt.mockImplementation(async (_project, requestId) => ({
    state: 'not_observed',
    requestId,
  }))
  await using screen = await render(f.ui, {
    router: '/deployments?projectId=p-one&deploymentEnvironmentId=test',
  })
  await screen.getByRole('button', { name: /修复订单/ }).click()
  await screen.getByRole('button', { name: '发布', exact: true }).click()
  await page.getByRole('button', { name: '确认发布', exact: true }).click()
  await expect.element(page.getByRole('button', { name: '确认发布', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect.element(screen.getByRole('button', { name: '检查操作结果' })).toBeEnabled()
  const requestId = mocks.submit.mock.calls[0]![1].requestId
  const saved = sessionStorage.getItem('autoops:deployments:workbench-test:p-one:pending')!
  expect(saved).toContain(requestId)
  expect(saved).not.toContain('sourceSelection')
  mocks.receipt.mockResolvedValue({
    state: 'accepted',
    operation: 'task',
    requestId,
    result: { task: { id: 'task-accepted', targetId: 'target-api' } },
  })
  await screen.getByRole('button', { name: '检查操作结果' }).click()
  await expect.poll(() => screen.router!.state.location.href).toContain('taskId=task-accepted')
  expect(mocks.submit).toHaveBeenCalledTimes(1)
  expect(sessionStorage.getItem('autoops:deployments:workbench-test:p-one:pending')).toBeNull()
})

it('多仓库分别选择完整提交，刷新分支不把其他仓库改成最新提交', async () => {
  const f = setup()
  f.repositories.push({
    id: 'repo-two',
    name: '组件仓库',
    url: 'https://example.invalid/components.git',
  })
  f.state.serviceSources![0]!.sources.push({
    sourceId: 'repo-two',
    refKind: 'branch',
    ref: 'main',
    mountPath: 'components',
  })
  mocks.history.mockImplementation(async (_project, sourceId) => ({
    sourceId,
    defaultRef: 'main',
    commits: [
      {
        revision: (sourceId === 'repo-one' ? 'a' : 'b').repeat(40),
        subject: sourceId === 'repo-one' ? '修复订单' : '更新组件',
        authoredAt: '2026-10-30T00:00:00Z',
      },
    ],
  }))
  await using screen = await render(f.ui, {
    router: '/deployments?projectId=p-one&deploymentEnvironmentId=test',
  })
  await screen.getByRole('button', { name: /修复订单/ }).click()
  await expect.element(screen.getByRole('button', { name: '发布', exact: true })).toBeDisabled()
  await screen.getByRole('button', { name: /组件仓库/ }).click()
  await screen.getByRole('button', { name: /更新组件/ }).click()
  await screen.getByRole('button', { name: '刷新分支列表' }).click()
  await expect.element(screen.getByRole('button', { name: '发布', exact: true })).toBeEnabled()
  await screen.getByRole('button', { name: '发布', exact: true }).click()
  await page.getByRole('button', { name: '确认发布', exact: true }).click()
  await expect.poll(() => mocks.submit.mock.calls.length).toBe(1)
  expect(
    mocks.submit.mock.calls[0]![1].sourceSelection.sources.map((row: { ref: string }) => row.ref),
  ).toEqual(['a'.repeat(40), 'b'.repeat(40)])
})

it('未保存输入阻止离开，继续编辑保留草稿，放弃后才切换环境', async () => {
  const f = setup(true)
  await using screen = await render(f.ui, {
    router:
      '/deployments?projectId=p-one&deploymentEnvironmentId=test&serviceId=service-api&setupStep=1',
  })
  await screen.getByRole('textbox', { name: '服务名称', exact: true }).fill('保留中的输入')
  await screen.getByRole('combobox', { name: '部署环境' }).click()
  await page.getByRole('option', { name: '生产环境', exact: true }).click()
  await screen.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect
    .element(screen.getByRole('textbox', { name: '服务名称', exact: true }))
    .toHaveValue('保留中的输入')
  await screen.getByRole('combobox', { name: '部署环境' }).click()
  await page.getByRole('option', { name: '生产环境', exact: true }).click()
  await screen.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect.element(screen.getByText('当前环境还没有服务', { exact: true })).toBeVisible()
  expect(mocks.saveService).not.toHaveBeenCalled()
})

it('刷新后从独立草稿入口继续未关联的服务配置，不混入环境服务列表', async () => {
  const f = setup(true)
  await using first = await render(f.ui, {
    router:
      '/deployments?projectId=p-one&deploymentEnvironmentId=test&setupStep=1&serviceId=new&targetId=new',
  })
  await first.getByRole('textbox', { name: '服务名称', exact: true }).fill('待关联服务')
  await first.getByRole('button', { name: '添加服务', exact: true }).last().click()
  await expect.element(first.getByRole('button', { name: '保存来源配置' })).toBeVisible()
  await first.unmount()
  await using restored = await render(f.ui, {
    router: '/deployments?projectId=p-one&deploymentEnvironmentId=test',
  })
  await expect
    .element(restored.getByRole('heading', { name: '后端服务', exact: true }))
    .toBeVisible()
  await restored.getByRole('button', { name: /继续配置/ }).click()
  await expect.element(restored.getByRole('button', { name: '保存来源配置' })).toBeVisible()
  expect(restored.router!.state.location.href).toContain('serviceId=new-service')
  expect(restored.router!.state.location.href).toContain('setupStep=2')
  expect(mocks.saveService).toHaveBeenCalledTimes(1)
  expect(mocks.submit).not.toHaveBeenCalled()
})

it('删除当前部署位置后保留服务定位及来源，不跳到其他服务', async () => {
  const f = setup(true)
  const second = { ...f.state.services[0]!, id: 'service-second', name: '第二服务' }
  f.state.services.push(second)
  f.state.targets.push({
    ...f.state.targets[0]!,
    id: 'target-second',
    name: second.name,
    serviceId: second.id,
  })
  f.state.serviceSources!.push({ ...f.state.serviceSources![0]!, serviceId: second.id })
  mocks.remove.mockImplementation(async (_project, kind, id) => {
    expect(kind).toBe('target')
    f.state.targets = f.state.targets.filter((row) => row.id !== id)
    return { deleted: true, id }
  })
  await using screen = await render(f.ui, {
    router:
      '/deployments?projectId=p-one&deploymentEnvironmentId=test&serviceId=service-second&targetId=target-second',
  })
  await expect.element(screen.getByRole('heading', { name: '第二服务', exact: true })).toBeVisible()
  await screen.getByRole('button', { name: '服务操作' }).click()
  await page.getByRole('menuitem', { name: '删除当前部署位置' }).click()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.poll(() => screen.router!.state.location.href).toContain('serviceId=service-second')
  await expect.poll(() => mocks.remove.mock.calls.length).toBe(1)
  await expect.element(screen.getByRole('heading', { name: '第二服务', exact: true })).toBeVisible()
  expect(f.state.targets.some((row) => row.id === 'target-api')).toBe(true)
  expect(f.state.serviceSources!.some((row) => row.serviceId === second.id)).toBe(true)
})
