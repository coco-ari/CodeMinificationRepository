import { resolveProductProfile } from "../../../../../../agent-demo/t3-adapters/product-profile.mjs";
import { forPrincipal } from "./personalSettings.ts";
/** AutoOps personal organization; native messages/runs/queues remain authoritative. */
import { CommandId, type OrchestrationV2Command, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { configuredAutoOpsAccess } from "../../../../../../agent-demo/t3-adapters/access.mjs";
import { configuredPreferences, isPersonalPreferenceCommand } from "../../../../../../agent-demo/t3-adapters/preferences.mjs";
import { filterAutoOpsShell } from "../../../../../../agent-demo/t3-adapters/rpc-policy.mjs";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Settings from "../serverSettings.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { resolveAutoSettlementAt } from "../orchestration-v2/ThreadSettlementService.ts";

const preferences = () => configuredPreferences((value) => DateTime.makeUnsafe(value));
const principalFor = (sessionId:string) => configuredAutoOpsAccess()?.principalForNativeSession(sessionId);

export const interceptPersonalCommand = Effect.fn("AutoOps.interceptPersonalCommand")(function* (
  command: OrchestrationV2Command, sessionId: string,
) {
  const access = configuredAutoOpsAccess();
  const store = preferences();
  if (!access || !store || !isPersonalPreferenceCommand(command) || !("threadId" in command)) return undefined;
  const principal = access.principalForNativeSession(sessionId);
  access.requireThread(principal, command.threadId);
  const threads = yield* Threads.ThreadManagementService;
  const events = yield* Events.OrchestrationEventStore;
  const shell = yield* threads.getThreadShell(command.threadId);
  // The shell status names only the latest run. Read authoritative queued runs
  // for the same native guards used by T3's settle/snooze mutations.
  let hasQueuedUserRun = false;
  if (shell && (command.type === "thread.snooze" || command.type === "thread.settle")) {
    const records = yield* threads.getThreadRecords(command.threadId, ["runs", "messages"]);
    const automatic = new Set(records.messages.filter((message) => message.notification !== undefined || message.delegatedCompletion !== undefined).map((message) => message.id));
    hasQueuedUserRun = records.runs.some((run) => run.status === "queued" && !automatic.has(run.userMessageId));
  }
  const nativeSequence = yield* events.latestApplicationSequence;
  const result = yield* Effect.try({
    try: () => store.applyCommand(principal.id, command, {thread:shell ? {...shell,hasQueuedUserRun} : null,nativeSequence}),
    catch: (cause) => new OrchestratorDispatchError({commandId:command.commandId,commandType:command.type,cause}),
  });
  return result.handled ? {sequence:result.sequence} : undefined;
});

/** Apply after ACL projection. It changes only the explicitly personal fields. */
export function overlayPersonalResult<T>(sessionId:string, method:string, result:T):T {
  const principal = principalFor(sessionId); const store = preferences();
  if (!principal || !store || !result || typeof result !== "object") return result;
  const value = result as Record<string, unknown>;
  const location = method.includes("Archived") ? "archive" : "active";
  if (Array.isArray(value.threads)) return store.overlayShell(principal.id, result, {location});
  if (value.snapshot && typeof value.snapshot === "object" && "threads" in value.snapshot)
    return {...value,snapshot:store.overlayShell(principal.id,value.snapshot,{location})} as T;
  if (value.kind === "thread.updated" && value.thread) {
    const thread = store.overlayThread(principal.id, value.thread as OrchestrationV2ThreadShell);
    if (location === "archive") return (thread.archivedAt === null
      ? {kind:"thread.removed",sequence:value.sequence,threadId:thread.id}
      : {...value,thread}) as T;
    return {...value,thread,location:thread.archivedAt === null ? "active" : "archive"} as T;
  }
  if (value.projection) return {...value,projection:store.overlayProjection(principal.id,value.projection)} as T;
  if (value.thread && Array.isArray(value.runs)) return store.overlayProjection(principal.id,result);
  // Native domain events carry a full app thread in thread.* payloads.
  if (value.kind === "event" && value.event && typeof value.event === "object") {
    const event = value.event as {type?:string;payload?:unknown};
    if (event.type?.startsWith("thread.") && event.payload && typeof event.payload === "object" && "id" in event.payload && "archivedAt" in event.payload)
      return {...value,event:{...event,payload:store.overlayThread(principal.id,event.payload as {id:string})}} as T;
  }
  return result;
}

/** Private actor changes and native time-based criteria share the existing shell protocol.
 * Snapshot watermarks are from the native snapshot itself, never an invented sequence.
 * A one-item sliding callback coalesces rapid drag/reorder updates without losing state.
 */
export function personalShellChanges(sessionId:string, location:"active"|"archive" = "active") {
  const changes = Stream.callback<void>((queue) => Effect.acquireRelease(
    Effect.sync(() => {
      const principal = principalFor(sessionId); const store = preferences();
      const remove = principal && store ? store.subscribe(principal.id, () => Queue.offerUnsafe(queue, undefined)) : () => {};
      return remove;
    }),
    (remove) => Effect.sync(remove),
  ), {bufferSize:1,strategy:"sliding"});
  return Stream.merge(changes, Stream.tick("30 seconds")).pipe(Stream.mapEffect(() => Effect.gen(function* () {
    const access = configuredAutoOpsAccess(); const store = preferences();
    const principal = principalFor(sessionId);
    if (!access || !store || !principal) return null;
    const threads = yield* Threads.ThreadManagementService;
    const projects = yield* Projects.ProjectStoreV2;
    const settings = yield* Settings.ServerSettingsService;
    const native = yield* threads.getShellSnapshot();
    const currentSettings = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    // Use full native shells, then per-user state and upstream settlement criteria.
    for (const original of [...native.threads,...native.archivedThreads]) {
      if (!access.canSeeThread(principal, original.id)) continue;
      if (!resolveProductProfile().capabilities.advancedOrganization) continue;
      const thread = store.overlayThread(principal.id, original);
      const policy = resolveProjectSettings(forPrincipal(principal.id,currentSettings), thread.projectId).settings;
      const settledAt = resolveAutoSettlementAt({
        thread:{...thread,lastSnoozeWakeAt:(thread as typeof thread & {lastSnoozeWakeAt?:DateTime.Utc}).lastSnoozeWakeAt ?? null,latestUserAuthoredMessageAt:thread.latestUserAuthoredMessageAt ?? null},
        pullRequest:null,nowMs,autoSettleAfterDays:policy.sidebarAutoSettleAfterDays,
        autoSettleOnMerge:policy.sidebarAutoSettleOnMerge,autoSettleKeepPullRequests:policy.sidebarAutoSettleKeepPullRequests,
      });
      if (!settledAt) continue;
      const latest = yield* threads.getThreadShell(thread.id);
      yield* Effect.try({
        try: () => store.applyCommand(principal.id, {
          type:"thread.auto-settle",commandId:CommandId.make(`autoops:auto-settle:${thread.id}:${store.revision(principal.id)}:${DateTime.toEpochMillis(settledAt)}`),
          threadId:thread.id,snapshotAt:thread.updatedAt,settledAt,
        },{thread:latest,nativeSequence:native.snapshotSequence}),
        catch:(cause) => new OrchestratorDispatchError({commandId:CommandId.make(`autoops:auto-settle:${thread.id}`),commandType:"thread.auto-settle",cause}),
      }).pipe(Effect.catch(() => Effect.void)); // A raced user action always wins.
    }
    const snapshot = filterAutoOpsShell(access, principal, store.overlayShell(principal.id, {...native,projects:yield* projects.listShells()}, {location}));
    return {kind:"snapshot" as const,snapshot};
  })), Stream.filter((item) => item !== null));
}
