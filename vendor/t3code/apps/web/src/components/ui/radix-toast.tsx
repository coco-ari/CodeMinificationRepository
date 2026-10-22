"use client";
// T3 keeps its toast rendering and thread visibility policy. Radix owns the
// accessible live region, focus, duration pause/resume, swipe and anchor geometry.
import * as React from "react";
import { flushSync } from "react-dom";
import { Toast as Primitive, Portal as PortalPrimitive } from "radix-ui";
import * as Popper from "@radix-ui/react-popper";
import type { Toast as BaseToast, ToastManager, ToastManagerAddOptions, ToastManagerUpdateOptions, ToastManagerPromiseOptions, ToastObject } from "@base-ui/react/toast";
import { randomUUID } from "~/lib/utils";
import { compatibleEvent, mergeRefs, renderWithPrimitive, renderWithSlot, resolveStateValue, stateDataAttributes } from "./radix-compat";

type RecordToast = ToastObject<Record<string, unknown>>;
type Direction = "left" | "right" | "up" | "down";
class ToastStore {
  toasts: RecordToast[] = [];
  listeners = new Set<() => void>();
  defaultTimeout = 5000;
  limit = 3;
  removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.toasts;
  publish() { for (const listener of this.listeners) listener(); }
  add(options: ToastManagerAddOptions<Record<string, unknown>>) {
    const id = options.id ?? randomUUID();
    const existing = this.toasts.find((toast) => toast.id === id);
    if (existing) { this.update(id, options); return id; }
    this.toasts = [{ ...options, id, updateKey: 0, transitionStatus: "starting", ref: React.createRef() }, ...this.toasts];
    this.publish();
    requestAnimationFrame(() => { this.toasts = this.toasts.map((toast) => toast.id === id && toast.transitionStatus === "starting" ? { ...toast, transitionStatus: undefined } : toast); this.publish(); });
    for (const toast of this.toasts.filter((item) => item.transitionStatus !== "ending").slice(this.limit)) this.close(toast.id);
    return id;
  }
  update(id: string, options: ToastManagerUpdateOptions<Record<string, unknown>>) {
    clearTimeout(this.removalTimers.get(id)); this.removalTimers.delete(id);
    const defined = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    this.toasts = this.toasts.map((toast) => toast.id === id ? { ...toast, ...defined, transitionStatus: undefined, updateKey: (toast.updateKey ?? 0) + 1 } : toast);
    this.publish();
  }
  close(id?: string) {
    const closing = this.toasts.filter((toast) => (!id || toast.id === id) && toast.transitionStatus !== "ending");
    if (!closing.length) return;
    for (const toast of closing) toast.onClose?.();
    this.toasts = this.toasts.map((toast) => closing.includes(toast) ? { ...toast, transitionStatus: "ending" } : toast);
    this.publish();
    for (const toast of closing) this.removalTimers.set(toast.id, setTimeout(() => {
      this.toasts = this.toasts.filter((item) => item.id !== toast.id); this.removalTimers.delete(toast.id); toast.onRemove?.(); this.publish();
    }, 500));
  }
  height(id: string, height: number) {
    if (this.toasts.find((toast) => toast.id === id)?.height === height) return;
    this.toasts = this.toasts.map((toast) => toast.id === id ? { ...toast, height } : toast); this.publish();
  }
}
const stores = new WeakMap<object, ToastStore>();
function createToastManager<Data extends object = Record<string, unknown>>(): ToastManager<Data> {
  const store = new ToastStore();
  const manager: ToastManager<Data> = {
    " subscribe": (listener) => store.subscribe(() => listener({ action: "update", options: store.toasts })),
    add: (options) => store.add(options as ToastManagerAddOptions<Record<string, unknown>>),
    update: (id, options) => store.update(id, options as ToastManagerUpdateOptions<Record<string, unknown>>),
    close: (id) => store.close(id),
    promise: async <Value, T extends Data = Data>(promise: Promise<Value>, options: ToastManagerPromiseOptions<Value, T>) => {
      const option = (value: string | ToastManagerUpdateOptions<T>) => typeof value === "string" ? { title: value } : value;
      const id = manager.add({ ...option(options.loading), type: "loading", timeout: 0 } as ToastManagerAddOptions<Data>);
      try { const value = await promise; manager.update(id, { timeout: store.defaultTimeout, ...option(typeof options.success === "function" ? options.success(value) : options.success), type: "success" } as ToastManagerUpdateOptions<Data>); return value; }
      catch (error) { manager.update(id, { timeout: store.defaultTimeout, ...option(typeof options.error === "function" ? options.error(error) : options.error), type: "error" } as ToastManagerUpdateOptions<Data>); throw error; }
    },
  };
  stores.set(manager, store); return manager;
}
const ManagerContext = React.createContext<{ manager: ToastManager; store: ToastStore; direction: Direction; setDirection: (direction: Direction) => void } | null>(null);
const ViewContext = React.createContext({ expanded: false });
const ToastContext = React.createContext<{ toast: RecordToast; state: BaseToast.Root.State } | null>(null);
function useManager() { const context = React.use(ManagerContext); if (!context) throw new Error("Toast requires ToastProvider"); return context; }
function useToast() { const context = React.use(ToastContext); if (!context) throw new Error("Toast content requires Toast.Root"); return context; }
function Provider({ toastManager, timeout = 5000, limit = 3, children }: BaseToast.Provider.Props) {
  const [local] = React.useState(() => createToastManager());
  const manager = toastManager ?? local;
  const store = stores.get(manager);
  if (!store) throw new Error("Use the local Radix toast manager");
  store.defaultTimeout = timeout; store.limit = limit;
  const [direction, setDirection] = React.useState<Direction>("right");
  return <ManagerContext value={{ manager, store, direction, setDirection }}><Primitive.Provider duration={timeout || Infinity} swipeDirection={direction}>{children}</Primitive.Provider></ManagerContext>;
}
function useToastManager<Data extends object>() {
  const { manager, store } = useManager();
  const toasts = React.useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return { ...manager, toasts: toasts as ToastObject<Data>[] };
}
function Viewport({ className, style, render, children, onPointerEnter, onPointerLeave, onFocusCapture, onBlurCapture, ...props }: BaseToast.Viewport.Props) {
  const [expanded, setExpanded] = React.useState(false);
  const state = { expanded };
  return renderWithPrimitive(Primitive.Viewport, {
    ...props, ...stateDataAttributes(state), className: resolveStateValue(className, state), style: resolveStateValue(style, state),
    onPointerEnter: (event: React.PointerEvent<HTMLDivElement>) => { onPointerEnter?.(compatibleEvent(event)); setExpanded(true); },
    onPointerLeave: (event: React.PointerEvent<HTMLDivElement>) => { onPointerLeave?.(compatibleEvent(event)); if (!event.currentTarget.contains(document.activeElement)) setExpanded(false); },
    onFocusCapture: (event: React.FocusEvent<HTMLDivElement>) => { onFocusCapture?.(compatibleEvent(event)); setExpanded(true); },
    onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => { onBlurCapture?.(compatibleEvent(event)); if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false); },
    children: <ViewContext value={state}>{children}</ViewContext>,
  }, render, state);
}
function Root({ toast, className, style, render, swipeDirection = ["down", "right"], ref, children, onPointerDownCapture, onPointerMoveCapture, ...props }: BaseToast.Root.Props) {
  const { manager, store, setDirection } = useManager();
  const { expanded } = React.use(ViewContext);
  const [element, setElement] = React.useState<HTMLDivElement | null>(null);
  const [swiping, setSwiping] = React.useState(false);
  const [swiped, setSwiped] = React.useState<Direction>();
  const origin = React.useRef<{ x: number; y: number } | null>(null);
  const references = React.useMemo(() => mergeRefs([ref, setElement, toast.ref as React.Ref<HTMLDivElement>]), [ref, toast.ref]);
  React.useEffect(() => {
    if (!element) return;
    const measure = () => { const previous = element.style.height; element.style.height = "auto"; const height = Math.ceil(element.getBoundingClientRect().height); element.style.height = previous; store.height(toast.id, height); };
    const observer = new ResizeObserver(measure); observer.observe(element);
    for (const child of element.children) observer.observe(child); measure();
    return () => observer.disconnect();
  }, [element, store, toast.id]);
  const state: BaseToast.Root.State = { expanded, limited: toast.limited ?? false, type: toast.type, transitionStatus: toast.transitionStatus, swiping, swipeDirection: swiped };
  const duration = toast.timeout ?? store.defaultTimeout;
  return renderWithPrimitive(Primitive.Root, {
    ...props, ...stateDataAttributes(state), ref: references, forceMount: true,
    key: toast.updateKey, open: toast.transitionStatus !== "ending", duration: duration === 0 ? Infinity : duration,
    type: toast.priority === "high" ? "foreground" : "background", onOpenChange: (open: boolean) => { if (!open) manager.close(toast.id); },
    "data-starting-style": toast.transitionStatus === "starting" ? "" : undefined, "data-ending-style": toast.transitionStatus === "ending" ? "" : undefined,
    "data-swipe-direction": swiped, "data-type": toast.type,
    className: resolveStateValue(className, state),
    style: { "--toast-height": `${toast.height ?? 0}px`, "--toast-swipe-movement-x": "var(--radix-toast-swipe-move-x, 0px)", "--toast-swipe-movement-y": "var(--radix-toast-swipe-move-y, 0px)", ...resolveStateValue(style, state) },
    onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => { onPointerDownCapture?.(compatibleEvent(event)); origin.current = { x: event.clientX, y: event.clientY }; const directions = Array.isArray(swipeDirection) ? swipeDirection : [swipeDirection]; setDirection(directions[0] ?? "right"); },
    onPointerMoveCapture: (event: React.PointerEvent<HTMLDivElement>) => { onPointerMoveCapture?.(compatibleEvent(event)); if (!origin.current || !event.buttons || swiping) return; const dx = event.clientX - origin.current.x, dy = event.clientY - origin.current.y; const direction = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? "left" : "right" : dy < 0 ? "up" : "down"; const allowed = Array.isArray(swipeDirection) ? swipeDirection : [swipeDirection]; if (allowed.includes(direction)) flushSync(() => setDirection(direction)); },
    onSwipeStart: () => setSwiping(true), onSwipeCancel: () => { setSwiping(false); origin.current = null; },
    onSwipeEnd: (event: CustomEvent<{ direction: Direction }>) => { setSwiped(event.detail.direction); setSwiping(false); manager.close(toast.id); },
    children: <ToastContext value={{ toast, state }}>{children}</ToastContext>,
  }, render, state);
}
function Content({ className, style, render, ...props }: BaseToast.Content.Props) {
  const { toast, state: root } = useToast(); const { store } = useManager();
  const state = { expanded: root.expanded, behind: store.toasts.findIndex((item) => item.id === toast.id) > 0 };
  return renderWithSlot("div", { ...props, ...stateDataAttributes(state), className: resolveStateValue(className, state), style: resolveStateValue(style, state) }, render, state);
}
function Title({ className, style, render, children, ...props }: BaseToast.Title.Props) {
  const { toast } = useToast(); const state = { type: toast.type };
  return renderWithPrimitive(Primitive.Title, { ...props, className: resolveStateValue(className, state), style: resolveStateValue(style, state), children: children ?? toast.title }, render, state);
}
function Description({ className, style, render, children, ...props }: BaseToast.Description.Props) {
  const { toast } = useToast(); const state = { type: toast.type };
  return renderWithPrimitive(Primitive.Description, { ...props, className: resolveStateValue(className, state), style: resolveStateValue(style, state), children: children ?? toast.description }, render, state);
}
function Action({ className, style, render, nativeButton: _nativeButton, ...props }: BaseToast.Action.Props) {
  const { toast } = useToast(); const state = { type: toast.type };
  return renderWithPrimitive(Primitive.Action, { ...toast.actionProps, ...props, altText: typeof toast.actionProps?.children === "string" ? toast.actionProps.children : "通知操作", className: resolveStateValue(className, state), style: resolveStateValue(style, state) }, render, state);
}
function Close({ className, style, render, nativeButton: _nativeButton, ...props }: BaseToast.Close.Props) {
  const { toast } = useToast(); const state = { type: toast.type };
  return renderWithPrimitive(Primitive.Close, { ...props, className: resolveStateValue(className, state), style: resolveStateValue(style, state) }, render, state);
}
function Positioner({ toast, children, ...props }: BaseToast.Positioner.Props) {
  const options = { ...toast.positionerProps, ...props };
  const { anchor, side = "top", align = "center", sideOffset = 0, alignOffset = 0, collisionBoundary, collisionPadding, className, style, render, ref } = options;
  const measurable = React.useMemo(() => ({ current: anchor ? { getBoundingClientRect: () => anchor.getBoundingClientRect() } : null }), [anchor]);
  const { direction } = useManager();
  const resolvedSide = side === "inline-start" ? "left" : side === "inline-end" ? "right" : side;
  const state = { side, align, anchorHidden: !anchor?.isConnected };
  return <Primitive.Provider swipeDirection={direction}><Popper.Root><Popper.Anchor virtualRef={measurable} />
    {renderWithPrimitive(Popper.Content, { ref, side: resolvedSide, align, sideOffset, alignOffset,
      collisionBoundary: collisionBoundary === "clipping-ancestors" ? undefined : collisionBoundary, collisionPadding,
      hideWhenDetached: true, "data-slot": "toast-positioner", className: resolveStateValue(className, state),
      style: { "--available-width": "var(--radix-popper-available-width)", "--available-height": "var(--radix-popper-available-height)", ...resolveStateValue(style, state) },
      children: <Primitive.Viewport style={{ display: "contents" }}>{children}</Primitive.Viewport>,
    }, render, state)}
  </Popper.Root></Primitive.Provider>;
}
export const Toast = { createToastManager, useToastManager, Provider, Viewport, Root, Content, Title, Description, Action, Close, Positioner, Portal: PortalPrimitive.Root, Arrow: Popper.Arrow } as unknown as typeof BaseToast;
