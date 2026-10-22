"use client";

import type { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Checkbox as Primitive } from "radix-ui";
import { cn } from "~/lib/utils";
import { compatibleEvent, composeEventHandlers, createChangeDetails, renderWithPrimitive, resolveStateValue,
  stateDataAttributes, useControllableState, useFieldState, useInteractionEvent } from "./radix-compat";

function Checkbox({
  className, style, render, checked: checkedProp, defaultChecked = false, onCheckedChange,
  readOnly = false, disabled = false, required = false, nativeButton: _nativeButton,
  inputRef, uncheckedValue, name, form, value, children: _children,
  onClick, onClickCapture, onFocus, onBlur, indeterminate = false, parent: _parent, ...props
}: BaseCheckbox.Root.Props) {
  const [checked, setChecked] = useControllableState({ prop: checkedProp, defaultProp: defaultChecked, caller: "T3Checkbox" });
  const interaction = useInteractionEvent();
  const field = useFieldState(checked, disabled);
  const state = { ...field.state, checked, readOnly, required, indeterminate };
  const data = stateDataAttributes(state);
  return (
    <Primitive.unstable_Provider checked={indeterminate ? "indeterminate" : checked} disabled={disabled} required={required}
      name={name} form={form} value={value} onCheckedChange={(next) => {
        if (readOnly) return;
        const details = createChangeDetails("none", interaction.event.current);
        onCheckedChange?.(next === true, details);
        if (!details.isCanceled) setChecked(next === true);
      }}>
      {renderWithPrimitive(Primitive.unstable_Trigger, {
        ...props, ...data,
        "data-slot": "checkbox", "data-ui": "checkbox", "aria-readonly": readOnly || undefined,
        className: cn("relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-[.25rem] border border-input bg-background not-dark:bg-clip-padding shadow-xs/5 outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[3px] not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:outline-destructive/48 data-disabled:opacity-64 sm:size-4 dark:not-data-checked:bg-input/32 dark:focus-visible:aria-invalid:outline-destructive/24 dark:not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [[data-disabled],[data-checked],[aria-invalid]]:shadow-none",
          resolveStateValue(className, state)),
        style: resolveStateValue(style, state),
        onClickCapture: composeEventHandlers(onClickCapture, interaction.capture),
        onClick: (event: React.MouseEvent<HTMLElement>) => { onClick?.(compatibleEvent(event)); if (readOnly) event.preventDefault(); },
        onFocus: composeEventHandlers(onFocus, field.onFocus),
        onBlur: composeEventHandlers(onBlur, field.onBlur),
        children: <Primitive.Indicator {...data}
          className="-inset-px absolute flex items-center justify-center rounded-[.25rem] text-primary-foreground data-unchecked:not-data-indeterminate:hidden data-checked:bg-primary data-indeterminate:text-foreground in-[[data-slot=checkbox]:focus-visible]:inset-shadow-[0_0_0_3px_var(--background)] in-[[data-slot=checkbox]:focus-visible]:outline-2 in-[[data-slot=checkbox]:focus-visible]:outline-solid in-[[data-slot=checkbox]:focus-visible]:-outline-offset-2 in-[[data-slot=checkbox]:focus-visible]:outline-inherit"
          data-slot="checkbox-indicator">
          <svg className="size-3.5 text-current sm:size-3" fill="none" height="24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg">
            <path d={indeterminate ? "M5.252 12h13.496" : "M5.252 12.7 10.2 18.63 18.748 5.37"} />
          </svg>
        </Primitive.Indicator>,
      }, render, state)}
      {/* Radix's exported split primitive preserves T3's inputRef and form input outside forms. */}
      <Primitive.unstable_BubbleInput ref={inputRef} />
      {uncheckedValue !== undefined && !checked && <input type="hidden" name={name} form={form} value={uncheckedValue} disabled={disabled} />}
    </Primitive.unstable_Provider>
  );
}

export { Checkbox };
