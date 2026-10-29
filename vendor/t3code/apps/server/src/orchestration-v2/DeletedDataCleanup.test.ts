import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlitePersistence from '../persistence/Sqlite.ts'
import { purgeDeletedData,DeletedDataCleanupError } from './DeletedDataCleanup.ts'

it.layer(SqlitePersistence.layerMemory)('删除会话的物理清理', (it) => {
  const seed = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM orchestration_v2_projection_threads`
    yield* sql`DELETE FROM mcp_app_model_context`
    for (const id of ['removed', 'other']) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,deleted_at,payload_json) VALUES(${id},${id},'正文','codex','codex','full-access','default','2026-01-01','2026-01-01',${id === 'removed' ? '2026-01-02' : null},'{}')`
      yield* sql`INSERT INTO mcp_app_model_context VALUES(${id},'item','server','tool','待删除内容','2026-01-01')`
    }
  })
  it.effect('删除指定会话的正文和关联记录，其他会话保留；重复清理可恢复', () =>
    Effect.gen(function* () {
      yield* seed
      yield* purgeDeletedData({ threadIds: ['removed'] })
      yield* purgeDeletedData({ threadIds: ['removed'] })
      const sql = yield* SqlClient.SqlClient
      assert.deepEqual(
        (yield* sql<{
          thread_id: string
        }>`SELECT thread_id FROM orchestration_v2_projection_threads`).map((row) => row.thread_id),
        ['other'],
      )
      assert.deepEqual(
        (yield* sql<{ thread_id: string }>`SELECT thread_id FROM mcp_app_model_context`).map(
          (row) => row.thread_id,
        ),
        ['other'],
      )
    }),
  )
  it.effect('所属业务清理失败时保留原生正文，恢复后同范围清理成功',()=>Effect.gen(function*(){
    yield* seed
    const failure=yield* purgeDeletedData({threadIds:['removed'],beforePurge:()=>Effect.fail(new DeletedDataCleanupError({message:'隔离清理故障'}))}).pipe(Effect.flip)
    assert.equal(failure.message,'隔离清理故障')
    const sql=yield* SqlClient.SqlClient
    assert.equal((yield* sql`SELECT 1 FROM mcp_app_model_context WHERE thread_id='removed'`).length,1)
    yield* purgeDeletedData({threadIds:['removed'],beforePurge:()=>Effect.void})
    assert.equal((yield* sql`SELECT 1 FROM mcp_app_model_context WHERE thread_id='removed'`).length,0)
  }))
  it.effect('活动会话不能绕过停止流程直接清除', () =>
    Effect.gen(function* () {
      yield* seed
      const error = yield* purgeDeletedData({ threadIds: ['other'] }).pipe(Effect.flip)
      assert.match(error.message, /尚未停止/)
      const sql = yield* SqlClient.SqlClient
      assert.equal((yield* sql`SELECT * FROM mcp_app_model_context`).length, 2)
    }),
  )
})
