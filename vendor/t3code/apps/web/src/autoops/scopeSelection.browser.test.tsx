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
