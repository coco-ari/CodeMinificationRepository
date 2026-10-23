import { useState } from 'react'
import { describe, expect, it, vi } from 'vite-plus/test'
import { render } from '../../test/render'
import { ModuleErrorBoundary } from './ModuleErrorBoundary'
import '../index.css'

function BrokenContent({ fail }: { fail: boolean }) {
  if (fail) throw new Error('隔离测试中的模块渲染失败')
  return <div>工作区内容已恢复</div>
}
function PublicNavigation() {
  const [selected, setSelected] = useState(false)
  return (
    <button onClick={() => setSelected(true)}>{selected ? '公共导航仍可用' : '切换模块'}</button>
  )
}

describe('模块渲染故障隔离', () => {
  it('错误只替换当前内容，公共导航状态与未提交动作不受重试影响', async () => {
    let fail = true
    let submitted = 0
    function Content() {
      return (
        <>
          <BrokenContent fail={fail} />
          <button onClick={() => submitted++}>确认发布</button>
        </>
      )
    }
    await using screen = await render(
      <>
        <PublicNavigation />
        <ModuleErrorBoundary label="部署发布" resetKey="deployments:p-one">
          <Content />
        </ModuleErrorBoundary>
      </>,
    )
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
        '部署发布暂时无法显示',
      ),
    )
    await screen.getByRole('button', { name: '切换模块' }).click()
    fail = false
    await screen.getByRole('button', { name: '重试当前模块' }).click()
    await expect.element(screen.getByRole('button', { name: '公共导航仍可用' })).toBeVisible()
    await expect.element(screen.getByText('工作区内容已恢复')).toBeVisible()
    expect(submitted).toBe(0)
  })

  it('切换模块或项目可清除前一个区域错误，正常渲染不因查询参数变化被重挂', async () => {
    function StatefulContent() {
      const [value, setValue] = useState('未编辑')
      return <button onClick={() => setValue('草稿已编辑')}>{value}</button>
    }
    await using screen = await render(
      <ModuleErrorBoundary label="工作区" resetKey="workspaces:p-one">
        <BrokenContent fail />
      </ModuleErrorBoundary>,
    )
    await expect.element(screen.getByRole('alert')).toBeVisible()
    await screen.rerender(
      <ModuleErrorBoundary label="工作区" resetKey="workspaces:p-two">
        <StatefulContent />
      </ModuleErrorBoundary>,
    )
    await screen.getByRole('button', { name: '未编辑' }).click()
    await screen.rerender(
      <ModuleErrorBoundary label="工作区" resetKey="workspaces:p-two:version-two">
        <StatefulContent />
      </ModuleErrorBoundary>,
    )
    await expect.element(screen.getByRole('button', { name: '草稿已编辑' })).toBeVisible()
    expect(screen.container.querySelector('[role="alert"]')).toBeNull()
  })
})
