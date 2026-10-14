import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { normalizeConfig, assertManaged, labels, managedName, releaseImage, owns, safeChild } from '../agent/config.mjs';
import { inspectZip, extractZip, crc32 } from '../agent/archive.mjs';
import { TaskJournal, readJson, writeJson } from '../agent/state.mjs';
import { DeploymentExecutor, composeFor } from '../agent/executor.mjs';
import { CenterClient } from '../agent/client.mjs';
import { AgentRunner } from '../agent/runner.mjs';
import { Monitor } from '../agent/monitor.mjs';
import { acquireAgentLock } from '../agent/lock.mjs';
import { Docker } from '../agent/docker.mjs';

const revision = 'a'.repeat(40);
function zip(entries) {
  const bodies = [], directory = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), content = Buffer.from(entry.content || ''), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc32(content), 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((entry.mode || 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    bodies.push(local, name, content); directory.push(central, name); offset += 30 + name.length + content.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, central, end]);
}
function config(extra = {}) { return normalizeConfig({ module: '.', artifactPath: 'target/demo.jar', profile: '', health: { port: 18081, path: '/health', bodyIncludes: 'ready', timeoutSeconds: 10, intervalSeconds: 2 }, ...extra }); }
function identity(mode = 'managed') { return { serverId: 'server-1', token: 's'.repeat(43), mode, targets: [{ id: 'target-1', serverId: 'server-1', mode, containerName: 'jenkins-service' }] }; }
function task(id = 'task-1', extra = {}) { return { id, targetId: 'target-1', serverId: 'server-1', applicationId: 'application-1', action: 'deploy', config: config(), source: { url: `/api/agent/v1/tasks/${id}/source`, revision, sha256: 'b'.repeat(64) }, ...extra }; }

class FakeDocker {
  constructor() { this.calls = []; this.containers = new Map(); this.images = new Map(); this.other = new Map(); this.unhealthyTask = null; }
  async inspect(name, kind = 'container') { this.calls.push(['inspect', kind, name]); return (kind === 'container' ? this.containers : kind === 'image' ? this.images : this.other).get(name) || null; }
  async run(args, options = {}) {
    this.calls.push([...args]);
    if (args[0] === 'run') {
      const mount = args.filter((_, i) => args[i - 1] === '--mount').find(v => v.includes('dst=/workspace'));
      const source = mount.match(/src=(.*?),dst=/)[1];
      if (args.includes('mvn')) { await mkdir(path.join(source, 'target')); await writeFile(path.join(source, 'target', 'demo.jar'), Buffer.alloc(64)); }
      if (args.includes('javac')) await writeFile(path.join(source, 'HealthProbe.class'), Buffer.alloc(16));
      await options.onOutput?.('构建输出\n');
    }
    if (args[0] === 'build') {
      const image = args[args.indexOf('-t') + 1], values = Object.fromEntries(args.filter((_, i) => args[i - 1] === '--label').map(v => { const equal = v.indexOf('='); return [v.slice(0, equal), v.slice(equal + 1)]; }));
      this.images.set(image, { Config: { Labels: values } });
    }
    if (args[0] === 'compose' && args.includes('up')) {
      const compose = JSON.parse(await readFile(args[args.indexOf('-f') + 1], 'utf8')), app = compose.services.app;
      const bad = app.image.endsWith(`:${this.unhealthyTask}`);
      this.containers.set(app.container_name, { Id: app.image, Config: { Image: app.image, Labels: app.labels }, State: { Running: !bad, Status: bad ? 'exited' : 'running', Health: { Status: bad ? 'unhealthy' : 'healthy' }, StartedAt: new Date().toISOString() }, RestartCount: 0 });
      await options.onOutput?.('容器更新完成\n');
    }
    if (args[0] === 'rm') this.containers.delete(args.at(-1));
    if (args[0] === 'image' && args[1] === 'rm') this.images.delete(args[2]);
    return { code: 0, output: '' };
  }
}

async function fixture(t, currentIdentity = identity()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cmr-agent-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const docker = new FakeDocker(), journal = new TaskJournal(root), archive = zip([{ name: 'pom.xml', content: '<project />' }]);
  const client = { download: async (_, file) => writeFile(file, archive) };
  const executor = new DeploymentExecutor({ root, identity: currentIdentity, journal, client, docker, sleepFn: async () => {} });
  return { root, docker, journal, client, executor, identity: currentIdentity };
}

test('Agent 配置限制资源、路径、入口和卷，同时支持 Maven 根模块', () => {
  assert.equal(config().module, '');
  for (const change of [{ module: '../outside' }, { artifactPath: '*/target/*.jar' }, { volumes: [{ name: 'data', mountPath: '/var/run/docker.sock' }] }, { runtimeImage: 'jdk\nRUN bad' }, { jvmArgs: ['-javaagent:/tmp/a.jar'] }, { ports: [{ host: 'attacker', hostPort: 8000, containerPort: 8000 }] }]) assert.throws(() => config(change));
  assert.throws(() => safeChild('/opt/cmr-agent', '..', 'jenkins'));
  assert.throws(() => assertManaged(identity('observe'), task()));
  assert.equal(owns({ Labels: labels('server-1', 'target-1') }, 'server-1', 'target-1'), true);
  assert.equal(owns({ Labels: labels('server-2', 'target-1') }, 'server-1', 'target-1'), false);
});

test('Docker 区分资源缺失和连接失败，覆盖网络资源的真实错误格式', async () => {
  const docker = new Docker();
  docker.run = async () => ({ code: 1, output: '[]\nError response from daemon: network cmr-missing not found\n' });
  assert.equal(await docker.inspect('cmr-missing', 'network'), null);
  docker.run = async () => ({ code: 1, output: 'permission denied while trying to connect to the Docker daemon socket' });
  await assert.rejects(docker.inspect('cmr-missing', 'network'), /连接错误/);
});

test('ZIP 拒绝路径穿越、链接、重复路径、CRC 错误和解压炸弹', async t => {
  for (const entries of [[{ name: '../outside' }], [{ name: '/root/file' }], [{ name: 'a\\b' }], [{ name: 'symlink', mode: 0o120777 }], [{ name: 'a' }, { name: 'a' }], [{ name: 'a' }, { name: 'a/b' }]]) assert.throws(() => inspectZip(zip(entries)));
  assert.throws(() => inspectZip(zip([{ name: 'large', content: '1234' }]), { maxBytes: 2 }));
  const { root } = await fixture(t), archive = zip([{ name: '中文目录/文件.txt', content: '源码' }]);
  const file = path.join(root, 'test.zip'); await writeFile(file, archive); await extractZip(file, path.join(root, 'extracted'));
  assert.equal(await readFile(path.join(root, 'extracted', '中文目录', '文件.txt'), 'utf8'), '源码');
  archive[30 + Buffer.byteLength('中文目录/文件.txt')] ^= 1;
  await writeFile(file, archive); await assert.rejects(extractZip(file, path.join(root, 'bad')), /校验失败/);
});

test('仅观察模式不能启动构建、重启、回退或执行 Docker 写操作', async t => {
  const { executor, docker, journal } = await fixture(t, identity('observe'));
  for (const action of ['deploy', 'restart', 'rollback']) {
    const value = task(`observe-${action}`, { action }); await executor.execute(value);
    assert.equal((await journal.get(value.id)).status, 'failed');
  }
  assert.deepEqual(docker.calls, []);
  const mixed = identity(); mixed.targets[0].mode = 'observe';
  const separate = await fixture(t, mixed); await separate.executor.execute(task('observe-target'));
  assert.deepEqual(separate.docker.calls, []);
});

test('托管目标出现非本平台容器时拒绝覆盖，且不触碰 Jenkins', async t => {
  const { executor, docker, journal } = await fixture(t);
  docker.containers.set('cmr-target-1', { Config: { Labels: {}, Image: 'jenkins/old:1' } });
  await executor.execute(task()); assert.equal((await journal.get('task-1')).status, 'failed');
  assert.ok(docker.calls.every(c => c[0] === 'inspect'));
});

test('完整发布与手动回退、重启使用目标专属资源，重复任务不重复部署', async t => {
  const { executor, docker, journal, root } = await fixture(t);
  const jenkins = { Id: 'original', State: { StartedAt: 'original' }, RestartCount: 0 }; docker.containers.set('jenkins-service', jenkins);
  await executor.execute(task()); assert.equal((await journal.get('task-1')).status, 'succeeded');
  const release1 = (await journal.get('task-1')).result.release;
  const calls = docker.calls.length; await executor.execute(task()); assert.equal(docker.calls.length, calls);
  await executor.execute(task('task-2')); assert.equal((await journal.get('task-2')).status, 'succeeded');
  await executor.execute(task('rollback-1', { action: 'rollback', release: release1 }));
  assert.equal((await journal.get('rollback-1')).status, 'succeeded'); assert.equal((await executor.current(task())).id, 'task-1');
  await executor.execute(task('restart-1', { action: 'restart' })); assert.equal((await journal.get('restart-1')).status, 'succeeded');
  assert.equal(docker.containers.get('jenkins-service'), jenkins);
  const builds = docker.calls.filter(c => c[0] === 'run'); assert.ok(builds.length > 0);
  for (const build of builds) { assert.equal(build.some(a => a.includes('docker.sock')), false); assert.ok(build.includes('1000:1000')); }
  const compose = JSON.parse(await readFile(path.join(root, 'work', 'task-1', 'compose-task-1.json'), 'utf8'));
  assert.deepEqual(await readdir(path.join(root, 'work', 'task-1')), ['compose-task-1.json']);
  assert.equal(compose.name, 'cmr-target-1'); assert.equal(compose.services.app.labels['io.cmr.server'], 'server-1');
  assert.ok(compose.services.app.healthcheck.test.includes('HealthProbe'));
});

test('发布健康失败自动恢复上一成功版本，编译失败不会重建运行容器', async t => {
  const { executor, docker, journal } = await fixture(t);
  await executor.execute(task()); docker.unhealthyTask = 'bad-task'; await executor.execute(task('bad-task'));
  const failure = await journal.get('bad-task'); assert.equal(failure.status, 'rolled_back'); assert.equal(failure.result.rollback.status, 'succeeded');
  assert.equal(docker.containers.get('cmr-target-1').Config.Image, 'cmr/target-1:task-1');
  const before = docker.calls.filter(c => c[0] === 'compose').length;
  executor.client.download = async () => { throw new Error('网络失败'); };
  await executor.execute(task('download-failure')); assert.equal((await journal.get('download-failure')).status, 'failed');
  assert.equal(docker.calls.filter(c => c[0] === 'compose').length, before);
});

test('首次发布失败仅删除本任务的失败容器，之后可以正常重试发布', async t => {
  const { executor, docker, journal } = await fixture(t); docker.unhealthyTask = 'first-failure';
  await executor.execute(task('first-failure'));
  assert.equal((await journal.get('first-failure')).status, 'failed');
  assert.equal(docker.containers.has('cmr-target-1'), false); assert.equal(docker.images.has('cmr/target-1:first-failure'), false);
  await executor.execute(task('retry-success')); assert.equal((await journal.get('retry-success')).status, 'succeeded');
});

test('中断部署只核验既有容器，中断构建只终止自身构建容器', async t => {
  const { executor, docker, journal } = await fixture(t);
  await executor.execute(task());
  const value = task('recover-task'), release = { id: value.id, image: releaseImage(value.targetId, value.id), revision, config: value.config };
  await journal.create(value); await journal.update(value.id, { release, previousRelease: await executor.current(value), stage: 'deploying' });
  docker.images.set(release.image, { Config: { Labels: labels('server-1', 'target-1', value.id) } });
  docker.containers.set('cmr-target-1', { Config: { Image: release.image, Labels: labels('server-1', 'target-1', value.id) }, State: { Running: true, Status: 'running', Health: { Status: 'healthy' } } });
  const before = docker.calls.filter(c => c[0] === 'compose').length;
  await executor.recover(await journal.get(value.id)); assert.equal((await journal.get(value.id)).status, 'succeeded');
  assert.equal(docker.calls.filter(c => c[0] === 'compose').length, before);
  const interrupted = task('interrupted-build'); await journal.create(interrupted); await journal.update(interrupted.id, { stage: 'building' });
  docker.containers.set('cmr-build-interrupted-build-maven', { Config: { Labels: labels('server-1', 'target-1', interrupted.id) } });
  await executor.recover(await journal.get(interrupted.id)); assert.equal((await journal.get(interrupted.id)).status, 'interrupted');
  assert.equal(docker.containers.has('cmr-build-interrupted-build-maven'), false);
});

test('历史保留最近五个成功版本，不清理外部镜像和数据卷', async t => {
  const { executor, docker, journal, root } = await fixture(t);
  docker.images.set('jenkins/app:old', { Config: { Labels: {} } });
  for (let i = 1; i <= 7; i++) { await executor.execute(task(`release-${i}`)); assert.equal((await journal.get(`release-${i}`)).status, 'succeeded'); }
  const files = await readdir(path.join(root, 'targets', 'target-1', 'releases')); assert.equal(files.length, 5);
  assert.equal(docker.images.has('jenkins/app:old'), true);
  assert.equal(docker.calls.some(c => c.includes('prune') || (c[0] === 'volume' && c[1] === 'rm')), false);
});

test('持久事件序号并发安全，网络中断后补报不会重复执行', async t => {
  const { root, docker, journal } = await fixture(t); await journal.create(task());
  await Promise.all(Array.from({ length: 10 }, (_, i) => journal.emit('task-1', { stage: 'building', message: `日志 ${i}` })));
  const record = await journal.get('task-1'); assert.equal(record.seq, 10);
  const seen = [], accepted = new Set(); let disconnect = true;
  const client = { post: async (route, event) => { seen.push(event.seq); accepted.add(event.seq); if (event.seq === 3 && disconnect) { disconnect = false; throw new Error('回复前断线'); } return { ackSeq: event.seq }; } };
  const runner = new AgentRunner({ root, centerUrl: 'https://center.example', docker, client });
  await assert.rejects(runner.flushEvents(), /断线/); assert.equal((await journal.get('task-1')).ackSeq, 2);
  await runner.flushEvents(); assert.equal((await journal.get('task-1')).ackSeq, 10); assert.equal(accepted.size, 10); assert.equal(seen.filter(n => n === 3).length, 2);
  await writeJson(path.join(root, 'events', 'task-1', '0000000011.json'), { seq: 11, stage: 'verifying', status: 'succeeded', result: { release: {} } });
  await journal.repair(); assert.equal((await journal.get('task-1')).seq, 11); assert.equal((await journal.get('task-1')).status, 'succeeded');
});

test('大量积压日志以异步迭代逐条补报，不把全部输出装入内存', async t => {
  const { root, docker, journal } = await fixture(t); await journal.create(task());
  for (let index = 0; index < 120; index++) await journal.emit('task-1', { stage: 'building', message: '日'.repeat(4096) });
  const pending = journal.pending(await journal.get('task-1')); assert.equal(typeof pending[Symbol.asyncIterator], 'function');
  let expected = 1;
  const client = { post: async (_, event) => { assert.equal(event.seq, expected++); return { ackSeq: event.seq }; } };
  const runner = new AgentRunner({ root, centerUrl: 'https://center.example', docker, client }); await runner.flushEvents();
  assert.equal(expected, 121); assert.equal((await journal.get('task-1')).ackSeq, 120);
});

test('网络客户端下载仅允许当前中心任务地址并校验 SHA-256', async t => {
  const { root } = await fixture(t), content = zip([{ name: 'pom.xml', content: 'source' }]);
  const server = http.createServer((req, res) => { assert.equal(req.headers.authorization, `Bearer ${'t'.repeat(43)}`); res.end(content); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.throws(() => new CenterClient(url), /HTTPS/);
  const client = new CenterClient(url, { allowHttpTest: true, token: 't'.repeat(43) }), value = task(); value.source.sha256 = createHash('sha256').update(content).digest('hex');
  await client.download(value, path.join(root, 'good.zip'));
  await assert.rejects(client.download({ ...value, source: { ...value.source, url: 'https://other.example/api/agent/v1/tasks/task-1/source' } }, path.join(root, 'bad.zip')), /非当前中心/);
  await assert.rejects(client.download({ ...value, source: { ...value.source, sha256: '0'.repeat(64) } }, path.join(root, 'wrong.zip')), /校验失败/);
});

test('监控只读取登记目标，保持 Jenkins 管理容器只读', async t => {
  const { root, docker } = await fixture(t), monitoringIdentity = identity('observe');
  docker.containers.set('jenkins-service', { Config: { Image: 'jenkins/app:1', Labels: {} }, State: { Status: 'running', Health: { Status: 'healthy' }, StartedAt: 'yesterday' }, RestartCount: 2 });
  const monitor = new Monitor({ root, docker, procRoot: root });
  const containers = await monitor.containers(monitoringIdentity);
  assert.equal(containers[0].managed, false); assert.equal(containers[0].health, 'healthy'); assert.equal(containers[0].restartCount, 2);
  assert.deepEqual(docker.calls, [['inspect', 'container', 'jenkins-service']]);
  const metrics = await monitor.metrics(); assert.equal(metrics.cpuPercent, null); assert.ok(metrics.disk.total > 0);
});

test('Agent 身份持久化且不重复注册，接入其他中心时拒绝复用身份', async t => {
  const { root, docker } = await fixture(t), tokenFile = path.join(root, 'registration-token'); let registrations = 0;
  await writeFile(tokenFile, 'r'.repeat(43));
  const client = { register: async () => { registrations++; return identity('observe'); } };
  const runner = new AgentRunner({ root, centerUrl: 'https://center.example', registrationTokenFile: tokenFile, docker, client });
  await runner.initialize(); assert.equal(registrations, 1); await assert.rejects(readFile(tokenFile), { code: 'ENOENT' });
  await runner.close();
  const restarted = new AgentRunner({ root, centerUrl: 'https://center.example', docker, client });
  await restarted.initialize(); assert.equal(registrations, 1); assert.equal(restarted.identity.serverId, 'server-1');
  await restarted.close();
  const wrongCenter = new AgentRunner({ root, centerUrl: 'https://another.example', docker, client });
  await assert.rejects(wrongCenter.initialize(), /其他中心/);
});

test('Linux 内核锁拒绝同目录双 Agent，释放后允许重新启动', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await fixture(t); const first = await acquireAgentLock(root);
  try { await assert.rejects(acquireAgentLock(root), /已有 Agent/); } finally { await first.release(); }
  const next = await acquireAgentLock(root); assert.equal(next.held, true); await next.release();
});

test('领取任务后刷新白名单，刚创建的目标可正常部署', async t => {
  const { root, docker, client: downloadClient } = await fixture(t), currentIdentity = identity();
  const client = { download: downloadClient.download, post: async (route, body) => {
    if (route === 'claim') return { task: task('new-target-task') };
    if (route === 'heartbeat') return { mode: 'managed', targets: currentIdentity.targets };
    if (route.endsWith('/events')) return { ackSeq: body.seq };
    throw new Error('未知接口');
  } };
  const runner = new AgentRunner({ root, centerUrl: 'https://center.example', docker, client });
  runner.identity = { ...currentIdentity, targets: [] };
  await runner.tick(); assert.equal((await runner.journal.get('new-target-task')).status, 'succeeded');
});
