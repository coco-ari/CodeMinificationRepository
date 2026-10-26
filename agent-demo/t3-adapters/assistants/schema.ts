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
  {
    version: 2,
    name: '提供者助手共享与分配修订',
    sql: `
    ALTER TABLE assistant_presets ADD COLUMN provider_id TEXT;
    CREATE INDEX assistant_provider_presets ON assistant_presets(provider_id);
    CREATE TABLE assistant_provider_shares (
      assistant_id TEXT NOT NULL REFERENCES assistant_presets(id), project_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL CHECK(revision>=1),
      source_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(assistant_id,project_id)
    ) STRICT;
    CREATE INDEX assistant_share_projects ON assistant_provider_shares(project_id,enabled);
    CREATE TABLE assistant_allocation_sources (
      project_id TEXT NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind IN ('member','role')),
      target_id TEXT NOT NULL, assistant_id TEXT NOT NULL REFERENCES assistant_presets(id),
      allocation_revision INTEGER NOT NULL CHECK(allocation_revision>=1),
      preset_revision INTEGER NOT NULL CHECK(preset_revision>=1), share_revision INTEGER,
      source_json TEXT NOT NULL,
      PRIMARY KEY(project_id,target_kind,target_id,assistant_id,allocation_revision)
    ) STRICT;
    `,
  },
  {
    version: 3,
    name: '共享运行范围签发事实',
    sql: `
    CREATE TABLE assistant_execution_grants (
      grant_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, value_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(thread_id,run_id)
    ) STRICT;
    `,
  },
]
