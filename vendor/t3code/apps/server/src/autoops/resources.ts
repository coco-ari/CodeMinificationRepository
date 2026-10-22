import * as Effect from "effect/Effect";
import { AuthOrchestrationReadScope, EnvironmentAuthorizationError, authScopeRequiredResponse } from "@t3tools/contracts";
import { configuredAutoOpsAccess } from "../../../../../../agent-demo/t3-adapters/access.mjs";
import { configuredBusinessResourceCatalog } from "../../../../../../agent-demo/t3-adapters/resources.mjs";

const denied = () => new EnvironmentAuthorizationError({ ...authScopeRequiredResponse(AuthOrchestrationReadScope), message: "业务资料不存在、已改变或无权访问。" });
/** Return undefined outside AutoOps; never fall through to a host filesystem. */
export function resourceRequest(sessionId: string, method: string, input: unknown) {
  const catalog = configuredBusinessResourceCatalog();
  if (!catalog || !["projects.searchEntries", "projects.listEntries", "projects.readFile", "filesystem.getMetadata"].includes(method)) return undefined;
  return Effect.tryPromise({
    try: async () => {
      const access = configuredAutoOpsAccess()!;
      const principal = access.principalForNativeSession(sessionId);
      if (method === "projects.searchEntries") return catalog.search(principal, input as Parameters<typeof catalog.search>[1]);
      if (method === "projects.listEntries") return catalog.list(principal, input as Parameters<typeof catalog.list>[1]);
      if (method === "projects.readFile") return catalog.read(principal, input as Parameters<typeof catalog.read>[1]);
      return catalog.metadata(principal, (input as {paths: string[]}).paths);
    },
    catch: denied,
  });
}

export const authorizeMessageContext = (threadId: string, context: unknown) =>
  Effect.try({ try: () => configuredBusinessResourceCatalog()?.requireContext(threadId, context as Parameters<NonNullable<ReturnType<typeof configuredBusinessResourceCatalog>>["requireContext"]>[1]), catch: denied });
