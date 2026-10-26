import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render, stubGlobal } from "../../test/render";
import { Sidebar, SidebarContent, SidebarProvider } from "~/components/ui/sidebar";
import { ModuleSidebarProvider, ModuleSidebarOutlet } from "./ModuleWorkspace";
import { AssistantManagementPage } from "./AssistantManagementPage";
import { installAutoOpsHost, readAutoOpsHost } from "./hostConfig";
import type {
  AssistantPreset,
  ProvidedAssistantSettings,
  ProvidedAssistantReceipt,
  ProvidedAssistantShare,
} from "../../../../../../autoops/contracts/assistants.ts";
import "../index.css";

function setup(manage = false) {
  sessionStorage.clear();
  const source = {
    kind: "customer" as const,
    deviceId: "device-one",
    registeredWorkspaceId: "directory-one",
    workspaceBindingRevision: 2,
    runtimeId: "codex" as const,
  };
  const ownerPreset: AssistantPreset = {
    id: "own-preset",
    projectId: "source-project",
    name: "本人排障助手",
    description: "",
    instructions: "",
    enabled: true,
    configuration: {
      agentId: "a-project",
      executionBinding: source,
      environmentId: null,
      workspaceType: null,
      visibility: "private",
      model: {
        instanceId: "customer-device-one-codex",
        model: "actual-local-model",
        reasoningEffort: "high",
      },
      skillIds: [],
    },
    revision: 1,
    createdBy: "assistant-page-user",
    updatedAt: "2026-10-26T00:00:00Z",
    providedBy: { id: "assistant-page-user", name: "本人", sourceProjectId: "source-project" },
  };
  const platform: AssistantPreset = {
    ...ownerPreset,
    id: "project-preset",
    projectId: "target-project",
    name: "项目预设",
    configuration: {
      ...ownerPreset.configuration,
      executionBinding: { kind: "platform" },
      workspaceType: "internal",
      model: { instanceId: "codex", model: "actual-platform-model", reasoningEffort: "low" },
    },
  };
  delete platform.providedBy;
  const foreign: AssistantPreset = {
    ...ownerPreset,
    id: "foreign-preset",
    projectId: "target-project",
    name: "他人已共享助手",
    configuration: {
      ...ownerPreset.configuration,
      executionBinding: { ...source, deviceId: "provider-device", registeredWorkspaceId: "provider-directory" },
      customerProfile: { ...isolatedProfile },
      model: { instanceId: "customer-provider-device-codex", model: "isolated-model", reasoningEffort: "high" },
      skillIds: ["isolated-skill"],
    },
    providedBy: { id: "other-provider", name: "提供者甲", sourceProjectId: "source-project" },
  };
  const own: ProvidedAssistantSettings = {
    items: [{ preset: ownerPreset, shares: [] }],
    sources: [
      {
        executionBinding: source,
        sourceProjectId: "source-project",
        deviceName: "本人电脑",
        workspaceName: "登记目录",
        deviceStatus: "active",
        workspaceStatus: "active",
        online: true,
        capabilities: {
          ...source,
          revision: "live-capabilities",
          protocolVersion: 1,
          updatedAt: "2026-10-26T00:00:00Z",
          assistantConfiguration: true,
          models: [
            {
              id: "actual-local-model",
              name: "真实本机模型",
              supportedReasoningEfforts: ["low", "high"],
              defaultReasoningEffort: "high",
            },
          ],
          skills: [{ id: "local-skill", name: "本机只读技能", description: "" }],
        },
      },
    ],
  };
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [],
    receipts = new Map<string, ProvidedAssistantReceipt>(),
    allocations: Array<Record<string, unknown>> = [];
  const state = {
    lost: false,
    denied: false,
    read503: 0,
    receipt503: 0,
    conflict: false,
    projectMixed: false,
    savedUnavailable: false,
    assignable: false,
    targetScopeError: false,
    sharedWithdrawn: false,
  };
  const projects = ["source-project", "target-project"].map((id) => ({
    id,
    name: id === "source-project" ? "来源项目" : "目标项目",
    agents: [{ id: "a-project", name: "项目助手" }],
    environments: [],
    capabilities: {
      "project.manage": manage,
      "chat.use": true,
      "chat.configure": false,
      "workspace.read": true,
      "workspace.manage": false,
      "deployment.read": false,
      "deployment.execute": false,
    },
    assistants: {
      items: [
        { preset: platform, available: true },
        {
          preset: foreign,
          available: false,
          reason: { code: "ASSISTANT_NOT_ASSIGNED", message: "当前管理员未获分配此助手" },
        },
      ],
      defaultAssistantId: platform.id,
      ready: true,
      canAdjust: false,
    },
  }));
  const bootstrap = () => ({
    principal: { id: "assistant-page-user", displayName: "助手用户" },
    csrfToken: "assistant-csrf",
    gatewayBasePath: "/api/agent-demo/t3",
    fixedModel: { instanceId: "codex", model: "wrong-platform-default" },
    runtimeMode: "approval-required" as const,
    customerAgentsEnabled: true,
    assistantDirectoryEnabled: true,
    capabilities: {},
    projects,
  });
  installAutoOpsHost(bootstrap(), window.location.origin);
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname.replace(
      /^\/api\/agent-demo\/t3/,
      "",
    );
    if (path === "/autoops/bootstrap") return Response.json(bootstrap());
    if (path === "/autoops/customer/devices")
      return Response.json({
        devices: [
          {
            id: "device-one",
            ownerId: "assistant-page-user",
            label: "本人电脑",
            status: "active",
            online: true,
            connectionEpoch: 1,
            createdAt: "2026-10-26T00:00:00Z",
          },
        ],
      });
    if (path.startsWith("/autoops/customer/workspaces"))
      return Response.json({
        workspaces: [
          {
            registeredWorkspaceId: "directory-one",
            deviceId: "device-one",
            ownerId: "assistant-page-user",
            projectId: "source-project",
            label: "登记目录",
            workspaceBindingRevision: 2,
            runtimeId: "codex",
            status: "active",
            createdAt: "now",
            updatedAt: "now",
          },
        ],
      });
    if (path === "/autoops/customer/pairings") {
      writes.push({ path, body: JSON.parse(String(init?.body)) });
      return Response.json({
        pairingCode: "isolated-pair-code",
        expiresAt: "2099-10-26T00:00:00Z",
      });
    }
    if (path.startsWith("/api/v1/assistants/provided/receipts/")) {
      if (state.receipt503 > 0) {
        state.receipt503--;
        return Response.json({ code: "OFFLINE", error: "原收据读取暂不可用" }, { status: 503 });
      }
      const found = receipts.get(path.split("/").at(-1)!);
      return found
        ? Response.json(found)
        : Response.json(
            { code: "ASSISTANT_PROVIDER_RECEIPT_NOT_FOUND", error: "原收据未见" },
            { status: 404 },
          );
    }
    if (path.startsWith("/api/v1/assistants/provided")) {
      if (state.denied)
        return Response.json(
          { code: "ASSISTANT_PROVIDER_FORBIDDEN", error: "个人助手权限已撤回" },
          { status: 403 },
        );
      if (init?.method === "GET") {
        if (state.read503 > 0) {
          state.read503--;
          return Response.json({ code: "OFFLINE", error: "个人助手暂不可读取" }, { status: 503 });
        }
        return Response.json(own);
      }
      const body = JSON.parse(String(init?.body)) as {
        requestId: string;
        expectedRevision: number;
        value?: AssistantPreset;
        enabled?: boolean;
      };
      writes.push({ path, body });
      if (receipts.has(body.requestId)) return Response.json(receipts.get(body.requestId)!.result);
      const parts = path.split("/"),
        id = parts[5],
        share = parts[6] === "shares";
      if (state.conflict) {
        state.conflict = false;
        own.items[0]!.preset = { ...own.items[0]!.preset, name: "另一页面的新名称", revision: 2 };
        return Response.json(
          { code: "ASSISTANT_REVISION_CONFLICT", error: "助手配置已更新" },
          { status: 409 },
        );
      }
      let result: AssistantPreset | ProvidedAssistantShare, operation: string, projectId: string;
      if (share) {
        projectId = parts[7]!;
        operation = `provider.share:${id}`;
        result = {
          assistantId: id!,
          projectId,
          enabled: body.enabled!,
          revision: body.expectedRevision + 1,
        };
        const item = own.items.find((item) => item.preset.id === id)!;
        item.shares = item.shares.filter((share) => share.projectId !== projectId);
        item.shares.push(result);
      } else {
        projectId = "source-project";
        operation = `provider.preset.save:${id ?? "new"}`;
        result = {
          ...ownerPreset,
          ...body.value,
          id: id ?? "new-preset",
          projectId,
          revision: body.expectedRevision + 1,
        };
        const resultId = result.id;
        const item = own.items.find((item) => item.preset.id === resultId);
        if (item) item.preset = result;
        else own.items.push({ preset: result, shares: [] });
      }
      receipts.set(body.requestId, {
        requestId: body.requestId,
        operation,
        projectId,
        payload: body,
        result,
      });
      if (state.savedUnavailable) {
        state.savedUnavailable = false;
        state.denied = true;
        return Response.json({ saved: true, available: false });
      }
      if (state.lost) {
        state.lost = false;
        throw new TypeError("隔离响应丢失");
      }
      return Response.json(result);
    }
    if (path.endsWith("/assistants/provided") && state.projectMixed)
      return Response.json(
        { code: "PROJECT_FORBIDDEN", error: "项目管理权已撤回" },
        { status: 403 },
      );
    if (path.endsWith("/assistants/provided"))
      return Response.json({
        items: state.sharedWithdrawn
          ? []
          : [
              {
                preset: foreign,
                source: {
                  ...own.sources[0],
                  executionBinding: foreign.configuration.executionBinding,
                  deviceName: "提供者电脑",
                  workspaceName: "提供者登记目录",
                  capabilities: {
                    ...own.sources[0]!.capabilities,
                    deviceId: "provider-device",
                    registeredWorkspaceId: "provider-directory",
                    models: [{ id: "provider-self-model", supportedReasoningEfforts: ["low"] }],
                    skills: [],
                    sharedProfile: {
                      ...isolatedProfile,
                      models: [{ id: "isolated-model", supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" }],
                      skills: [{ id: "isolated-skill", name: "隔离只读技能", description: "" }],
                    },
                  },
                },
                share: {
                  assistantId: foreign.id,
                  projectId: "target-project",
                  enabled: true,
                  revision: 1,
                },
                available: false,
                assignable: state.assignable,
                ...(!state.assignable
                  ? {
                      assignmentReason: {
                        code: "SHARING_NOT_VERIFIED",
                        message: "共享隔离待验证，暂不可分配默认",
                      },
                    }
                  : {}),
                reason: { code: "ASSISTANT_NOT_ASSIGNED", message: "当前管理员未获分配此助手" },
              },
            ],
      });
    if (path.endsWith("/assistants/settings"))
      return Response.json({ presets: [platform, foreign], allocations });
    if (path.endsWith("/assistants/choices"))
      return Response.json({
        agents: [{ id: "a-project", name: "项目助手" }],
        sources: [
          {
            id: "platform",
            name: "平台运行器",
            executionBinding: { kind: "platform" },
            available: true,
            models: [
              {
                id: "actual-platform-model",
                name: "真实平台模型",
                reasoningLevels: ["low", "high"],
                defaultReasoning: "low",
              },
            ],
            skills: [],
          },
        ],
        platformSkills: [],
      });
    if (path.endsWith("/settings") && state.projectMixed)
      return Response.json({ code: "OFFLINE", error: "项目读取暂不可用" }, { status: 503 });
    if (path.endsWith("/settings"))
      return Response.json({
        project: {
          id: "target-project",
          name: "目标项目",
          description: "",
          revision: 1,
          createdBy: "admin",
          createdAt: "now",
          environments: [],
        },
        members: [],
        candidates: [{ id: "member-one", name: "待分配成员", kind: "internal" }],
      });
    if (path.endsWith("/assistant-allocations")) {
      const body = JSON.parse(String(init?.body));
      writes.push({ path, body });
      if (state.targetScopeError)
        return Response.json(
          { code: "CUSTOMER_SHARED_EXTERNAL_UNSUPPORTED", error: "所选目标成员不能使用此资料范围" },
          { status: 403 },
        );
      allocations.push({ ...body, revision: 1 });
      return Response.json({ ...body, revision: 1 });
    }
    throw new Error(`未处理助手管理测试请求 ${path}`);
  });
  return { own, foreign, writes, receipts, fetcher, state };
}
function App() {
  return (
    <SidebarProvider defaultOpen open>
      <ModuleSidebarProvider>
        <Sidebar>
          <SidebarContent>
            <ModuleSidebarOutlet />
          </SidebarContent>
        </Sidebar>
        <AssistantManagementPage />
      </ModuleSidebarProvider>
    </SidebarProvider>
  );
}
async function menu(name: string, item: string) {
  await page.getByRole("button", { name: `管理个人助手 ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}
async function create() {
  await page.getByRole("button", { name: "添加个人助手", exact: true }).click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("新增本人助手");
  await page.getByRole("combobox", { name: "本人运行来源", exact: true }).click();
  await page.getByRole("option", { name: "本人电脑 · 登记目录", exact: true }).click();
  await page.getByRole("combobox", { name: "运行目录", exact: true }).click();
  await page.getByRole("option", { name: "自用运行器", exact: true }).click();
  await page.getByRole("combobox", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: "真实本机模型", exact: true }).click();
  await page.getByRole("button", { name: "保存个人助手", exact: true }).click();
}

const isolatedProfile = {
  id: "readonly-profile",
  revision: 2,
  digest: "a".repeat(64),
  imageDigest: `sha256:${"b".repeat(64)}`,
  policy: "linux-docker-readonly-v1" as const,
};
function enableIsolatedProfile(f: ReturnType<typeof setup>) {
  const source = f.own.sources[0]!;
  source.sharedProfileAvailable = true;
  source.capabilities!.sharedProfile = {
    ...isolatedProfile,
    models: [
      {
        id: "isolated-model",
        name: "隔离实际模型",
        supportedReasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "medium",
      },
    ],
    skills: [{ id: "isolated-skill", name: "隔离只读技能", description: "" }],
  };
}

it("新预设显式选择隔离目录后仅展示其真实模型技能，提交固定profile且不自动选首项", async () => {
  const f = setup();
  enableIsolatedProfile(f);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=provided",
  });
  const add = page.getByRole("button", { name: "添加个人助手", exact: true });
  await expect.element(add).toBeEnabled();
  await add.click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("显式隔离助手");
  await page.getByRole("combobox", { name: "本人运行来源", exact: true }).click();
  await page.getByRole("option", { name: "本人电脑 · 登记目录", exact: true }).click();
  await expect.element(page.getByRole("combobox", { name: "模型", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "运行目录", exact: true }).click();
  await page.getByRole("option", { name: "隔离运行器", exact: true }).click();
  await expect
    .element(page.getByRole("combobox", { name: "模型", exact: true }))
    .toHaveTextContent("请选择");
  await page.getByRole("combobox", { name: "模型", exact: true }).click();
  await expect
    .element(page.getByRole("option", { name: "真实本机模型", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("option", { name: "隔离实际模型", exact: true }).click();
  await expect
    .element(page.getByRole("combobox", { name: "思考强度", exact: true }))
    .toHaveTextContent("medium");
  await expect
    .element(page.getByRole("checkbox", { name: "本机只读技能", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("checkbox", { name: "隔离只读技能", exact: true }).click();
  await page.getByRole("button", { name: "保存个人助手", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(add).toHaveFocus();
  expect(f.writes[0]?.body).toMatchObject({
    value: {
      configuration: {
        customerProfile: isolatedProfile,
        model: { model: "isolated-model", reasoningEffort: "medium" },
        skillIds: ["isolated-skill"],
      },
    },
  });
  expect((f.writes[0]?.body.value as AssistantPreset).configuration.customerProfile).toEqual(
    isolatedProfile,
  );
});

it("编辑自用预设保留原参数，显式切换运行目录清除旧模型技能且不默选新模型", async () => {
  const f = setup();
  enableIsolatedProfile(f);
  Object.assign(f.own.items[0]!.preset.configuration, { skillIds: ["local-skill"] });
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=provided",
  });
  await expect.element(page.getByText("本人排障助手", { exact: true })).toBeVisible();
  await menu("本人排障助手", "编辑助手");
  await expect
    .element(page.getByRole("combobox", { name: "运行目录", exact: true }))
    .toHaveTextContent("自用运行器");
  await expect
    .element(page.getByRole("combobox", { name: "模型", exact: true }))
    .toHaveTextContent("真实本机模型");
  await expect
    .element(page.getByRole("checkbox", { name: "本机只读技能", exact: true }))
    .toBeChecked();
  await page.getByRole("combobox", { name: "运行目录", exact: true }).click();
  await page.getByRole("option", { name: "隔离运行器", exact: true }).click();
  await expect
    .element(page.getByRole("combobox", { name: "模型", exact: true }))
    .toHaveTextContent("请选择");
  await expect
    .element(page.getByRole("checkbox", { name: "本机只读技能", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "保存个人助手", exact: true }).click();
  await expect
    .element(page.getByRole("dialog").getByRole("alert"))
    .toHaveTextContent("请选择所选运行目录提供的模型。");
  expect(f.writes).toHaveLength(0);
  await page.getByRole("combobox", { name: "运行目录", exact: true }).click();
  await page.getByRole("option", { name: "自用运行器", exact: true }).click();
  await expect
    .element(page.getByRole("combobox", { name: "模型", exact: true }))
    .toHaveTextContent("请选择");
  await expect
    .element(page.getByRole("checkbox", { name: "本机只读技能", exact: true }))
    .not.toBeChecked();
});

it.each([false, true])("保存后等待目录刷新，恢复空焦点但不抢走用户已移动的焦点%s", async (moveFocus) => {
  const f = setup();
  let finish!: () => void;
  let refreshing = false;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname.replace(
      /^\/api\/agent-demo\/t3/,
      "",
    );
    if (path === "/api/v1/assistants/provided" && init?.method === "GET" && f.writes.length) {
      refreshing = true;
      await gate;
    }
    return f.fetcher(input, init);
  });
  using _fetch = stubGlobal("fetch", fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=provided",
  });
  const add = page.getByRole("button", { name: "添加个人助手", exact: true });
  await expect.element(add).toBeEnabled();
  await create();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await vi.waitFor(() => expect(refreshing).toBe(true));
  await expect.element(add).toBeDisabled();
  expect(f.writes).toHaveLength(1);
  const refresh = page.getByRole("button", { name: "刷新助手", exact: true });
  if (moveFocus) {
    await refresh.click();
    await expect.element(refresh).toHaveFocus();
  }
  await act(() => finish());
  await expect.element(add).toBeEnabled();
  if (moveFocus) {
    await expect.element(refresh).toHaveFocus();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  } else {
    await expect.element(add).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("");
  }
  expect(f.writes).toHaveLength(1);
});

it.each(["withdrawn", "changed", "model"] as const)(
  "既有隔离预设%s保留原目录与参数，显示异常并阻止静默转为自用执行",
  async (kind) => {
    const f = setup();
    enableIsolatedProfile(f);
    const source = f.own.sources[0]!,
      configuration = f.own.items[0]!.preset.configuration;
    Object.assign(configuration, {
      customerProfile: { ...isolatedProfile },
      model: {
        instanceId: "customer-device-one-codex",
        model: "isolated-model",
        reasoningEffort: "high",
      },
      skillIds: ["isolated-skill"],
    });
    if (kind === "withdrawn") {
      source.sharedProfileAvailable = false;
      source.sharedProfileReason = { code: "REVOKED", message: "隔离许可已撤回" };
    }
    if (kind === "changed")
      source.capabilities!.sharedProfile = { ...source.capabilities!.sharedProfile!, revision: 3 };
    if (kind === "model")
      source.capabilities!.sharedProfile = { ...source.capabilities!.sharedProfile!, models: [] };
    using _fetch = stubGlobal("fetch", f.fetcher);
    await using _screen = await render(<App />, {
      router: "/assistants?projectId=target-project&assistantView=provided",
    });
    await expect.element(page.getByText("本人排障助手", { exact: true })).toBeVisible();
    await menu("本人排障助手", "编辑助手");
    await expect
      .element(page.getByRole("combobox", { name: "运行目录", exact: true }))
      .toHaveTextContent(
        kind === "model"
          ? "隔离运行器"
          : kind === "withdrawn"
            ? "隔离运行器 · 已不可用"
            : "原隔离运行器 · 已不可用",
      );
    await expect
      .element(page.getByRole("combobox", { name: "模型", exact: true }))
      .toHaveTextContent("isolated-model · 已不可用");
    await expect
      .element(page.getByRole("combobox", { name: "思考强度", exact: true }))
      .toHaveTextContent("high · 已不可用");
    await page.getByRole("button", { name: "保存个人助手", exact: true }).click();
    await expect.element(page.getByRole("dialog").getByRole("alert")).toBeVisible();
    expect(f.writes).toHaveLength(0);
    expect(configuration.customerProfile).toEqual(isolatedProfile);
    if (kind === "changed") {
      await page.getByRole("combobox", { name: "运行目录", exact: true }).click();
      await page.getByRole("option", { name: "隔离运行器", exact: true }).click();
      await expect
        .element(page.getByRole("combobox", { name: "模型", exact: true }))
        .toHaveTextContent("请选择");
    }
  },
);

it("普通提供者不需项目管理权，按真实来源创建，再主动共享和撤回目标项目", async () => {
  await page.viewport(1280, 800);
  const f = setup();
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=provided",
  });
  await expect
    .element(page.getByRole("button", { name: "添加个人助手", exact: true }))
    .toBeEnabled();
  await create();
  await expect.element(page.getByText("新增本人助手", { exact: true })).toBeVisible();
  expect(f.writes[0]?.body).toMatchObject({
    expectedRevision: 0,
    value: {
      configuration: {
        executionBinding: f.own.sources[0]!.executionBinding,
        model: { model: "actual-local-model", reasoningEffort: "high" },
        environmentId: null,
        workspaceType: null,
        visibility: "private",
      },
    },
  });
  await menu("新增本人助手", "共享到项目");
  await page.getByRole("combobox", { name: "共享目标项目", exact: true }).click();
  await page.getByRole("option", { name: "目标项目", exact: true }).click();
  await page.getByRole("button", { name: "保存共享", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(f.writes[1]?.path).toBe("/api/v1/assistants/provided/new-preset/shares/target-project");
  expect(f.writes[1]?.body).toMatchObject({ expectedRevision: 0, enabled: true });
  await menu("新增本人助手", "共享到项目");
  await page.getByRole("combobox", { name: "共享目标项目", exact: true }).click();
  await page.getByRole("option", { name: "目标项目", exact: true }).click();
  await page.getByRole("checkbox", { name: "共享给此项目", exact: true }).click();
  await page.getByRole("button", { name: "保存共享", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(f.writes[2]?.body).toMatchObject({ expectedRevision: 1, enabled: false });
  await expect.element(page.getByRole("button", { name: "当前项目", exact: true })).toBeEnabled();
});

it("个人预设断线按GET原payload恢复不重复创建；配对仍从同一我提供的入口可用", async () => {
  const f = setup();
  f.state.lost = true;
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=provided",
  });
  await expect
    .element(page.getByRole("button", { name: "添加个人助手", exact: true }))
    .toBeEnabled();
  await create();
  await expect.element(page.getByText("新增本人助手", { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  await page.getByRole("button", { name: "连接电脑", exact: true }).click();
  await expect.element(page.getByRole("dialog").getByText("isolated-pair-code",{exact:true})).toBeVisible();
  expect(Object.values(sessionStorage).join("")).not.toContain("isolated-pair-code");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "连接电脑", exact: true })).toHaveFocus();
  await page.getByRole("textbox", { name: "搜索电脑", exact: true }).fill("不存在的电脑");
  await expect.element(page.getByText("没有匹配的电脑", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "搜索电脑", exact: true }).fill("本人电脑");
  await expect.element(page.getByRole("list", { name: "我的电脑", exact: true })).toBeVisible();
});

it("原收据读取失败后关闭编辑并切分类，重开仍恢复同一原请求且不重复创建", async () => {
  await page.viewport(1280, 800);
  const f = setup();
  f.state.lost = true;
  f.state.receipt503 = 1;
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=provided",
  });
  await expect
    .element(page.getByRole("button", { name: "添加个人助手", exact: true }))
    .toBeEnabled();
  await create();
  await expect.element(page.getByRole("dialog").getByRole("alert"))
    .toHaveTextContent("原收据读取暂不可用");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "重试", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "当前项目", exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "项目预设", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "我提供的", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "添加个人助手", exact: true }))
    .toBeEnabled();
  await expect.element(page.getByText("新增本人助手", { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  expect(
    Object.keys(sessionStorage).some((key) => key.endsWith("provided-assistants:pending")),
  ).toBe(false);
});

it("保存后授权失效明确显示已保存并清除预设表单，恢复授权后只刷新且不重发", async () => {
  const f = setup();
  f.state.savedUnavailable = true;
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=provided",
  });
  await expect
    .element(page.getByRole("button", { name: "添加个人助手", exact: true }))
    .toBeEnabled();
  await create();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("alert").filter({ hasText: "操作已保存，当前授权已失效" }))
    .toBeVisible();
  await expect.element(page.getByText("本人排障助手", { exact: true })).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "添加个人助手", exact: true }))
    .toBeDisabled();
  expect(
    Object.keys(sessionStorage).some((key) => key.endsWith("provided-assistants:pending")),
  ).toBe(false);
  expect(f.writes).toHaveLength(1);
  expect(
    f.fetcher.mock.calls.some(([input]) => String(input).includes("/provided/receipts/")),
  ).toBe(false);
  f.state.denied = false;
  await page.getByRole("button", { name: "重试读取助手", exact: true }).click();
  await expect.element(page.getByText("新增本人助手", { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1);
});

it("只读项目成员只看获分配预设，不读取管理接口，也不会获得提供者管理权", async () => {
  const f = setup();
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=project",
  });
  await expect.element(page.getByRole("heading", { name: "项目预设", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "添加项目助手", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "分配助手", exact: true }))
    .not.toBeInTheDocument();
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("503保留读取重试，403清除本人预设与编辑内容；错误不伪装空列表或成功", async () => {
  const f = setup();
  f.state.read503 = 1;
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=provided",
  });
  await expect
    .element(page.getByRole("button", { name: "重试读取助手", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "重试读取助手", exact: true }).click();
  await expect.element(page.getByText("本人排障助手", { exact: true })).toBeVisible();
  await menu("本人排障助手", "编辑助手");
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("不应残留的名称");
  f.state.denied = true;
  await page.getByRole("button", { name: "保存个人助手", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("alert").filter({ hasText: "个人助手权限已撤回" }))
    .toBeVisible();
  await expect.element(page.getByText("本人排障助手", { exact: true })).not.toBeInTheDocument();
});

it("409刷新后明确重开编辑，新保存使用新revision；来源身份不可在编辑中改写", async () => {
  const f = setup();
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=provided",
  });
  await expect.element(page.getByText("本人排障助手", { exact: true })).toBeVisible();
  await menu("本人排障助手", "编辑助手");
  await expect
    .element(page.getByRole("combobox", { name: "本人运行来源", exact: true }))
    .toBeDisabled();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("旧修订名称");
  f.state.conflict = true;
  await page.getByRole("button", { name: "保存个人助手", exact: true }).click();
  await expect.element(page.getByText("另一页面的新名称", { exact: true })).toBeVisible();
  await menu("另一页面的新名称", "编辑助手");
  await expect
    .element(page.getByRole("textbox", { name: "名称", exact: true }))
    .toHaveValue("另一页面的新名称");
  await page.getByRole("checkbox", { name: "启用个人助手", exact: true }).click();
  await page.getByRole("button", { name: "保存个人助手", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(f.writes[1]?.body).toMatchObject({ expectedRevision: 2, value: { enabled: false } });
});

it("项目管理员只能分配已获共享助手，不能代提供者编辑或把未验证跨用户执行设成有效默认", async () => {
  const f = setup(true);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=project",
  });
  await expect.element(page.getByText("他人已共享助手", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "编辑项目助手 他人已共享助手", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "分配助手", exact: true }).click();
  await page.getByRole("checkbox", { name: "他人已共享助手", exact: true }).click();
  await page.getByRole("combobox", { name: "默认助手", exact: true }).click();
  await expect
    .element(page.getByRole("option", { name: "他人已共享助手", exact: true }))
    .toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "保存助手配置", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(f.writes[0]?.body).toMatchObject({
    target: { kind: "role", id: "reader" },
    assistantIds: ["foreign-preset"],
    defaultAssistantId: null,
  });
});

it("管理员本人不可执行仍可给明确成员设置获准默认，不取得执行或提供者管理权", async () => {
  const f = setup(true);
  f.state.assignable = true;
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=project",
  });
  const assign = page.getByRole("button", { name: "分配助手", exact: true });
  await expect.element(assign).toBeEnabled();
  await assign.click();
  await page.getByRole("combobox", { name: "分配对象", exact: true }).click();
  await page.getByRole("option", { name: "成员 · 待分配成员", exact: true }).click();
  await page.getByRole("checkbox", { name: "他人已共享助手", exact: true }).click();
  await page.getByRole("combobox", { name: "默认助手", exact: true }).click();
  await page.getByRole("option", { name: "他人已共享助手", exact: true }).click();
  await page.getByRole("button", { name: "保存助手配置", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(f.writes[0]?.body).toMatchObject({
    target: { kind: "member", id: "member-one" },
    assistantIds: ["foreign-preset"],
    defaultAssistantId: "foreign-preset",
  });
  expect(readAutoOpsHost()?.projects.find(project => project.id === "target-project")?.assistants?.items.find(item => item.preset.id === "foreign-preset")?.available).toBe(false);
  expect(
    f.fetcher.mock.calls.some(
      ([input]) => String(input).includes("/customer/") && !String(input).includes("workspaces"),
    ),
  ).toBe(false);
  await expect
    .element(page.getByRole("button", { name: "编辑项目助手 他人已共享助手", exact: true }))
    .not.toBeInTheDocument();
});

it("目标默认范围拒绝保留当前表单与实际目标，未把该业务错误当管理员被撤权", async () => {
  const f = setup(true);
  f.state.assignable = true;
  f.state.targetScopeError = true;
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=project",
  });
  const assign = page.getByRole("button", { name: "分配助手", exact: true });
  await expect.element(assign).toBeEnabled();
  await assign.click();
  await page.getByRole("combobox", { name: "分配对象", exact: true }).click();
  await page.getByRole("option", { name: "成员 · 待分配成员", exact: true }).click();
  await page.getByRole("checkbox", { name: "他人已共享助手", exact: true }).click();
  await page.getByRole("combobox", { name: "默认助手", exact: true }).click();
  await page.getByRole("option", { name: "他人已共享助手", exact: true }).click();
  await page.getByRole("button", { name: "保存助手配置", exact: true }).click();
  await expect
    .element(page.getByRole("dialog").getByRole("alert"))
    .toHaveTextContent("所选目标成员不能使用此资料范围");
  await expect
    .element(page.getByRole("combobox", { name: "分配对象", exact: true }))
    .toHaveTextContent("成员 · 待分配成员");
  expect(f.writes).toHaveLength(1);
  await userEvent.keyboard("{Escape}");
  await expect.element(assign).toHaveFocus();
});

it("共享候选撤回后刷新不能用旧执行或预设状态恢复默认选项", async () => {
  const f = setup(true);
  f.state.assignable = true;
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=project",
  });
  await expect.element(page.getByRole("button", { name: "分配助手", exact: true })).toBeEnabled();
  f.state.sharedWithdrawn = true;
  await page.getByRole("button", { name: "刷新助手", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "分配助手", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "分配助手", exact: true }).click();
  await page.getByRole("checkbox", { name: "他人已共享助手", exact: true }).click();
  await page.getByRole("combobox", { name: "默认助手", exact: true }).click();
  await expect
    .element(page.getByRole("option", { name: "他人已共享助手", exact: true }))
    .toHaveAttribute("aria-disabled", "true");
  expect(f.writes).toHaveLength(0);
});

it("管理列表刷新并发503和403时，已知撤权清除旧预设并保留错误及恢复入口", async () => {
  const f = setup(true);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App />, {
    router: "/assistants?projectId=target-project&assistantView=project",
  });
  await expect.element(page.getByText("他人已共享助手", { exact: true })).toBeVisible();
  f.state.projectMixed = true;
  await page.getByRole("button", { name: "刷新助手", exact: true }).click();
  await expect
    .element(page.getByRole("alert").filter({ hasText: "项目管理权已撤回" }))
    .toBeVisible();
  await expect.element(page.getByText("他人已共享助手", { exact: true })).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "添加项目助手", exact: true }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "重试项目助手", exact: true }))
    .toBeVisible();
});

it.each(["light", "dark"])(
  "%s的窄屏短窗口保留公共分类、模型标签、内部滚动与Esc焦点恢复",
  async (theme) => {
    const f = setup();
    const previousDark = document.documentElement.classList.contains("dark"),
      previousSize = { width: window.innerWidth, height: window.innerHeight };
    await using _appearance = {
      async [Symbol.asyncDispose]() {
        document.documentElement.classList.toggle("dark", previousDark);
        await page.viewport(previousSize.width, previousSize.height);
      },
    };
    document.documentElement.classList.toggle("dark", theme === "dark");
    await page.viewport(390, 500);
    using _fetch = stubGlobal("fetch", f.fetcher);
    await using _screen = await render(<App />, {
      router: "/assistants?projectId=target-project&assistantView=provided",
    });
    const add = page.getByRole("button", { name: "添加个人助手", exact: true });
    await expect.element(add).toBeEnabled();
    await add.click();
    await expect.element(page.getByRole("textbox", { name: "名称", exact: true })).toHaveFocus();
    await expect.element(page.getByRole("combobox", { name: "模型", exact: true })).toBeDisabled();
    await page.getByRole("textbox", { name: "名称", exact: true }).fill("长名称".repeat(30));
    const bounds = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
    expect(bounds.height).toBeLessThanOrEqual(window.innerHeight);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(add).toHaveFocus();
  },
);
