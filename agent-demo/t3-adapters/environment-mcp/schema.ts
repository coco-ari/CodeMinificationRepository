import type { Migration } from '../../../autoops/server/platform/database.ts'

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: '环境只读连接及轮次固定输入',
    sql: `
    CREATE TABLE mcp_connections (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      removed INTEGER NOT NULL CHECK(removed IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX mcp_connections_environment ON mcp_connections(project_id,environment_id);
    CREATE TABLE mcp_connection_versions (
      connection_id TEXT NOT NULL REFERENCES mcp_connections(id), revision INTEGER NOT NULL CHECK(revision>=1),
      configuration TEXT NOT NULL, configuration_hash TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(connection_id,revision)
    ) STRICT;
    CREATE TABLE mcp_connection_tests (
      connection_id TEXT PRIMARY KEY REFERENCES mcp_connections(id), configuration_hash TEXT NOT NULL,
      credential_version TEXT, result TEXT NOT NULL
    ) STRICT;
    CREATE TABLE mcp_receipts (
      project_id TEXT NOT NULL, environment_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
      result TEXT, error TEXT, PRIMARY KEY(project_id,environment_id,actor_id,request_id)
    ) STRICT;
    CREATE TABLE mcp_runs (
      thread_id TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT,
      actor_id TEXT NOT NULL, captured_at TEXT NOT NULL, connections TEXT NOT NULL, unavailable TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','released')),
      inherited_run_id TEXT,
      PRIMARY KEY(thread_id,run_id)
    ) STRICT;
    CREATE TABLE mcp_audit (
      id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, request_id TEXT NOT NULL, operation TEXT NOT NULL,
      connection_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
  `,
  },
]
