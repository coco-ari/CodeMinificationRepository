import { useRef, useState, type PropsWithChildren } from "react";
import { EnvironmentId, customerFileReference } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { autoOpsRequest } from "./apiClient";
import { useCustomerFileSearch } from "./customerFiles";
import { CustomerFileLink, CustomerFilePicker } from "./CustomerFilePicker";
import { ThreadId } from "@t3tools/contracts";
import type { AutoOpsThreadScope } from "./hostConfig";
import "../index.css";

vi.mock(import("./apiClient"), async (original) => ({
  ...(await original()),
  autoOpsRequest: vi.fn(),
}));
vi.mock("~/components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}));
const environmentId = EnvironmentId.make("customer-files-test");
function setup() {
  vi.mocked(autoOpsRequest).mockReset();
  const scope: AutoOpsThreadScope = {
    projectId: "project",
    environmentId: "test",
    agentId: "agent",
    visibility: "private",
    executionBinding: {
      kind: "customer",
      deviceId: "device",
      registeredWorkspaceId: "workspace",
      workspaceBindingRevision: 1,
      runtimeId: "codex",
    },
  };
  return { scope };
}

function Search(props: { scope: AutoOpsThreadScope; query: string }) {
  const result = useCustomerFileSearch(props.scope, "draft", environmentId, props.query);
  return (
    <>
      <div role="status">{result.isPending ? "加载中" : "已完成"}</div>
      <div role="alert">{result.error}</div>
      <ul>
        {result.entries.map((entry) => (
          <li key={entry.path}>{entry.path}</li>
        ))}
      </ul>
    </>
  );
}

describe("客户文件的原生选择与范围隔离", () => {
  it("Esc 关闭后回到输入框，历史预览关闭后回到原文件标签", async () => {
    const { scope } = setup();
    vi.mocked(autoOpsRequest).mockImplementation((path) => {
      const input = JSON.parse(new URL(path, "http://localhost").searchParams.get("input")!);
      return Promise.resolve(
        input.operation === "preview"
          ? {
              entries: [],
              truncated: false,
              preview: { path: "src/client.ts", size: 12, binary: false, contents: "FOCUS-7625" },
            }
          : { entries: [], truncated: false },
      );
    });
    function Composer() {
      const [open, setOpen] = useState(false);
      const input = useRef<HTMLInputElement>(null);
      return (
        <>
          <input aria-label="测试消息" ref={input} />
          <button onClick={() => setOpen(true)}>选择电脑文件</button>
          {open ? (
            <CustomerFilePicker
              scope={scope}
              threadId="draft"
              environmentId={environmentId}
              initialPath={null}
              onClose={() => setOpen(false)}
              onRestoreFocus={() => input.current?.focus()}
            />
          ) : null}
          <CustomerFileLink
            scope={scope}
            threadRef={{ environmentId, threadId: ThreadId.make("draft") }}
            path="autoops-customer/device/workspace/1/src/client.ts"
            copyMarkdown=""
          />
        </>
      );
    }
    await using screen = await render(<Composer />);
    await screen.getByRole("button", { name: "选择电脑文件", exact: true }).click();
    await page.getByRole("searchbox").click();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(screen.getByRole("textbox", { name: "测试消息", exact: true }))
      .toHaveFocus();
    await screen.getByRole("button", { name: "预览 client.ts", exact: true }).click();
    await expect.element(page.getByText(/FOCUS-7625/u)).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "预览 client.ts", exact: true }))
      .toHaveFocus();
  });

  it("旧搜索取消后迟到结果不能覆盖新目录，新范围不复用旧结果", async () => {
    const { scope } = setup();
    let finishOld!: (value: unknown) => void;
    let oldSignal: AbortSignal | undefined;
    vi.mocked(autoOpsRequest).mockImplementation((path, options) => {
      const query = new URL(path, "http://localhost").searchParams;
      const input = JSON.parse(query.get("input")!);
      if (input.query === "old") {
        oldSignal = options.signal;
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      }
      return Promise.resolve({ entries: [{ path: "new.ts", kind: "file" }], truncated: false });
    });
    await using screen = await render(<Search scope={scope} query="old" />);
    await expect.poll(() => !!finishOld).toBe(true);
    await screen.rerender(<Search scope={scope} query="new" />);
    await expect.poll(() => oldSignal?.aborted).toBe(true);
    await expect.element(screen.getByText(/new\.ts/u)).toBeVisible();
    finishOld({ entries: [{ path: "old.ts", kind: "file" }], truncated: false });
    await expect.element(screen.getByText(/old\.ts/u)).not.toBeInTheDocument();
    const other = {
      ...scope,
      executionBinding: { ...scope.executionBinding!, registeredWorkspaceId: "other" },
    } as AutoOpsThreadScope;
    await screen.rerender(<Search scope={other} query="new" />);
    await expect
      .element(screen.getByText(/autoops-customer\/device\/other\/1\/new\.ts/u))
      .toBeVisible();
  });

  it("原生文件预览显示正文，引用仅传登记身份和相对路径", async () => {
    const { scope } = setup();
    vi.mocked(autoOpsRequest).mockImplementation((path) => {
      const input = JSON.parse(new URL(path, "http://localhost").searchParams.get("input")!);
      return Promise.resolve(
        input.operation === "preview"
          ? {
              entries: [],
              truncated: true,
              preview: {
                path: "src/client.ts",
                size: 120_000,
                binary: false,
                contents: "export const marker = 'PREVIEW-7813';",
              },
            }
          : { entries: [{ path: "src", kind: "directory" }], truncated: false },
      );
    });
    const selected = vi.fn(),
      closed = vi.fn();
    await using _screen = await render(
      <CustomerFilePicker
        scope={scope}
        threadId="draft"
        environmentId={environmentId}
        initialPath="src/client.ts"
        onClose={closed}
        onSelect={selected}
      />,
    );
    await expect.element(page.getByText(/PREVIEW-7813/u)).toBeVisible();
    await expect.element(page.getByText("仅预览文件开头，Agent 会读取本机原文件。")).toBeVisible();
    await page.getByRole("button", { name: "引用文件", exact: true }).click();
    expect(selected).toHaveBeenCalledWith(
      customerFileReference(
        scope.executionBinding as Extract<
          NonNullable<AutoOpsThreadScope["executionBinding"]>,
          { kind: "customer" }
        >,
        "src/client.ts",
      ),
    );
    const requests = vi
      .mocked(autoOpsRequest)
      .mock.calls.map(([path]) =>
        JSON.parse(new URL(path, "http://localhost").searchParams.get("input")!),
      );
    expect(requests.filter((input) => input.operation === "preview")).toHaveLength(1);
    expect(
      requests
        .filter((input) => input.operation === "list")
        .map((input) => input.path)
        .sort(),
    ).toEqual(["", "src"]);
  });

  it("预览失败提供一次重试，失败时不能假装选中文件成功", async () => {
    const { scope } = setup();
    let fail = true;
    vi.mocked(autoOpsRequest).mockImplementation((path) => {
      const input = JSON.parse(new URL(path, "http://localhost").searchParams.get("input")!);
      if (input.operation !== "preview") return Promise.resolve({ entries: [], truncated: false });
      return fail
        ? Promise.reject(new Error("电脑已离线，请等待重新连接"))
        : Promise.resolve({
            entries: [],
            truncated: false,
            preview: { path: "client.ts", size: 1, binary: false, contents: "x" },
          });
    });
    await using _screen = await render(
      <CustomerFilePicker
        scope={scope}
        threadId="draft"
        environmentId={environmentId}
        initialPath="client.ts"
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );
    await expect.element(page.getByText("电脑已离线，请等待重新连接")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "引用文件", exact: true }))
      .toBeDisabled();
    fail = false;
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "引用文件", exact: true })).toBeEnabled();
  });
});
