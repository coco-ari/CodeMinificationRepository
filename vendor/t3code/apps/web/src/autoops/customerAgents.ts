import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import type { ProviderInstanceEntry } from "~/providerInstances";
import type {
  CustomerCapabilities,
  CustomerDevice,
  CustomerWorkspace,
} from "../../../../../../agent-demo/t3-adapters/customer-registry.mjs";
import {
  readAutoOpsHost,
  type AutoOpsExecutionBinding,
  type AutoOpsThreadScope,
} from "./hostConfig";
export type { CustomerCapabilities, CustomerDevice, CustomerWorkspace };
export type CustomerTarget = Extract<AutoOpsExecutionBinding, { kind: "customer" }>;
export const isCustomerScope = (scope: AutoOpsThreadScope | undefined) =>
  scope?.executionBinding?.kind === "customer";
export const customerInstanceId = (target: CustomerTarget) =>
  ProviderInstanceId.make(`customer-${target.deviceId}-${target.runtimeId}`);
export const customerTargetKey = (target: CustomerTarget) =>
  `${target.deviceId}/${target.registeredWorkspaceId}/${target.workspaceBindingRevision}/${target.runtimeId}`;
/** Dynamic customer instances are not machine settings. Their enablement comes
 * from the authenticated server snapshot for the exact fixed workspace target. */
export function customerProviderAvailability(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  scope: AutoOpsThreadScope | undefined,
) {
  const host = readAutoOpsHost();
  const target = scope?.executionBinding?.kind === "customer" ? scope.executionBinding : null;
  if (!host || !target) return entries;
  const id = customerInstanceId(target);
  return entries.map((entry) =>
    entry.instanceId === id
      ? { ...entry, enabled: host.customerAgentsEnabled === true && entry.snapshot.enabled }
      : entry,
  );
}
export async function customerRequest<T>(
  path: string,
  input?: object,
  signal?: AbortSignal,
): Promise<T> {
  const host = readAutoOpsHost();
  if (!host) throw new Error("项目工作台未连接。");
  const response = await fetch(`${host.gatewayBasePath}/autoops/customer/${path}`, {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
    ...(input
      ? {
          method: "POST",
          headers: { "content-type": "application/json", "x-demo-csrf": host.csrfToken },
          body: JSON.stringify(input),
        }
      : {}),
  });
  const result = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || result === null)
    throw new Error(result?.error ?? "客户设备请求失败，请重试。");
  return result;
}
export async function loadCustomerWorkspaces(projectId?: string, signal?: AbortSignal) {
  return customerRequest<{ workspaces: CustomerWorkspace[] }>(
    `workspaces${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    undefined,
    signal,
  );
}
export async function loadCustomerCapabilities(target: CustomerTarget, signal?: AbortSignal) {
  const query = new URLSearchParams({
    deviceId: target.deviceId,
    registeredWorkspaceId: target.registeredWorkspaceId,
    workspaceBindingRevision: String(target.workspaceBindingRevision),
    runtimeId: target.runtimeId,
  });
  return (
    await customerRequest<{ capabilities: CustomerCapabilities | null }>(
      `capabilities?${query}`,
      undefined,
      signal,
    )
  ).capabilities;
}
export function useCustomerRuntime(scope: AutoOpsThreadScope | undefined) {
  const target = scope?.executionBinding?.kind === "customer" ? scope.executionBinding : null;
  const key = target ? customerTargetKey(target) : null;
  const [state, setState] = useState<{
    key: string;
    catalog: CustomerCapabilities | null;
    device: CustomerDevice | null;
    error: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!target || !key) return;
    const controller = new AbortController();
    let reading = false;
    const read = async () => {
      if (reading || controller.signal.aborted) return;
      reading = true;
      try {
        const [catalog, devices] = await Promise.all([
          loadCustomerCapabilities(target, controller.signal),
          customerRequest<{ devices: CustomerDevice[] }>("devices", undefined, controller.signal),
        ]);
        if (!controller.signal.aborted)
          setState({
            key,
            catalog,
            device: devices.devices.find((entry) => entry.id === target.deviceId) ?? null,
            error: null,
          });
      } catch (cause) {
        if (!controller.signal.aborted)
          setState((current) => ({
            key,
            catalog: current?.key === key ? current.catalog : null,
            device: current?.key === key ? current.device : null,
            error: cause instanceof Error ? cause.message : "无法读取客户运行器",
          }));
      }
      reading = false;
    };
    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", refreshOnFocus);
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [key, attempt]);
  const current = state?.key === key ? state : null;
  return {
    target,
    catalog: current?.catalog ?? null,
    device: current?.device ?? null,
    error: current?.error ?? null,
    loading: target !== null && current === null,
    refresh: () => setAttempt((value) => value + 1),
  };
}
const reasoningLabels: Record<string, string> = {
  none: "不思考",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
  ultra: "极高",
};
/** Adapt only cached workspace metadata; execution state and chat stay native T3. */
export function customerScopedProviders(
  providers: ReadonlyArray<ServerProvider>,
  scope: AutoOpsThreadScope | undefined,
  catalog: CustomerCapabilities | null,
): ReadonlyArray<ServerProvider> {
  const host = readAutoOpsHost();
  if (!host) return providers;
  const target = scope?.executionBinding?.kind === "customer" ? scope.executionBinding : null;
  if (!target) return providers.filter((entry) => entry.instanceId === host.fixedModel.instanceId);
  const instanceId = customerInstanceId(target);
  // Never expose another workspace's cache during a draft/route transition.
  const capabilities =
    catalog &&
    catalog.deviceId === target.deviceId &&
    catalog.registeredWorkspaceId === target.registeredWorkspaceId &&
    catalog.workspaceBindingRevision === target.workspaceBindingRevision &&
    catalog.runtimeId === target.runtimeId
      ? catalog
      : null;
  return providers
    .filter((entry) => entry.instanceId === instanceId)
    .map((entry) => ({
      ...entry,
      version: capabilities?.runtimeVersion ?? null,
      models:
        capabilities?.models.map((model) => ({
          slug: model.id,
          name: model.name ?? model.id,
          isCustom: false,
          capabilities: {
            optionDescriptors: model.supportedReasoningEfforts.length
              ? [
                  {
                    id: "reasoningEffort",
                    label: "思考强度",
                    type: "select" as const,
                    options: model.supportedReasoningEfforts.map((id) => ({
                      id,
                      label: reasoningLabels[id] ?? id,
                    })),
                  },
                ]
              : [],
          },
        })) ?? [],
      skills:
        capabilities?.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: `autoops-customer-skill:${skill.id}`,
          scope: "客户本机",
          enabled: true,
        })) ?? [],
      slashCommands: [],
      workspaceSnapshots: [],
    }));
}
