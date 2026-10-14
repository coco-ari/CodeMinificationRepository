// 在没有 Docker Socket 的临时 Node 容器中执行，只运行仓库声明的构建脚本。
import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const [manager, version, script, ...args] = process.argv.slice(2);
if (!['npm', 'pnpm'].includes(manager) || !/^\d+\.\d+\.\d+$/.test(version) || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(script || '')) throw new Error('前端构建参数无效');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (!Object.hasOwn(manifest.scripts || {}, script)) throw new Error(`package.json 缺少 ${script} 脚本`);
const lock = manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
try { await access(lock); } catch { throw new Error(`请先提交 ${lock}，发布时不自动生成或更新依赖锁文件`); }
if (manager === 'pnpm' && manifest.packageManager && manifest.packageManager !== `pnpm@${version}` && !manifest.packageManager.startsWith(`pnpm@${version}+`)) throw new Error('配置的 pnpm 版本与 package.json.packageManager 不一致');
function run(command) {
  const result = spawnSync('npm', command, { stdio: 'inherit', env: { ...process.env, CI: 'true', NODE_ENV: 'production' } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (manager === 'npm') {
  run(['ci', '--include=dev', '--no-audit', '--no-fund']);
  run(['run', script, '--', ...args]);
} else {
  const prefix = ['exec', '--yes', `--package=pnpm@${version}`, '--', 'pnpm'];
  run([...prefix, 'install', '--frozen-lockfile', '--prod=false', '--store-dir', '/cache/pnpm']);
  run([...prefix, 'run', script, ...args]);
}
