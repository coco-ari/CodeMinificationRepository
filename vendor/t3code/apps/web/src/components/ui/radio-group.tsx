"use client";

import type { Radio as BaseRadio } from "@base-ui/react/radio";
import type { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import * as React from "react";
import { RadioGroup as Primitive } from "radix-ui";
import { cn } from "~/lib/utils";
import { compatibleEvent, composeEventHandlers, createChangeDetails, renderWithPrimitive, resolveStateValue,
  stateDataAttributes, useControllableState, useFieldState, useInteractionEvent } from "./radix-compat";

const GroupContext = React.createContext({ value: "", readOnly: false, disabled: false, required: false, inputRef: undefined as React.Ref<HTMLInputElement> | undefined });
const ItemContext = React.createContext<BaseRadio.Root.State>({ checked: false, disabled: false, readOnly: false, required: false, touched: false, dirty: false, valid: null, filled: false, focused: false });

function RadioGroup({ className, style, render, value: controlled, defaultValue = "", onValueChange,
  disabled = false, readOnly = false, required = false, inputRef, onClickCapture, onKeyDownCapture,
  children, ...props }: BaseRadioGroup.Props<string>) {
  const [value, setValue] = useControllableState({ prop: controlled, defaultProp: defaultValue, caller: "T3RadioGroup" });
  const interaction = useInteractionEvent();
  const field = useFieldState(value, disabled);
  const state = { ...field.state, readOnly, required };
  return renderWithPrimitive(Primitive.Root, {
    ...props, ...stateDataAttributes(state), disabled, required, value,
    "aria-readonly": readOnly || undefined, "data-slot": "radio-group",
    className: cn("flex flex-col gap-3", resolveStateValue(className, state)),
    style: resolveStateValue(style, state),
    onClickCapture: composeEventHandlers(onClickCapture, interaction.capture),
    onKeyDownCapture: composeEventHandlers(onKeyDownCapture, interaction.capture),
    onValueChange: (next: string) => {
      if (readOnly) return;
      const details = createChangeDetails("none", interaction.event.current);
      onValueChange?.(next, details);
      if (!details.isCanceled) setValue(next);
    },
    children: <GroupContext value={{ value, readOnly, disabled, required, inputRef }}>{children}</GroupContext>,
  }, render, state);
}

function RadioRoot({ className, style, render, value, disabled: disabledProp = false, required: requiredProp = false,
  readOnly: readOnlyProp = false, nativeButton: _nativeButton, inputRef, onClick, onFocus, onBlur, children, ...props }: BaseRadio.Root.Props<string>) {
  const group = React.use(GroupContext);
  const disabled = disabledProp || group.disabled;
  const readOnly = readOnlyProp || group.readOnly;
  const required = requiredProp || group.required;
  const checked = group.value === value;
  const field = useFieldState(checked, disabled);
  const state = { ...field.state, checked, readOnly, required };
  return <Primitive.unstable_ItemProvider value={value} disabled={disabled}>
    {renderWithPrimitive(Primitive.unstable_ItemTrigger, {
      ...props, ...stateDataAttributes(state), required, "aria-readonly": readOnly || undefined,
      className: resolveStateValue(className, state), style: resolveStateValue(style, state),
      onClick: (event: React.MouseEvent<HTMLElement>) => { onClick?.(compatibleEvent(event)); if (readOnly) event.preventDefault(); },
      onFocus: composeEventHandlers(onFocus, field.onFocus), onBlur: composeEventHandlers(onBlur, field.onBlur),
      children: <ItemContext value={state}>{children}</ItemContext>,
    }, render, state)}
    <Primitive.unstable_ItemBubbleInput ref={inputRef ?? (checked ? group.inputRef : undefined)} />
  </Primitive.unstable_ItemProvider>;
}

function RadioIndicator({ className, style, render, keepMounted, ...props }: BaseRadio.Indicator.Props) {
  const state = { ...React.use(ItemContext), transitionStatus: undefined };
  return renderWithPrimitive(Primitive.Indicator, {
    ...props, ...stateDataAttributes(state), forceMount: keepMounted || undefined,
    hidden: !state.checked, className: resolveStateValue(className, state), style: resolveStateValue(style, state),
  }, render, state);
}

function Radio({ className, ...props }: BaseRadio.Root.Props<string>) {
  return <RadioRoot {...props} data-slot="radio" className={(state) => cn("relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-input bg-background not-dark:bg-clip-padding shadow-xs/5 outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-full not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:outline-destructive/48 data-disabled:opacity-64 sm:size-4 dark:not-data-checked:bg-input/32 dark:focus-visible:aria-invalid:outline-destructive/24 dark:not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [[data-disabled],[data-checked],[aria-invalid]]:shadow-none", resolveStateValue(className, state))}>
    <RadioIndicator data-slot="radio-indicator" className="-inset-px absolute flex size-4.5 items-center justify-center rounded-full before:size-2 before:rounded-full before:bg-primary-foreground data-unchecked:hidden data-checked:bg-primary sm:size-4 sm:before:size-1.5 in-[[data-slot=radio]:focus-visible]:inset-shadow-[0_0_0_3px_var(--background)] in-[[data-slot=radio]:focus-visible]:outline-2 in-[[data-slot=radio]:focus-visible]:outline-solid in-[[data-slot=radio]:focus-visible]:-outline-offset-2 in-[[data-slot=radio]:focus-visible]:outline-inherit" />
  </RadioRoot>;
}

const RadioPrimitive = { Root: RadioRoot, Indicator: RadioIndicator };
export { RadioGroup, Radio, Radio as RadioGroupItem, RadioRoot, RadioIndicator, RadioPrimitive };
