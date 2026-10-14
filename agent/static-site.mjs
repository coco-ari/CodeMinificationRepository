import { mkdir, readdir, lstat, realpath, copyFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { safeChild } from './config.mjs';

export async function copyStaticSite(source, artifactPath, destination) {
  const root = await realpath(source), output = safeChild(source, ...artifactPath.split('/'));
  const info = await lstat(output), resolved = await realpath(output);
  if (!info.isDirectory() || info.isSymbolicLink() || !resolved.startsWith(`${root}${path.sep}`)) throw new Error('静态产物目录无效或越出源码目录');
  if (await lstat(path.join(output, 'package.json')).catch(() => null)) throw new Error('输出目录包含 package.json，拒绝将前端源码目录作为站点发布');
  const index = await lstat(safeChild(output, 'index.html'));
  if (!index.isFile() || index.isSymbolicLink() || index.size === 0) throw new Error('静态产物目录必须包含非空 index.html；SSR 不在当前支持范围内');
  let count = 0, bytes = 0;
  async function copy(from, to) {
    await mkdir(to, { recursive: true, mode: 0o755 });
    await chmod(to, 0o755);
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (++count > 100000) throw new Error('静态产物文件数量超出限制');
      if (entry.name.startsWith('.') || entry.name === 'node_modules') throw new Error('静态产物包含隐藏文件或依赖目录，请检查输出目录');
      const file = safeChild(from, entry.name), target = safeChild(to, entry.name), stat = await lstat(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('静态产物不允许符号链接或特殊文件');
      if (stat.isDirectory()) await copy(file, target);
      else {
        bytes += stat.size;
        if (bytes > 512 * 1024 * 1024) throw new Error('静态产物超过 512 MiB');
        await copyFile(file, target); await chmod(target, 0o644);
      }
    }
  }
  await copy(output, destination);
  return { files: count, bytes };
}
