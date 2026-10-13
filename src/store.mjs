import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export async function atomicWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, file);
}

export class Store {
  constructor(directory) { this.directory = directory; this.pending = Promise.resolve(); }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.file = path.join(this.directory, 'state.json');
    const keyFile = path.join(this.directory, 'master.key');
    try { this.key = await readFile(keyFile); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // 已有配置缺失密钥时停止启动，避免覆盖后让旧凭证永久不可恢复。
      try { await readFile(this.file); throw new Error('已有数据缺失 master.key，请从备份恢复'); }
      catch (existing) { if (existing.code !== 'ENOENT') throw existing; }
      this.key = randomBytes(32);
      await writeFile(keyFile, this.key, { flag: 'wx', mode: 0o600 });
    }
    if (this.key.length !== 32) throw new Error('master.key 格式错误');
    try { this.state = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { version: 1, admin: null, credentials: [], projects: [], events: [] };
      await atomicWrite(this.file, JSON.stringify(this.state));
    }
    if (this.state.version !== 1) throw new Error('不支持的数据版本');
  }
  async change(mutator) {
    const operation = this.pending.then(async () => {
      const next = structuredClone(this.state);
      const result = await mutator(next);
      await atomicWrite(this.file, JSON.stringify(next, null, 2));
      this.state = next;
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
