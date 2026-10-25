import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { AutoOpsRequestError } from "../apiClient";
import { DeploymentServers } from "./DeploymentServers";
import type { DeploymentServerManagement } from "./deploymentServersApi";
import "../../index.css";

const mocks = vi.hoisted(() => ({ load: vi.fn(), mutate: vi.fn() }));
vi.mock(import("./deploymentServersApi"), async (original) => ({
  ...(await original()),
  loadDeploymentServers: mocks.load,
  mutateDeploymentServer: mocks.mutate,
}));

const fixture = (): DeploymentServerManagement => ({
  canAdmin: true,
  availableServers: [{ id: "shared-node", name: "共享节点", online: true }],
  servers: [
    {
      id: "node-one",
      name: "隔离部署节点",
      environmentId: "env-test",
      online: true,
      lastSeenAt: "2026-10-25T08:00:00Z",
      version: "test-build",
      metrics: {
        cpuPercent: 12.5,
        memory: { used: 1024 ** 3, total: 4 * 1024 ** 3 },
        disk: { used: 8 * 1024 ** 3, total: 32 * 1024 ** 3 },
        centerRttMs: 28,
      },
      storagePolicy: { revision: 3, retainedVersions: 4, buildCacheGiB: 6 },
      storageState: "applied",
    },
  ],
});
function setup() {
  mocks.load.mockReset().mockResolvedValue(fixture());
  mocks.mutate.mockReset().mockResolvedValue({ ok: true });
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith("autoops:deployment-servers:")) sessionStorage.removeItem(key);
  return {
    projectId: "p-nodes",
    environmentId: "env-test",
    open: true,
    finalFocus: false as const,
    onOpenChange: vi.fn(),
    onAccessDenied: vi.fn(),
    onChanged: vi.fn(),
  };
}
async function menu(name: string) {
  await page.getByRole("button", { name: "隔离部署节点的操作", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function createNode() {
  await page.getByRole("button", { name: "接入节点", exact: true }).click();
  await page.getByRole("textbox", { name: "节点名称", exact: true }).fill("隔离新节点");
  await page.getByRole("button", { name: "生成安装命令", exact: true }).click();
}

describe("部署节点管理", () => {
  it("显示有时间来源的资源观测，普通管理者不显示共享节点管理入口", async () => {
    const props = setup();
    mocks.load.mockResolvedValue({ ...fixture(), canAdmin: false, availableServers: [] });
    await using screen = await render(<DeploymentServers {...props} />);
    await expect.element(page.getByText("隔离部署节点", { exact: true })).toBeVisible();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("CPU 12.5%");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("1 GiB / 4 GiB");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("RTT 28 ms");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("2026");
    await expect
      .element(page.getByRole("button", { name: "绑定已有节点", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "隔离部署节点的操作", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "解绑节点", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: "撤销节点", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: "删除节点", exact: true }))
      .not.toBeInTheDocument();
  });

  it("创建后显示安装命令，不把一次性口令写入浏览器存储", async () => {
    const props = setup();
    mocks.mutate.mockResolvedValue({
      server: fixture().servers[0],
      registrationToken: "isolated-registration-token",
      expiresAt: "2026-10-25T09:00:00Z",
      installCommand: "echo isolated-install-command",
    });
    await using screen = await render(<DeploymentServers {...props} />);
    await expect.element(page.getByRole("button", { name: "接入节点", exact: true })).toBeEnabled();
    await createNode();
    await expect
      .element(page.getByText("echo isolated-install-command", { exact: true }))
      .toBeVisible();
    expect(mocks.mutate.mock.calls[0]?.[1]).toMatchObject({
      kind: "create",
      input: { name: "隔离新节点", environmentId: "env-test", requestId: expect.any(String) },
    });
    expect(JSON.stringify(sessionStorage)).not.toContain("isolated-registration-token");
    expect(JSON.stringify(sessionStorage)).not.toContain("isolated-install-command");
    expect(props.onChanged).toHaveBeenCalledOnce();
  });

  it("未知创建结果在关闭再打开后仍重试原请求，不能另建重复节点", async () => {
    const props = setup();
    mocks.mutate
      .mockRejectedValueOnce(
        new AutoOpsRequestError("连接中断", "CONNECTION_FAILED", undefined, true),
      )
      .mockResolvedValueOnce({
        server: fixture().servers[0],
        registrationToken: null,
        expiresAt: null,
        repeated: true,
      });
    await using screen = await render(<DeploymentServers {...props} />);
    await expect.element(page.getByRole("button", { name: "接入节点", exact: true })).toBeEnabled();
    await createNode();
    await expect.element(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    const original = structuredClone(mocks.mutate.mock.calls[0]?.[1]);
    await screen.rerender(<DeploymentServers {...props} open={false} />);
    await screen.rerender(<DeploymentServers {...props} />);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(mocks.mutate.mock.calls[1]?.[1]).toEqual(original);
    await expect
      .element(page.getByText("节点已创建。安装口令仅在首次创建时提供，请使用已保存的安装命令。"))
      .toBeVisible();
  });

  it("存储保存携带已读取的策略版本，拒绝后保留错误并允许修改", async () => {
    const props = setup();
    mocks.mutate.mockRejectedValue(
      new AutoOpsRequestError("存储策略已更新，请刷新后重试", "DEPLOYMENT_POLICY_CHANGED", 409),
    );
    await using screen = await render(<DeploymentServers {...props} />);
    await menu("查看节点");
    await page.getByRole("spinbutton", { name: "保留成功版本数" }).fill("5");
    await page.getByRole("button", { name: "保存存储设置", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("存储策略已更新，请刷新后重试");
    expect(mocks.mutate.mock.calls[0]?.[1]).toMatchObject({
      kind: "storage",
      serverId: "node-one",
      input: {
        expectedRevision: 3,
        retainedVersions: 5,
        buildCacheGiB: 6,
        requestId: expect.any(String),
      },
    });
    await expect.element(page.getByRole("spinbutton", { name: "保留成功版本数" })).toBeEnabled();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it("删除结果未知后即使节点不再列出也沿用原请求核对", async () => {
    const props = setup();
    mocks.mutate
      .mockRejectedValueOnce(
        new AutoOpsRequestError("连接中断", "CONNECTION_FAILED", undefined, true),
      )
      .mockResolvedValueOnce({ ok: true });
    await using screen = await render(<DeploymentServers {...props} />);
    await menu("删除节点");
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    const original = structuredClone(mocks.mutate.mock.calls[0]?.[1]);
    mocks.load.mockResolvedValue({ ...fixture(), servers: [] });
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.getByRole("button", { name: "刷新节点", exact: true }).click();
    await expect.element(page.getByText("暂无部署节点", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(mocks.mutate.mock.calls[1]?.[1]).toEqual(original);
  });

  it("切项目取消旧读取，迟到响应不会恢复旧节点", async () => {
    const props = setup();
    let complete!: (value: DeploymentServerManagement) => void;
    mocks.load.mockReturnValueOnce(
      new Promise<DeploymentServerManagement>((resolve) => {
        complete = resolve;
      }),
    );
    await using screen = await render(<DeploymentServers {...props} />);
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
    const oldSignal = mocks.load.mock.calls[0]?.[2] as AbortSignal;
    mocks.load.mockResolvedValue({ ...fixture(), servers: [] });
    await screen.rerender(<DeploymentServers {...props} projectId="p-other" />);
    await expect.element(page.getByText("暂无部署节点", { exact: true })).toBeVisible();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => {
      complete(fixture());
      await Promise.resolve();
    });
    await expect.element(page.getByText("隔离部署节点", { exact: true })).not.toBeInTheDocument();
  });

  it("服务端撤权后清除节点与操作，不保留旧数据", async () => {
    const props = setup();
    mocks.mutate.mockRejectedValue(new AutoOpsRequestError("当前权限已撤销", "ACCESS_DENIED", 403));
    await using screen = await render(<DeploymentServers {...props} />);
    await menu("撤销节点");
    await page.getByRole("button", { name: "确认撤销", exact: true }).click();
    await vi.waitFor(() => expect(props.onAccessDenied).toHaveBeenCalledOnce());
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    await screen.rerender(<DeploymentServers {...props} open={false} />);
    await expect.element(page.getByText("隔离部署节点", { exact: true })).not.toBeInTheDocument();
    expect(props.onChanged).not.toHaveBeenCalled();
  });
});
