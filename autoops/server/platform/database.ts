import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { Transaction } from './ports.ts'

export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}
export function openDatabase(filename: string, migrations: readonly Migration[]) {
  const db = new DatabaseSync(filename)
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
    if (tables.length && !tables.some((row) => row.name === 'schema_migrations'))
      throw new Error('数据目录不是新 AutoOps 数据库，拒绝自动迁移')
    db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;',
    )
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;',
      )
      const applied = db
        .prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version')
        .all()
      for (const row of applied) {
        const expected = migrations.find((m) => m.version === row.version)
        if (!expected || row.name !== expected.name || row.checksum !== checksum(expected.sql))
          throw new Error('数据库升级版本未知或已应用升级被修改')
      }
      if (migrations.some((m, i) => m.version !== i + 1)) throw new Error('数据库升级必须连续有序')
      if (applied.some((m, i) => m.version !== i + 1)) throw new Error('数据库升级记录不连续')
      for (const migration of migrations.slice(applied.length)) {
        db.exec(migration.sql)
        db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(
          migration.version,
          migration.name,
          checksum(migration.sql),
        )
      }
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据库外键检查失败')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    let depth = 0
    const transaction: Transaction = {
      run(operation) {
        const name = `autoops_${depth}`,
          nested = depth > 0
        db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE')
        depth++
        try {
          const result = operation()
          if (result && typeof result === 'object' && 'then' in result)
            throw new Error('同步事务内不允许异步操作')
          db.exec(nested ? `RELEASE ${name}` : 'COMMIT')
          return result
        } catch (error) {
          db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK')
          throw error
        } finally {
          depth--
        }
      },
    }
    return { db, transaction, close: () => db.close() }
  } catch (error) {
    db.close()
    throw error
  }
}
const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex')
