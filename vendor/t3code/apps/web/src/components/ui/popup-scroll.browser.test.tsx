import '../../index.css'
import { useState } from 'react'
import { expect, it } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { act, render } from '../../../test/render'
import { Button } from './button'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './select'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './menu'
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from './combobox'
import { Dialog, DialogPanel, DialogPopup, DialogTitle } from './dialog'
import { ScrollArea } from './scroll-area'

const options = Array.from({ length: 60 }, (_, index) => `分支-${String(index).padStart(2, '0')}`)

function Branches({ aligned = true, selected = 0 }: { aligned?: boolean; selected?: number }) {
  const [value, setValue] = useState(options[selected]!)
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next) setValue(next)
      }}
    >
      <SelectTrigger aria-label="分支">
        <SelectValue>{value}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={aligned}>
        {options.map((value) => (
          <SelectItem key={value} value={value}>
            {value}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  )
}

async function checkScrollable(selector: string) {
  await expect
    .poll(() => {
      const viewport = document.querySelector<HTMLElement>(selector)
      return viewport ? viewport.scrollHeight - viewport.clientHeight : 0
    })
    .toBeGreaterThan(100)
  const viewport = document.querySelector<HTMLElement>(selector)!
  await act(() => {
    viewport.scrollTop = 0
  })
  // 原生对齐浮层可能先用滚动量扩展高度，待布局稳定后继续验证视口位移。
  for (let attempt = 0; attempt < Math.ceil(window.innerHeight / 350) + 2 && viewport.scrollTop <= 100; attempt++) {
    await act(async () => {
      viewport.scrollBy({ top: 350, behavior: 'instant' })
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
  }
  await expect.poll(() => viewport.scrollTop).toBeGreaterThan(100)
  const bounds = viewport.getBoundingClientRect()
  expect(bounds.top).toBeGreaterThanOrEqual(0)
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1)
}

it.each([
  { aligned: true, selected: 0 },
  { aligned: true, selected: 35 },
  { aligned: false, selected: 0 },
])('长下拉列表保持可滚动并能键盘选到末项：$aligned／$selected', async ({ aligned, selected }) => {
  await using screen = await render(
    <div style={{ padding: 70, width: 400 }}>
      <Branches aligned={aligned} selected={selected} />
    </div>,
  )
  await screen.getByRole('combobox', { name: '分支', exact: true }).click()
  await checkScrollable('[data-slot="select-list"]')
  await userEvent.keyboard('{End}')
  await expect.element(page.getByRole('option', { name: '分支-59', exact: true })).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await expect
    .element(screen.getByRole('combobox', { name: '分支', exact: true }))
    .toHaveTextContent('分支-59')
})

it('设置弹窗中的长选择列表有独立滚动区域', async () => {
  await using screen = await render(
    <Dialog open>
      <DialogPopup>
        <DialogTitle>配置</DialogTitle>
        <DialogPanel>
          <Branches />
        </DialogPanel>
      </DialogPopup>
    </Dialog>,
  )
  await page.getByRole('combobox', { name: '分支', exact: true }).click()
  await expect.element(page.getByRole('option', { name: '分支-00', exact: true })).toHaveFocus()
  await checkScrollable('[data-slot="select-list"]')
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('combobox', { name: '分支', exact: true })).toHaveFocus()
})

it('长列表滚动箭头的渐变只覆盖边缘，不遮住整个分支列表', async () => {
  await using screen = await render(
    <div style={{ padding: 70, width: 800 }}>
      <Branches selected={35} />
    </div>,
  )
  await screen.getByRole('combobox', { name: '分支', exact: true }).click()
  await expect.poll(() => document.querySelectorAll('[data-slot^="select-scroll-"]').length).toBe(2)
  for (const arrow of document.querySelectorAll<HTMLElement>('[data-slot^="select-scroll-"]')) {
    const gradientHeight = parseFloat(getComputedStyle(arrow, '::before').height)
    expect(gradientHeight).toBeGreaterThan(0)
    expect(gradientHeight).toBeLessThanOrEqual(arrow.clientHeight * 2 + 1)
  }
  const viewport = document.querySelector<HTMLElement>('[data-slot="select-list"]')!
  await act(() => { viewport.scrollTop = viewport.scrollHeight })
  await page.getByRole('option', { name: '分支-59', exact: true }).click()
  await screen.getByRole('combobox', { name: '分支', exact: true }).click()
  await expect.element(page.getByRole('option', { name: '分支-59', exact: true })).toHaveFocus()
  await userEvent.keyboard('{Escape}')
  await expect.element(screen.getByRole('combobox', { name: '分支', exact: true })).toHaveFocus()
})

it('长操作菜单可滚动并选到末项', async () => {
  const chosen: string[] = []
  await using screen = await render(
    <Menu>
      <MenuTrigger render={<Button />}>操作菜单</MenuTrigger>
      <MenuPopup>
        {options.map((value) => (
          <MenuItem key={value} onClick={() => chosen.push(value)}>
            {value}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>,
  )
  await screen.getByRole('button', { name: '操作菜单', exact: true }).click()
  await checkScrollable('[data-slot="menu-popup"] > div')
  await userEvent.keyboard('{End}')
  await expect.element(page.getByRole('menuitem', { name: '分支-59', exact: true })).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await expect.poll(() => chosen[0]).toBe('分支-59')
})

it('长搜索选择列表可滚动且筛选后仍能选择', async () => {
  await using screen = await render(
    <Combobox items={options}>
      <ComboboxTrigger render={<Button />}>搜索分支</ComboboxTrigger>
      <ComboboxPopup>
        <ComboboxSearchInput aria-label="搜索分支名称" />
        <ComboboxList>
          {options.map((value) => (
            <ComboboxItem key={value} value={value}>
              {value}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>,
  )
  await screen.getByRole('button', { name: '搜索分支', exact: true }).click()
  await checkScrollable('[data-slot="combobox-popup"] [data-slot="scroll-area-viewport"]')
  await page.getByRole('combobox', { name: '搜索分支名称', exact: true }).fill('分支-59')
  await expect.element(page.getByRole('option', { name: '分支-59', exact: true })).toBeVisible()
  await page.getByRole('option', { name: '分支-59', exact: true }).click()
  await expect.element(page.getByRole('option')).not.toBeInTheDocument()
})

it('长设置弹窗的正文滚动而不是被外壳裁掉', async () => {
  await using screen = await render(
    <Dialog open>
      <DialogPopup>
        <DialogTitle>长配置</DialogTitle>
        <DialogPanel>
          {options.map((value) => (
            <p key={value} style={{ padding: 12 }}>
              {value}
            </p>
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>,
  )
  await checkScrollable('[data-slot="dialog-popup"] [data-slot="scroll-area-viewport"]')
  const viewport = document.querySelector<HTMLElement>(
    '[data-slot="dialog-popup"] [data-slot="scroll-area-viewport"]',
  )!
  await act(() => {
    viewport.scrollTop = viewport.scrollHeight
  })
  await expect.element(page.getByText('分支-59', { exact: true })).toBeVisible()
})

it('横向文件内容仍可独立滚动', async () => {
  await using screen = await render(
    <div style={{ width: 280, height: 100 }}>
      <ScrollArea>
        <div style={{ width: 1200 }}>横向文件内容</div>
      </ScrollArea>
    </div>,
  )
  const viewport = screen.container.querySelector<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  )!
  await expect.poll(() => viewport.scrollWidth - viewport.clientWidth).toBeGreaterThan(500)
  await act(() => {
    viewport.scrollLeft = 500
  })
  expect(viewport.scrollLeft).toBe(500)
  expect(viewport.clientWidth).toBeLessThanOrEqual(280)
})
