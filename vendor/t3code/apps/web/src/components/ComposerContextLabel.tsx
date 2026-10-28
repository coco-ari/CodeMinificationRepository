import type { CSSProperties, ReactNode } from "react";

import { cn } from "../lib/utils";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./chat/threadDetailsPanelStyles";

export function ComposerContextLabel({
  children,
  displayMode = "toolbar",
  reservedWidth,
}: {
  children: ReactNode;
  displayMode?: "toolbar" | "panel";
  reservedWidth?: number;
}) {
  return (
    <span
      data-composer-label
      data-composer-label-fixed={reservedWidth !== undefined ? "" : undefined}
      style={
        reservedWidth === undefined
          ? undefined
          : ({ "--composer-label-width": `${reservedWidth}rem` } as CSSProperties)
      }
      className={cn(
        "min-w-0",
        reservedWidth !== undefined && "w-(--composer-label-width) shrink-0",
        displayMode === "panel"
          ? "flex-1 overflow-x-clip overflow-y-visible text-left"
          : reservedWidth !== undefined
            ? "max-w-(--composer-label-width) group-data-[compact]/composer-context:max-w-0"
            : "max-w-[240px] group-data-[compact]/composer-context:max-w-0",
      )}
    >
      <span
        data-composer-label-motion
        className={cn(
          "block w-full min-w-0 truncate",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LABEL_CLASS,
          displayMode === "toolbar" &&
            "transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none",
          displayMode === "toolbar" &&
            (reservedWidth !== undefined ? "max-w-(--composer-label-width)" : "max-w-[240px]"),
        )}
      >
        {children}
      </span>
    </span>
  );
}
