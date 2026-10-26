import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("升级保留历史来源，并按会话和实体索引读取最新终态", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 67 });
    const rows = [
      ["thread-a", "run-a", "original"],
      ["thread-a", "run-other", "other-run"],
      ["thread-other", "run-a", "other-thread"],
      ["thread-a", "run-a", "command:runtime-reconcile:shutdown"],
    ].map(([threadId, runId, commandId], ordinal) => ({
      event_id: `event:${ordinal}`,
      aggregate_kind: "thread",
      stream_id: threadId,
      stream_version: ordinal + 1,
      event_type: "run.updated",
      occurred_at: "2026-10-26T00:00:00.000Z",
      command_id: commandId,
      causation_event_id: null,
      correlation_id: null,
      actor_kind: "server",
      payload_json: encodeJson({ id: runId, status: "cancelled" }),
      metadata_json: "{}",
      application_event_version: 2,
    }));
    yield* sql`INSERT INTO orchestration_events ${sql.insert(rows)}`;
    const before = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
      before,
    );
    const latest = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_events
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        AND event_type IN ('run.updated','subagent.updated','provider-turn.updated')
        AND stream_id = 'thread-a' AND event_type = 'run.updated'
        AND json_extract(payload_json, '$.id') = 'run-a'
      ORDER BY sequence DESC LIMIT 1
    `;
    assert.equal(latest[0]?.command_id, "command:runtime-reconcile:shutdown");
    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN SELECT command_id FROM orchestration_events
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        AND event_type IN ('run.updated','subagent.updated','provider-turn.updated')
        AND stream_id = 'thread-a' AND event_type = 'run.updated'
        AND json_extract(payload_json, '$.id') = 'run-a'
      ORDER BY sequence DESC LIMIT 1
    `;
    assert.isTrue(
      plan.some((row) => row.detail.includes("idx_orchestration_events_resource_entity_sequence")),
    );
    assert.isFalse(plan.some((row) => row.detail.includes("SCAN orchestration_events")));
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
