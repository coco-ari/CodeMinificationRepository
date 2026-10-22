import type { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import { PreviewCardAdapter as PreviewCardPrimitiveRuntime } from "./radix-overlays";

import { cn } from "~/lib/utils";

const PreviewCard = PreviewCardPrimitiveRuntime.Root;

function PreviewCardTrigger(props: PreviewCardPrimitive.Trigger.Props) {
  return <PreviewCardPrimitiveRuntime.Trigger data-slot="preview-card-trigger" {...props} />;
}

function PreviewCardPopup({
  className,
  align = "start",
  side = "top",
  sideOffset = 6,
  ...props
}: PreviewCardPrimitive.Popup.Props & {
  align?: PreviewCardPrimitive.Positioner.Props["align"];
  side?: PreviewCardPrimitive.Positioner.Props["side"];
  sideOffset?: PreviewCardPrimitive.Positioner.Props["sideOffset"];
}) {
  return (
    <PreviewCardPrimitiveRuntime.Portal>
      <PreviewCardPrimitiveRuntime.Positioner
        align={align}
        className="z-[140] max-w-(--available-width)"
        data-slot="preview-card-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PreviewCardPrimitiveRuntime.Popup
          className={cn(
            "origin-(--transform-origin) rounded-lg border bg-popover text-popover-foreground shadow-lg outline-none transition-[scale,opacity] data-[state=closed]:scale-98 data-[state=closed]:scale-98 data-[state=closed]:opacity-0 data-[state=closed]:opacity-0",
            className,
          )}
          data-slot="preview-card-popup"
          {...props}
        />
      </PreviewCardPrimitiveRuntime.Positioner>
    </PreviewCardPrimitiveRuntime.Portal>
  );
}

export { PreviewCard, PreviewCardPopup, PreviewCardTrigger };
