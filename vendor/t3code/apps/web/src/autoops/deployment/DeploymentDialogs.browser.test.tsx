import { describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { act, render } from '../../../test/render'
import type { DeploymentRelease, DeploymentTarget, StaticDeploymentConfig } from '../deployments'
import { ConfigurationDetails } from './ConfigurationDetails'
import { ReleaseDialog } from './DeploymentDialogs'
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
  return { target, release }
}

describe('部署确认与配置', () => {
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
    const { target } = fixture()
    await using screen = await render(<ConfigurationDetails target={target} />)
    for (const name of ['目标与站点', '构建', '验证与恢复']) {
      await expect.element(screen.getByRole('heading', { name, exact: true })).toBeVisible()
    }
    for (const value of [
      target.config.health.url,
      target.config.module,
      target.config.artifactPath,
      target.config.buildImage,
      'npm 10.9.9',
      target.config.buildScript,
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
