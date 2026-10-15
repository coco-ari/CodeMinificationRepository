import { fakeOwnership } from './fake-ownership.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, readlink } from 'node:fs/promises';
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
import { checkStaticResponse } from '../agent/static-deployment.mjs';
import { copyStaticSite } from '../agent/static-site.mjs';

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
  async inspect(name, kind = 'container') { this.calls.push(['inspect', kind, name]); if (kind === 'image' && /^(maven:|node:|eclipse-temurin:|sha256:)/.test(name)) return { Id: `sha256:${'c'.repeat(64)}` }; return (kind === 'container' ? this.containers : kind === 'image' ? this.images : this.other).get(name) || null; }
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
  fakeOwnership(executor);
  return { root, docker, journal, client, executor, identity: currentIdentity };
}

async function staticFixture(t) {
  const f = await fixture(t), publicRoot = `${f.root}-static`;
  await mkdir(publicRoot, { mode: 0o755 }); await writeFile(path.join(publicRoot, '.cmr-static-root'), publicRoot);
  t.after(() => rm(publicRoot, { recursive: true, force: true }));
  const server = http.createServer(async (request, response) => {
    try {
      const parts = new URL(request.url, 'http://localhost').pathname.split('/').filter(Boolean);
      const body = await readFile(path.join(publicRoot, parts[0], 'current', parts.slice(1).join('/') || 'index.html'));
      response.writeHead(200); response.end(body);
    } catch { response.writeHead(404); response.end('missing'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/target-1/`;
  const staticConfig = normalizeConfig({ kind: 'static', module: 'web', health: { url, timeoutSeconds: 10, intervalSeconds: 2, bodyIncludes: 'ready' } });
  const archive = zip([{ name: 'web/package.json', content: '{"scripts":{"build":"vite build"}}' }, { name: 'web/package-lock.json', content: '{}' }]);
  f.client.download = async (_, file) => writeFile(file, archive);
  const run = f.docker.run.bind(f.docker);
  f.docker.run = async (args, options) => {
    if (args.includes('/cmr/static-build.mjs')) {
      if (f.docker.failStaticBuild) throw new Error('前端编译失败');
      const mount = args.find(value => value.includes('dst=/workspace')), source = mount.match(/src=(.*?),dst=/)[1];
      await mkdir(path.join(source, 'web', 'dist'), { recursive: true });
      await writeFile(path.join(source, 'web', 'dist', 'index.html'), '<html>ready</html>');
    }
    return run(args, options);
  };
  return { ...f, publicRoot, url, staticConfig, staticTask: (id, extra = {}) => task(id, { config: staticConfig, ...extra }) };
}

test('前端通过共用站点目录发布、单独回退，不创建或重启 Web 容器', async t => {
  const f = await staticFixture(t), shared = { Config: { Image: 'nginx:existing', Labels: {} } };
  f.docker.containers.set('shared-nginx', shared);
  await f.executor.execute(f.staticTask('static-1'));
  assert.equal((await f.journal.get('static-1')).status, 'succeeded');
  const first = (await f.journal.get('static-1')).result.release;
  assert.equal(await readlink(path.join(f.publicRoot, 'target-1', 'current')), 'releases/static-1');
  await checkStaticResponse(first);
  const count = f.docker.calls.length; await f.executor.execute(f.staticTask('static-1')); assert.equal(f.docker.calls.length, count);
  await f.executor.execute(f.staticTask('static-2'));
  assert.equal((await f.journal.get('static-2')).status, 'succeeded');
  await f.executor.execute(f.staticTask('static-rollback', { action: 'rollback', release: first }));
  assert.equal((await f.journal.get('static-rollback')).status, 'succeeded');
  assert.equal((await f.executor.current(f.staticTask('unused'))).id, first.id);
  assert.equal(f.docker.containers.get('shared-nginx'), shared);
  assert.equal(f.docker.calls.some(args => ['compose', 'build', 'restart'].includes(args[0])), false);
  for (const args of f.docker.calls.filter(args => args[0] === 'run')) {
    assert.equal(args.filter((_, index) => args[index - 1] === '--mount').some(value => value.includes('docker.sock') || value.includes(f.publicRoot)), false);
    assert.equal(args[args.indexOf('--workdir') + 1], '/workspace/web');
    assert.ok(args.includes('1000:1000'));
  }
  const monitoring = await new Monitor({ docker: f.docker, root: f.root }).containers({ ...f.identity, targets: [{ ...f.identity.targets[0], config: f.staticConfig }] });
  assert.equal(monitoring[0].health, 'healthy'); assert.equal(monitoring[0].containerName, null);
});

test('前端构建失败保留当前站点，验证失败恢复旧版本，首次失败不留下当前指针', async t => {
  const f = await staticFixture(t);
  await f.executor.execute(f.staticTask('baseline'));
  f.docker.failStaticBuild = true;
  await f.executor.execute(f.staticTask('build-failed'));
  assert.equal((await f.journal.get('build-failed')).status, 'failed');
  assert.equal(await readlink(path.join(f.publicRoot, 'target-1', 'current')), 'releases/baseline');
  f.docker.failStaticBuild = false;
  const health = f.executor.static.health.bind(f.executor.static);
  f.executor.static.health = (task, release) => release.id.startsWith('bad-') ? Promise.reject(new Error('模拟站点验证失败')) : health(task, release);
  await f.executor.execute(f.staticTask('bad-health'));
  assert.equal((await f.journal.get('bad-health')).status, 'rolled_back');
  assert.equal(await readlink(path.join(f.publicRoot, 'target-1', 'current')), 'releases/baseline');
  f.identity.targets.push({ id: 'target-2', serverId: 'server-1', mode: 'managed' });
  await f.executor.execute(f.staticTask('bad-first', { targetId: 'target-2' }));
  assert.equal((await f.journal.get('bad-first')).status, 'failed');
  await assert.rejects(readlink(path.join(f.publicRoot, 'target-2', 'current')), { code: 'ENOENT' });
  assert.equal(await readlink(path.join(f.publicRoot, 'target-1', 'current')), 'releases/baseline');
});

test('前端任务恢复核对版本，不重复构建；目录归属和仅观察模式仍生效', async t => {
  const f = await staticFixture(t), value = f.staticTask('recover-static');
  await f.executor.static.preflight(value);
  await f.journal.create(value);
  const release = await f.executor.static.build(value, f.staticConfig);
  await f.executor.static.activate(value, release);
  await f.journal.update(value.id, { stage: 'deploying', release, previousRelease: null });
  const before = f.docker.calls.filter(args => args[0] === 'run').length;
  await f.executor.recover(await f.journal.get(value.id));
  assert.equal((await f.journal.get(value.id)).status, 'succeeded');
  assert.equal(f.docker.calls.filter(args => args[0] === 'run').length, before);
  await writeJson(path.join(f.publicRoot, 'target-1', '.cmr-owner.json'), { serverId: 'another-server', targetId: 'target-1' });
  await f.executor.execute(f.staticTask('foreign-site'));
  assert.equal((await f.journal.get('foreign-site')).status, 'failed');
  assert.equal(f.docker.calls.filter(args => args[0] === 'run').length, before);
  f.identity.mode = 'observe';
  await f.executor.execute(f.staticTask('observed-static'));
  assert.equal((await f.journal.get('observed-static')).status, 'failed');
});

test('静态产物拒绝源码目录和符号链接，HTTP 200 也必须对应本次发布标识', async t => {
  const { root } = await fixture(t), source = path.join(root, 'source'), output = path.join(source, 'dist');
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'index.html'), 'ready');
  await symlink('/etc/passwd', path.join(output, 'outside.txt'));
  await assert.rejects(copyStaticSite(source, 'dist', path.join(root, 'copy')), /符号链接/);
  await rm(path.join(output, 'outside.txt')); await writeFile(path.join(output, 'package.json'), '{}');
  await assert.rejects(copyStaticSite(source, 'dist', path.join(root, 'copy')), /源码目录/);
  const release = { id: 'expected', config: { kind: 'static', health: { url: 'https://example.com/' } } };
  await assert.rejects(checkStaticResponse(release, { fetchFn: async () => new Response('old-version') }), /本次发布版本/);
  assert.throws(() => normalizeConfig({ kind: 'static', artifactPath: '../dist', health: { url: 'https://example.com' } }));
});

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
  const phases = []; for await (const event of journal.pending(await journal.get('task-1'))) phases.push(event.stage);
  assert.ok(phases.indexOf('image') > phases.indexOf('building')); assert.ok(phases.indexOf('deploying') > phases.indexOf('image'));
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

test('Java 历史镜像清理后使用原源码和历史配置重建，不覆盖原版本记录', async t => {
  const f = await fixture(t);
  await f.executor.execute(task('original'));
  const original = (await f.journal.get('original')).result.release;
  await f.executor.execute(task('current', { config: config({ profile: 'changed' }) }));
  f.docker.images.delete(original.image);
  const restore = task('rebuild', { action: 'rollback', release: original, config: original.config, recoveryAllowed: true, source: { ...task().source, archiveId: 'archive-old' } });
  await f.executor.execute(restore);
  const result = await f.journal.get(restore.id);
  assert.equal(result.status, 'succeeded', result.result?.error);
  assert.equal(result.result.release.restoredFromReleaseId, original.id);
  assert.equal(result.result.release.config.profile, original.config.profile);
  assert.equal(result.result.recoveryMethod, 'rebuild');
  assert.equal((await readJson(path.join(f.root, 'targets', 'target-1', 'releases', 'original.json'))).image, original.image);
  assert.notEqual(result.result.release.image, original.image);
  const count = f.docker.calls.length; await f.executor.execute(restore); assert.equal(f.docker.calls.length, count);
});

test('Java 回退重建失败不切换，健康失败恢复当前版本，缺失基线先重建并保护', async t => {
  const f = await fixture(t);
  await f.executor.execute(task('original')); const original = (await f.journal.get('original')).result.release;
  await f.executor.execute(task('current')); const current = (await f.journal.get('current')).result.release;
  f.docker.images.delete(original.image);
  const restore = id => task(id, { action: 'rollback', release: original, config: original.config, recoveryAllowed: true, source: { ...task().source, archiveId: 'archive-old' } });
  const download = f.client.download; f.client.download = async () => { throw new Error('原源码校验失败'); };
  const before = f.docker.calls.filter(c => c[0] === 'compose').length;
  await f.executor.execute(restore('bad-source'));
  assert.equal((await f.journal.get('bad-source')).status, 'failed'); assert.equal(f.docker.calls.filter(c => c[0] === 'compose').length, before);
  f.client.download = download; f.docker.unhealthyTask = 'bad-health';
  await f.executor.execute(restore('bad-health'));
  assert.equal((await f.journal.get('bad-health')).status, 'rolled_back'); assert.equal((await f.executor.current(task())).id, current.id);
  f.docker.images.delete(current.image);
  const guarded = { ...restore('good-with-baseline'), baselineReleaseId: 'prepared-baseline', baselineSource: { ...task().source, archiveId: 'archive-current', url: '/api/agent/v1/tasks/good-with-baseline/source?role=baseline' } };
  await f.executor.execute(guarded);
  const finished = await f.journal.get(guarded.id);
  assert.equal(finished.status, 'succeeded', finished.result?.error);
  assert.equal(finished.result.baseline.restoredFromReleaseId, current.id);
  assert.ok(f.docker.images.has('cmr/target-1:prepared-baseline'));
});

test('静态历史产物删除后从中心源码重建，恢复失败保留原页面', async t => {
  const f = await staticFixture(t);
  await f.executor.execute(f.staticTask('original')); const original = (await f.journal.get('original')).result.release;
  assert.ok(original, (await f.journal.get('original')).result?.error);
  await f.executor.execute(f.staticTask('current'));
  await rm(f.executor.static.releasePath(f.staticTask('unused'), original.id), { recursive: true });
  const restore = id => f.staticTask(id, { action: 'rollback', release: original, recoveryAllowed: true, source: { ...task().source, archiveId: 'archive-old' } });
  f.docker.failStaticBuild = true; await f.executor.execute(restore('build-failed'));
  assert.equal((await f.journal.get('build-failed')).status, 'failed');
  assert.equal(await f.executor.static.selected(restore('unused')), 'current');
  f.docker.failStaticBuild = false; await f.executor.execute(restore('rebuilt'));
  const completed = await f.journal.get('rebuilt');
  assert.equal(completed.status, 'succeeded', completed.result?.error);
  assert.equal(completed.result.release.restoredFromReleaseId, original.id);
  assert.equal(await f.executor.static.selected(restore('unused')), 'rebuilt');
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

test('不再采集旧外部目标，只采集平台目标和主机资源', async t => {
  const { root, docker } = await fixture(t), monitoringIdentity = identity('observe');
  docker.containers.set('jenkins-service', { Config: { Image: 'jenkins/app:1', Labels: {} }, State: { Status: 'running', Health: { Status: 'healthy' }, StartedAt: 'yesterday' }, RestartCount: 2 });
  const monitor = new Monitor({ root, docker, procRoot: root });
  const containers = await monitor.containers(monitoringIdentity);
  assert.deepEqual(containers, []); assert.deepEqual(docker.calls, []);
  const ownedIdentity=identity();
  docker.containers.set('cmr-target-1', { Config: { Image: 'cmr/app:1', Labels: labels('server-1','target-1') }, State: { Status: 'running', Health: { Status: 'healthy' } }, RestartCount: 2 });
  const owned=await monitor.containers(ownedIdentity);
  assert.equal(owned[0].managed,true);assert.equal(owned[0].health,'healthy');
  const metrics = await monitor.metrics(); assert.equal(metrics.cpuPercent, null); assert.ok(metrics.disk.total > 0);
});

test('Agent 身份持久化且不重复注册，接入其他中心时拒绝复用身份', async t => {
  const { root, docker } = await fixture(t), tokenFile = path.join(root, 'registration-token'); let registrations = 0;
  await writeFile(tokenFile, 'r'.repeat(43));
  const client = { register: async () => { registrations++; return identity(); } };
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
  fakeOwnership(runner.executor); runner.identity = { ...currentIdentity, targets: [] };
  await runner.tick(); assert.equal((await runner.journal.get('new-target-task')).status, 'succeeded');
});


test('心跳上报上一成功请求的实测往返耗时，首次和失败时不伪造延迟', async t => {
  const {root,docker}=await fixture(t); const reports=[];
  const runner=new AgentRunner({root,centerUrl:'https://center.example',docker,client:{post:async(route,body)=>{reports.push(structuredClone(body));return {mode:'managed',targets:[]}}}});
  runner.identity=identity(); runner.monitor={metrics:async()=>({cpuPercent:1}),containers:async()=>[]};
  await runner.heartbeat(); await runner.heartbeat();
  assert.equal(reports[0].metrics.centerRttMs,undefined);assert.ok(Number.isFinite(reports[1].metrics.centerRttMs));assert.ok(reports[1].metrics.centerRttMs>=0);
});
