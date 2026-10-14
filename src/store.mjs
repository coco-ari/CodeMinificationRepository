import { mkdir, readFile, writeFile, rename, stat, chmod, copyFile, open } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export async function atomicWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}

export class Store {
  constructor(directory) { this.directory = directory; this.pending = Promise.resolve(); }
  async open() {
    if (this.state) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.file = path.join(this.directory, 'state.json');
    this.databaseFile = path.join(this.directory, 'state.sqlite');
    let databaseExists = false;
    try { await stat(this.databaseFile); databaseExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const keyFile = path.join(this.directory, 'master.key');
    try { this.key = await readFile(keyFile); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (databaseExists) throw new Error('已有数据库缺失 master.key，请从备份恢复');
      // 已有配置缺失密钥时停止启动，避免覆盖后让旧凭证永久不可恢复。
      try { await readFile(this.file); throw new Error('已有数据缺失 master.key，请从备份恢复'); }
      catch (existing) { if (existing.code !== 'ENOENT') throw existing; }
      this.key = randomBytes(32);
      await writeFile(keyFile, this.key, { flag: 'wx', mode: 0o600 });
    }
    if (this.key.length !== 32) throw new Error('master.key 格式错误');
    if (!databaseExists) {
      let initial, legacy = false;
      try { initial = JSON.parse(await readFile(this.file, 'utf8')); legacy = true; }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        initial = { version: 1, admin: null, credentials: [], projects: [], events: [] };
        // 保留首次快照以兼容旧运维工具；后续写入只使用 SQLite。
        await atomicWrite(this.file, JSON.stringify(initial));
      }
      this.validate(initial);
      if (legacy) {
        // 备份失败必须终止迁移，不能把备份过程中的 ENOENT 当成新安装。
        const backup = path.join(this.directory, `migration-backup-${Date.now()}-${randomUUID()}`);
        await mkdir(backup, { mode: 0o700 });
        await copyFile(this.file, path.join(backup, 'state.json'));
        await copyFile(keyFile, path.join(backup, 'master.key'));
        await chmod(path.join(backup, 'master.key'), 0o600);
      }
      const temporary = `${this.databaseFile}.${randomUUID()}.tmp`;
      const db = new DatabaseSync(temporary);
      try {
        db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE application_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); PRAGMA user_version=1;');
        db.prepare('INSERT INTO application_state (id,value) VALUES (1,?)').run(JSON.stringify(initial));
        db.exec('COMMIT');
      } finally { db.close(); }
      await chmod(temporary, 0o600);
      await rename(temporary, this.databaseFile);
    }
    const db = new DatabaseSync(this.databaseFile, { readOnly: true });
    try {
      if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('不支持的数据库版本');
      this.state = JSON.parse(db.prepare('SELECT value FROM application_state WHERE id=1').get().value);
      this.validate(this.state);
    } finally { db.close(); }
  }
  validate(state) {
    if (state?.version !== 1 || !Array.isArray(state.projects) || !Array.isArray(state.credentials) || !Array.isArray(state.events)) throw new Error('不支持或损坏的数据版本');
  }
  async change(mutator) {
    const operation = this.pending.then(async () => {
      // 单实例串行事务，短连接避免 Windows 备份、关闭及测试清理时留下文件句柄。
      const db = new DatabaseSync(this.databaseFile);
      try {
        db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
        const next = JSON.parse(db.prepare('SELECT value FROM application_state WHERE id=1').get().value);
        const result = await mutator(next);
        this.validate(next);
        db.prepare('UPDATE application_state SET value=? WHERE id=1').run(JSON.stringify(next));
        db.exec('COMMIT');
        this.state = next;
        return result;
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      finally { db.close(); }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async close() { await this.pending; }
}
