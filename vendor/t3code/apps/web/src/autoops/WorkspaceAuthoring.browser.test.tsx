import { describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { render } from '../../test/render'
import { AutoOpsRequestError } from './apiClient'
import { useWorkspaceAuthoring } from './useWorkspaceAuthoring'
import { AuthoringNotice } from './WorkspaceAuthoringDialogs'
import type { WorkspaceAuthoringOverview } from './workspaceAuthoring'
import '../index.css'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  credentials: vi.fn(),
  send: vi.fn(),
  inspect: vi.fn(),
  accepted: vi.fn(),
  host: vi.fn(),
}))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}))
vi.mock(import('./workspaceAuthoring'), async (original) => ({
  ...(await original()),
  loadAuthoring: mocks.read,
  loadAuthoringCredentials: mocks.credentials,
  submitAuthoring: mocks.send,
  inspectAuthoringRequest: mocks.inspect,
}))
function overview(projectId = 'p-one', revision = 0): WorkspaceAuthoringOverview {
  return {
    projectId,
    revision,
    sources: [],
    entries: [],
    limits: { maxFileBytes: 8000000, maxBytes: 50000000, maxFiles: 100 },
  }
}
function setup() {
  vi.resetAllMocks()
  sessionStorage.clear()
  mocks.host.mockReturnValue({ principal: { id: 'isolated-owner' } })
  mocks.read.mockImplementation(async (projectId: string) => overview(projectId))
  mocks.credentials.mockResolvedValue({ credentials: [] })
  mocks.inspect.mockResolvedValue(null)
  mocks.send.mockRejectedValue(
    new AutoOpsRequestError('结果尚未确认', 'CONNECTION_FAILED', undefined, true),
  )
}
function Harness({
  projectId = 'p-one',
  manager = true,
}: {
  projectId?: string
  manager?: boolean
}) {
  const controller = useWorkspaceAuthoring(projectId, manager, mocks.accepted)
  return (
    <>
      <p>项目 {controller.overview?.projectId ?? '正在读取'}</p>
      <button onClick={controller.refresh}>重新读取</button>
      <button
        disabled={!controller.overview || controller.busy}
        onClick={() =>
          void controller.submit({ kind: 'document', action: 'mkdir', path: 'docs/测试目录' })
        }
      >
        保存目录
      </button>
      <button
        disabled={!controller.overview || controller.busy}
        onClick={() =>
          void controller.submit({ kind: 'document', action: 'mkdir', path: 'docs/其他目录' })
        }
      >
        保存其他目录
      </button>
      <AuthoringNotice controller={controller} />
    </>
  )
}

describe('当前资料的原请求恢复和范围隔离', () => {
  it('网络失败后只按原请求重试，不把更改后的输入绑定旧收据', async () => {
    setup()
    await using screen = await render(<Harness />)
    await page.getByRole('button', { name: '保存目录', exact: true }).click()
    await expect.element(page.getByRole('button', { name: '重试' })).toBeEnabled()
    const first = mocks.send.mock.calls[0]![1]
    const stored = sessionStorage.getItem('autoops:workspace-authoring:isolated-owner:p-one')!
    expect(stored).not.toContain('测试目录')
    await page.getByRole('button', { name: '保存其他目录' }).click()
    await expect
      .element(page.getByText('上次操作还在确认中，请稍后再修改。', { exact: true }))
      .toBeVisible()
    expect(mocks.send).toHaveBeenCalledTimes(1)
    await page.getByRole('button', { name: '重试' }).click()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
    expect(mocks.send.mock.calls[1]![1]).toEqual(first)
    expect(mocks.inspect).toHaveBeenCalledWith(
      'p-one',
      first.requestId,
      false,
      expect.any(AbortSignal),
    )
  })
  it('刷新后的原请求核对命中时不再写入', async () => {
    setup()
    await using screen = await render(<Harness key="before" />)
    await page.getByRole('button', { name: '保存目录', exact: true }).click()
    await expect.element(page.getByRole('button', { name: '重试' })).toBeEnabled()
    const first = mocks.send.mock.calls[0]![1]
    mocks.inspect.mockResolvedValue({ requestId: first.requestId, revision: 1 })
    await screen.rerender(<Harness key="after" />)
    await page.getByRole('button', { name: '重试' }).click()
    await vi.waitFor(() =>
      expect(mocks.accepted).toHaveBeenCalledWith({ requestId: first.requestId, revision: 1 }),
    )
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('autoops:workspace-authoring:isolated-owner:p-one')).toBeNull()
  })
  it('切项目后迟到写入不能恢复旧资料或触发新项目动作', async () => {
    setup()
    let deliver!: (result: unknown) => void
    mocks.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        }),
    )
    await using screen = await render(<Harness key="first" />)
    await page.getByRole('button', { name: '保存目录', exact: true }).click()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    const first = mocks.send.mock.calls[0]![1]
    await screen.rerender(<Harness key="second" projectId="p-two" />)
    await expect.element(page.getByText('项目 p-two', { exact: true })).toBeVisible()
    deliver({ requestId: first.requestId, revision: 1 })
    await expect.element(page.getByText('项目 p-two', { exact: true })).toBeVisible()
    expect(mocks.accepted).not.toHaveBeenCalled()
    expect(
      sessionStorage.getItem('autoops:workspace-authoring:isolated-owner:p-one'),
    ).not.toBeNull()
    expect(sessionStorage.getItem('autoops:workspace-authoring:isolated-owner:p-two')).toBeNull()
  })
  it('内部只读用户不提交写入、不读取凭证管理列表', async () => {
    setup()
    await using screen = await render(<Harness manager={false} />)
    await page.getByRole('button', { name: '保存目录', exact: true }).click()
    await expect.element(page.getByRole('alert')).toHaveTextContent('当前账号只可阅读资料。')
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.credentials).not.toHaveBeenCalled()
  })
  it('服务端拒绝越权后清理资料并结束明确失败的请求', async () => {
    setup()
    mocks.send.mockRejectedValue(new AutoOpsRequestError('授权已撤回', 'FORBIDDEN', 403, false))
    await using screen = await render(<Harness />)
    await page.getByRole('button', { name: '保存目录', exact: true }).click()
    await expect.element(page.getByRole('alert')).toHaveTextContent('授权已撤回')
    await expect.element(page.getByRole('button', { name: '保存目录', exact: true })).toBeDisabled()
    expect(sessionStorage.getItem('autoops:workspace-authoring:isolated-owner:p-one')).toBeNull()
  })
  it('撤权拒绝后更早读取的迟到成功响应不能恢复资料', async () => {
    setup()
    await using screen = await render(<Harness />)
    await expect.element(page.getByText('项目 p-one', { exact: true })).toBeVisible()
    let deliver!: (value: WorkspaceAuthoringOverview) => void
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        }),
    )
    await page.getByRole('button', { name: '重新读取' }).click()
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2))
    mocks.send.mockRejectedValue(new AutoOpsRequestError('授权已撤回', 'FORBIDDEN', 403, false))
    await page.getByRole('button', { name: '保存目录', exact: true }).click()
    await expect.element(page.getByRole('alert')).toHaveTextContent('授权已撤回')
    deliver(overview())
    await expect.element(page.getByRole('button', { name: '保存目录', exact: true })).toBeDisabled()
    await expect.element(page.getByText('项目 正在读取', { exact: true })).toBeVisible()
  })
})

it('同步准备已失败时自动结束待确认状态，下次点击使用新的请求', async () => {
  setup()
  mocks.inspect.mockRejectedValue(
    new AutoOpsRequestError('连接仓库超时，请重试。', 'CAPTURE_FAILED', 409),
  )
  await using screen = await render(<Harness />)
  await page.getByRole('button', { name: '保存目录', exact: true }).click()
  const first = mocks.send.mock.calls[0]![1]
  await vi.waitFor(
    () =>
      expect(sessionStorage.getItem('autoops:workspace-authoring:isolated-owner:p-one')).toBeNull(),
    { timeout: 4000 },
  )
  await expect.element(page.getByRole('alert')).toHaveTextContent('连接仓库超时，请重试。')
  mocks.send.mockImplementation(async (_project, input) => ({
    requestId: input.requestId,
    revision: 1,
  }))
  await page.getByRole('button', { name: '保存目录', exact: true }).click()
  expect(mocks.send.mock.calls[1]![1].requestId).not.toBe(first.requestId)
  expect(mocks.accepted).toHaveBeenCalledTimes(1)
})

it('断网后自动查到保存结果，无需用户核对且不重复写入', async () => {
  setup()
  await using screen = await render(<Harness />)
  await page.getByRole('button', { name: '保存目录', exact: true }).click()
  const first = mocks.send.mock.calls[0]![1]
  mocks.inspect.mockResolvedValue({ requestId: first.requestId, revision: 1 })
  await vi.waitFor(() => expect(mocks.accepted).toHaveBeenCalledTimes(1), { timeout: 4000 })
  expect(mocks.send).toHaveBeenCalledTimes(1)
  await expect.element(page.getByRole('status')).not.toBeInTheDocument()
})
