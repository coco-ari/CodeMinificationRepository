"use client";

// AutoOps adapter: preserve T3's render/state API while Radix owns composition,
// focus, keyboard interaction and form-control behavior.
import * as React from "react";
import { Slot } from "radix-ui";
import type { useRender as BaseUseRender } from "@base-ui/react/use-render";
export { useControllableState } from "@radix-ui/react-use-controllable-state";

type RenderFunction = (props: Record<string, unknown>, state: unknown) => React.ReactElement;
export type RenderProp<State = Record<string, never>> =
  | React.ReactElement
  | ((props: Record<string, unknown>, state: State) => React.ReactElement);

const RenderFunctionHost = React.forwardRef<HTMLElement, {
  renderFunction: RenderFunction;
  renderState: unknown;
  children?: React.ReactNode;
}>(({ renderFunction, renderState, ...props }, ref) => renderFunction({ ...props, ref }, renderState));

/** Function renders receive Radix's final props exactly once, including its ref. */
export function renderWithPrimitive<State>(
  Primitive: React.ElementType,
  props: Record<string, unknown>,
  render: React.ReactElement | ((props: never, state: State) => React.ReactElement) | undefined,
  state: State,
): React.ReactElement {
  props = adaptEventProps(props);
  if (!render) return React.createElement(Primitive, props);
  const { children, ...outerProps } = props;
  const child = typeof render === "function"
    ? <RenderFunctionHost renderFunction={render as unknown as RenderFunction} renderState={state}>{children as React.ReactNode}</RenderFunctionHost>
    : children === undefined ? render : React.cloneElement(render, undefined, children as React.ReactNode);
  return React.createElement(Primitive, { ...outerProps, asChild: true }, child);
}

/** For shadcn's native button/span pattern: Slot performs ref/event composition. */
export function renderWithSlot<State>(
  tagName: React.ElementType,
  props: Record<string, unknown>,
  render: React.ReactElement | ((props: never, state: State) => React.ReactElement) | undefined,
  state: State,
): React.ReactElement {
  props = adaptEventProps(props);
  if (!render) return React.createElement(tagName, props);
  const { children, ...outerProps } = props;
  const child = typeof render === "function"
    ? <RenderFunctionHost renderFunction={render as unknown as RenderFunction} renderState={state}>{children as React.ReactNode}</RenderFunctionHost>
    : children === undefined ? render : React.cloneElement(render, undefined, children as React.ReactNode);
  return <Slot.Root {...outerProps}>{child}</Slot.Root>;
}

export function resolveStateValue<Value, State>(value: Value | ((state: State) => Value), state: State): Value {
  return typeof value === "function" ? (value as (state: State) => Value)(state) : value;
}

export function stateDataAttributes(state: object): Record<string, string | undefined> {
  const attributes: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value !== "boolean") continue;
    const name = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    attributes[`data-${name}`] = value ? "" : undefined;
  }
  if ("checked" in state && typeof state.checked === "boolean") attributes["data-unchecked"] = state.checked ? undefined : "";
  if ("open" in state && typeof state.open === "boolean") attributes["data-closed"] = state.open ? undefined : "";
  return attributes;
}

export function createChangeDetails<Reason extends string>(reason: Reason, event: Event = new Event("change")) {
  return {
    reason,
    event,
    trigger: event.target instanceof Element ? event.target : undefined,
    isCanceled: false,
    isPropagationAllowed: false,
    cancel() { this.isCanceled = true; },
    allowPropagation() { this.isPropagationAllowed = true; },
  };
}

/** Capture the real input event for T3's second callback argument. */
export function useInteractionEvent() {
  const event = React.useRef<Event | undefined>(undefined);
  return {
    event,
    capture: (next: React.SyntheticEvent) => { event.current = next.nativeEvent; },
  };
}

export function composeEventHandlers<EventType>(first: ((event: EventType) => void) | undefined, second: ((event: EventType) => void) | undefined) {
  return (event: EventType) => { first?.(event); second?.(event); };
}

/** Field state used by T3 render callbacks; native controls retain validation. */
export function useFieldState(value: unknown, disabled = false) {
  const initialValue = React.useRef(value);
  const [focused, setFocused] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  return {
    state: { disabled, focused, touched, dirty: value !== initialValue.current,
      filled: value !== undefined && value !== null && value !== "" && value !== false, valid: null as boolean | null },
    onFocus: () => setFocused(true),
    onBlur: () => { setFocused(false); setTouched(true); },
  };
}

export function compatibleEvent<E extends React.SyntheticEvent>(event: E): E & { preventBaseUIHandler: () => void; readonly baseUIHandlerPrevented?: boolean } {
  return Object.assign(event, { preventBaseUIHandler() { event.preventDefault(); } });
}

function adaptEventProps(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).map(([key, value]) => [key,
    /^on[A-Z]/.test(key) && typeof value === "function"
      ? (...args: unknown[]) => {
          const event = args[0];
          if (event && typeof event === "object" && "nativeEvent" in event && "preventDefault" in event) compatibleEvent(event as React.SyntheticEvent);
          return value(...args);
        }
      : value,
  ]));
}

export function mergeRefs<T>(refs: (React.Ref<T> | undefined)[]) {
  return (node: T | null) => {
    const cleanups = refs.map((ref) => typeof ref === "function" ? ref(node) : ref ? (ref.current = node, undefined) : undefined);
    return () => refs.forEach((ref, index) => {
      const cleanup = cleanups[index];
      if (typeof cleanup === "function") cleanup();
      else if (typeof ref === "function") ref(null);
      else if (ref) ref.current = null;
    });
  };
}

/** T3's native render helpers, composed using the same Slot pattern as shadcn. */
export function mergeProps<ElementType extends React.ElementType>(...sources: (Record<string, unknown> | undefined)[]): React.ComponentPropsWithRef<ElementType> & Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const source of sources) for (const [key, value] of Object.entries(source ?? {})) {
    const previous = result[key];
    if (key === "className") result[key] = [previous, value].filter(Boolean).join(" ");
    else if (key === "style") result[key] = { ...(previous as object), ...(value as object) };
    else if (key === "ref" && previous && value) result[key] = mergeRefs([previous as React.Ref<unknown>, value as React.Ref<unknown>]);
    else if (/^on[A-Z]/.test(key) && typeof previous === "function" && typeof value === "function") {
      result[key] = (...args: unknown[]) => { value(...args); if (!(args[0] as React.SyntheticEvent | undefined)?.defaultPrevented) previous(...args); };
    } else result[key] = value;
  }
  return result as React.ComponentPropsWithRef<ElementType> & Record<string, unknown>;
}

export const useRender: typeof BaseUseRender = ((params: BaseUseRender.Parameters<Record<string, unknown>, Element, boolean | undefined>) => {
  const state = params.state ?? {};
  const ref = React.useMemo(() => Array.isArray(params.ref) ? mergeRefs(params.ref as React.Ref<unknown>[]) : params.ref, [params.ref]);
  if (params.enabled === false) return null;
  const attributes = stateDataAttributes(state);
  for (const [key, mapper] of Object.entries(params.stateAttributesMapping ?? {})) {
    if (mapper) Object.assign(attributes, mapper(state[key]));
  }
  return renderWithSlot(params.defaultTagName ?? "div", { ...attributes, ...params.props, ...(ref ? { ref } : {}) }, params.render, state);
}) as typeof BaseUseRender;
