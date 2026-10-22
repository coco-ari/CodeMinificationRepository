"use client";

import type { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import * as React from "react";
import { renderWithPrimitive, resolveStateValue, stateDataAttributes } from "./radix-compat";

import { cn } from "~/lib/utils";

function getVirtualizedScrollFadeClassName({ top, bottom }: { top: boolean; bottom: boolean }) {
  if (!top && !bottom) return undefined;

  return cn(
    "virtualized-scroll-fade [--fade-size:1.5rem]",
    top &&
      bottom &&
      "[--virtualized-scroll-fade-mask:linear-gradient(to_bottom,transparent,black_var(--fade-size),black_calc(100%-var(--fade-size)),transparent)]",
    top &&
      !bottom &&
      "[--virtualized-scroll-fade-mask:linear-gradient(to_bottom,transparent,black_var(--fade-size))]",
    !top &&
      bottom &&
      "[--virtualized-scroll-fade-mask:linear-gradient(to_bottom,black_calc(100%-var(--fade-size)),transparent)]",
  );
}

const initialState: BaseScrollArea.Root.State = { scrolling: false, hasOverflowX: false, hasOverflowY: false, overflowXStart: false, overflowXEnd: false, overflowYStart: false, overflowYEnd: false, cornerHidden: true };
const ScrollState = React.createContext(initialState);

function ScrollArea({
  className, style, render, overflowEdgeThreshold = 0,
  children,
  scrollFade = false,
  scrollFadePadding = true,
  scrollbarGutter = false,
  hideScrollbars = false,
  chainVerticalScroll = false,
  radius = "inherit",
  viewportTabIndex,
  contentSizing = "auto",
  ...props
}: BaseScrollArea.Root.Props & {
  scrollFade?: boolean;
  scrollFadePadding?: boolean;
  scrollbarGutter?: boolean;
  hideScrollbars?: boolean;
  chainVerticalScroll?: boolean;
  radius?: "inherit" | "none";
  viewportTabIndex?: number;
  /** Vertical lists constrain content to their viewport; horizontal surfaces retain intrinsic sizing. */
  contentSizing?: "auto" | "viewport";
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState(initialState);
  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const threshold = (edge: "xStart" | "xEnd" | "yStart" | "yEnd") => typeof overflowEdgeThreshold === "number" ? overflowEdgeThreshold : overflowEdgeThreshold[edge] ?? 0;
    const measure = (scrolling = false) => {
      const x = Math.abs(viewport.scrollLeft), y = Math.max(0, viewport.scrollTop);
      const maxX = Math.max(0, viewport.scrollWidth - viewport.clientWidth), maxY = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      for (const [edge, value] of Object.entries({ "x-start": x, "x-end": maxX - x, "y-start": y, "y-end": maxY - y })) viewport.style.setProperty(`--scroll-area-overflow-${edge}`, `${Math.max(0, value)}px`);
      const next = { scrolling, hasOverflowX: maxX > 0, hasOverflowY: maxY > 0, overflowXStart: x > threshold("xStart"), overflowXEnd: maxX - x > threshold("xEnd"), overflowYStart: y > threshold("yStart"), overflowYEnd: maxY - y > threshold("yEnd"), cornerHidden: maxX === 0 || maxY === 0 };
      // Render only at overflow-edge transitions; streamed content does not rerender per pixel.
      setState((previous) => Object.keys(next).every((key) => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    const onScroll = () => { measure(true); clearTimeout(timer); timer = setTimeout(() => measure(false), 120); };
    const observer = new ResizeObserver(() => measure());
    observer.observe(viewport);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    viewport.addEventListener("scroll", onScroll, { passive: true }); measure();
    return () => { observer.disconnect(); viewport.removeEventListener("scroll", onScroll); clearTimeout(timer); };
  }, [overflowEdgeThreshold]);
  return renderWithPrimitive(ScrollAreaPrimitive.Root, {
    ...props, ...stateDataAttributes(state),
    className: cn("relative size-full min-h-0 overflow-hidden", radius === "none" ? "rounded-none" : "rounded-[inherit]", resolveStateValue(className, state)),
    style: resolveStateValue(style, state),
    children: <ScrollState value={state}>
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        disableImplicitContentElement={contentSizing === "viewport"}
        {...stateDataAttributes(state)}
        {...(viewportTabIndex === undefined ? {} : { tabIndex: viewportTabIndex })}
        className={cn(
          "h-full max-h-[inherit] overflow-auto overscroll-contain rounded-[inherit] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-has-overflow-x:overscroll-x-contain",
          chainVerticalScroll && "overscroll-y-auto",
          scrollFade &&
            "mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] focus-visible:mask-none [--fade-size:1.5rem]",
          scrollFade && scrollFadePadding && "scroll-p-[var(--fade-size)]",
          scrollFade && !scrollFadePadding && "has-focus-visible:mask-none",
          scrollbarGutter && "scrollbar-gutter-stable",
          hideScrollbars &&
            "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
        data-slot="scroll-area-viewport"
      >
        {contentSizing === "viewport" ? (
          <ScrollAreaPrimitive.Content
            data-slot="scroll-area-content"
            style={{ display: "block", width: "100%", minWidth: 0 }}
          >
            {children}
          </ScrollAreaPrimitive.Content>
        ) : children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar orientation="vertical" className={hideScrollbars ? "hidden" : undefined} />
      <ScrollBar orientation="horizontal" className={hideScrollbars ? "hidden" : undefined} />
      {!hideScrollbars && <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />}
    </ScrollState>,
  }, render, state);
}

function ScrollBar({
  className, style, render, keepMounted,
  orientation = "vertical",
  ...props
}: BaseScrollArea.Scrollbar.Props) {
  const root = React.use(ScrollState);
  const state = { ...root, hovering: false, orientation };
  return renderWithPrimitive(ScrollAreaPrimitive.Scrollbar, {
    ...props, ...stateDataAttributes(state), orientation, forceMount: keepMounted || undefined,
    className: cn(
      "flex opacity-0 transition-opacity delay-300 data-[orientation=horizontal]:mx-1 data-[orientation=horizontal]:mb-px data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:my-1 data-[orientation=vertical]:mr-px data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:flex-col data-[state=visible]:opacity-100 data-scrolling:opacity-100 data-[state=visible]:delay-0 data-scrolling:delay-0 data-[state=visible]:duration-100 data-scrolling:duration-100",
      resolveStateValue(className, state)),
    style: resolveStateValue(style, state), "data-slot": "scroll-area-scrollbar",
    children: <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-[var(--app-scrollbar-thumb)] transition-colors hover:bg-[var(--app-scrollbar-thumb-hover)]" data-slot="scroll-area-thumb" />,
  }, render, state);
}

export { getVirtualizedScrollFadeClassName, ScrollArea, ScrollBar };
