import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { AutoOpsRequestError } from "./apiClient";
import { readAuthoringPending, useWorkspaceAuthoring } from "./useWorkspaceAuthoring";
import { authoringDigest, type AuthoringCommand } from "./workspaceAuthoring";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  send: vi.fn(),
  inspect: vi.fn(),
  credentials: vi.fn(),
  accepted: vi.fn(),
  host: vi.fn(),
}));
vi.mock(import("./hostConfig"), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}));
vi.mock(import("./workspaceAuthoring"), async (original) => ({
  ...(await original()),
  loadAuthoring: mocks.read,
  loadAuthoringCredentials: mocks.credentials,
  submitAuthoring: mocks.send,
  inspectAuthoringRequest: mocks.inspect,
}));
const storageKey = "autoops:workspace-authoring:credential-fixture:p-fixture";
const command = (secret = "fixture-secret-one"): AuthoringCommand => ({
  kind: "credential",
  action: "save",
  name: "隔离测试仓库",
  username: "fixture-user",
  secret,
});
function setup() {
  vi.resetAllMocks();
  sessionStorage.clear();
  mocks.host.mockReturnValue({ principal: { id: "credential-fixture" } });
  mocks.read.mockResolvedValue({
    projectId: "p-fixture",
    revision: 3,
    entries: [],
    sources: [],
    limits: { maxFileBytes: 8_000_000, maxBytes: 50_000_000, maxFiles: 100 },
  });
  mocks.credentials.mockResolvedValue({ credentials: [] });
  mocks.inspect.mockResolvedValue(null);
  mocks.send.mockRejectedValue(
    new AutoOpsRequestError("结果尚未确认", "CONNECTION_FAILED", undefined, true),
  );
}
function Harness() {
  const controller = useWorkspaceAuthoring("p-fixture", true, mocks.accepted);
  const [outcome, setOutcome] = useState("尚未提交");
  const save = async (secret: string) => {
    setOutcome((await controller.submit(command(secret))) ? "本次输入已保存" : "本次输入未确认");
  };
  return (
    <>
      <button
        disabled={!controller.overview || controller.busy}
        onClick={() => void save("fixture-secret-one")}
      >
        保存原秘密
      </button>
      <button
        disabled={!controller.overview || controller.busy}
        onClick={() => void save("fixture-secret-two")}
      >
        保存修改秘密
      </button>
      <button disabled={controller.busy} onClick={() => void controller.check()}>
        核对原请求
      </button>
      <button
        disabled={controller.busy || !controller.retryAvailable}
        onClick={() => void controller.retry()}
      >
        重试原请求
      </button>
      <p>{outcome}</p>
      <p>{controller.pending ? "原请求待核对" : "没有待核对请求"}</p>
      {controller.error ? <p role="alert">{controller.error}</p> : null}
    </>
  );
}
const receipt = (requestId: string) => ({
  requestId,
  credential: { id: "credential-fixture", name: "隔离测试仓库", revision: 1 },
});

describe("凭证待核对状态的秘密边界", () => {
  it("持久摘要不依赖秘密，只随非秘密元数据变化", () => {
    setup();
    expect(authoringDigest(command())).toBe(authoringDigest(command("another-fixture-secret")));
    expect(authoringDigest(command())).not.toBe(
      authoringDigest({ ...command(), name: "另一仓库" } as AuthoringCommand),
    );
  });

  it("秘密及其完整输入摘要不进入存储，同页修改秘密不会套用原收据", async () => {
    setup();
    await using screen = await render(<Harness />);
    await page.getByRole("button", { name: "保存原秘密", exact: true }).click();
    await expect.element(page.getByText("本次输入未确认", { exact: true })).toBeVisible();
    const first = mocks.send.mock.calls[0]![1];
    const stored = sessionStorage.getItem(storageKey)!;
    const unsafeDigest = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(command()))));
    expect(stored).not.toContain("fixture-secret-one");
    expect(stored).not.toContain(unsafeDigest);
    expect(JSON.parse(stored).digest).toBe(authoringDigest(command("fixture-secret-two")));
    mocks.inspect.mockResolvedValue(receipt(first.requestId));
    await page.getByRole("button", { name: "保存修改秘密", exact: true }).click();
    await expect
      .element(
        page.getByText(
          "上次凭证还在确认中，请暂时保留刚才填写的内容。",
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.accepted).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "重试原请求", exact: true }).click();
    await vi.waitFor(() => expect(mocks.accepted).toHaveBeenCalledWith(receipt(first.requestId)));
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("刷新后命中原收据只确认旧操作，不声称新输入已经保存", async () => {
    setup();
    await using screen = await render(<Harness key="before" />);
    await page.getByRole("button", { name: "保存原秘密", exact: true }).click();
    await expect.element(page.getByText("本次输入未确认", { exact: true })).toBeVisible();
    const first = mocks.send.mock.calls[0]![1];
    mocks.inspect.mockResolvedValue(receipt(first.requestId));
    await screen.rerender(<Harness key="after" />);
    await expect
      .element(
        page.getByText(
          "请重新填写刚才的凭证后重试。",
          { exact: true },
        ),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "保存修改秘密", exact: true }).click();
    await expect
      .element(
        page.getByText(
          "上次凭证已保存。如需更换，请再次保存。",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect.element(page.getByText("本次输入未确认", { exact: true })).toBeVisible();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.accepted).toHaveBeenCalledWith(receipt(first.requestId));
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("刷新后无收据仍使用原标识重试，服务端秘密冲突保留原请求供核对", async () => {
    setup();
    await using screen = await render(<Harness key="before" />);
    await page.getByRole("button", { name: "保存原秘密", exact: true }).click();
    await expect.element(page.getByText("本次输入未确认", { exact: true })).toBeVisible();
    const first = mocks.send.mock.calls[0]![1];
    await screen.rerender(<Harness key="after" />);
    mocks.send.mockRejectedValue(
      new AutoOpsRequestError(
        "原请求秘密不一致，请核对原结果",
        "CREDENTIAL_REQUEST_CONFLICT",
        409,
        false,
      ),
    );
    await page.getByRole("button", { name: "保存修改秘密", exact: true }).click();
    await expect
      .element(page.getByText("原请求秘密不一致，请核对原结果", { exact: true }))
      .toBeVisible();
    expect(mocks.inspect).toHaveBeenCalledWith(
      "p-fixture",
      first.requestId,
      true,
      expect.any(AbortSignal),
    );
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[1]![1]).toEqual({
      ...first,
      command: command("fixture-secret-two"),
    });
    expect(JSON.parse(sessionStorage.getItem(storageKey)!).requestId).toBe(first.requestId);
    mocks.inspect.mockResolvedValue(receipt(first.requestId));
    await page.getByRole("button", { name: "核对原请求", exact: true }).click();
    await expect.element(page.getByText("没有待核对请求", { exact: true })).toBeVisible();
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("刷新后重输原秘密的成功响应可以确认，但请求标识始终不变", async () => {
    setup();
    await using screen = await render(<Harness key="before" />);
    await page.getByRole("button", { name: "保存原秘密", exact: true }).click();
    await expect.element(page.getByText("本次输入未确认", { exact: true })).toBeVisible();
    const first = mocks.send.mock.calls[0]![1];
    await screen.rerender(<Harness key="after" />);
    mocks.send.mockResolvedValue(receipt(first.requestId));
    await page.getByRole("button", { name: "保存原秘密", exact: true }).click();
    await expect.element(page.getByText("本次输入已保存", { exact: true })).toBeVisible();
    expect(mocks.send.mock.calls[1]![1]).toEqual(first);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("旧版凭证摘要会被清除，原请求标识仍可核对", () => {
    setup();
    const oldDigest = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(command()))));
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        requestId: "legacy-original",
        expectedRevision: 3,
        kind: "credential",
        digest: oldDigest,
      }),
    );
    expect(readAuthoringPending(storageKey)).toMatchObject({
      requestId: "legacy-original",
      digest: null,
      digestVersion: 2,
    });
    expect(sessionStorage.getItem(storageKey)).not.toContain(oldDigest);
    expect(readAuthoringPending(storageKey)?.requestId).toBe("legacy-original");
  });
});
