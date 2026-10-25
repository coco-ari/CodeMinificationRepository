import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { useState } from 'react'
import { act, render } from '../../../test/render'
import type { DeploymentTaskDetails } from '../deployments'
import { loadDeploymentTask } from '../deployments'
import { DeploymentLogs } from './DeploymentLogs'
import { Choice } from './DeploymentControls'
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
  for (const width of [1440, 390]) {
    for (const dark of [false, true]) {
      it(`${width}px ${dark ? '深色' : '浅色'}日志工具条同行且筛选复制可用`, async () => {
        const previousViewport = { width: window.innerWidth, height: window.innerHeight }
        const previousDark = document.documentElement.classList.contains('dark')
        await page.viewport(width, 500)
        document.documentElement.classList.toggle('dark', dark)
        try {
          const data = details('toolbar', 'target-one', '构建完成', 2)
          data.logs = [
            { seq: 1, stage: 'building', message: '构建完成' },
            { seq: 2, stage: 'verifying', message: '健康检查通过' },
          ]
          load.mockResolvedValue(data)
          using copied = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
          await using screen = await render(
            <div style={{ width: width === 1440 ? 1184 : width, height: 400, display: 'flex' }}>
              <DeploymentLogs
                projectId="p-one"
                targetId="target-one"
                taskId="toolbar"
                refresh={0}
              />
            </div>,
          )
          const search = screen.getByRole('textbox', { name: '搜索部署日志' })
          const stage = screen.getByRole('combobox', { name: '日志阶段' })
          const copy = screen.getByRole('button', { name: '复制日志' })
          const download = screen.getByRole('button', { name: '下载日志' })
          await expect.element(copy).toBeEnabled()
          const bounds = [search, stage, copy, download].map((item) =>
            item.element().getBoundingClientRect(),
          )
          const centers = bounds.map((rect) => rect.top + rect.height / 2)
          expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(2)
          const panel = screen.container.firstElementChild!.getBoundingClientRect()
          for (const rect of bounds) {
            expect(rect.left).toBeGreaterThanOrEqual(panel.left)
            expect(rect.right).toBeLessThanOrEqual(panel.right)
          }
          await stage.click()
          await page.getByRole('option', { name: '构建', exact: true }).click()
          await search.fill('完成')
          await copy.click()
          expect(copied).toHaveBeenCalledWith('[构建] 构建完成')
          await expect.element(download).toBeEnabled()
        } finally {
          document.documentElement.classList.toggle('dark', previousDark)
          await page.viewport(previousViewport.width, previousViewport.height)
        }
      })
    }
  }

  it('补读完成前禁止导出，不把尚未读到的搜索结果显示为空', async () => {
    const initial = details('backfill', 'target-one', '第一批日志', 501)
    initial.logs = Array.from({ length: 500 }, (_, index) => ({
      seq: index + 1,
      message: `第一批日志 ${index + 1}`,
    }))
    initial.nextSeq = 501
    let finish!: (value: DeploymentTaskDetails) => void
    load.mockResolvedValueOnce(initial).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    using copied = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    await using screen = await render(
      <DeploymentLogs projectId="p-one" targetId="target-one" taskId="backfill" refresh={0} />,
    )
    await expect.poll(() => load.mock.calls.length).toBe(2)
    expect(load.mock.calls[1]?.[2]).toBe(500)
    await expect.element(screen.getByRole('button', { name: '复制日志' })).toBeDisabled()
    await expect.element(screen.getByRole('button', { name: '下载日志' })).toBeDisabled()
    await screen.getByRole('textbox', { name: '搜索部署日志' }).fill('最后一条记录')
    await expect.element(screen.getByLabelText('部署增量日志')).toHaveTextContent('正在补读日志…')
    await act(() => finish(details('backfill', 'target-one', '最后一条记录', 501)))
    await expect.element(screen.getByLabelText('部署增量日志')).toHaveTextContent('最后一条记录')
    await expect.element(screen.getByRole('button', { name: '下载日志' })).toBeEnabled()
    await screen.getByRole('button', { name: '复制日志' }).click()
    expect(copied).toHaveBeenCalledExactlyOnceWith('最后一条记录')
  })

  it('刷新发现任务身份不匹配后保留已读日志，但禁止继续导出', async () => {
    load.mockResolvedValueOnce(details('one', 'target-one', '已确认任务日志'))
    await using screen = await render(
      <DeploymentLogs projectId="p-one" targetId="target-one" taskId="one" refresh={0} />,
    )
    await expect.element(screen.getByRole('button', { name: '复制日志' })).toBeEnabled()
    load.mockResolvedValueOnce(details('wrong-task', 'target-one', '错误身份日志'))
    await screen.rerender(
      <DeploymentLogs projectId="p-one" targetId="target-one" taskId="one" refresh={1} />,
    )
    await expect.element(screen.getByRole('alert')).toMatchTextContent(/任务身份与当前选择不一致/)
    await expect.element(screen.getByRole('button', { name: '复制日志' })).toBeDisabled()
    await expect.element(screen.getByRole('button', { name: '下载日志' })).toBeDisabled()
    await expect.element(screen.getByText('已确认任务日志')).toBeVisible()
    expect(screen.container.textContent).not.toContain('错误身份日志')
  })

  it('按内容与阶段筛选日志并复制可见结果，保持原完整记录', async () => {
    const data = details('search-task', 'target-one', '构建完成', 2)
    data.logs = [
      { seq: 1, stage: 'building', message: '构建完成' },
      { seq: 2, stage: 'verifying', message: '健康检查通过' },
    ]
    load.mockResolvedValue(data)
    using copied = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    await using screen = await render(
      <DeploymentLogs projectId="p-one" targetId="target-one" taskId="search-task" refresh={0} />,
    )
    await expect.element(screen.getByText('健康检查通过', { exact: false })).toBeVisible()
    await screen.getByRole('textbox', { name: '搜索部署日志' }).fill('构建')
    await expect.element(screen.getByText('健康检查通过', { exact: false })).not.toBeInTheDocument()
    await screen.getByRole('button', { name: '复制日志' }).click()
    expect(copied).toHaveBeenCalledWith('[构建] 构建完成')
    await screen.getByRole('textbox', { name: '搜索部署日志' }).fill('')
    await expect.element(screen.getByText('健康检查通过', { exact: false })).toBeVisible()
    await screen.getByRole('combobox', { name: '日志阶段' }).click()
    await page.getByRole('option', { name: '验证服务' }).click()
    await expect.element(screen.getByText('构建完成', { exact: false })).not.toBeInTheDocument()
  })

  it('所选任务读取失败后仍可从摘要切换任务并读取对应日志', async () => {
    load.mockImplementation(async (_projectId, taskId) =>
      taskId === 'unavailable'
        ? details('another-task', 'target-one', '不可显示的错误日志')
        : details('available', 'target-one', '所选历史任务日志'),
    )
    function TaskSelection() {
      const [taskId, setTaskId] = useState('unavailable')
      return (
        <DeploymentLogs
          projectId="p-one"
          targetId="target-one"
          taskId={taskId}
          refresh={0}
          taskPicker={
            <Choice
              label="部署任务"
              value={taskId}
              options={[
                { id: 'unavailable', name: '读取失败的任务' },
                { id: 'available', name: '历史成功任务' },
              ]}
              onChange={setTaskId}
            />
          }
        />
      )
    }
    await using screen = await render(<TaskSelection />)
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('任务身份与当前选择不一致，请从任务列表重新选择。 当前任务已停止读取。')
    await screen.getByRole('combobox', { name: '部署任务' }).click()
    await page.getByRole('option', { name: '历史成功任务' }).click()
    await expect.element(screen.getByText('所选历史任务日志')).toBeVisible()
    await expect.element(screen.getByRole('alert')).not.toBeInTheDocument()
    expect(screen.container.textContent).not.toContain('不可显示的错误日志')
  })

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
