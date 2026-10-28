import { openDatabase } from '../../../autoops/server/platform/database.ts'

export const workspaceUpdateMigrations = [
  {
    version: 1,
    name: '工作区定期更新配置与原请求',
    sql: `
CREATE TABLE workspace_update_plans (
 project_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('internal','external')),
 revision INTEGER NOT NULL CHECK(revision>0), actor_id TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), interval_minutes INTEGER NOT NULL CHECK(interval_minutes BETWEEN 5 AND 43200),
 timezone TEXT NOT NULL, source_ids TEXT NOT NULL, updated_at TEXT NOT NULL,
 next_run_at INTEGER, paused_code TEXT, PRIMARY KEY(project_id,scope)
) STRICT;
CREATE TABLE workspace_update_runs (
 project_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('internal','external')),
 request_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('manual','scheduled')),
 fingerprint TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
 accepted_at TEXT NOT NULL, finished_at TEXT,
 outcome TEXT CHECK(outcome IN ('completed','pending_review','failed','rejected')),
 error_code TEXT, task_id TEXT, PRIMARY KEY(project_id,request_id)
) STRICT;
CREATE UNIQUE INDEX workspace_update_active_scope ON workspace_update_runs(project_id,scope) WHERE finished_at IS NULL;
CREATE INDEX workspace_update_due ON workspace_update_plans(enabled,next_run_at);
CREATE TABLE workspace_update_receipts (
 project_id TEXT NOT NULL, request_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 scope TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
 PRIMARY KEY(project_id,request_id)
) STRICT;
CREATE TABLE workspace_update_audit (
 id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, scope TEXT NOT NULL,
 actor_id TEXT NOT NULL, request_id TEXT NOT NULL, revision INTEGER NOT NULL,
 enabled INTEGER NOT NULL, created_at TEXT NOT NULL
) STRICT;
`,
  },
  {
    version: 2,
    name: '外部资料更新复用已保存脱敏规则',
    sql: `ALTER TABLE workspace_update_plans ADD COLUMN rules_json TEXT NOT NULL DEFAULT '[]';`,
  },
] as const

export const openWorkspaceUpdateDatabase = (filename: string) =>
  openDatabase(filename, workspaceUpdateMigrations)
