import { StrictMode, useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render, stubGlobal } from "../../test/render";
import { Button } from "~/components/ui/button";
import { EnvironmentMcpDialog } from "./EnvironmentMcpDialog";
import { installAutoOpsHost } from "./hostConfig";
import type { EnvironmentMcpConnection, EnvironmentMcpConfiguration } from "./environmentMcpApi";
import type { EnvironmentMcpReceipt } from "../../../../../../autoops/contracts/environment-mcp.ts";
import "../index.css";

function setup() {
  window.sessionStorage.clear();
  const configuration: EnvironmentMcpConfiguration = {
    type: "mysql",
    name: "项目数据库",
    host: "db.test",
    port: 3306,
    credentialId: "credential-one",
    database: "project_db",
    tls: "required",
  };
  const make = (id: string, environmentId: string, name: string): EnvironmentMcpConnection => ({
    id,
    projectId: "mcp-project",
    environmentId,
    configuration: { ...configuration, name },
    revision: 1,
    enabled: false,
    removed: false,
    createdAt: "2026-10-26T08:00:00Z",
    updatedAt: "2026-10-26T08:00:00Z",
    lastTest: {
      connectionId: id,
      revision: 1,
      status: "passed",
      testedAt: "2026-10-25T08:00:00Z",
      actions: ["mysql.tables"],
    },
  });
  const items = [
    make("connection-one", "test", "项目数据库"),
    make("connection-production", "production", "生产数据库"),
  ];
  const writes: Array<{
    action: string;
    environment: string;
    input: Record<string, unknown>;
    method: string;
  }> = [];
  const receipts = new Map<string, EnvironmentMcpReceipt>();
  const options = {
    lost: "",
    read503: 0,
    receipt503: 0,
    denied: false,
    conflict: false,
    testFails: false,
    holdRead: false,
  };
  const held: Array<() => void> = [];
  const callbacks = { changed: vi.fn(), denied: vi.fn() };
  installAutoOpsHost(
    {
      principal: { id: "mcp-ui-user", displayName: "环境管理员" },
      csrfToken: "mcp-csrf",
      gatewayBasePath: "/api/agent-demo/t3",
      fixedModel: { instanceId: "codex", model: "test-model" },
      runtimeMode: "approval-required",
      capabilities: {},
      projects: [
        {
          id: "mcp-project",
          name: "MCP 验收项目",
          agents: [],
          environments: [
            { id: "test", name: "测试环境" },
            { id: "production", name: "生产环境" },
          ],
          capabilities: {
            "project.manage": true,
            "chat.use": true,
            "workspace.read": true,
            "workspace.manage": true,
            "deployment.read": true,
            "deployment.execute": true,
          },
        },
      ],
    },
    window.location.origin,
  );
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname.replace(
      /^\/api\/agent-demo\/t3/,
      "",
    );
    if (path.endsWith("/workspace/credentials"))
      return Response.json({
        credentials: [
          {
            id: "credential-one",
            projectId: "mcp-project",
            name: "只读凭证",
            revision: 1,
            version: 1,
            revoked: false,
            createdAt: "now",
            updatedAt: "now",
          },
        ],
      });
    const match = /^\/api\/v1\/projects\/mcp-project\/environments\/([^/]+)\/mcp(?:\/(.*))?$/.exec(
      path,
    );
    if (!match) throw new Error(`未处理测试请求 ${path}`);
    const environment = match[1]!,
      suffix = match[2],
      method = init?.method ?? "GET";
    if (options.denied)
      return Response.json(
        { code: "ENVIRONMENT_MCP_FORBIDDEN", error: "环境管理权限已撤回" },
        { status: 403 },
      );
    if (suffix?.startsWith("receipts/")) {
      if (options.receipt503 > 0) {
        options.receipt503--;
        return Response.json({ code: "OFFLINE", error: "收据暂不可用" }, { status: 503 });
      }
      return Response.json({ receipt: receipts.get(`${environment}:${suffix.slice(9)}`) ?? null });
    }
    if (method === "GET") {
      if (options.read503 > 0) {
        options.read503--;
        return Response.json({ code: "OFFLINE", error: "连接列表暂不可用" }, { status: 503 });
      }
      const snapshot = structuredClone(
        items.filter((item) => item.environmentId === environment && !item.removed),
      );
      if (options.holdRead && environment === "test")
        return await new Promise<Response>((resolve) => {
          held.push(() => resolve(Response.json({ items: snapshot })));
        });
      return Response.json({ items: snapshot });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const action =
      method === "DELETE"
        ? "remove"
        : suffix?.endsWith("/enabled")
          ? "enabled"
          : suffix?.endsWith("/test")
            ? "test"
            : "save";
    writes.push({ action, environment, input: body, method });
    const receiptKey = `${environment}:${body.requestId}`;
    const previous = receipts.get(receiptKey);
    if (previous?.status === "completed") return Response.json(previous.result);
    const id = suffix?.split("/")[0],
      existing = id
        ? items.find((item) => item.id === id && item.environmentId === environment)
        : undefined;
    if (options.conflict && existing) {
      options.conflict = false;
      existing.revision++;
      existing.configuration = { ...existing.configuration, name: "其他管理员的新名称" };
      return Response.json(
        { code: "ENVIRONMENT_MCP_REVISION_CONFLICT", error: "连接已被其他管理员更新" },
        { status: 409 },
      );
    }
    if (existing && body.expectedRevision !== existing.revision)
      return Response.json(
        { code: "ENVIRONMENT_MCP_REVISION_CONFLICT", error: "连接修订已变化" },
        { status: 409 },
      );
    if (action === "test") {
      if (!existing) throw new Error("测试连接不存在");
      const testedAt = "2026-10-26T08:00:00Z";
      if (options.testFails) {
        existing.lastTest = {
          connectionId: existing.id,
          revision: existing.revision,
          status: "failed",
          testedAt,
          actions: [],
          error: { code: "ENVIRONMENT_MCP_TEST_FAILED", message: "只读连接未建立" },
        };
        receipts.set(receiptKey, {
          status: "failed",
          error: { code: "ENVIRONMENT_MCP_TEST_FAILED", message: "只读连接未建立" },
        });
        return Response.json(
          { code: "ENVIRONMENT_MCP_TEST_FAILED", error: "只读连接未建立" },
          { status: 502 },
        );
      }
      existing.lastTest = {
        connectionId: existing.id,
        revision: existing.revision,
        status: "passed",
        testedAt,
        actions: ["mysql.tables"],
      };
      const result = structuredClone(existing.lastTest);
      receipts.set(receiptKey, { status: "completed", result });
      if (options.lost === action) {
        options.lost = "";
        throw new TypeError("隔离响应丢失");
      }
      return Response.json(result);
    }
    const result: EnvironmentMcpConnection =
      existing ?? make("connection-new", environment, "新连接");
    if (!existing) items.push(result);
    result.revision = (existing?.revision ?? 0) + 1;
    if (action === "save") result.configuration = body.value as EnvironmentMcpConfiguration;
    else if (action === "enabled") result.enabled = body.enabled === true;
    else result.removed = true;
    const saved = structuredClone(result);
    receipts.set(receiptKey, { status: "completed", result: saved });
    if (options.lost === action) {
      options.lost = "";
      throw new TypeError("隔离响应丢失");
    }
    return Response.json(saved);
  });
  return { items, writes, receipts, options, held, callbacks, fetcher };
}
type Fixture = ReturnType<typeof setup>;
function App({
  fixture,
  environmentId = "test",
  environmentName = "测试环境",
}: {
  fixture: Fixture;
  environmentId?: string;
  environmentName?: string;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <StrictMode>
      <Button ref={trigger} onClick={() => setOpen(true)}>
        管理环境 MCP
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      <EnvironmentMcpDialog
        projectId="mcp-project"
        environmentId={environmentId}
        environmentName={environmentName}
        open={open}
        onOpenChange={setOpen}
        finalFocus={trigger}
        onChanged={fixture.callbacks.changed}
        onAccessDenied={(cause) => {
          fixture.callbacks.denied(cause);
          setError(cause instanceof Error ? cause.message : "访问被拒绝");
        }}
      />
    </StrictMode>
  );
}
async function open() {
  await page.getByRole("button", { name: "管理环境 MCP", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "添加连接", exact: true })).toBeEnabled();
}
async function menu(name: string, item: string) {
  await page.getByRole("button", { name: `管理连接 ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}
async function create(name = "新增数据库") {
  await page.getByRole("button", { name: "添加连接", exact: true }).click();
  await page.getByRole("textbox", { name: "连接名称", exact: true }).fill(name);
  await page.getByRole("textbox", { name: "主机", exact: true }).fill("isolated-db.test");
  await page.getByRole("combobox", { name: "项目凭证", exact: true }).click();
  await page.getByRole("option", { name: "只读凭证", exact: true }).click();
  await page.getByRole("textbox", { name: "数据库", exact: true }).fill("isolated_db");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
}

it("同一原生 Dialog 完成创建、测试、启停、修改与移除，保留标签、历史时间及焦点", async () => {
  const f = setup();
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<App fixture={f} />);
  await open();
  await expect.element(page.getByText(/上次测试：通过.*2026/)).toBeVisible();
  await create();
  await expect.element(page.getByText("新增数据库", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "添加连接", exact: true })).toHaveFocus();
  expect(f.items.find((item) => item.id === "connection-new")?.enabled).toBe(false);
  expect(f.writes[0]).toMatchObject({
    action: "save",
    input: {
      expectedRevision: 0,
      value: { type: "mysql", name: "新增数据库", credentialId: "credential-one", tls: "required" },
    },
  });
  await page.getByRole("button", { name: "测试连接 新增数据库", exact: true }).click();
  await expect.element(page.getByText("连接测试通过。", { exact: true })).toBeVisible();
  await menu("新增数据库", "启用连接");
  await expect.element(page.getByText(/本环境内可使用问答的成员可以读取以上范围/)).toBeVisible();
  await page.getByRole("button", { name: "确认启用", exact: true }).click();
  await expect.element(page.getByText("连接已启用。", { exact: true })).toBeVisible();
  await menu("新增数据库", "编辑连接");
  await expect.element(page.getByRole("textbox", { name: "连接名称", exact: true })).toHaveFocus();
  await expect
    .element(page.getByRole("combobox", { name: "连接类型", exact: true }))
    .toBeDisabled();
  await page.getByRole("textbox", { name: "连接名称", exact: true }).fill("修订数据库");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "管理连接 修订数据库", exact: true }))
    .toHaveFocus();
  await menu("修订数据库", "停用连接");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "管理连接 修订数据库", exact: true }))
    .toHaveFocus();
  await menu("项目数据库", "启用连接");
  await page.getByRole("button", { name: "确认启用", exact: true }).click();
  await expect.element(page.getByText("连接已启用。", { exact: true })).toBeVisible();
  await menu("项目数据库", "停用连接");
  await page.getByRole("button", { name: "确认停用", exact: true }).click();
  await expect.element(page.getByText("连接已停用。", { exact: true })).toBeVisible();
  await menu("修订数据库", "移除连接");
  await page.getByRole("button", { name: "确认移除", exact: true }).click();
  await expect.element(page.getByText("修订数据库", { exact: true })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect
    .element(screen.getByRole("button", { name: "管理环境 MCP", exact: true }))
    .toHaveFocus();
  expect(f.writes.map((write) => write.action)).toEqual([
    "save",
    "test",
    "enabled",
    "save",
    "enabled",
    "enabled",
    "remove",
  ]);
  expect(Object.values(sessionStorage).join("")).not.toContain("password");
});

it("创建响应丢失后读取原收据，仅一次写入且不把凭证秘密带入表单或存储", async () => {
  const f = setup();
  f.options.lost = "save";
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<App fixture={f} />);
  await open();
  await create("断线连接");
  await expect.element(page.getByText("断线连接", { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  expect(f.callbacks.changed).toHaveBeenCalledOnce();
  expect(Object.values(sessionStorage).join("")).not.toContain("credential-one");
  expect(screen.container.textContent).not.toContain("password");
});

it.each(["server", "redis"])("%s 仅提交对应连接字段及读取范围，新配置默认停用", async (type) => {
  const f = setup();
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App fixture={f} />);
  await open();
  await page.getByRole("button", { name: "添加连接", exact: true }).click();
  await page.getByRole("combobox", { name: "连接类型", exact: true }).click();
  await page
    .getByRole("option", { name: type === "server" ? "服务器" : "Redis", exact: true })
    .click();
  await page.getByRole("textbox", { name: "连接名称", exact: true }).fill("隔离只读资源");
  await page.getByRole("textbox", { name: "主机", exact: true }).fill("isolated-resource.test");
  if (type === "server") {
    await page.getByRole("combobox", { name: "项目凭证", exact: true }).click();
    await page.getByRole("option", { name: "只读凭证", exact: true }).click();
    await page
      .getByRole("textbox", { name: "SSH 主机指纹", exact: true })
      .fill(`SHA256:${"a".repeat(43)}`);
    await page
      .getByRole("textbox", { name: "可读目录（每行一个）", exact: true })
      .fill("/srv/isolated/logs");
    await page
      .getByRole("textbox", { name: "服务单元（每行一个）", exact: true })
      .fill("isolated.service");
  } else {
    await expect
      .element(page.getByRole("spinbutton", { name: "逻辑数据库", exact: true }))
      .toHaveValue(0);
    await page
      .getByRole("textbox", { name: "Key 范围（每行一个）", exact: true })
      .fill("isolated:*");
  }
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect.element(page.getByText("隔离只读资源", { exact: true })).toBeVisible();
  const value = f.items.find((item) => item.id === "connection-new")!;
  expect(value.enabled).toBe(false);
  expect(value.configuration).toMatchObject(
    type === "server"
      ? {
          type,
          port: 22,
          credentialId: "credential-one",
          readPaths: ["/srv/isolated/logs"],
          serviceUnits: ["isolated.service"],
        }
      : { type, port: 6379, database: 0, keyPatterns: ["isolated:*"], tls: "required" },
  );
  expect(value.configuration).not.toHaveProperty("password");
  if (type === "redis") expect(value.configuration).not.toHaveProperty("credentialId");
});

it("原收据不存在时必须明确按原请求重试，关闭再打开不生成新 requestId", async () => {
  const f = setup();
  f.options.lost = "save";
  const original = f.fetcher.getMockImplementation()!;
  let missing = true;
  f.fetcher.mockImplementation(async (input, init) => {
    if (missing && String(input).includes("/receipts/")) return Response.json({ receipt: null });
    return await original(input, init);
  });
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<App fixture={f} />);
  await open();
  await create("原请求连接");
  await expect.element(page.getByRole("button", { name: "重试原请求", exact: true })).toBeVisible();
  const first = structuredClone(f.writes[0]);
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByRole("button", { name: "管理环境 MCP", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "重试原请求", exact: true })).toBeEnabled();
  expect(f.writes).toHaveLength(1);
  await expect.element(page.getByRole("button", { name: "添加连接", exact: true })).toBeDisabled();
  missing = false;
  await page.getByRole("button", { name: "重试原请求", exact: true }).click();
  await expect
    .element(page.getByText("连接配置已保存，请测试当前配置。", { exact: true }))
    .toBeVisible();
  expect(f.writes).toEqual([first, first]);
  expect(f.items.filter((item) => item.configuration.name === "原请求连接")).toHaveLength(1);
  expect(screen.container.textContent).not.toContain("原请求仍在执行");
});

it("列表 503 保留重试入口，测试失败经原收据恢复仍显示失败，不能报告保存成功", async () => {
  const f = setup();
  f.options.read503 = 2;
  f.options.testFails = true;
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<App fixture={f} />);
  await page.getByRole("button", { name: "管理环境 MCP", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "重试读取连接", exact: true }))
    .toBeVisible();
  f.options.read503 = 0;
  await page.getByRole("button", { name: "重试读取连接", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "测试连接 项目数据库", exact: true }))
    .toBeEnabled();
  await page.getByRole("button", { name: "测试连接 项目数据库", exact: true }).click();
  await expect
    .element(page.getByRole("alert").filter({ hasText: "只读连接未建立" }).first())
    .toBeVisible();
  await expect.element(page.getByText("连接测试通过。", { exact: true })).not.toBeInTheDocument();
  await expect
    .element(page.getByText("连接配置已保存，请测试当前配置。", { exact: true }))
    .not.toBeInTheDocument();
  expect(f.callbacks.changed).not.toHaveBeenCalled();
  expect(f.writes).toHaveLength(1);
  expect(screen.container.textContent).not.toContain("密码");
});

it("收据读取 503 不丢失待确认操作，可再次核对并恢复原成功结果", async () => {
  const f = setup();
  f.options.lost = "test";
  f.options.receipt503 = 1;
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App fixture={f} />);
  await open();
  await page.getByRole("button", { name: "测试连接 项目数据库", exact: true }).click();
  await expect.element(page.getByText("收据暂不可用", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "核对原请求", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "核对原请求", exact: true }).click();
  await expect.element(page.getByText("连接测试通过。", { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1);
});

it("修订 409 刷新最新资料并要求重新打开确认，不按旧值自动覆盖", async () => {
  const f = setup();
  f.options.conflict = true;
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<App fixture={f} />);
  await open();
  await menu("项目数据库", "编辑连接");
  await page.getByRole("textbox", { name: "连接名称", exact: true }).fill("本地旧修订");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect.element(page.getByText(/请重新打开连接并确认最新配置/)).toBeVisible();
  await expect.element(page.getByText("其他管理员的新名称", { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  await menu("其他管理员的新名称", "编辑连接");
  await expect
    .element(page.getByRole("textbox", { name: "连接名称", exact: true }))
    .toHaveValue("其他管理员的新名称");
  await page.getByRole("textbox", { name: "连接名称", exact: true }).fill("重新确认名称");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect.element(page.getByText("重新确认名称", { exact: true })).toBeVisible();
  expect(f.writes[1]?.input.expectedRevision).toBe(2);
});

it("403 撤回关闭 Dialog 并清除旧内容与待确认请求，拒绝后不提供重试写入", async () => {
  const f = setup();
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<App fixture={f} />);
  await open();
  f.options.denied = true;
  await page.getByRole("button", { name: "测试连接 项目数据库", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("环境管理权限已撤回");
  expect(f.callbacks.denied).toHaveBeenCalledOnce();
  expect(Object.values(sessionStorage).join("")).not.toContain("connection-one");
  await expect.element(page.getByText("项目数据库", { exact: true })).not.toBeInTheDocument();
});

it("切换环境取消旧读取，忽略未遵守 AbortSignal 的迟到响应", async () => {
  const f = setup();
  f.options.holdRead = true;
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<App fixture={f} />);
  await page.getByRole("button", { name: "管理环境 MCP", exact: true }).click();
  await vi.waitFor(() => expect(f.held.length).toBeGreaterThan(0));
  await screen.rerender(<App fixture={f} environmentId="production" environmentName="生产环境" />);
  await expect
    .element(page.getByRole("heading", { name: "生产环境 · 环境连接", exact: true }))
    .toBeVisible();
  await expect.element(page.getByText("生产数据库", { exact: true })).toBeVisible();
  for (const release of f.held) release();
  await expect.element(page.getByText("项目数据库", { exact: true })).not.toBeInTheDocument();
  expect(f.writes).toHaveLength(0);
});

it.each(["light", "dark"])(
  "%s 窄屏短窗口仍可滚动完成操作，菜单关闭与 Esc 恢复原入口焦点",
  async (theme) => {
    const f = setup();
    f.items[0]!.configuration = { ...f.items[0]!.configuration, name: "长名称".repeat(30) };
    const previousDark = document.documentElement.classList.contains("dark");
    const previousSize = { width: window.innerWidth, height: window.innerHeight };
    await using _appearance = {
      async [Symbol.asyncDispose]() {
        document.documentElement.classList.toggle("dark", previousDark);
        await page.viewport(previousSize.width, previousSize.height);
      },
    };
    document.documentElement.classList.toggle("dark", theme === "dark");
    await page.viewport(390, 500);
    using _fetch = stubGlobal("fetch", f.fetcher);
    await using screen = await render(<App fixture={f} />);
    await open();
    await menu("长名称".repeat(30), "编辑连接");
    await expect
      .element(page.getByRole("textbox", { name: "连接名称", exact: true }))
      .toHaveFocus();
    await page.getByRole("textbox", { name: "数据库", exact: true }).fill("isolated_narrow");
    await page.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect
      .element(page.getByText("连接配置已保存，请测试当前配置。", { exact: true }))
      .toBeVisible();
    const dialog = document.querySelector('[role="dialog"]')!;
    const bounds = dialog.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
    expect(bounds.height).toBeLessThanOrEqual(window.innerHeight);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "管理环境 MCP", exact: true }))
      .toHaveFocus();
  },
);
