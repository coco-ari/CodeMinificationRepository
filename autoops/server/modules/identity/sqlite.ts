import type { DatabaseSync } from 'node:sqlite'
import * as C from '../../../contracts/index.ts'
import { decode } from '../../platform/errors.ts'
import type { Migration } from '../../platform/database.ts'
import type { IdentityRepository, StoredAccount, Session } from './domain.ts'

export const migration: Migration = {
  version: 1,
  name: 'identity',
  sql: `
CREATE TABLE identity_accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('internal','external')),
platform_admin INTEGER NOT NULL CHECK(platform_admin IN(0,1)), enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
password_hash TEXT NOT NULL, CHECK(kind='internal' OR platform_admin=0)) STRICT;
CREATE TABLE identity_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES identity_accounts(id),
csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE INDEX identity_session_user ON identity_sessions(user_id);
CREATE INDEX identity_session_expiry ON identity_sessions(expires_at);
`,
}
export function repository(db: DatabaseSync): IdentityRepository {
  const account = (
    row: ReturnType<ReturnType<DatabaseSync['prepare']>['get']>,
  ): StoredAccount | undefined =>
    row
      ? {
          user: decode(C.User, {
            id: row.id,
            username: row.username,
            name: row.name,
            kind: row.kind,
            platformAdmin: row.platform_admin === 1,
            enabled: row.enabled === 1,
          }),
          passwordHash: String(row.password_hash),
        }
      : undefined
  return {
    count: () => Number(db.prepare('SELECT count(*) AS n FROM identity_accounts').get()?.n),
    list: (after, limit) =>
      db
        .prepare('SELECT * FROM identity_accounts WHERE id>? ORDER BY id LIMIT ?')
        .all(after, limit)
        .map((row) => account(row)!.user),
    byId: (id) => account(db.prepare('SELECT * FROM identity_accounts WHERE id=?').get(id)),
    byUsername: (username) =>
      account(db.prepare('SELECT * FROM identity_accounts WHERE username=?').get(username)),
    insert: ({ user, passwordHash }) => {
      db.prepare('INSERT INTO identity_accounts VALUES (?,?,?,?,?,?,?)').run(
        user.id,
        user.username,
        user.name,
        user.kind,
        Number(user.platformAdmin),
        Number(user.enabled),
        passwordHash,
      )
    },
    setEnabled: (id, enabled) => {
      db.prepare('UPDATE identity_accounts SET enabled=? WHERE id=?').run(Number(enabled), id)
    },
    enabledAdmins: () =>
      Number(
        db
          .prepare(
            'SELECT count(*) AS n FROM identity_accounts WHERE enabled=1 AND platform_admin=1',
          )
          .get()?.n,
      ),
    setPassword: (id, value) => {
      db.prepare('UPDATE identity_accounts SET password_hash=? WHERE id=?').run(value, id)
    },
    saveSession: (hash, s) => {
      db.prepare('INSERT INTO identity_sessions VALUES (?,?,?,?)').run(
        hash,
        s.userId,
        s.csrfHash,
        s.expiresAt,
      )
    },
    session(hash): Session | undefined {
      const row = db.prepare('SELECT * FROM identity_sessions WHERE token_hash=?').get(hash)
      return row
        ? {
            userId: String(row.user_id),
            csrfHash: String(row.csrf_hash),
            expiresAt: Number(row.expires_at),
          }
        : undefined
    },
    deleteSession: (hash) => {
      db.prepare('DELETE FROM identity_sessions WHERE token_hash=?').run(hash)
    },
    revokeSessions: (id) => {
      db.prepare('DELETE FROM identity_sessions WHERE user_id=?').run(id)
    },
    deleteExpiredSessions: (now) => {
      db.prepare('DELETE FROM identity_sessions WHERE expires_at<=?').run(now)
    },
  }
}
