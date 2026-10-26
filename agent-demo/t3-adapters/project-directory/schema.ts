import type { Migration } from '../../../autoops/server/platform/database.ts'

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: '项目环境与成员目录',
    sql: `
    CREATE TABLE directory_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>=1), created_by TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE directory_environments (
      project_id TEXT NOT NULL REFERENCES directory_projects(id), id TEXT NOT NULL,
      name TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), PRIMARY KEY(project_id,id)
    ) STRICT;
    CREATE TABLE directory_members (
      project_id TEXT NOT NULL REFERENCES directory_projects(id), user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('project_admin','developer','release_operator','reader','external')),
      can_adjust_chat INTEGER NOT NULL CHECK(can_adjust_chat IN (0,1)), pending INTEGER NOT NULL CHECK(pending IN (0,1)), status TEXT NOT NULL CHECK(status IN ('active','disabled')),
      revision INTEGER NOT NULL CHECK(revision>=1), PRIMARY KEY(project_id,user_id)
    ) STRICT;
    CREATE TABLE directory_member_environments (
      project_id TEXT NOT NULL, user_id TEXT NOT NULL, environment_id TEXT NOT NULL,
      role TEXT CHECK(role IS NULL OR role IN ('developer','release_operator','reader')),
      PRIMARY KEY(project_id,user_id,environment_id),
      FOREIGN KEY(project_id,user_id) REFERENCES directory_members(project_id,user_id),
      FOREIGN KEY(project_id,environment_id) REFERENCES directory_environments(project_id,id)
    ) STRICT;
    CREATE TABLE directory_receipts (
      request_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, project_id TEXT NOT NULL,
      operation TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE directory_audit (
      id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, project_id TEXT NOT NULL,
      operation TEXT NOT NULL, subject_id TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE directory_seed (id INTEGER PRIMARY KEY CHECK(id=1)) STRICT;
  `,
  },
]
