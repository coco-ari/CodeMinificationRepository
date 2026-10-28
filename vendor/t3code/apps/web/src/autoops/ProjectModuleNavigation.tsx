import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronDownIcon, type LucideIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from '~/components/ui/combobox'
import type { AutoOpsArea } from './projectNavigation'

type ModuleItem = { id: AutoOpsArea; label: string; icon: LucideIcon }

export function ProjectModuleNavigation({
  items,
  current,
  currentLabel,
  contextKey,
  onNavigate,
}: {
  items: readonly ModuleItem[]
  current: AutoOpsArea | null
  currentLabel: string
  contextKey: string | null
  onNavigate: (area: AutoOpsArea) => void
}) {
  const container = useRef<HTMLElement>(null)
  const measurement = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<string | null>(null)
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const filter = useComboboxFilter()
  const visible = items.slice(0, count)
  const overflow = items.slice(count)
  const selected = overflow.find((item) => item.id === current) ?? null
  const label = count === 0 ? currentLabel : (selected?.label ?? '更多')
  const CurrentIcon = selected?.icon

  useLayoutEffect(() => {
    const nav = container.current
    const measure = measurement.current
    if (!nav || !measure) return
    const group = measure.querySelector<HTMLElement>('[data-slot="toggle-group"]')!
    const buttons = [...group.querySelectorAll<HTMLElement>('[data-slot="toggle"]')]
    const more = measure.querySelector<HTMLElement>('[data-measure-more]')!
    const measureLayout = () => {
      // 只测不参与布局的完整原生控件，避免收起自身后宽度反复震荡。
      const available = nav.getBoundingClientRect().width
      const style = getComputedStyle(group)
      const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      const gap = parseFloat(style.columnGap) || 0
      const widths = buttons.map((button) => button.getBoundingClientRect().width)
      const groupWidth = (length: number) =>
        padding + widths.slice(0, length).reduce((a, b) => a + b, 0) + Math.max(0, length - 1) * gap
      let next = items.length
      if (groupWidth(next) > available) {
        const menuWidth = more.getBoundingClientRect().width
        const navGap = parseFloat(getComputedStyle(nav).columnGap) || 0
        next--
        while (next > 0 && groupWidth(next) + navGap + menuWidth > available) next--
      }
      const focused = document.activeElement
      if (focused instanceof HTMLElement && nav.contains(focused)) {
        const id = focused.dataset.navigationArea
        if (id && !items.slice(0, next).some((item) => item.id === id)) pendingFocus.current = id
        else if (focused === trigger.current && next === items.length)
          pendingFocus.current = current ?? items[0]?.id ?? null
      }
      setCount(next)
    }
    const observer = new ResizeObserver(measureLayout)
    observer.observe(nav)
    observer.observe(group)
    observer.observe(more)
    buttons.forEach((button) => observer.observe(button))
    measureLayout()
    return () => observer.disconnect()
  }, [items, current])

  useLayoutEffect(() => {
    if (open) pendingFocus.current = current ?? items[0]?.id ?? null
    setOpen(false)
    setQuery('')
    if (pendingFocus.current) {
      const button = container.current?.querySelector<HTMLButtonElement>(
        `[data-navigation-area="${pendingFocus.current}"]`,
      )
      ;(button ?? trigger.current)?.focus()
      pendingFocus.current = null
    }
  }, [count, current, contextKey])

  return (
    <nav
      ref={container}
      aria-label="功能导航"
      className="relative flex min-w-0 flex-1 items-center gap-2"
    >
      {visible.length > 0 && (
        <ToggleGroup
          variant="segmented"
          aria-label="项目功能"
          value={current ? [current] : []}
          onValueChange={(values) => {
            const item = visible.find((item) => item.id === values[0])
            if (item) onNavigate(item.id)
          }}
        >
          {visible.map((item) => (
            <Toggle
              key={item.id}
              value={item.id}
              aria-label={item.label}
              data-navigation-area={item.id}
              aria-current={current === item.id ? 'page' : undefined}
            >
              <item.icon />
              <span>{item.label}</span>
            </Toggle>
          ))}
        </ToggleGroup>
      )}
      {overflow.length > 0 && (
        <div className="w-32 max-w-full min-w-0 shrink-0">
          <Combobox<ModuleItem>
            items={overflow}
            filteredItems={overflow.filter((item) => filter.contains(item.label, query))}
            autoHighlight
            aria-label="搜索功能"
            itemToStringLabel={(item) => item.label}
            isItemEqualToValue={(left, right) => left.id === right.id}
            value={selected}
            open={open}
            onOpenChange={(value) => {
              setOpen(value)
              if (!value) setQuery('')
            }}
            onValueChange={(item) => {
              if (item) onNavigate(item.id)
            }}
          >
            <ComboboxTrigger
              render={
                <Button
                  ref={trigger}
                  size="sm"
                  variant="ghost"
                  aria-label={count > 0 ? '更多功能' : '切换模块'}
                  className="w-full min-w-0 justify-start"
                  aria-current={selected ? 'page' : undefined}
                />
              }
            >
              {CurrentIcon && <CurrentIcon />}
              <span className="min-w-0 flex-1 truncate text-left">{label}</span>
              <ChevronDownIcon className="size-3.5 shrink-0" />
            </ComboboxTrigger>
            <ComboboxPopup align="start" className="w-64 max-w-(--available-width)">
              <ComboboxSearchInput
                aria-label="搜索功能"
                placeholder="搜索功能…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <ComboboxEmpty>没有匹配的功能。</ComboboxEmpty>
              <ComboboxList>
                {(item: ModuleItem) => (
                  <ComboboxItem key={item.id} value={item}>
                    <item.icon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxPopup>
          </Combobox>
        </div>
      )}
      {/* 测量节点不进入可访问树、焦点序列或页面滚动范围。 */}
      <div
        className="pointer-events-none invisible absolute h-0 w-0 overflow-hidden"
        aria-hidden
        inert
      >
        <div ref={measurement} className="flex w-max items-center gap-2">
          <ToggleGroup variant="segmented" value={[]}>
            {items.map((item) => (
              <Toggle key={item.id} value={item.id} tabIndex={-1}>
                <item.icon />
                <span>{item.label}</span>
              </Toggle>
            ))}
          </ToggleGroup>
          <div data-measure-more className="w-32 shrink-0">
            <Button size="sm" variant="ghost" tabIndex={-1}>
              更多
              <ChevronDownIcon />
            </Button>
          </div>
        </div>
      </div>
    </nav>
  )
}
