export const migration = {
  version: 1,
  name: '实际运行账号与原请求',
  sql: `
    CREATE TABLE runtime_accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('internal','external')),
      platform_admin INTEGER NOT NULL CHECK(platform_admin IN (0,1)),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      revision INTEGER NOT NULL CHECK(revision>0), password_hash TEXT NOT NULL,
      CHECK(kind='internal' OR platform_admin=0)
    ) STRICT;
    CREATE TABLE runtime_account_requests (
      actor_id TEXT NOT NULL REFERENCES runtime_accounts(id), request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, operation TEXT NOT NULL, target_id TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL,
      password_proof TEXT NOT NULL, current_password_proof TEXT NOT NULL,
      PRIMARY KEY(actor_id,request_id)
    ) STRICT;
    CREATE TABLE runtime_account_audit (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES runtime_accounts(id),
      operation TEXT NOT NULL, target_id TEXT NOT NULL REFERENCES runtime_accounts(id),
      request_id TEXT, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE runtime_account_metadata (
      id INTEGER PRIMARY KEY CHECK(id=1), initialized INTEGER NOT NULL CHECK(initialized IN (0,1)),
      legacy_installation INTEGER NOT NULL CHECK(legacy_installation IN (0,1))
    ) STRICT;
  `,
}
