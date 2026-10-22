import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ principal: { id: "actor-a", username: "actor-a" }, authorize: vi.fn() }));
vi.mock("../../../../../../agent-demo/t3-adapters/access.mjs", () => ({ configuredAutoOpsAccess: () => ({ principalForNativeSession: () => mocks.principal, customerRegistry: { listDevices: () => [{ id: "owned" }] } }) }));
vi.mock("../../../../../../agent-demo/t3-adapters/rpc-policy.mjs", () => ({
  authorizeAutoOpsRpc: mocks.authorize,
  filterAutoOpsShell: (_access: unknown, _principal: unknown, value: unknown) => value,
  filterAutoOpsShellItem: (_access: unknown, _principal: unknown, value: unknown) => value,
  prepareAutoOpsRpcPayload: (_access: unknown, _principal: unknown, _method: string, value: unknown) => value,
}));
vi.mock("./resources.ts", () => ({ resourceRequest: () => undefined }));
vi.mock("./personalPreferences.ts", () => ({ overlayPersonalResult: (_session: string, _method: string, value: unknown) => value }));
import { protectHandlers, authorize } from "./rpc.ts";
import { CurrentAutoOpsPrincipal } from "./RequestScope.ts";
import { PRODUCT_CAPABILITY_DISABLED, PRODUCT_CAPABILITY_MESSAGE } from "../../../../../../agent-demo/t3-adapters/product-profile.mjs";

describe("AutoOps signed attachment RPC identity", () => {
  it("exposes only the fixed product restriction message and keeps ACL details private", async () => {
    mocks.authorize.mockReset().mockImplementation(() => { throw Object.assign(new Error("untrusted internal detail"), {code: PRODUCT_CAPABILITY_DISABLED}); });
    const product = await Effect.runPromise(authorize("native-session", "orchestration.dispatchCommand", {}).pipe(Effect.flip));
    expect(product._tag).toBe("EnvironmentAuthorizationError");
    expect(product.message).toBe(PRODUCT_CAPABILITY_MESSAGE);
    mocks.authorize.mockImplementation(() => { throw Object.assign(new Error("private project detail"), {code: "AUTOOPS_OPERATION_FORBIDDEN"}); });
    const acl = await Effect.runPromise(authorize("native-session", "orchestration.dispatchCommand", {}).pipe(Effect.flip));
    expect(acl.message).toBe("AutoOps access denied or session expired.");
    expect(acl.message).not.toContain("private project");
  });
  it("provides the authorized actor to signed asset resolution without leaking into other RPCs", async () => {
    mocks.authorize.mockReset();
    const handlers = protectHandlers({
      "assets.createUrl": (_payload: object) => Effect.service(CurrentAutoOpsPrincipal),
      "orchestration.getThreadProjection": (_payload: object) => Effect.service(CurrentAutoOpsPrincipal),
    }, "native-session", () => Stream.empty);
    const payload = { asset: { type: "chat-attachment", attachmentId: "legacy-pdf" } };
    expect(await Effect.runPromise(handlers["assets.createUrl"](payload))).toEqual(mocks.principal);
    expect(mocks.authorize.mock.calls.some((call) => call[1] === mocks.principal && call[2] === "assets.createUrl" && call[3] === payload)).toBe(true);
    expect(await Effect.runPromise(handlers["orchestration.getThreadProjection"]({ threadId: "thread-a" }))).toBeUndefined();
  });
  it("rechecks a revoked session before running asset resolution", async () => {
    mocks.authorize.mockReset().mockImplementation(() => { throw new Error("expired host session"); });
    const resolve = vi.fn();
    const handlers = protectHandlers({ "assets.createUrl": (_payload: object) => Effect.sync(resolve) }, "native-session", () => Stream.empty);
    await expect(Effect.runPromise(handlers["assets.createUrl"]({}))).rejects.toThrow("expired host session");
    expect(resolve).not.toHaveBeenCalled();
  });
});


describe("AutoOps provider projection", () => {
  it("keeps owned customer skills and filters foreign devices at every config nesting", async () => {
    mocks.authorize.mockReset();
    const owned = { instanceId: "customer-owned-codex", skills: [{ name: "local-check", path: "autoops-customer-skill:opaque", enabled: true }] };
    const foreign = { instanceId: "customer-other-codex", skills: [{ name: "private" }] };
    const platform = { instanceId: "codex", skills: [{ name: "global-not-authorized" }] };
    for (const wrap of [(providers: unknown[]) => ({ providers }), (providers: unknown[]) => ({ config: { providers } }), (providers: unknown[]) => ({ payload: { config: { providers } } })]) {
      const handlers = protectHandlers({ "server.getConfig": () => Effect.succeed(wrap([platform, owned, foreign])) }, "native-session", () => Stream.empty);
      const projected = await Effect.runPromise(handlers["server.getConfig"]());
      expect(projected).toEqual(wrap([{ ...platform, skills: [] }, owned]));
    }
  });
});
