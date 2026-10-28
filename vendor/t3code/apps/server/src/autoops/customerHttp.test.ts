import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Temporary trusted build artifact fixture.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Build a temporary fixture path without adding a FileSystem layer to route tests.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixtures populate the existing host session hash format.
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { AuthSessionId } from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type { AutoOpsAccess } from "../../../../../../agent-demo/t3-adapters/access.mjs";
const mock = vi.hoisted(() => ({ access: undefined as AutoOpsAccess | undefined }));
vi.mock("../../../../../../agent-demo/t3-adapters/access.mjs", async (original) => ({
  ...(await original<typeof import("../../../../../../agent-demo/t3-adapters/access.mjs")>()),
  configuredAutoOpsAccess: () => mock.access,
}));
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from "../../../../../../agent-demo/t3-adapters/access.mjs";
import { layer } from "./customerHttp.ts";
import { layer as filesLayer } from "./customerFilesHttp.ts";
import { RemoteDeviceService, type RemoteDeviceHub } from "./RemoteDeviceService.ts";
const cleanup: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  process.env.AUTOOPS_CUSTOMER_AGENTS = "1";
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  mock.access = undefined;
  delete process.env.AUTOOPS_CUSTOMER_AGENTS;
  delete process.env.AUTOOPS_CUSTOMER_AGENT_BUNDLE;
});
function fixture(fileReader?: RemoteDeviceHub["readFiles"]) {
  const sessions = new DatabaseSync(":memory:"),
    bindings = new DatabaseSync(":memory:");
  cleanup.push(() => {
    sessions.close();
    bindings.close();
  });
  sessions.exec("CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)");
  initializeAutoOpsAccessSchema(bindings);
  for (const ownerId of ["u-admin", "u-guest"])
    sessions
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .run(createHash("sha256").update(ownerId).digest("hex"), ownerId, `csrf-${ownerId}`, 60_000);
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, now: () => 1000 });
  for (const ownerId of ["u-admin", "u-guest"])
    access.recordNativeSession(access.authenticateCookie(`demo_session=${ownerId}`), ownerId);
  mock.access = access;
  const app = HttpRouter.toWebHandler(
    Layer.mergeAll(layer, filesLayer).pipe(
      Layer.provideMerge(Layer.succeed(RemoteDeviceService, { hub: fileReader ? { readFiles: fileReader } as RemoteDeviceHub : undefined })),
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateHttpRequest: (request: { headers: Record<string, string> }) =>
            Effect.succeed({
              sessionId: AuthSessionId.make(request.headers["x-test-session"] ?? "missing"),
              subject: "test",
              method: "bearer-access-token",
              scopes: [],
            }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
    ),
    { disableLogger: true },
  );
  cleanup.push(app.dispose);
  const request = (
    path: string,
    options: { body?: unknown; ownerId?: string; token?: string; csrf?: boolean } = {},
  ) =>
    app.handler(
      new Request(`http://localhost/autoops/customer/${path}`, {
        method: options.body === undefined ? "GET" : "POST",
        headers: {
          ...(options.ownerId ? { "x-test-session": options.ownerId } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(options.ownerId && options.csrf !== false
            ? { "x-demo-csrf": `csrf-${options.ownerId}` }
            : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
  return { request, access };
}
describe("customer registration HTTP boundaries", () => {
  it("电脑文件只允许所有者及当前项目环境，不接受设备令牌冒充浏览器", async () => {
    const f = fixture(async (ownerId, projectId, target, _input, _signal, authorize) => {
      authorize?.();
      f.access.customerRegistry.validateTarget(ownerId, projectId, target);
      return { entries: [{ path: "src/client.ts", kind: "file" }], truncated: false };
    });
    const registry = f.access.customerRegistry;
    const paired = registry.consumePairing(registry.createPairing("u-admin").pairingCode, { label: "文件验收电脑" });
    registry.registerWorkspace(registry.authenticateToken(paired.deviceToken), { registeredWorkspaceId: "files", projectId: "p-autoops", label: "目录", workspaceBindingRevision: 1, runtimeId: "codex" });
    const query = new URLSearchParams({ projectId: "p-autoops", environmentId: "env-test", deviceId: paired.device.id, registeredWorkspaceId: "files", workspaceBindingRevision: "1", input: '{"operation":"list"}' });
    const path = () => `files?${query}`;
    expect((await f.request(path())).status).toBe(401);
    expect((await f.request(path(), { token: paired.deviceToken })).status).toBe(401);
    const valid = await f.request(path(), { ownerId: "u-admin" });
    expect(valid.status).toBe(200); expect(valid.headers.get("cache-control")).toBe("private, no-store");
    expect(await valid.json()).toEqual({ entries: [{ path: "src/client.ts", kind: "file" }], truncated: false });
    expect([403, 404]).toContain((await f.request(path(), { ownerId: "u-guest" })).status);
    query.set("environmentId", "not-authorized"); expect((await f.request(path(), { ownerId: "u-admin" })).status).toBe(403);
    query.set("environmentId", "env-test"); query.set("workspaceBindingRevision", "2");
    expect((await f.request(path(), { ownerId: "u-admin" })).status).toBe(409);
  });
  it("共享原电脑会话允许成员浏览固定目录，转私有后拒绝，不能浏览其他目录", async () => {
    const f = fixture(async (ownerId, projectId, target, _input, _signal, authorize) => {
      authorize?.();
      expect(ownerId).toBe("u-admin");
      f.access.customerRegistry.validateTarget(ownerId, projectId, target);
      return { entries: [{path: "source.txt", kind: "file"}], truncated: false };
    });
    const owner = f.access.authenticateCookie("demo_session=u-admin"), registry=f.access.customerRegistry;
    const paired=registry.consumePairing(registry.createPairing(owner.id).pairingCode,{label:"原电脑"});
    const target={kind:"customer" as const,deviceId:paired.device.id,registeredWorkspaceId:"original",workspaceBindingRevision:1,runtimeId:"codex" as const};
    registry.registerWorkspace(registry.authenticateToken(paired.deviceToken),{registeredWorkspaceId:target.registeredWorkspaceId,workspaceBindingRevision:1,runtimeId:"codex",projectId:"p-autoops",label:"原目录"});
    f.access.bindThread(owner,{threadId:"shared-files",projectId:"p-autoops",environmentId:null,agentId:"a-project",visibility:"project",executionBinding:target});
    const query=new URLSearchParams({threadId:"shared-files",projectId:"p-autoops",deviceId:target.deviceId,registeredWorkspaceId:target.registeredWorkspaceId,workspaceBindingRevision:"1",input:'{"operation":"list"}'});
    expect((await f.request(`files?${query}`,{ownerId:"u-guest"})).status).toBe(200);
    query.set("registeredWorkspaceId","other");
    expect((await f.request(`files?${query}`,{ownerId:"u-guest"})).status).toBe(403);
    query.set("registeredWorkspaceId","original");
    f.access.updateThreadVisibility(owner,"shared-files",{expectedVisibility:"project",visibility:"private"});
    expect((await f.request(`files?${query}`,{ownerId:"u-guest"})).status).toBe(404);
  });
  it("downloads only an authenticated fixed build artifact and reports an unpublished bundle", async () => {
    const { request } = fixture();
    expect((await request("download")).status).toBe(401);
    const unavailable = await request("download", { ownerId: "u-admin" });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      code: "CUSTOMER_BUNDLE_UNAVAILABLE",
      error: "连接程序尚未发布，请联系管理员。",
    });
    const directory = await mkdtemp(join(tmpdir(), "autoops-customer-http-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    process.env.AUTOOPS_CUSTOMER_AGENT_BUNDLE = join(directory, "build.zip");
    await writeFile(
      process.env.AUTOOPS_CUSTOMER_AGENT_BUNDLE,
      "// packaged application; no customer credentials",
    );
    const result = await request("download?path=/etc/passwd&filename=secret", {
      ownerId: "u-admin",
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("content-disposition")).toBe(
      'attachment; filename="autoops-customer-agent.zip"',
    );
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(await result.text()).toBe("// packaged application; no customer credentials");
    expect((await request("download")).status).toBe(401);
  });
  it("pairs once, separates browser CSRF from device credentials, and rejects remote paths", async () => {
    const { request } = fixture();
    expect((await request("pairings", { body: {} })).status).toBe(401);
    expect((await request("pairings", { body: {}, ownerId: "u-guest", csrf: false })).status).toBe(
      403,
    );
    const issued = await request("pairings", { body: { label: "客户电脑" }, ownerId: "u-guest" });
    expect(issued.status).toBe(200);
    const pairing = (await issued.json()) as { pairingCode: string };
    const paired = await request("connector/pair", {
      body: { pairingCode: pairing.pairingCode, label: "本机" },
    });
    expect(paired.status).toBe(200);
    const result = (await paired.json()) as { device: { id: string }; deviceToken: string };
    expect(
      (
        await request("connector/pair", {
          body: { pairingCode: pairing.pairingCode, label: "重复" },
        })
      ).status,
    ).toBe(401);
    expect((await request("connector/state", { ownerId: "u-guest" })).status).toBe(401);
    expect((await request("devices", { token: result.deviceToken })).status).toBe(401);
    const body = {
      registeredWorkspaceId: "workspace-1",
      projectId: "p-autoops",
      label: "本地项目",
      workspaceBindingRevision: 1,
      runtimeId: "codex",
    };
    expect(
      (
        await request("connector/workspaces", {
          body: { ...body, cwd: "C:\\secret" },
          token: result.deviceToken,
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("connector/workspaces", { body, token: result.deviceToken })).status,
    ).toBe(200);
    const state = await request("connector/state", { token: result.deviceToken });
    expect(state.status).toBe(200);
    const text = await state.text();
    expect(text).toContain("workspace-1");
    expect(text).not.toContain(result.deviceToken);
    expect(text).not.toContain("tokenHash");
    expect(
      (
        await request(`devices/${result.device.id}/status`, {
          body: { status: "disabled" },
          ownerId: "u-admin",
        })
      ).status,
    ).toBe(404);
  });
  it("keeps disabled-device recovery access but rejects revoked credentials", async () => {
    const { request } = fixture();
    const pairing = (await (
      await request("pairings", { body: {}, ownerId: "u-admin" })
    ).json()) as { pairingCode: string };
    const paired = (await (
      await request("connector/pair", { body: { pairingCode: pairing.pairingCode, label: "本机" } })
    ).json()) as { device: { id: string }; deviceToken: string };
    expect(
      (
        await request(`devices/${paired.device.id}/status`, {
          body: { status: "disabled" },
          ownerId: "u-admin",
        })
      ).status,
    ).toBe(200);
    expect((await request("connector/state", { token: paired.deviceToken })).status).toBe(200);
    expect(
      (await request(`devices/${paired.device.id}/revoke`, { body: {}, ownerId: "u-admin" }))
        .status,
    ).toBe(200);
    expect((await request("connector/state", { token: paired.deviceToken })).status).toBe(401);
    delete process.env.AUTOOPS_CUSTOMER_AGENTS;
    delete process.env.AUTOOPS_CUSTOMER_AGENT_BUNDLE;
    expect((await request("devices", { ownerId: "u-admin" })).status).toBe(200);
    expect((await request("pairings", { body: {}, ownerId: "u-admin" })).status).toBe(409);
  });
});
