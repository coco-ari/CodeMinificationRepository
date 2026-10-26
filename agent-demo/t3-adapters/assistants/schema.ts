import type { Migration } from '../../../autoops/server/platform/database.ts'

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: '助手预设与项目分配',
    sql: `
    CREATE TABLE assistant_presets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, value_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>=1), created_by TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX assistant_projects ON assistant_presets(project_id);
    CREATE TABLE assistant_versions (
      assistant_id TEXT NOT NULL REFERENCES assistant_presets(id), revision INTEGER NOT NULL,
      value_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(assistant_id,revision)
    ) STRICT;
    CREATE TABLE assistant_allocations (
      project_id TEXT NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind IN ('member','role')),
      target_id TEXT NOT NULL, assistant_ids_json TEXT NOT NULL, default_assistant_id TEXT,
      revision INTEGER NOT NULL CHECK(revision>=1), PRIMARY KEY(project_id,target_kind,target_id)
    ) STRICT;
    CREATE TABLE assistant_receipts (
      request_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, project_id TEXT NOT NULL,
      operation TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE assistant_audit (
      id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, project_id TEXT NOT NULL,
      operation TEXT NOT NULL, subject_id TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
  `,
  },
]
