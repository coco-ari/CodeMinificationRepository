import { type ReactNode, useRef } from "react";

import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  animationDurationMs: number;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  keepMounted?: boolean;
  restoreFocus?: boolean;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        transitionDurationMs={props.animationDurationMs}
        side="right"
        showCloseButton={false}
        keepMounted={props.keepMounted ?? true}
        initialFocus={
          props.restoreFocus
            ? () => {
                opener.current =
                  document.activeElement instanceof HTMLElement ? document.activeElement : null;
                return undefined;
              }
            : undefined
        }
        finalFocus={
          props.restoreFocus
            ? () => {
                const active = document.activeElement;
                // 添加引用已主动回到输入框时，不再把焦点抢回历史文件按钮。
                if (
                  active instanceof HTMLElement &&
                  active !== document.body &&
                  active !== document.documentElement &&
                  !active.closest('[role="dialog"]')
                )
                  return active;
                return opener.current?.isConnected ? opener.current : false;
              }
            : undefined
        }
        className="w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
