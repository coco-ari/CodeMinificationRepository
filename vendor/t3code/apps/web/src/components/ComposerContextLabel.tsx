import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./chat/threadDetailsPanelStyles";

export function ComposerContextLabel({
  children,
  displayMode = "toolbar",
  compactBehavior = "hide",
}: {
  children: ReactNode;
  displayMode?: "toolbar" | "panel";
  compactBehavior?: "hide" | "truncate";
}) {
  return (
    <span
      data-composer-label
      className={cn(
        "min-w-0",
        displayMode === "panel"
          ? "flex-1 overflow-x-clip overflow-y-visible text-left"
          : compactBehavior === "truncate"
            ? "max-w-24 sm:max-w-40"
            : "max-w-[240px] group-data-[compact]/composer-context:max-w-0",
      )}
    >
      <span
        data-composer-label-motion
        className={cn(
          "block w-full min-w-0 truncate",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LABEL_CLASS,
          displayMode === "toolbar" &&
            (compactBehavior === "truncate"
              ? "max-w-24 sm:max-w-40"
              : "max-w-[240px] transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"),
        )}
      >
        {children}
      </span>
    </span>
  );
}
