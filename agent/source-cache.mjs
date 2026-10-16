import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, chmod, lstat, open, readdir, rename, rm, utimes } from 'node:fs/promises';
import path from 'node:path';

// 缓存只保存中心已校验的 ZIP，不共享构建目录；单个 Agent 串行使用并限制总占用。
export class SourceCache {
  constructor(directory, { maxEntries = 4, maxBytes = 128 * 1024 * 1024 } = {}) {
    this.directory = path.resolve(directory); this.maxEntries = maxEntries; this.maxBytes = maxBytes;
  }
  file(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('源码缓存标识无效');
    return path.join(this.directory, `${key}.zip`);
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('源码缓存目录无效');
    await chmod(this.directory, 0o700);
  }
  async has(key) {
    await this.initialize();
    const info = await lstat(this.file(key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return !!info?.isFile() && !info.isSymbolicLink();
  }
  async copyVerified(from, destination, source, maxBytes) {
    const input = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let output, created = false, size = 0;
    try {
      const info = await input.stat();
      if (!info.isFile() || info.size > maxBytes) throw new Error('源码缓存文件大小无效');
      output = await open(destination, 'wx', 0o600); created = true;
      const hash = createHash('sha256');
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > maxBytes) throw new Error('源码缓存文件过大');
        hash.update(chunk); await output.writeFile(chunk);
      }
      if (hash.digest('hex') !== source.sha256 || (source.size != null && size !== source.size)) throw new Error('源码缓存校验失败');
      await output.sync();
      return size;
    } catch (error) {
      await output?.close(); output = null;
      if (created) await rm(destination, { force: true });
      throw error;
    } finally { await input.close(); await output?.close(); }
  }
  async restore(key, destination, source, maxBytes) {
    try {
      const size = await this.copyVerified(this.file(key), destination, source, maxBytes);
      const now = new Date(); await utimes(this.file(key), now, now).catch(() => {});
      return size;
    } catch (error) {
      // 损坏缓存退回下载同一个固定源码包，不能替换成其他提交。
      if (error.code === 'EEXIST') throw error;
      await rm(this.file(key), { force: true });
      return null;
    }
  }
  async store(key, sourceFile, source) {
    await this.initialize();
    await this.prune();
    const info = await lstat(sourceFile);
    if (info.size > this.maxBytes || this.maxEntries < 1) return;
    await rm(this.file(key), { force: true });
    await this.prune(info.size, 1);
    const temporary = path.join(this.directory, `${key}.${randomUUID()}.part`);
    try {
      await this.copyVerified(sourceFile, temporary, source, this.maxBytes);
      await rename(temporary, this.file(key));
    } finally { await rm(temporary, { force: true }); }
    await this.prune();
  }
  async prune(reservedBytes = 0, reservedEntries = 0) {
    const files = [];
    for (const name of await readdir(this.directory)) {
      const file = path.join(this.directory, name);
      if (/^[a-f0-9]{64}\.[a-f0-9-]{36}\.part$/.test(name)) { await rm(file, { force: true }); continue; }
      if (!/^[a-f0-9]{64}\.zip$/.test(name)) continue;
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) { await rm(file, { force: true }); continue; }
      files.push({ file, size: info.size, used: info.mtimeMs });
    }
    files.sort((a, b) => b.used - a.used);
    let total = reservedBytes;
    for (let index = 0; index < files.length; index++) {
      const file = files[index]; total += file.size;
      if (index + reservedEntries >= this.maxEntries || total > this.maxBytes) await rm(file.file, { force: true });
    }
  }
}
