import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  AssistantDetails,
  AssistantPreset,
  PendingProvidedAssistant,
} from "./providedAssistants";
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}
const bootstrap = (csrfToken = "provider-csrf") => ({
  principal: { id: "provider-api-user", displayName: "提供者" },
  csrfToken,
  gatewayBasePath: "/api/agent-demo/t3",
  fixedModel: { instanceId: "codex", model: "wrong-platform-default" },
  runtimeMode: "approval-required" as const,
  capabilities: {},
  projects: [],
});
const details = (): AssistantDetails => ({
  name: "本人助手",
  description: "",
  instructions: "",
  enabled: true,
  configuration: {
    agentId: "a-project",
    executionBinding: {
      kind: "customer",
      deviceId: "device-one",
      registeredWorkspaceId: "directory-one",
      workspaceBindingRevision: 2,
      runtimeId: "codex",
    },
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
});
const preset = (): AssistantPreset => ({
  ...details(),
  id: "assistant-one",
  projectId: "source-project",
  revision: 1,
  createdBy: "provider-api-user",
  updatedAt: "2026-10-26T00:00:00Z",
  providedBy: { id: "provider-api-user", name: "提供者", sourceProjectId: "source-project" },
});
beforeEach(async () => {
  const sessionStorage = storage();
  vi.stubGlobal("window", {
    sessionStorage,
    localStorage: storage(),
    location: { origin: "https://work.test" },
  });
  vi.stubGlobal("sessionStorage", sessionStorage);
  const { installAutoOpsHost } = await import("./hostConfig");
  installAutoOpsHost(bootstrap(), "https://work.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
const receipt = (pending: PendingProvidedAssistant, result: unknown) => ({
  requestId: pending.input.requestId,
  operation:
    pending.kind === "save"
      ? `provider.preset.save:${pending.assistantId ?? "new"}`
      : `provider.share:${pending.assistantId}`,
  projectId: pending.kind === "save" ? pending.sourceProjectId : pending.projectId,
  payload: pending.input,
  result,
});

it("普通提供者不依赖project.manage保存个人预设，原请求包含真实来源与模型而非当前项目默认", async () => {
  const api = await import("./providedAssistants"),
    pending = api.prepareProvidedSave(null, "source-project", 0, details());
  const fetcher = vi.fn().mockResolvedValue(Response.json(preset()));
  vi.stubGlobal("fetch", fetcher);
  await expect(api.submitProvidedAssistant(pending)).resolves.toEqual(preset());
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "/api/agent-demo/t3/api/v1/assistants/provided",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(pending.input),
      headers: expect.objectContaining({ "X-Demo-CSRF": "provider-csrf" }),
    }),
  );
  expect(api.readPendingProvidedAssistant()).toBeNull();
});
it("分享目标单独进入path和收据范围，不能以sourceProjectId替代target项目", async () => {
  const api = await import("./providedAssistants"),
    pending = api.prepareProvidedShare("assistant-one", "target-project", 3, true);
  const result = {
      assistantId: "assistant-one",
      projectId: "target-project",
      revision: 4,
      enabled: true,
    },
    fetcher = vi.fn().mockResolvedValue(Response.json(result));
  vi.stubGlobal("fetch", fetcher);
  await api.submitProvidedAssistant(pending);
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    "/api/agent-demo/t3/api/v1/assistants/provided/assistant-one/shares/target-project",
  );
  expect(pending.input).toEqual({
    requestId: expect.any(String),
    expectedRevision: 3,
    enabled: true,
  });
});
it.each(["save", "share"] as const)(
  "%s已保存后授权撤回，明确完成原请求且不当成未知结果重复提交",
  async (kind) => {
    const api = await import("./providedAssistants"),
      pending =
        kind === "save"
          ? api.prepareProvidedSave(null, "source-project", 0, details())
          : api.prepareProvidedShare("assistant-one", "target-project", 0, true);
    const fetcher = vi.fn().mockResolvedValue(Response.json({ saved: true, available: false }));
    vi.stubGlobal("fetch", fetcher);
    await expect(api.submitProvidedAssistant(pending)).resolves.toEqual({
      saved: true,
      available: false,
    });
    expect(api.readPendingProvidedAssistant()).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it("创建响应丢失后仅GET原收据恢复，不再POST，也不为新操作更换requestId", async () => {
  const api = await import("./providedAssistants"),
    pending = api.prepareProvidedSave(null, "source-project", 0, details());
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("隔离断线"))
    .mockResolvedValueOnce(Response.json(receipt(pending, preset())));
  vi.stubGlobal("fetch", fetcher);
  await expect(api.submitProvidedAssistant(pending)).rejects.toMatchObject({ uncertain: true });
  expect(() => api.prepareProvidedShare("other", "target-project", 0, true)).toThrow(
    "请先核对上一次助手操作",
  );
  await expect(api.recoverProvidedAssistant(pending)).resolves.toEqual(preset());
  expect(fetcher.mock.calls[1]?.[1].method).toBe("GET");
  expect(api.readPendingProvidedAssistant()).toBeNull();
});
it("未见收据404只保留unknown，显式重试才再次发送完全相同原命令", async () => {
  const api = await import("./providedAssistants"),
    pending = api.prepareProvidedShare("assistant-one", "target-project", 0, false);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { code: "ASSISTANT_PROVIDER_RECEIPT_NOT_FOUND", error: "未见原收据" },
        { status: 404 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({
        assistantId: "assistant-one",
        projectId: "target-project",
        revision: 1,
        enabled: false,
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(api.recoverProvidedAssistant(pending)).resolves.toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(api.readPendingProvidedAssistant()).toEqual(pending);
  await api.submitProvidedAssistant(api.readPendingProvidedAssistant()!);
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify(pending.input),
  });
});
it("收据键序不同仍核对语义相同的原payload", async () => {
  const api = await import("./providedAssistants"),
    pending = api.prepareProvidedShare("assistant-one", "target-project", 0, true),
    result = {
      assistantId: "assistant-one",
      projectId: "target-project",
      revision: 1,
      enabled: true,
    };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        ...receipt(pending, result),
        payload: { enabled: true, expectedRevision: 0, requestId: pending.input.requestId },
      }),
    ),
  );
  await expect(api.recoverProvidedAssistant(pending)).resolves.toEqual(result);
});
it.each(["payload", "project", "operation"])(
  "篡改%s不能把旧收据当成新意图成功，仍保留待核对记录",
  async (field) => {
    const api = await import("./providedAssistants"),
      pending = api.prepareProvidedShare("assistant-one", "target-project", 0, true),
      value = receipt(pending, {
        assistantId: "assistant-one",
        projectId: "target-project",
        revision: 1,
        enabled: true,
      });
    if (field === "payload") value.payload = { ...pending.input, enabled: false };
    if (field === "project") value.projectId = "source-project";
    if (field === "operation") value.operation = "provider.share:someone-else";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
    await expect(api.recoverProvidedAssistant(pending)).rejects.toMatchObject({ uncertain: true });
    expect(api.readPendingProvidedAssistant()).toEqual(pending);
  },
);
it.each([403, 409])("明确HTTP %s拒绝清理已拒绝原命令，保留真实业务错误", async (status) => {
  const api = await import("./providedAssistants"),
    pending = api.prepareProvidedShare("assistant-one", "target-project", 0, true);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: "ASSISTANT_REFUSED", error: "真实拒绝" }, { status }),
      ),
  );
  await expect(api.submitProvidedAssistant(pending)).rejects.toMatchObject({
    status,
    uncertain: false,
    message: "真实拒绝",
  });
  expect(api.readPendingProvidedAssistant()).toBeNull();
});
it("收据读取503不清理unknown，403清理所属记录", async () => {
  const api = await import("./providedAssistants"),
    pending = api.prepareProvidedShare("assistant-one", "target-project", 0, true);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: "OFFLINE", error: "读取失败" }, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ code: "FORBIDDEN", error: "当前授权撤回" }, { status: 403 }),
      ),
  );
  await expect(api.recoverProvidedAssistant(pending)).rejects.toMatchObject({ status: 503 });
  expect(api.readPendingProvidedAssistant()).toEqual(pending);
  await expect(api.recoverProvidedAssistant(pending)).rejects.toMatchObject({ status: 403 });
  expect(api.readPendingProvidedAssistant()).toBeNull();
});
it("凭证秘密和额外actor字段不能进入个人助手原请求存储", async () => {
  const api = await import("./providedAssistants"),
    value = { ...details(), password: "fixture-forbidden-secret" };
  expect(() => api.prepareProvidedSave(null, "source-project", 0, value)).toThrow("请核对助手名称");
  expect(sessionStorage.length).toBe(0);
  const pending = api.prepareProvidedShare("assistant-one", "target-project", 0, true),
    key = sessionStorage.key(0)!;
  sessionStorage.setItem(key, JSON.stringify({ ...pending, actorId: "other-user" }));
  expect(() => api.readPendingProvidedAssistant()).toThrow("原助手操作尚未确认");
});
it("会话更新拒绝迟到响应并保留原id待核对", async () => {
  const api = await import("./providedAssistants"),
    pending = api.prepareProvidedSave(null, "source-project", 0, details()),
    { installAutoOpsHost } = await import("./hostConfig");
  let finish!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const result = api.submitProvidedAssistant(pending),
    rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  installAutoOpsHost(bootstrap("renewed-csrf"), "https://work.test");
  finish(Response.json(preset()));
  await rejected;
  expect(api.readPendingProvidedAssistant()).toEqual(pending);
});
