"use client";
import * as React from "react";
import type { NumberField as BaseNumberField } from "@base-ui/react/number-field";
import { Button } from "./button";
import { Input } from "./input";
import { compatibleEvent, createChangeDetails, renderWithSlot, resolveStateValue, stateDataAttributes, useControllableState, useFieldState } from "./radix-compat";

type Reason = BaseNumberField.Root.ChangeEventReason;
type CommitReason = BaseNumberField.Root.CommitEventReason;
type NumberContext = {
  state: BaseNumberField.Root.State; id: string; min?: number | undefined; max?: number | undefined; step: number | "any";
  inputRef?: React.Ref<HTMLInputElement> | undefined; name?: string | undefined; form?: string | undefined; allowWheelScrub: boolean;
  format: (value: number | null) => string; parse: (value: string) => number | null;
  change: (value: number | null, reason: Reason, event: Event, commit?: boolean, direction?: -1 | 1) => void;
  increment: (direction: -1 | 1, reason: Reason, event: Event, commit?: boolean) => void;
  commit: (reason: CommitReason, event: Event) => void;
};
const Context = React.createContext<NumberContext | null>(null);
function useNumber() { const context = React.use(Context); if (!context) throw new Error("NumberField parts require NumberField"); return context; }

function Root({ id, value: controlled, defaultValue, onValueChange, onValueCommitted, min, max,
  step = 1, smallStep = .1, largeStep = 10, disabled = false, readOnly = false, required = false,
  name, form, inputRef, locale, format: formatOptions, allowOutOfRange = false, allowWheelScrub = false,
  snapOnStep = false, render, className, style, children, ...props }: BaseNumberField.Root.Props) {
  const generatedId = React.useId();
  const [value, setValue] = useControllableState<number | null>({ prop: controlled, defaultProp: defaultValue ?? null, caller: "T3NumberField" });
  const latest = React.useRef(value); latest.current = value;
  const field = useFieldState(value, disabled);
  const formatter = React.useMemo(() => new Intl.NumberFormat(locale, formatOptions), [locale, formatOptions]);
  const format = (number: number | null) => number === null ? "" : formatter.format(number);
  const parse = (text: string) => {
    if (!text.trim()) return null;
    const parts = formatter.formatToParts(-12345.6);
    const group = parts.find((part) => part.type === "group")?.value;
    const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
    const minus = parts.find((part) => part.type === "minusSign")?.value ?? "-";
    let normalized = text.replaceAll(minus, "-");
    if (group) normalized = normalized.replaceAll(group, "");
    normalized = normalized.replaceAll(decimal, ".").replace(/[^0-9eE+.-]/g, "");
    const parsed = Number(normalized);
    return normalized && Number.isFinite(parsed) ? parsed / (formatOptions?.style === "percent" ? 100 : 1) : null;
  };
  const clamp = (number: number | null) => number === null ? null : Math.min(max ?? Infinity, Math.max(min ?? -Infinity, number));
  const change = (next: number | null, reason: Reason, event: Event, commit = false, direction?: -1 | 1) => {
    if (disabled || readOnly) return;
    const constrained = (allowOutOfRange && (reason === "input-change" || reason === "input-blur" || reason === "input-paste")) ? next : clamp(next);
    const details = { ...createChangeDetails(reason, event), direction } as BaseNumberField.Root.ChangeEventDetails;
    onValueChange?.(constrained, details);
    if (details.isCanceled) return;
    latest.current = constrained; setValue(constrained);
    if (commit) onValueCommitted?.(constrained, { reason: reason as CommitReason, event } as BaseNumberField.Root.CommitEventDetails);
  };
  const increment: NumberContext["increment"] = (direction, reason, event, commit = true) => {
    const keys = event as KeyboardEvent;
    const amount = keys.shiftKey ? largeStep : keys.altKey || keys.metaKey ? smallStep : step === "any" ? 1 : step;
    const start = latest.current ?? (direction > 0 ? min ?? 0 : max ?? 0);
    const next = snapOnStep ? (Math.round((start - (min ?? 0)) / amount) + direction) * amount + (min ?? 0) : start + amount * direction;
    change(Number(next.toPrecision(14)), reason, event, commit, direction);
  };
  const state = { ...field.state, value, inputValue: format(value), required, readOnly, scrubbing: false };
  const context: NumberContext = { state, id: id ?? generatedId, min, max, step, inputRef, name, form, allowWheelScrub,
    format, parse, change, increment, commit: (reason, event) => {
      const next = allowOutOfRange ? latest.current : clamp(latest.current);
      if (next !== latest.current) change(next, reason, event);
      onValueCommitted?.(next, { reason, event } as BaseNumberField.Root.CommitEventDetails);
    } };
  return renderWithSlot("div", { ...props, ...stateDataAttributes(state), className: resolveStateValue(className, state), style: resolveStateValue(style, state),
    children: <Context value={context}>{children}</Context> }, render, state);
}
function Group({ render, className, style, ...props }: BaseNumberField.Group.Props) {
  const { state } = useNumber(); return renderWithSlot("div", { ...props, ...stateDataAttributes(state), className: resolveStateValue(className, state), style: resolveStateValue(style, state) }, render, state);
}
function NumberInput({ className, style, render, size, onChange, onBlur, onFocus, onKeyDown, onWheel, ...props }: BaseNumberField.Input.Props) {
  const context = useNumber(); const { state } = context;
  const [draft, setDraft] = React.useState(state.inputValue);
  const focused = React.useRef(false);
  React.useEffect(() => { if (!focused.current) setDraft(state.inputValue); }, [state.inputValue]);
  return <Input {...props} id={props.id ?? context.id} ref={props.ref ?? context.inputRef} unstyled {...(size !== undefined ? { size } : {})}
    className="contents" style={resolveStateValue(style, state)} type="text" inputMode="decimal" role="spinbutton"
    disabled={state.disabled} readOnly={state.readOnly} required={props.required ?? state.required}
    name={context.name} form={context.form} aria-valuemin={context.min} aria-valuemax={context.max} aria-valuenow={state.value ?? undefined}
    value={draft} onFocus={(event) => { focused.current = true; onFocus?.(compatibleEvent(event)); }}
    onChange={(event) => { onChange?.(compatibleEvent(event)); if (event.defaultPrevented) return; const text = event.currentTarget.value; setDraft(text); const next = context.parse(text); if (next !== null || !text.trim()) context.change(next, text.trim() ? "input-change" : "input-clear", event.nativeEvent); }}
    onBlur={(event) => { focused.current = false; onBlur?.(compatibleEvent(event)); if (event.defaultPrevented) return; const next = context.parse(draft); context.change(next, "input-blur", event.nativeEvent); context.commit("input-blur", event.nativeEvent); setDraft(context.format(next === null ? null : Math.min(context.max ?? Infinity, Math.max(context.min ?? -Infinity, next)))); }}
    onKeyDown={(event) => { onKeyDown?.(compatibleEvent(event)); if (event.defaultPrevented || state.readOnly) return; if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); context.increment(event.key === "ArrowUp" ? 1 : -1, "keyboard", event.nativeEvent); focused.current = false; } else if (event.key === "Home" && context.min !== undefined) { event.preventDefault(); context.change(context.min, "keyboard", event.nativeEvent, true); focused.current = false; } else if (event.key === "End" && context.max !== undefined) { event.preventDefault(); context.change(context.max, "keyboard", event.nativeEvent, true); focused.current = false; } }}
    onWheel={(event) => { onWheel?.(compatibleEvent(event)); if (!event.defaultPrevented && focused.current && context.allowWheelScrub) { event.preventDefault(); context.increment(event.deltaY < 0 ? 1 : -1, "wheel", event.nativeEvent); focused.current = false; } }}
    render={(inputProps) => renderWithSlot("input", { ...inputProps, className: resolveStateValue(className, state) }, render, state)} />;
}
function Step({ direction, nativeButton: _nativeButton, render, className, style, disabled, onClick, ...props }: (BaseNumberField.Increment.Props | BaseNumberField.Decrement.Props) & { direction: -1 | 1 }) {
  const context = useNumber(); const { state } = context;
  const atLimit = state.value !== null && (direction > 0 ? state.value >= (context.max ?? Infinity) : state.value <= (context.min ?? -Infinity));
  return renderWithSlot(Button, { ...props, ...stateDataAttributes(state), variant: "ghost", disabled: disabled || state.disabled || state.readOnly || atLimit,
    "aria-controls": context.id, className: resolveStateValue(className, state), style: resolveStateValue(style, state),
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => { onClick?.(compatibleEvent(event)); if (!event.defaultPrevented) context.increment(direction, direction > 0 ? "increment-press" : "decrement-press", event.nativeEvent); },
  }, render, state);
}
const Increment = (props: BaseNumberField.Increment.Props) => <Step {...props} direction={1} />;
const Decrement = (props: BaseNumberField.Decrement.Props) => <Step {...props} direction={-1} />;
export const NumberField = { Root, Group, Input: NumberInput, Increment, Decrement };
