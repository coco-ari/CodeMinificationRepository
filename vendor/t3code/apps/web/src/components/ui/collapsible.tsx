"use client";

import type { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import { Collapsible as Primitive } from "radix-ui";
import * as React from "react";
import { cn } from "~/lib/utils";
import { composeEventHandlers, createChangeDetails, mergeRefs, renderWithPrimitive, resolveStateValue,
  stateDataAttributes, useControllableState, useInteractionEvent } from "./radix-compat";
import "./collapsible.css";

const Context = React.createContext({ open: false, disabled: false, reveal: (_event: Event) => {} });
function Collapsible({ open: controlled, defaultOpen = false, onOpenChange, disabled = false,
  className, style, render, children, onClickCapture, onKeyDownCapture, ...props }: BaseCollapsible.Root.Props) {
  const [open, setOpen] = useControllableState({ prop: controlled, defaultProp: defaultOpen, caller: "T3Collapsible" });
  const interaction = useInteractionEvent();
  const state = { open, disabled, transitionStatus: undefined };
  const update = (next: boolean, event: Event | undefined) => {
    const details = createChangeDetails("none", event);
    onOpenChange?.(next, details);
    if (!details.isCanceled) setOpen(next);
  };
  return renderWithPrimitive(Primitive.Root, {
    ...props, ...stateDataAttributes(state), open, disabled, "data-slot": "collapsible",
    className: resolveStateValue(className, state), style: resolveStateValue(style, state),
    onClickCapture: composeEventHandlers(onClickCapture, interaction.capture),
    onKeyDownCapture: composeEventHandlers(onKeyDownCapture, interaction.capture),
    onOpenChange: (next: boolean) => update(next, interaction.event.current),
    children: <Context value={{ open, disabled, reveal: (event) => update(true, event) }}>{children}</Context>,
  }, render, state);
}

function CollapsibleTrigger({ className, style, render, nativeButton: _nativeButton, ...props }: BaseCollapsible.Trigger.Props) {
  const context = React.use(Context);
  const state = { open: context.open, disabled: context.disabled, transitionStatus: undefined };
  return renderWithPrimitive(Primitive.Trigger, {
    ...props, ...stateDataAttributes(state), "data-slot": "collapsible-trigger",
    className: cn("cursor-pointer", resolveStateValue(className, state)), style: resolveStateValue(style, state),
  }, render, state);
}

function CollapsiblePanel({ className, style, render, animate = true, hiddenUntilFound = false,
  keepMounted = false, ref, ...props }: BaseCollapsible.Panel.Props & { animate?: boolean }) {
  const context = React.use(Context);
  const [element, setElement] = React.useState<HTMLDivElement | null>(null);
  const mergedRef = React.useMemo(() => mergeRefs([ref, setElement]), [ref]);
  const state = { open: context.open, disabled: context.disabled, transitionStatus: undefined };
  React.useLayoutEffect(() => {
    if (!element || !hiddenUntilFound) return;
    // React treats hidden as boolean; preserve the platform find-in-page value on the DOM.
    if (!context.open) element.setAttribute("hidden", "until-found");
    else element.removeAttribute("hidden");
    element.addEventListener("beforematch", context.reveal);
    return () => element.removeEventListener("beforematch", context.reveal);
  }, [element, hiddenUntilFound, context.open, context.reveal]);
  return renderWithPrimitive(Primitive.Content, {
    ...props, ...stateDataAttributes(state), ref: mergedRef,
    forceMount: keepMounted || hiddenUntilFound || undefined,
    ...((keepMounted || hiddenUntilFound) && !context.open ? { hidden: hiddenUntilFound ? "until-found" : true } : {}),
    className: cn("overflow-hidden", animate && "t3-radix-collapsible-panel", resolveStateValue(className, state)),
    "data-slot": "collapsible-panel",
    style: { "--collapsible-panel-height": "var(--radix-collapsible-content-height)", ...resolveStateValue(style, state) },
  }, render, state);
}

export { Collapsible, CollapsibleTrigger, CollapsiblePanel, CollapsiblePanel as CollapsibleContent };
