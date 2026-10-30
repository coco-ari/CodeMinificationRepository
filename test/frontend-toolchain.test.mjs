import test from 'node:test';
import assert from 'node:assert/strict';
import { installationArgs, frontendOptions, lockName } from '../agent/frontend-toolchain.mjs';
import { validateConfig } from '../src/deployment.mjs';
import { normalizeConfig } from '../agent/config.mjs';

test('工具链默认锁定安装，npm 6 安装开发依赖，兼容模式必须显式选择', () => {
  assert.deepEqual(installationArgs('npm', '6.14.18'), ['ci', '--production=false', '--no-audit', '--no-fund']);
  assert.deepEqual(installationArgs('npm', '8.19.4', { installMode: 'install', legacyPeerDeps: true }), ['install', '--include=dev', '--no-audit', '--no-fund', '--legacy-peer-deps']);
  assert.ok(installationArgs('pnpm', '10.11.0').includes('--frozen-lockfile'));
  assert.ok(installationArgs('pnpm', '10.11.0', { installMode: 'install' }).includes('--no-frozen-lockfile'));
  assert.ok(installationArgs('yarn', '1.22.22').includes('--frozen-lockfile'));
  assert.equal(lockName('yarn'), 'yarn.lock');
  assert.throws(() => frontendOptions({ installMode: 'auto' }));
  assert.throws(() => frontendOptions({ packageManager: 'pnpm', legacyPeerDeps: true }));
  assert.throws(() => frontendOptions({ packageManager: 'yarn', packageManagerVersion: '4.0.0' }));
});

test('中心与 Agent 保留相同的独立工具链配置，旧配置仍然锁定安装', () => {
  for (const packageManager of ['npm', 'pnpm', 'yarn']) {
    const input = { kind: 'static', packageManager, packageManagerVersion: packageManager === 'yarn' ? '1.22.22' : '8.19.4', installMode: 'install', legacyPeerDeps: packageManager === 'npm', health: { url: 'https://site.test/' } };
    const center = validateConfig(input, 'web', 'static'), agent = normalizeConfig(center);
    for (const key of ['packageManager', 'packageManagerVersion', 'installMode', 'legacyPeerDeps']) assert.equal(center[key], agent[key]);
  }
  assert.equal(validateConfig({}, 'web', 'static').installMode, 'frozen');
  assert.equal(normalizeConfig({ kind: 'static', health: { url: 'https://site.test/' } }).installMode, 'frozen');
  assert.equal(normalizeConfig({ kind: 'static' }, { buildOnly: true }).health.url, '');
  assert.throws(() => normalizeConfig({ kind: 'static' }), /访问地址/);
});
