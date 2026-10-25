'use client'

// T3 v0.1.1 keeps its public component API and layouts. These adapters map it
// to the same official Radix primitives used by AutoOps shadcn components.
// Base UI imports below are types only, not a second runtime widget system.
import * as React from 'react'
import { Dialog, AlertDialog, Popover, HoverCard, Tooltip } from 'radix-ui'
import type { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { AlertDialog as BaseAlertDialog } from '@base-ui/react/alert-dialog'
import type { Popover as BasePopover } from '@base-ui/react/popover'
import type { PreviewCard as BasePreviewCard } from '@base-ui/react/preview-card'
import type { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import {
  createChangeDetails,
  renderWithPrimitive,
  renderWithSlot,
  resolveStateValue,
} from './radix-compat'

// Deliberately confined to the foreign-library compatibility boundary. Public
// callers retain upstream's typed API; native widgets receive explicitly mapped props.
type Props = Record<string, any>
interface Handle {
  snapshot: { open: boolean; payload?: unknown; trigger?: HTMLElement }
  listeners: Set<() => void>
  request?: (open: boolean, reason: string, event?: Event) => void
}
function createHandle(): Handle {
  return { snapshot: { open: false }, listeners: new Set() }
}
function updateHandle(handle: Handle, next: Partial<Handle['snapshot']>) {
  handle.snapshot = { ...handle.snapshot, ...next }
  for (const listener of handle.listeners) listener()
}
const TooltipProviderContext = React.createContext(false)
const emptySnapshot: Handle['snapshot'] = { open: false }
function useHandle(handle?: Handle) {
  return React.useSyncExternalStore(
    React.useCallback(
      (listener) => {
        handle?.listeners.add(listener)
        return () => {
          handle?.listeners.delete(listener)
        }
      },
      [handle],
    ),
    () => handle?.snapshot ?? emptySnapshot,
    () => emptySnapshot,
  )
}
function side(value: string | undefined) {
  return value === 'inline-end' ? 'right' : value === 'inline-start' ? 'left' : value
}
function makeOverlay(native: Props, kind: 'dialog' | 'alert' | 'popover' | 'preview' | 'tooltip') {
  const Context = React.createContext<Props>({ open: false })
  const Position = React.createContext<Props>({})
  function Root({
    open: controlled,
    defaultOpen = false,
    onOpenChange,
    onOpenChangeComplete,
    children,
    actionsRef,
    handle,
    delay,
    closeDelay,
    ...props
  }: Props) {
    const hasTooltipProvider = React.use(TooltipProviderContext)
    const snapshot = useHandle(handle)
    const [local, setLocal] = React.useState(defaultOpen)
    const interaction = React.useRef<{ reason: string; event?: Event } | undefined>(undefined)
    const open = controlled ?? (handle ? snapshot.open : local)
    const change = React.useCallback(
      (next: boolean, reason?: string, event?: Event) => {
        const previous = interaction.current
        interaction.current = undefined
        const details = createChangeDetails(
          reason ?? previous?.reason ?? (next ? 'trigger-press' : 'outside-press'),
          event ?? previous?.event,
        )
        onOpenChange?.(next, details)
        if (details.isCanceled) return
        setLocal(next)
        if (handle) updateHandle(handle, { open: next })
      },
      [onOpenChange, handle],
    )
    const previousOpen = React.useRef(open)
    React.useEffect(() => {
      if (previousOpen.current === open) return
      previousOpen.current = open
      const frame = requestAnimationFrame(() => onOpenChangeComplete?.(open))
      return () => cancelAnimationFrame(frame)
    }, [open, onOpenChangeComplete])
    React.useLayoutEffect(() => {
      if (!handle) return
      handle.request = change
      return () => {
        delete handle.request
      }
    }, [handle, change])
    React.useImperativeHandle(
      actionsRef,
      () => ({
        close: () => change(false, 'imperative-action'),
        unmount: () => change(false, 'imperative-action'),
      }),
      [change],
    )
    const { modal, disabled, ...unused } = props
    void unused
    const rootProps: Props = { open, onOpenChange: change }
    if (kind === 'dialog' || kind === 'popover')
      rootProps.modal = modal === 'trap-focus' ? true : modal
    if (kind === 'tooltip') rootProps.delayDuration = delay
    if (kind === 'preview') {
      rootProps.openDelay = delay
      rootProps.closeDelay = closeDelay
    }
    const content = (
      <Context
        value={{
          open,
          change,
          interaction,
          handle,
          payload: snapshot.payload,
          trigger: snapshot.trigger,
          disabled,
        }}
      >
        {React.createElement(
          native.Root,
          rootProps,
          typeof children === 'function' ? children({ open, payload: snapshot.payload }) : children,
        )}
      </Context>
    )
    return kind === 'tooltip' && !hasTooltipProvider ? (
      <Tooltip.Provider>{content}</Tooltip.Provider>
    ) : (
      content
    )
  }
  function Trigger({
    render,
    handle,
    payload,
    className,
    style,
    nativeButton: _nativeButton,
    ...props
  }: Props) {
    const context = React.use(Context)
    const snapshot = useHandle(handle)
    const state = { open: handle ? snapshot.open : context.open, disabled: props.disabled ?? false }
    const record = (reason: string, event: React.SyntheticEvent) => {
      if (context.interaction) context.interaction.current = { reason, event: event.nativeEvent }
    }
    const common = {
      ...props,
      onClick: (event: React.MouseEvent) => {
        record('trigger-press', event)
        props.onClick?.(event)
      },
      onMouseEnter: (event: React.MouseEvent) => {
        record('trigger-hover', event)
        props.onMouseEnter?.(event)
      },
      onFocus: (event: React.FocusEvent) => {
        record('trigger-focus', event)
        props.onFocus?.(event)
      },
      className: resolveStateValue(className, state),
      style: resolveStateValue(style, state),
      'data-popup-open': state.open ? '' : undefined,
    }
    if (handle) {
      return renderWithSlot(
        'button',
        {
          ...common,
          type: 'button',
          'aria-expanded': state.open,
          onClick: (event: React.MouseEvent<HTMLElement>) => {
            props.onClick?.(event)
            if (!event.defaultPrevented) {
              updateHandle(handle, { payload, trigger: event.currentTarget })
              if (handle.request) handle.request(!snapshot.open, 'trigger-press', event.nativeEvent)
              else updateHandle(handle, { open: !snapshot.open })
            }
          },
        },
        render,
        state,
      )
    }
    return renderWithPrimitive(native.Trigger, common, render, state)
  }
  function Portal({ keepMounted, container, children }: Props) {
    return React.createElement(
      native.Portal,
      { forceMount: keepMounted || undefined, container },
      <div className="contents">{children}</div>,
    )
  }
  function Positioner({
    children,
    anchor,
    side: positionSide,
    align,
    sideOffset,
    alignOffset,
    collisionPadding,
    collisionAvoidance,
    className,
    ...props
  }: Props) {
    const context = React.use(Context)
    const getAnchor = () =>
      typeof anchor === 'function'
        ? anchor()
        : anchor && 'current' in anchor
          ? anchor.current
          : anchor
    const element = getAnchor() ?? context.trigger
    const virtualRef = React.useMemo(() => ({ current: element }), [element])
    return (
      <Position
        value={{
          side: side(positionSide),
          align,
          sideOffset,
          alignOffset,
          collisionPadding,
          avoidCollisions: collisionAvoidance?.side !== 'none',
          className,
        }}
      >
        {native.Anchor && element ? React.createElement(native.Anchor, { virtualRef }) : null}
        {children}
      </Position>
    )
  }
  function Popup({
    render,
    className,
    style,
    initialFocus,
    finalFocus,
    onOpenAutoFocus,
    onCloseAutoFocus,
    onPointerDownOutside,
    onEscapeKeyDown,
    onFocusOutside,
    ...props
  }: Props) {
    const context = React.use(Context)
    const position = React.use(Position)
    const state = { open: context.open }
    const focus = (target: unknown, event: Event) => {
      const value = typeof target === 'function' ? target() : target
      if (value === false) {
        event.preventDefault()
        return
      }
      const element =
        value && typeof value === 'object' && 'current' in value ? value.current : value
      if (element instanceof HTMLElement) {
        event.preventDefault()
        element.focus()
      }
    }
    const { className: positionClassName, ...positionProps } = position
    const classes = [positionClassName, resolveStateValue(className, state)]
      .filter(Boolean)
      .join(' ')
    const prefix = kind === 'preview' ? 'hover-card' : kind
    const mappedStyle = {
      '--available-height': `var(--radix-${prefix}-content-available-height)`,
      '--available-width': `var(--radix-${prefix}-content-available-width)`,
      '--anchor-width': `var(--radix-${prefix}-trigger-width)`,
      '--anchor-height': `var(--radix-${prefix}-trigger-height)`,
      '--transform-origin': `var(--radix-${prefix}-content-transform-origin)`,
      ...resolveStateValue(style, state),
    }
    return renderWithPrimitive(
      native.Content,
      {
        ...positionProps,
        ...props,
        className: classes,
        style: mappedStyle,
        'data-open': context.open ? '' : undefined,
        'data-closed': !context.open ? '' : undefined,
        onOpenAutoFocus: (event: Event) => {
          onOpenAutoFocus?.(event)
          focus(initialFocus, event)
        },
        onCloseAutoFocus: (event: Event) => {
          onCloseAutoFocus?.(event)
          focus(finalFocus ?? context.trigger, event)
        },
        hidden: !context.open,
        onPointerDownOutside: (event: CustomEvent<{ originalEvent: Event }>) => {
          context.interaction.current = {
            reason: 'outside-press',
            event: event.detail.originalEvent,
          }
          onPointerDownOutside?.(event)
        },
        onFocusOutside: (event: CustomEvent<{ originalEvent: Event }>) => {
          context.interaction.current = { reason: 'focus-out', event: event.detail.originalEvent }
          onFocusOutside?.(event)
        },
        onEscapeKeyDown: (event: KeyboardEvent) => {
          context.interaction.current = { reason: 'escape-key', event }
          onEscapeKeyDown?.(event)
        },
      },
      render,
      state,
    )
  }
  function Backdrop({ forceRender: _force, render, className, style, ...props }: Props) {
    const context = React.use(Context)
    if (!native.Overlay)
      return context.open ? (
        <div
          {...props}
          className={className}
          onPointerDown={(event) => {
            props.onPointerDown?.(event)
            context.change(false, 'outside-press', event.nativeEvent)
            event.preventDefault()
          }}
        />
      ) : null
    return renderWithPrimitive(
      native.Overlay,
      {
        ...props,
        className: resolveStateValue(className, context),
        style: resolveStateValue(style, context),
      },
      render,
      context,
    )
  }
  function Viewport({ render, ...props }: Props) {
    return renderWithSlot('div', props, render, React.use(Context))
  }
  function Close({ render, nativeButton: _nativeButton, ...props }: Props) {
    const context = React.use(Context)
    return renderWithPrimitive(
      native.Close ?? native.Cancel,
      {
        ...props,
        onClick: (event: React.MouseEvent) => {
          context.interaction.current = { reason: 'close-press', event: event.nativeEvent }
          props.onClick?.(event)
        },
      },
      render,
      context,
    )
  }
  function Title({ render, ...props }: Props) {
    return native.Title
      ? renderWithPrimitive(native.Title, props, render, React.use(Context))
      : renderWithSlot('h2', props, render, {})
  }
  function Description({ render, ...props }: Props) {
    return native.Description
      ? renderWithPrimitive(native.Description, props, render, React.use(Context))
      : renderWithSlot('p', props, render, {})
  }
  return {
    Root,
    Trigger,
    Portal,
    Positioner,
    Popup,
    Backdrop,
    Viewport,
    Close,
    Title,
    Description,
    createHandle,
  }
}
export const DialogAdapter = makeOverlay(Dialog, 'dialog') as unknown as typeof BaseDialog
export const AlertDialogAdapter = makeOverlay(
  AlertDialog,
  'alert',
) as unknown as typeof BaseAlertDialog
export const PopoverAdapter = makeOverlay(Popover, 'popover') as unknown as typeof BasePopover
export const PreviewCardAdapter = makeOverlay(
  HoverCard,
  'preview',
) as unknown as typeof BasePreviewCard
export const TooltipAdapter = {
  ...makeOverlay(Tooltip, 'tooltip'),
  Provider: ({ delay, closeDelay: _closeDelay, children, ...props }: Props) => (
    <TooltipProviderContext value={true}>
      <Tooltip.Provider {...props} delayDuration={delay}>
        {children}
      </Tooltip.Provider>
    </TooltipProviderContext>
  ),
} as unknown as typeof BaseTooltip
