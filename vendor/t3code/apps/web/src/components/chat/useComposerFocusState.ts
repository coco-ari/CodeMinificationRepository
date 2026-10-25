import { useLayoutEffect, useRef, useState } from "react";

export function useComposerFocusState() {
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isComposerScrollCollapsed, setIsComposerScrollCollapsed] = useState(false);
  const pendingFocus = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    if (!isComposerFocused || !pendingFocus.current) return;
    const focus = pendingFocus.current;
    pendingFocus.current = null;
    focus();
  });

  const requestExpandedFocus = (focus: () => void) => {
    if (isComposerFocused) {
      focus();
      return;
    }
    // 关闭面板后的帧回调可能早于布局提交，展开完成后才能聚焦隐藏的编辑器。
    pendingFocus.current = focus;
    setIsComposerFocused(true);
  };

  const restoreAfterTimelineReachedEnd = () => {
    setIsComposerScrollCollapsed(false);
  };

  return {
    isComposerFocused,
    setIsComposerFocused,
    isComposerScrollCollapsed,
    setIsComposerScrollCollapsed,
    restoreAfterTimelineReachedEnd,
    requestExpandedFocus,
  };
}
