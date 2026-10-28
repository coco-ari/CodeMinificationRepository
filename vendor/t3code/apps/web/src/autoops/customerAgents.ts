import { autoOpsRequest, AutoOpsRequestError, isAutoOpsAccessError } from './apiClient'
import { decodeContract } from '../../../../../../autoops/contracts/index.ts'
import { CustomerAssistantRuntimeRequest, type CustomerAssistantRuntime } from '../../../../../../autoops/contracts/customer-assistant-runtime.ts'
import type { AssistantSelection } from '../../../../../../autoops/contracts/assistants.ts'
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import type { ProviderInstanceEntry } from "~/providerInstances";
import type {
  CustomerCapabilities,
  CustomerDevice,
  CustomerWorkspace,
} from "../../../../../../autoops/contracts/runtime.ts";
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
export const customerTargetKey = (target: Pick<CustomerTarget, 'deviceId' | 'registeredWorkspaceId' | 'workspaceBindingRevision' | 'runtimeId'>) =>
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
export const customerRequest = <T>(path: string, input?: object, signal?: AbortSignal): Promise<T> =>
  autoOpsRequest<T>(`/autoops/customer/${path}`, {
    label: '客户设备', ...(input === undefined ? {} : { body: input }), ...(signal ? { signal } : {}),
  })

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
export async function loadCustomerAssistantRuntime(projectId: string, question: AssistantSelection, signal?: AbortSignal) {
  const actorId = readAutoOpsHost()?.principal.id
  const input = decodeContract(CustomerAssistantRuntimeRequest, { projectId, question })
  const target = question.configuration.executionBinding
  if (target.kind !== 'customer') throw new AutoOpsRequestError('当前助手不使用电脑运行器。', 'CUSTOMER_RUNTIME_TARGET_INVALID', 400)
  const result = await autoOpsRequest<CustomerAssistantRuntime>('/autoops/customer/assistant-runtime', {
    label: '助手运行能力', body: input, timeoutMs: 30_000, ...(signal ? { signal } : {}),
  })
  if (readAutoOpsHost()?.principal.id !== actorId)
    throw new AutoOpsRequestError('登录账号已变更，请重新读取当前助手。', 'CUSTOMER_RUNTIME_ACTOR_CHANGED', 401)
  if (customerTargetKey(result.target) !== customerTargetKey(target) || result.device.id !== target.deviceId ||
      (result.capabilities && customerTargetKey(result.capabilities) !== customerTargetKey(target)))
    throw new AutoOpsRequestError('运行能力与当前助手不一致，请刷新重试。', 'CUSTOMER_RUNTIME_SCOPE_CHANGED', 409)
  return result
}
export function customerRuntimeRequestKey(scope: AutoOpsThreadScope | undefined) {
  const target = scope?.executionBinding?.kind === "customer" ? scope.executionBinding : null;
  const principalId = readAutoOpsHost()?.principal.id;
  return target ? JSON.stringify([principalId, scope?.projectId, scope?.threadId, scope?.visibility, target, scope?.question]) : null;
}
export function useCustomerRuntime(scope: AutoOpsThreadScope | undefined) {
  const target = scope?.executionBinding?.kind === "customer" ? scope.executionBinding : null;
  const key = customerRuntimeRequestKey(scope);
  const [state, setState] = useState<{
    key: string;
    catalog: CustomerCapabilities | null;
    device: Pick<CustomerDevice, 'id' | 'label' | 'status' | 'online'> | null;
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
        if (scope?.question || (scope?.threadId && scope.scopeState === 'locked')) {
          const runtime = scope.threadId && scope.scopeState === 'locked'
            ? await autoOpsRequest<CustomerAssistantRuntime>('/autoops/customer/assistant-runtime', {
                label: '会话运行能力', body: decodeContract(CustomerAssistantRuntimeRequest, {threadId: scope.threadId}),
                signal: controller.signal, timeoutMs: 30_000,
              })
            : await loadCustomerAssistantRuntime(scope.projectId, scope.question!, controller.signal)
          if (!controller.signal.aborted)
            setState({ key, catalog: runtime.capabilities, device: runtime.device,
              error: runtime.available ? null : runtime.reason?.message ?? '当前助手配置不可用，请核对实际能力' })
          return
        }
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
            // 读取失败后停止提供新的模型和skill候选；历史消息由原生会话保留。
            catalog: null,
            device: !isAutoOpsAccessError(cause) && current?.key === key ? current.device : null,
            error: cause instanceof Error ? cause.message : "无法读取客户运行器",
          }));
      } finally { reading = false; }
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
    requestKey: key,
    target,
    catalog: current?.catalog ?? null,
    device: current?.device ?? null,
    error: current?.error ?? null,
    loading: target !== null && current === null,
    refresh: () => setAttempt((value) => value + 1),
  };
}
export type CustomerRuntime = ReturnType<typeof useCustomerRuntime>;
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
                      ...(id === model.defaultReasoningEffort ? { isDefault: true } : {}),
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
