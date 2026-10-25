import { mkdir, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (args.includes('--fail-build')) throw new Error('隔离验收主动触发构建失败');
const version = args.find((arg) => arg.startsWith('--version='))?.slice('--version='.length) || 'v1';
if (!/^[a-z0-9-]{1,24}$/.test(version)) throw new Error('隔离验收版本标记无效');
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>静态部署验收</title><body>static-ready ${version}</body></html>\n`);
console.log(`静态部署验收产物已生成：${version}`);
