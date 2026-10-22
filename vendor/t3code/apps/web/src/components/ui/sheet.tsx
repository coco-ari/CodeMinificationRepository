import type { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
"use client";

import { DialogAdapter as SheetPrimitiveRuntime } from "./radix-overlays";
import { XIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

const Sheet = SheetPrimitiveRuntime.Root;

const SheetPortal = SheetPrimitiveRuntime.Portal;

function SheetBackdrop({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitiveRuntime.Backdrop
      className={cn(
        "fixed inset-0 z-(--z-sheet) bg-background/60 backdrop-blur-xs transition-all duration-200 data-[state=closed]:opacity-0 data-[state=closed]:opacity-0",
        className,
      )}
      data-slot="sheet-backdrop"
      {...props}
    />
  );
}

function SheetViewport({
  className,
  side,
  variant = "default",
  ...props
}: SheetPrimitive.Viewport.Props & {
  side?: "right" | "left" | "top" | "bottom";
  variant?: "default" | "inset";
}) {
  return (
    <SheetPrimitiveRuntime.Viewport
      className={cn(
        "fixed inset-0 z-(--z-sheet) grid",
        side === "bottom" && "grid grid-rows-[1fr_auto] pt-12",
        side === "top" && "grid grid-rows-[auto_1fr] pb-12",
        side === "left" && "flex justify-start",
        side === "right" && "flex justify-end",
        variant === "inset" && "sm:p-4",
        className,
      )}
      data-slot="sheet-viewport"
      {...props}
    />
  );
}

function SheetPopup({
  className,
  children,
  showCloseButton = true,
  keepMounted = false,
  transitionDurationMs,
  side = "right",
  variant = "default",
  style,
  ...props
}: SheetPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  keepMounted?: boolean;
  transitionDurationMs?: number;
  side?: "right" | "left" | "top" | "bottom";
  variant?: "default" | "inset";
}) {
  const transitionStyle =
    transitionDurationMs === undefined
      ? undefined
      : ({ transitionDuration: `${transitionDurationMs}ms` } satisfies CSSProperties);
  const instant = transitionDurationMs === 0;

  return (
    <SheetPortal keepMounted={keepMounted}>
      <SheetBackdrop
        className={
          instant
            ? "transition-none! data-[state=closed]:opacity-100! data-[state=closed]:opacity-100!"
            : undefined
        }
        style={transitionStyle}
      />
      <SheetViewport side={side} variant={variant}>
        <SheetPrimitiveRuntime.Popup
          className={cn(
            "relative flex max-h-full min-h-0 w-full min-w-0 flex-col bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 transition-[opacity,translate] duration-200 ease-in-out will-change-transform before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_--theme(--color-black/4%)] data-[state=closed]:opacity-0 data-[state=closed]:opacity-0 max-sm:before:hidden dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            side === "bottom" &&
              "row-start-2 border-t data-[state=closed]:translate-y-8 data-[state=closed]:translate-y-8",
            side === "top" &&
              "data-[state=closed]:-translate-y-8 data-[state=closed]:-translate-y-8 border-b",
            side === "left" &&
              "data-[state=closed]:-translate-x-8 data-[state=closed]:-translate-x-8 w-[calc(100%-(--spacing(12)))] max-w-md border-e",
            side === "right" &&
              "col-start-2 w-[calc(100%-(--spacing(12)))] max-w-md border-s data-[state=closed]:translate-x-8 data-[state=closed]:translate-x-8",
            variant === "inset" &&
              "before:hidden sm:rounded-2xl sm:border sm:before:rounded-[calc(var(--radius-2xl)-1px)] sm:**:data-[slot=sheet-footer]:rounded-b-[calc(var(--radius-2xl)-1px)]",
            instant &&
              "transition-none! will-change-auto! data-[state=closed]:translate-x-0! data-[state=closed]:translate-x-0! data-[state=closed]:translate-y-0! data-[state=closed]:translate-y-0! data-[state=closed]:opacity-100! data-[state=closed]:opacity-100!",
            className,
          )}
          data-slot="sheet-popup"
          style={{ ...transitionStyle, ...style }}
          {...props}
        >
          {children}
          {showCloseButton && (
            <SheetPrimitiveRuntime.Close
              aria-label="关闭"
              className="absolute end-2 top-2"
              render={<Button size="icon" variant="ghost" />}
            >
              <XIcon />
            </SheetPrimitiveRuntime.Close>
          )}
        </SheetPrimitiveRuntime.Popup>
      </SheetViewport>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pb-3 max-sm:pb-4",
        className,
      )}
      data-slot="sheet-header"
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitiveRuntime.Title
      className={cn("font-semibold text-xl leading-none", className)}
      data-slot="sheet-title"
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitiveRuntime.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="sheet-description"
      {...props}
    />
  );
}

export {
  Sheet,
  SheetPortal,
  SheetBackdrop,
  SheetBackdrop as SheetOverlay,
  SheetPopup,
  SheetPopup as SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
};
