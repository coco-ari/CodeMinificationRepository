import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { AutoOpsRequestError } from "../apiClient";
import { DeploymentServers } from "./DeploymentServers";
import type { DeploymentGlobalNodeCatalog, DeploymentServerManagement } from "./deploymentServersApi";
import "../../index.css";

const mocks = vi.hoisted(() => ({ load: vi.fn(), mutate: vi.fn(), loadGlobal: vi.fn(), mutateGlobal: vi.fn() }));
vi.mock(import("./deploymentServersApi"), async (original) => ({
  ...(await original()),
  loadDeploymentServers: mocks.load,
  mutateDeploymentServer: mocks.mutate,
  loadGlobalDeploymentNodes: mocks.loadGlobal,
  mutateGlobalDeploymentNode: mocks.mutateGlobal,
}));

const fixture = (): DeploymentServerManagement => ({
  canAdmin: true,
  canBind: true,
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
const globalFixture = (): DeploymentGlobalNodeCatalog => ({
  servers: fixture().servers.map(({ environmentId: _environmentId, ...server }) => server),
  projects: [{ id: "p-nodes", name: "节点验收项目", environments: [{ id: "env-test", name: "测试环境" }] }],
  projectAccess: [{ projectId: "p-nodes", serverIds: [], revision: 1 }],
  bindings: [],
});
function setup() {
  mocks.load.mockReset().mockResolvedValue(fixture());
  mocks.mutate.mockReset().mockResolvedValue({ ok: true });
  mocks.loadGlobal.mockReset().mockResolvedValue(globalFixture());
  mocks.mutateGlobal.mockReset().mockResolvedValue({ ok: true });
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
function platformProps(props: ReturnType<typeof setup>) {
  const { projectId: _projectId, environmentId: _environmentId, ...common } = props;
  return { ...common, scope: "platform" as const };
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
    mocks.load.mockResolvedValue({ ...fixture(), canAdmin: false, canBind: false, availableServers: [] });
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
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: "撤销节点", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: "删除节点", exact: true }))
      .not.toBeInTheDocument();
  });

  it("创建后显示安装命令，不把一次性口令写入浏览器存储", async () => {
    const props = platformProps(setup());
    mocks.mutateGlobal.mockResolvedValue({
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
    expect(mocks.mutateGlobal.mock.calls[0]?.[0]).toMatchObject({
      kind: "create",
      input: { name: "隔离新节点", requestId: expect.any(String) },
    });
    expect(JSON.stringify(sessionStorage)).not.toContain("isolated-registration-token");
    expect(JSON.stringify(sessionStorage)).not.toContain("isolated-install-command");
    expect(props.onChanged).toHaveBeenCalledOnce();
  });

  it("未知创建结果在关闭再打开后仍重试原请求，不能另建重复节点", async () => {
    const props = platformProps(setup());
    mocks.mutateGlobal
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
    const original = structuredClone(mocks.mutateGlobal.mock.calls[0]?.[0]);
    await screen.rerender(<DeploymentServers {...props} open={false} />);
    await screen.rerender(<DeploymentServers {...props} />);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(mocks.mutateGlobal.mock.calls[1]?.[0]).toEqual(original);
    await expect
      .element(page.getByText("节点已创建。安装口令仅在首次创建时提供，请使用已保存的安装命令。"))
      .toBeVisible();
  });

  it("存储保存携带已读取的策略版本，拒绝后保留错误并允许修改", async () => {
    const props = platformProps(setup());
    mocks.mutateGlobal.mockRejectedValue(
      new AutoOpsRequestError("存储策略已更新，请刷新后重试", "DEPLOYMENT_POLICY_CHANGED", 409),
    );
    await using screen = await render(<DeploymentServers {...props} />);
    await menu("查看节点");
    await page.getByRole("spinbutton", { name: "保留成功版本数" }).fill("5");
    await page.getByRole("button", { name: "保存存储设置", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("存储策略已更新，请刷新后重试");
    expect(mocks.mutateGlobal.mock.calls[0]?.[0]).toMatchObject({
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
    const props = platformProps(setup());
    mocks.mutateGlobal
      .mockRejectedValueOnce(
        new AutoOpsRequestError("连接中断", "CONNECTION_FAILED", undefined, true),
      )
      .mockResolvedValueOnce({ ok: true });
    await using screen = await render(<DeploymentServers {...props} />);
    await menu("删除节点");
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    const original = structuredClone(mocks.mutateGlobal.mock.calls[0]?.[0]);
    mocks.loadGlobal.mockResolvedValue({ ...globalFixture(), servers: [] });
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.getByRole("button", { name: "刷新节点", exact: true }).click();
    await expect.element(page.getByText("暂无部署节点", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(mocks.mutateGlobal.mock.calls[1]?.[0]).toEqual(original);
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
    const props = platformProps(setup());
    mocks.mutateGlobal.mockRejectedValue(new AutoOpsRequestError("当前权限已撤销", "ACCESS_DENIED", 403));
    await using screen = await render(<DeploymentServers {...props} />);
    await menu("撤销节点");
    await page.getByRole("button", { name: "确认撤销", exact: true }).click();
    await vi.waitFor(() => expect(props.onAccessDenied).toHaveBeenCalledOnce());
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    await screen.rerender(<DeploymentServers {...props} open={false} />);
    await expect.element(page.getByText("隔离部署节点", { exact: true })).not.toBeInTheDocument();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it("项目管理员仅绑定已准入节点，平台管理标记不能开放全局操作", async () => {
    const props = setup();
    await using screen = await render(<DeploymentServers {...props} />);
    await page.getByRole("button", { name: "绑定已有节点", exact: true }).click();
    await expect.element(page.getByRole("combobox", { name: "已有节点", exact: true })).toHaveTextContent("共享节点");
    await page.getByRole("button", { name: "确认绑定", exact: true }).click();
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(mocks.mutate.mock.calls[0]?.slice(0, 2)).toEqual([
      "p-nodes",
      { kind: "bind", serverId: "shared-node", input: { environmentId: "env-test", requestId: expect.any(String) } },
    ]);
    await expect.element(page.getByRole("button", { name: "接入节点", exact: true })).not.toBeInTheDocument();
    await menu("查看节点");
    await expect.element(page.getByRole("spinbutton", { name: "保留成功版本数", exact: true })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "保存存储设置", exact: true })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.getByRole("button", { name: "隔离部署节点的操作", exact: true }).click();
    await expect.element(page.getByRole("menuitem", { name: "解绑节点", exact: true })).toBeVisible();
    for (const name of ["项目准入", "撤销节点", "删除节点"])
      await expect.element(page.getByRole("menuitem", { name, exact: true })).not.toBeInTheDocument();
    expect(mocks.loadGlobal).not.toHaveBeenCalled();
    expect(mocks.mutateGlobal).not.toHaveBeenCalled();
  });

  it("平台明确允许项目后可撤回，准入修改携带已读版本且不绑定环境", async () => {
    const props = platformProps(setup());
    let catalog = globalFixture();
    mocks.loadGlobal.mockImplementation(async () => catalog);
    mocks.mutateGlobal.mockImplementation(async (operation) => {
      catalog = { ...catalog, projectAccess: [{ projectId: "p-nodes", serverIds: operation.input.allowed ? ["node-one"] : [], revision: catalog.projectAccess[0]!.revision + 1 }] };
      return { ok: true };
    });
    await using screen = await render(<DeploymentServers {...props} />);
    await menu("项目准入");
    await page.getByRole("button", { name: "允许节点验收项目使用节点", exact: true }).click();
    await expect.element(page.getByText("允许“节点验收项目”使用“隔离部署节点”。项目管理员可将其绑定到环境。", { exact: true })).toBeVisible();
    expect(mocks.mutateGlobal).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "确认允许", exact: true }).click();
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(mocks.mutateGlobal.mock.calls[0]?.[0]).toEqual({ kind: "access", serverId: "node-one", projectId: "p-nodes", input: { allowed: true, expectedRevision: 1, requestId: expect.any(String) } });
    await menu("项目准入");
    await expect.element(page.getByText("已准入", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "撤回节点验收项目使用节点", exact: true }).click();
    await expect.element(page.getByText(/拒绝新部署与排队任务领取/)).toBeVisible();
    await page.getByRole("button", { name: "确认撤回", exact: true }).click();
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(2));
    expect(mocks.mutateGlobal.mock.calls[1]?.[0]).toEqual({ kind: "access", serverId: "node-one", projectId: "p-nodes", input: { allowed: false, expectedRevision: 2, requestId: expect.any(String) } });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("准入并发冲突显示真实错误，刷新后重新确认新版本", async () => {
    const props = platformProps(setup());
    mocks.mutateGlobal.mockRejectedValueOnce(new AutoOpsRequestError("项目节点准入已变化，请刷新后重试", "DEPLOYMENT_SERVER_ACCESS_CHANGED", 409)).mockResolvedValueOnce({ ok: true });
    await using screen = await render(<DeploymentServers {...props} />);
    await menu("项目准入");
    await page.getByRole("button", { name: "允许节点验收项目使用节点", exact: true }).click();
    await page.getByRole("button", { name: "确认允许", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("项目节点准入已变化，请刷新后重试");
    expect(props.onChanged).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "重试", exact: true })).not.toBeInTheDocument();
    const original = mocks.mutateGlobal.mock.calls[0]?.[0];
    mocks.loadGlobal.mockResolvedValue({ ...globalFixture(), projectAccess: [{ projectId: "p-nodes", serverIds: [], revision: 3 }] });
    await page.getByRole("button", { name: "返回", exact: true }).click();
    const before = mocks.loadGlobal.mock.calls.length;
    await page.getByRole("button", { name: "刷新节点", exact: true }).click();
    await vi.waitFor(() => expect(mocks.loadGlobal.mock.calls.length).toBeGreaterThan(before));
    await expect.element(page.getByRole("button", { name: "刷新节点", exact: true })).toBeEnabled();
    await menu("项目准入");
    await page.getByRole("button", { name: "允许节点验收项目使用节点", exact: true }).click();
    expect(mocks.mutateGlobal).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: "确认允许", exact: true }).click();
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(mocks.mutateGlobal.mock.calls[1]?.[0].input).toMatchObject({ allowed: true, expectedRevision: 3 });
    expect(mocks.mutateGlobal.mock.calls[1]?.[0].input.requestId).not.toBe(original.input.requestId);
  });

  it("已撤回准入只显示绑定事实，保留解绑清理并隐藏节点观测", async () => {
    const props = setup();
    mocks.load.mockResolvedValue({ canAdmin: false, canBind: true, availableServers: [], servers: [{ id: "node-one", name: "隔离部署节点", environmentId: "env-test", projectAllowed: false }] });
    await using screen = await render(<DeploymentServers {...props} />);
    await expect.element(page.getByText("准入已撤回", { exact: true })).toBeVisible();
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("CPU");
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("test-build");
    await expect.element(page.getByRole("button", { name: "绑定已有节点", exact: true })).toBeDisabled();
    await menu("解绑节点");
    await page.getByRole("button", { name: "确认解绑", exact: true }).click();
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(mocks.mutate.mock.calls[0]?.[1]).toMatchObject({ kind: "unbind", serverId: "node-one", input: { environmentId: "env-test" } });
    expect(mocks.mutateGlobal).not.toHaveBeenCalled();
  });

  it("读取失败保留重试入口，读取撤权则清除已经展示的节点", async () => {
    const props = platformProps(setup());
    mocks.loadGlobal.mockRejectedValueOnce(new AutoOpsRequestError("节点目录暂时不可用", "DEPLOYMENT_UNAVAILABLE", 503)).mockResolvedValueOnce(globalFixture());
    await using screen = await render(<DeploymentServers {...props} />);
    await expect.element(page.getByRole("alert")).toHaveTextContent("节点目录暂时不可用");
    await page.getByRole("button", { name: "刷新节点", exact: true }).click();
    await expect.element(page.getByText("隔离部署节点", { exact: true })).toBeVisible();
    mocks.loadGlobal.mockRejectedValueOnce(new AutoOpsRequestError("平台节点管理权限已撤回", "ACCESS_DENIED", 403));
    await page.getByRole("button", { name: "刷新节点", exact: true }).click();
    await vi.waitFor(() => expect(props.onAccessDenied).toHaveBeenCalledOnce());
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    await expect.element(page.getByText("隔离部署节点", { exact: true })).not.toBeInTheDocument();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it("写入已保存但最终撤权时清除口令和待处理记录，不伪装有权查看结果", async () => {
    const props = platformProps(setup());
    mocks.mutateGlobal.mockResolvedValue({ saved: true, available: false });
    await using screen = await render(<DeploymentServers {...props} />);
    await expect.element(page.getByRole("button", { name: "接入节点", exact: true })).toBeEnabled();
    await createNode();
    await vi.waitFor(() => expect(props.onAccessDenied).toHaveBeenCalledOnce());
    expect(props.onAccessDenied.mock.calls[0]?.[0].message).toContain("操作已保存");
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    await expect.element(page.getByText("隔离部署节点", { exact: true })).not.toBeInTheDocument();
    expect(Object.keys(sessionStorage).filter(key => key.startsWith("autoops:deployment-servers:"))).toHaveLength(0);
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it("关闭平台节点取消旧读取，迟到响应不恢复平台数据或触发结果回调", async () => {
    const props = platformProps(setup());
    let complete!: (value: DeploymentGlobalNodeCatalog) => void;
    mocks.loadGlobal.mockReturnValueOnce(new Promise<DeploymentGlobalNodeCatalog>(resolve => { complete = resolve; }));
    await using screen = await render(<DeploymentServers {...props} />);
    await vi.waitFor(() => expect(mocks.loadGlobal).toHaveBeenCalledOnce());
    const signal = mocks.loadGlobal.mock.calls[0]?.[0] as AbortSignal;
    await screen.rerender(<DeploymentServers {...props} open={false} />);
    expect(signal.aborted).toBe(true);
    await act(async () => { complete(globalFixture()); await Promise.resolve(); });
    await expect.element(page.getByText("隔离部署节点", { exact: true })).not.toBeInTheDocument();
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(props.onAccessDenied).not.toHaveBeenCalled();
  });

  it("切出平台时迟到写入不泄露口令，返回平台仍核对原请求", async () => {
    const common = setup();
    const props = platformProps(common);
    let complete!: (value: unknown) => void;
    mocks.mutateGlobal.mockReturnValueOnce(new Promise(resolve => { complete = resolve; })).mockResolvedValueOnce({ server: globalFixture().servers[0], registrationToken: null, expiresAt: null, repeated: true });
    await using screen = await render(<DeploymentServers {...props} />);
    await expect.element(page.getByRole("button", { name: "接入节点", exact: true })).toBeEnabled();
    await createNode();
    await vi.waitFor(() => expect(mocks.mutateGlobal).toHaveBeenCalledOnce());
    const original = structuredClone(mocks.mutateGlobal.mock.calls[0]?.[0]);
    const signal = mocks.mutateGlobal.mock.calls[0]?.[1] as AbortSignal;
    await screen.rerender(<DeploymentServers {...common} />);
    await expect.element(page.getByRole("button", { name: "绑定已有节点", exact: true })).toBeEnabled();
    expect(signal.aborted).toBe(true);
    await act(async () => { complete({ server: globalFixture().servers[0], registrationToken: "late-secret", expiresAt: "2026-10-25T09:00:00Z", installCommand: "late-install-secret" }); await Promise.resolve(); });
    expect(document.body.textContent).not.toContain("late-install-secret");
    expect(props.onChanged).not.toHaveBeenCalled();
    await screen.rerender(<DeploymentServers {...props} />);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(mocks.mutateGlobal.mock.calls[1]?.[0]).toEqual(original);
    await expect.element(page.getByText("节点已创建。安装口令仅在首次创建时提供，请使用已保存的安装命令。")).toBeVisible();
    expect(JSON.stringify(sessionStorage)).not.toContain("late-secret");
  });
});
