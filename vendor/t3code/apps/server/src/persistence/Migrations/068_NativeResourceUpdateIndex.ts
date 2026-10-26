import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // 终态重放按确切实体取最新来源，不能反复扫描整段会话历史。
  yield* sql`CREATE INDEX idx_orchestration_events_resource_entity_sequence
    ON orchestration_events(stream_id,event_type,json_extract(payload_json,'$.id'),sequence DESC)
    WHERE application_event_version=2 AND aggregate_kind='thread'
      AND event_type IN ('run.updated','subagent.updated','provider-turn.updated')`;
});
