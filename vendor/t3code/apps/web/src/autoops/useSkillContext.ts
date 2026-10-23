import { useEffect, useState } from "react";
import { readAutoOpsHost, readAutoOpsThreadScope, type AutoOpsThreadScope } from "./hostConfig";

interface SkillContext {
  cwd: string;
  snapshotId: string;
  skills: { name: string; displayName?: string; versionId: string }[];
}
/** Remote skills never resolve a platform catalogue, including a draft carrying
 * obsolete platform fields from before the target was changed. */
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
    query.set("environmentId", selection.environmentId);
    if (selection.workspaceType) query.set("workspaceType", selection.workspaceType);
    if (selection.workspaceVersionId) query.set("workspaceVersionId", selection.workspaceVersionId);
  }
  return `${gatewayBasePath}/autoops/skill-library/context?${query}`;
}

/** Resolve the server-authorized scope before asking T3's native skill scanner. */
export function useAutoOpsSkillContext(
  threadId: string | null,
  projectId: string | undefined,
  scope: AutoOpsThreadScope | undefined,
) {
  const host = readAutoOpsHost();
  const selection =
    scope ?? (threadId && projectId ? readAutoOpsThreadScope(threadId, projectId) : undefined);
  const requestKey = autoOpsSkillContextRequestKey(host?.gatewayBasePath, threadId, selection);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    revision: number;
    context: SkillContext | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    window.addEventListener("autoops:skill-library-changed", changed);
    window.addEventListener("focus", changed);
    return () => {
      window.removeEventListener("autoops:skill-library-changed", changed);
      window.removeEventListener("focus", changed);
    };
  }, []);
  useEffect(() => {
    if (!requestKey) return;
    const controller = new AbortController();
    void fetch(requestKey, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "无法读取当前技能范围");
        if (!controller.signal.aborted)
          setResult({ key: requestKey, revision, context: body as SkillContext, error: null });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setResult({
            key: requestKey,
            revision,
            context: null,
            error: cause instanceof Error ? cause.message : "无法读取当前技能范围",
          });
      });
    return () => controller.abort();
  }, [requestKey, revision]);
  // Never reuse the previous scope's catalogue while a new scope is loading.
  return result?.key === requestKey && result.revision === revision ? result : null;
}
