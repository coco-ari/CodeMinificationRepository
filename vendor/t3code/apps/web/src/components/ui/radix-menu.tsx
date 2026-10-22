"use client";
import * as React from "react";
import { DropdownMenu } from "radix-ui";
import type { Menu as BaseMenu } from "@base-ui/react/menu";
import { createChangeDetails, renderWithPrimitive, resolveStateValue } from "./radix-compat";

type Props = Record<string, any>;
const Position = React.createContext<Props>({});
const MenuState = React.createContext({ open: false, submenu: false });
function root(Primitive: React.ElementType, submenu: boolean) {
  return function Root({
    open: controlled,
    defaultOpen = false,
    onOpenChange,
    children,
    modal,
    ...props
  }: Props) {
    const [local, setLocal] = React.useState(defaultOpen);
    const open = controlled ?? local;
    return (
      <MenuState value={{ open, submenu }}>
        {React.createElement(
          Primitive,
          {
            open,
            ...(submenu ? {} : { modal }),
            onOpenChange: (next: boolean) => {
              const details = createChangeDetails(next ? "trigger-press" : "close-press");
              onOpenChange?.(next, details);
              if (!details.isCanceled) setLocal(next);
            },
          },
          children,
        )}
      </MenuState>
    );
  };
}
function part(Primitive: React.ElementType, item = false) {
  return function Part({
    render,
    className,
    style,
    closeOnClick,
    nativeButton: _nativeButton,
    onValueChange,
    onCheckedChange,
    ...props
  }: Props) {
    const menu = React.use(MenuState);
    const state = { open: menu.open, checked: props.checked, disabled: props.disabled ?? false };
    return renderWithPrimitive(
      Primitive,
      {
        ...props,
        ...(onValueChange
          ? {
              onValueChange: (value: unknown) =>
                onValueChange(value, createChangeDetails("item-press")),
            }
          : {}),
        ...(onCheckedChange
          ? {
              onCheckedChange: (value: unknown) =>
                onCheckedChange(value, createChangeDetails("item-press")),
            }
          : {}),
        ...(item
          ? {
              onSelect: (event: Event) => {
                props.onSelect?.(event);
                if (closeOnClick === false) event.preventDefault();
              },
            }
          : {}),
        className: resolveStateValue(className, state),
        style: resolveStateValue(style, state),
        "data-popup-open": menu.open ? "" : undefined,
      },
      render,
      state,
    );
  };
}
function Positioner({
  children,
  side,
  align,
  sideOffset,
  alignOffset,
  collisionPadding,
  className,
}: Props) {
  return (
    <Position
      value={{
        side: side === "inline-end" ? "right" : side === "inline-start" ? "left" : side,
        align,
        sideOffset,
        alignOffset,
        collisionPadding,
        className,
      }}
    >
      {children}
    </Position>
  );
}
function Popup({ render, className, style, initialFocus, finalFocus, ...props }: Props) {
  const { className: positionClassName, ...position } = React.use(Position);
  const state = React.use(MenuState);
  return renderWithPrimitive(
    state.submenu ? DropdownMenu.SubContent : DropdownMenu.Content,
    {
      ...position,
      ...props,
      className: [positionClassName, resolveStateValue(className, state)].filter(Boolean).join(" "),
      style: {
        "--available-height": "var(--radix-dropdown-menu-content-available-height)",
        "--available-width": "var(--radix-dropdown-menu-content-available-width)",
        "--anchor-width": "var(--radix-dropdown-menu-trigger-width)",
        "--transform-origin": "var(--radix-dropdown-menu-content-transform-origin)",
        ...resolveStateValue(style, state),
      },
      onOpenAutoFocus: (event: Event) => {
        props.onOpenAutoFocus?.(event);
        if (initialFocus === false) event.preventDefault();
      },
      onCloseAutoFocus: (event: Event) => {
        props.onCloseAutoFocus?.(event);
        if (event.defaultPrevented) return;
        // T3's composer returns false after restoring its editor focus. Preserve
        // that callback contract instead of focusing a now-disabled menu trigger.
        const target = typeof finalFocus === "function" ? finalFocus() : finalFocus;
        if (target === false) {
          event.preventDefault();
          return;
        }
        const element =
          target && typeof target === "object" && "current" in target ? target.current : target;
        if (element instanceof HTMLElement) {
          event.preventDefault();
          element.focus({ preventScroll: true });
        }
      },
    },
    render,
    state,
  );
}
export const MenuAdapter = {
  Root: root(DropdownMenu.Root, false),
  SubmenuRoot: root(DropdownMenu.Sub, true),
  Trigger: part(DropdownMenu.Trigger),
  SubmenuTrigger: part(DropdownMenu.SubTrigger),
  Portal: ({ keepMounted, children, ...props }: Props) => (
    <DropdownMenu.Portal {...props} forceMount={keepMounted || undefined}>
      {children}
    </DropdownMenu.Portal>
  ),
  Positioner,
  Popup,
  Group: part(DropdownMenu.Group),
  GroupLabel: part(DropdownMenu.Label),
  Item: part(DropdownMenu.Item, true),
  CheckboxItem: part(DropdownMenu.CheckboxItem, true),
  CheckboxItemIndicator: part(DropdownMenu.ItemIndicator),
  RadioGroup: part(DropdownMenu.RadioGroup),
  RadioItem: part(DropdownMenu.RadioItem, true),
  RadioItemIndicator: part(DropdownMenu.ItemIndicator),
  Separator: part(DropdownMenu.Separator),
} as unknown as typeof BaseMenu;
