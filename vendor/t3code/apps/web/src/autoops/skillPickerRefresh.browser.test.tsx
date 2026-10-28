import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import { useProviderWorkspaceSnapshotRefresh } from "../components/chat/useProviderWorkspaceSnapshotRefresh";
import { ComposerCommandMenu } from "../components/chat/ComposerCommandMenu";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock(import("../state/use-atom-command"), () => ({ useAtomCommand: () => mocks.refresh }));

const instanceId = ProviderInstanceId.make("isolated-model");
const cwd = "autoops/skill-context/scope-one";
function provider(directory?: string): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "隔离模型服务",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models: [],
    skills: [],
    slashCommands: [],
    workspaceSnapshots: directory
      ? [{ cwd: directory, checkedAt: new Date().toISOString(), skills: [], slashCommands: [] }]
      : [],
  };
}
const success = (directory?: string) => ({
  _tag: "Success",
  value: { providers: [provider(directory)] },
});
function setup() {
  mocks.refresh.mockReset();
  mocks.refresh.mockResolvedValue(success());
}
function Probe({
  directory = cwd,
  status = null,
}: {
  directory?: string | null;
  status?: ServerProvider | null;
}) {
  const state = useProviderWorkspaceSnapshotRefresh({
    environmentId: EnvironmentId.make("isolated-environment"),
    gitCwd: directory,
    instanceId,
    selectedProviderStatus: status,
  });
  return (
    <>
      <output>{state.isRefreshing ? "正在读取skill…" : (state.error ?? "已完成")}</output>
      <ComposerCommandMenu
        listId="skills"
        items={[]}
        resolvedTheme="light"
        isLoading={state.isRefreshing}
        triggerKind="skill"
        error={state.error}
        onRetry={state.retry}
        activeItemId={null}
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />
      <button onClick={() => state.refreshIfStale()}>输入</button>
      <button onClick={state.retry}>重新扫描</button>
    </>
  );
}
// 本测试仅驱动目录 Hook 与原生候选菜单，不依赖路由。
const options = { router: false } as const;
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("skill目录读取恢复", () => {
  it("没有快照时也自动重试，而不是等用户再次输入", async () => {
    setup();
    using timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mocks.refresh.mockResolvedValueOnce(success()).mockResolvedValueOnce(success(cwd));
    await using screen = await render(<Probe />, options);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.container.querySelector("output")?.textContent).toBe("正在读取skill…");
    await advance(10_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(screen.container.querySelector("output")?.textContent).toBe("已完成");
    await advance(30_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it("持续缺失目录在总时限后失败，停止后台重试", async () => {
    setup();
    using timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await using screen = await render(<Probe />, options);
    await advance(30_000);
    expect(screen.container.querySelector("output")?.textContent).toBe("skill加载失败，请重试。");
    expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain("重试");
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
    await advance(120_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
  });

  it("请求挂起仍有时限，一键重试成功后忽略旧请求失败", async () => {
    setup();
    using timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let reject!: (cause: Error) => void;
    mocks.refresh.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    await using screen = await render(<Probe />, options);
    await advance(30_000);
    mocks.refresh.mockResolvedValue(success(cwd));
    await act(() =>
      (screen.container.querySelector('[role="alert"] button') as HTMLButtonElement).click(),
    );
    expect(mocks.refresh.mock.calls[1]?.[0].input.fresh).toBe(true);
    expect(screen.container.querySelector("output")?.textContent).toBe("已完成");
    await act(() => reject(new Error("迟到的网络失败")));
    await advance(30_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(screen.container.querySelector("output")?.textContent).toBe("已完成");
  });

  it("原生目录确认为空时结束等待，允许主动重新扫描", async () => {
    setup();
    using timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const empty = provider(cwd);
    await using screen = await render(<Probe status={empty} />, options);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(screen.container.querySelector("output")?.textContent).toBe("已完成");
    mocks.refresh.mockResolvedValue(success(cwd));
    await act(() => (screen.container.querySelectorAll("button")[1] as HTMLButtonElement).click());
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh.mock.calls[0]?.[0].input.fresh).toBe(true);
  });

  it("切范围后旧响应不结束新范围等待，也不触发旧范围重试", async () => {
    setup();
    using timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let deliver!: (value: ReturnType<typeof success>) => void;
    mocks.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    await using screen = await render(<Probe />, options);
    await screen.rerender(<Probe directory="autoops/skill-context/scope-two" />);
    await act(() => deliver(success(cwd)));
    expect(screen.container.querySelector("output")?.textContent).toBe("正在读取skill…");
    await advance(10_000);
    expect(mocks.refresh.mock.calls.map(([call]) => call.input.cwd)).toEqual([
      cwd,
      "autoops/skill-context/scope-two",
      "autoops/skill-context/scope-two",
    ]);
    await screen.rerender(<Probe directory={null} />);
    await advance(40_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
    expect(screen.container.querySelector("output")?.textContent).toBe("已完成");
  });

  it("服务器移除已有快照后重新读取，原 TTL 不阻止恢复", async () => {
    setup();
    using timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mocks.refresh.mockResolvedValue(success(cwd));
    await using screen = await render(<Probe status={provider(cwd)} />, options);
    await screen.rerender(<Probe status={provider()} />);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.container.querySelector("output")?.textContent).toBe("已完成");
  });

  it("网络恢复后重新读取，卸载清理后不再重试", async () => {
    setup();
    using timers = fakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await using screen = await render(<Probe />, options);
    await advance(30_000);
    await act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(4);
    await screen.unmount();
    await advance(60_000);
    await act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(4);
  });
});
