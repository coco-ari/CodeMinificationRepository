import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, render } from '../../../test/render'
import type { DeploymentTaskDetails } from '../deployments'
import { loadDeploymentTask } from '../deployments'
import { DeploymentLogs } from './DeploymentLogs'
import '../../index.css'

vi.mock(import('../deployments'), async (original) => ({
  ...(await original()),
  loadDeploymentTask: vi.fn(),
}))
const load = vi.mocked(loadDeploymentTask)
const details = (
  taskId: string,
  targetId: string,
  message: string,
  seq = 1,
): DeploymentTaskDetails => ({
  task: {
    id: taskId,
    targetId,
    status: 'succeeded',
    stage: 'complete',
    createdAt: '2026-10-23T00:00:00Z',
    lastSeq: seq,
  },
  logs: [{ seq, message }],
  nextSeq: seq + 1,
})
afterEach(() => {
  load.mockReset()
})

describe('部署增量日志生命周期', () => {
  it('刷新沿用当前任务游标，合并增量时不重复已有日志', async () => {
    load.mockResolvedValueOnce(details('one', 'target-one', '第一段日志'))
    await using screen = await render(
      <DeploymentLogs projectId="p-one" targetId="target-one" taskId="one" refresh={0} />,
    )
    await expect.element(screen.getByText('第一段日志')).toBeVisible()
    load.mockResolvedValueOnce({
      ...details('one', 'target-one', '第二段日志', 2),
      logs: [
        { seq: 1, message: '重复响应不应追加' },
        { seq: 2, message: '第二段日志' },
      ],
    })
    await screen.rerender(
      <DeploymentLogs projectId="p-one" targetId="target-one" taskId="one" refresh={1} />,
    )
    await expect.element(screen.getByText('第二段日志')).toBeVisible()
    expect(load.mock.calls[1]?.[2]).toBe(1)
    expect(screen.container.textContent).not.toContain('重复响应不应追加')
    expect(screen.container.textContent).toContain('第一段日志')
  })

  it('切换任务取消旧读取，即使旧请求忽略取消并迟到返回也不串入新任务', async () => {
    let resolveOld!: (value: DeploymentTaskDetails) => void
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    await using screen = await render(
      <DeploymentLogs projectId="p-one" targetId="target-one" taskId="old" refresh={0} />,
    )
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    const oldSignal = load.mock.calls[0]?.[3]
    load.mockResolvedValueOnce(details('new', 'target-two', '当前任务日志'))
    await screen.rerender(
      <DeploymentLogs projectId="p-two" targetId="target-two" taskId="new" refresh={0} />,
    )
    await expect.element(screen.getByText('当前任务日志')).toBeVisible()
    expect(oldSignal?.aborted).toBe(true)
    resolveOld(details('old', 'target-one', '迟到的旧项目日志'))
    await Promise.resolve()
    expect(screen.container.textContent).not.toContain('迟到的旧项目日志')
    expect(load.mock.calls[1]?.[2]).toBe(0)
  })

  it('服务身份不匹配时拒绝显示返回的日志', async () => {
    load.mockResolvedValueOnce(details('one', 'another-target', '另一服务的日志'))
    await using screen = await render(
      <DeploymentLogs projectId="p-one" targetId="target-one" taskId="one" refresh={0} />,
    )
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
        '该任务不属于当前服务',
      ),
    )
    expect(screen.container.textContent).not.toContain('另一服务的日志')
  })

  it('恢复结果保留且去除重复摘要，完整执行阶段可展开查看', async () => {
    const result = details('one', 'target-one', '恢复执行日志')
    result.task = {
      ...result.task,
      status: 'rolled_back',
      error: '发布失败，已恢复上一版本',
      stageHistory: [{ stage: 'build' }, { stage: 'verify' }],
      result: { rollback: { status: 'succeeded' } },
    }
    load.mockResolvedValueOnce(result)
    await using screen = await render(
      <DeploymentLogs projectId="p-one" targetId="target-one" taskId="one" refresh={0} />,
    )
    await expect
      .element(screen.getByText('发布失败，已恢复上一版本', { exact: true }))
      .toBeVisible()
    expect(screen.container.textContent?.match(/已恢复上一版本/g)).toHaveLength(1)
    await screen.getByRole('button', { name: '执行阶段（2）' }).click()
    await expect.element(screen.getByRole('list', { name: '执行阶段记录' })).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '故障与恢复详情' })).toBeVisible()
  })
  it('同一服务返回错误任务身份时停止读取且不伪装为网络恢复', async () => {
    load.mockResolvedValueOnce(details('wrong-task', 'target-one', '错误任务的日志'))
    await using screen = await render(
      <DeploymentLogs projectId="p-one" targetId="target-one" taskId="one" refresh={0} />,
    )
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
        '任务身份与当前选择不一致',
      ),
    )
    expect(screen.container.textContent).not.toContain('错误任务的日志')
    expect(screen.container.textContent).not.toContain('连接恢复后继续读取')
  })

  it('阅读旧日志时新增内容不跳到底部，回到最新后才恢复跟随', async () => {
    const initial = details('one', 'target-one', '第 80 行', 80)
    initial.logs = Array.from({ length: 80 }, (_, index) => ({
      seq: index + 1,
      message: '历史记录第 ' + (index + 1) + ' 行',
    }))
    load.mockResolvedValueOnce(initial)
    const view = (refresh: number) => (
      <div style={{ width: 800, height: 400, display: 'flex' }}>
        <DeploymentLogs projectId="p-one" targetId="target-one" taskId="one" refresh={refresh} />
      </div>
    )
    await using screen = await render(view(0))
    await expect.element(screen.getByText('历史记录第 80 行', { exact: true })).toBeVisible()
    const viewport = screen.container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )!
    await act(() => {
      viewport.scrollTop = 0
      viewport.dispatchEvent(new Event('scroll'))
    })
    await expect.element(screen.getByRole('button', { name: '回到最新日志' })).toBeVisible()
    load.mockResolvedValueOnce(details('one', 'target-one', '新的第 81 行', 81))
    await screen.rerender(view(1))
    await vi.waitFor(() => expect(screen.container.textContent).toContain('新的第 81 行'))
    expect(viewport.scrollTop).toBe(0)
    await screen.getByRole('button', { name: '回到最新日志' }).click()
    await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0))
  })
})
