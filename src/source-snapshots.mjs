import { open, mkdir, readFile, writeFile, rename, copyFile, rm, readdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { HttpError } from './security.mjs';
import { atomicWrite } from './store.mjs';

export const SOURCE_PROTOCOL = 'cmr-source/1';
export const SOURCE_LIMITS = Object.freeze({ maxFiles: 20000, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxBatchFiles: 128, maxBatchBytes: 16 * 1024 * 1024 });
const inflate = promisify(inflateRaw);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const PROJECT = /^[a-f0-9-]{36}$/;
const invalid = message => new HttpError(422, message);

export function sourcePath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || value !== value.normalize('NFC')
      || /[\\\x00-\x1f\x7f:<>"|?*]/.test(value) || value.startsWith('/')
      || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
        || part.toLowerCase() === '.git' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw invalid('源码包含无法安全同步到 Windows/macOS 的文件路径');
  }
  return value;
}

async function readAt(file, position, length) {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) throw invalid('源码包索引无效');
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw invalid('源码包不完整');
  return buffer;
}

// Read the already-exported ZIP: git attributes and the deployment package remain the source of truth.
export async function* exportedFiles(filename, limits = SOURCE_LIMITS) {
  const file = await open(filename, 'r');
  try {
    const size = (await file.stat()).size;
    if (size < 22) throw invalid('源码包格式无效');
    const tail = await readAt(file, Math.max(0, size - 65557), Math.min(size, 65557));
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    }
    if (end < 0 || tail.readUInt32LE(end + 4) !== 0) throw invalid('不支持分卷或损坏的源码包');
    const count = tail.readUInt16LE(end + 10), centralSize = tail.readUInt32LE(end + 12), centralStart = tail.readUInt32LE(end + 16);
    if (count === 65535 || centralStart === 0xffffffff || count > limits.maxFiles || centralSize > 32 * 1024 * 1024
        || centralStart + centralSize > size - tail.length + end) throw invalid('源码包文件数量或索引超出限制');
    const central = await readAt(file, centralStart, centralSize);
    let cursor = 0, total = 0;
    const paths = new Map();
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw invalid('源码包索引损坏');
      const flags = central.readUInt16LE(cursor + 8), method = central.readUInt16LE(cursor + 10);
      const packedSize = central.readUInt32LE(cursor + 20), bytes = central.readUInt32LE(cursor + 24);
      const nameSize = central.readUInt16LE(cursor + 28), extraSize = central.readUInt16LE(cursor + 30), commentSize = central.readUInt16LE(cursor + 32);
      const mode = central.readUInt32LE(cursor + 38) >>> 16, offset = central.readUInt32LE(cursor + 42);
      if (cursor + 46 + nameSize + extraSize + commentSize > central.length || nameSize > 1024) throw invalid('源码包文件名无效');
      const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameSize);
      const name = nameBytes.toString('utf8');
      cursor += 46 + nameSize + extraSize + commentSize;
      if (!Buffer.from(name).equals(nameBytes)) throw invalid('源码包文件名不是有效 UTF-8');
      const directory = name.endsWith('/');
      const relative = sourcePath(directory ? name.slice(0, -1) : name);
      const canonical = relative.toLowerCase();
      if (paths.has(canonical)) throw invalid('源码包含重复或大小写冲突的文件路径');
      paths.set(canonical, directory ? 'directory' : 'file');
      if (directory) continue;
      if ((mode & 0xf000) && (mode & 0xf000) !== 0x8000) throw invalid('源码快照暂不支持符号链接或特殊文件；原 ZIP 下载仍可使用');
      if (flags & 1 || ![0, 8].includes(method) || bytes > limits.maxFileBytes || packedSize > limits.maxFileBytes + 65536) throw invalid('源码文件格式或大小超出限制');
      total += bytes;
      if (total > limits.maxTotalBytes) throw invalid('源码展开大小超出限制');
      const local = await readAt(file, offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== method) throw invalid('源码包文件头无效');
      const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
      if (localNameLength !== nameSize || !(await readAt(file, offset + 30, localNameLength)).equals(nameBytes)) throw invalid('源码包文件头与索引不一致');
      const dataStart = offset + 30 + localNameLength + localExtraLength;
      if (dataStart + packedSize > centralStart) throw invalid('源码包数据越界');
      const packed = await readAt(file, dataStart, packedSize);
      const content = method === 0 ? packed : await inflate(packed, { maxOutputLength: limits.maxFileBytes });
      if (content.length !== bytes) throw invalid('源码包文件大小校验失败');
      yield { path: relative, type: 'file', mode: mode & 0o111 ? 0o755 : 0o644, size: bytes, sha256: hash(content), content };
    }
    if (cursor !== central.length) throw invalid('源码包索引长度不一致');
    for (const name of paths.keys()) {
      const parts = name.split('/');
      while (parts.pop() && parts.length) if (paths.get(parts.join('/')) === 'file') throw invalid('源码包含文件与目录冲突');
    }
  } finally { await file.close(); }
}

export function snapshotSummary(manifest) {
  if (!manifest) return null;
  const { snapshotId, revision, createdAt, fileCount, totalBytes, archiveBytes, archiveSha256 } = manifest;
  return { snapshotId, revision, createdAt, fileCount, totalBytes, archiveBytes, archiveSha256 };
}

export class SourceSnapshots {
  constructor(directory, { limits = SOURCE_LIMITS, retentionMs = 3600000, now = Date.now } = {}) {
    Object.assign(this, { directory, limits, retentionMs, now });
    this.readers = new Map();
    this.deleting = new Set();
  }
  root(projectId) {
    if (!PROJECT.test(projectId)) throw new HttpError(400, '项目标识无效');
    return path.join(this.directory, projectId);
  }
  snapshotDirectory(projectId, snapshotId) {
    if (!HASH.test(snapshotId)) throw new HttpError(404, '源码快照不存在');
    return path.join(this.root(projectId), snapshotId);
  }
  async head(projectId) {
    try { return JSON.parse(await readFile(path.join(this.root(projectId), 'head.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new HttpError(500, '源码快照状态不可用'); }
  }
  async manifest(projectId, snapshotId) {
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(this.snapshotDirectory(projectId, snapshotId), 'manifest.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw new HttpError(410, '源码快照已清理，请刷新可用版本'); throw new HttpError(500, '源码清单不可用'); }
    const { files, revision, exportVersion, sourceIdentity } = manifest;
    if (manifest.protocol !== SOURCE_PROTOCOL || manifest.projectId !== projectId || manifest.snapshotId !== snapshotId
        || !Array.isArray(files) || hash(JSON.stringify({ projectId, revision, exportVersion, sourceIdentity, files })) !== snapshotId) throw new HttpError(500, '源码清单完整性校验失败');
    return manifest;
  }
  async clearHead(projectId) { await rm(path.join(this.root(projectId), 'head.json'), { force: true }); }
  async publish(projectId, archive, sourceIdentity = '') {
    const root = this.root(projectId), objects = path.join(root, 'objects');
    await mkdir(objects, { recursive: true, mode: 0o700 });
    const files = [];
    for await (const entry of exportedFiles(archive.file, this.limits)) {
      const { content, ...metadata } = entry;
      const objectFile = path.join(objects, entry.sha256);
      let reusable = false;
      try { reusable = hash(await readFile(objectFile)) === entry.sha256; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!reusable) {
        const temporary = `${objectFile}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, objectFile); }
        finally { await rm(temporary, { force: true }); }
      }
      files.push(metadata);
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const identity = { projectId, revision: archive.revision, exportVersion: 1, sourceIdentity, files };
    const snapshotId = hash(JSON.stringify(identity));
    const destination = this.snapshotDirectory(projectId, snapshotId);
    let manifest;
    try { manifest = await this.manifest(projectId, snapshotId); }
    catch (error) { if (error.status !== 410) throw error; }
    if (!manifest) {
      const temporary = path.join(root, `${randomUUID()}.tmp`);
      try {
        await mkdir(temporary, { mode: 0o700 });
        await copyFile(archive.file, path.join(temporary, 'source.zip'));
        manifest = { protocol: SOURCE_PROTOCOL, ...identity, sourceIdentity, snapshotId, createdAt: new Date(this.now()).toISOString(), fileCount: files.length,
          totalBytes: files.reduce((total, entry) => total + entry.size, 0), archiveBytes: archive.size, archiveSha256: archive.sha256 };
        await writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
        await rename(temporary, destination);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    await atomicWrite(path.join(root, 'head.json'), JSON.stringify(snapshotSummary(manifest)));
    await this.prune(projectId).catch(() => {});
    return snapshotSummary(manifest);
  }
  async acquire(projectId, snapshotId) {
    const key = `${projectId}/${snapshotId}`;
    if (this.deleting.has(key)) throw new HttpError(410, '源码快照正在清理，请刷新可用版本');
    this.readers.set(key, (this.readers.get(key) || 0) + 1);
    let released = false;
    const release = () => { if (released) return; released = true; const remaining = this.readers.get(key) - 1; if (remaining) this.readers.set(key, remaining); else this.readers.delete(key); };
    try { return { manifest: await this.manifest(projectId, snapshotId), release }; }
    catch (error) { release(); throw error; }
  }
  async batch(projectId, manifest, hashes) {
    if (!Array.isArray(hashes) || hashes.length < 1 || hashes.length > this.limits.maxBatchFiles || hashes.some(value => typeof value !== 'string' || !HASH.test(value)) || new Set(hashes).size !== hashes.length) throw new HttpError(400, '请提供数量受限且不重复的文件哈希');
    const allowed = new Map(manifest.files.map(entry => [entry.sha256, entry]));
    let bytes = 0;
    for (const value of hashes) {
      if (!allowed.has(value)) throw new HttpError(404, '请求的文件不属于此源码快照');
      bytes += allowed.get(value).size;
    }
    if (bytes > this.limits.maxBatchBytes) throw new HttpError(413, '本批文件过大，请缩小批次');
    const files = [];
    for (const value of hashes) {
      const content = await readFile(path.join(this.root(projectId), 'objects', value));
      if (content.length !== allowed.get(value).size || hash(content) !== value) throw new HttpError(500, '源码文件完整性校验失败');
      files.push({ sha256: value, data: content.toString('base64') });
    }
    return { protocol: SOURCE_PROTOCOL, snapshotId: manifest.snapshotId, files };
  }
  async prune(projectId) {
    const root = this.root(projectId), head = await this.head(projectId);
    const retained = new Set();
    for (const name of await readdir(root)) {
      if (!HASH.test(name)) continue;
      const directory = this.snapshotDirectory(projectId, name);
      const age = this.now() - (await stat(directory)).mtimeMs;
      if (name !== head?.snapshotId && !this.readers.has(`${projectId}/${name}`) && age > this.retentionMs) {
        const key = `${projectId}/${name}`; this.deleting.add(key);
        try { await rm(directory, { recursive: true, force: true }); }
        finally { this.deleting.delete(key); }
      } else {
        // If any retained manifest cannot be read, abort object collection conservatively.
        for (const entry of (await this.manifest(projectId, name)).files) retained.add(entry.sha256);
      }
    }
    for (const name of await readdir(path.join(root, 'objects'))) {
      if (HASH.test(name) && !retained.has(name)) await rm(path.join(root, 'objects', name), { force: true });
    }
  }
}
