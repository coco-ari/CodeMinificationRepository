import { filterBusinessProviderResult } from "../../../../../../agent-demo/t3-adapters/scoped-skills.mjs";
import { resourceRequest } from "./resources.ts";
import { prepareBusinessMessagePayload } from "./messageContext.ts";
import { withCommandPrincipal } from "./RequestScope.ts";
import * as Personal from "./personalPreferences.ts";
import { AuthOrchestrationReadScope, EnvironmentAuthorizationError, authScopeRequiredResponse, type OrchestrationV2Command, type ChatAttachment, type AttachmentCreateUploadUrlInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { configuredAutoOpsAccess } from "../../../../../../agent-demo/t3-adapters/access.mjs";
import { PRODUCT_CAPABILITY_DISABLED, PRODUCT_CAPABILITY_MESSAGE } from "../../../../../../agent-demo/t3-adapters/product-profile.mjs";
import { authorizeAutoOpsRpc, filterAutoOpsShell, filterAutoOpsShellItem, prepareAutoOpsRpcPayload } from "../../../../../../agent-demo/t3-adapters/rpc-policy.mjs";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { projectCustomerProviderResult } from '../../../../../../agent-demo/t3-adapters/customer-target.mjs';

/** A fork may reserve a new binding, never claim an unmigrated native thread. */
export const reserveForkBinding = Effect.fn("AutoOps.reserveForkBinding")(function* (
  command: OrchestrationV2Command, sessionId: string, threads: ThreadManagement.ThreadManagementService["Service"],
) {
  const access = configuredAutoOpsAccess();
  if (!access || command.type !== "thread.fork") return;
  const principal = access.principalForNativeSession(sessionId);
  if (!access.getThreadBinding(command.targetThreadId)) {
    const existing = yield* threads.getThreadShell(command.targetThreadId);
    if (existing !== null) return yield* Effect.die(new Error("The fork target requires authorized migration."));
  }
  yield* Effect.sync(() => access.forkBinding(principal, command.sourceThreadId, command.targetThreadId));
});

export const authorize = (sessionId: string, method: string, payload: unknown) => Effect.try({
  try: () => {
    const access = configuredAutoOpsAccess();
    if (access) authorizeAutoOpsRpc(access, access.principalForNativeSession(sessionId), method, prepareBusinessMessagePayload(access, method, payload));
  },
  catch: (cause) => new EnvironmentAuthorizationError({
    ...authScopeRequiredResponse(AuthOrchestrationReadScope),
    message: typeof cause === "object" && cause !== null && "code" in cause && cause.code === PRODUCT_CAPABILITY_DISABLED
      ? PRODUCT_CAPABILITY_MESSAGE
      : typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" && (cause.code.startsWith("SKILL_") || cause.code.startsWith("CUSTOMER_")) && "message" in cause
        ? String(cause.message)
        : "AutoOps access denied or session expired.",
  }),
});

export const visibleThreadIds = (sessionId: string) => {
  const access = configuredAutoOpsAccess();
  return access?.visibleThreadIds(access.principalForNativeSession(sessionId));
};

/** Recheck every emitted result. Sequence markers retain the native global watermark. */
function projectResult(sessionId: string, method: string, payload: unknown, result: unknown): unknown {
  const access = configuredAutoOpsAccess();
  if (!access) return result;
  const principal = access.principalForNativeSession(sessionId);
  authorizeAutoOpsRpc(access, principal, method, payload);
  if (['server.getConfig','subscribeServerConfig','server.refreshProviders'].includes(method)) {
    return filterBusinessProviderResult(process.env.AUTOOPS_T3_DATA_DIR!,projectCustomerProviderResult(access,principal,result),{access,principal});
  }
  if (method === "orchestration.dispatchCommand" && (payload as {type: string}).type === "thread.delete")
    access.markThreadDeleted((payload as {threadId: string}).threadId);
  if (method === "orchestration.subscribeShell" || method === "orchestration.subscribeArchivedShell")
    return filterAutoOpsShellItem(access, principal, result);
  if (method === "orchestration.getArchivedShellSnapshot") return filterAutoOpsShell(access, principal, result);
  if (method === "projects.list") return Array.isArray(result)
    ? filterAutoOpsShell(access, principal, {projects:result}).projects
    : filterAutoOpsShell(access, principal, result);
  if (method === "orchestration.searchThreads") {
    const value = result as { matches: {threadId: string}[] };
    return {...value, matches: value.matches.filter((match) => access.canSeeThread(principal, match.threadId))};
  }
  if (method === "attachments.createUploadUrl") {
    access.recordPendingAttachment(principal, (result as {attachmentId: string}).attachmentId, payload as AttachmentCreateUploadUrlInput);
  }
  if (method === "assets.persistChatAttachments") {
    for (const attachment of (result as {attachments: ChatAttachment[]}).attachments)
      access.recordThreadAttachment(principal, attachment.id, (payload as {threadId: string}).threadId, attachment);
  }
  return result;
}

/** Native handlers and streams remain unchanged; only their authorization projection is adapted. */
export function protectHandlers<T extends object>(handlers: T, sessionId: string, personalChanges: (location: "active" | "archive") => Stream.Stream<unknown, unknown>): T {
  if (!configuredAutoOpsAccess()) return handlers;
  const entries = Object.entries(handlers).map(([method, original]) => {
    if (typeof original !== "function") return [method, original];
    return [method, (payload: unknown, ...args: unknown[]) => {
      const access = configuredAutoOpsAccess();
      const nativePayload = access ? prepareBusinessMessagePayload(access, method, prepareAutoOpsRpcPayload(access, access.principalForNativeSession(sessionId), method, payload)) : payload;
      const value = resourceRequest(sessionId,method,payload) ?? original(nativePayload, ...args);
      if (Stream.isStream(value)) return (
        method === "orchestration.subscribeShell" || method === "orchestration.subscribeArchivedShell"
          ? Stream.merge(value, personalChanges(method.includes("Archived") ? "archive" : "active"))
          : value
      ).pipe(
        Stream.map((result) => projectResult(sessionId, method, payload, Personal.overlayPersonalResult(sessionId, method, result))),
        Stream.filter((result) => result !== null),
      );
      // Preserve the heterogeneous native RPC error/context channels in this transparent wrapper.
      if (Effect.isEffect(value)) return (
        method === "assets.createUrl"
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off
          ? withCommandPrincipal(value, sessionId, method, payload)
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off
          : value
      ).pipe(Effect.map((result) => projectResult(sessionId, method, payload, Personal.overlayPersonalResult(sessionId, method, result))));
      return value;
    }];
  });
  // Object keys and native handler input/result schemas are preserved by this wrapper.
  return Object.fromEntries(entries) as T;
}

/** Native session expiry is supplemented with revocation of the host login. */
export const awaitHostSessionInvalidation = (sessionId: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const access = configuredAutoOpsAccess();
    if (!access) return yield* Effect.never;
    while (true) {
      const active = yield* Effect.sync(() => {
        try { access.principalForNativeSession(sessionId); return true; } catch { return false; }
      });
      if (!active) return;
      yield* Effect.sleep("1 second");
    }
  });
