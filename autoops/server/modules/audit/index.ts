import type { DatabaseSync } from 'node:sqlite'
import type { Runtime, AuditWriter, Authorization } from '../../platform/ports.ts'
import type { Migration } from '../../platform/database.ts'
import { decode } from '../../platform/errors.ts'
import { Id } from '../../../contracts/index.ts'

export const migration: Migration = {
  version: 4,
  name: 'audit',
  sql: `
CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
target_id TEXT NOT NULL, project_id TEXT, occurred_at INTEGER NOT NULL) STRICT;
CREATE INDEX audit_project_time ON audit_events(project_id,occurred_at);
`,
}
export function createAudit(db: DatabaseSync, runtime: Runtime, auth: Authorization) {
  const writer: AuditWriter = {
    append(actorId, action, targetId, projectId) {
      db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?)').run(
        runtime.id(),
        actorId,
        action,
        targetId,
        projectId ?? null,
        runtime.now(),
      )
    },
  }
  // 审计写入只接收允许字段，禁止传入整个请求、业务对象或秘密。
  return {
    writer,
    list(userId: string, projectId: string, after = '') {
      auth.require(userId, 'audit.read', { projectId })
      const rows = db
        .prepare('SELECT * FROM audit_events WHERE project_id=? AND id>? ORDER BY id LIMIT 100')
        .all(projectId, after ? decode(Id, after) : '')
      return {
        items: rows.map((r) => ({
          id: String(r.id),
          actorId: String(r.actor_id),
          action: String(r.action),
          targetId: String(r.target_id),
          projectId: String(r.project_id),
          occurredAt: Number(r.occurred_at),
        })),
        nextCursor: rows.length === 100 ? String(rows.at(-1)!.id) : null,
      }
    },
  }
}
