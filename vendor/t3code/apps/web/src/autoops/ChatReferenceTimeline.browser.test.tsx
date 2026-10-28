import { RegistryProvider } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId, MessageId } from "@t3tools/contracts";
import { createRef, useState, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import { readTimelinePosition } from "../components/chat/timelineScrollAnchoring";
import { autoOpsResourceCwd, autoOpsResourceUrl } from "./resources";
import type { AutoOpsThreadScope } from "./hostConfig";
import { useAutoOpsSkillContext } from "./useSkillContext";
import "../index.css";

vi.mock(import("./hostSnapshot"), async (original) => {
  const host = {
    principal: { id: "isolated-reference-reader", displayName: "隔离引用用户" },
    csrfToken: "isolated-reference-csrf",
    httpBaseUrl: `${location.origin}/api/agent-demo/t3`,
    wsBaseUrl: `ws://${location.host}/api/agent-demo/t3/ws`,
    gatewayBasePath: "/api/agent-demo/t3",
    fixedModel: { instanceId: "codex", model: "isolated-test-model" },
    runtimeMode: "approval-required" as const,
    capabilities: {},
    projects: [],
  };
  return { ...(await original()), readAutoOpsHost: () => host };
});

// 保留真正的查询注册表，仅隔离不属于本用例的原生服务配置读取。
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});

// 隔离公共运行时的环境发现，网络只允许本用例的skill目录请求。
vi.mock(import("../environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

const createdAt = "2026-10-23T00:00:00Z";
const filePath = "autoops/p-one/workspaces/version-one/docs/运行说明.md";
const skillMarker = "$autoops-release-readiness";
const userText = `[运行说明.md](${filePath}) ${skillMarker} 请检查发布准备情况。`;
const assistantText = `已核对 [运行说明.md](${filePath})，当前版本可以阅读。`;
const scope: AutoOpsThreadScope = {
  projectId: "p-one",
  environmentId: "env-test",
  agentId: "a-project",
  visibility: "private",
  workspaceType: "internal",
  workspaceVersionId: "version-one",
  scopeState: "locked",
  scopeLocked: true,
};

function message(id: string, text: string, role: "user" | "assistant"): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId: null,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    },
  };
}

function timelineProps(threadId: string): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-reference-test:${threadId}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: EnvironmentId.make("environment-reference-test"),
    markdownCwd: autoOpsResourceCwd(threadId, scope.projectId, scope) ?? undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function ReferenceTimeline({
  threadId,
  props,
  entries,
  timelineKey,
}: {
  threadId: string;
  props: Omit<TimelineProps, "timelineEntries">;
  entries: Entry[];
  timelineKey: number;
}) {
  const context = useAutoOpsSkillContext(threadId, scope.projectId, scope);
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  return (
    <div className="contents" onWheelCapture={() => setLiveFollowEnabled(false)}>
      <output
        className="sr-only"
        data-testid="reference-context-state"
        data-refreshing={context?.isRefreshing === true}
        data-authorized={context?.authorizedContext != null}
      >
        skill目录状态
      </output>
      <MessagesTimeline
        key={timelineKey}
        {...props}
        timelineEntries={entries}
        liveFollowEnabled={liveFollowEnabled}
        skills={context?.context?.skills ?? []}
      />
    </div>
  );
}

function row(container: HTMLElement, id: string, role: "user" | "assistant") {
  return container.querySelector<HTMLElement>(
    `[data-message-id="${id}"][data-message-role="${role}"]`,
  );
}

function readingAnchor(container: HTMLElement, viewport: HTMLElement) {
  const bounds = viewport.getBoundingClientRect();
  const visible = [...container.querySelectorAll<HTMLElement>("[data-message-role]")].find(
    (candidate) => {
      const position = candidate.getBoundingClientRect();
      return position.top < bounds.bottom - 30 && position.bottom > bounds.top + 30;
    },
  );
  expect(visible).toBeDefined();
  return {
    id: visible!.dataset.messageId!,
    offset: visible!.getBoundingClientRect().top - bounds.top,
  };
}

function expectReadingAnchor(
  container: HTMLElement,
  viewport: HTMLElement,
  anchor: ReturnType<typeof readingAnchor>,
) {
  const element = container.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`);
  expect(element).not.toBeNull();
  const offset = element!.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  expect(Math.abs(offset - anchor.offset)).toBeLessThanOrEqual(2);
}

async function copiedText(markdown: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(markdown);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const clipboardData = new DataTransfer();
  const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
  try {
    await act(() => markdown.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    return clipboardData.getData("text/plain").trim();
  } finally {
    selection.removeAllRanges();
  }
}

it("目录慢刷新期间滚动和重挂长历史仍保留skill与双方文件标签、原始复制及阅读位置", async () => {
  const threadId = `reference-${Math.random().toString(36).slice(2)}`;
  const props = timelineProps(threadId);
  const context = {
    cwd: "autoops/skill-context/isolated-snapshot",
    snapshotId: "a".repeat(64),
    skills: [
      { name: "autoops-release-readiness", displayName: "发布准备报告", versionId: "skill-v1" },
    ],
  };
  let finishRefresh: (response: Response) => void = () => {
    throw new Error("尚未开始目录刷新");
  };
  const pendingRefresh = new Promise<Response>((resolve) => {
    finishRefresh = resolve;
  });
  let requestCount = 0;
  using fetcher = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = new URL(String(input), location.origin);
    expect(url.pathname).toBe("/api/agent-demo/t3/autoops/skill-library/context");
    expect(url.searchParams.get("threadId")).toBe(threadId);
    requestCount += 1;
    return requestCount === 1 ? Promise.resolve(Response.json(context)) : pendingRefresh;
  });
  const entries = [
    ...Array.from({ length: 64 }, (_, index) =>
      message(
        `history-${index}`,
        `历史消息 ${index}\n\n${"这一段资料用于检验向上阅读时的真实文件与skill标签。".repeat(35)}`,
        "assistant",
      ),
    ),
    message("user-reference", userText, "user"),
    message("assistant-reference", assistantText, "assistant"),
  ];
  const container = document.createElement("div");
  container.style.cssText = "height: 620px; width: 900px; display: flex; flex-direction: column;";
  const view = (timelineKey: number) => (
    <RegistryProvider>
      <ReferenceTimeline
        threadId={threadId}
        props={props}
        entries={entries}
        timelineKey={timelineKey}
      />
    </RegistryProvider>
  );
  await using screen = await render(view(0), { container });
  const state = () =>
    container.querySelector<HTMLElement>('[data-testid="reference-context-state"]')!;
  const userRow = () => row(container, "user-reference", "user");
  const assistantRow = () => row(container, "assistant-reference", "assistant");
  const skillChip = () =>
    userRow()?.querySelector<HTMLElement>(
      `[data-slot="context-chip"][data-markdown-copy="${skillMarker}"]`,
    );
  const expectReferences = () => {
    expect(skillChip()?.textContent).toBe("发布准备报告");
    expect(userRow()?.textContent).not.toContain(skillMarker);
    for (const messageRow of [userRow(), assistantRow()]) {
      expect(messageRow).not.toBeNull();
      const file = messageRow!.querySelector<HTMLAnchorElement>(".chat-markdown-file-link")!;
      expect(file.textContent).toBe("运行说明.md");
      expect(file.querySelector("[data-pierre-icon]")).not.toBeNull();
      expect(file.getAttribute("href")).toBe(autoOpsResourceUrl(filePath));
      expect(file.getAttribute("data-markdown-copy")).toBe(`[运行说明.md](${filePath})`);
    }
  };
  await vi.waitFor(() => {
    expect(state().dataset.authorized).toBe("true");
    expectReferences();
  });
  const originalUserNode = userRow()!;
  let viewport = props.listRef.current!.getScrollableNode()!;
  const scrollToHistory = async () => {
    await vi.waitFor(
      async () => {
        if (viewport.scrollTop > 2) await userEvent.wheel(viewport, { delta: { y: -100_000 } });
        expect(viewport.scrollTop).toBeLessThanOrEqual(2);
        const pooledUserRow = userRow();
        if (pooledUserRow) {
          const position = pooledUserRow.getBoundingClientRect();
          const bounds = viewport.getBoundingClientRect();
          expect(position.bottom <= bounds.top || position.top >= bounds.bottom).toBe(true);
        }
        expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(false);
      },
      { timeout: 4_000 },
    );
  };
  const scrollToReferences = async () => {
    await vi.waitFor(
      async () => {
        const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        if (gap > 2 || !userRow() || !assistantRow())
          await userEvent.wheel(viewport, { delta: { y: 100_000 } });
        expect(
          viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        ).toBeLessThanOrEqual(2);
        expectReferences();
        const bounds = viewport.getBoundingClientRect();
        for (const messageRow of [userRow()!, assistantRow()!]) {
          const position = messageRow.getBoundingClientRect();
          expect(position.bottom).toBeGreaterThan(bounds.top);
          expect(position.top).toBeLessThan(bounds.bottom);
        }
      },
      { timeout: 4_000 },
    );
  };
  const originalOffset = viewport.scrollTop;
  await scrollToHistory();
  expect(viewport.scrollTop).toBeLessThan(originalOffset - 500);
  const beforeFocus = readingAnchor(container, viewport);
  await act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await vi.waitFor(() => {
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(state().dataset.refreshing).toBe("true");
    expect(state().dataset.authorized).toBe("false");
    expectReadingAnchor(container, viewport, beforeFocus);
  });

  // 原生容器池允许离屏保留节点，单独重建列表来确证卸载与阅读位置恢复。
  const oldViewport = viewport;
  await screen.rerender(view(1));
  await vi.waitFor(() => {
    const nextViewport = props.listRef.current?.getScrollableNode();
    expect(nextViewport).toBeTruthy();
    expect(nextViewport).not.toBe(oldViewport);
    expect(originalUserNode.isConnected).toBe(false);
  });
  viewport = props.listRef.current!.getScrollableNode()!;
  await vi.waitFor(() => {
    expect(state().dataset.refreshing).toBe("true");
    expectReadingAnchor(container, viewport, beforeFocus);
  });

  await scrollToReferences();
  expect(userRow()).not.toBe(originalUserNode);
  expect(state().dataset.refreshing).toBe("true");
  await scrollToHistory();
  const beforeCompletion = readingAnchor(container, viewport);
  await act(() => {
    finishRefresh(Response.json(context));
  });
  await vi.waitFor(() => {
    expect(state().dataset.refreshing).toBe("false");
    expect(state().dataset.authorized).toBe("true");
    expectReadingAnchor(container, viewport, beforeCompletion);
  });

  await scrollToReferences();
  expect(await copiedText(userRow()!.querySelector<HTMLElement>(".chat-markdown")!)).toBe(userText);
  expect(await copiedText(assistantRow()!.querySelector<HTMLElement>(".chat-markdown")!)).toBe(
    assistantText,
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});
