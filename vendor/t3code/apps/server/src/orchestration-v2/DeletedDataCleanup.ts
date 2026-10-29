import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as Schema from 'effect/Schema'

export class DeletedThreadDataHooks extends Context.Reference<{
  cleanup: (threadId: string) => Effect.Effect<void, DeletedDataCleanupError>
}>('t3/DeletedThreadDataHooks', { defaultValue: () => ({ cleanup: () => Effect.void }) }) {}

export class DeletedDataCleanupError extends Schema.TaggedError<DeletedDataCleanupError>()(
  'DeletedDataCleanupError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// 只由原生 owner 清理自身记录；业务组合根不访问这些表。
const threadTables = [
  'orchestration_v2_projection_context_handoffs',
  'orchestration_v2_projection_checkpoints',
  'orchestration_v2_projection_checkpoint_scopes',
  'orchestration_v2_projection_turn_items',
  'orchestration_v2_projection_plans',
  'orchestration_v2_projection_messages',
  'orchestration_v2_projection_runtime_requests',
  'orchestration_v2_projection_provider_turns',
  'orchestration_v2_projection_provider_threads',
  'orchestration_v2_projection_subagents',
  'orchestration_v2_projection_nodes',
  'orchestration_v2_projection_run_attempts',
  'orchestration_v2_projection_runs',
  'orchestration_v2_turn_item_positions',
  'orchestration_v2_thread_launch_workflows',
  'orchestration_v2_legacy_imports',
  'orchestration_v2_events',
  'orchestration_v2_command_receipts',
  'projection_thread_messages',
  'projection_thread_activities',
  'projection_thread_sessions',
  'projection_thread_proposed_plans',
  'projection_thread_pull_requests',
  'projection_turns',
  'projection_pending_approvals',
  'provider_session_runtime',
  'checkpoint_diff_blobs',
  'mcp_app_model_context',
  'projection_threads',
  'orchestration_v2_projection_threads',
] as const

/** 先完成原生停止/附件等清理，再清除正文和事件；失败保持可重试，不能宣布完成。 */
export const purgeDeletedData = Effect.fn('DeletedDataCleanup.purge')(
  function* (scope: {
    projectId?: string
    threadIds?: readonly string[]
    cleanupEffectId?: string
    beforePurge?: () => Effect.Effect<void, DeletedDataCleanupError>
  }) {
    const sql = yield* SqlClient.SqlClient
    const rows =
      scope.projectId !== undefined
        ? yield* sql<{
            thread_id: string
            deleted_at: string | null
          }>`SELECT thread_id,deleted_at FROM orchestration_v2_projection_threads WHERE project_id=${scope.projectId}`
        : scope.threadIds?.length
          ? yield* sql<{
              thread_id: string
              deleted_at: string | null
            }>`SELECT thread_id,deleted_at FROM orchestration_v2_projection_threads WHERE thread_id IN ${sql.in(scope.threadIds)}`
          : []
    if (rows.some((row) => row.deleted_at === null))
      return yield* new DeletedDataCleanupError({ message: '会话尚未停止，关联清理未完成' })
    const ids = rows.map((row) => row.thread_id)
    if (ids.length) {
      // 显式继续删除才重新排队失败的清理；不自动重发业务执行。
      if (scope.cleanupEffectId === undefined) yield* sql`UPDATE orchestration_v2_effect_outbox SET status='pending',attempt_count=0,available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),lease_owner=NULL,lease_expires_at=NULL WHERE thread_id IN ${sql.in(ids)} AND status='failed' AND (effect_type LIKE '%.cleanup' OR effect_type='provider-session.detach')`
      // 工作器与当前请求共享持久队列；不跳过尚未结束的执行或清理。
      for (let attempt = 0; ; attempt++) {
        const pending = yield* sql<{
          status: string
          last_error: string | null
        }>`SELECT status,last_error FROM orchestration_v2_effect_outbox WHERE thread_id IN ${sql.in(ids)} AND effect_id <> ${scope.cleanupEffectId ?? ''} AND (status IN ('pending','running') OR (status='failed' AND (effect_type LIKE '%.cleanup' OR effect_type='provider-session.detach' OR effect_type='provider-turn.interrupt')))`
        if (!pending.length) break
        if (pending.some((row) => row.status === 'failed'))
          return yield* new DeletedDataCleanupError({
            message: `会话清理失败：${pending.find((row) => row.status === 'failed')?.last_error ?? '请重试删除'}`,
          })
        if (attempt >= 30)
          return yield* new DeletedDataCleanupError({
            message: '会话仍在结束或清理中，请稍后继续原删除',
          })
        yield* Effect.sleep('500 millis')
      }
    }
    if (scope.beforePurge) yield* scope.beforePurge()
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (ids.length) {
          yield* sql`DELETE FROM orchestration_v2_projection_context_transfers WHERE source_thread_id IN ${sql.in(ids)} OR target_thread_id IN ${sql.in(ids)}`
          // 共享 provider 会话只删除本次引用，仍有其他引用的会话保留。
          const sessions = yield* sql<{
            provider_session_id: string
          }>`SELECT provider_session_id FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id IN ${sql.in(ids)} UNION SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions WHERE thread_id IN ${sql.in(ids)}`
          yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id IN ${sql.in(ids)}`
          if (sessions.length)
            yield* sql`DELETE FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id IN ${sql.in(sessions.map((row) => row.provider_session_id))} AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_session_bindings b WHERE b.provider_session_id=orchestration_v2_projection_provider_sessions.provider_session_id)`
          const installed = new Set(
            (yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`).map(
              (row) => row.name,
            ),
          )
          for (const table of threadTables)
            if (installed.has(table))
              yield* sql`DELETE FROM ${sql(table)} WHERE thread_id IN ${sql.in(ids)}`
          yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE thread_id IN ${sql.in(ids)} AND effect_id <> ${scope.cleanupEffectId ?? ''}`
          yield* sql`DELETE FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id IN ${sql.in(ids)}`
          yield* sql`DELETE FROM orchestration_command_receipts WHERE aggregate_kind='thread' AND aggregate_id IN ${sql.in(ids)}`
        }
        if (scope.projectId !== undefined) {
          const live =
            yield* sql`SELECT 1 FROM projection_projects WHERE project_id=${scope.projectId} AND deleted_at IS NULL`
          if (live.length)
            return yield* new DeletedDataCleanupError({ message: '原生项目尚未删除' })
          yield* sql`DELETE FROM projection_projects WHERE project_id=${scope.projectId}`
          yield* sql`DELETE FROM orchestration_events WHERE aggregate_kind='project' AND stream_id=${scope.projectId}`
          yield* sql`DELETE FROM orchestration_command_receipts WHERE aggregate_kind='project' AND aggregate_id=${scope.projectId}`
        }
        yield* sql`UPDATE orchestration_v2_projection_metadata SET last_sequence=MIN(last_sequence,(SELECT COALESCE(MAX(sequence),0) FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread')) WHERE projection_name='thread-projections'`
      }),
    )
  },
  Effect.mapError((cause) =>
    Schema.is(DeletedDataCleanupError)(cause)
      ? cause
      : new DeletedDataCleanupError({ message: '原生关联数据清理失败', cause }),
  ),
)
