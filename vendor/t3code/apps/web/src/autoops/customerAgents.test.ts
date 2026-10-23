import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import type { AutoOpsThreadScope, AutoOpsT3Bootstrap } from "./hostConfig";
import type { CustomerCapabilities } from "./customerAgents";
const target = {
  kind: "customer" as const,
  deviceId: "device-1",
  registeredWorkspaceId: "workspace-1",
  workspaceBindingRevision: 2,
  runtimeId: "codex" as const,
};
const scope: AutoOpsThreadScope = {
  projectId: "p-autoops",
  environmentId: "test",
  agentId: "a-project",
  visibility: "private",
  executionBinding: target,
};
const bootstrap: AutoOpsT3Bootstrap = {
  principal: { id: "customer-owner", displayName: "Owner" },
  gatewayBasePath: "/api/agent-demo/t3",
  csrfToken: "csrf",
  fixedModel: { instanceId: "codex", model: "platform-default" },
  runtimeMode: "approval-required",
  customerAgentsEnabled: true,
  projects: [
    {
      id: "p-autoops",
      name: "AutoOps",
      environments: [{ id: "test", name: "测试" }],
      agents: [{ id: "a-project", name: "项目助手" }],
      membership: { workspaceAccess: "external", role: "member", environmentIds: ["test"] },
    },
  ],
  capabilities: {},
};
const catalog: CustomerCapabilities = {
  ...target,
  revision: "catalog-1",
  protocolVersion: 1,
  updatedAt: "2026-10-22T00:00:00Z",
  models: [{ id: "local-model", supportedReasoningEfforts: ["low", "high"] }],
  skills: [{ id: "opaque-skill-1", name: "review", description: "本地代码审查" }],
};
function provider(instanceId: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-22T00:00:00Z",
    models: [{ slug: "unscoped", name: "unscoped", isCustom: false, capabilities: {} }],
    skills: [],
    slashCommands: [],
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
describe("customer workspace UI boundary", () => {
  it("uses the fixed customer's server availability without enabling platform providers", async () => {
    const host = await import("./hostConfig");
    host.installAutoOpsHost(bootstrap, "https://work.test");
    const { deriveProviderInstanceEntries } = await import("~/providerInstances");
    const { customerProviderAvailability, customerInstanceId } = await import("./customerAgents");
    const entries = deriveProviderInstanceEntries([
      provider("codex"),
      provider(customerInstanceId(target)),
    ]).map((entry) => ({ ...entry, enabled: false }));
    expect(customerProviderAvailability(entries, scope).map((entry) => entry.enabled)).toEqual([
      false,
      true,
    ]);
    expect(
      customerProviderAvailability(entries, {
        ...scope,
        executionBinding: { kind: "platform" },
      }).map((entry) => entry.enabled),
    ).toEqual([false, false]);
    const disabled = entries.map((entry) => ({
      ...entry,
      snapshot: { ...entry.snapshot, enabled: false },
    }));
    expect(customerProviderAvailability(disabled, scope).every((entry) => !entry.enabled)).toBe(
      true,
    );
  });
  it("allows an external project member to select their private customer target without platform internal fields", async () => {
    const host = await import("./hostConfig");
    host.installAutoOpsHost(bootstrap, "https://work.test");
    host.setAutoOpsThreadScope("draft", scope);
    expect(host.readAutoOpsThreadScope("draft", "p-autoops")).toEqual(scope);
    for (const patch of [
      { visibility: "project" as const },
      { workspaceType: "internal" as const },
      { workspaceVersionId: "platform-version" },
      { environmentId: "production" },
    ]) {
      expect(() => host.setAutoOpsThreadScope("draft", { ...scope, ...patch })).toThrow(/无权/);
    }
    const { autoOpsResourceCwd } = await import("./resources");
    expect(autoOpsResourceCwd("draft", "p-autoops", scope)).toBeNull();
  });
  it("sends the exact registered target before launch and keeps it immutable after acceptance", async () => {
    const host = await import("./hostConfig");
    host.installAutoOpsHost(bootstrap, "https://work.test");
    host.setAutoOpsThreadScope("draft", scope);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "会话范围尚未保存" }, { status: 404 }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ binding: { ...scope, scopeState: "draft" } }),
      });
    vi.stubGlobal("fetch", fetch);
    const { prepareHostThreadLaunch } = await import("@t3tools/client-runtime/host-integration");
    await prepareHostThreadLaunch({ threadId: "draft", projectId: "p-autoops" });
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual({ threadId: "draft", ...scope });
    const locked = { ...scope, scopeState: "locked" as const, scopeLocked: true };
    host.setAutoOpsThreadScope("draft", locked);
    for (const patch of [
      { deviceId: "device-2" },
      { registeredWorkspaceId: "workspace-2" },
      { workspaceBindingRevision: 3 },
    ]) {
      expect(() =>
        host.setAutoOpsThreadScope("draft", {
          ...scope,
          executionBinding: { ...target, ...patch },
        }),
      ).toThrow(/固定/);
    }
    expect(
      host.sameAutoOpsThreadScope(locked, {
        ...locked,
        executionBinding: {
          runtimeId: "codex",
          workspaceBindingRevision: 2,
          registeredWorkspaceId: "workspace-1",
          deviceId: "device-1",
          kind: "customer",
        },
      }),
    ).toBe(true);
  });
  it("preserves customer model/reasoning at the host turn boundary while keeping platform fixed model policy", async () => {
    const host = await import("./hostConfig");
    host.installAutoOpsHost(bootstrap, "https://work.test");
    host.setAutoOpsThreadScope("customer-draft", scope);
    const { readHostTurnConfiguration } = await import("@t3tools/client-runtime/host-integration");
    expect(readHostTurnConfiguration({ threadId: "customer-draft" })).toEqual({
      runtimeMode: "approval-required",
    });
    expect(readHostTurnConfiguration({ threadId: "platform-draft" })).toEqual({
      runtimeMode: "approval-required",
      modelSelection: { instanceId: "codex", model: "platform-default" },
    });
  });
  it("uses only this workspace capability cache and keeps native readiness unchanged", async () => {
    const host = await import("./hostConfig");
    host.installAutoOpsHost(bootstrap, "https://work.test");
    const { customerScopedProviders, customerInstanceId } = await import("./customerAgents");
    const selected = { ...provider(customerInstanceId(target)), status: "error" as const };
    const providers = [provider("codex"), selected, provider("customer-device-2-codex")];
    expect(
      customerScopedProviders(providers, undefined, null).map((entry) => entry.instanceId),
    ).toEqual(["codex"]);
    const scoped = customerScopedProviders(providers, scope, catalog);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.status).toBe("error");
    expect(scoped[0]?.models[0]).toMatchObject({
      slug: "local-model",
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            type: "select",
            options: [
              { id: "low", label: "低" },
              { id: "high", label: "高" },
            ],
          },
        ],
      },
    });
    expect(scoped[0]?.skills).toEqual([
      {
        name: "review",
        description: "本地代码审查",
        path: "autoops-customer-skill:opaque-skill-1",
        scope: "客户本机",
        enabled: true,
      },
    ]);
    for (const patch of [
      { deviceId: "device-2" },
      { registeredWorkspaceId: "workspace-2" },
      { workspaceBindingRevision: 1 },
    ]) {
      const mismatched = customerScopedProviders(providers, scope, { ...catalog, ...patch })[0];
      expect(mismatched?.models).toEqual([]);
      expect(mismatched?.skills).toEqual([]);
    }
    expect(customerScopedProviders([providers[0]!], scope, catalog)).toEqual([]);
  });
  it("uses same-origin authenticated metadata requests and presents a useful non-JSON failure", async () => {
    const host = await import("./hostConfig");
    host.installAutoOpsHost(bootstrap, "https://work.test");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pairingCode: "one-time" }) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => {
          throw new Error("html");
        },
      });
    vi.stubGlobal("fetch", fetch);
    const { customerRequest } = await import("./customerAgents");
    await expect(customerRequest("pairings", {})).resolves.toEqual({ pairingCode: "one-time" });
    expect(fetch).toHaveBeenCalledWith(
      "/api/agent-demo/t3/autoops/customer/pairings",
      expect.objectContaining({
        credentials: "same-origin",
        method: "POST",

      }),
    );
    expect(new Headers(fetch.mock.calls[0]?.[1].headers).get('x-demo-csrf')).toBe('csrf');
    await expect(customerRequest("devices")).rejects.toMatchObject({ code: 'REQUEST_FAILED', uncertain: false });
  });
});
