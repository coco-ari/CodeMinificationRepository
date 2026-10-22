"use client";

import type { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import type { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "~/lib/utils";
import { toggleVariants } from "~/components/ui/toggle";

import { ToggleGroup as Primitive } from "radix-ui";
import { composeEventHandlers, createChangeDetails, renderWithPrimitive, resolveStateValue,
  stateDataAttributes, useControllableState, useInteractionEvent } from "./radix-compat";

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants> & { value: readonly string[]; disabled: boolean }>({
  size: "default", variant: "default", value: [], disabled: false,
});

function ToggleGroup({ className, style, render, variant = "segmented", size: sizeProp,
  orientation = "horizontal", children, value: controlled, defaultValue = [], onValueChange,
  multiple = false, disabled = false, loopFocus = true, onClickCapture, onKeyDownCapture, ...props
}: ToggleGroupPrimitive.Props & VariantProps<typeof toggleVariants>) {
  const [value, setValue] = useControllableState({ prop: controlled, defaultProp: defaultValue, caller: "T3ToggleGroup" });
  const interaction = useInteractionEvent();
  const state = { disabled, multiple, orientation };
  const size = sizeProp === undefined ? (variant === "segmented" ? "segmented" : "default") : sizeProp;
  return renderWithPrimitive(Primitive.Root, {
    ...props, ...stateDataAttributes(state), orientation, disabled, loop: loopFocus,
    type: multiple ? "multiple" : "single", value: multiple ? [...value] : value[0] ?? "",
    onClickCapture: composeEventHandlers(onClickCapture, interaction.capture),
    onKeyDownCapture: composeEventHandlers(onKeyDownCapture, interaction.capture),
    onValueChange: (next: string | string[]) => {
      const values = Array.isArray(next) ? next : next ? [next] : [];
      const details = createChangeDetails("none", interaction.event.current);
      onValueChange?.(values, details);
      if (!details.isCanceled) setValue(values);
    },
    className: cn(
        "flex w-fit *:focus-visible:z-10 dark:*:[[data-slot=separator]:has(+[data-slot=toggle]:hover)]:before:bg-input/64 dark:*:[[data-slot=separator]:has(+[data-slot=toggle][data-pressed])]:before:bg-input dark:*:[[data-slot=toggle]:hover+[data-slot=separator]]:before:bg-input/64 dark:*:[[data-slot=toggle][data-pressed]+[data-slot=separator]]:before:bg-input",
        orientation === "horizontal"
          ? "*:pointer-coarse:after:min-w-auto"
          : "*:pointer-coarse:after:min-h-auto",
        variant === "segmented"
          ? "gap-0.5 rounded-lg bg-input/40 p-0.5"
          : variant === "default"
            ? "gap-0.5"
            : orientation === "horizontal"
              ? "*:not-first:not-data-[slot=separator]:before:-start-[0.5px] *:not-last:not-data-[slot=separator]:before:-end-[0.5px] *:not-first:rounded-s-none *:not-last:rounded-e-none *:not-first:border-s-0 *:not-last:border-e-0 *:not-first:before:rounded-s-none *:not-last:before:rounded-e-none"
              : "*:not-first:not-data-[slot=separator]:before:-top-[0.5px] *:not-last:not-data-[slot=separator]:before:-bottom-[0.5px] flex-col *:not-first:rounded-t-none *:not-last:rounded-b-none *:not-first:border-t-0 *:not-last:border-b-0 *:not-first:before:rounded-t-none *:not-last:before:rounded-b-none *:data-[slot=toggle]:not-last:before:hidden dark:*:last:before:hidden dark:*:first:before:block",
      resolveStateValue(className, state)),
    style: resolveStateValue(style, state), "data-size": size, "data-slot": "toggle-group", "data-variant": variant,
    children: <ToggleGroupContext value={{ size, variant, value, disabled }}>{children}</ToggleGroupContext>,
  }, render, state);
}

function Toggle({ className, style, render, variant, size, value = "", disabled: disabledProp = false,
  pressed: _pressed, defaultPressed: _defaultPressed, onPressedChange, nativeButton: _nativeButton, onClick, ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.use(ToggleGroupContext);
  const resolvedVariant = variant ?? context.variant;
  const resolvedSize = size ?? context.size;
  const state = { pressed: context.value.includes(value), disabled: disabledProp || context.disabled };
  return renderWithPrimitive(Primitive.Item, {
    ...props, ...stateDataAttributes(state), value, disabled: state.disabled,
    className: cn(toggleVariants({ variant: resolvedVariant, size: resolvedSize }), resolveStateValue(className, state)),
    style: resolveStateValue(style, state), "data-slot": "toggle", "data-size": resolvedSize, "data-variant": resolvedVariant,
    onClick: (event: React.MouseEvent<HTMLButtonElement> & { preventBaseUIHandler: () => void }) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      const details = createChangeDetails("none", event.nativeEvent);
      onPressedChange?.(!state.pressed, details);
      if (details.isCanceled) event.preventDefault();
    },
  }, render, state);
}

export { ToggleGroup, Toggle, Toggle as ToggleGroupItem };
