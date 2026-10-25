import { useEffect, useState } from "react";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import {
  customerFileReference,
  decodeCustomerFileResult,
  type CustomerFileInput,
} from "@t3tools/contracts";
import { autoOpsRequest } from "./apiClient";
import { readAutoOpsHost, type AutoOpsThreadScope } from "./hostConfig";
import { customerTargetKey } from "./customerAgents";

export function customerFilesKey(scope: AutoOpsThreadScope | undefined): string | null {
  const target = scope?.executionBinding;
  return scope && target?.kind === "customer"
    ? `${readAutoOpsHost()?.principal.id}/${scope.projectId}/${scope.environmentId}/${customerTargetKey(target)}`
    : null;
}

export async function readCustomerFiles(
  scope: AutoOpsThreadScope,
  threadId: string | null,
  input: CustomerFileInput,
  signal?: AbortSignal,
) {
  const target = scope.executionBinding;
  if (target?.kind !== "customer") throw new Error("请选择客户工作区");
  const query = new URLSearchParams({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    deviceId: target.deviceId,
    registeredWorkspaceId: target.registeredWorkspaceId,
    workspaceBindingRevision: String(target.workspaceBindingRevision),
    input: JSON.stringify(input),
    ...(threadId ? { threadId } : {}),
  });
  return decodeCustomerFileResult(
    await autoOpsRequest(`/autoops/customer/files?${query}`, {
      label: "电脑文件",
      timeoutMs: 10000,
      ...(signal ? { signal } : {}),
    }),
  );
}

export function useCustomerFileSearch(
  scope: AutoOpsThreadScope | undefined,
  threadId: string | null,
  environmentId: EnvironmentId | null,
  query: string | null,
) {
  const cwd = customerFilesKey(scope);
  const key = cwd && query !== null ? `${cwd}/${threadId}/${query}` : null;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    entries: readonly ProjectEntry[];
    truncated: boolean;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!scope || !key || query === null || scope.executionBinding?.kind !== "customer") return;
    const target = scope.executionBinding;
    const controller = new AbortController();
    const normalized = query.replace(/^\.\//u, "");
    const slash = normalized.lastIndexOf("/");
    const input: CustomerFileInput =
      !normalized || normalized.endsWith("/")
        ? { operation: "list", path: normalized.replace(/\/$/u, "") }
        : {
            operation: "search",
            path: slash < 0 ? "" : normalized.slice(0, slash),
            query: normalized,
          };
    // 输入稳定后才发送；切换范围和下一次输入会取消旧读取。
    const timer = window.setTimeout(() => {
      void readCustomerFiles(scope, threadId, input, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted)
            setState({
              key,
              entries: result.entries.map((entry) => ({
                ...entry,
                path: customerFileReference(target, entry.path),
              })),
              truncated: result.truncated,
              error: null,
            });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setState({
              key,
              entries: [],
              truncated: false,
              error: error instanceof Error ? error.message : "文件读取失败，请重试",
            });
        },
      );
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, attempt]);
  const current = state?.key === key ? state : null;
  return {
    entries: current?.entries ?? [],
    error: current?.error ?? null,
    isPending: key !== null && !current,
    truncated: current?.truncated ?? false,
    searchedTarget: { environmentId, cwd, query },
    searchedQuery: query ?? "",
    refresh: () => setAttempt((value) => value + 1),
  };
}
