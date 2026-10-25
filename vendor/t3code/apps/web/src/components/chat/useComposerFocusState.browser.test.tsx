import { useLayoutEffect, useRef } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { shouldUseRestingComposerLayout } from "../composerFooterLayout";
import { useComposerFocusState } from "./useComposerFocusState";

let composer: ReturnType<typeof useComposerFocusState>;
let isResting: boolean;

function ComposerProbe() {
  const state = useComposerFocusState();
  useLayoutEffect(() => {
    composer = state;
    isResting = shouldUseRestingComposerLayout({
      isExistingThread: true,
      isMobileViewport: false,
      isScrollCollapsed: state.isComposerScrollCollapsed,
      hasExpandedChrome: false,
      hasMultilinePrompt: false,
      timelineOverflows: true,
    });
  });
  return null;
}

describe("composer focus state", () => {
  it("恢复输入时先展开编辑器，再执行一次聚焦", async () => {
    let controls: ReturnType<typeof useComposerFocusState>;
    const visibleAtFocus: boolean[] = [];
    function CollapsedComposer() {
      const state = useComposerFocusState();
      const input = useRef<HTMLInputElement>(null);
      useLayoutEffect(() => {
        controls = state;
      });
      return (
        <>
          <input ref={input} hidden={!state.isComposerFocused} aria-label="消息" />
          <button
            onClick={() =>
              state.requestExpandedFocus(() => {
                visibleAtFocus.push(!!input.current?.getClientRects().length);
                input.current?.focus();
              })
            }
          >
            返回输入
          </button>
        </>
      );
    }
    await using screen = await render(<CollapsedComposer />);
    await screen.getByRole("button", { name: "返回输入" }).click();
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toHaveFocus();
    expect(visibleAtFocus).toEqual([true]);
    await act(() => controls.setIsComposerScrollCollapsed(true));
    expect(visibleAtFocus).toEqual([true]);
  });
  it("stays expanded when the composer loses focus", async () => {
    await using _screen = await render(<ComposerProbe />);
    await act(() => composer.setIsComposerFocused(true));
    expect(isResting).toBe(false);

    await act(() => composer.setIsComposerFocused(false));
    expect(isResting).toBe(false);
  });

  it("can collapse again on the next scroll after returning to the end", async () => {
    await using _screen = await render(<ComposerProbe />);
    await act(() => composer.setIsComposerScrollCollapsed(true));
    expect(isResting).toBe(true);

    await act(() => composer.restoreAfterTimelineReachedEnd());
    expect(isResting).toBe(false);

    await act(() => composer.setIsComposerScrollCollapsed(true));
    expect(isResting).toBe(true);
  });

  it("does not move focus into the composer when the timeline reaches the end", async () => {
    await using _screen = await render(<ComposerProbe />);
    await act(() => composer.setIsComposerScrollCollapsed(true));
    await act(() => composer.restoreAfterTimelineReachedEnd());
    expect(isResting).toBe(false);
    expect(composer.isComposerFocused).toBe(false);
  });
});
