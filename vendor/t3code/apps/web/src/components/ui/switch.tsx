"use client";

import type { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Switch as Primitive } from "radix-ui";
import { cn } from "~/lib/utils";
import { compatibleEvent, composeEventHandlers, createChangeDetails, renderWithPrimitive, resolveStateValue,
  stateDataAttributes, useControllableState, useFieldState, useInteractionEvent } from "./radix-compat";

function Switch({
  className, style, render, checked: checkedProp, defaultChecked = false, onCheckedChange,
  readOnly = false, disabled = false, required = false, nativeButton: _nativeButton,
  inputRef, uncheckedValue, name, form, value, children: _children,
  onClick, onClickCapture, onFocus, onBlur, size = "default", mixed = false, ...props
}: BaseSwitch.Root.Props & { size?: "default" | "sm"; mixed?: boolean }) {
  const [checked, setChecked] = useControllableState({ prop: checkedProp, defaultProp: defaultChecked, caller: "T3Switch" });
  const interaction = useInteractionEvent();
  const field = useFieldState(checked, disabled);
  const state = { ...field.state, checked, readOnly, required };
  const data = stateDataAttributes(state);
  return (
    <Primitive.unstable_Provider checked={checked} disabled={disabled} required={required}
      name={name} form={form} value={value} onCheckedChange={(next) => {
        if (readOnly) return;
        const details = createChangeDetails("none", interaction.event.current);
        onCheckedChange?.(next === true, details);
        if (!details.isCanceled) setChecked(next === true);
      }}>
      {renderWithPrimitive(Primitive.unstable_Trigger, {
        ...props, ...data,
        "data-slot": "switch", "data-ui": "switch", "aria-readonly": readOnly || undefined,
        className: cn("inline-flex h-[calc(var(--thumb-size)+2px)] w-[calc(var(--thumb-size)*2-2px)] shrink-0 cursor-pointer items-center rounded-full p-[2px] outline-none transition-[background-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input data-disabled:cursor-not-allowed data-disabled:opacity-64 data-[mixed]:bg-input",
          size === "sm" ? "[--thumb-size:--spacing(4)] sm:[--thumb-size:--spacing(3.5)]" : "[--thumb-size:--spacing(5)] sm:[--thumb-size:--spacing(4)]",
          resolveStateValue(className, state)),
        style: resolveStateValue(style, state),
        onClickCapture: composeEventHandlers(onClickCapture, interaction.capture),
        onClick: (event: React.MouseEvent<HTMLElement>) => { onClick?.(compatibleEvent(event)); if (readOnly) event.preventDefault(); },
        onFocus: composeEventHandlers(onFocus, field.onFocus),
        onBlur: composeEventHandlers(onBlur, field.onBlur),
        "data-size": size, "data-mixed": mixed ? "" : undefined,
        ...(mixed ? { "aria-checked": "mixed" as const } : {}),
        children: <Primitive.Thumb {...data}
        className={cn(
          "pointer-events-none block size-[calc(var(--thumb-size)-2px)] shrink-0 origin-left in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:not-data-disabled:scale-x-110 in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.1)] rounded-(--thumb-size) bg-background shadow-sm/5 dark:data-unchecked:bg-muted-foreground [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s] data-checked:origin-right data-checked:translate-x-[calc(var(--thumb-size)-4px)]",
          mixed &&
            "translate-x-[calc((var(--thumb-size)-4px)/2)] opacity-70 data-checked:translate-x-[calc((var(--thumb-size)-4px)/2)]",
        )} data-slot="switch-thumb" />,
      }, render, state)}
      {/* Radix's exported split primitive preserves T3's inputRef and form input outside forms. */}
      <Primitive.unstable_BubbleInput ref={inputRef} />
      {uncheckedValue !== undefined && !checked && <input type="hidden" name={name} form={form} value={uncheckedValue} disabled={disabled} />}
    </Primitive.unstable_Provider>
  );
}

export { Switch };
