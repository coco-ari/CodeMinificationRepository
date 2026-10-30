// 在没有 Docker Socket 的临时 Node 容器中执行，只运行仓库声明的构建脚本。
import { readFile, access, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { frontendOptions, lockName, installationArgs } from './frontend-toolchain.mjs';

const [manager, version, script, ...args] = process.argv.slice(2);
if (!['npm', 'pnpm', 'yarn'].includes(manager) || !/^\d+\.\d+\.\d+$/.test(version) || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(script || '')) throw new Error('前端构建参数无效');
const options = frontendOptions({ packageManager: manager, packageManagerVersion: version, installMode: process.env.CMR_INSTALL_MODE, legacyPeerDeps: process.env.CMR_LEGACY_PEER_DEPS === 'true' });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (!Object.prototype.hasOwnProperty.call(manifest.scripts || {}, script)) throw new Error(`package.json 缺少 ${script} 脚本`);
const lock = lockName(manager);
if (options.installMode === 'frozen') {
  try { await access(lock); } catch { throw new Error(`请先提交 ${lock}，或明确选择兼容安装；锁定安装不会自动生成依赖锁文件`); }
}
if (manifest.packageManager && manifest.packageManager !== `${manager}@${version}` && !manifest.packageManager.startsWith(`${manager}@${version}+`)) throw new Error('配置的包管理器版本与 package.json.packageManager 不一致');
if (manager === 'npm' && Number(version.split('.')[0]) < 7) {
  const data = await readFile(lock, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (data?.lockfileVersion > 1) throw new Error('npm 6 不能使用新版锁文件，请选择 npm 8 以上或提交匹配的锁文件');
}
const installed = spawnSync('npm', ['--version'], { encoding: 'utf8' });
let executable = 'npm', prefix = [];
if (manager !== 'npm' || installed.status !== 0 || installed.stdout.trim() !== version) {
  const tools = path.join(process.env.npm_config_cache || os.tmpdir(), 'cmr-tools', `${manager}-${version}`);
  const entry = path.join(tools, 'node_modules', manager, 'bin', manager === 'npm' ? 'npm-cli.js' : manager === 'yarn' ? 'yarn.js' : 'pnpm.cjs');
  try { await access(entry); }
  catch {
    await mkdir(tools, { recursive: true });
    const setup = spawnSync('npm', ['install', '--prefix', tools, '--engine-strict', '--ignore-scripts', '--no-package-lock', '--no-save', '--no-audit', '--no-fund', `${manager}@${version}`], { stdio: 'inherit' });
    if (setup.error) throw setup.error;
    if (setup.status !== 0) process.exit(setup.status || 1);
  }
  // 使用明确的 Node 入口，避免 npm exec 回落到镜像中的其他版本或受缓存挂载执行权限影响。
  executable = process.execPath; prefix = [entry];
}
const actual = spawnSync(executable, [...prefix, '--version'], { encoding: 'utf8' });
if (actual.status !== 0 || actual.stdout.trim() !== version) throw new Error(`无法取得配置指定的包管理器版本 ${manager}@${version}：${actual.error?.message || actual.stderr?.trim().slice(-2000) || actual.stdout?.trim() || `退出码 ${actual.status}`}`);
console.log(`CMR_BUILD_INFO=${JSON.stringify({ packageManager: manager, packageManagerVersion: actual.stdout.trim(), nodeVersion: process.version })}`);
console.log(options.installMode === 'frozen' ? `锁定安装：${lock}` : '兼容安装：允许解析依赖，未来重新构建可能得到不同依赖；建议提交锁文件后改为锁定安装。');
function run(command) {
  const result = spawnSync(executable, [...prefix, ...command], { stdio: 'inherit', env: { ...process.env, CI: 'true', NODE_ENV: 'production' } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(installationArgs(manager, version, options));
run(['run', script, ...(manager === 'npm' ? ['--'] : []), ...args]);
