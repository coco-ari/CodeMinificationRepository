import { expect, it, vi } from "vite-plus/test";
import { autoOpsRequest } from "./apiClient";
import {
  loadOwnAccount,
  prepareAccountWrite,
  readPendingAccountWrite,
  recoverAccountWrite,
  submitAccountWrite,
  accountResultRequiresLogin,
} from "./accounts";

const context = vi.hoisted(() => ({ actorId: "account-user" }));
vi.mock("./hostSnapshot", () => ({
  readAutoOpsHost: () => ({
    principal: { id: context.actorId },
    csrfToken: "isolated-account-csrf",
    gatewayBasePath: "/api/agent-demo/t3",
    httpBaseUrl: "https://work.test/api/agent-demo/t3",
  }),
  autoOpsStorage: (storage: Storage) => ({
    getItem: (key: string) => storage.getItem(`${context.actorId}:${key}`),
    setItem: (key: string, value: string) => storage.setItem(`${context.actorId}:${key}`, value),
    removeItem: (key: string) => storage.removeItem(`${context.actorId}:${key}`),
  }),
}));
const account = {
  id: "account-user",
  username: "alice",
  name: "测试成员",
  kind: "internal",
  platformAdmin: false,
  enabled: true,
  revision: 2,
};
function setup() {
  context.actorId = "account-user";
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    },
  });
  return {
    values,
    [Symbol.dispose]() {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}
it("创建沿用真实同源/CSRF合同，持久元数据不含密码，成功后清原请求", async () => {
  using fixture = setup();
  using fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(account));
  const pending = prepareAccountWrite("create", null);
  expect(
    await submitAccountWrite(pending, {
      operation: "create",
      value: {
        username: "alice",
        name: "测试成员",
        kind: "internal",
        platformAdmin: false,
        password: "fictional-password",
      },
    }),
  ).toEqual(account);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "/api/agent-demo/t3/api/v1/accounts",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-Demo-CSRF": "isolated-account-csrf" }),
      body: expect.stringContaining("fictional-password"),
    }),
  );
  expect(readPendingAccountWrite()).toBeNull();
  expect(fixture.values.size).toBe(0);
});
it("断线改密仅持久原请求元数据，重开后 GET 原收据，不能再次 PUT", async () => {
  using fixture = setup();
  const result = { userId: account.id, revision: 3, sessionsRevoked: true, loginPath: "/" };
  using fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new TypeError("isolated disconnect"));
  const pending = prepareAccountWrite("changePassword", account.id);
  await expect(
    submitAccountWrite(pending, {
      operation: "changePassword",
      expectedRevision: 2,
      value: { currentPassword: "fictional-old", newPassword: "fictional-new" },
    }),
  ).rejects.toMatchObject({ uncertain: true });
  expect([...fixture.values.values()].join()).not.toMatch(
    /fictional|currentPassword|newPassword|"value"/,
  );
  const reopened = readPendingAccountWrite()!;
  await expect(
    submitAccountWrite(reopened, {
      operation: "changePassword",
      expectedRevision: 2,
      value: { currentPassword: "fictional-old", newPassword: "fictional-new" },
    }),
  ).rejects.toThrow("不能再次提交");
  fetcher.mockResolvedValueOnce(
    Response.json({
      state: "completed",
      requestId: pending.requestId,
      operation: "changePassword",
      targetId: account.id,
      result,
      createdAt: "2026-10-26T00:00:00Z",
    }),
  );
  expect(await recoverAccountWrite(reopened)).toEqual(result);
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["PUT", "GET"]);
  expect(fetcher.mock.calls[1]?.[0]).toBe(
    `/api/agent-demo/t3/api/v1/accounts/receipts/${pending.requestId}`,
  );
  expect(readPendingAccountWrite()).toBeNull();
  expect(
    accountResultRequiresLogin(
      result as Parameters<typeof accountResultRequiresLogin>[0],
      account.id,
    ),
  ).toBe(true);
});
it("原收据暂不存在仍保留请求且不重发；默认读取及全部写入继续拒绝 null", async () => {
  using _fixture = setup();
  using fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(null));
  const pending = prepareAccountWrite("enable", account.id);
  expect(await recoverAccountWrite(pending)).toBeNull();
  expect(readPendingAccountWrite()).toEqual(pending);
  await expect(autoOpsRequest("/api/v1/account", { label: "账号" })).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
  });
  await expect(
    autoOpsRequest("/api/v1/accounts", { label: "账号", body: {}, allowNull: true }),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE", uncertain: true });
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "POST"]);
});
it.each(["operation", "target", "request", "result"] as const)(
  "原收据 %s 不匹配时保留未知结果，不宣称成功",
  async (mismatch) => {
    using _fixture = setup();
    const pending = prepareAccountWrite("enable", account.id);
    const receipt = {
      state: "completed",
      requestId:
        mismatch === "request" ? "00000000-0000-4000-8000-000000000001" : pending.requestId,
      operation: mismatch === "operation" ? "create" : "enable",
      targetId: mismatch === "target" ? "other-user" : account.id,
      result: mismatch === "result" ? { ...account, id: "other-user" } : account,
    };
    using fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(receipt));
    await expect(recoverAccountWrite(pending)).rejects.toMatchObject({
      code: "ACCOUNT_RESPONSE_INVALID",
    });
    expect(readPendingAccountWrite()).toEqual(pending);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it.each([403, 409])("明确 %s 拒绝释放未接受请求，仍返回真实业务错误", async (status) => {
  using _fixture = setup();
  using fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({ code: "ACCOUNT_FORBIDDEN", message: "真实拒绝" }, { status }),
    );
  const pending = prepareAccountWrite("enable", account.id);
  await expect(
    submitAccountWrite(pending, {
      operation: "enable",
      expectedRevision: 1,
      value: { enabled: false },
    }),
  ).rejects.toMatchObject({ status, uncertain: false, message: "真实拒绝" });
  expect(readPendingAccountWrite()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("写后撤权的已保存结果保留原请求，不能误报失败或再次写入", async () => {
  using fixture = setup();
  using fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ saved: true, available: false }));
  const pending = prepareAccountWrite("resetPassword", "other-user");
  expect(
    await submitAccountWrite(pending, {
      operation: "resetPassword",
      expectedRevision: 1,
      value: { newPassword: "fictional-new" },
    }),
  ).toEqual({ saved: true, available: false });
  expect(readPendingAccountWrite()?.requestId).toBe(pending.requestId);
  expect([...fixture.values.values()].join()).not.toContain("fictional-new");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("异常成功正文不释放原请求；跨身份不能读或提交原请求，本人读取必须同身份", async () => {
  using _fixture = setup();
  using fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ ...account, id: "another" }));
  const pending = prepareAccountWrite("enable", account.id);
  await expect(
    submitAccountWrite(pending, {
      operation: "enable",
      expectedRevision: 2,
      value: { enabled: false },
    }),
  ).rejects.toMatchObject({ code: "ACCOUNT_RESPONSE_INVALID" });
  context.actorId = "another";
  expect(readPendingAccountWrite()).toBeNull();
  await expect(recoverAccountWrite(pending)).rejects.toThrow("原账号请求不可用");
  expect(fetcher).toHaveBeenCalledTimes(1);
  context.actorId = account.id;
  fetcher.mockResolvedValueOnce(Response.json({ account: { ...account, id: "another" } }));
  await expect(loadOwnAccount()).rejects.toThrow("登录身份不一致");
});
