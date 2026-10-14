import { readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'agent');
const files = [];
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), relative + '/');
    // 安装包只包含程序文件，不打包运行身份、缓存和本地凭据。
    else if (entry.isFile() && (/\.(mjs|sh|java)$/.test(entry.name) || /^Dockerfile(?:\.[A-Za-z0-9_-]+)?$/.test(entry.name))) files.push(relative);
  }
}
await collect(source);
if (!files.includes('install.sh') || !files.includes('Dockerfile')) throw new Error('Agent 安装文件尚未完整生成');
await mkdir(path.join(root, 'dist'), { recursive: true });
await promisify(execFile)('tar', ['-czf', path.join(root, 'dist/agent-bundle.tar.gz'), '-C', source, ...files.sort()], { windowsHide: true });
console.log(`Agent 安装包已生成，共 ${files.length} 个程序文件。`);
