import { ServerIcon } from 'lucide-react'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render } from '../../test/render'
import { ScopeComposerChoice } from './scopeSelection'
import '../index.css'

const choice = {
  label: '业务环境',
  summary: '测试环境',
  icon: ServerIcon,
  value: 'test',
  options: [
    { value: 'test', label: '测试环境' },
    { value: 'production', label: '生产环境' },
  ],
  locked: false,
  disabled: false,
}

it('可编辑范围使用正常控件层级，选择与 Esc 关闭后回到入口', async () => {
  await page.viewport(1440, 600)
  const onChange = vi.fn()
  await using screen = await render(<ScopeComposerChoice {...choice} onChange={onChange} />)
  const trigger = screen.getByRole('button', { name: '业务环境', exact: true })
  const element = trigger.element()
  expect(element.getBoundingClientRect().height).toBe(28)
  expect(getComputedStyle(element).fontSize).toBe('14px')
  await trigger.click()
  await page.getByRole('menuitemradio', { name: '生产环境', exact: true }).click()
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange.mock.calls[0]?.[0]).toBe('production')
  await expect.poll(() => document.activeElement).toBe(element)
  await trigger.click()
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
  await expect.poll(() => document.activeElement).toBe(element)
})

it('已锁定范围保留名称和当前值，提交中保留禁用状态且不能再次选择', async () => {
  const onChange = vi.fn()
  await using screen = await render(<ScopeComposerChoice {...choice} locked onChange={onChange} />)
  expect(
    screen.container.querySelector('[data-autoops-scope-locked]')?.getAttribute('aria-label'),
  ).toBe('业务环境')
  await expect.element(screen.getByText('测试环境', { exact: true })).toBeVisible()
  await expect.element(screen.getByRole('button')).not.toBeInTheDocument()
  await screen.rerender(<ScopeComposerChoice {...choice} disabled onChange={onChange} />)
  await expect.element(screen.getByRole('button', { name: '业务环境', exact: true })).toBeDisabled()
  expect(onChange).not.toHaveBeenCalled()
})

it('紧凑布局的只读参数可用键盘查看实际值，不产生调整菜单', async () => {
  const onChange = vi.fn()
  await using screen = await render(
    <div className="group/composer-context" data-compact="">
      <ScopeComposerChoice {...choice} locked onChange={onChange} lockReason="由项目管理员设置" />
    </div>,
  )
  await userEvent.tab()
  await expect.element(screen.getByLabelText('业务环境', { exact: true })).toHaveFocus()
  await expect.element(page.getByRole('tooltip')).toHaveTextContent('测试环境 · 由项目管理员设置')
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
  expect(onChange).not.toHaveBeenCalled()
})

it('相邻问答参数一次切换只保留当前菜单，选项仍可选择并恢复焦点', async () => {
  const onChange = vi.fn()
  await using screen = await render(
    <div>
      <ScopeComposerChoice {...choice} label="资料范围" onChange={() => {}} />
      <ScopeComposerChoice {...choice} onChange={onChange} />
    </div>,
  )
  const first = screen.getByRole('button', { name: '资料范围', exact: true }).element()
  const next = screen.getByRole('button', { name: '业务环境', exact: true }).element()
  await userEvent.click(first)
  await userEvent.click(next)
  await expect.poll(() => document.querySelectorAll('[role="menu"]').length).toBe(1)
  await expect.element(page.getByText('业务环境', { exact: true })).toBeVisible()
  await page.getByRole('menuitemradio', { name: '生产环境', exact: true }).click()
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange.mock.calls[0]?.[0]).toBe('production')
  await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
  await expect.poll(() => document.activeElement).toBe(next)
})

it('不可用助手显示实际原因并拒绝键盘选择，可用助手仍能选择', async () => {
  const onChange = vi.fn()
  await using screen = await render(
    <ScopeComposerChoice {...choice} label="助手" value="" onChange={onChange}
      options={[
        { value: 'paused', label: '暂停助手 · 助手已停用', disabled: true },
        { value: 'ready', label: '可用助手' },
      ]} />,
  )
  await screen.getByRole('button', { name: '助手', exact: true }).click()
  await expect.element(page.getByRole('menuitemradio', { name: '暂停助手 · 助手已停用', exact: true }))
    .toHaveAttribute('aria-disabled', 'true')
  await userEvent.keyboard('{Home}{Enter}')
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange.mock.calls[0]?.[0]).toBe('ready')
})
