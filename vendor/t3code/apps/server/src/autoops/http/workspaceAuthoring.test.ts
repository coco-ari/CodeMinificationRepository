import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import { vi } from "vite-plus/test";
import type {
  AutoOpsAccess,
  AutoOpsPrincipal,
  ProjectMembership,
} from "../../../../../../../agent-demo/t3-adapters/access.mjs";
import type { handleWorkspaceAuthoringRequest } from "../../../../../../../agent-demo/t3-adapters/workspace-authoring-http.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";

const controller = vi.hoisted(() => ({ handle: vi.fn<typeof handleWorkspaceAuthoringRequest>() }));
vi.mock("../../../../../../../agent-demo/t3-adapters/workspace-authoring-http.ts", () => ({
  handleWorkspaceAuthoringRequest: controller.handle,
}));

import { workspaceAuthoringRoutes } from "./workspaceAuthoring.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const base = "/api/v1/projects/project-a/workspace";

function setup({ reader = true, manager = true } = {}) {
  controller.handle.mockReset().mockResolvedValue({ status: 200, body: { accepted: true } });
  const principal: AutoOpsPrincipal = {
    id: "actor-a", displayName: "隔离测试成员", role: "member", sessionHash: "fixture-session",
    csrf: "fixture-csrf", expiresAt: 60_000,
  };
  const membership: ProjectMembership = {
    userId: principal.id, workspaceAccess: "internal", role: manager ? "manager" : "member",
    environmentIds: [], status: "active",
  };
  const deny = (code: string) => { throw Object.assign(new Error("测试权限拒绝"), { status: 403, code }); };
  const access = {
    requireCsrf(_principal: AutoOpsPrincipal, token: unknown) {
      if (token !== principal.csrf) deny("CSRF_INVALID");
    },
    requireWorkspace(_principal: AutoOpsPrincipal, projectId: string, type: string) {
      if (!reader || projectId !== "project-a" || type !== "internal") deny("WORKSPACE_FORBIDDEN");
      return membership;
    },
    requireWorkspaceManager() {
      if (!manager) deny("WORKSPACE_MANAGE_FORBIDDEN");
      return membership;
    },
  } satisfies Pick<AutoOpsAccess, "requireCsrf" | "requireWorkspace" | "requireWorkspaceManager">;
  // 只替换业务控制器与身份端口；真实路由负责授权顺序、正文读取、解析和响应映射。
  const routes = workspaceAuthoringRoutes({ access: access as unknown as AutoOpsAccess, principal: Effect.succeed(principal) }).pipe(
    HttpRouter.provideRequest(Layer.mock(EnvironmentAuth.EnvironmentAuth)({})),
  );
  const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
  return { routes, app, [Symbol.asyncDispose]: () => app.dispose() };
}
function uploadRequest({ csrf = true, metadata = encodeJson({ requestId: "upload-a", expectedRevision: 0, path: "docs/产品说明.md", size: 6, sha256: "fixture-hash", conflict: "replace" }), bytes = new TextEncoder().encode("测试") } = {}) {
  return new Request(`http://localhost${base}/uploads?input=${encodeURIComponent(metadata)}`, {
    method: "POST", headers: { "content-type": "application/octet-stream", ...(csrf ? { "x-demo-csrf": "fixture-csrf" } : {}) }, body: bytes,
  });
}

describe("工作区资料真实 HTTP 路由", () => {
  it("CSRF拒绝发生在读取上传字节之前", async () => {
    await using fixture = setup();
    const request = uploadRequest({ csrf: false });
    using read = vi.spyOn(request, "arrayBuffer");
    const response = await fixture.app.handler(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CSRF_INVALID" });
    expect(read).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(controller.handle).not.toHaveBeenCalled();
  });

  it("没有内部工作区权限或只有阅读权限时，上传均在读字节之前拒绝", async () => {
    for (const authorization of [{ reader: false, manager: false }, { reader: true, manager: false }]) {
      await using fixture = setup(authorization);
      const request = uploadRequest();
      using read = vi.spyOn(request, "arrayBuffer");
      const response = await fixture.app.handler(request);
      expect(response.status).toBe(403);
      expect(read).not.toHaveBeenCalled();
      expect(request.bodyUsed).toBe(false);
      expect(controller.handle).not.toHaveBeenCalled();
    }
  });

  it("阅读者可以GET资料，但POST资料变更要求管理权限", async () => {
    await using fixture = setup({ manager: false });
    const read = await fixture.app.handler(new Request(`http://localhost${base}/authoring`));
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    expect(await read.json()).toEqual({ accepted: true });
    controller.handle.mockClear();
    const request = new Request(`http://localhost${base}/documents`, {
      method: "POST", headers: { "content-type": "application/json", "x-demo-csrf": "fixture-csrf" },
      body: encodeJson({ action: "directory", input: { path: "docs", requestId: "folder-a", expectedRevision: 0 } }),
    });
    using readBody = vi.spyOn(request, "text");
    const denied = await fixture.app.handler(request);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "WORKSPACE_MANAGE_FORBIDDEN" });
    expect(readBody).not.toHaveBeenCalled();
    expect(controller.handle).not.toHaveBeenCalled();
  });

  it("原始上传完整传递解码后的资料元数据和原始字节", async () => {
    await using fixture = setup();
    const request = uploadRequest();
    const response = await fixture.app.handler(request);
    expect(response.status).toBe(200);
    const accepted = controller.handle.mock.calls[0]?.[0];
    expect(accepted?.method).toBe("POST");
    expect(accepted?.principal.id).toBe("actor-a");
    expect(accepted?.input).toEqual({ requestId: "upload-a", expectedRevision: 0, path: "docs/产品说明.md", size: 6, sha256: "fixture-hash", conflict: "replace" });
    expect(accepted?.bytes).toEqual(new TextEncoder().encode("测试"));
    expect(controller.handle).toHaveBeenCalledTimes(1);
  });

  it("损坏的上传元数据在消耗原始字节前返回400", async () => {
    await using fixture = setup();
    const request = uploadRequest({ metadata: "{broken-json" });
    using read = vi.spyOn(request, "arrayBuffer");
    const response = await fixture.app.handler(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "WORKSPACE_REQUEST_INVALID" });
    expect(read).not.toHaveBeenCalled();
    expect(controller.handle).not.toHaveBeenCalled();
  });

  it("未知路由404，不调用业务控制器", async () => {
    await using fixture = setup();
    const response = await fixture.app.handler(new Request(`http://localhost${base}/not-a-route`));
    expect(response.status).toBe(404);
    expect(controller.handle).not.toHaveBeenCalled();
  });

  it.effect("Node HTTP传输执行8MiB原始上传和2MiB JSON正文上限", () =>
    Effect.gen(function* () {
      const fixture = setup();
      yield* Effect.addFinalizer(() => Effect.promise(() => fixture.app.dispose()));
      // Web Request适配器不执行MaxBodySize，大小边界必须通过生产使用的Node传输证明。
      const services = yield* Layer.build(HttpRouter.serve(fixture.routes, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
      ));
      const client = Context.get(services, HttpClient.HttpClient);
      const upload = yield* client.execute(HttpClientRequest.post(`${base}/uploads?input=${encodeURIComponent(encodeJson({ path: "docs/large.bin" }))}`).pipe(
        HttpClientRequest.setHeader("x-demo-csrf", "fixture-csrf"),
        HttpClientRequest.bodyUint8Array(new Uint8Array(8 * 1024 * 1024 + 1)),
      ));
      expect(upload.status).toBe(413);
      expect(yield* upload.json).toMatchObject({ code: "WORKSPACE_UPLOAD_SIZE" });
      const json = yield* client.execute(HttpClientRequest.post(`${base}/documents`).pipe(
        HttpClientRequest.setHeader("x-demo-csrf", "fixture-csrf"),
        HttpClientRequest.bodyText(encodeJson({ text: "x".repeat(2 * 1024 * 1024) }), "application/json"),
      ));
      expect(json.status).toBe(413);
      expect(yield* json.json).toMatchObject({ code: "WORKSPACE_REQUEST_INVALID" });
      expect(controller.handle).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );

  it.effect("未声明长度的超限上传仍被截断，未知传输结果不能进入业务控制器", () =>
    Effect.gen(function* () {
      const fixture = setup();
      yield* Effect.addFinalizer(() => Effect.promise(() => fixture.app.dispose()));
      const services = yield* Layer.build(HttpRouter.serve(fixture.routes, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
      ));
      const client = Context.get(services, HttpClient.HttpClient);
      expect((yield* client.get(`${base}/authoring`)).status).toBe(200);
      controller.handle.mockClear();
      const result = yield* client.execute(HttpClientRequest.post(`${base}/uploads?input=${encodeURIComponent(encodeJson({ path: "docs/large.bin" }))}`).pipe(
        HttpClientRequest.setHeader("x-demo-csrf", "fixture-csrf"),
        HttpClientRequest.bodyStream(Stream.make(new Uint8Array(8 * 1024 * 1024 + 1))),
      )).pipe(Effect.exit);
      // Node流超过上限可能先关闭socket；无论收到413或传输失败，都不能伪造业务写入成功。
      if (Exit.isSuccess(result)) expect(result.value.status).toBe(413);
      else expect(result.cause.reasons.some(reason => reason._tag === "Fail")).toBe(true);
      expect(controller.handle).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );
});
