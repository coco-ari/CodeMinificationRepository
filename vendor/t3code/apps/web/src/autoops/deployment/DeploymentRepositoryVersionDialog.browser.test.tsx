import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { act, render } from '../../../test/render'
import { DeploymentRequestError, type DeploymentRepositoryHistory } from '../deployments'
import { DeploymentRepositoryVersionDialog } from './DeploymentRepositoryVersionDialog'
import '../../index.css'

const api = vi.hoisted(() => ({ refs: vi.fn(), history: vi.fn() }))
vi.mock('../deployments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../deployments')>()),
  loadDeploymentRepositoryRefs: api.refs,
  loadDeploymentRepositoryHistory: api.history,
}))
afterEach(() => vi.resetAllMocks())
const refs = {
  sourceId: 'repo',
  defaultRef: 'main',
  branches: [
    { name: 'main', commit: 'a'.repeat(40) },
    { name: 'release', commit: 'b'.repeat(40) },
  ],
  tags: [{ name: 'v1.0.0', commit: 'c'.repeat(40) }],
  truncated: false,
}
const props = {
  projectId: 'p-one',
  sourceId: 'repo',
  sourceName: '订单仓库',
  selection: { refKind: 'branch' as const, ref: 'main' },
  open: true,
  onOpenChange: vi.fn(),
  finalFocus: false as const,
}
function history(subject: string, revision: string): DeploymentRepositoryHistory {
  return {
    sourceId: 'repo',
    refKind: 'branch',
    ref: subject,
    defaultRef: 'main',
    commit: revision,
    commits: [{ subject, revision, authoredAt: '2026-10-25T00:00:00Z' }],
    truncated: false,
  }
}

describe('部署仓库版本选择', () => {
  it('按需读取分支和标签，选择标签不提前请求提交历史', async () => {
    api.refs.mockResolvedValue(refs)
    const onSelect = vi.fn()
    await using screen = await render(
      <DeploymentRepositoryVersionDialog {...props} onSelect={onSelect} />,
    )
    await expect.element(page.getByRole('button', { name: /release bbbbbbbb/ })).toBeVisible()
    expect(api.history).not.toHaveBeenCalled()
    await page.getByRole('radio', { name: '标签', exact: true }).click()
    await page.getByRole('button', { name: /v1.0.0 cccccccc/ }).click()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ refKind: 'tag', ref: 'v1.0.0' })
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('切换历史来源中止旧请求，迟到响应不能覆盖新提交', async () => {
    api.refs.mockResolvedValue(refs)
    const resolve: Array<(value: DeploymentRepositoryHistory) => void> = []
    api.history.mockImplementation(
      () => new Promise<DeploymentRepositoryHistory>((done) => resolve.push(done)),
    )
    const onSelect = vi.fn()
    await using screen = await render(
      <DeploymentRepositoryVersionDialog
        {...props}
        selection={{ refKind: 'commit', ref: 'a'.repeat(40) }}
        onSelect={onSelect}
      />,
    )
    await expect.poll(() => api.history.mock.calls.length).toBe(1)
    await page.getByRole('combobox', { name: '提交历史来源', exact: true }).click()
    await page.getByRole('option', { name: '分支 · release', exact: true }).click()
    await expect.poll(() => api.history.mock.calls.length).toBe(2)
    expect(api.history.mock.calls[0]![3].aborted).toBe(true)
    await act(async () => {
      resolve[1]!(history('新版本可发布', 'b'.repeat(40)))
    })
    await expect.element(page.getByRole('button', { name: /新版本可发布/ })).toBeVisible()
    await act(async () => {
      resolve[0]!(history('旧请求不得恢复', 'a'.repeat(40)))
    })
    expect(document.body.textContent).not.toContain('旧请求不得恢复')
    await page.getByRole('button', { name: /新版本可发布/ }).click()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ refKind: 'commit', ref: 'b'.repeat(40) })
  })

  it('读取失败显示错误并能重试，权限拒绝交由外层立即清理数据', async () => {
    api.refs.mockRejectedValueOnce(new Error('读取分支失败')).mockResolvedValueOnce(refs)
    const onAccessDenied = vi.fn()
    await using screen = await render(
      <DeploymentRepositoryVersionDialog
        {...props}
        onSelect={vi.fn()}
        onAccessDenied={onAccessDenied}
      />,
    )
    await expect.element(page.getByRole('alert')).toMatchTextContent(/读取分支失败/)
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect.element(page.getByRole('button', { name: /release bbbbbbbb/ })).toBeVisible()
    const denied = new DeploymentRequestError('无权读取仓库', false, 403, 'ACCESS_DENIED')
    api.refs.mockRejectedValueOnce(denied)
    await page.getByRole('button', { name: '刷新仓库版本', exact: true }).click()
    await expect.element(page.getByRole('alert')).toMatchTextContent(/无权读取仓库/)
    expect(onAccessDenied).toHaveBeenCalledExactlyOnceWith(denied)
    expect(document.body.textContent).not.toContain('release bbbbbbbb')
  })
})
