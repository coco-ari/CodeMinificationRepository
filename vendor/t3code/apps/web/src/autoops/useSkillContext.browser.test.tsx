import { RegistryProvider } from "@effect/atom-react";
import type { Editor } from "@tiptap/core";
import type { ServerProviderSkill } from "@t3tools/contracts";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal, type Screen } from "../../test/render";
import { renderSkillInlineMarkdownChildren } from "~/components/chat/SkillInlineText";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "~/components/ComposerPromptEditor";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import type { AutoOpsThreadScope } from "./hostConfig";
import { useAutoOpsSkillContext } from "./useSkillContext";
import { skillContextDisplaySkills } from "./skillLibrary";

const mocks = vi.hoisted(() => ({ host: vi.fn() }));
vi.mock(import("./hostSnapshot"), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}));

const scope: AutoOpsThreadScope = {
  projectId: "project-one",
  agentId: "agent-one",
  environmentId: "test",
  visibility: "private",
  workspaceType: "internal",
  workspaceVersionId: "version-one",
};
const skillName = "autoops-readiness";
const prompt = `$${skillName} 检查一下`;
const host = (principalId = "owner-one", csrfToken = "isolated-session-one") => ({
  principal: { id: principalId, displayName: "隔离测试用户" },
  csrfToken,
  gatewayBasePath: "/api/agent-demo/t3",
  httpBaseUrl: `${location.origin}/api/agent-demo/t3`,
});
const snapshot = (label = "发布准备检查") => ({
  cwd: "autoops/skill-context/isolated",
  snapshotId: "isolated-snapshot",
  skills: [{ name: skillName, displayName: label, versionId: "skill-version-one" }],
});
const response = (label?: string) => Response.json(snapshot(label));
const denied = (status: number) => Response.json({ error: "当前技能访问已失效。" }, { status });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((deliver) => {
    resolve = deliver;
  });
  return { promise, resolve };
}

function setup() {
  vi.resetAllMocks();
  mocks.host.mockReturnValue(host());
}

interface ProbeProps {
  id?: string;
  threadId?: string;
  selection?: AutoOpsThreadScope;
  showHistory?: boolean;
  showEditor?: boolean;
}

function SkillDraft({ skills }: { skills: ReadonlyArray<ServerProviderSkill> }) {
  const [draft, setDraft] = useState({ value: prompt, cursor: prompt.length });
  return (
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      value={draft.value}
      cursor={draft.cursor}
      richTextEnabled
      contextRecords={new Map()}
      skills={skills}
      disabled={false}
      placeholder="输入需求"
      onChange={(value, cursor) => setDraft({ value, cursor })}
      onPaste={() => {}}
    />
  );
}

function Probe({
  id = "timeline",
  threadId = "thread-one",
  selection = scope,
  showHistory = true,
  showEditor = false,
}: ProbeProps) {
  const result = useAutoOpsSkillContext(threadId, selection.projectId, selection);
  const displaySkills = skillContextDisplaySkills(result?.context);
  return (
    <section data-testid={id}>
      {showHistory ? (
        <p data-testid="history">
          {renderSkillInlineMarkdownChildren(prompt, result?.context?.skills ?? [])}
        </p>
      ) : null}
      <button type="button" disabled={!result?.authorizedContext}>
        选择新技能
      </button>
      {showEditor ? <SkillDraft skills={displaySkills} /> : null}
      <output data-testid="available">{result?.authorizedContext?.skills.map(skill => skill.name).join(",")}</output>
      <output data-testid="status">
        {result?.isRefreshing ? "正在复核" : result ? "已完成" : "初次读取"}
      </output>
      {result?.error ? (
        <>
          <p role="alert">{result.error}</p>
          <button onClick={result.refresh}>重试</button>
        </>
      ) : null}
    </section>
  );
}

const view = (props: ProbeProps = {}, withComposer = false, sessionKey = "session-one") => (
  <RegistryProvider key={sessionKey}>
    <Probe {...props} />
    {withComposer ? <Probe {...props} id="composer" /> : null}
  </RegistryProvider>
);
const panel = (screen: Screen, id = "timeline") =>
  screen.container.querySelector(`[data-testid="${id}"]`)!;
const history = (screen: Screen, id = "timeline") =>
  panel(screen, id).querySelector('[data-testid="history"]')!;
const newSelection = (screen: Screen, id = "timeline") =>
  panel(screen, id).querySelector("button")!;

function expectLabel(screen: Screen, label = "发布准备检查", id = "timeline") {
  expect(history(screen, id).textContent).toContain(label);
  expect(history(screen, id).textContent).not.toContain(`$${skillName}`);
  expect(history(screen, id).querySelector('[data-slot="context-chip"]')).not.toBeNull();
}

async function focus() {
  await act(() => window.dispatchEvent(new Event("focus")));
}

describe("技能上下文的同范围刷新", () => {
  it("旧对话按当前分配刷新，移除的技能不阻止其余候选，网络失败不恢复旧项", async () => {
    setup();
    const selection = { ...scope, scopeLocked: true, scopeState: "locked" as const };
    const current = { ...snapshot(), snapshotId: "remaining", skills: [{ name: "autoops-kept", displayName: "项目资料解读", versionId: "kept" }] };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(Response.json(current))
      .mockRejectedValueOnce(new TypeError("隔离网络故障"))
      .mockResolvedValueOnce(Response.json({ ...current, skills: [] }));
    using _fetch = stubGlobal("fetch", fetcher);
    await using screen = await render(view({ selection }, true));
    await vi.waitFor(() => expect(newSelection(screen).disabled).toBe(false));
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/agent-demo/t3/autoops/skill-library/context?threadId=thread-one");
    await focus();
    await vi.waitFor(() => expect(panel(screen).querySelector('[data-testid="available"]')?.textContent).toBe("autoops-kept"));
    for (const id of ["timeline", "composer"]) {
      expect(newSelection(screen, id).disabled).toBe(false);
      expect(panel(screen, id).querySelector('[role="alert"]')).toBeNull();
      expect(panel(screen, id).querySelector('[data-testid="status"]')?.textContent).toBe("已完成");
      expect(history(screen, id).textContent).toContain(prompt);
    }
    await focus();
    await vi.waitFor(() => expect(newSelection(screen).disabled).toBe(true));
    expect(history(screen).querySelector('[data-slot="context-chip"]')).toBeNull();
    await vi.waitFor(() => expect(panel(screen).querySelector('[role="alert"]')?.textContent).toContain("暂时无法连接"));
    await act(() => panel(screen).querySelectorAll<HTMLButtonElement>("button")[1]!.click());
    await vi.waitFor(() => expect(newSelection(screen).disabled).toBe(false));
    expect(panel(screen).querySelector('[data-testid="available"]')?.textContent).toBe("");
    expect(panel(screen).querySelector('[role="alert"]')).toBeNull();
  });

  it("分配切换快照但原生目录尚未发现时，标签、光标及固定版本说明地址保持正确", async () => {
    setup();
    const next = {
      ...snapshot("新版发布检查"),
      cwd: "autoops/skill-context/next",
      snapshotId: "next-snapshot",
      skills: [{ name: skillName, displayName: "新版发布检查", versionId: "skill-version-two" }],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(Response.json(next));
    using _fetch = stubGlobal("fetch", fetcher);
    await using screen = await render(view({ showEditor: true }));
    const node = screen.container.querySelector<HTMLElement & { editor: Editor }>(".tiptap")!;
    await vi.waitFor(() => expect(node.textContent).toContain("发布准备检查"));
    const editor = node.editor;
    await act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1));
    const cursor = editor.state.selection.from;
    await act(() => window.dispatchEvent(new Event("autoops:skill-library-changed")));
    await vi.waitFor(() => expect(node.textContent).toContain("新版发布检查"));
    expect(editor.state.selection.from).toBe(cursor);
    expect(serializeEditorDoc(editor.state.doc).value).toBe(prompt);
    expect(node.querySelectorAll('button[aria-label="技能 新版发布检查，查看详情"]')).toHaveLength(
      1,
    );
    expect(skillContextDisplaySkills(next)[0]?.path).toBe(
      "/api/agent-demo/t3/autoops/skill-library/contexts/next-snapshot/files/autoops-readiness?path=SKILL.md",
    );
    expect(skillContextDisplaySkills(null)).toEqual([]);
  });

  it("输入框已有技能标签和原文序列化在复核、网络失败及恢复期间保持稳定", async () => {
    setup();
    const pending = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(denied(403));
    using _fetch = stubGlobal("fetch", fetcher);
    await using screen = await render(view({ showEditor: true }));
    const editorNode = screen.container.querySelector<HTMLElement & { editor: Editor }>(".tiptap")!;
    await vi.waitFor(() => expect(editorNode.textContent).toContain("发布准备检查"));
    const editor = editorNode.editor;
    await act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1));
    const cursor = editor.state.selection.from;
    expect(serializeEditorDoc(editor.state.doc).value).toBe(prompt);
    await focus();
    expect(editorNode.textContent).toContain("发布准备检查");
    expect(newSelection(screen).disabled).toBe(true);
    expect(editor.state.selection.from).toBe(cursor);
    expect(serializeEditorDoc(editor.state.doc).value).toBe(prompt);
    await act(() => pending.resolve(Response.json({ error: "读取暂时失败" }, { status: 503 })));
    await vi.waitFor(() => expect(panel(screen).textContent).toContain("读取暂时失败"));
    expect(editorNode.textContent).toContain("发布准备检查");
    expect(editor.state.selection.from).toBe(cursor);
    expect(serializeEditorDoc(editor.state.doc).value).toBe(prompt);
    await focus();
    await vi.waitFor(() => expect(newSelection(screen).disabled).toBe(false));
    expect(editorNode.textContent).toContain("发布准备检查");
    expect(serializeEditorDoc(editor.state.doc).value).toBe(prompt);
    await focus();
    await vi.waitFor(() => expect(panel(screen).textContent).toContain("当前技能访问已失效。"));
    expect(editorNode.textContent).not.toContain("发布准备检查");
    expect(serializeEditorDoc(editor.state.doc).value).toBe(prompt);
  });

  it("时间线和输入区共享一次读取，初次读取时不授权新选择", async () => {
    setup();
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    using _fetch = stubGlobal("fetch", fetcher);
    await using screen = await render(view({}, true));
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const id of ["timeline", "composer"]) {
      expect(history(screen, id).textContent).toContain(prompt);
      expect(newSelection(screen, id).disabled).toBe(true);
    }
    await act(() => pending.resolve(response()));
    await vi.waitFor(() => {
      for (const id of ["timeline", "composer"]) {
        expectLabel(screen, "发布准备检查", id);
        expect(newSelection(screen, id).disabled).toBe(false);
      }
    });
  });

  it("焦点刷新期间保留历史标签，行重挂仍稳定，新选择等待复核", async () => {
    setup();
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockReturnValueOnce(pending.promise);
    using _fetch = stubGlobal("fetch", fetcher);
    await using screen = await render(view({}, true));
    await vi.waitFor(() => expectLabel(screen));
    await focus();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const id of ["timeline", "composer"]) {
      expectLabel(screen, "发布准备检查", id);
      expect(newSelection(screen, id).disabled).toBe(true);
    }
    await screen.rerender(view({ showHistory: false }, true));
    await screen.rerender(view({}, true));
    expectLabel(screen);
    await focus();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(() => pending.resolve(response()));
    await vi.waitFor(() => expect(newSelection(screen).disabled).toBe(false));
    expectLabel(screen);
  });

  it("技能库变动只发一个请求，普通网络失败保留历史并可恢复", async () => {
    setup();
    const pending = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response());
    using _fetch = stubGlobal("fetch", fetcher);
    await using screen = await render(view({}, true));
    await vi.waitFor(() => expectLabel(screen));
    await act(() => window.dispatchEvent(new Event("autoops:skill-library-changed")));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(() => pending.resolve(Response.json({ error: "读取暂时失败" }, { status: 503 })));
    await vi.waitFor(() => expect(panel(screen).textContent).toContain("读取暂时失败"));
    expectLabel(screen);
    expect(newSelection(screen).disabled).toBe(true);
    await focus();
    await vi.waitFor(() => expect(newSelection(screen).disabled).toBe(false));
    expectLabel(screen);
    expect(panel(screen).querySelector('[role="alert"]')).toBeNull();
  });

  it("读取在途发生技能变动会重新复核，迟到旧结果不能重新授权", async () => {
    setup();
    const oldRequest = deferred<Response>();
    const nextRequest = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(nextRequest.promise);
    using _fetch = stubGlobal("fetch", fetcher);
    await using screen = await render(view({}, true));
    await vi.waitFor(() => expectLabel(screen));
    await focus();
    await act(() => window.dispatchEvent(new Event("autoops:skill-library-changed")));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expectLabel(screen);
    expect(newSelection(screen).disabled).toBe(true);
    await act(() => oldRequest.resolve(response("已经失效的目录")));
    expectLabel(screen);
    expect(newSelection(screen).disabled).toBe(true);
    await act(() => nextRequest.resolve(denied(403)));
    await vi.waitFor(() => expect(panel(screen).textContent).toContain("当前技能访问已失效。"));
    expect(history(screen).textContent).toContain(prompt);
    expect(newSelection(screen).disabled).toBe(true);
  });

  it.each([401, 403, 404])(
    "读取 %s 清除历史目录，后续网络失败不会复活，重新授权后才恢复",
    async (status) => {
      setup();
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(denied(status))
        .mockRejectedValueOnce(new TypeError("隔离网络不可用"))
        .mockResolvedValueOnce(response());
      using _fetch = stubGlobal("fetch", fetcher);
      await using screen = await render(view({}, true));
      await vi.waitFor(() => expectLabel(screen));
      await focus();
      await vi.waitFor(() => expect(panel(screen).textContent).toContain("当前技能访问已失效。"));
      expect(history(screen).textContent).toContain(prompt);
      expect(newSelection(screen).disabled).toBe(true);
      await focus();
      await vi.waitFor(() => expect(panel(screen).textContent).toContain("暂时无法连接"));
      expect(history(screen).textContent).toContain(prompt);
      expect(newSelection(screen).disabled).toBe(true);
      await focus();
      await vi.waitFor(() => expectLabel(screen));
      expect(newSelection(screen).disabled).toBe(false);
    },
  );
});

describe("技能上下文的身份和范围隔离", () => {
  it.each(["线程", "项目", "账号", "登录会话"] as const)(
    "%s变化按原生身份边界隔离目录，并忽略不服从取消的迟到响应",
    async (change) => {
      setup();
      const oldRequest = deferred<Response>();
      const nextRequest = deferred<Response>();
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(response("旧目录标签"))
        .mockReturnValueOnce(oldRequest.promise)
        .mockReturnValueOnce(nextRequest.promise);
      using _fetch = stubGlobal("fetch", fetcher);
      await using screen = await render(view());
      await vi.waitFor(() => expectLabel(screen, "旧目录标签"));
      await focus();
      const next =
        change === "线程"
          ? { threadId: "thread-two" }
          : change === "项目"
            ? { selection: { ...scope, projectId: "project-two" } }
            : {};
      if (change === "账号") mocks.host.mockReturnValue(host("owner-two"));
      if (change === "登录会话")
        mocks.host.mockReturnValue(host("owner-one", "isolated-session-two"));
      // 更换登录身份由宿主重新加载应用；业务范围切换则保留现有组件实例。
      const sessionKey = change === "账号" || change === "登录会话" ? "session-two" : "session-one";
      await screen.rerender(view(next, false, sessionKey));
      expect(history(screen).textContent).toContain(prompt);
      expect(newSelection(screen).disabled).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(3);
      await vi.waitFor(() =>
        expect((fetcher.mock.calls[1]![1] as RequestInit).signal?.aborted).toBe(true),
      );
      if (change !== "项目") expect(fetcher.mock.calls[2]![0]).toBe(fetcher.mock.calls[1]![0]);
      await act(() => nextRequest.resolve(response("新目录标签")));
      await vi.waitFor(() => expectLabel(screen, "新目录标签"));
      await act(() => oldRequest.resolve(response("迟到旧目录")));
      expectLabel(screen, "新目录标签");
      expect(screen.container.textContent).not.toContain("迟到旧目录");
    },
  );

  it("切换客户执行目标立即清除平台目录并取消旧读取", async () => {
    setup();
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockReturnValueOnce(pending.promise);
    using _fetch = stubGlobal("fetch", fetcher);
    await using screen = await render(view());
    await vi.waitFor(() => expectLabel(screen));
    await focus();
    const selection: AutoOpsThreadScope = {
      ...scope,
      executionBinding: {
        kind: "customer",
        deviceId: "device-one",
        registeredWorkspaceId: "workspace-one",
        workspaceBindingRevision: 1,
        runtimeId: "codex",
      },
    };
    await screen.rerender(view({ selection }));
    expect(history(screen).textContent).toContain(prompt);
    expect(newSelection(screen).disabled).toBe(true);
    await vi.waitFor(() =>
      expect((fetcher.mock.calls[1]![1] as RequestInit).signal?.aborted).toBe(true),
    );
    await act(() => pending.resolve(response("旧平台目录")));
    expect(history(screen).textContent).toContain(prompt);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("一个消费者卸载不会取消另一个的请求，最后一个卸载才取消", async () => {
    setup();
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    using _fetch = stubGlobal("fetch", fetcher);
    await using screen = await render(view({}, true));
    const signal = (fetcher.mock.calls[0]![1] as RequestInit).signal!;
    await screen.rerender(view());
    expect(signal.aborted).toBe(false);
    await screen.unmount();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    await act(() => pending.resolve(response()));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

for (const recovery of ["manual", "online"] as const) {
  it(`技能授权目录读取失败后通过 ${recovery} 恢复且不提前放行`, async () => {
    setup();
    const pending = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "技能加载失败" }, { status: 503 }))
      .mockReturnValueOnce(pending.promise);
    using _fetch = stubGlobal("fetch", fetcher);
    await using screen = await render(view());
    await vi.waitFor(() => expect(panel(screen).textContent).toContain("技能加载失败"));
    expect(newSelection(screen).disabled).toBe(true);
    await act(() => {
      if (recovery === "online") window.dispatchEvent(new Event("online"));
      else (panel(screen).querySelectorAll("button")[1] as HTMLButtonElement).click();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(newSelection(screen).disabled).toBe(true);
    await act(() => pending.resolve(response()));
    await vi.waitFor(() => expect(newSelection(screen).disabled).toBe(false));
    expectLabel(screen);
    await screen.unmount();
    await act(() => window.dispatchEvent(new Event("online")));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
}
