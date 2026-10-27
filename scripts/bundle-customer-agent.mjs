import { mkdir, readFile, writeFile, copyFile, rename, readdir, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import path from 'node:path';
import { generateThirdPartyLicenseManifest } from '../vendor/t3code/scripts/lib/third-party-licenses.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const t3Root = path.join(root, 'vendor/t3code');
const output = path.resolve(root, 'dist/customer-agent');
if (path.relative(path.resolve(root, 'dist'), output) !== 'customer-agent') throw new Error('客户构建目录越过允许的输出范围');
// 此目录只保存本次客户程序产物；校验目录后清理旧分块。
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// 使用同一锁定 CLI 的 JavaScript 入口，避免 Windows 的 .cmd 与 POSIX 启动文件差异。
await promisify(execFile)(process.execPath, [path.join(t3Root, 'node_modules/vite-plus/bin/vp'),
  'pack', '../../agent-demo/customer-agent/cli.ts', '--no-config', '--format', 'esm',
  '--out-dir', output, '--sourcemap', '--deps.always-bundle', '/.*/', '--target', 'node24',
], { cwd: t3Root, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` }, maxBuffer: 8 * 1024 * 1024 });

// The sourcemap is also a dependency inventory: a customer must never ship the
// platform database, secret configuration, material bridge or attachment store.
const sources = new Set();
for (const filename of await readdir(output)) {
  if (!filename.endsWith('.map')) continue;
  const map = JSON.parse(await readFile(path.join(output, filename), 'utf8'));
  for (const source of map.sources) sources.add(source);
}
const prohibited = [...sources].filter(source =>
  /\/agent-demo\/(?:t3-adapters|server\.mjs|fixtures\.mjs)/.test(source) ||
  /\/apps\/server\/src\/(?:config\.ts|attachmentStore\.ts|secrets\/|persistence\/|autoops\/)/.test(source));
if (prohibited.length) throw new Error(`客户安装包包含平台依赖：${prohibited.join(', ')}`);
// Reuse T3's notice collector against every bundled module from every chunk.
// packageManifests stays empty so unrelated platform dependencies are not claimed as shipped.
const notices = await generateThirdPartyLicenseManifest({
  configFile: path.join(t3Root, 'third-party-licenses.config.json'),
  packageManifests: [], bundleName: 'customer-agent',
  bundledModuleIds: [...sources].map(source => path.resolve(output, source)),
});
await writeFile(path.join(output, 'third-party-licenses.json'), JSON.stringify(notices, null, 2) + '\n');
await writeFile(path.join(output, 'THIRD-PARTY-NOTICES.txt'), notices.entries.map(entry =>
  `${entry.name}${entry.version ? `@${entry.version}` : ''}\nLicense: ${entry.license}\n${entry.sourceUrl ?? ''}\n\n${entry.noticeText}`,
).join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
await writeFile(path.join(output, 'dependency-audit.json'), JSON.stringify({
  schemaVersion: 1, entry: 'agent-demo/customer-agent/cli.ts',
  sourceModules: sources.size, auditedAllChunks: true, prohibitedPlatformDependencies: [],
  bundledThirdPartyNotices: notices.entries.length,
}, null, 2) + '\n');
await rename(path.join(output, 'cli.mjs'), path.join(output, 'autoops-customer-agent.mjs'));
await copyFile(path.join(t3Root, 'LICENSE'), path.join(output, 'LICENSE-T3-Code'));
await copyFile(path.join(root, 'agent-demo/customer-agent/README.md'), path.join(output, 'README.md'));
await copyFile(path.join(root, 'agent-demo/customer-agent/shared-container-entry.mjs'), path.join(output, 'shared-container-entry.mjs'));
for (const [name, location] of [
  ['effect', 'effect'], ['effect-platform-node', '@effect/platform-node'],
  ['effect-platform-node-shared', '@effect/platform-node-shared'], ['undici', 'undici'],
]) {
  await copyFile(path.join(t3Root, 'apps/server/node_modules', location, 'LICENSE'), path.join(output, `LICENSE-${name}`));
}
const requireNodeShared = createRequire(await realpath(path.join(t3Root, 'apps/server/node_modules/@effect/platform-node-shared/package.json')));
await copyFile(path.join(path.dirname(requireNodeShared.resolve('ws/package.json')), 'LICENSE'), path.join(output, 'LICENSE-ws'));

const files = {};
const manifest = { schemaVersion: 1, connectorVersion: '0.4.5', protocolVersion: 1, node: '>=24.10', files: {} };
for (const filename of (await readdir(output)).sort()) {
  if (filename.endsWith('.map')) continue;
  let bytes = await readFile(path.join(output, filename));
  if (filename.endsWith('.mjs')) {
    bytes = Buffer.from(bytes.toString('utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, ''));
    await writeFile(path.join(output, filename), bytes);
  }
  files[`customer-agent/${filename}`] = bytes;
  manifest.files[filename] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(output, 'manifest.json'), manifestBytes);
files['customer-agent/manifest.json'] = manifestBytes;
const archivePath = path.join(root, 'dist/customer-agent.zip');
const archive = zipSync(files, { level: 9 });
await writeFile(archivePath, archive);
await writeFile(`${archivePath}.sha256`, `${createHash('sha256').update(archive).digest('hex')}  customer-agent.zip\n`);
console.log(`客户连接程序已构建：${archivePath}；全部分块平台依赖审计通过，含许可、说明与 SHA-256 清单。`);
