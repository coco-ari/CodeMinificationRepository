'use client'
import * as React from 'react'
import { Select } from 'radix-ui'
import type { Select as BaseSelect } from '@base-ui/react/select'
import { createChangeDetails, renderWithPrimitive, resolveStateValue } from './radix-compat'
type Props = Record<string, any>
const SelectContext = React.createContext<Props>({})
const Position = React.createContext<Props>({})
const encodeValue = (value: unknown) =>
  value == null ? '' : `${typeof value}:${JSON.stringify(value)}`
function Root({
  value: controlled,
  defaultValue,
  onValueChange,
  children,
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  items,
  itemToStringLabel,
  ...props
}: Props) {
  const [local, setLocal] = React.useState(defaultValue)
  const [localOpen, setLocalOpen] = React.useState(defaultOpen ?? false)
  const value = controlled === undefined ? local : controlled
  const open = controlledOpen ?? localOpen
  const values = React.useRef(new Map<string, unknown>())
  if (value != null) values.current.set(encodeValue(value), value)
  const state = { value, open, values: values.current, items, itemToStringLabel }
  return (
    <SelectContext value={state}>
      <Select.Root
        value={encodeValue(value)}
        open={open}
        disabled={props.disabled}
        name={props.name}
        required={props.required}
        form={props.form}
        onValueChange={(encoded) => {
          const next = values.current.get(encoded)
          const details = createChangeDetails('item-press')
          onValueChange?.(next, details)
          if (!details.isCanceled) setLocal(next)
        }}
        onOpenChange={(next) => {
          const details = createChangeDetails(next ? 'trigger-press' : 'outside-press')
          onOpenChange?.(next, details)
          if (!details.isCanceled) setLocalOpen(next)
        }}
      >
        {children}
      </Select.Root>
    </SelectContext>
  )
}
function part(Primitive: React.ElementType) {
  return function Part({ render, className, style, nativeButton: _nativeButton, ...props }: Props) {
    const state = React.use(SelectContext)
    return renderWithPrimitive(
      Primitive,
      {
        ...props,
        className: resolveStateValue(className, state),
        style: resolveStateValue(style, state),
        'data-popup-open': state.open ? '' : undefined,
      },
      render,
      state,
    )
  }
}
function Item({ value, ...props }: Props) {
  const context = React.use(SelectContext)
  const encoded = encodeValue(value)
  context.values.set(encoded, value)
  const Component = React.useMemo(() => part(Select.Item), [])
  return (
    <Component
      {...props}
      value={encoded}
      data-selected={Object.is(context.value, value) ? '' : undefined}
    />
  )
}
function Value({ children, ...props }: Props) {
  const context = React.use(SelectContext)
  let content = typeof children === 'function' ? children(context.value) : children
  if (content === undefined && context.value != null && context.items) {
    const match = Array.isArray(context.items)
      ? context.items.find(
          (item: unknown) =>
            typeof item === 'object' &&
            item !== null &&
            'value' in item &&
            Object.is(item.value, context.value),
        )
      : undefined
    content = match?.label ?? context.itemToStringLabel?.(context.value)
  }
  return <Select.Value {...props}>{content}</Select.Value>
}
function Positioner({
  children,
  alignItemWithTrigger,
  side,
  align,
  sideOffset,
  alignOffset,
  className,
}: Props) {
  return (
    <Position
      value={{
        position: alignItemWithTrigger ? 'item-aligned' : 'popper',
        side,
        align,
        sideOffset,
        alignOffset,
        className,
      }}
    >
      {children}
    </Position>
  )
}
function Popup({ className, style, ...props }: Props) {
  const { className: positionClass, ...position } = React.use(Position)
  return (
    <Select.Content
      {...position}
      {...props}
      className={[positionClass, className].filter(Boolean).join(' ')}
      style={
        {
          '--available-height': 'var(--radix-select-content-available-height)',
          '--available-width': 'var(--radix-select-content-available-width)',
          '--anchor-width': 'var(--radix-select-trigger-width)',
          '--transform-origin': 'var(--radix-select-content-transform-origin)',
          ...style,
        } as React.CSSProperties
      }
    />
  )
}
export const SelectAdapter = {
  Root,
  Trigger: part(Select.Trigger),
  Value,
  Icon: part(Select.Icon),
  Portal: Select.Portal,
  Positioner,
  Popup,
  List: part(Select.Viewport),
  Item,
  ItemText: part(Select.ItemText),
  ItemIndicator: part(Select.ItemIndicator),
  Group: part(Select.Group),
  GroupLabel: part(Select.Label),
  ScrollUpArrow: part(Select.ScrollUpButton),
  ScrollDownArrow: part(Select.ScrollDownButton),
  Separator: part(Select.Separator),
} as unknown as typeof BaseSelect
