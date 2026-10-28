import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useEnvironmentQuery } from "~/state/query";
import { isAutoOpsAccessError } from "./apiClient";
import { readAutoOpsHost, readAutoOpsThreadScope, type AutoOpsThreadScope } from "./hostConfig";

import { loadSkillContext, type SkillContext } from "./skillLibrary";

/** 客户端执行目标不读取平台目录，即使草稿仍携带切换前的平台范围。 */
export function autoOpsSkillContextRequestKey(
  gatewayBasePath: string | undefined,
  threadId: string | null,
  selection: AutoOpsThreadScope | undefined,
) {
  if (
    !gatewayBasePath ||
    !selection ||
    !threadId ||
    selection.executionBinding?.kind === "customer"
  )
    return null;
  const query = new URLSearchParams();
  if (selection.scopeLocked || selection.scopeState === "locked") query.set("threadId", threadId);
  else {
    query.set("projectId", selection.projectId);
    query.set("agentId", selection.agentId);
    if (selection.question) query.set("skillIds", JSON.stringify(selection.question.configuration.skillIds));
    if (selection.environmentId !== null) query.set("environmentId", selection.environmentId);
    if (selection.workspaceType) query.set("workspaceType", selection.workspaceType);
    if (selection.workspaceVersionId) query.set("workspaceVersionId", selection.workspaceVersionId);
  }
  return `${gatewayBasePath}/autoops/skill-library/context?${query}`;
}

interface SkillContextResponse {
  readonly context: SkillContext | null;
  readonly error: string | null;
}

class SkillContextReadError extends Data.TaggedError("SkillContextReadError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

interface SkillContextRequest {
  readonly principalId: string;
  readonly csrfToken: string;
  readonly httpBaseUrl: string;
  readonly gatewayBasePath: string;
  readonly threadId: string;
  readonly requestKey: string;
}

const skillContextQueries = Atom.family((key: string) => {
  const request = JSON.parse(key) as SkillContextRequest;
  return Atom.make((get) => {
    const refresh = () => {
      const current = Option.getOrNull(
        get.self<AsyncResult.AsyncResult<SkillContextResponse, SkillContextReadError>>(),
      );
      if (!current?.waiting) get.refreshSelf();
    };
    const changed = () => get.refreshSelf();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("autoops:skill-library-changed", changed);
    get.addFinalizer(() => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("autoops:skill-library-changed", changed);
    });
    return Effect.tryPromise({
      try: async (signal): Promise<SkillContextResponse> => {
        const host = readAutoOpsHost();
        if (
          host?.principal.id !== request.principalId ||
          host.csrfToken !== request.csrfToken ||
          host.httpBaseUrl !== request.httpBaseUrl ||
          host.gatewayBasePath !== request.gatewayBasePath
        ) {
          throw new DOMException("登录上下文已经改变", "AbortError");
        }
        try {
          const context = await loadSkillContext(request.requestKey, signal);
          return { context, error: null };
        } catch (cause) {
          // 撤权成为新的读取基线，之后的网络失败也不能复活此前的skill展示。
          if (isAutoOpsAccessError(cause)) {
            return {
              context: null,
              error: cause instanceof Error ? cause.message : "当前skill访问已失效。",
            };
          }
          throw cause;
        }
      },
      catch: (cause) =>
        new SkillContextReadError({
          message: cause instanceof Error ? cause.message : "无法读取当前skill范围",
          cause,
        }),
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel("autoops:skill-context"));
});

/** 历史展示保留同范围快照；skill发现和新选择仅使用复核完成后的授权目录。 */
export function useAutoOpsSkillContext(
  threadId: string | null,
  projectId: string | undefined,
  scope: AutoOpsThreadScope | undefined,
) {
  const host = readAutoOpsHost();
  const selection =
    scope ?? (threadId && projectId ? readAutoOpsThreadScope(threadId, projectId) : undefined);
  const requestKey = autoOpsSkillContextRequestKey(host?.gatewayBasePath, threadId, selection);
  const query = useEnvironmentQuery(
    host && requestKey && threadId
      ? skillContextQueries(
          JSON.stringify({
            principalId: host.principal.id,
            csrfToken: host.csrfToken,
            httpBaseUrl: host.httpBaseUrl,
            gatewayBasePath: host.gatewayBasePath,
            threadId,
            requestKey,
          } satisfies SkillContextRequest),
        )
      : null,
  );
  if (!requestKey || (!query.data && query.isPending)) return null;
  const error = query.error ?? query.data?.error ?? null;
  const context = query.data?.context ?? null;
  return {
    context,
    authorizedContext: query.isSuccess && !query.isPending && error === null ? context : null,
    error,
    isRefreshing: query.isPending,
    refresh: query.refresh,
  };
}
