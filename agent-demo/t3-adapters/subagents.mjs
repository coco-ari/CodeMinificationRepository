import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { configuredAutoOpsAccess, initializeAutoOpsAccessSchema } from './access.mjs'

export function createNativeSubagentBindings(dataDirectory, access) {
  const db = new DatabaseSync(join(dataDirectory, 't3-autoops.sqlite'))
  initializeAutoOpsAccessSchema(db)
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS t3_native_subagent_bindings (
      child_thread_id TEXT PRIMARY KEY, parent_thread_id TEXT NOT NULL,
      native_thread_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    );`)
  return {
    register(parentThreadId, childThreadId, nativeThreadId, parentRunId) {
      // 只接受原生提供商事件中的父任务身份，浏览器不能指定继承关系。
      const { binding } = access.requireToolThread(parentThreadId)
      for (const id of [parentThreadId, childThreadId, nativeThreadId])
        if (typeof id !== 'string' || !id || id.length > 512 || /[\u0000-\u001f]/u.test(id))
          throw new Error('原生子任务身份无效')
      if (parentThreadId === childThreadId) throw new Error('原生子任务不能以自身为父会话')
      const inherited = parentRunId ? access.getRunInput(parentThreadId, parentRunId) : undefined
      if (parentRunId && !inherited) throw new Error('父任务资料输入尚未固定')
      db.exec('BEGIN IMMEDIATE')
      try {
        const previous = db.prepare('SELECT * FROM t3_native_subagent_bindings WHERE child_thread_id=? OR native_thread_id=?').get(childThreadId,nativeThreadId)
        if (previous && (previous.child_thread_id !== childThreadId || previous.parent_thread_id !== parentThreadId || previous.native_thread_id !== nativeThreadId)) throw new Error('原生子任务身份已有其他来源')
        const existing = access.getThreadBinding(childThreadId)
        if (existing && !previous) throw new Error('原生子任务不能占用现有会话身份')
        if (!previous) {
          const at = new Date().toISOString()
          db.prepare('INSERT INTO t3_thread_bindings(thread_id,project_id,environment_id,agent_id,owner_id,visibility,created_at,compatibility_read_only,continuation_verified,native_thread_id,workspace_type,workspace_version_id) VALUES(?,?,?,?,?,?,?,0,1,?,?,?)').run(childThreadId,binding.projectId,binding.environmentId,binding.agentId,binding.ownerId,binding.visibility,at,nativeThreadId,binding.workspaceType??null,binding.workspaceVersionId??null)
          db.prepare('INSERT INTO t3_native_subagent_bindings VALUES(?,?,?,?)').run(childThreadId,parentThreadId,nativeThreadId,at)
        }
        if (inherited) db.prepare('INSERT INTO t3_thread_inputs VALUES(?,?,?,?) ON CONFLICT(thread_id,run_id) DO NOTHING').run(childThreadId, parentRunId, inherited.inputId, inherited.createdAt)
        for (const reference of access.inputReferences(parentThreadId)) db.prepare('INSERT INTO t3_thread_input_references VALUES(?,?,?,?) ON CONFLICT(thread_id,input_id) DO NOTHING').run(childThreadId, reference.inputId, reference.actorId, new Date().toISOString())
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      return access.getThreadBinding(childThreadId)
    },
    close() { db.close() },
  }
}

let configured
export function registerNativeSubagent(parentThreadId, childThreadId, nativeThreadId, parentRunId) {
  const access = configuredAutoOpsAccess()
  if (!access || !process.env.AUTOOPS_T3_DATA_DIR) return
  configured ||= createNativeSubagentBindings(process.env.AUTOOPS_T3_DATA_DIR, access)
  return configured.register(parentThreadId,childThreadId,nativeThreadId,parentRunId)
}
