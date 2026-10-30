import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeEnvFiles, preflightEnvFiles, assertEnvFileAgent } from '../agent/env-files.mjs';
import { normalizeConfig, labels } from '../agent/config.mjs';
import { composeFor, DeploymentExecutor } from '../agent/executor.mjs';
import { validateConfig } from '../src/deployment.mjs';

const envFiles = ['/opt/cmr-agent/env-files/api.env'];
const identity = { serverId: 'server-one', mode: 'managed', targets: [{ id: 'target-one', serverId: 'server-one', mode: 'managed' }] };
const task = { id: 'task-one', targetId: 'target-one', serverId: 'server-one', action: 'deploy' };
const legacy = { module: '.', profile: 'test', ports: [{ host: '127.0.0.1', hostPort: 10031, containerPort: 10031 }], volumes: [{ name: 'logs', mountPath: '/app/logs' }] };

async function directories(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cmr-env-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentRoot = path.join(root, 'agent');
  await mkdir(path.join(agentRoot, 'env-files'), { recursive: true });
  return { root, agentRoot };
}

test('未配置和空环境文件保持原有配置及 Compose 清单，不改变普通网络和日志卷', () => {
  for (const normalize of [normalizeConfig, validateConfig]) {
    const original = normalize(legacy);
    assert.equal('envFiles' in original, false);
    assert.deepEqual(normalize({ ...legacy, envFiles: [] }), original);
  }
  const release = { id: task.id, image: 'cmr/target-one:task-one', config: legacy };
  const original = composeFor(identity, task, release);
  assert.deepEqual(composeFor(identity, task, { ...release, config: { ...legacy, envFiles: [] } }), original);
  assert.equal('env_file' in original.services.app, false);
  assert.equal('network_mode' in original.services.app, false);
  assert.deepEqual(original.services.app.ports, ['127.0.0.1:10031:10031']);
  assert.deepEqual(original.services.app.volumes, ['logs:/app/logs']);
});

test('中心和 Agent 保留有序环境文件路径，Compose 只注入指定服务且不改变其他运行设置', () => {
  const files = [...envFiles, '/opt/cmr-agent/env-files/override.env'];
  for (const normalize of [normalizeConfig, validateConfig]) assert.deepEqual(normalize({ ...legacy, envFiles: files }).envFiles, files);
  const original = composeFor(identity, task, { id: task.id, config: legacy });
  const updated = composeFor(identity, task, { id: task.id, config: { ...legacy, envFiles: files } });
  assert.deepEqual(updated.services.app.env_file, files);
  delete updated.services.app.env_file;
  assert.deepEqual(updated, original);
});

test('环境文件拒绝无效路径、重复、超限、系统目录以及静态站点误用', () => {
  for (const value of [null, 'api.env', ['relative.env'], ['/', '/tmp/api.env'], ['/tmp/../api.env'], ['/tmp//api.env'], ['/tmp/api$KEY.env'], ['/etc/app.env'], ['/proc/self/environ'], [...envFiles, ...envFiles], Array(9).fill('/tmp/api.env')]) {
    assert.throws(() => normalizeEnvFiles(value));
    assert.throws(() => validateConfig({ ...legacy, envFiles: value }));
    assert.throws(() => normalizeConfig({ ...legacy, envFiles: value }));
  }
  const config = { kind: 'static', module: 'web', envFiles, health: { url: 'https://example.invalid/' } };
  assert.throws(() => normalizeConfig(config), /静态站点/);
  assert.throws(() => validateConfig(config), /静态站点/);
  assert.doesNotThrow(() => assertEnvFileAgent({}, []));
  assert.throws(() => assertEnvFileAgent({ envFiles }, []), /升级目标 Agent/);
  assert.doesNotThrow(() => assertEnvFileAgent({ envFiles }, ['env-file-v1']));
});

test('节点只检查文件可读性和范围，缺失、目录、大文件和身份文件在切换前拒绝', async t => {
  const { root, agentRoot } = await directories(t);
  const file = path.join(agentRoot, 'env-files', 'api.env');
  const body = "EXAMPLE_VALUE='fictional-value'\n";
  await writeFile(file, body);
  await preflightEnvFiles([file], agentRoot);
  assert.equal(await readFile(file, 'utf8'), body);
  await assert.rejects(preflightEnvFiles([path.join(root, 'missing.env')], agentRoot), /不存在或不可读取/);
  await assert.rejects(preflightEnvFiles([agentRoot], agentRoot), /普通文件/);
  const identityFile = path.join(agentRoot, 'identity.json');
  await writeFile(identityFile, '{}');
  await assert.rejects(preflightEnvFiles([identityFile], agentRoot), /不能读取身份或任务文件/);
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(preflightEnvFiles([file], agentRoot), /1 MiB/);
});

test('旧项目保持 Docker restart，只有启用环境文件的成功版本重建当前镜像', async t => {
  const { agentRoot } = await directories(t), calls = [], events = [];
  const executor = new DeploymentExecutor({ root: agentRoot, identity, journal: { emit: async (_, event) => events.push(event) }, docker: { run: async args => calls.push(args) } });
  t.mock.method(executor, 'requireOwned', async () => ({}));
  const activate = t.mock.method(executor, 'activate', async () => {});
  const release = { id: 'original-version', image: 'cmr/target-one:original-version', config: normalizeConfig(legacy) };
  await executor.restart(task, release);
  assert.deepEqual(calls, [['restart', '--time', '45', 'cmr-target-one']]);
  assert.equal(activate.mock.callCount(), 0);
  const configured = { ...release, config: normalizeConfig({ ...legacy, envFiles }) };
  await executor.restart(task, configured);
  assert.equal(calls.length, 1);
  assert.deepEqual(activate.mock.calls[0].arguments, [task, configured, true]);
  assert.equal(events.length, 1);
});

test('环境文件解析错误不会泄露 Docker 输出中的变量内容，重建使用原版本镜像', async t => {
  const { agentRoot } = await directories(t), calls = [], events = [];
  const secret = 'fictional-env-secret-for-isolated-test';
  const executor = new DeploymentExecutor({ root: agentRoot, identity, journal: { emit: async (_, event) => events.push(event) }, docker: { run: async (args, options) => { calls.push(args); await options.onOutput?.(secret); throw new Error(secret); } } });
  t.mock.method(executor, 'requireRelease', async () => {});
  t.mock.method(executor, 'preflight', async () => {});
  await mkdir(executor.taskRoot(task), { recursive: true });
  const release = { id: 'original-version', image: 'cmr/target-one:original-version', config: normalizeConfig({ ...legacy, envFiles }) };
  await assert.rejects(executor.activate(task, release, true), error => error.message.includes('容器创建失败') && !error.message.includes(secret));
  assert.equal(events.length, 0);
  assert.ok(calls[0].includes('--force-recreate'));
  const manifest = JSON.parse(await readFile(path.join(executor.taskRoot(task), 'compose-original-version.json'), 'utf8'));
  assert.equal(manifest.services.app.image, release.image);
  assert.deepEqual(manifest.services.app.labels, labels(identity.serverId, task.targetId, release.id));
});
