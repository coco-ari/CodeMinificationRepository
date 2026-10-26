import { expect, it, vi } from "vite-plus/test";
import { installAutoOpsHost } from "./hostConfig";
import { loadAssistantManagement } from "./projectAssistants";
import { AutoOpsRequestError } from "./apiClient";
import { loadProjectProvidedAssistants } from "./providedAssistants";

function context() {
  installAutoOpsHost(
    {
      principal: { id: "management-user", displayName: "管理者" },
      csrfToken: "management-csrf",
      gatewayBasePath: "/api/agent-demo/t3",
      fixedModel: { instanceId: "codex", model: "actual-model" },
      runtimeMode: "approval-required",
      capabilities: {},
      projects: [],
    },
    "https://work.test",
  );
}

it("原接口保留真实403，不会把撤权改写为临时连接失败", async () => {
  context();
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({ error: "项目管理权已撤回", code: "PROJECT_FORBIDDEN" }, { status: 403 }),
    );
  await expect(loadProjectProvidedAssistants("project-one")).rejects.toMatchObject({
    name: AutoOpsRequestError.name,
    status: 403,
    code: "PROJECT_FORBIDDEN",
  });
});

it("并行读取中503不能掩盖其他接口已明确返回的403，撤权优先清除旧管理内容", async () => {
  context();
  const paths: string[] = [];
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith("/settings") && !path.endsWith("/assistants/settings")) {
      return Response.json({ error: "项目读取暂不可用", code: "OFFLINE" }, { status: 503 });
    }
    if (path.endsWith("/assistants/provided")) {
      return Response.json(
        { error: "项目管理权已撤回", code: "PROJECT_FORBIDDEN" },
        { status: 403 },
      );
    }
    return Response.json(
      path.endsWith("/choices")
        ? { sources: [], agents: [], platformSkills: [] }
        : { presets: [], allocations: [] },
    );
  });
  await expect(loadAssistantManagement("project-one")).rejects.toMatchObject({
    name: AutoOpsRequestError.name,
    status: 403,
    code: "PROJECT_FORBIDDEN",
  });
  expect(paths).toHaveLength(4);
});
