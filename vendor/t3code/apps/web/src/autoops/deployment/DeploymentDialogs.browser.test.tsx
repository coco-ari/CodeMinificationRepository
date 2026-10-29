import { describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { act, render } from '../../../test/render'
import type {
  DeploymentOverview,
  DeploymentRelease,
  DeploymentService,
  DeploymentTarget,
  JavaDeploymentConfig,
  StaticDeploymentConfig,
} from '../deployments'
import { ConfigurationDetails } from './ConfigurationDetails'
import {
  ReleaseDialog,
  TargetDialog,
  ServiceDialog,
  ServiceSourceDialog,
} from './DeploymentDialogs'
import type { WorkspaceRepositorySource } from '../workspaceAuthoring'
import { deploymentConfigDefaults } from './DeploymentConfigurationFields'
import '../../index.css'

function fixture() {
  const config: StaticDeploymentConfig = {
    kind: 'static',
    module: 'frontend-current',
    artifactPath: 'frontend-current/dist',
    buildImage: 'node:24-bookworm-slim',
    packageManager: 'npm',
    packageManagerVersion: '10.9.9',
    buildScript: 'build',
    buildArgs: ['--mode', 'production'],
    build: { cpus: 1, memoryMb: 1024 },
    health: {
      url: 'https://current.example.invalid/',
      bodyIncludes: '现行响应',
      status: 200,
      timeoutSeconds: 180,
      intervalSeconds: 5,
    },
  }
  const target: DeploymentTarget = {
    id: 'target-history-confirmation',
    name: '隔离前端服务',
    environmentId: 'test-environment',
    serverId: 'test-server',
    serviceId: 'test-service',
    configKey: 'current-configuration-key',
    config,
  }
  const release: DeploymentRelease = {
    id: 'historical-release',
    targetId: target.id,
    createdAt: '2026-10-23T00:00:00Z',
    revision: 'historical-revision',
    available: true,
    current: false,
    config: {
      ...config,
      module: 'frontend-history',
      artifactPath: 'frontend-history/site',
      health: {
        ...config.health,
        url: 'https://history.example.invalid/',
        bodyIncludes: '历史响应',
        timeoutSeconds: 120,
        intervalSeconds: 3,
      },
    },
  }
  return { target, release, config }
}

describe('部署确认与配置', () => {
  it('自动刷新不覆盖草稿或条件键，核对最新配置后才显式采用新版本', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const service: DeploymentService = {
      id: 'shared-service',
      name: '共享服务',
      kind: 'java',
      module: '.',
      configKey: 'old-key',
    }
    const view = (value: DeploymentService) => (
      <ServiceDialog
        service={value}
        embedded
        open
        busy={false}
        error={null}
        onSubmit={onSubmit}
        onOpenChange={() => {}}
        finalFocus={false}
      />
    )
    await using screen = await render(view(service))
    await screen.getByRole('textbox', { name: '服务名称', exact: true }).fill('尚未保存的名称')
    await screen.rerender(view({ ...service, name: '其他人保存的名称', configKey: 'new-key' }))
    await expect
      .element(screen.getByRole('textbox', { name: '服务名称', exact: true }))
      .toHaveValue('尚未保存的名称')
    await screen.getByRole('button', { name: '保存服务', exact: true }).click()
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      name: '尚未保存的名称',
      configKey: 'old-key',
    })
    await screen.getByText('核对最新配置', { exact: true }).click()
    await expect.element(screen.getByText(/其他人保存的名称/)).toBeVisible()
    await screen.getByRole('button', { name: '已核对，保留输入并采用新版本' }).click()
    await screen.getByRole('button', { name: '保存服务', exact: true }).click()
    expect(onSubmit.mock.calls[1]![0]).toMatchObject({
      name: '尚未保存的名称',
      configKey: 'new-key',
    })
  })
  it('回退确认展示历史配置，提交仍使用现行配置键检查并发变更', async () => {
    const { target, release } = fixture()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    await using screen = await render(
      <ReleaseDialog
        projectId="p-test"
        target={target}
        serverName="隔离服务器"
        environmentName="隔离环境"
        packages={[]}
        releases={[release]}
        rollbackId={release.id}
        action="rollback"
        busy={false}
        error={null}
        onSubmit={onSubmit}
        open
        onOpenChange={() => {}}
        finalFocus={false}
      />,
    )
    await expect.element(page.getByText('frontend-history', { exact: true })).toBeVisible()
    await expect.element(page.getByText('frontend-history/site', { exact: true })).toBeVisible()
    await expect
      .element(page.getByText('https://history.example.invalid/', { exact: true }))
      .toBeVisible()
    await expect.element(page.getByText('历史响应', { exact: true })).toBeVisible()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '120 秒内，每 3 秒检查',
    )
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('frontend-current')
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
      'https://current.example.invalid/',
    )
    await page.getByRole('button', { name: '确认回退', exact: true }).click()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      targetId: target.id,
      action: 'rollback',
      service: 'frontend',
      configKey: target.configKey,
      releaseId: release.id,
    })
  })

  it('缺少历史配置时明确阻止回退，不回填现行配置', async () => {
    const { target, release } = fixture()
    const { config: _historicalConfig, ...missingConfigRelease } = release
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    await using screen = await render(
      <ReleaseDialog
        projectId="p-test"
        target={target}
        serverName="隔离服务器"
        environmentName="隔离环境"
        packages={[]}
        releases={[missingConfigRelease]}
        rollbackId={release.id}
        action="rollback"
        busy={false}
        error={null}
        onSubmit={onSubmit}
        open
        onOpenChange={() => {}}
        finalFocus={false}
      />,
    )
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('历史配置不可用，无法确认回退。请重新加载发布记录后核对。')
    await expect.element(page.getByRole('button', { name: '确认回退', exact: true })).toBeDisabled()
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('frontend-current')
    await act(() => {
      document
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('当前版本默认不能回退，运行结果待核查时可重新恢复上次确认版本', async () => {
    const { target, release } = fixture()
    release.current = true
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const props = {
      projectId: 'p-test',
      target,
      serverName: '隔离服务器',
      environmentName: '隔离环境',
      packages: [],
      releases: [release],
      rollbackId: release.id,
      action: 'rollback' as const,
      busy: false,
      error: null,
      onSubmit,
      open: true,
      onOpenChange: () => {},
      finalFocus: false as const,
    }
    await using screen = await render(<ReleaseDialog {...props} />)
    await expect.element(page.getByRole('button', { name: '确认回退', exact: true })).toBeDisabled()
    await screen.rerender(<ReleaseDialog {...props} allowCurrentRelease />)
    await expect
      .element(page.getByRole('button', { name: '尝试重新恢复上次确认版本', exact: true }))
      .toBeEnabled()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('当前运行结果待核查')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '执行器会先核对现场状态',
    )
    await page.getByRole('button', { name: '尝试重新恢复上次确认版本', exact: true }).click()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      targetId: target.id,
      action: 'rollback',
      service: 'frontend',
      configKey: target.configKey,
      releaseId: release.id,
    })
  })

  it('配置按职责分组且保留全部业务值，目标标识按需展开', async () => {
    const { target, config } = fixture()
    await using screen = await render(<ConfigurationDetails target={target} />)
    for (const name of ['下次发布配置', '构建', '验证与恢复']) {
      await expect.element(screen.getByRole('heading', { name, exact: true })).toBeVisible()
    }
    for (const value of [
      config.health.url,
      target.config.module,
      target.config.artifactPath,
      target.config.buildImage,
      'npm 10.9.9',
      config.buildScript,
      '1 CPU / 1024 MB',
      'HTTP 200',
      '现行响应',
      '180 秒内，每 5 秒检查',
    ]) {
      expect(screen.container.textContent).toContain(value)
    }
    expect(screen.container.textContent).toContain('--mode\nproduction')
    expect(screen.container.textContent).not.toContain(target.id)
    await screen.getByRole('button', { name: '查看目标标识' }).click()
    await expect.element(screen.getByText(target.id, { exact: true })).toBeVisible()
  })
})

function javaFixture() {
  const config = deploymentConfigDefaults('java', '.') as JavaDeploymentConfig
  const service: DeploymentService = {
    id: 'java-service',
    name: '订单服务',
    kind: 'java',
    module: '.',
    configKey: 'service-key',
  }
  const target: DeploymentTarget = {
    id: 'java-target',
    name: service.name,
    serviceId: service.id,
    environmentId: 'test',
    serverId: 'node-one',
    configKey: 'draft-key',
    config,
  }
  const overview: DeploymentOverview = {
    enabled: true,
    services: [service],
    environments: [{ id: 'test', name: '测试' }],
    servers: [{ id: 'node-one', name: '测试节点', environmentId: 'test', online: true }],
    targets: [],
    tasks: [],
  }
  const sources: WorkspaceRepositorySource[] = [
    {
      id: 'java-source',
      name: '订单仓库',
      role: 'backend',
      mountPath: 'apps/order',
      url: 'https://github.com/example/order',
      refKind: 'branch',
      ref: 'release',
    },
  ]
  return { config, service, target, overview, sources }
}

describe('Java 服务、位置与直接发布', () => {
  it('独立创建服务不依赖服务器，服务类型与目录随表单提交', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    await using screen = await render(
      <ServiceDialog
        open
        onOpenChange={() => {}}
        finalFocus={false}
        busy={false}
        error={null}
        onSubmit={onSubmit}
      />,
    )
    await page.getByRole('textbox', { name: '服务名称', exact: true }).fill('订单服务')
    await page.getByRole('combobox', { name: '服务类型', exact: true }).click()
    await page.getByRole('option', { name: 'Java / Maven', exact: true }).click()
    await page.getByRole('textbox', { name: '构建目录', exact: true }).fill('services/order')
    await page.getByRole('button', { name: '添加服务', exact: true }).click()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      name: '订单服务',
      kind: 'java',
      module: 'services/order',
    })
  })

  it('Java 位置保存容器检查与运行配置，不提交静态站点字段', async () => {
    const { overview, service, config } = javaFixture()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    await using screen = await render(
      <TargetDialog
        open
        onOpenChange={() => {}}
        finalFocus={false}
        overview={overview}
        service={service}
        environmentId="test"
        busy={false}
        error={null}
        onSubmit={onSubmit}
        onUpdate={vi.fn()}
      />,
    )
    await page
      .getByRole('textbox', { name: '运行镜像', exact: true })
      .fill('eclipse-temurin:21-jre')
    await page.getByRole('textbox', { name: '健康检查路径', exact: true }).fill('/ready')
    await page.getByRole('button', { name: '添加位置', exact: true }).click()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      serviceId: service.id,
      environmentId: 'test',
      serverId: 'node-one',
      networkIdentity: null,
      config: {
        ...config,
        runtimeImage: 'eclipse-temurin:21-jre',
        health: { ...config.health, path: '/ready' },
      },
    })
    expect(document.querySelector('[role=dialog]')?.textContent).not.toContain('站点检查地址')
  })

  it('从已有位置复制配置不会复制固定网络身份，长参数失焦后完整保存', async () => {
    const { overview, service, target, config } = javaFixture()
    const copied = {
      ...target,
      config: { ...config, runtimeImage: 'eclipse-temurin:21-jre', jvmArgs: ['-Xmx768m'] },
      networkIdentity: { network: 'project-test', alias: 'order-one' },
    }
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    await using screen = await render(
      <TargetDialog
        open
        onOpenChange={() => {}}
        finalFocus={false}
        overview={{
          ...overview,
          targets: [copied],
          servers: [
            ...overview.servers,
            { id: 'node-two', name: '第二节点', environmentId: 'test', online: true },
          ],
        }}
        service={service}
        environmentId="test"
        busy={false}
        error={null}
        onSubmit={onSubmit}
        onUpdate={vi.fn()}
      />,
    )
    await page.getByRole('combobox', { name: '配置模板', exact: true }).click()
    await page.getByRole('option', { name: '测试节点 · 测试', exact: true }).click()
    await expect
      .element(page.getByRole('textbox', { name: '运行镜像', exact: true }))
      .toHaveValue('eclipse-temurin:21-jre')
    await page.getByRole('button', { name: '更多构建与检查配置', exact: true }).click()
    const args = `-Xmx768m\n-Ddeployment.description=${'long-value-'.repeat(40)}`
    await page.getByRole('textbox', { name: 'JVM 参数（每行一个）', exact: true }).fill(args)
    await page.getByRole('textbox', { name: '运行镜像', exact: true }).click()
    await expect
      .element(page.getByRole('textbox', { name: 'JVM 参数（每行一个）', exact: true }))
      .toHaveValue(args)
    await page.getByRole('button', { name: '固定网络身份', exact: true }).click()
    await expect
      .element(page.getByRole('textbox', { name: '固定网络', exact: true }))
      .toHaveValue('')
    await expect
      .element(page.getByRole('textbox', { name: '服务别名', exact: true }))
      .toHaveValue('')
    await page.getByRole('button', { name: '添加位置', exact: true }).click()
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'node-two',
        networkIdentity: null,
        config: expect.objectContaining({
          jvmArgs: args.split('\n'),
          runtimeImage: 'eclipse-temurin:21-jre',
        }),
      }),
    )
  })

  it('固定网络和别名成对填写，原生表单校验拒绝非法别名', async () => {
    const { overview, service } = javaFixture()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    await using screen = await render(
      <TargetDialog
        open
        onOpenChange={() => {}}
        finalFocus={false}
        overview={overview}
        service={service}
        environmentId="test"
        busy={false}
        error={null}
        onSubmit={onSubmit}
        onUpdate={vi.fn()}
      />,
    )
    await page.getByRole('button', { name: '固定网络身份', exact: true }).click()
    await page.getByRole('textbox', { name: '固定网络', exact: true }).fill('project-test')
    await expect.element(page.getByRole('button', { name: '添加位置', exact: true })).toBeDisabled()
    await page.getByRole('textbox', { name: '服务别名', exact: true }).fill('INVALID ALIAS')
    await page.getByRole('button', { name: '添加位置', exact: true }).click()
    expect(onSubmit).not.toHaveBeenCalled()
    await page.getByRole('textbox', { name: '服务别名', exact: true }).fill('order-test')
    await page.getByRole('button', { name: '添加位置', exact: true }).click()
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        networkIdentity: { network: 'project-test', alias: 'order-test' },
      }),
    )
  })

  it('编辑配置保留打开时配置键，不用轮询新键提交旧草稿', async () => {
    const { overview, service, target } = javaFixture()
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    const props = {
      open: true,
      onOpenChange: () => {},
      finalFocus: false as const,
      overview: { ...overview, targets: [target] },
      service,
      environmentId: 'test',
      busy: false,
      error: null,
      onSubmit: vi.fn(),
      onUpdate,
    }
    await using screen = await render(<TargetDialog {...props} target={target} />)
    await page
      .getByRole('textbox', { name: '运行镜像', exact: true })
      .fill('eclipse-temurin:21-jre')
    await screen.rerender(
      <TargetDialog {...props} target={{ ...target, configKey: 'new-server-key' }} />,
    )
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        configKey: 'draft-key',
        config: expect.objectContaining({ runtimeImage: 'eclipse-temurin:21-jre' }),
      }),
    )
  })

  it('重启展示上次确认版本的健康配置，不采用下次发布草稿', async () => {
    const { target, config } = javaFixture()
    const currentRelease: DeploymentRelease = {
      id: 'confirmed-java',
      targetId: target.id,
      createdAt: '2026-10-25T00:00:00Z',
      config: { ...config, health: { ...config.health, path: '/historical-ready' } },
    }
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    await using screen = await render(
      <ReleaseDialog
        projectId="p-test"
        target={{ ...target, currentRelease }}
        serverName="测试节点"
        environmentName="测试"
        packages={[]}
        releases={[]}
        rollbackId=""
        action="restart"
        busy={false}
        error={null}
        onSubmit={onSubmit}
        open
        onOpenChange={() => {}}
        finalFocus={false}
      />,
    )
    await expect
      .element(page.getByText('容器端口 8080/historical-ready', { exact: true }))
      .toBeVisible()
    await page.getByRole('button', { name: '确认重启', exact: true }).click()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      targetId: target.id,
      action: 'restart',
      service: 'backend',
      configKey: target.configKey,
    })
  })

  it('缺少当前运行配置时阻止重启并保留明确错误', async () => {
    const { target } = javaFixture()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    await using screen = await render(
      <ReleaseDialog
        projectId="p-test"
        target={{
          ...target,
          currentRelease: {
            id: 'confirmed-java',
            targetId: target.id,
            createdAt: '2026-10-25T00:00:00Z',
          },
        }}
        serverName="测试节点"
        environmentName="测试"
        packages={[]}
        releases={[]}
        rollbackId=""
        action="restart"
        busy={false}
        error={null}
        onSubmit={onSubmit}
        open
        onOpenChange={() => {}}
        finalFocus={false}
      />,
    )
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('当前运行配置不可用，无法确认重启。请重新加载运行信息后核对。')
    await expect.element(page.getByRole('button', { name: '确认重启', exact: true })).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('无需已有包即可从 Git 分支直接提交发布，保存来源是独立操作', async () => {
    const { target, sources } = javaFixture()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    await using screen = await render(
      <ReleaseDialog
        projectId="p-test"
        target={target}
        sources={sources}
        serverName="测试节点"
        environmentName="测试"
        packages={[]}
        releases={[]}
        rollbackId=""
        action="deploy"
        busy={false}
        error={null}
        onSubmit={onSubmit}
        open
        onOpenChange={() => {}}
        finalFocus={false}
      />,
    )
    await expect
      .element(page.getByRole('combobox', { name: '订单仓库版本类型', exact: true }))
      .toHaveTextContent('默认分支')
    await page.getByRole('combobox', { name: '订单仓库版本类型', exact: true }).click()
    await page.getByRole('option', { name: '分支', exact: true }).click()
    await page
      .getByRole('textbox', { name: '订单仓库版本引用', exact: true })
      .fill('release-candidate')
    await page.getByRole('button', { name: '确认发布', exact: true }).click()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      targetId: target.id,
      action: 'deploy',
      service: 'backend',
      configKey: target.configKey,
      sourceSelection: {
        sources: [
          {
            sourceId: sources[0]!.id,
            mountPath: 'repository',
            refKind: 'branch',
            ref: 'release-candidate',
          },
        ],
        contexts: [{ service: 'backend', root: 'repository', workingDirectory: '.' }],
      },
    })
  })

  it.each([false, true])(
    '发布默认来源优先已保存配置，其次上次确认发布来源（已保存：%s）',
    async (saved) => {
      const { target, sources } = javaFixture()
      const onSubmit = vi.fn().mockResolvedValue(undefined)
      const context = [{ service: 'backend' as const, root: 'apps/order', workingDirectory: '.' }]
      const currentRelease: DeploymentRelease = {
        id: 'current-release',
        targetId: target.id,
        createdAt: '2026-10-25T00:00:00Z',
        config: target.config,
        sourceSelection: {
          sources: [
            {
              sourceId: sources[0]!.id,
              mountPath: 'apps/order',
              refKind: 'branch',
              ref: 'running-branch',
            },
          ],
          contexts: context,
        },
      }
      const savedSource = {
        serviceId: target.serviceId,
        environmentId: target.environmentId,
        configKey: 'source-key',
        sources: [
          {
            sourceId: sources[0]!.id,
            mountPath: 'apps/order',
            refKind: 'tag' as const,
            ref: 'saved-tag',
          },
        ],
        contexts: context,
      }
      await using screen = await render(
        <ReleaseDialog
          projectId="p-test"
          target={{ ...target, currentRelease }}
          sources={sources}
          defaultSource={saved ? savedSource : undefined}
          serverName="测试节点"
          environmentName="测试"
          packages={[]}
          releases={[]}
          rollbackId=""
          action="deploy"
          busy={false}
          error={null}
          onSubmit={onSubmit}
          open
          onOpenChange={() => {}}
          finalFocus={false}
        />,
      )
      await expect
        .element(page.getByRole('textbox', { name: '订单仓库版本引用', exact: true }))
        .toHaveValue(saved ? 'saved-tag' : 'running-branch')
      await page.getByRole('button', { name: '确认发布', exact: true }).click()
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceSelection: saved
            ? { sources: savedSource.sources, contexts: context }
            : currentRelease.sourceSelection,
        }),
      )
    },
  )

  it('保存来源的仓库被移除时不静默部分发布，重新选择后才提交当前仓库', async () => {
    const { target, sources } = javaFixture()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const defaultSource = {
      serviceId: target.serviceId,
      environmentId: target.environmentId,
      configKey: 'source-key',
      sources: [
        {
          sourceId: sources[0]!.id,
          mountPath: 'apps/order',
          refKind: 'branch' as const,
          ref: 'release',
        },
        { sourceId: 'removed-shared', mountPath: 'shared', refKind: 'default' as const, ref: '' },
      ],
      contexts: [{ service: 'backend' as const, root: 'apps/order', workingDirectory: '.' }],
    }
    await using screen = await render(
      <ReleaseDialog
        projectId="p-test"
        target={target}
        sources={sources}
        defaultSource={defaultSource}
        serverName="测试节点"
        environmentName="测试"
        packages={[]}
        releases={[]}
        rollbackId=""
        action="deploy"
        busy={false}
        error={null}
        onSubmit={onSubmit}
        open
        onOpenChange={() => {}}
        finalFocus={false}
      />,
    )
    await expect.element(page.getByRole('button', { name: '确认发布', exact: true })).toBeDisabled()
    await expect
      .element(page.getByRole('alert'))
      .toMatchTextContent(/保存的来源已变化，请重新选择仓库。/)
    await page.getByRole('button', { name: '重新选择仓库', exact: true }).click()
    await page.getByRole('button', { name: '确认发布', exact: true }).click()
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSelection: {
          sources: [
            {
              sourceId: sources[0]!.id,
              mountPath: 'repository',
              refKind: 'default',
              ref: '',
            },
          ],
          contexts: defaultSource.contexts,
        },
      }),
    )
  })

  it('保存默认来源保留原配置键，不隐式发布任务', async () => {
    const { service, sources } = javaFixture()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const source = {
      serviceId: service.id,
      environmentId: 'test',
      configKey: 'source-key',
      sources: [
        {
          sourceId: sources[0]!.id,
          mountPath: 'apps/order',
          refKind: 'branch' as const,
          ref: 'saved-release',
        },
      ],
      contexts: [{ service: 'backend' as const, root: 'apps/order', workingDirectory: '.' }],
    }
    await using screen = await render(
      <ServiceSourceDialog
        service={service}
        sources={sources}
        source={source}
        busy={false}
        error={null}
        onSubmit={onSubmit}
        open
        onOpenChange={() => {}}
        finalFocus={false}
      />,
    )
    await page.getByRole('textbox', { name: '订单仓库版本引用', exact: true }).fill('release-next')
    await page.getByRole('button', { name: '保存来源配置', exact: true }).click()
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      configKey: 'source-key',
      sources: [
        {
          sourceId: sources[0]!.id,
          mountPath: 'apps/order',
          refKind: 'branch',
          ref: 'release-next',
        },
      ],
      contexts: source.contexts,
    })
  })
})
