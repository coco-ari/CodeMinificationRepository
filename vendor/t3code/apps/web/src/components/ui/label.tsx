"use client";

import type { useRender } from "@base-ui/react/use-render";

import { cn } from "~/lib/utils";
import { renderWithSlot } from "./radix-compat";

function Label({ className, render, ...props }: useRender.ComponentProps<"label">) {
  const defaultProps = {
    className: cn(
      "inline-flex items-center gap-2 text-base/4.5 sm:text-sm/4 font-medium text-foreground",
      className,
    ),
    "data-slot": "label",
    "data-ui": "label",
  };

  return renderWithSlot("label", { ...defaultProps, ...props }, render, {});
}

export { Label };
