import { describe, expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { act, render } from '../../../test/render'
import { autoOpsRequest, AutoOpsRequestError } from '../apiClient'
import type { DeploymentRelease, DeploymentTarget } from '../deployments'
import { DeploymentHistory } from './DeploymentHistory'
import '../../index.css'

vi.mock(import('../apiClient'), async (original) => ({
  ...(await original()),
  autoOpsRequest: vi.fn(),
}))
vi.mock(import('../hostSnapshot'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: () => ({
    principal: { id: 'history-user', displayName: '验收用户' },
    gatewayBasePath: '/api/agent-demo/t3',
    csrfToken: 'test-csrf',
    fixedModel: { instanceId: 'test', model: 'test' },
    runtimeMode: 'approval-required' as const,
    projects: [],
    capabilities: {},
    httpBaseUrl: 'http://localhost',
    wsBaseUrl: 'ws://localhost',
  }),
}))
const request = vi.mocked(autoOpsRequest)
const release: DeploymentRelease = {
  id: 'release-one',
  targetId: 'target-one',
  createdAt: '2026-10-25T00:00:00Z',
  revision: 'a'.repeat(40),
  available: true,
  archiveStatus: 'available',
}
const target: DeploymentTarget = {
  id: 'target-one',
  serviceId: 'service-one',
  name: '版本测试',
  environmentId: 'env-test',
  serverId: 'server-one',
  configKey: 'config-one',
  config: {
    kind: 'static',
    module: '.',
    artifactPath: 'dist',
    buildImage: 'node:24',
    packageManager: 'npm',
    packageManagerVersion: '10.8.2',
    buildScript: 'build',
    buildArgs: [],
    build: { cpus: 1, memoryMb: 512 },
    health: {
      url: 'https://example.invalid',
      bodyIncludes: '',
      status: 200,
      timeoutSeconds: 180,
      intervalSeconds: 5,
    },
  },
}
const denied = vi.fn(),
  rollback = vi.fn()
const view = () => (
  <DeploymentHistory
    projectId="project-one"
    target={target}
    releases={[]}
    error={null}
    disabled={false}
    mutationDisabled={false}
    allowCurrentRelease={false}
    onRollback={rollback}
    onAccessDenied={denied}
  />
)
function setup() {
  request.mockReset()
  denied.mockReset()
  rollback.mockReset()
  sessionStorage.clear()
}

describe('部署历史与源码档案', () => {
  it('版本链直接显示历史分支和固定提交，回退仍使用所选历史记录', async () => {
    setup()
    const historical: DeploymentRelease = {
      ...release,
      sourceIdentity: { repositories: [{ path: '.', commit: 'a'.repeat(40) }] },
      sourceSelection: { sources: [{ sourceId: 'repo-one', refKind: 'branch', ref: 'release/history', mountPath: '.' }], contexts: [] },
    }
    request.mockResolvedValue({ releases: [historical], total: 1, nextOffset: null })
    await using screen = await render(view())
    await expect.element(screen.getByText('release/history', { exact: true })).toBeVisible()
    await expect.element(screen.getByText('aaaaaaaaaaaa', { exact: true })).toBeVisible()
    await expect.element(screen.getByText('源码包可恢复', { exact: true })).toBeVisible()
    await screen.getByRole('button', { name: '回退', exact: true }).click()
    expect(rollback).toHaveBeenCalledWith(historical)
    expect(request.mock.calls.every(([path]) => !path.includes('/refs') && !path.includes('/commits'))).toBe(true)
  })

  it('分页后回退使用选中的历史版本，不替换为当前版本', async () => {
    setup()
    const older = { ...release, id: 'older-release', revision: 'b'.repeat(40) }
    request.mockImplementation(async (path) =>
      path.includes('offset=20')
        ? { releases: [older], total: 21, nextOffset: null }
        : { releases: [release], total: 21, nextOffset: 20 },
    )
    await using screen = await render(view())
    await expect.element(screen.getByText('aaaaaaaaaaaa')).toBeVisible()
    await screen.getByRole('button', { name: '下一页' }).click()
    await expect.element(screen.getByText('bbbbbbbbbbbb')).toBeVisible()
    await screen.getByRole('button', { name: '回退', exact: true }).click()
    expect(rollback).toHaveBeenCalledWith(older)
  })

  it('清理结果未知只提供原请求重试，成功后更新记录', async () => {
    setup()
    let attempts = 0
    request.mockImplementation(async (_path, options) => {
      if (options.method === 'DELETE') {
        attempts++
        if (attempts === 1)
          throw new AutoOpsRequestError(
            '暂时无法确认清理结果',
            'CONNECTION_FAILED',
            undefined,
            true,
          )
        return { ok: true }
      }
      return { releases: [release], total: 1, nextOffset: null }
    })
    await using screen = await render(view())
    await expect.element(screen.getByRole('button', { name: '详情' })).toBeVisible()
    await screen.getByRole('button', { name: '详情' }).click()
    await page.getByRole('button', { name: '清理源码', exact: true }).click()
    await page.getByRole('button', { name: '确认清理' }).click()
    await expect.element(page.getByRole('dialog')).toMatchTextContent(/暂时无法确认清理结果/)
    await userEvent.keyboard('{Escape}')
    await screen.getByRole('button', { name: '重试', exact: true }).click()
    await expect
      .poll(() => request.mock.calls.filter(([, options]) => options.method === 'DELETE').length)
      .toBe(2)
    const writes = request.mock.calls.filter(([, options]) => options.method === 'DELETE')
    expect(writes[1]?.[1].body).toEqual(writes[0]?.[1].body)
    await expect.element(screen.getByText('上次清理尚未完成')).not.toBeInTheDocument()
    expect(sessionStorage.length).toBe(0)
  })

  it('当前版本与恢复保护禁止清理，Esc 返回原详情入口焦点', async () => {
    setup()
    request.mockResolvedValue({
      releases: [{ ...release, current: true, archiveProtected: true }],
      total: 1,
      nextOffset: null,
    })
    await using screen = await render(view())
    await expect.element(screen.getByRole('button', { name: '详情' })).toBeVisible()
    await screen.getByRole('button', { name: '详情' }).click()
    await expect.element(page.getByRole('button', { name: '清理源码', exact: true })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('button', { name: '详情' })).toHaveFocus()
  })

  it('读取被撤权时清空历史并交还区域权限处理', async () => {
    setup()
    request.mockRejectedValue(new AutoOpsRequestError('无权查看', 'FORBIDDEN', 403))
    await using screen = await render(view())
    await expect.element(screen.getByRole('alert')).toHaveTextContent('无权查看')
    expect(denied).toHaveBeenCalledTimes(1)
    await expect.element(screen.getByRole('button', { name: '详情' })).not.toBeInTheDocument()
  })

  it('清理明确被保护规则拒绝时显示错误，不保留未知操作或阻塞其他版本', async () => {
    setup()
    request.mockImplementation(async (_path, options) => {
      if (options.method === 'DELETE')
        throw new AutoOpsRequestError('该版本是恢复基线，不能清理。', 'SOURCE_PROTECTED', 409)
      return { releases: [release], total: 1, nextOffset: null }
    })
    await using screen = await render(view())
    await screen.getByRole('button', { name: '详情' }).click()
    await page.getByRole('button', { name: '清理源码', exact: true }).click()
    await page.getByRole('button', { name: '确认清理' }).click()
    await expect.element(page.getByRole('dialog')).toMatchTextContent(/该版本是恢复基线，不能清理/)
    await expect.element(page.getByRole('button', { name: '确认清理' })).toBeEnabled()
    expect(sessionStorage.length).toBe(0)
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByText('上次清理尚未完成')).not.toBeInTheDocument()
  })

  it('切换目标后取消旧下载查询，迟到文件元数据不能触发下载', async () => {
    setup()
    let resolveDownload!: (result: { name: string }) => void
    let downloadSignal: AbortSignal | undefined
    request.mockImplementation(async (path, options) => {
      if (path.includes('metadata=1')) {
        downloadSignal = options.signal
        return new Promise((resolve) => {
          resolveDownload = resolve
        })
      }
      return { releases: [release], total: 1, nextOffset: null }
    })
    await using screen = await render(view())
    using click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await screen.getByRole('button', { name: '详情' }).click()
    await page.getByRole('button', { name: '下载源码', exact: true }).click()
    await screen.unmount()
    await act(() => {
      resolveDownload({ name: 'old-source.zip' })
    })
    expect(downloadSignal?.aborted).toBe(true)
    expect(click).not.toHaveBeenCalled()
  })

  it('当前发布指针变化后自动刷新历史，旧版本不再标为当前保护版本', async () => {
    setup()
    const newer = { ...release, id: 'release-two', revision: 'b'.repeat(40), current: true }
    request.mockResolvedValueOnce({
      releases: [{ ...release, current: true }],
      total: 1,
      nextOffset: null,
    })
    await using screen = await render(view())
    await expect.element(screen.getByText('aaaaaaaaaaaa')).toBeVisible()
    request.mockResolvedValue({ releases: [newer], total: 1, nextOffset: null })
    await screen.rerender(
      <DeploymentHistory
        projectId="project-one"
        target={{ ...target, currentRelease: newer }}
        releases={[newer]}
        error={null}
        disabled={false}
        mutationDisabled={false}
        allowCurrentRelease={false}
        onRollback={rollback}
        onAccessDenied={denied}
      />,
    )
    await expect.element(screen.getByText('bbbbbbbbbbbb')).toBeVisible()
    await expect.element(screen.getByText('aaaaaaaaaaaa')).not.toBeInTheDocument()
  })

  it('离开目标后旧清理响应不能触发新区域撤权，原请求仍可核对', async () => {
    setup()
    let rejectClear!: (error: Error) => void
    request.mockImplementation(async (_path, options) => {
      if (options.method === 'DELETE')
        return new Promise((_resolve, reject) => {
          rejectClear = reject
        })
      return { releases: [release], total: 1, nextOffset: null }
    })
    await using screen = await render(view())
    await screen.getByRole('button', { name: '详情' }).click()
    await page.getByRole('button', { name: '清理源码', exact: true }).click()
    await page.getByRole('button', { name: '确认清理' }).click()
    await screen.unmount()
    await act(() => {
      rejectClear(new AutoOpsRequestError('旧目标已撤权', 'FORBIDDEN', 403))
    })
    expect(denied).not.toHaveBeenCalled()
    expect(sessionStorage.length).toBe(1)
  })
})
