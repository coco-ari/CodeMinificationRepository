import { autoOpsRequest } from "../apiClient";
import type {
  DeploymentServer,
  DeploymentServerManagement,
  DeploymentServerRegistration,
  DeploymentGlobalNodeCatalog,
} from "../../../../../../../autoops/contracts/deployments";

export type { DeploymentServer, DeploymentServerManagement, DeploymentServerRegistration, DeploymentGlobalNodeCatalog };

export type DeploymentServerMutation =
  | { kind: "create"; input: { name: string; requestId: string } }
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
    `/${encodeURIComponent(mutation.serverId)}${mutation.kind === "access" ? `/projects/${encodeURIComponent(mutation.projectId)}` : mutation.kind === "delete" ? "" : `/${mutation.kind === "storage" ? "storage-policy" : "revoke"}`}`;
  return autoOpsRequest<DeploymentServerRegistration | { ok: true } | { saved: true; available: false }>(
    `/autoops/deployment-servers${suffix}`, {
      label: "平台节点", body: mutation.input,
      method: mutation.kind === "delete" ? "DELETE" : mutation.kind === "storage" ? "PUT" : "POST",
      ...(signal ? { signal } : {}),
    },
  );
}
