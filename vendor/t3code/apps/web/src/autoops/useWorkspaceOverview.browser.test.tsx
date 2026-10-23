import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { render } from '../../test/render'
import { useWorkspaceOverview } from './useWorkspaceOverview'
import { AutoOpsRequestError } from './apiClient'
import type { WorkspaceOverview } from './workspaces'

const mocks = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('./workspaces', () => ({ loadWorkspaces: mocks.load }))

function overview(projectId: string, active = false): WorkspaceOverview {
  return { projectId, import: { supported: false, hosts: [], maxBytes: 0, maxFiles: 0 }, internalVersions: [], externalVersions: [], releases: [],
    tasks: active ? [{ id: 'task-one', type: 'import', status: 'running', stage: 'clone', message: '正在读取', createdAt: '2026-10-23' }] : [] }
}
function View({ projectId }: { projectId: string }) {
  const state = useWorkspaceOverview(projectId)
  return <><span data-testid="project">{state.overview?.projectId ?? '未读取'}</span>
    <span data-testid="error">{state.loadError ?? '无错误'}</span>
    <button onClick={state.refreshOverview}>刷新</button></>
}
afterEach(() => { vi.useRealTimers(); mocks.load.mockReset() })

describe('工作区读取生命周期', () => {
  it('切项目取消旧读取，即使旧请求忽略取消也不串数据', async () => {
    let deliver!: (value: WorkspaceOverview) => void
    mocks.load.mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve }))
      .mockResolvedValueOnce(overview('new'))
    await using screen = await render(<View projectId="old" />)
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1))
    const signal = mocks.load.mock.calls[0]![1] as AbortSignal
    await screen.rerender(<View projectId="new" />)
    await expect.element(screen.getByTestId('project')).toHaveTextContent('new')
    expect(signal.aborted).toBe(true)
    deliver(overview('old'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect.element(screen.getByTestId('project')).toHaveTextContent('new')
  })

  it('手动刷新遇到临时故障后，仍继续跟踪已知运行中的任务', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mocks.load.mockResolvedValueOnce(overview('one', true))
      .mockRejectedValueOnce(new Error('暂时无法连接'))
      .mockResolvedValueOnce(overview('one'))
    await using screen = await render(<View projectId="one" />)
    await vi.waitFor(() => expect(screen.container.querySelector('[data-testid="project"]')?.textContent).toBe('one'))
    screen.container.querySelector('button')!.click()
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(screen.container.querySelector('[data-testid="error"]')?.textContent).toBe('无错误'))
    await vi.advanceTimersByTimeAsync(6_000)
    expect(mocks.load).toHaveBeenCalledTimes(3)
  })

  it('撤权清空已显示快照并停止轮询，不能继续显示旧项目数据', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mocks.load.mockResolvedValueOnce(overview('one', true))
      .mockRejectedValueOnce(new AutoOpsRequestError('项目权限已撤回', 'FORBIDDEN', 403))
    await using screen = await render(<View projectId="one" />)
    await vi.waitFor(() => expect(screen.container.querySelector('[data-testid="project"]')?.textContent).toBe('one'))
    await vi.advanceTimersByTimeAsync(1_200)
    await vi.waitFor(() => expect(screen.container.querySelector('[data-testid="project"]')?.textContent).toBe('未读取'))
    expect(screen.container.querySelector('[data-testid="error"]')?.textContent).toBe('项目权限已撤回')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.load).toHaveBeenCalledTimes(2)
  })
})
