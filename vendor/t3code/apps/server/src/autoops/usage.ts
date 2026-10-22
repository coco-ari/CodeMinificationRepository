import { UsageReadError, type UsageSummaryInput } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { configuredAutoOpsAccess } from "../../../../../../agent-demo/t3-adapters/access.mjs";
import type * as UsageService from "../usage/UsageService.ts";

interface NativeUsageRow {
  readonly thread_id: string;
  readonly payload_json: string;
  readonly native_thread_id: string | null;
  readonly model: string | null;
}
const encodeThreadIds=Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export function authorizedUsageRecords(rows: readonly NativeUsageRow[]) {
  const records: UsageRecord[] = [];
  let incompleteRecords = 0;
  for (const row of rows) {
    const turn = JSON.parse(row.payload_json) as {
      id:string;completedAt?:string|null;startedAt?:string|null;
      nativeTurnRef?:{nativeId?:string}|null;
      turnTokenUsage?:{usageStatus:string;inputTokens?:number;outputTokens?:number;cachedInputTokens?:number;cacheCreationTokens?:number;reasoningTokens?:number};
    };
    const usage = turn.turnTokenUsage;
    if (!usage || usage.usageStatus !== "complete") incompleteRecords++;
    const timestampMs = Date.parse(turn.completedAt ?? turn.startedAt ?? "");
    if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined) || !Number.isFinite(timestampMs)) continue;
    const count=(n:number|undefined)=>typeof n === "number" && Number.isFinite(n) && n>0 ? Math.trunc(n) : 0;
    const input=count(usage.inputTokens), cached=count(usage.cachedInputTokens), creation=count(usage.cacheCreationTokens);
    records.push({provider:"codex",timestampMs,model:row.model ?? "unknown",sessionId:row.native_thread_id ?? row.thread_id,
      totals:{uncachedInputTokens:Math.max(0,input-cached-creation),cachedInputTokens:cached,cacheCreationTokens:creation,outputTokens:count(usage.outputTokens),reasoningTokens:count(usage.reasoningTokens)},
      reportedCostUsd:null,speed:"standard",dedupeKey:`codex:${row.native_thread_id ?? row.thread_id}:${turn.nativeTurnRef?.nativeId ?? turn.id}`});
  }
  return {records,incompleteRecords};
}

export function selectAuthorizedUsageRows(sql:SqlClient.SqlClient,allowedThreadIds:readonly string[]) {
  return sql<NativeUsageRow>`
      SELECT turn.thread_id,turn.payload_json,
        json_extract(provider.payload_json,'$.nativeThreadRef.nativeId') AS native_thread_id,
        json_extract(run.payload_json,'$.modelSelection.model') AS model
      FROM orchestration_v2_projection_provider_turns AS turn
      LEFT JOIN orchestration_v2_projection_provider_threads AS provider
        ON provider.thread_id=turn.thread_id AND provider.provider_thread_id=turn.provider_thread_id
      LEFT JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.thread_id=turn.thread_id AND attempt.attempt_id=turn.run_attempt_id
      LEFT JOIN orchestration_v2_projection_runs AS run
        ON run.thread_id=turn.thread_id AND run.run_id=attempt.run_id
      WHERE turn.thread_id IN (SELECT value FROM json_each(${encodeThreadIds(allowedThreadIds)}))
        AND json_extract(turn.payload_json,'$.nativeTurnRef.driver')='codex'
    `.pipe(NodeSqliteClient.readOnly);
}

export function readAutoOpsUsageSummary(sessionId:string,input:UsageSummaryInput,usage:UsageService.UsageService["Service"],sql:SqlClient.SqlClient) {
  const access=configuredAutoOpsAccess();
  if (!access) return undefined;
  return Effect.gen(function*(){
    const principal=access.principalForNativeSession(sessionId);
    const allowed=access.visibleThreadIds(principal);
    const rows=yield* selectAuthorizedUsageRows(sql,allowed);
    const result=yield* usage.readSummary(input,{identity:principal.id,...authorizedUsageRecords(rows)});
    // Revoke before emitting even if a concurrent membership change happened
    // while the original aggregator was producing the summary.
    for(const id of allowed)access.requireThread(principal,id);
    return result;
  }).pipe(Effect.mapError(cause=>new UsageReadError({reason:"scanFailed",detail:"Authorized native usage could not be read.",cause})));
}
