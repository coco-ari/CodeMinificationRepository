// 此模块同时运行在中心、Agent 和 Node 14 以上的独立构建容器中。
export const FRONTEND_CAPABILITY = 'frontend-toolchain-v1';
export function frontendOptions(input) {
  const installMode = input.installMode || 'frozen';
  if (!['frozen', 'install'].includes(installMode)) throw new Error('依赖安装方式无效');
  if (input.legacyPeerDeps !== undefined && typeof input.legacyPeerDeps !== 'boolean') throw new Error('依赖兼容选项无效');
  if (input.legacyPeerDeps && input.packageManager !== 'npm') throw new Error('旧项目 peer 依赖兼容选项仅适用于 npm');
  if (input.packageManager === 'yarn' && !/^1\.22\.\d+$/.test(input.packageManagerVersion || '')) throw new Error('目前支持 Yarn Classic 1.22.x，请填写准确版本');
  return { installMode, legacyPeerDeps: input.legacyPeerDeps || false };
}
export function lockName(manager) {
  return { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock' }[manager];
}
export function installationArgs(manager, version, options = {}) {
  const { installMode, legacyPeerDeps } = frontendOptions({ ...options, packageManager: manager, packageManagerVersion: version });
  const frozen = installMode === 'frozen';
  if (manager === 'npm') return [frozen ? 'ci' : 'install', Number(version.split('.')[0]) < 7 ? '--production=false' : '--include=dev', '--no-audit', '--no-fund', ...(legacyPeerDeps ? ['--legacy-peer-deps'] : [])];
  if (manager === 'pnpm') return ['install', frozen ? '--frozen-lockfile' : '--no-frozen-lockfile', '--prod=false', '--store-dir', '/cache/pnpm'];
  return ['install', ...(frozen ? ['--frozen-lockfile'] : []), '--production=false', '--non-interactive', '--cache-folder', '/cache/yarn'];
}
