import { describe, expect, it, vi } from "vite-plus/test";
import { loadDeploymentServers, mutateDeploymentServer } from "./deploymentServersApi";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../apiClient", () => ({ autoOpsRequest: mocks.request }));

describe("部署节点请求边界", () => {
  it("读取限定项目和环境并传递取消信号", async () => {
    mocks.request
      .mockReset()
      .mockResolvedValue({ servers: [], availableServers: [], canAdmin: false });
    const signal = new AbortController().signal;
    await loadDeploymentServers("项目/一", "测试/二", signal);
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      `/autoops/projects/${encodeURIComponent("项目/一")}/deployments/servers?${new URLSearchParams({ environmentId: "测试/二" })}`,
      { label: "部署节点", signal },
    );
  });

  it("删除和策略写入保留原请求及并发版本，不丢弃DELETE请求体", async () => {
    mocks.request.mockReset().mockResolvedValue({ ok: true });
    const signal = new AbortController().signal;
    const input = { requestId: "original-delete-request" };
    await mutateDeploymentServer(
      "project",
      { kind: "delete", serverId: "node/one", input },
      signal,
    );
    expect(mocks.request).toHaveBeenLastCalledWith(
      "/autoops/projects/project/deployments/servers/node%2Fone",
      { label: "部署节点", method: "DELETE", body: input, signal },
    );
    const policy = {
      requestId: "original-policy-request",
      expectedRevision: 3,
      retainedVersions: 5,
      buildCacheGiB: 6,
    };
    await mutateDeploymentServer("project", {
      kind: "storage",
      serverId: "node/one",
      input: policy,
    });
    expect(mocks.request).toHaveBeenLastCalledWith(
      "/autoops/projects/project/deployments/servers/node%2Fone/storage-policy",
      { label: "部署节点", method: "PUT", body: policy },
    );
  });

  it("接入、绑定、解绑和撤销均走已授权的项目部署入口", async () => {
    mocks.request.mockReset().mockResolvedValue({ ok: true });
    const input = {
      name: "隔离节点",
      environmentId: "env-one",
      requestId: "original-create-request",
    };
    await mutateDeploymentServer("project", { kind: "create", input });
    expect(mocks.request).toHaveBeenLastCalledWith(
      "/autoops/projects/project/deployments/servers",
      { label: "部署节点", method: "POST", body: input },
    );
    for (const kind of ["bind", "unbind", "revoke"] as const) {
      const boundInput = { environmentId: "env-one", requestId: `original-${kind}-request` };
      await mutateDeploymentServer("project", { kind, serverId: "node-one", input: boundInput });
      expect(mocks.request).toHaveBeenLastCalledWith(
        `/autoops/projects/project/deployments/servers/node-one/${kind}`,
        { label: "部署节点", method: "POST", body: boundInput },
      );
    }
  });
});
