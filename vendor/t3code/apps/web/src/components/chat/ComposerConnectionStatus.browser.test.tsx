import "../../index.css";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";
import { Button } from "../ui/button";
import { ComposerActivityRow, useComposerSyncPhase } from "./ComposerActivityStatus";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import type { ThreadSyncPhase } from "../../threadSync";

function Status({
  phase = "syncing",
  banners = [],
  unavailable = false,
  target = "current-thread",
}: {
  phase?: ThreadSyncPhase | null;
  banners?: readonly ComposerBannerStackItem[];
  unavailable?: boolean;
  target?: string;
}) {
  const shown = useComposerSyncPhase(target, phase, banners, unavailable);
  return (
    <ComposerBannerStack
      items={
        shown
          ? [
              {
                id: "composer-activity",
                variant: "default",
                priority: "activity",
                content: <ComposerActivityRow phase={shown} />,
              },
              ...banners,
            ]
          : banners
      }
    />
  );
}

it.each([
  { width: 1280, dark: false },
  { width: 390, dark: true },
])(
  "$width px 连接提示立即接管同步条，不留下第二层背景，恢复后继续同步",
  async ({ width, dark }) => {
    const container = document.createElement("div");
    container.style.width = `${Math.min(width, 672)}px`;
    container.classList.toggle("dark", dark);
    await using screen = await render(<Status phase={null} />, { container });
    using _timers = fakeTimers();
    await screen.rerender(<Status />);
    await act(() => vi.advanceTimersByTimeAsync(400));
    await expect.element(page.getByRole("status")).toBeVisible();
    const banner: ComposerBannerStackItem = {
      id: "customer-connection",
      variant: "warning",
      replacesSync: true,
      icon: null,
      title: "客户设备离线，草稿保留；恢复连接后再发送。",
      actions: <Button>刷新</Button>,
    };
    await screen.rerender(<Status banners={[banner]} />);
    expect(container.querySelector("[data-composer-sync-status]")).toBeNull();
    expect(container.querySelector('[aria-label="显示其他通知"]')).toBeNull();
    await expect.element(page.getByRole("button", { name: "刷新", exact: true })).toBeVisible();
    await screen.rerender(<Status phase={null} />);
    expect(container.querySelector("[data-composer-sync-status]")).toBeNull();
    await screen.rerender(<Status />);
    await act(() => vi.advanceTimersByTimeAsync(400));
    await expect.element(page.getByRole("status")).toBeVisible();
    await screen.rerender(<Status phase={null} />);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(container.querySelector("[data-composer-sync-status]")).toBeNull();
  },
);

it("对话服务断线的宽限期也立即隐藏旧同步状态，切换会话不沿用旧提示", async () => {
  await using screen = await render(<Status phase={null} />);
  using _timers = fakeTimers();
  await screen.rerender(<Status phase="loading" />);
  await act(() => vi.advanceTimersByTimeAsync(400));
  await expect.element(page.getByRole("status")).toBeVisible();
  await screen.rerender(<Status phase={null} unavailable />);
  expect(screen.container.querySelector("[data-composer-sync-status]")).toBeNull();
  await screen.rerender(<Status target="another-thread" phase={null} />);
  await act(() => vi.advanceTimersByTimeAsync(800));
  expect(screen.container.querySelector("[data-composer-sync-status]")).toBeNull();
});

it("刷新动作保留，状态恢复后从连接提示切回同步，其他告警不吞掉同步", async () => {
  function Recovery() {
    const [offline, setOffline] = useState(true);
    return (
      <Status
        banners={
          offline
            ? [
                {
                  id: "customer-connection",
                  variant: "warning",
                  replacesSync: true,
                  icon: null,
                  title: "设备离线",
                  actions: <Button onClick={() => setOffline(false)}>刷新</Button>,
                },
              ]
            : [
                {
                  id: "independent-notice",
                  variant: "warning",
                  icon: null,
                  title: "需要处理的其他通知",
                },
              ]
        }
      />
    );
  }
  await using screen = await render(<Recovery />);
  await expect.element(page.getByText("设备离线", { exact: true })).toBeVisible();
  expect(screen.container.querySelector("[data-composer-sync-status]")).toBeNull();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect.element(page.getByText("设备离线", { exact: true })).not.toBeInTheDocument();
  await expect
    .poll(() => screen.container.querySelector("[data-composer-sync-status]") !== null)
    .toBe(true);
  await expect.element(page.getByText("需要处理的其他通知", { exact: true })).toBeVisible();
});

it("正常连接沿用中性状态语义，不展示警告或第二条同步进度", async () => {
  await using screen = await render(
    <Status
      banners={[
        {
          id: "customer-connection",
          variant: "default",
          replacesSync: true,
          icon: null,
          title: "正在读取客户运行器…",
        },
      ]}
    />,
  );
  await expect.element(page.getByRole("status")).toHaveTextContent("正在读取客户运行器…");
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  expect(screen.container.querySelector("[data-composer-sync-status]")).toBeNull();
  expect(screen.container.querySelector('[aria-label="显示其他通知"]')).toBeNull();
});
