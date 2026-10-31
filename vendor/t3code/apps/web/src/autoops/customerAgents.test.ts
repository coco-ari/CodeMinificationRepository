import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import type { AutoOpsThreadScope, AutoOpsT3Bootstrap } from "./hostConfig";
import type { CustomerCapabilities } from "./customerAgents";
import { getProviderOptionCurrentLabel, getProviderOptionDescriptors } from "@t3tools/shared/model";
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
      membership: { workspaceAccess: "external", role: "external", environmentIds: ["test"] },
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
  vi.restoreAllMocks();
  vi.resetModules();
});
describe("customer workspace UI boundary", () => {
  it("获分配的电脑助手按项目与原参数读取能力，不查询提供者设备管理目录", async () => {
    const host = await import('./hostConfig')
    host.installAutoOpsHost(bootstrap, 'https://work.test')
    const question = {
      assistantId: 'provided-one', presetRevision: 2,
      configuration: { agentId: 'a-project', executionBinding: target, environmentId: null,
        workspaceType: null, visibility: 'private' as const,
        model: { instanceId: 'customer-device-1-codex', model: 'local-model', reasoningEffort: 'high' as const }, skillIds: [] },
    }
    const projected = { target, profile: 'linux-docker-readonly-v1', available: false,
      reason: { code: 'ASSISTANT_MODEL_UNAVAILABLE', message: '原模型已下线，请选择目录中可用模型' },
      device: { id: target.deviceId, label: '项目已分配电脑', status: 'active', online: true },
      workspace: { label: '获准目录', status: 'active' }, capabilities: catalog }
    const fetch = vi.fn().mockResolvedValue(Response.json(projected))
    vi.stubGlobal('fetch', fetch)
    const { loadCustomerAssistantRuntime } = await import('./customerAgents')
    await expect(loadCustomerAssistantRuntime('p-autoops', question)).resolves.toEqual(projected)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [path, init] = fetch.mock.calls[0]!
    expect(path).toBe('/api/agent-demo/t3/autoops/customer/assistant-runtime')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ projectId: 'p-autoops', question })
    expect(new Headers(init.headers).get('x-demo-csrf')).toBe('csrf')
  })
  it("助手能力响应串入其他目录时明确拒绝，撤权不退回设备所有者接口", async () => {
    const host = await import('./hostConfig')
    host.installAutoOpsHost(bootstrap, 'https://work.test')
    const question = {
      assistantId: 'provided-one', presetRevision: 2,
      configuration: { agentId: 'a-project', executionBinding: target, environmentId: null,
        workspaceType: null, visibility: 'private' as const,
        model: { instanceId: 'customer-device-1-codex', model: 'local-model', reasoningEffort: 'high' as const }, skillIds: [] },
    }
    const projected = { target, profile: 'self', available: true,
      device: { id: target.deviceId, label: '已分配电脑', status: 'active', online: true },
      workspace: { label: '获准目录', status: 'active' },
      capabilities: { ...catalog, registeredWorkspaceId: 'other-directory' } }
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(projected))
      .mockResolvedValueOnce(Response.json({ error: { code: 'ASSISTANT_WITHDRAWN', message: '助手已撤回' } }, { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    const { loadCustomerAssistantRuntime } = await import('./customerAgents')
    await expect(loadCustomerAssistantRuntime('p-autoops', question)).rejects.toMatchObject({ code: 'CUSTOMER_RUNTIME_SCOPE_CHANGED' })
    await expect(loadCustomerAssistantRuntime('p-autoops', question)).rejects.toMatchObject({ code: 'ASSISTANT_WITHDRAWN', status: 403 })
    expect(fetch.mock.calls.map(call => call[0])).toEqual(Array(2).fill('/api/agent-demo/t3/autoops/customer/assistant-runtime'))
  })
  it('能力响应返回前切换实际调用者，拒绝旧账号结果', async () => {
    const host = await import('./hostConfig')
    host.installAutoOpsHost(bootstrap, 'https://work.test')
    const question = { assistantId: 'provided-one', presetRevision: 2,
      configuration: { agentId: 'a-project', executionBinding: target, environmentId: null,
        workspaceType: null, visibility: 'private' as const,
        model: { instanceId: 'customer-device-1-codex', model: 'local-model', reasoningEffort: 'high' as const }, skillIds: [] } }
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const { loadCustomerAssistantRuntime } = await import('./customerAgents')
    const result = loadCustomerAssistantRuntime('p-autoops', question)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    vi.spyOn(host, 'readAutoOpsHost').mockReturnValue({ ...host.readAutoOpsHost()!, principal: { id: 'other-actor', displayName: '另一用户' } })
    finish(Response.json({ target, profile: 'self', available: true,
      device: { id: target.deviceId, label: '旧账号电脑', status: 'active', online: true },
      workspace: { label: '原目录', status: 'active' }, capabilities: catalog }))
    await expect(result).rejects.toMatchObject({ code: 'CUSTOMER_RUNTIME_ACTOR_CHANGED', status: 401 })
  })
  it("显示本机默认思考档位，并保留用户显式选择及未知默认值", async () => {
    const host = await import("./hostConfig");
    host.installAutoOpsHost(bootstrap, "https://work.test");
    const { customerScopedProviders, customerInstanceId } = await import("./customerAgents");
    const entries = [provider(customerInstanceId(target))];
    const scoped = customerScopedProviders(entries, scope, {
      ...catalog,
      models: [{ ...catalog.models[0]!, defaultReasoningEffort: "high" }],
    });
    const caps = scoped[0]!.models[0]!.capabilities;
    if (!caps) throw new Error("客户模型缺少能力描述");
    expect(getProviderOptionCurrentLabel(getProviderOptionDescriptors({ caps })[0])).toBe("高");
    expect(
      getProviderOptionCurrentLabel(
        getProviderOptionDescriptors({
          caps,
          selections: [{ id: "reasoningEffort", value: "low" }],
        })[0],
      ),
    ).toBe("低");
    const unreported = customerScopedProviders(entries, scope, catalog)[0]!.models[0]!.capabilities;
    if (!unreported) throw new Error("客户模型缺少能力描述");
    expect(
      getProviderOptionCurrentLabel(getProviderOptionDescriptors({ caps: unreported })[0]),
    ).toBeUndefined();
  });
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
  it("外部成员显式调整会话可见范围时保持客户目标，仍拒绝平台内部资料和越权环境", async () => {
    const host = await import("./hostConfig");
    host.installAutoOpsHost(bootstrap, "https://work.test");
    host.setAutoOpsThreadScope("draft", scope);
    expect(host.readAutoOpsThreadScope("draft", "p-autoops")).toEqual(scope);
    host.setAutoOpsThreadScope("draft", { ...scope, visibility: "project" });
    expect(host.readAutoOpsThreadScope("draft", "p-autoops")).toEqual({ ...scope, visibility: "project" });
    for (const patch of [
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
