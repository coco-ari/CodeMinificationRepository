import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { safeChild } from './config.mjs';

const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let n = 0; n < 8; n++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(buffer) { let c = 0xffffffff; for (const b of buffer) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function inspectZip(data, { maxBytes = 1024 * 1024 * 1024, maxFiles = 100000, maxFileBytes = 32 * 1024 * 1024 } = {}) {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
  }
  if (end < 0) throw new Error('源码 ZIP 缺少完整目录');
  const count = data.readUInt16LE(end + 10), directorySize = data.readUInt32LE(end + 12), start = data.readUInt32LE(end + 16);
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || count !== data.readUInt16LE(end + 8) || count === 65535 || count > maxFiles || start + directorySize !== end) throw new Error('不支持分卷、ZIP64 或过大的 ZIP');
  let offset = start, total = 0; const entries = [], names = new Map();
  for (let n = 0; n < count; n++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const flags = data.readUInt16LE(offset + 8), method = data.readUInt16LE(offset + 10), expectedCrc = data.readUInt32LE(offset + 16), size = data.readUInt32LE(offset + 24), packed = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28), extra = data.readUInt16LE(offset + 30), comment = data.readUInt16LE(offset + 32), mode = data.readUInt32LE(offset + 38) >>> 16, local = data.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extra + comment > end) throw new Error('ZIP 文件名损坏');
    const rawName = data.subarray(offset + 46, offset + 46 + nameLength), name = new TextDecoder('utf-8', { fatal: true }).decode(rawName), directory = name.endsWith('/'), clean = directory ? name.slice(0, -1) : name;
    if (!clean || /[\\\x00-\x1f:]/.test(clean) || clean.startsWith('/') || clean.split('/').some(p => !p || p === '.' || p === '..') || names.has(clean)) throw new Error('ZIP 含不安全或重复路径');
    if ((mode & 0xf000) === 0xa000 || ((mode & 0xf000) && ![0x8000, 0x4000].includes(mode & 0xf000))) throw new Error('源码 ZIP 不允许符号链接或特殊文件');
    if (flags & 1 || ![0, 8].includes(method) || size === 0xffffffff || packed === 0xffffffff || local + 30 > start || data.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP 压缩格式不支持');
    const localNameLength = data.readUInt16LE(local + 26), localExtra = data.readUInt16LE(local + 28), body = local + 30 + localNameLength + localExtra;
    if (body + packed > start || data.readUInt16LE(local + 8) !== method || !data.subarray(local + 30, local + 30 + localNameLength).equals(rawName)) throw new Error('ZIP 文件头不一致');
    total += size; if (total > maxBytes || size > maxFileBytes) throw new Error('源码解压体积超出限制');
    names.set(clean, directory); entries.push({ name: clean, directory, mode, size, packed, body, method, expectedCrc }); offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end) throw new Error('ZIP 目录长度不符');
  for (const entry of entries) {
    for (let parent = path.posix.dirname(entry.name); parent !== '.'; parent = path.posix.dirname(parent)) {
      if (names.has(parent) && !names.get(parent)) throw new Error('ZIP 目录与文件路径冲突');
    }
  }
  return entries;
}
export async function extractZip(file, root, options = {}) {
  const data = await readFile(file), entries = inspectZip(data, options);
  // 只向新建的专属目录写入，避免历史文件或链接改变解压目的地。
  await mkdir(root, { mode: 0o700 });
  for (const entry of entries) {
    const destination = safeChild(root, ...entry.name.split('/'));
    if (entry.directory) { await mkdir(destination, { recursive: true, mode: 0o755 }); continue; }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    const compressed = data.subarray(entry.body, entry.body + entry.packed);
    const output = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
    if (output.length !== entry.size || crc32(output) !== entry.expectedCrc) throw new Error('ZIP 文件内容校验失败');
    await writeFile(destination, output, { flag: 'wx', mode: entry.mode & 0o111 ? 0o755 : 0o644 });
    if (!(await lstat(destination)).isFile()) throw new Error('解压文件类型无效');
  }
  return entries.length;
}
