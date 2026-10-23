import type { DatabaseSync } from 'node:sqlite'
import type { Migration } from '../../platform/database.ts'
import * as C from '../../../contracts/index.ts'
import { decode } from '../../platform/errors.ts'
import type { ProjectRepository } from './domain.ts'
export const migration: Migration = {
  version: 2,
  name: 'projects',
  sql: `
CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,
created_by TEXT NOT NULL REFERENCES identity_accounts(id),created_at INTEGER NOT NULL) STRICT;
CREATE TABLE project_members (project_id TEXT NOT NULL REFERENCES projects(id),user_id TEXT NOT NULL REFERENCES identity_accounts(id),PRIMARY KEY(project_id,user_id)) STRICT;
CREATE INDEX project_member_user ON project_members(user_id,project_id);
CREATE TABLE project_environments (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,
created_at INTEGER NOT NULL,UNIQUE(project_id,name),UNIQUE(project_id,id)) STRICT;
CREATE TABLE project_commands (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, operation TEXT NOT NULL,
payload TEXT NOT NULL, result TEXT NOT NULL) STRICT;
`,
}
export function repository(db: DatabaseSync): ProjectRepository {
  const fromProject = (r: Record<string, unknown>) =>
    decode(C.Project, {
      id: r.id,
      name: r.name,
      description: r.description,
      createdBy: r.created_by,
      createdAt: r.created_at,
    })
  const fromEnvironment = (r: Record<string, unknown>) =>
    decode(C.Environment, {
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      createdAt: r.created_at,
    })
  return {
    exists: (id) => !!db.prepare('SELECT 1 FROM projects WHERE id=?').get(id),
    creator: (id) => {
      const r = db.prepare('SELECT created_by FROM projects WHERE id=?').get(id)
      return r ? String(r.created_by) : undefined
    },
    member: (projectId, userId) =>
      !!db
        .prepare('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?')
        .get(projectId, userId),
    environmentProject: (id) => {
      const r = db.prepare('SELECT project_id FROM project_environments WHERE id=?').get(id)
      return r ? String(r.project_id) : undefined
    },
    insert: (p) => {
      db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(
        p.id,
        p.name,
        p.description,
        p.createdBy,
        p.createdAt,
      )
    },
    get: (id) => {
      const row = db.prepare('SELECT * FROM projects WHERE id=?').get(id)
      return row ? fromProject(row) : undefined
    },
    candidates: (userId, admin, after, limit) =>
      db
        .prepare(
          'SELECT p.* FROM projects p WHERE p.id>? AND (?=1 OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=?)) ORDER BY p.id LIMIT ?',
        )
        .all(after, Number(admin), userId, limit)
        .map(fromProject),
    addMember: (projectId, userId) => {
      db.prepare('INSERT INTO project_members VALUES(?,?) ON CONFLICT DO NOTHING').run(
        projectId,
        userId,
      )
    },
    removeMember: (projectId, userId) => {
      db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(
        projectId,
        userId,
      )
    },
    members: (projectId, after, limit) =>
      db
        .prepare(
          'SELECT user_id FROM project_members WHERE project_id=? AND user_id>? ORDER BY user_id LIMIT ?',
        )
        .all(projectId, after, limit)
        .map((r) => String(r.user_id)),
    addEnvironment: (e) => {
      db.prepare('INSERT INTO project_environments VALUES(?,?,?,?)').run(
        e.id,
        e.projectId,
        e.name,
        e.createdAt,
      )
    },
    environments: (projectId, scope, after, limit) =>
      scope !== 'all' && scope.length === 0
        ? []
        : db
            .prepare(
              `SELECT * FROM project_environments WHERE project_id=? AND id>? ${scope === 'all' ? '' : `AND id IN (${scope.map(() => '?').join(',')})`} ORDER BY id LIMIT ?`,
            )
            .all(projectId, after, ...(scope === 'all' ? [] : scope), limit)
            .map(fromEnvironment),
    receipt: (key) => {
      const r = db.prepare('SELECT * FROM project_commands WHERE id=?').get(key)
      return r
        ? {
            actorId: String(r.actor_id),
            operation: String(r.operation),
            payload: String(r.payload),
            result: JSON.parse(String(r.result)) as unknown,
          }
        : undefined
    },
    saveReceipt: (key, actorId, operation, payload, result) => {
      db.prepare('INSERT INTO project_commands VALUES(?,?,?,?,?)').run(
        key,
        actorId,
        operation,
        payload,
        JSON.stringify(result),
      )
    },
  }
}
