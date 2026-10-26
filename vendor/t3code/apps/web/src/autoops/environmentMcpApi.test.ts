import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentMcpConfiguration, EnvironmentMcpConnection } from "./environmentMcpApi";

function memoryStorage(): Storage {
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
const bootstrap = (csrfToken = "mcp-csrf") => ({
  principal: { id: "mcp-protocol-user", displayName: "环境连接协议测试" },
  csrfToken,
  gatewayBasePath: "/api/agent-demo/t3",
  fixedModel: { instanceId: "codex", model: "test-model" },
  runtimeMode: "approval-required" as const,
  projects: [],
  capabilities: {},
});
const config = (): EnvironmentMcpConfiguration => ({
  type: "mysql",
  name: "项目数据库",
  host: "db.test",
  port: 3306,
  credentialId: "credential-one",
  database: "project_db",
  tls: "required",
});
const connection = (configuration = config()): EnvironmentMcpConnection => ({
  id: "connection-one",
  projectId: "project-one",
  environmentId: "test",
  configuration,
  revision: 1,
  enabled: false,
  removed: false,
  createdAt: "2026-10-26T08:00:00Z",
  updatedAt: "2026-10-26T08:00:00Z",
});
beforeEach(async () => {
  vi.stubGlobal("window", {
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    location: { origin: "https://work.test" },
  });
  const { installAutoOpsHost } = await import("./hostConfig");
  installAutoOpsHost(bootstrap(), "https://work.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("环境连接创建只保存严格配置和凭证引用，按原请求与 CSRF 提交，确认后清理", async () => {
  const api = await import("./environmentMcpApi");
  const pending = api.prepareEnvironmentMcpMutation("project-one", "test", {
    kind: "save",
    input: { expectedRevision: 0, value: config() },
  });
  expect(pending.mutation.input).toMatchObject({
    requestId: expect.any(String),
    expectedRevision: 0,
    value: config(),
  });
  expect(api.readPendingEnvironmentMcp("project-one", "test")).toEqual(pending);
  const fetcher = vi.fn().mockResolvedValue(Response.json(connection()));
  vi.stubGlobal("fetch", fetcher);
  await expect(api.submitEnvironmentMcp(pending)).resolves.toEqual(connection());
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "/api/agent-demo/t3/api/v1/projects/project-one/environments/test/mcp",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(pending.mutation.input),
      headers: expect.objectContaining({ "X-Demo-CSRF": "mcp-csrf" }),
    }),
  );
  expect(api.readPendingEnvironmentMcp("project-one", "test")).toBeNull();
});

it.each([
  { ...config(), password: "fixture-forbidden-secret" },
  { ...config(), projectId: "forged-project" },
  { ...config(), environmentId: "production" },
  { ...config(), port: 0 },
])("秘密、伪造归属和非法字段不能进入待处理存储：%j", async (value) => {
  const api = await import("./environmentMcpApi");
  expect(() =>
    api.prepareEnvironmentMcpMutation("project-one", "test", {
      kind: "save",
      input: { expectedRevision: 0, value },
    }),
  ).toThrow("请核对连接字段及读取范围");
  expect(window.sessionStorage.length).toBe(0);
});

it("断线保留原请求并阻止本环境重复提交，其他环境的收据互不替换", async () => {
  const api = await import("./environmentMcpApi");
  const pending = api.prepareEnvironmentMcpMutation("project-one", "test", {
    kind: "save",
    input: { expectedRevision: 0, value: config() },
  });
  const other = api.prepareEnvironmentMcpMutation("project-one", "production", {
    kind: "test",
    connectionId: "other-connection",
    input: { expectedRevision: 2 },
  });
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("隔离断线"))
    .mockResolvedValueOnce(
      Response.json({ receipt: { status: "completed", result: connection() } }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(api.submitEnvironmentMcp(pending)).rejects.toMatchObject({ uncertain: true });
  expect(api.readPendingEnvironmentMcp("project-one", "test")).toEqual(pending);
  expect(() =>
    api.prepareEnvironmentMcpMutation("project-one", "test", {
      kind: "save",
      input: { expectedRevision: 0, value: config() },
    }),
  ).toThrow("请先核对上一次连接操作结果");
  await expect(api.recoverEnvironmentMcp(pending)).resolves.toEqual({
    status: "completed",
    result: connection(),
  });
  expect(fetcher.mock.calls[1]?.[0]).toBe(
    `/api/agent-demo/t3/api/v1/projects/project-one/environments/test/mcp/receipts/${pending.mutation.input.requestId}`,
  );
  expect(fetcher.mock.calls[1]?.[1].method).toBe("GET");
  expect(api.readPendingEnvironmentMcp("project-one", "test")).toBeNull();
  expect(api.readPendingEnvironmentMcp("project-one", "production")).toEqual(other);
});

it("收据不存在和执行中均保留原请求，只有显式原参数重试发出第二次写", async () => {
  const api = await import("./environmentMcpApi");
  const pending = api.prepareEnvironmentMcpMutation("project-one", "test", {
    kind: "enabled",
    connectionId: "connection-one",
    input: { expectedRevision: 1, enabled: true },
  });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ receipt: null }))
    .mockResolvedValueOnce(Response.json({ receipt: { status: "pending" } }))
    .mockResolvedValueOnce(Response.json({ ...connection(), revision: 2, enabled: true }));
  vi.stubGlobal("fetch", fetcher);
  await expect(api.recoverEnvironmentMcp(pending)).resolves.toEqual({ status: "missing" });
  await expect(api.recoverEnvironmentMcp(pending)).resolves.toEqual({ status: "pending" });
  expect(api.readPendingEnvironmentMcp("project-one", "test")).toEqual(pending);
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "GET"]);
  await api.submitEnvironmentMcp(pending);
  expect(fetcher.mock.calls[2]).toEqual([
    "/api/agent-demo/t3/api/v1/projects/project-one/environments/test/mcp/connection-one/enabled",
    expect.objectContaining({ method: "POST", body: JSON.stringify(pending.mutation.input) }),
  ]);
});

it.each([403, 409])("原请求收到明确 %s 拒绝后不保留可重放写入", async (status) => {
  const api = await import("./environmentMcpApi");
  const pending = api.prepareEnvironmentMcpMutation("project-one", "test", {
    kind: "remove",
    connectionId: "connection-one",
    input: { expectedRevision: 1 },
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: "ENVIRONMENT_MCP_REFUSED", error: "真实拒绝" }, { status }),
      ),
  );
  await expect(api.submitEnvironmentMcp(pending)).rejects.toMatchObject({
    status,
    uncertain: false,
    message: "真实拒绝",
  });
  expect(api.readPendingEnvironmentMcp("project-one", "test")).toBeNull();
});

it("测试服务失败经原收据恢复仍报失败，不能变成配置保存成功", async () => {
  const api = await import("./environmentMcpApi");
  const pending = api.prepareEnvironmentMcpMutation("project-one", "test", {
    kind: "test",
    connectionId: "connection-one",
    input: { expectedRevision: 1 },
  });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ code: "ENVIRONMENT_MCP_TEST_FAILED", error: "测试失败" }, { status: 502 }),
    )
    .mockResolvedValueOnce(
      Response.json({
        receipt: {
          status: "failed",
          error: { code: "ENVIRONMENT_MCP_TEST_FAILED", message: "只读连接未建立" },
        },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(api.submitEnvironmentMcp(pending)).rejects.toMatchObject({ uncertain: true });
  await expect(api.recoverEnvironmentMcp(pending)).rejects.toMatchObject({
    code: "ENVIRONMENT_MCP_TEST_FAILED",
    uncertain: false,
    message: "只读连接未建立",
  });
  expect(api.readPendingEnvironmentMcp("project-one", "test")).toBeNull();
});

it("读取 503 可重试且不遗失原收据，读取 403 清除原环境记录", async () => {
  const api = await import("./environmentMcpApi");
  const pending = api.prepareEnvironmentMcpMutation("project-one", "test", {
    kind: "test",
    connectionId: "connection-one",
    input: { expectedRevision: 1 },
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ code: "OFFLINE", error: "读取暂不可用" }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        Response.json({ code: "FORBIDDEN", error: "授权已撤回" }, { status: 403 }),
      ),
  );
  await expect(api.recoverEnvironmentMcp(pending)).rejects.toMatchObject({
    status: 503,
    uncertain: false,
  });
  expect(api.readPendingEnvironmentMcp("project-one", "test")).toEqual(pending);
  await expect(api.recoverEnvironmentMcp(pending)).rejects.toMatchObject({
    status: 403,
    uncertain: false,
  });
  expect(api.readPendingEnvironmentMcp("project-one", "test")).toBeNull();
});

it("被篡改的存储归属或额外秘密字段阻止恢复和新写入", async () => {
  const api = await import("./environmentMcpApi");
  const pending = api.prepareEnvironmentMcpMutation("project-one", "test", {
    kind: "save",
    input: { expectedRevision: 0, value: config() },
  });
  const key = window.sessionStorage.key(0)!;
  window.sessionStorage.setItem(key, JSON.stringify({ ...pending, actorId: "different-user" }));
  expect(() => api.readPendingEnvironmentMcp("project-one", "test")).toThrow("原连接操作记录无效");
  window.sessionStorage.setItem(
    key,
    JSON.stringify({ ...pending, password: "fixture-forbidden-secret" }),
  );
  expect(() => api.readPendingEnvironmentMcp("project-one", "test")).toThrow("原连接操作记录无效");
  expect(() =>
    api.prepareEnvironmentMcpMutation("project-one", "test", {
      kind: "remove",
      connectionId: "connection-one",
      input: { expectedRevision: 1 },
    }),
  ).toThrow("原连接操作记录无效");
});

it("调用期间取消或会话更新拒绝迟到成功，原请求仍留待核对", async () => {
  const api = await import("./environmentMcpApi");
  const pending = api.prepareEnvironmentMcpMutation("project-one", "test", {
    kind: "remove",
    connectionId: "connection-one",
    input: { expectedRevision: 1 },
  });
  const { installAutoOpsHost } = await import("./hostConfig");
  let resolve!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  const original = api.submitEnvironmentMcp(pending);
  const rejected = expect(original).rejects.toMatchObject({ name: "AbortError" });
  installAutoOpsHost(bootstrap("renewed-csrf"), "https://work.test");
  resolve(Response.json({ ...connection(), removed: true, revision: 2 }));
  await rejected;
  expect(api.readPendingEnvironmentMcp("project-one", "test")).toEqual(pending);
});

it("错误连接的成功响应不能清理原收据或报告成功", async () => {
  const api = await import("./environmentMcpApi");
  const pending = api.prepareEnvironmentMcpMutation("project-one", "test", {
    kind: "test",
    connectionId: "connection-one",
    input: { expectedRevision: 1 },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        connectionId: "different-connection",
        revision: 1,
        status: "passed",
        testedAt: "2026-10-26T00:00:00Z",
        actions: [],
      }),
    ),
  );
  await expect(api.submitEnvironmentMcp(pending)).rejects.toMatchObject({ uncertain: true });
  expect(api.readPendingEnvironmentMcp("project-one", "test")).toEqual(pending);
});

it.each([
  { ...connection(), environmentId: "production" },
  { ...connection(), revision: 2 },
  { ...connection(), configuration: { ...config(), password: "fixture-response-secret" } },
])("归属、修订或秘密字段异常的成功响应仍保留原请求：%j", async (result) => {
  const api = await import("./environmentMcpApi");
  const pending = api.prepareEnvironmentMcpMutation("project-one", "test", {
    kind: "save",
    input: { expectedRevision: 0, value: config() },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(result)));
  const submitted = api.submitEnvironmentMcp(pending);
  await expect(submitted).rejects.toMatchObject({
    code: "ENVIRONMENT_MCP_RESPONSE_INVALID",
    uncertain: true,
  });
  await expect(submitted).rejects.not.toHaveProperty(
    "message",
    expect.stringContaining("fixture-response-secret"),
  );
  expect(api.readPendingEnvironmentMcp("project-one", "test")).toEqual(pending);
});
