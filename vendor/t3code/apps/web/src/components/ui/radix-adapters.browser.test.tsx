import '../../index.css'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vite-plus/test'
import { act, render } from '../../../test/render'
import { Button } from './button'
import { Dialog, DialogClose, DialogPopup, DialogTitle, DialogTrigger } from './dialog'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './select'
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxPopup,
  ComboboxTrigger,
  ComboboxSearchInput,
  ComboboxList,
  ComboboxListVirtualized,
} from './combobox'
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from './popover'

function key(element: Element, key: string) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('T3 Radix interaction adapters', () => {
  it('anchors a popup search field to its trigger above a positioned application shell', async () => {
    await using screen = await render(
      <div style={{ position: 'relative', zIndex: 30, background: 'white', height: 500 }}>
        <Combobox items={['Alpha', 'Beta']}>
          <ComboboxTrigger render={<Button style={{ margin: 40 }} />}>
            Choose project
          </ComboboxTrigger>
          <ComboboxPopup>
            <ComboboxSearchInput placeholder="Search projects" />
            <ComboboxList>
              <ComboboxItem value="Alpha">Alpha</ComboboxItem>
              <ComboboxItem value="Beta">Beta</ComboboxItem>
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      </div>,
    )
    const trigger = screen.container.querySelector<HTMLButtonElement>('button')!
    await act(() => trigger.click())
    await vi.waitFor(() => {
      const option = document.querySelector<HTMLElement>('[role="option"]')!,
        popup = document.querySelector<HTMLElement>('[data-slot="combobox-popup"]')!
      expect(option).not.toBeNull()
      const bounds = option.getBoundingClientRect(),
        origin = trigger.getBoundingClientRect(),
        placed = popup.getBoundingClientRect()
      expect(placed.top).toBeGreaterThanOrEqual(origin.bottom)
      expect(Math.abs(placed.left - origin.left)).toBeLessThan(2)
      const under = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      )
      expect(
        option.contains(under),
        JSON.stringify({
          element: under?.outerHTML.slice(0, 200),
          popupZ: getComputedStyle(popup).zIndex,
          wrapperZ: getComputedStyle(popup.parentElement!).zIndex,
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        }),
      ).toBe(true)
    })
  })

  it('opens a rendered shadcn dialog trigger and restores focus after escape', async () => {
    await using screen = await render(
      <Dialog>
        <DialogTrigger render={<Button />}>Open dialog</DialogTrigger>
        <DialogPopup>
          <DialogTitle>Confirmation</DialogTitle>
          <DialogClose render={<Button />}>Close dialog</DialogClose>
        </DialogPopup>
      </Dialog>,
    )
    const trigger = screen.container.querySelector<HTMLButtonElement>('button')!
    await act(() => {
      trigger.focus()
      trigger.click()
    })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await act(() => key(document.activeElement!, 'Escape'))
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
  it('retains non-string select values across the Radix string value boundary', async () => {
    const a = { id: 'a' },
      b = { id: 'b' }
    const change = vi.fn()
    function Example() {
      const [value, setValue] = useState(a)
      return (
        <Select
          value={value}
          onValueChange={(next) => {
            if (next) {
              setValue(next)
              change(next)
            }
          }}
        >
          <SelectTrigger>
            <SelectValue>{value.id}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={a}>Alpha</SelectItem>
            <SelectItem value={b}>Beta</SelectItem>
          </SelectPopup>
        </Select>
      )
    }
    await using screen = await render(<Example />)
    const trigger = screen.container.querySelector<HTMLElement>('[role="combobox"]')!
    await act(() => key(trigger, 'ArrowDown'))
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent === 'Beta',
    )!
    await act(() => {
      option.focus()
      key(option, 'Enter')
    })
    await vi.waitFor(() => expect(change).toHaveBeenCalledWith(b))
  })
  it('keeps detached popover trigger payloads and closes through Radix escape', async () => {
    const handle = PopoverCreateHandle<{ name: string }>()
    await using screen = await render(
      <>
        <PopoverTrigger handle={handle} payload={{ name: 'Quota' }} render={<Button />}>
          Details
        </PopoverTrigger>
        <Popover handle={handle}>
          {({ payload }) => <PopoverPopup>{payload?.name}</PopoverPopup>}
        </Popover>
      </>,
    )
    const trigger = screen.container.querySelector<HTMLButtonElement>('button')!
    await act(() => trigger.click())
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="popover-popup"]')?.textContent).toContain('Quota'),
    )
    await act(() => key(document.activeElement!, 'Escape'))
    await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
  it('preserves cancelable escape navigation inside the command palette', async () => {
    const reason = vi.fn()
    await using screen = await render(
      <Dialog
        onOpenChange={(open, details) => {
          reason(details.reason)
          if (!open && details.reason === 'escape-key') details.cancel()
        }}
      >
        <DialogTrigger render={<Button />}>Open nested command</DialogTrigger>
        <DialogPopup>
          <DialogTitle>Command submenu</DialogTitle>
          <Button>Submenu action</Button>
        </DialogPopup>
      </Dialog>,
    )
    await act(() => screen.container.querySelector<HTMLButtonElement>('button')!.click())
    await act(() => key(document.activeElement!, 'Escape'))
    expect(reason).toHaveBeenLastCalledWith('escape-key')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
  it('keeps virtualized picker index navigation and selection callbacks', async () => {
    const highlighted = vi.fn()
    const selected = vi.fn()
    await using screen = await render(
      <Combobox
        inline
        open
        virtualized
        items={['a', 'b', 'c']}
        filteredItems={['a', 'b', 'c']}
        onItemHighlighted={highlighted}
        onValueChange={selected}
      >
        <ComboboxInput
          showTrigger={false}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') event.stopPropagation()
          }}
        />
        <ComboboxListVirtualized>
          {['a', 'b', 'c'].map((value) => (
            <ComboboxItem key={value} value={value}>
              {value}
            </ComboboxItem>
          ))}
        </ComboboxListVirtualized>
      </Combobox>,
    )
    const input = screen.container.querySelector<HTMLInputElement>('input')!
    await act(() => {
      input.focus()
      key(input, 'ArrowDown')
    })
    expect(highlighted).toHaveBeenLastCalledWith(
      'b',
      expect.objectContaining({ reason: 'keyboard', index: 1 }),
    )
    await act(() => key(input, 'Enter'))
    expect(selected).toHaveBeenCalledWith('b', expect.objectContaining({ reason: 'item-press' }))
  })
})
