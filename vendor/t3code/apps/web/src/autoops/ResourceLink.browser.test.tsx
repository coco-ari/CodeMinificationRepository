import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import ChatMarkdown from "~/components/ChatMarkdown";
import { chatMarkdownClipboardPayload } from "~/markdown-clipboard";
import { useRightPanelStore } from "~/rightPanelStore";
import { autoOpsResourceAttachmentId, autoOpsResourceUrl } from "./resources";
import "../index.css";

const state = vi.hoisted(() => ({
  customer: false,
  theme: "light" as "light" | "dark",
  read: vi.fn(),
  command: vi.fn(),
  toast: vi.fn(),
  openFile: vi.fn(),
  openAttachment: vi.fn(),
}));
vi.mock(import("./hostConfig"), async (original) => ({
  ...(await original()),
  readAutoOpsHost: () =>
    ({
      principal: { id: "isolated-file-reader", displayName: "隔离文件用户" },
      httpBaseUrl: `${location.origin}/api/agent-demo/t3`,
      gatewayBasePath: "/api/agent-demo/t3",
    }) as never,
}));
vi.mock(import("./useThreadScope"), async (original) => ({
  ...(await original()),
  useAutoOpsThreadScope: (() =>
    state.customer ? { executionBinding: { kind: "customer" } } : undefined) as never,
}));
vi.mock(import("../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useRenderedAppearance: () => state.theme,
}));
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: (() => state.read) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.command) as never,
}));
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
// 文件呈现测试没有连接目标，阻止公共运行时按浏览器地址发起环境发现。
vi.mock(import("../environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));
vi.mock(import("../components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

const threadRef = {
  environmentId: EnvironmentId.make("file-test-environment"),
  threadId: ThreadId.make("file-test-thread"),
};
const workspacePath = "autoops/p-one/workspaces/version-one/package-lock.json";

function setup() {
  const stack = new DisposableStack();
  state.customer = false;
  state.theme = "light";
  state.read.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  state.command.mockReset();
  state.toast.mockReset();
  state.openFile.mockReset();
  state.openAttachment.mockReset();
  const { openFile, openAttachment } = useRightPanelStore.getState();
  useRightPanelStore.setState({ openFile: state.openFile, openAttachment: state.openAttachment });
  stack.defer(() => useRightPanelStore.setState({ openFile, openAttachment }));
  const fetcher = stack.use(
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("禁止真实请求")),
  );
  return Object.assign(stack.move(), { fetcher });
}

it.each(["light", "dark"] as const)(
  "业务文件在 %s 主题下重挂载仍是原生标签并打开固定版本",
  async (theme) => {
    using test = setup();
    state.theme = theme;
    const text = `[package-lock.json](${workspacePath}) 给我项目总结`;
    await using screen = await render(
      <ChatMarkdown cwd={undefined} text={text} threadRef={threadRef} />,
    );
    const link = screen.getByRole("link", { name: "package-lock.json", exact: true });
    expect(link.element().classList.contains("chat-markdown-file-link")).toBe(true);
    expect(link.element().querySelector("[data-pierre-icon]")).not.toBeNull();
    expect(link.element().getAttribute("href")).toBe(autoOpsResourceUrl(workspacePath));
    expect(link.element().getAttribute("data-markdown-copy")).toBe(
      `[package-lock.json](${workspacePath})`,
    );
    await screen.rerender(
      <ChatMarkdown cwd={undefined} key="重新进入可视区域" text={text} threadRef={threadRef} />,
    );
    expect(
      screen
        .getByRole("link", { name: "package-lock.json", exact: true })
        .element()
        .querySelector("[data-pierre-icon]"),
    ).not.toBeNull();
    expect(test.fetcher).not.toHaveBeenCalled();
    await screen.getByRole("link", { name: "package-lock.json", exact: true }).click();
    expect(state.openFile).toHaveBeenCalledWith(threadRef, workspacePath);
    expect(state.openAttachment).not.toHaveBeenCalled();
    expect(state.command).not.toHaveBeenCalled();
    expect(state.read).not.toHaveBeenCalled();
    expect(test.fetcher).not.toHaveBeenCalled();
  },
);

it("助手描述与中文空格文件名各保留一次，复制保留原始业务引用", async () => {
  using test = setup();
  const path = "autoops/p-one/workspaces/version-one/docs/发布 准备.md";
  const source = `[**发布说明**](${encodeURI(path)})`;
  await using screen = await render(
    <ChatMarkdown cwd={undefined} text={`请阅读 ${source}。`} threadRef={threadRef} />,
  );
  const link = screen.getByRole("link", { name: "发布 准备.md", exact: true }).element();
  expect(link.querySelector("[data-pierre-icon]")).not.toBeNull();
  expect(screen.container.textContent?.match(/发布说明/g)).toHaveLength(1);
  expect(screen.container.textContent?.match(/发布 准备.md/g)).toHaveLength(1);
  expect(screen.container.querySelector("strong")?.textContent).toBe("发布说明");
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(screen.container.querySelector(".chat-markdown")!);
  selection.removeAllRanges();
  selection.addRange(range);
  using _selection = { [Symbol.dispose]: () => selection.removeAllRanges() };
  expect(chatMarkdownClipboardPayload(selection)?.text).toBe(`请阅读 ${source}。`);
  expect(test.fetcher).not.toHaveBeenCalled();
});

it("链接名称已是相对路径时不重复显示描述与文件名", async () => {
  using test = setup();
  const path = "autoops/p-one/workspaces/version-one/docs/需求 文档.md";
  await using screen = await render(
    <ChatMarkdown cwd={undefined} text={`[docs/需求 文档.md](${encodeURI(path)})`} />,
  );
  expect(
    screen
      .getByRole("link", { name: "需求 文档.md", exact: true })
      .element()
      .querySelector("[data-pierre-icon]"),
  ).not.toBeNull();
  expect(screen.container.textContent?.match(/需求 文档.md/g)).toHaveLength(1);
  expect(test.fetcher).not.toHaveBeenCalled();
});

it.each([
  ["/api/agent-demo/t3/autoops/files/report-one", "查看报告", "查看报告"],
  ["/api/agent-demo/t3/autoops/attachments/attachment-one", "需求.md", "需求.md"],
  [
    `/api/agent-demo/t3/autoops/skill-library/contexts/${"a".repeat(64)}/files/autoops-sample?path=references%2F检查.md`,
    "检查.md",
    "检查.md",
  ],
])("资源 %s 只在点击时校验元数据并使用原生附件预览", async (url, label, name) => {
  using test = setup();
  const text = `[${label}](${url})`;
  await using screen = await render(
    <ChatMarkdown cwd={undefined} text={text} threadRef={threadRef} />,
  );
  expect(
    screen.getByRole("link", { name, exact: true }).element().querySelector("svg"),
  ).not.toBeNull();
  await screen.rerender(
    <ChatMarkdown cwd={undefined} key="重新加载历史行" text={text} threadRef={threadRef} />,
  );
  expect(test.fetcher).not.toHaveBeenCalled();
  test.fetcher.mockResolvedValue(
    new Response(JSON.stringify({ name: "检查.md", mime: "text/markdown", size: 128 })),
  );
  await screen.getByRole("link", { name, exact: true }).click();
  await vi.waitFor(() =>
    expect(state.openAttachment).toHaveBeenCalledWith(threadRef, {
      type: "file",
      id: autoOpsResourceAttachmentId(autoOpsResourceUrl(url)!),
      name: "检查.md",
      mimeType: "text/markdown",
      sizeBytes: 128,
    }),
  );
  expect(test.fetcher).toHaveBeenCalledTimes(1);
  const requested = new URL(String(test.fetcher.mock.calls[0]![0]), location.origin);
  expect(requested.searchParams.get("metadata")).toBe("1");
  expect(test.fetcher.mock.calls[0]![1]).toMatchObject({ credentials: "same-origin" });
  expect(state.openFile).not.toHaveBeenCalled();
  expect(state.command).not.toHaveBeenCalled();
});

it("撤权返回错误时不打开文件，也不回退宿主读取", async () => {
  using test = setup();
  await using screen = await render(
    <ChatMarkdown
      cwd={undefined}
      text="[查看报告](/api/agent-demo/t3/autoops/files/report-denied)"
      threadRef={threadRef}
    />,
  );
  test.fetcher.mockResolvedValue(new Response("", { status: 403 }));
  await screen.getByRole("link", { name: "查看报告", exact: true }).click();
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "无法打开文件",
      }),
    ),
  );
  expect(state.openAttachment).not.toHaveBeenCalled();
  expect(state.openFile).not.toHaveBeenCalled();
  expect(state.read).not.toHaveBeenCalled();
  expect(state.command).not.toHaveBeenCalled();
});

it("外部链接和普通文件名不凭空转换为业务文件标签", async () => {
  using test = setup();
  await using screen = await render(
    <ChatMarkdown
      cwd={undefined}
      text="package-lock.json 和 `README.md`，以及 [外部文档](https://outside.invalid/file.md)"
      threadRef={threadRef}
    />,
  );
  expect(screen.container.querySelector(".chat-markdown-file-link")).toBeNull();
  expect(
    screen.getByRole("link", { name: "外部文档", exact: true }).element().getAttribute("href"),
  ).toBe("https://outside.invalid/file.md");
  expect(test.fetcher).not.toHaveBeenCalled();
});

it("客户执行会话不显示平台文件预览入口", async () => {
  using test = setup();
  state.customer = true;
  await using screen = await render(
    <ChatMarkdown
      cwd={undefined}
      text={`[package-lock.json](${workspacePath})`}
      threadRef={threadRef}
    />,
  );
  expect(screen.container.textContent).toContain("package-lock.json");
  expect(screen.container.querySelector("a")).toBeNull();
  expect(screen.container.querySelector(".chat-markdown-file-link")).toBeNull();
  expect(test.fetcher).not.toHaveBeenCalled();
  expect(state.command).not.toHaveBeenCalled();
});
