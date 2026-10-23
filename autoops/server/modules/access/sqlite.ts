import type { DatabaseSync } from 'node:sqlite'
import type { Migration } from '../../platform/database.ts'
import * as C from '../../../contracts/index.ts'
import { decode } from '../../platform/errors.ts'
import type { GrantRepository } from './domain.ts'
export const migration: Migration = {
  version: 3,
  name: 'access',
  sql: `
CREATE TABLE access_grants (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
role TEXT NOT NULL CHECK(role IN ('project_admin','developer','release_operator','reader','external')),
environment_id TEXT, CHECK(role!='project_admin' OR environment_id IS NULL),
FOREIGN KEY(project_id,user_id) REFERENCES project_members(project_id,user_id),
FOREIGN KEY(project_id,environment_id) REFERENCES project_environments(project_id,id)) STRICT;
CREATE UNIQUE INDEX access_grant_unique ON access_grants(project_id,user_id,role,coalesce(environment_id,''));
CREATE INDEX access_grant_user ON access_grants(user_id,project_id);
`,
}
export function repository(db: DatabaseSync): GrantRepository {
  const fromRow = (r: Record<string, unknown>) =>
    decode(C.Grant, {
      id: r.id,
      projectId: r.project_id,
      userId: r.user_id,
      role: r.role,
      environmentId: r.environment_id,
    })
  return {
    page: (projectId, after, limit) =>
      db
        .prepare('SELECT * FROM access_grants WHERE project_id=? AND id>? ORDER BY id LIMIT ?')
        .all(projectId, after, limit)
        .map(fromRow),
    list: (projectId, userId) =>
      db
        .prepare(
          `SELECT * FROM access_grants WHERE project_id=?${userId ? ' AND user_id=?' : ''} ORDER BY id`,
        )
        .all(...(userId ? [projectId, userId] : [projectId]))
        .map(fromRow),
    get: (id) => {
      const row = db.prepare('SELECT * FROM access_grants WHERE id=?').get(id)
      return row ? fromRow(row) : undefined
    },
    insert: (g) => {
      db.prepare('INSERT INTO access_grants VALUES(?,?,?,?,?)').run(
        g.id,
        g.projectId,
        g.userId,
        g.role,
        g.environmentId,
      )
    },
    remove: (id) => {
      db.prepare('DELETE FROM access_grants WHERE id=?').run(id)
    },
    removeMember: (projectId, userId) => {
      db.prepare('DELETE FROM access_grants WHERE project_id=? AND user_id=?').run(
        projectId,
        userId,
      )
    },
  }
}
