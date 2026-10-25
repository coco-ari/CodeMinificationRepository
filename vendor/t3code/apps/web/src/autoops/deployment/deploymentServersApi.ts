import { autoOpsRequest } from "../apiClient";
import type {
  DeploymentServer,
  DeploymentServerManagement,
  DeploymentServerRegistration,
} from "../../../../../../../autoops/contracts/deployments";

export type { DeploymentServer, DeploymentServerManagement, DeploymentServerRegistration };

export type DeploymentServerMutation =
  | { kind: "create"; input: { name: string; environmentId: string; requestId: string } }
  | {
      kind: "bind" | "unbind" | "revoke";
      serverId: string;
      input: { environmentId: string; requestId: string };
    }
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
