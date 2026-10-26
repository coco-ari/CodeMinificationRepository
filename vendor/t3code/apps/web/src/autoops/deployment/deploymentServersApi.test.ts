import { describe, expect, it, vi } from "vite-plus/test";
import { loadDeploymentServers, mutateDeploymentServer, loadGlobalDeploymentNodes, mutateGlobalDeploymentNode, loadGlobalDeploymentNodeReceipt, loadDeploymentNodeReceipt, matchesDeploymentNodeReceipt, type DeploymentNodeReceipt, type DeploymentServerMutation } from "./deploymentServersApi";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../apiClient", () => ({ autoOpsRequest: mocks.request }));

describe("部署节点请求边界", () => {
  it("读取限定项目和环境并传递取消信号", async () => {
    mocks.request
      .mockReset()
      .mockResolvedValue({ servers: [], availableServers: [], canAdmin: false, canBind: true });
    const signal = new AbortController().signal;
    await loadDeploymentServers("项目/一", "测试/二", signal);
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      `/autoops/projects/${encodeURIComponent("项目/一")}/deployments/servers?${new URLSearchParams({ environmentId: "测试/二" })}`,
      { label: "部署节点", signal },
    );
  });

  it("全局删除和策略写入保留原请求及并发版本，不依赖项目和环境", async () => {
    mocks.request.mockReset().mockResolvedValue({ ok: true });
    const signal = new AbortController().signal;
    const input = { requestId: "original-delete-request" };
    await mutateGlobalDeploymentNode(
      { kind: "delete", serverId: "node/one", input },
      signal,
    );
    expect(mocks.request).toHaveBeenLastCalledWith(
      "/autoops/deployment-servers/node%2Fone",
      { label: "平台节点", method: "DELETE", body: input, signal },
    );
    const policy = {
      requestId: "original-policy-request",
      expectedRevision: 3,
      retainedVersions: 5,
      buildCacheGiB: 6,
    };
    await mutateGlobalDeploymentNode({
      kind: "storage",
      serverId: "node/one",
      input: policy,
    });
    expect(mocks.request).toHaveBeenLastCalledWith(
      "/autoops/deployment-servers/node%2Fone/storage-policy",
      { label: "平台节点", method: "PUT", body: policy },
    );
  });

  it("项目入口只发起环境绑定和解绑，全局接入不携带环境或隐式绑定", async () => {
    mocks.request.mockReset().mockResolvedValue({ ok: true });
    const input = {
      name: "隔离节点",
      requestId: "original-create-request",
    };
    await loadGlobalDeploymentNodes();
    expect(mocks.request).toHaveBeenLastCalledWith("/autoops/deployment-servers", { label: "平台节点" });
    await mutateGlobalDeploymentNode({ kind: "create", input });
    expect(mocks.request).toHaveBeenLastCalledWith(
      "/autoops/deployment-servers",
      { label: "平台节点", method: "POST", body: input },
    );
    for (const kind of ["bind", "unbind"] as const) {
      const boundInput = { environmentId: "env-one", requestId: `original-${kind}-request` };
      await mutateDeploymentServer("project", { kind, serverId: "node-one", input: boundInput });
      expect(mocks.request).toHaveBeenLastCalledWith(
        `/autoops/projects/project/deployments/servers/node-one/${kind}`,
        { label: "部署节点", method: "POST", body: boundInput },
      );
    }
  });

  it("项目准入保留当前版本和原请求，撤销节点始终走全局入口", async () => {
    mocks.request.mockReset().mockResolvedValue({ ok: true });
    const input = { allowed: false, expectedRevision: 7, requestId: "original-access-request" };
    await mutateGlobalDeploymentNode({kind: "access", serverId: "node/one", projectId: "project/two", input});
    expect(mocks.request).toHaveBeenLastCalledWith("/autoops/deployment-servers/node%2Fone/projects/project%2Ftwo", {
      label: "平台节点", method: "POST", body: input,
    });
    const revoke = {requestId: "original-revoke-request"};
    await mutateGlobalDeploymentNode({kind: "revoke", serverId: "node/one", input: revoke});
    expect(mocks.request).toHaveBeenLastCalledWith("/autoops/deployment-servers/node%2Fone/revoke", {
      label: "平台节点", method: "POST", body: revoke,
    });
  });
});


it("未知结果核对仅GET原requestId并固定平台/项目环境，不携带写入正文", async () => {
  mocks.request.mockReset().mockResolvedValue(null);
  const signal = new AbortController().signal;
  expect(await loadGlobalDeploymentNodeReceipt("original/request", signal)).toBeNull();
  expect(mocks.request).toHaveBeenLastCalledWith("/autoops/deployment-servers/receipts/original%2Frequest", { label: "平台节点原收据", allowNull: true, signal });
  expect(await loadDeploymentNodeReceipt("project/one", "env/two", "original/request", signal)).toBeNull();
  expect(mocks.request).toHaveBeenLastCalledWith(`/autoops/projects/project%2Fone/deployments/servers/receipts/original%2Frequest?${new URLSearchParams({ environmentId: "env/two" })}`, { label: "部署节点原收据", allowNull: true, signal });
});

it("七类节点收据逐项核对公开原参数，参数篡改及缺失不能确认原pending", () => {
  const requestId = "original-request", serverId = "node-one";
  const cases: Array<{ pending: DeploymentServerMutation; intent: DeploymentNodeReceipt["publicIntent"]; scope: { projectId?: string; environmentId?: string } }> = [
    { pending: { kind: "create", input: { requestId, name: "原节点" } }, intent: { name: "原节点" }, scope: {} },
    { pending: { kind: "access", serverId, projectId: "project-one", input: { requestId, allowed: true, expectedRevision: 3 } }, intent: { serverId, projectId: "project-one", allowed: true, expectedRevision: 3 }, scope: {} },
    { pending: { kind: "storage", serverId, input: { requestId, expectedRevision: 3, retainedVersions: 4, buildCacheGiB: 6 } }, intent: { serverId, expectedRevision: 3, retainedVersions: 4, buildCacheGiB: 6 }, scope: {} },
    ...(["bind", "unbind"] as const).map(kind => ({ pending: { kind, serverId, input: { requestId, environmentId: "test" } }, intent: { serverId, environmentId: "test" }, scope: { projectId: "project-one", environmentId: "test" } })),
    ...(["revoke", "delete"] as const).map(kind => ({ pending: { kind, serverId, input: { requestId } }, intent: { serverId }, scope: {} })),
  ];
  for (const { pending, intent, scope } of cases) {
    const original = structuredClone(pending);
    const receipt: DeploymentNodeReceipt = { state: "completed", requestId, operation: pending.kind, projectId: scope.projectId ?? null, environmentId: scope.environmentId ?? null, serverId, ...(pending.kind === "access" ? { targetProjectId: pending.projectId } : {}), publicIntent: intent, result: { ok: true } };
    expect(matchesDeploymentNodeReceipt(pending, receipt, scope)).toBe(true);
    for (const [key, value] of Object.entries(intent)) {
      const changed = typeof value === "boolean" ? !value : typeof value === "number" ? value + 1 : `${value}-changed`;
      expect(matchesDeploymentNodeReceipt(pending, { ...receipt, publicIntent: { ...intent, [key]: changed } }, scope)).toBe(false);
    }
    expect(matchesDeploymentNodeReceipt(pending, { ...receipt, publicIntent: undefined as unknown as DeploymentNodeReceipt["publicIntent"] }, scope)).toBe(false);
    const extraIntent = { ...intent, extra: "不属于原参数" };
    expect(matchesDeploymentNodeReceipt(pending, { ...receipt, publicIntent: extraIntent }, scope)).toBe(false);
    expect(pending).toEqual(original);
  }
});
