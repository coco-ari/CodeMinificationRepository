import { autoOpsRequest } from "../apiClient";
import type {
  DeploymentNodeReceipt,
  DeploymentServer,
  DeploymentServerManagement,
  DeploymentServerRegistration,
  DeploymentGlobalNodeCatalog,
  DeploymentNodeAssignment,
} from "../../../../../../../autoops/contracts/deployments";

export type { DeploymentNodeReceipt, DeploymentServer, DeploymentServerManagement, DeploymentServerRegistration, DeploymentGlobalNodeCatalog };

export type DeploymentServerMutation =
  | { kind: "create"; input: { name: string; requestId: string } }
  | { kind: "registration"; serverId: string; input: { requestId: string } }
  | { kind: "assign"; serverId: string; input: { projectId: string; environmentIds: string[]; expectedRevision: number; requestId: string } }
  | {
      kind: "bind" | "unbind";
      serverId: string;
      input: { environmentId: string; requestId: string };
    }
  | { kind: "revoke"; serverId: string; input: { requestId: string } }
  | { kind: "access"; serverId: string; projectId: string; input: { allowed: boolean; expectedRevision: number; requestId: string } }
  | { kind: "delete"; serverId: string; input: { requestId: string } }
  | {
      kind: "storage";
      serverId: string;
      input: {
        expectedRevision: number;
        retainedVersions: number;
        buildCacheGiB: number;
        requestId: string;
      };
    };

const endpoint = (projectId: string) =>
  `/autoops/projects/${encodeURIComponent(projectId)}/deployments/servers`;

export function loadDeploymentServers(
  projectId: string,
  environmentId: string,
  signal?: AbortSignal,
) {
  return autoOpsRequest<DeploymentServerManagement>(
    `${endpoint(projectId)}?${new URLSearchParams({ environmentId })}`,
    {
      label: "部署节点",
      ...(signal ? { signal } : {}),
    },
  );
}

export function mutateDeploymentServer(
  projectId: string,
  mutation: DeploymentServerMutation,
  signal?: AbortSignal,
) {
  if (mutation.kind === "assign" || mutation.kind === "registration") throw new Error("节点分配和接入必须在平台节点中操作");
  const suffix =
    mutation.kind === "create"
      ? ""
      : `/${encodeURIComponent(mutation.serverId)}${mutation.kind === "delete" ? "" : `/${mutation.kind === "storage" ? "storage-policy" : mutation.kind}`}`;
  return autoOpsRequest<DeploymentServerRegistration | { server: DeploymentServer } | { ok: true }>(
    `${endpoint(projectId)}${suffix}`,
    {
      label: "部署节点",
      body: mutation.input,
      method: mutation.kind === "delete" ? "DELETE" : mutation.kind === "storage" ? "PUT" : "POST",
      ...(signal ? { signal } : {}),
    },
  );
}

export function loadGlobalDeploymentNodes(signal?: AbortSignal) {
  return autoOpsRequest<DeploymentGlobalNodeCatalog>("/autoops/deployment-servers", {
    label: "平台节点", ...(signal ? { signal } : {}),
  });
}

export function mutateGlobalDeploymentNode(mutation: DeploymentServerMutation, signal?: AbortSignal) {
  if (mutation.kind === "bind" || mutation.kind === "unbind")
    throw new Error("环境绑定必须在项目中操作");
  const suffix = mutation.kind === "create" ? "" :
    `/${encodeURIComponent(mutation.serverId)}${mutation.kind === "access" ? `/projects/${encodeURIComponent(mutation.projectId)}` : mutation.kind === "delete" ? "" : `/${mutation.kind === "storage" ? "storage-policy" : mutation.kind === "assign" ? "assignments" : mutation.kind}`}`;
  return autoOpsRequest<DeploymentServerRegistration | DeploymentServer | DeploymentNodeAssignment | { ok: true } | { saved: true; available: false }>(
    `/autoops/deployment-servers${suffix}`, {
      label: "平台节点", body: mutation.input,
      method: mutation.kind === "delete" ? "DELETE" : mutation.kind === "storage" ? "PUT" : "POST",
      ...(signal ? { signal } : {}),
    },
  );
}


export function loadGlobalDeploymentNodeReceipt(requestId: string, signal?: AbortSignal) {
  return autoOpsRequest<DeploymentNodeReceipt | null>(
    `/autoops/deployment-servers/receipts/${encodeURIComponent(requestId)}`,
    { label: "平台节点原收据", allowNull: true, ...(signal ? { signal } : {}) },
  );
}

export function loadDeploymentNodeReceipt(projectId: string, environmentId: string, requestId: string, signal?: AbortSignal) {
  return autoOpsRequest<DeploymentNodeReceipt | null>(
    `${endpoint(projectId)}/receipts/${encodeURIComponent(requestId)}?${new URLSearchParams({ environmentId })}`,
    { label: "部署节点原收据", allowNull: true, ...(signal ? { signal } : {}) },
  );
}

export function matchesDeploymentNodeReceipt(
  operation: DeploymentServerMutation,
  receipt: DeploymentNodeReceipt,
  scope: { projectId?: string | undefined; environmentId?: string | undefined },
) {
  if (receipt.state !== "completed" || receipt.requestId !== operation.input.requestId ||
    receipt.operation !== operation.kind || receipt.projectId !== (scope.projectId ?? null) ||
    receipt.environmentId !== (scope.environmentId ?? null) ||
    (operation.kind !== "create" && receipt.serverId !== operation.serverId) ||
    ((operation.kind === "bind" || operation.kind === "unbind") && operation.input.environmentId !== scope.environmentId) ||
    (operation.kind === "access" && receipt.targetProjectId !== operation.projectId) ||
    (operation.kind === "assign" && receipt.targetProjectId !== operation.input.projectId)) return false;
  const expected: Record<string, unknown> = operation.kind === "create" ? { name: operation.input.name }
    : operation.kind === "assign" ? { serverId: operation.serverId, projectId: operation.input.projectId, environmentIds: operation.input.environmentIds, expectedRevision: operation.input.expectedRevision }
    : operation.kind === "access" ? { projectId: operation.projectId, serverId: operation.serverId, allowed: operation.input.allowed, expectedRevision: operation.input.expectedRevision }
    : operation.kind === "storage" ? { serverId: operation.serverId, expectedRevision: operation.input.expectedRevision, retainedVersions: operation.input.retainedVersions, buildCacheGiB: operation.input.buildCacheGiB }
    : operation.kind === "bind" || operation.kind === "unbind" ? { serverId: operation.serverId, environmentId: operation.input.environmentId }
    : { serverId: operation.serverId };
  const actual = receipt.publicIntent;
  // 原标识只能证明有过请求；原参数也须一致，不能把本地冲突意图确认成成功。
  return !!actual && typeof actual === "object" && !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && JSON.stringify(actual[key as keyof typeof actual]) === JSON.stringify(value));
}
