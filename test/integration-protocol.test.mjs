import { fakeOwnership } from './fake-ownership.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApplication } from '../src/server.mjs';
import { AgentRunner } from '../agent/runner.mjs';
import { crc32 } from '../agent/archive.mjs';

function sourceZip() {
  const name = Buffer.from('pom.xml'), content = Buffer.from('<project><modelVersion>4.0.0</modelVersion></project>');
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc32(content), 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, end]);
}

class ProtocolDocker {
  constructor() { this.calls = []; this.containers = new Map(); this.images = new Map(); this.other = new Map(); this.unhealthyTask = null; this.beforeMaven = null; this.failCompile = false; }
  async inspect(name, kind = 'container') { this.calls.push(['inspect', kind, name]); if (kind === 'image' && /^(maven:|eclipse-temurin:|sha256:)/.test(name)) return { Id: `sha256:${'c'.repeat(64)}` }; return (kind === 'container' ? this.containers : kind === 'image' ? this.images : this.other).get(name) || null; }
  async run(args, options = {}) {
    this.calls.push([...args]);
    if (args[0] === 'history') return { code: 0, output: JSON.stringify({ CreatedBy: 'RUN install java runtime' }) + '\n' };
    if (args[0] === 'run') {
      const mount = args.filter((_, index) => args[index - 1] === '--mount').find(value => value.includes('dst=/workspace'));
      const source = mount.match(/src=(.*?),dst=/)[1];
      if (args.includes('mvn')) {
        if (this.beforeMaven) await this.beforeMaven();
        if (this.failCompile) throw new Error('模拟 Maven 编译失败');
        await mkdir(path.join(source, 'target')); await writeFile(path.join(source, 'target', 'demo.jar'), Buffer.alloc(64));
      }
      if (args.includes('javac')) await writeFile(path.join(source, 'HealthProbe.class'), Buffer.alloc(16));
      await options.onOutput?.('测试构建输出\n');
    }
    if (args[0] === 'build') {
      const labels = Object.fromEntries(args.filter((_, index) => args[index - 1] === '--label').map(value => { const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)]; }));
      this.images.set(args[args.indexOf('-t') + 1], { Config: { Labels: labels } });
    }
    if (args[0] === 'compose' && args.includes('up')) {
      const compose = JSON.parse(await readFile(args[args.indexOf('-f') + 1], 'utf8')), app = compose.services.app;
      const bad = app.image.endsWith(`:${this.unhealthyTask}`);
      this.containers.set(app.container_name, { Id: app.image, Config: { Image: app.image, Labels: app.labels }, State: { Running: !bad, Status: bad ? 'exited' : 'running', Health: { Status: bad ? 'unhealthy' : 'healthy' }, StartedAt: new Date().toISOString() }, RestartCount: 0 });
      await options.onOutput?.('测试容器已更新\n');
    }
    if (args[0] === 'restart') this.containers.get(args.at(-1)).RestartCount++;
    if (args[0] === 'rm') this.containers.delete(args.at(-1));
    if (args[0] === 'image' && args[1] === 'rm') this.images.delete(args[2]);
    return { code: 0, output: '' };
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cmr-protocol-test-')); const centerRoot = path.join(root, 'center'); const apps = [];
  const fixture = { root, centerRoot, apps, runners: [], docker: new ProtocolDocker(), revision: 'a'.repeat(40) };
  fixture.start = async (port = 0) => {
    const archive = sourceZip();
    const builder = { async initialize() { await mkdir(path.join(centerRoot, 'cache'), { recursive: true }); }, async build() {
      const file = path.join(centerRoot, 'cache', 'source.zip'); await writeFile(file, archive);
      return { file, revision: fixture.revision, sha256: createHash('sha256').update(archive).digest('hex'), size: archive.length, cached: false };
    } };
    const app = await createApplication({ directory: centerRoot, builder, secureCookies: false });
    await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve)); apps.push(app); fixture.app = app; fixture.port = app.server.address().port; fixture.url = `http://127.0.0.1:${fixture.port}`;
    return app;
  };
  fixture.stop = async () => { await fixture.app.close(); };
  fixture.request = async (route, method = 'GET', value, auth = fixture.auth || {}) => {
    const response = await fetch(fixture.url + route, { method, headers: { ...auth, ...(value ? { 'content-type': 'application/json' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) });
    const result = await response.json(); assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`); return result;
  };
  fixture.login = async (setup = false) => {
    const response = await fetch(fixture.url + (setup ? '/api/setup' : '/api/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'protocol-test-admin', ...(setup ? { bootstrapToken: fixture.app.service.bootstrapToken } : {}) }) });
    assert.equal(response.status, 200); fixture.auth = { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await response.json()).csrf };
  };
  fixture.agent = async (name, mode = 'managed') => {
    const registration = await fixture.request('/api/deploy/servers', 'POST', { name, mode });
    const runner = new AgentRunner({ root: path.join(root, name), centerUrl: fixture.url, registrationToken: registration.registrationToken, allowHttpTest: true, docker: fixture.docker, procRoot: root, logger: { warn() {} } });
    fixture.runners.push(runner); fakeOwnership(runner.executor); await runner.initialize(); return runner;
  };
  fixture.target = async (runner, suffix = '') => {
    const application = await fixture.request('/api/deploy/applications', 'POST', { name: `演示项目${suffix}` });
    const source = await fixture.request('/api/projects', 'POST', { name: `演示源码${suffix}`, repository: 'https://gitee.com/example/demo.git', branch: 'main', applicationId: application.id });
    const environment = await fixture.request('/api/deploy/environments', 'POST', { name: '隔离验证', applicationId: application.id, sourceProjectId: source.project.id });
    const service = await fixture.request('/api/deploy/services', 'POST', { name: 'Java 演示', applicationId: application.id, module: '.' });
    const target = await fixture.request('/api/deploy/targets', 'POST', { environmentId: environment.id, serviceId: service.id, serverId: runner.identity.serverId, mode: runner.identity.mode,
      ...(runner.identity.mode === 'observe' ? { containerName: 'jenkins-service' } : {}), config: { artifactPath: 'target/demo.jar', profile: '', health: { path: '/health', port: 8080, timeoutSeconds: 10, intervalSeconds: 2 } } });
    await runner.heartbeat(); return target;
  };
  fixture.task = async (target, action = 'deploy', extra = {}) => {
    const { task } = await fixture.request('/api/deploy/tasks', 'POST', { targetId: target.id, action, ...extra });
    if (task.status === 'preparing') await fixture.app.deployment.preparations.get(task.id);
    return (await fixture.request(`/api/deploy/tasks/${task.id}`)).task;
  };
  t.after(async () => {
    for (const runner of fixture.runners) await runner.close();
    for (const app of apps) await app.close();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('cmr-protocol-test-')) throw new Error('临时目录范围错误'); await rm(root, { recursive: true, force: true });
  });
  await fixture.start(); await fixture.login(true); return fixture;
}

test('真实 HTTP 中心与 Agent 注册、下载、发布、日志补报、失败回退和手动回退贯通', async t => {
  const f = await fixture(t); const runner = await f.agent('agent-one'); const target = await f.target(runner);
  const jenkins = { Id: 'jenkins-unchanged', State: { StartedAt: 'original' }, RestartCount: 0 }; f.docker.containers.set('jenkins-service', jenkins);
  const first = await f.task(target); await runner.tick();
  let detail = await f.request(`/api/deploy/tasks/${first.id}`); assert.equal(detail.task.status, 'succeeded'); assert.ok(detail.logs.some(log => log.stage === 'building')); assert.equal(detail.task.lastSeq, (await runner.journal.get(first.id)).seq);
  await runner.heartbeat(); assert.equal(f.app.deployment.overview().targets[0].observation.health, 'healthy');
  f.revision = 'b'.repeat(40); const second = await f.task(target); await runner.tick(); assert.equal((await f.request(`/api/deploy/tasks/${second.id}`)).task.status, 'succeeded');
  const bad = await f.task(target); f.docker.unhealthyTask = bad.id; await runner.tick();
  detail = await f.request(`/api/deploy/tasks/${bad.id}`); assert.equal(detail.task.status, 'rolled_back'); assert.equal(detail.task.result.rollback.release.id, second.id);
  const rollback = await f.task(target, 'rollback', { releaseId: first.id }); await runner.tick(); assert.equal((await f.request(`/api/deploy/tasks/${rollback.id}`)).task.status, 'succeeded');
  const restart = await f.task(target, 'restart'); await runner.tick(); assert.equal((await f.request(`/api/deploy/tasks/${restart.id}`)).task.status, 'succeeded');
  assert.equal(f.app.deployment.overview().targets[0].currentRelease.id, first.id); assert.equal(f.docker.containers.get('jenkins-service'), jenkins);
  const before = f.docker.calls.length; await runner.executor.execute(first); await runner.flushEvents(); assert.equal(f.docker.calls.length, before);
});

test('中心真实断网与重启期间 Agent 继续已领取部署，重连只补日志不重复发布', async t => {
  const f = await fixture(t); const runner = await f.agent('agent-offline'); const target = await f.target(runner); const task = await f.task(target); const port = f.port;
  f.docker.beforeMaven = async () => { f.docker.beforeMaven = null; await f.stop(); };
  await assert.rejects(runner.tick(), /fetch failed|ECONNREFUSED/);
  const local = await runner.journal.get(task.id); assert.equal(local.status, 'succeeded'); assert.equal(local.ackSeq, 0); assert.ok(local.seq > 0);
  const deployedCount = f.docker.calls.filter(call => call[0] === 'compose' && call.includes('up')).length; assert.equal(deployedCount, 1);
  await f.start(port); await f.login();
  assert.equal((await f.request(`/api/deploy/tasks/${task.id}`)).task.status, 'running');
  await runner.heartbeat(); await runner.flushEvents();
  const restored = await f.request(`/api/deploy/tasks/${task.id}`); assert.equal(restored.task.status, 'succeeded'); assert.equal(restored.logs.length, local.seq);
  await runner.flushEvents(); assert.equal(f.docker.calls.filter(call => call[0] === 'compose' && call.includes('up')).length, deployedCount);
  const identity = JSON.parse(await readFile(path.join(runner.root, 'identity.json'), 'utf8')); assert.equal(identity.token, runner.identity.token);
});

test('两个真实 HTTP Agent 只能领取自己的任务，空节点不操作其他容器', async t => {
  const f = await fixture(t); const one = await f.agent('agent-a'); const two = await f.agent('agent-b'); const observer = await f.agent('agent-idle');
  const first = await f.target(one, '甲'); const second = await f.target(two, '乙');
  const taskA = await f.task(first); const taskB = await f.task(second);
  const claimed = (await one.client.post('claim')).task; assert.equal(claimed.id, taskA.id);
  const invalid = await fetch(`${f.url}/api/agent/v1/tasks/${taskA.id}/source`, { headers: { authorization: `Bearer ${two.identity.token}` } }); assert.equal(invalid.status, 403);
  const invalidHead = await fetch(`${f.url}/api/agent/v1/tasks/${taskA.id}/source`, { method: 'HEAD', headers: { authorization: `Bearer ${two.identity.token}` } }); assert.equal(invalidHead.status, 403);
  const validHead = await fetch(`${f.url}/api/agent/v1/tasks/${taskA.id}/source`, { method: 'HEAD', headers: { authorization: `Bearer ${one.identity.token}` } });
  assert.equal(validHead.status, 200); assert.equal(validHead.headers.get('x-archive-sha256'), claimed.source.sha256); assert.equal(await validHead.text(), '');
  await Promise.all([one.tick(), two.tick()]);
  assert.equal((await f.request(`/api/deploy/tasks/${taskA.id}`)).task.status, 'succeeded'); assert.equal((await f.request(`/api/deploy/tasks/${taskB.id}`)).task.status, 'succeeded');
  assert.equal((await observer.client.post('claim')).task,null);
  const calls=f.docker.calls.length;await observer.heartbeat();assert.deepEqual(f.docker.calls.slice(calls),[]);
});

test('Agent 实例重建后中断编译明确失败，已更新容器只核验不重复发布', async t => {
  const f = await fixture(t); let runner = await f.agent('agent-restart'); const target = await f.target(runner);
  const first = await f.task(target); await runner.tick();
  const second = await f.task(target); const claimed = (await runner.client.post('claim')).task; assert.equal(claimed.id, second.id);
  await runner.journal.create(claimed); await runner.journal.emit(claimed.id, { stage: 'building', message: '模拟进程停止前最后日志' });
  const createRestored = async () => {
    await runner.close();
    const restored = new AgentRunner({ root: runner.root, centerUrl: f.url, allowHttpTest: true, docker: f.docker, procRoot: f.root, logger: { warn() {} } });
    f.runners.push(restored); fakeOwnership(restored.executor); await restored.initialize(); await restored.heartbeat(); return restored;
  };
  const before = f.docker.calls.filter(call => call[0] === 'compose' && call.includes('up')).length;
  runner = await createRestored(); await runner.recover(); await runner.flushEvents();
  assert.equal((await f.request(`/api/deploy/tasks/${second.id}`)).task.status, 'interrupted');
  assert.equal(f.docker.calls.filter(call => call[0] === 'compose' && call.includes('up')).length, before);
  assert.equal(f.app.deployment.overview().targets[0].currentRelease.id, first.id);
  const third = await f.task(target); const publishing = (await runner.client.post('claim')).task; assert.equal(publishing.id, third.id);
  await runner.journal.create(publishing); const previous = await runner.executor.current(publishing);
  const release = await runner.executor.build(publishing, publishing.config); await runner.journal.update(publishing.id, { release, previousRelease: previous });
  await runner.executor.activate(publishing, release); await runner.journal.emit(publishing.id, { stage: 'verifying', message: '模拟容器更新后进程停止' });
  const deployed = f.docker.calls.filter(call => call[0] === 'compose' && call.includes('up')).length;
  runner = await createRestored(); await runner.recover(); await runner.flushEvents();
  assert.equal((await f.request(`/api/deploy/tasks/${third.id}`)).task.status, 'succeeded');
  assert.equal(f.docker.calls.filter(call => call[0] === 'compose' && call.includes('up')).length, deployed);
  assert.equal(f.app.deployment.overview().targets[0].currentRelease.id, third.id);
});
