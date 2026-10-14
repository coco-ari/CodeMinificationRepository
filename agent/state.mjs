import { mkdir, readFile, rename, writeFile, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { identifier, safeChild } from './config.mjs';

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}
export class TaskJournal {
  constructor(root) { this.root = root; this.chain = Promise.resolve(); }
  file(id) { return safeChild(this.root, 'tasks', `${identifier(id)}.json`); }
  async get(id) { return readJson(this.file(id)); }
  async list() {
    const directory = safeChild(this.root, 'tasks'); await mkdir(directory, { recursive: true, mode: 0o700 });
    return (await Promise.all((await readdir(directory)).filter(n => n.endsWith('.json')).map(n => readJson(path.join(directory, n))))).filter(Boolean);
  }
  transaction(fn) {
    const next = this.chain.then(fn); this.chain = next.catch(() => {}); return next;
  }
  create(task) {
    return this.transaction(async () => {
      const existing = await this.get(task.id); if (existing) return existing;
      const value = { task, stage: 'queued', status: 'running', seq: 0, ackSeq: 0, createdAt: new Date().toISOString() };
      await writeJson(this.file(task.id), value); return value;
    });
  }
  update(id, changes) {
    return this.transaction(async () => { const value = await this.get(id); if (!value) throw new Error('本地任务不存在'); Object.assign(value, changes); await writeJson(this.file(id), value); return value; });
  }
  emit(id, event) {
    return this.transaction(async () => {
      const record = await this.get(id); if (!record) throw new Error('本地任务不存在');
      const value = { ...event, seq: record.seq + 1, timestamp: new Date().toISOString() };
      await writeJson(safeChild(this.root, 'events', id, `${String(value.seq).padStart(10, '0')}.json`), value);
      record.seq = value.seq; if (event.stage) record.stage = event.stage;
      if (event.status) record.status = event.status; if (event.result) record.result = event.result;
      await writeJson(this.file(id), record); return value;
    });
  }
  async *pending(record) {
    // 逐条读取积压日志，避免断网恢复时把全部历史输出装入 Agent 内存。
    for (let seq = record.ackSeq + 1; seq <= record.seq; seq++) yield await readJson(safeChild(this.root, 'events', record.task.id, `${String(seq).padStart(10, '0')}.json`));
  }
  async repair() {
    // 事件先落盘再更新游标；异常退出后把已持久化的最后一条事件纳入补报。
    for (const record of await this.list()) {
      for (;;) {
        const event = await readJson(safeChild(this.root, 'events', record.task.id, `${String(record.seq + 1).padStart(10, '0')}.json`));
        if (!event) break;
        record.seq = event.seq; if (event.stage) record.stage = event.stage; if (event.status) record.status = event.status; if (event.result) record.result = event.result;
      }
      await writeJson(this.file(record.task.id), record);
    }
  }
}
