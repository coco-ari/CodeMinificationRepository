import { StrictMode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render, stubGlobal } from "../../test/render";
import { SidebarProvider } from "~/components/ui/sidebar";
import { ModuleSidebarProvider, ModuleSidebarOutlet } from "./ModuleWorkspace";
import { AccountManagementPage } from "./AccountManagementPage";
import { installAutoOpsHost } from "./hostConfig";
import type { RuntimeAccount } from "./accounts";
import "../index.css";
type MutableAccount = { -readonly [Key in keyof RuntimeAccount]: RuntimeAccount[Key] };

const navigation = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("./accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./accounts")>()),
  returnToAccountLogin: navigation.login,
}));
function setup({ manager = true } = {}) {
  window.sessionStorage.clear();
  navigation.login.mockReset();
  const own: MutableAccount = {
    id: "accounts-ui-user",
    username: "ui_admin",
    name: "本人账号名称",
    kind: "internal",
    platformAdmin: manager,
    enabled: true,
    revision: 1,
  };
  const member: MutableAccount = {
    id: "accounts-member",
    username: "case_member",
    name: "测试成员",
    kind: "internal",
    platformAdmin: false,
    enabled: true,
    revision: 2,
  };
  const items = [own, member];
  const options = {
    lost: false,
    nullReceipt: false,
    conflict: false,
    denied: false,
    savedUnavailable: false,
    holdList: false,
  };
  const held: Array<() => void> = [];
  const writes: Array<{
    path: string;
    method: string;
    input: { requestId: string; expectedRevision?: number; value: Record<string, unknown> };
  }> = [];
  const receipts = new Map<string, object>();
  const bootstrap = (allowed = manager) => ({
    principal: { id: own.id, displayName: own.name },
    csrfToken: "isolated-accounts-csrf",
    gatewayBasePath: "/api/agent-demo/t3",
    fixedModel: { instanceId: "codex", model: "test-model" },
    runtimeMode: "approval-required" as const,
    canManageAccounts: allowed,
    capabilities: {},
    projects: [],
  });
  installAutoOpsHost(bootstrap(), window.location.origin);
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    const path = url.pathname.replace(/^\/api\/agent-demo\/t3/, "");
    if (path.startsWith("/api/v1/accounts/receipts/")) {
      if (options.denied)
        return Response.json({ code: "UNAUTHENTICATED", message: "请重新登录" }, { status: 401 });
      return Response.json(
        options.nullReceipt
          ? null
          : (receipts.get(decodeURIComponent(path.split("/").at(-1)!)) ?? null),
      );
    }
    if (init?.method === "GET") {
      if (path === "/api/v1/account") return Response.json({ account: { ...own } });
      if (path === "/api/v1/accounts") {
        const result = () =>
          options.denied
            ? Response.json({ code: "ACCOUNT_FORBIDDEN", message: "无权管理账号" }, { status: 403 })
            : Response.json({ items: items.map((item) => ({ ...item })), nextCursor: null });
        if (options.holdList)
          return await new Promise<Response>((resolve) => held.push(() => resolve(result())));
        return result();
      }
    } else {
      const body = JSON.parse(String(init?.body)) as (typeof writes)[number]["input"];
      writes.push({ path, method: init?.method ?? "POST", input: body });
      if (options.denied)
        return Response.json(
          { code: "ACCOUNT_FORBIDDEN", message: "无权管理账号" },
          { status: 403 },
        );
      if (options.conflict) {
        options.conflict = false;
        member.revision = 4;
        member.name = "已更新成员";
        return Response.json(
          { code: "ACCOUNT_REVISION_CONFLICT", message: "账号已更新" },
          { status: 409 },
        );
      }
      const target =
        path === "/api/v1/account/password"
          ? own
          : items.find((item) => path.includes(`/${item.id}`));
      const operation =
        path === "/api/v1/accounts"
          ? "create"
          : path === "/api/v1/account/password"
            ? "changePassword"
            : path.endsWith("/password")
              ? "resetPassword"
              : "enable";
      let result: object;
      let targetId: string;
      if (operation === "create") {
        const next: MutableAccount = {
          id: `created-${items.length}`,
          username: String(body.value.username),
          name: String(body.value.name),
          kind: body.value.kind as "internal" | "external",
          platformAdmin: body.value.platformAdmin === true,
          enabled: true,
          revision: 1,
        };
        items.push(next);
        result = { ...next };
        targetId = next.id;
      } else if (operation === "enable") {
        target!.enabled = body.value.enabled === true;
        target!.revision++;
        result = { ...target! };
        targetId = target!.id;
      } else {
        target!.revision++;
        result = {
          userId: target!.id,
          revision: target!.revision,
          sessionsRevoked: true,
          loginPath: "/",
        };
        targetId = target!.id;
      }
      receipts.set(body.requestId, {
        state: "completed",
        requestId: body.requestId,
        operation,
        targetId,
        result,
        createdAt: "2026-10-26T00:00:00Z",
      });
      if (options.lost) throw new TypeError("隔离断线");
      return Response.json(options.savedUnavailable ? { saved: true, available: false } : result);
    }
    throw new Error(`未处理的隔离请求 ${path}`);
  });
  return {
    options,
    held,
    writes,
    fetcher,
    items,
    revoke: () => installAutoOpsHost(bootstrap(false), window.location.origin),
  };
}
function App() {
  return (
    <StrictMode>
      <SidebarProvider>
        <ModuleSidebarProvider>
          <ModuleSidebarOutlet />
          <AccountManagementPage />
        </ModuleSidebarProvider>
      </SidebarProvider>
    </StrictMode>
  );
}
async function passwords() {
  await page.getByLabelText("新密码", { exact: true }).fill("isolated-password-2026");
  await page.getByLabelText("确认新密码", { exact: true }).fill("isolated-password-2026");
}

it("平台管理员创建外部账号，默认不授平台权；保存后可重新打开且不保留密码", async () => {
  const fixture = setup();
  using _fetch = stubGlobal("fetch", fixture.fetcher);
  await using screen = await render(<App />, { router: "/accounts" });
  await screen.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabelText("用户名", { exact: true }).fill("external_case");
  await page.getByLabelText("姓名", { exact: true }).fill("外部验收成员");
  await page.getByRole("combobox", { name: "账号类型" }).click();
  await page.getByRole("option", { name: "外部成员", exact: true }).click();
  await expect.element(page.getByRole("checkbox", { name: "平台管理员" })).not.toBeInTheDocument();
  await passwords();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(screen.getByText("外部验收成员", { exact: true })).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]?.input.value).toMatchObject({
    username: "external_case",
    kind: "external",
    platformAdmin: false,
  });
  await screen.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect.element(page.getByLabelText("新密码", { exact: true })).toHaveValue("");
  await expect.element(page.getByLabelText("用户名", { exact: true })).toHaveValue("");
});
it("普通成员仅本人改密，成功退出全部原会话且不刷新已失效会话", async () => {
  const fixture = setup({ manager: false });
  using _fetch = stubGlobal("fetch", fixture.fetcher);
  await using screen = await render(<App />, { router: "/accounts" });
  await expect
    .element(screen.getByRole("button", { name: "创建账号", exact: true }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "修改密码", exact: true }).click();
  await page.getByLabelText("当前密码", { exact: true }).fill("isolated-old-password");
  await passwords();
  const before = fixture.fetcher.mock.calls.filter(([path]) =>
    String(path).endsWith("/api/v1/account"),
  ).length;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => navigation.login.mock.calls.length).toBe(1);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]?.path).toBe("/api/v1/account/password");
  expect(
    fixture.fetcher.mock.calls.filter(([path]) => String(path).endsWith("/api/v1/account")),
  ).toHaveLength(before);
  expect(
    window.sessionStorage.getItem("autoops:t3:accounts-ui-user:account-write-receipt"),
  ).toBeNull();
});
it("普通成员深链平台账号明确拒绝且不请求目录", async () => {
  const fixture = setup({ manager: false });
  using _fetch = stubGlobal("fetch", fixture.fetcher);
  await using screen = await render(<App />, { router: "/accounts?accountView=manage" });
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("无权管理平台账号。请在侧栏进入本人账号。");
  expect(fixture.fetcher).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "本人账号", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "修改密码", exact: true })).toBeVisible();
});
it("停用需确认；409读取新修订后重新打开确认，不自动重发", async () => {
  const fixture = setup();
  fixture.options.conflict = true;
  using _fetch = stubGlobal("fetch", fixture.fetcher);
  await using screen = await render(<App />, { router: "/accounts" });
  await screen.getByRole("button", { name: "停用账号 case_member", exact: true }).click();
  expect(fixture.writes).toHaveLength(0);
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect
    .element(screen.getByText("账号已更新 请重新打开并确认最新账号。", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText("已更新成员", { exact: true })).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  await screen.getByRole("button", { name: "停用账号 case_member", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "启用账号 case_member", exact: true }))
    .toBeVisible();
  expect(fixture.writes.map((write) => write.input.expectedRevision)).toEqual([2, 4]);
  expect(fixture.writes[0]?.input.requestId).not.toBe(fixture.writes[1]?.input.requestId);
});
it("重置断线清密码，仅 GET 原请求收据恢复，不重发写入", async () => {
  const fixture = setup();
  fixture.options.lost = true;
  fixture.options.nullReceipt = true;
  using _fetch = stubGlobal("fetch", fixture.fetcher);
  await using screen = await render(<App />, { router: "/accounts" });
  await screen.getByRole("button", { name: "重置密码 case_member", exact: true }).click();
  await passwords();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await screen.getByRole("button", { name: "核对原结果", exact: true }).click();
  await expect
    .element(screen.getByText("尚未找到原请求收据。请稍后核对；不要重新提交。", { exact: true }))
    .toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  const raw = window.sessionStorage.getItem("autoops:t3:accounts-ui-user:account-write-receipt")!;
  expect(raw).not.toMatch(/isolated-password|newPassword|"value"/);
  fixture.options.nullReceipt = false;
  await screen.getByRole("button", { name: "核对原结果", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "核对原结果", exact: true }))
    .not.toBeInTheDocument();
  expect(fixture.writes).toHaveLength(1);
  expect(navigation.login).not.toHaveBeenCalled();
});
it("写后撤权的 saved unavailable 清目录，保持原收据且不再次写入", async () => {
  const fixture = setup();
  fixture.options.savedUnavailable = true;
  using _fetch = stubGlobal("fetch", fixture.fetcher);
  await using screen = await render(<App />, { router: "/accounts" });
  await screen.getByRole("button", { name: "重置密码 case_member", exact: true }).click();
  await passwords();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .element(
      screen.getByText("已保存，但当前登录无权继续查看。请重新登录后核对原结果。", { exact: true }),
    )
    .toBeVisible();
  await expect.element(screen.getByText("测试成员", { exact: true })).not.toBeInTheDocument();
  expect(fixture.writes).toHaveLength(1);
  expect(
    window.sessionStorage.getItem("autoops:t3:accounts-ui-user:account-write-receipt"),
  ).not.toBeNull();
});
it("读取挂起时撤回管理权，迟到目录不能重现或留下密码弹窗", async () => {
  const fixture = setup();
  using _fetch = stubGlobal("fetch", fixture.fetcher);
  await using screen = await render(<App />, { router: "/accounts?accountView=manage" });
  await screen.getByRole("button", { name: "重置密码 case_member", exact: true }).click();
  await passwords();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  fixture.options.holdList = true;
  await screen.getByRole("button", { name: "刷新账号", exact: true }).click();
  await expect.poll(() => fixture.held.length).toBeGreaterThan(0);
  fixture.revoke();
  fixture.held.splice(0).forEach((deliver) => deliver());
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("无权管理平台账号。请在侧栏进入本人账号。");
  await expect.element(screen.getByText("测试成员", { exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(fixture.writes).toHaveLength(0);
});
it("保存后刷新恢复入口焦点；用户主动聚焦搜索时迟到刷新不抢焦点", async () => {
  const fixture = setup();
  using _fetch = stubGlobal("fetch", fixture.fetcher);
  await using screen = await render(<App />, { router: "/accounts" });
  await screen.getByRole("button", { name: "重置密码 case_member", exact: true }).click();
  await passwords();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "重置密码 case_member", exact: true }))
    .toBeEnabled();
  await expect
    .element(screen.getByRole("button", { name: "重置密码 case_member", exact: true }))
    .toHaveFocus();
  await screen.getByRole("button", { name: "重置密码 case_member", exact: true }).click();
  await passwords();
  fixture.options.holdList = true;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => fixture.held.length).toBeGreaterThan(0);
  await screen.getByRole("searchbox", { name: "搜索已加载账号" }).click();
  fixture.held.splice(0).forEach((deliver) => deliver());
  await expect.element(screen.getByRole("button", { name: "创建账号", exact: true })).toBeEnabled();
  await expect.element(screen.getByRole("searchbox", { name: "搜索已加载账号" })).toHaveFocus();
});
