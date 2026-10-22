'use client'
// shadcn's Command (cmdk) + Radix Popover supply the searchable picker. This
// boundary preserves T3's controlled values and its existing LegendList owner.
import * as React from 'react'
import { Command } from 'cmdk'
import { Popover } from 'radix-ui'
import type { Combobox as BaseCombobox } from '@base-ui/react/combobox'
import type { Autocomplete as BaseAutocomplete } from '@base-ui/react/autocomplete'
import {
  createChangeDetails,
  renderWithPrimitive,
  renderWithSlot,
  resolveStateValue,
} from './radix-compat'
import { Button } from './button'

type Props = Record<string, any>
const Context = React.createContext<Props>({})
const Position = React.createContext<Props>({})
const keyOf = (value: unknown): string => `${typeof value}:${JSON.stringify(value)}`
const flatten = (items: unknown[]): unknown[] =>
  items.flatMap((item) =>
    item && typeof item === 'object' && 'items' in item && Array.isArray(item.items)
      ? item.items
      : [item],
  )
function makeRoot(autocomplete: boolean) {
  return function Root({
    children,
    value: controlled,
    defaultValue,
    onValueChange,
    inputValue: controlledInput,
    onInputValueChange,
    open: controlledOpen,
    defaultOpen = false,
    onOpenChange,
    items = [],
    filteredItems,
    filter,
    inline = false,
    virtualized = false,
    multiple = false,
    itemToStringValue,
    itemToStringLabel,
    onItemHighlighted,
    autoHighlight = true,
    loopFocus = true,
    disabled,
    mode,
    ...props
  }: Props) {
    const [local, setLocal] = React.useState(
      defaultValue ?? (multiple ? [] : autocomplete ? '' : null),
    )
    const [query, setQuery] = React.useState('')
    const [localOpen, setLocalOpen] = React.useState(defaultOpen)
    const [highlight, setHighlight] = React.useState('')
    const value = controlled === undefined ? local : controlled
    const inputValue = controlledInput ?? (autocomplete ? value : query) ?? ''
    const open = controlledOpen ?? localOpen
    const values = React.useRef(new Map<string, unknown>())
    const eventRef = React.useRef<Event | undefined>(undefined)
    const inputRef = React.useRef<HTMLInputElement | null>(null)
    const all = flatten(items)
    const label = (item: unknown) =>
      String(
        itemToStringLabel?.(item) ??
          itemToStringValue?.(item) ??
          (typeof item === 'string'
            ? item
            : item && typeof item === 'object' && 'label' in item
              ? item.label
              : (item ?? '')),
      )
    const visible = filteredItems
      ? flatten(filteredItems)
      : filter === null || !inputValue
        ? all
        : all.filter((item) =>
            typeof filter === 'function'
              ? filter(item, inputValue)
              : label(item).toLocaleLowerCase().includes(String(inputValue).toLocaleLowerCase()),
          )
    for (const item of all) values.current.set(keyOf(item), item)
    const changeOpen = (next: boolean, reason = 'trigger-press') => {
      const details = createChangeDetails(reason, eventRef.current)
      onOpenChange?.(next, details)
      if (!details.isCanceled) setLocalOpen(next)
    }
    const changeValue = (next: unknown, reason: string) => {
      const details = createChangeDetails(reason, eventRef.current)
      onValueChange?.(next, details)
      if (!details.isCanceled) setLocal(next)
    }
    const highlightValue = (encoded: string, reason: string) => {
      setHighlight(encoded)
      const item = values.current.get(encoded) ?? null
      onItemHighlighted?.(item, {
        ...createChangeDetails(reason, eventRef.current),
        index: visible.findIndex((value) => keyOf(value) === encoded),
      })
    }
    const select = (item: unknown) => {
      if (disabled) return
      if (autocomplete) {
        if (mode !== 'none') changeValue(label(item), 'item-press')
      } else {
        changeValue(
          multiple
            ? Array.isArray(value) && value.some((entry) => keyOf(entry) === keyOf(item))
              ? value.filter((entry: unknown) => keyOf(entry) !== keyOf(item))
              : [...(Array.isArray(value) ? value : []), item]
            : item,
          'item-press',
        )
      }
      if (!multiple && !inline) changeOpen(false, 'item-press')
    }
    const changeInput = (next: string) => {
      setQuery(next)
      onInputValueChange?.(next, createChangeDetails('input-change', eventRef.current))
      if (autocomplete) changeValue(next, 'input-change')
    }
    // cmdk owns ordinary keyboard navigation. LegendList mounts only visible rows;
    // translate its existing all-item index contract before delegating item selection.
    const virtualKeyDown = (event: React.KeyboardEvent) => {
      eventRef.current = event.nativeEvent
      if (
        !virtualized ||
        event.defaultPrevented ||
        event.nativeEvent.isComposing ||
        event.keyCode === 229
      )
        return
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || visible.length === 0)
        return
      const current = visible.findIndex((item) => keyOf(item) === highlight)
      const raw =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? visible.length - 1
            : current + (event.key === 'ArrowDown' ? 1 : -1)
      const index = loopFocus
        ? (raw + visible.length) % visible.length
        : Math.max(0, Math.min(visible.length - 1, raw))
      event.preventDefault()
      highlightValue(keyOf(visible[index]), 'keyboard')
    }
    React.useEffect(() => {
      if (
        autoHighlight &&
        visible.length &&
        (!highlight || !visible.some((item) => keyOf(item) === highlight))
      )
        highlightValue(keyOf(visible[0]), 'none')
    }, [visible.map(keyOf).join('\0'), autoHighlight])
    const context = {
      value,
      inputValue,
      open,
      inline,
      autocomplete,
      multiple,
      values: values.current,
      visible,
      label,
      select,
      changeInput,
      changeOpen,
      highlight,
      highlightValue,
      virtualKeyDown,
      inputRef,
      eventRef,
      disabled,
    }
    const content = (
      <Command
        className="contents"
        shouldFilter={false}
        loop={loopFocus}
        value={highlight}
        onValueChange={(encoded) => highlightValue(encoded, 'keyboard')}
        onKeyDown={virtualKeyDown}
        onPointerDownCapture={(event) => {
          eventRef.current = event.nativeEvent
        }}
        aria-label={props['aria-label']}
      >
        {children}
      </Command>
    )
    return (
      <Context value={context}>
        {inline ? (
          content
        ) : (
          <Popover.Root open={open} onOpenChange={changeOpen}>
            {content}
          </Popover.Root>
        )}
      </Context>
    )
  }
}
function Input({
  render,
  className,
  style,
  value: controlled,
  onChange,
  onInputCapture,
  onKeyDown,
  ...props
}: Props) {
  const context = React.use(Context)
  const position = React.use(Position)
  const latest = React.useRef<React.FormEvent<HTMLInputElement> | null>(null)
  const state = { open: context.open, disabled: props.disabled }
  const input = renderWithPrimitive(
    Command.Input,
    {
      ...props,
      value: controlled ?? context.inputValue,
      className: resolveStateValue(className, state),
      style: resolveStateValue(style, state),
      ref: (node: HTMLInputElement | null) => {
        context.inputRef.current = node
        const ref = props.ref
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      },
      onInputCapture: (event: React.FormEvent<HTMLInputElement>) => {
        latest.current = event
        context.eventRef.current = event.nativeEvent
        onInputCapture?.(event)
      },
      onValueChange: (value: string) => {
        context.changeInput(value)
        if (onChange && latest.current) onChange(latest.current)
        if (!context.inline) context.changeOpen(true, 'input-change')
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        context.eventRef.current = event.nativeEvent
        onKeyDown?.(event)
        // T3's search stops propagation to isolate composer shortcuts. Base UI
        // navigates at the input, so virtualized navigation must run here too.
        context.virtualKeyDown(event)
      },
    },
    render,
    state,
  )
  // A search field inside a popup must not replace its trigger as the Popper anchor.
  return context.inline || position.inPopup ? (
    input
  ) : (
    <Popover.Anchor asChild>{input}</Popover.Anchor>
  )
}
function Trigger({ render, nativeButton: _nativeButton, ...props }: Props) {
  const context = React.use(Context)
  return renderWithPrimitive(
    context.inline ? Button : Popover.Trigger,
    { ...props, disabled: props.disabled ?? context.disabled },
    render,
    { open: context.open },
  )
}
function Portal({ children, ...props }: Props) {
  return React.use(Context).inline ? (
    <>{children}</>
  ) : (
    <Popover.Portal {...props}>{children}</Popover.Portal>
  )
}
function Positioner({ children, side, align, sideOffset, alignOffset, anchor, className }: Props) {
  const context = React.use(Context)
  const node =
    typeof anchor === 'function'
      ? anchor()
      : anchor && 'current' in anchor
        ? anchor.current
        : anchor
  return (
    <Position value={{ side, align, sideOffset, alignOffset, className, inPopup: true }}>
      {!context.inline && node ? <Popover.Anchor virtualRef={{ current: node }} /> : null}
      {children}
    </Position>
  )
}
function Popup({ className, style, initialFocus, finalFocus, ...props }: Props) {
  const context = React.use(Context)
  const { className: positionClass, inPopup: _inPopup, ...position } = React.use(Position)
  if (context.inline) return <div {...props} className={className} style={style} />
  return (
    <Popover.Content
      {...position}
      {...props}
      className={[positionClass, className].filter(Boolean).join(' ')}
      style={
        {
          '--available-height': 'var(--radix-popover-content-available-height)',
          '--available-width': 'var(--radix-popover-content-available-width)',
          '--anchor-width': 'var(--radix-popover-trigger-width)',
          ...style,
        } as React.CSSProperties
      }
      onOpenAutoFocus={(event) => {
        if (initialFocus === false || context.inputRef.current === document.activeElement)
          event.preventDefault()
      }}
      onCloseAutoFocus={(event) => {
        if (finalFocus === false) event.preventDefault()
      }}
    />
  )
}
function Item({
  value,
  render,
  className,
  style,
  onClick,
  onPointerMove,
  index: _index,
  ...props
}: Props) {
  const context = React.use(Context)
  const ref = React.useRef<HTMLElement | null>(null)
  const encoded = keyOf(value)
  context.values.set(encoded, value)
  const selected = context.multiple
    ? Array.isArray(context.value) && context.value.some((item: unknown) => keyOf(item) === encoded)
    : keyOf(context.value) === encoded
  const state = {
    selected,
    highlighted: context.highlight === encoded,
    disabled: props.disabled ?? false,
  }
  return renderWithPrimitive(
    Command.Item,
    {
      ...props,
      ref,
      value: encoded,
      // cmdk emits data-disabled="false" and uses data-selected for keyboard
      // highlight. Base UI used presence for disabled and selected value. Keep
      // T3's classes semantic while retaining cmdk's native item navigation.
      className: resolveStateValue(className, state)
        ?.replaceAll('data-disabled', 'data-[disabled=true]')
        .replaceAll('data-selected', 'data-value-selected'),
      style: resolveStateValue(style, state),
      'data-highlighted': state.highlighted ? '' : undefined,
      'data-value-selected': state.selected ? '' : undefined,
      onPointerMoveCapture: (event: React.PointerEvent) => {
        context.eventRef.current = event.nativeEvent
        onPointerMove?.(event)
        context.highlightValue(encoded, 'pointer')
      },
      onSelect: () => {
        const event = context.eventRef.current ?? new MouseEvent('click')
        let canceled = false
        const click = {
          nativeEvent: event,
          currentTarget: ref.current,
          target: ref.current,
          preventDefault: () => {
            canceled = true
            event.preventDefault()
          },
          stopPropagation: () => event.stopPropagation(),
          get defaultPrevented() {
            return event.defaultPrevented
          },
        }
        onClick?.(click)
        if (!canceled) context.select(value)
      },
    },
    render,
    state,
  )
}
function List({ children, render, ...props }: Props) {
  const context = React.use(Context)
  return renderWithPrimitive(
    Command.List,
    {
      ...props,
      // cmdk owns the listbox's aria-label and otherwise replaces it with "Suggestions".
      label: props['aria-label'] ?? props.label,
      children: typeof children === 'function' ? context.visible.map(children) : children,
    },
    render,
    context,
  )
}
function Collection({ children }: Props) {
  const context = React.use(Context)
  return typeof children === 'function' ? context.visible.map(children) : children
}
function Empty(props: Props) {
  return <Command.Empty {...props} />
}
function Clear({ render, ...props }: Props) {
  const context = React.use(Context)
  return renderWithPrimitive(
    Button,
    {
      ...props,
      type: 'button',
      onClick: (event: React.MouseEvent) => {
        props.onClick?.(event)
        context.changeInput('')
        context.inputRef.current?.focus()
      },
    },
    render,
    {},
  )
}
function Group({ render, ...props }: Props) {
  return renderWithPrimitive(Command.Group, props, render, {})
}
function GroupLabel({ render, ...props }: Props) {
  return renderWithSlot('div', { ...props, role: 'presentation' }, render, {})
}
function useFilter(options?: Intl.CollatorOptions) {
  const collator = React.useMemo(
    () => new Intl.Collator(undefined, { usage: 'search', sensitivity: 'base', ...options }),
    [options],
  )
  return {
    contains: (value: string, query: string) => {
      for (let index = 0; index <= value.length - query.length; index++)
        if (collator.compare(value.slice(index, index + query.length), query) === 0) return true
      return false
    },
    startsWith: (value: string, query: string) =>
      collator.compare(value.slice(0, query.length), query) === 0,
    endsWith: (value: string, query: string) =>
      collator.compare(value.slice(-query.length), query) === 0,
  }
}
const shared = {
  Input,
  Trigger,
  Portal,
  Positioner,
  Popup,
  Item,
  List,
  Collection,
  Empty,
  Clear,
  Group,
  GroupLabel,
  Icon: ({ render, ...props }: Props) => renderWithSlot('span', props, render, {}),
  Status: ({ render, ...props }: Props) =>
    renderWithSlot('div', { ...props, role: 'status' }, render, {}),
  useFilter,
}
export const ComboboxAdapter = {
  ...shared,
  Root: makeRoot(false),
} as unknown as typeof BaseCombobox
export const AutocompleteAdapter = {
  ...shared,
  Root: makeRoot(true),
} as unknown as typeof BaseAutocomplete
