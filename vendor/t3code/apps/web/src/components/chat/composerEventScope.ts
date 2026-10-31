import type { RefObject } from "react";
import { useComposerHandleContext } from "../../composerHandleContext";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-composer-drawer-layer="true"]',
  '[data-chat-composer-floating-layer="true"]',
].join(",");

export const composerFloatingLayerProps = {
  "data-chat-composer-floating-layer": "true",
} as const;

export function useComposerMenuProps(trigger?: RefObject<HTMLElement | null>) {
  const composerRef = useComposerHandleContext();

  return {
    ...composerFloatingLayerProps,
    finalFocus: composerRef || trigger
      ? () => {
          const activeElement = document.activeElement;
          // 相邻菜单已打开时保留其焦点，旧菜单关闭不能把焦点拉回输入框。
          const activeLayer = activeElement?.closest(COMPOSER_FLOATING_LAYER_SELECTOR);
          if (
            activeLayer?.id &&
            document.querySelector(
              `[aria-controls="${CSS.escape(activeLayer.id)}"][aria-expanded="true"]`,
            )
          ) return false;
          if (activeElement !== document.body && !isInsideComposerFloatingLayer(activeElement)) {
            return false;
          }
          if (composerRef) {
            composerRef.current?.focusAtEnd();
            return false;
          }
          trigger?.current?.focus({ preventScroll: true });
          return false;
        }
      : undefined,
  };
}

export function isInsideComposerFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

export function isInsideCollapsedComposerControls(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-chat-composer-collapsed-controls="true"]') !== null
  );
}

export function isInsideRestingComposerControlScope(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.closest('[data-chat-composer-resting-controls="true"]') !== null ||
      target.closest('[data-chat-composer-resting-images="true"]') !== null ||
      target.closest("[data-composer-context-control]") !== null ||
      isInsideComposerFloatingLayer(target))
  );
}
