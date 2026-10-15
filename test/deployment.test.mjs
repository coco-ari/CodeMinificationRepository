import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { RepositoryService } from '../src/service.mjs';
import { DeploymentService, validateConfig } from '../src/deployment.mjs';
import { createApplication } from '../src/server.mjs';

const projectInput = { name: '独立验证源码', repository: 'https://gitee.com/example/demo.git', branch: 'main' };
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cmr-deploy-test-'));
  t.after(async () => { if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('cmr-deploy-test-')) throw new Error('临时目录范围错误'); await rm(root, { recursive: true, force: true }); });
  return root;
}
function builder(root) {
  return { revision: 'a'.repeat(40), content: '测试源码第一版', async initialize() { await mkdir(path.join(root, 'cache'), { recursive: true }); },
    async build() { const file = path.join(root, 'cache', 'source.zip'); const content = Buffer.from(this.content); await writeFile(file, content); return { file, revision: this.revision, commitSubject: this.commitSubject, sha256: createHash('sha256').update(content).digest('hex'), size: content.length, cached: false }; } };
}
async function fixture(t) {
  const root = await directory(t); const fake = builder(root); const repository = new RepositoryService({ directory: root, builder: fake }); await repository.initialize();
  const deployment = new DeploymentService(repository, { publicOrigin: 'https://center.example.test' }); await deployment.initialize();
  return { root, fake, repository, deployment };
}
async function targetFixture(f, serverMode = 'managed') {
  const source = await f.repository.saveProject(projectInput);
  const application = await f.deployment.saveEntity('applications', { name: '演示业务' });
  const environment = await f.deployment.saveEntity('environments', { name: '隔离测试', applicationId: application.id, sourceProjectId: source.project.id });
  const service = await f.deployment.saveEntity('services', { name: '演示服务', applicationId: application.id, module: 'demo' });
  const server = await f.deployment.createServer({ name: '验证服务器', mode: serverMode });
  const agent = await f.deployment.register({ registrationToken: server.registrationToken, version: 'test' });
  const target = await f.deployment.saveEntity('targets', { serverId: server.server.id, environmentId: environment.id, serviceId: service.id,
    mode: serverMode, ...(serverMode === 'observe' ? { containerName: 'jenkins-managed-api' } : {}), config: {} });
  return { source, application, environment, service, server, agent, target };
}
async function ready(f, targetId, action = 'deploy', extra = {}) {
  const task = await f.deployment.createTask({ targetId, action, ...extra });
  if (task.status === 'preparing') await f.deployment.preparations.get(task.id);
  return f.deployment.data.tasks.find(item => item.id === task.id);
}
function release(task) { return { id: task.id, image: `cmr/${task.targetId}:${task.id}`, revision: task.revision, config: task.config }; }

test('中心保留所有成功源码，清理保护当前版本与基线，共享包按引用释放', async t => {
  const f = await fixture(t), records = await targetFixture(f), versions = [];
  t.after(async () => { await f.deployment.close(); await f.repository.store.close(); });
  for (let i = 0; i < 7; i++) {
    f.fake.revision = String(i + 1).repeat(40); f.fake.content = i < 2 ? '共享源码' : `源码 ${i}`;
    const task = await ready(f, records.target.id); await f.deployment.claim(records.agent.serverId);
    await f.deployment.events(records.agent.serverId, task.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: release(task) } });
    versions.push(f.deployment.releases(records.target.id).find(r => r.id === task.id));
  }
  assert.equal(f.deployment.releases(records.target.id).filter(r => r.archiveStatus === 'available').length, 7);
  assert.equal(versions[0].sourceArchiveId, versions[1].sourceArchiveId);
  await assert.rejects(f.deployment.archives.clear(versions[6].id, records.application.id), /不能清理/);
  await assert.rejects(f.deployment.archives.clear(versions[5].id, records.application.id), /不能清理/);
  const sharedFile = f.deployment.archives.resolve(versions[0]).file;
  await f.deployment.archives.clear(versions[0].id, records.application.id);
  assert.equal(await readFile(sharedFile, 'utf8'), '共享源码');
  await f.deployment.archives.clear(versions[1].id, records.application.id);
  await assert.rejects(readFile(sharedFile), { code: 'ENOENT' });
  assert.equal(f.deployment.releases(records.target.id).find(r => r.id === versions[0].id).archiveStatus, 'cleared');
  assert.equal(f.deployment.releasePage(records.target.id, 0, 2).nextOffset, 2);
  assert.equal(f.deployment.releasePage(records.target.id, 6, 2).nextOffset, null);
});

test('档案回退不读取当前仓库或配置，重建产生独立版本并保留来源', async t => {
  const f = await fixture(t), records = await targetFixture(f);
  t.after(async () => { await f.deployment.close(); await f.repository.store.close(); });
  await f.deployment.heartbeat(records.agent.serverId, { capabilities: ['source-archive-recovery-v1'] });
  const first = await ready(f, records.target.id); await f.deployment.claim(records.agent.serverId);
  await f.deployment.events(records.agent.serverId, first.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: release(first) } });
  await f.deployment.heartbeat(records.agent.serverId, { capabilities: [] });
  await assert.rejects(f.deployment.createTask({ targetId: records.target.id, action: 'rollback', releaseId: first.id, requestId: randomUUID() }), /升级目标 Agent/);
  await f.deployment.heartbeat(records.agent.serverId, { capabilities: ['source-archive-recovery-v1'] });
  await f.repository.store.change(state => { state.projects[0].enabled = false; state.projects[0].branch = 'deleted'; state.deployments.services[0].module = 'new-module'; state.deployments.targets[0].config.profile = 'changed'; });
  f.fake.build = () => { throw new Error('回退不应访问远端'); };
  const rollback = await ready(f, records.target.id, 'rollback', { releaseId: first.id });
  const claimed = await f.deployment.claim(records.agent.serverId);
  assert.equal(claimed.config.module, first.config.module); assert.equal(claimed.config.profile, first.config.profile);
  assert.equal(claimed.source.sha256, first.source.sha256); assert.equal(claimed.sourceSnapshot.branch, 'main');
  assert.equal(claimed.baselineSource.archiveId, first.sourceArchiveId);
  await assert.rejects(f.deployment.archives.clear(first.id, records.application.id), /不能清理/);
  assert.throws(() => f.deployment.source('foreign-agent', rollback.id), /无权/);
  await f.deployment.events(records.agent.serverId, rollback.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { recoveryMethod: 'rebuild', release: { ...release(claimed), restoredFromReleaseId: first.id } } });
  const versions = f.deployment.releases(records.target.id);
  assert.equal(versions.length, 2); assert.equal(versions[0].restoredFromReleaseId, first.id);
  assert.equal(versions[1].image, release(first).image); assert.notEqual(versions[0].image, versions[1].image);
  const file = f.deployment.archives.resolve(versions[0]).file;
  await writeFile(file, Buffer.alloc(first.source.size, 48));
  await assert.rejects(f.deployment.archives.verify(versions[0]), /校验失败/);
  assert.equal(f.deployment.archives.status(versions[0]), 'invalid');
  await assert.rejects(f.deployment.createTask({ targetId: records.target.id, action: 'rollback', releaseId: first.id }), /档案缺失、损坏/);
});

test('历史源码迁移校验后去重，缺失源码不从远端补档，重复迁移保留版本身份', async t => {
  const f = await fixture(t), records = await targetFixture(f);
  t.after(async () => { await f.deployment.close(); await f.repository.store.close(); });
  const first = await ready(f, records.target.id); await f.deployment.claim(records.agent.serverId);
  await f.deployment.events(records.agent.serverId, first.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: release(first) } });
  const original = f.deployment.archives.resolve(first.source);
  await writeFile(path.join(f.deployment.root, 'tasks', first.id, 'source.zip'), await readFile(original.file));
  await f.repository.store.change(state => { state.deployments.sourceArchives = []; delete state.deployments.tasks[0].sourceArchiveId; delete state.deployments.tasks[0].source.archiveId; delete state.deployments.releases[0].sourceArchiveId; });
  f.fake.build = () => { throw new Error('迁移不得拉取最新代码'); };
  await f.deployment.archives.migrate();
  const archiveId = f.deployment.releases(records.target.id)[0].sourceArchiveId;
  await f.deployment.archives.migrate();
  assert.equal(f.deployment.data.sourceArchives.length, 1); assert.equal(f.deployment.releases(records.target.id)[0].sourceArchiveId, archiveId);
  await rm(original.file);
  await f.deployment.archives.migrate();
  assert.equal(f.deployment.releases(records.target.id)[0].archiveStatus, 'missing');
  assert.equal(f.deployment.data.sourceArchiveMigration.missing, 1);
});

test('提交说明固定到源码版本，忽略 Agent 伪造值并随回退恢复', async t => {
  const f = await fixture(t), records = await targetFixture(f);
  f.fake.commitSubject = '修复设备连接';
  const first = await ready(f, records.target.id);
  assert.equal(first.commitSubject, '修复设备连接');
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'deployments/tasks', first.id, 'source.json'), 'utf8')).commitSubject, first.commitSubject);
  await f.deployment.claim(records.agent.serverId);
  await f.deployment.events(records.agent.serverId, first.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: { ...release(first), commitSubject: '伪造说明' } } });
  assert.equal(f.deployment.data.targets[0].currentRelease.commitSubject, '修复设备连接');
  f.fake.revision = 'b'.repeat(40); f.fake.commitSubject = '修复登录超时';
  const second = await ready(f, records.target.id); await f.deployment.claim(records.agent.serverId);
  await f.deployment.events(records.agent.serverId, second.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: release(second) } });
  assert.equal(f.deployment.data.targets[0].currentRelease.commitSubject, '修复登录超时');
  const rollback = await ready(f, records.target.id, 'rollback', { releaseId: first.id }); await f.deployment.claim(records.agent.serverId);
  await f.deployment.events(records.agent.serverId, rollback.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: release(first) } });
  assert.equal(f.deployment.data.targets[0].currentRelease.commitSubject, '修复设备连接');
  await f.deployment.close(); await f.repository.store.close();
});

test('旧发布说明按源码快照与准确提交补齐，缓存缺失时不误用最新说明', async t => {
  const f = await fixture(t), records = await targetFixture(f);
  const first = await ready(f, records.target.id); await f.deployment.claim(records.agent.serverId);
  await f.deployment.events(records.agent.serverId, first.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: release(first) } });
  await f.repository.store.change(state => { state.projects[0].branch = 'new-branch'; });
  const taskCount = f.deployment.data.tasks.length;
  f.fake.cachedCommitSubject = async (snapshot, revision) => {
    assert.equal(snapshot.branch, 'main'); assert.equal(revision, first.revision); return null;
  };
  await f.deployment.backfillCommitSubjects();
  assert.equal(f.deployment.data.targets[0].currentRelease.commitSubject, undefined);
  f.fake.cachedCommitSubject = async (snapshot, revision) => {
    assert.equal(snapshot.branch, 'main'); assert.equal(revision, first.revision); return '历史版本的真实说明';
  };
  await f.deployment.backfillCommitSubjects();
  assert.equal(f.deployment.data.targets[0].currentRelease.commitSubject, '历史版本的真实说明');
  assert.equal(f.deployment.releases(records.target.id)[0].commitSubject, '历史版本的真实说明');
  assert.equal(f.deployment.data.tasks[0].commitSubject, '历史版本的真实说明');
  assert.equal(f.deployment.data.tasks.length, taskCount);
  await f.deployment.close(); await f.repository.store.close();
});

test('前端目标按服务类型固定配置，旧 Agent 拒绝任务，版本与回退使用静态产物引用', async t => {
  const f = await fixture(t), base = await targetFixture(f);
  const frontend = await f.deployment.saveEntity('services', { applicationId: base.application.id, name: '前端', kind: 'static', module: 'web' });
  const input = { serverId: base.server.server.id, environmentId: base.environment.id, serviceId: frontend.id, mode: 'managed', config: { kind: 'java', health: { url: 'https://app.example.com' } } };
  const target = await f.deployment.saveEntity('targets', input);
  assert.equal(target.config.kind, 'static'); assert.equal(target.config.artifactPath, 'web/dist');
  assert.equal(target.config.health.url, 'https://app.example.com/'); assert.equal(target.containerName, null);
  assert.equal(target.config.runtimeImage, undefined);
  await assert.rejects(f.deployment.createTask({ targetId: target.id, action: 'deploy' }), /升级/);
  await f.deployment.heartbeat(base.agent.serverId, { version: '1.1.0', capabilities: ['static-site-v1'], containers: [] });
  await assert.rejects(f.deployment.createTask({ targetId: target.id, action: 'restart' }), /无需重启/);
  await assert.rejects(f.deployment.saveEntity('services', { ...frontend, kind: 'java' }, frontend.id), /不能切换类型/);
  const first = await ready(f, target.id); await f.deployment.claim(base.agent.serverId);
  const artifact = { id: first.id, kind: 'static', artifact: `static/${target.id}/${first.id}`, revision: first.revision, config: first.config };
  await assert.rejects(f.deployment.events(base.agent.serverId, first.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: { ...artifact, artifact: `static/${base.target.id}/${first.id}` } } }), /不属于/);
  await f.deployment.events(base.agent.serverId, first.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: artifact } });
  assert.equal(f.deployment.releases(target.id)[0].artifact, artifact.artifact);
  const second = await ready(f, target.id); await f.deployment.claim(base.agent.serverId);
  await f.deployment.events(base.agent.serverId, second.id, { seq: 1, stage: 'verifying', status: 'rolled_back', result: { release: artifact, rollback: { status: 'succeeded', release: artifact } } });
  const rollback = await ready(f, target.id, 'rollback', { releaseId: first.id }); await f.deployment.claim(base.agent.serverId);
  await f.deployment.events(base.agent.serverId, rollback.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: artifact } });
  assert.equal(f.deployment.data.targets.find(item => item.id === target.id).currentRelease.id, first.id);
  assert.equal(base.target.currentRelease, undefined);
  const queued = await ready(f, target.id), updates = [];
  f.deployment.on('update', value => updates.push(value));
  await f.deployment.heartbeat(base.agent.serverId, { version: '1.0.0', containers: [] });
  assert.equal(await f.deployment.claim(base.agent.serverId), null);
  assert.equal(f.deployment.data.tasks.find(item => item.id === queued.id).status, 'interrupted');
  assert.ok(updates.some(value => value.type === 'task' && value.id === queued.id));
  const java = await ready(f, base.target.id);
  assert.equal((await f.deployment.claim(base.agent.serverId)).id, java.id);
  await f.deployment.close(); await f.repository.store.close();
});

test('静态站点配置拒绝目录逃逸、外部容器配置和无效站点地址', () => {
  for (const config of [{ artifactPath: '../dist' }, { artifactPath: 'node_modules/site' }, { buildScript: 'build;rm' }, { packageManager: 'other' }, { health: { url: 'file:///etc/passwd' } }, { ports: [{ hostPort: 18080, containerPort: 80 }] }, { buildArgs: ['--mode\nproduction'] }]) {
    assert.throws(() => validateConfig(config, '.', 'static'), { status: 400 });
  }
  assert.equal(validateConfig({}, '.', 'java').buildImage, 'maven:3.9.9-eclipse-temurin-8');
});

test('SQLite 迁移保留管理员、凭证、项目和密钥，事务失败不提交', async t => {
  const root = await directory(t); const key = randomBytes(32); const original = { version: 1, admin: { username: 'admin', passwordHash: 'old-hash' }, credentials: [{ id: 'credential', secret: 'encrypted' }], projects: [{ id: 'old-project', tokenHash: 'old-download-hash' }], events: [{ action: 'old' }] };
  await writeFile(path.join(root, 'state.json'), JSON.stringify(original)); await writeFile(path.join(root, 'master.key'), key);
  const store = new Store(root); await store.open(); assert.deepEqual(store.state, original); assert.deepEqual(store.key, key);
  await assert.rejects(store.change(state => { state.admin.username = '错误修改'; throw new Error('模拟失败'); }));
  await store.change(state => { state.admin.username = '新管理员'; }); await store.close();
  const restored = new Store(root); await restored.open(); assert.equal(restored.state.admin.username, '新管理员'); assert.equal(restored.state.projects[0].tokenHash, 'old-download-hash');
  const backup = (await readdir(root)).find(name => name.startsWith('migration-backup-')); assert.ok(backup);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, backup, 'state.json'), 'utf8')), original);
  assert.deepEqual(await readFile(path.join(root, backup, 'master.key')), key); await restored.close();
  await rm(path.join(root, 'master.key')); await assert.rejects(new Store(root).open(), /缺失 master.key/);
});

test('损坏的旧数据拒绝迁移，不创建空数据库', async t => {
  const root = await directory(t); await writeFile(path.join(root, 'state.json'), '{invalid'); await writeFile(path.join(root, 'master.key'), randomBytes(32));
  await assert.rejects(new Store(root).open()); assert.ok(!(await readdir(root)).includes('state.sqlite'));
});

test('一次性 Agent 注册、过期、撤销与凭据隔离', async t => {
  const f = await fixture(t); const first = await f.deployment.createServer({ name: '只读服务器' });
  const agent = await f.deployment.register({ registrationToken: first.registrationToken, version: 'test' });
  assert.equal(f.deployment.authenticate(agent.token), agent.serverId); assert.equal(agent.mode, 'managed');
  await assert.rejects(f.deployment.register({ registrationToken: first.registrationToken }), { status: 401 });
  const expired = await f.deployment.createServer({ name: '过期服务器' });
  await f.repository.store.change(state => { state.deployments.servers.find(server => server.id === expired.server.id).registrationExpiresAt = '2000-01-01T00:00:00Z'; });
  await assert.rejects(f.deployment.register({ registrationToken: expired.registrationToken }), { status: 401 });
  assert.ok(!JSON.stringify(f.deployment.overview()).includes(agent.token)); assert.ok(!JSON.stringify(f.deployment.overview()).includes('tokenHash'));
  await f.deployment.revokeServer(agent.serverId); assert.throws(() => f.deployment.authenticate(agent.token), { status: 401 });
});

test('删除已撤销服务器会清理空绑定并留审计，不删除关联资源和发布历史', async t => {
  const f = await fixture(t);
  t.after(async () => { await f.deployment.close(); await f.repository.store.close(); });
  const application = await f.deployment.saveEntity('applications', { name: '临时验收项目' });
  const created = await f.deployment.createServer({ name: '临时验收服务器', applicationId: application.id });
  const agent = await f.deployment.register({ registrationToken: created.registrationToken, version: 'test' });
  const other = await f.deployment.createServer({ name: '保留服务器' });
  const otherAgent = await f.deployment.register({ registrationToken: other.registrationToken, version: 'test' });
  await assert.rejects(f.deployment.deleteServer(agent.serverId), { status: 409 });
  await f.deployment.revokeServer(agent.serverId);
  for (const collection of ['targets', 'tasks', 'releases']) {
    await f.repository.store.change(state => { state.deployments[collection].push({ id: randomUUID(), serverId: agent.serverId, status: 'succeeded' }); });
    const before = structuredClone(f.repository.store.state);
    await assert.rejects(f.deployment.deleteServer(agent.serverId), { status: 409 });
    assert.deepEqual(f.repository.store.state, before);
    await f.repository.store.change(state => { state.deployments[collection] = []; });
  }
  const updates = []; f.deployment.on('update', value => updates.push(value));
  await f.deployment.deleteServer(agent.serverId);
  assert.ok(!f.deployment.data.servers.some(s => s.id === agent.serverId));
  assert.ok(!f.deployment.data.serverBindings.some(b => b.serverId === agent.serverId));
  assert.equal(f.deployment.data.applications[0].id, application.id);
  assert.equal(f.deployment.authenticate(otherAgent.token), otherAgent.serverId);
  assert.throws(() => f.deployment.authenticate(agent.token), { status: 401 });
  await assert.rejects(f.deployment.register({ registrationToken: created.registrationToken }), { status: 401 });
  assert.equal(f.repository.store.state.events.filter(e => e.action === 'server-delete' && e.serverId === agent.serverId).length, 1);
  assert.ok(updates.some(e => e.type === 'server' && e.id === agent.serverId));
  await assert.rejects(f.deployment.deleteServer(agent.serverId), { status: 404 });
  await f.repository.store.close();
  await f.repository.store.open();
  assert.ok(!f.deployment.data.servers.some(s => s.id === agent.serverId));
});

test('保留身份升级 Agent 后心跳更新版本，旧客户端省略版本时保持现值', async t => {
  const f = await fixture(t); const created = await f.deployment.createServer({ name: '版本验证' });
  const agent = await f.deployment.register({ registrationToken: created.registrationToken, version: '1.0.0' });
  await f.deployment.heartbeat(agent.serverId, { version: '2.0.0', containers: [] }); assert.equal(f.deployment.overview().servers[0].version, '2.0.0');
  await f.deployment.heartbeat(agent.serverId, { containers: [] }); assert.equal(f.deployment.overview().servers[0].version, '2.0.0');
});

test('默认接入即可部署，拒绝重新创建监控模式及外部容器目标', async t => {
  const f = await fixture(t); const records = await targetFixture(f);
  assert.equal(records.agent.mode, 'managed');
  await assert.rejects(f.deployment.createServer({ name: '旧模式', mode: 'observe' }), { status: 400 });
  await assert.rejects(f.deployment.saveEntity('targets', { ...records.target, mode: 'observe' }), { status: 400 });
  const task = await ready(f, records.target.id);
  assert.equal((await f.deployment.claim(records.agent.serverId)).id, task.id);
  await f.deployment.close(); await f.repository.store.close();
});

test('旧监控记录升级后停止下发并保留身份和历史，不接管外部容器', async t => {
  const f = await fixture(t); const records = await targetFixture(f);
  await f.repository.store.change(state => {
    const d=state.deployments;
    d.servers.find(s=>s.id===records.agent.serverId).mode='observe';
    Object.assign(d.targets.find(x=>x.id===records.target.id),{mode:'observe',owner:'Jenkins',containerName:'jenkins-api'});
  });
  await f.deployment.close();
  const next = new DeploymentService(f.repository); await next.initialize();
  assert.equal(next.authenticate(records.agent.token), records.agent.serverId);
  assert.equal(next.assignment(records.agent.serverId).mode, 'managed');
  assert.deepEqual(next.assignment(records.agent.serverId).targets, []);
  assert.deepEqual(next.overview().targets, []);
  const retired=next.data.targets.find(x=>x.id===records.target.id);
  assert.ok(retired.retiredAt); assert.equal(retired.containerName,'jenkins-api'); assert.equal(retired.owner,'Jenkins');
  for(const action of ['deploy','restart','rollback']) await assert.rejects(next.createTask({targetId:retired.id,action}),{status:403});
  await assert.rejects(next.saveEntity('targets',{...retired,mode:'managed'},retired.id),{status:400});
  await next.heartbeat(records.agent.serverId,{containers:[{targetId:retired.id,status:'running'}]});
  assert.deepEqual(next.overview().servers[0].containers,[]);
  const replacement=await next.saveEntity('targets',{environmentId:records.environment.id,serviceId:records.service.id,serverId:records.agent.serverId,config:{}});
  assert.equal(replacement.mode,'managed'); assert.notEqual(replacement.containerName,'jenkins-api');
  await next.close(); await f.repository.store.close();
});

test('部署配置拒绝目录逃逸、外部容器名称及跨项目目标', async t => {
  assert.throws(() => validateConfig({ artifactPath: '../outside.jar' }, '.'), { status: 400 });
  assert.throws(() => validateConfig({ buildImage: '--privileged' }, '.'), { status: 400 });
  assert.throws(() => validateConfig({ volumes: [{ name: '/var/run/docker.sock', mountPath: '/x' }] }, '.'), { status: 400 });
  const f = await fixture(t); const records = await targetFixture(f);
  await assert.rejects(f.deployment.saveEntity('targets', { ...records.target, containerName: 'jenkins-container' }, records.target.id), { status: 400 });
});

test('固定 ZIP 不随新同步改变，同服务器串行而不同服务器独立领取', async t => {
  const f = await fixture(t); const first = await targetFixture(f); const second = await targetFixture(f);
  const one = await ready(f, first.target.id); const two = await ready(f, first.target.id); const other = await ready(f, second.target.id);
  assert.equal((await f.deployment.claim(first.agent.serverId)).id, one.id); assert.equal((await f.deployment.claim(first.agent.serverId)).id, one.id);
  assert.equal((await f.deployment.claim(second.agent.serverId)).id, other.id);
  f.fake.content = '第二版'; f.fake.revision = 'b'.repeat(40); await f.repository.sync(first.source.project.id);
  assert.equal(await readFile(f.deployment.source(first.agent.serverId, one.id).file, 'utf8'), '测试源码第一版');
  assert.throws(() => f.deployment.source(second.agent.serverId, one.id), { status: 403 });
  await f.deployment.events(first.agent.serverId, one.id, { seq: 1, stage: 'failed', message: '模拟编译失败' });
  assert.equal((await f.deployment.claim(first.agent.serverId)).id, two.id);
});

test('启用部署平台后不同源码项目保持原并发额度，同项目下载仍合并', async t => {
  const root = await directory(t); let active = 0, peak = 0, calls = 0, release, both;
  const gate = new Promise(resolve => { release = resolve; }), concurrent = new Promise(resolve => { both = resolve; });
  const fake = { async initialize() { await mkdir(path.join(root, 'cache'), { recursive: true }); }, async build(project) {
    calls++; active++; peak = Math.max(peak, active); if (active === 2) both();
    try { await gate; const file = path.join(root, 'cache', `${project.id}.zip`); const content = Buffer.from(project.id); await writeFile(file, content);
      return { file, revision: 'a'.repeat(40), sha256: createHash('sha256').update(content).digest('hex'), size: content.length, cached: false };
    } finally { active--; }
  } };
  const repository = new RepositoryService({ directory: root, builder: fake, maxConcurrent: 2 }); await repository.initialize();
  const deployment = new DeploymentService(repository); await deployment.initialize();
  const first = await repository.saveProject(projectInput), second = await repository.saveProject({ ...projectInput, name: '第二源码项目' });
  const jobs = [repository.sync(first.project.id), repository.sync(first.project.id), repository.sync(second.project.id)]; let timer;
  try { await Promise.race([concurrent, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('不同项目被错误地全局串行化')), 1500); })]); }
  finally { clearTimeout(timer); release(); await Promise.allSettled(jobs); }
  assert.equal(peak, 2); assert.equal(calls, 2);
  assert.equal((await jobs[0]).file, (await jobs[1]).file); await deployment.close();
});

test('某项目固定 ZIP 写入等待时不会阻塞其他项目的 Jenkins 同步', async t => {
  const f = await fixture(t); const records = await targetFixture(f); const other = await f.repository.saveProject({ ...projectInput, name: '另一个 Jenkins 源码项目' });
  const original = f.deployment.copyArchive.bind(f.deployment); let release, copying;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { copying = resolve; });
  f.deployment.copyArchive = async (...args) => { copying(); await gate; return original(...args); };
  const task = await f.deployment.createTask({ targetId: records.target.id, action: 'deploy' }); await started; let timer;
  try { const archive = await Promise.race([f.repository.sync(other.project.id), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('无关项目受到固定 ZIP 锁阻塞')), 1500); })]); assert.equal(archive.revision, 'a'.repeat(40)); }
  finally { clearTimeout(timer); release(); await f.deployment.preparations.get(task.id); }
  assert.equal(f.deployment.data.tasks.find(item => item.id === task.id).status, 'queued');
});

test('日志有序持久化、断线补传幂等，中心重启保持已领取任务', async t => {
  const f = await fixture(t); const records = await targetFixture(f); const task = await ready(f, records.target.id); await f.deployment.claim(records.agent.serverId);
  assert.deepEqual(await f.deployment.events(records.agent.serverId, task.id, { seq: 1, stage: 'building', message: '开始编译' }), { ackSeq: 1 });
  assert.deepEqual(await f.deployment.events(records.agent.serverId, task.id, { seq: 1, stage: 'building', message: '重复请求' }), { ackSeq: 1 });
  await assert.rejects(f.deployment.events(records.agent.serverId, task.id, { seq: 3, stage: 'building' }), { status: 409 });
  await f.deployment.close(); await f.repository.store.close();
  const repository = new RepositoryService({ directory: f.root, builder: builder(f.root) }); await repository.initialize(); const deployment = new DeploymentService(repository); await deployment.initialize();
  assert.equal(deployment.authenticate(records.agent.token), records.agent.serverId); assert.equal((await deployment.claim(records.agent.serverId)).id, task.id);
  await deployment.events(records.agent.serverId, task.id, { seq: 2, stage: 'interrupted', message: 'Agent 重启识别编译中断' });
  const detail = await deployment.taskDetails(task.id); assert.equal(detail.logs.length, 2); assert.equal(detail.logs[0].message, '开始编译'); assert.equal(detail.task.status, 'interrupted');
  assert.equal((await deployment.taskDetails(task.id, 1)).logs.length, 1);
});

test('离线积压日志补报保留发生时间和实际阶段耗时，另存接收时间', async t => {
  const f = await fixture(t); const records = await targetFixture(f); const task = await ready(f, records.target.id); await f.deployment.claim(records.agent.serverId);
  const began = Date.now() - 300000; const time = seconds => new Date(began + seconds * 1000).toISOString();
  // 模拟中心在五分钟前分配任务，Agent 断线完成工作后一次性补报。
  await f.repository.store.change(state => {
    const current = state.deployments.tasks.find(item => item.id === task.id);
    current.startedAt = time(0); current.createdAt = time(-5); current.stageHistory = [{ stage: 'queued', startedAt: time(-5) }];
  });
  const events = [
    { seq: 1, stage: 'downloading', timestamp: time(0) },
    { seq: 2, stage: 'building', timestamp: time(10) },
    { seq: 3, stage: 'deploying', timestamp: time(100) },
    { seq: 4, stage: 'verifying', timestamp: time(130) },
    { seq: 5, stage: 'verifying', status: 'succeeded', timestamp: time(150), result: { release: release(task) } },
  ];
  for (const event of events) await f.deployment.events(records.agent.serverId, task.id, event);
  const detail = await f.deployment.taskDetails(task.id);
  assert.deepEqual(detail.logs.map(log => log.at), events.map(event => event.timestamp));
  assert.ok(detail.logs.every(log => Date.parse(log.receivedAt) >= began + 300000));
  assert.deepEqual(detail.task.stageHistory.map(stage => [stage.stage, stage.durationMs]), [['queued', 5000], ['downloading', 10000], ['building', 90000], ['deploying', 30000], ['verifying', 20000]]);
  assert.equal(detail.task.finishedAt, time(150)); assert.ok(Date.parse(detail.task.resultReceivedAt) >= began + 300000);
  const originalReceivedAt = detail.logs[4].receivedAt;
  await f.deployment.events(records.agent.serverId, task.id, events[4]); assert.equal((await f.deployment.taskDetails(task.id)).logs[4].receivedAt, originalReceivedAt);
});

test('轻微时钟差与乱序日期不阻断日志，发生时间单调且阶段耗时不为负', async t => {
  const f = await fixture(t); const records = await targetFixture(f); const task = await ready(f, records.target.id); await f.deployment.claim(records.agent.serverId);
  const assigned = Date.now() - 300000; const timestamp = offset => new Date(assigned + offset).toISOString();
  await f.repository.store.change(state => {
    const current = state.deployments.tasks.find(item => item.id === task.id); current.startedAt = timestamp(0); current.createdAt = timestamp(-1000); current.stageHistory = [{ stage: 'queued', startedAt: timestamp(-1000) }];
  });
  await f.deployment.events(records.agent.serverId, task.id, { seq: 1, stage: 'downloading', timestamp: timestamp(-60000) });
  await f.deployment.events(records.agent.serverId, task.id, { seq: 2, stage: 'building', timestamp: timestamp(-50000) });
  await f.deployment.events(records.agent.serverId, task.id, { seq: 3, stage: 'building', timestamp: timestamp(-90000) });
  await assert.rejects(f.deployment.events(records.agent.serverId, task.id, { seq: 4, stage: 'building', timestamp: '不是时间' }), { status: 400 });
  await f.deployment.events(records.agent.serverId, task.id, { seq: 4, stage: 'verifying', timestamp: '2099-01-01T00:00:00.000Z' });
  await f.deployment.events(records.agent.serverId, task.id, { seq: 5, stage: 'failed', message: '旧客户端无时间字段' });
  const detail = await f.deployment.taskDetails(task.id);
  assert.equal(detail.task.agentClockOffsetMs, 60000); assert.equal(detail.task.stageHistory.find(stage => stage.stage === 'downloading').durationMs, 10000);
  assert.equal(detail.logs[2].at, detail.logs[1].at); assert.ok(detail.logs[2].timeAdjusted);
  assert.ok(Date.parse(detail.logs[3].at) <= Date.parse(detail.logs[3].receivedAt));
  assert.equal(detail.logs[4].agentTimestamp, undefined); assert.ok(detail.task.stageHistory.every(stage => stage.durationMs >= 0));
});

test('成功版本、失败回退和手动回退具有独立结果且保留来源', async t => {
  const f = await fixture(t); const records = await targetFixture(f); const first = await ready(f, records.target.id); await f.deployment.claim(records.agent.serverId);
  await f.deployment.events(records.agent.serverId, first.id, { seq: 1, stage: 'succeeded', result: { release: release(first) } });
  const second = await ready(f, records.target.id); const claimed = await f.deployment.claim(records.agent.serverId); assert.equal(claimed.previousRelease.id, first.id);
  await f.deployment.events(records.agent.serverId, second.id, { seq: 1, stage: 'rolled_back', message: '健康检查失败，已回退', result: { rollback: { status: 'succeeded', release: release(first) } } });
  assert.equal(f.deployment.overview().targets[0].currentRelease.id, first.id); assert.equal(f.deployment.releases(records.target.id).length, 1);
  const rollback = await ready(f, records.target.id, 'rollback', { releaseId: first.id }); await f.deployment.claim(records.agent.serverId);
  await f.deployment.events(records.agent.serverId, rollback.id, { seq: 1, stage: 'succeeded', result: { release: release(first) } });
  assert.equal(f.deployment.overview().targets[0].currentRelease.id, first.id);
  await assert.rejects(f.deployment.events(records.agent.serverId, rollback.id, { seq: 2, stage: 'building' }), { status: 409 });
});

test('心跳过期只标记失联，不把最后业务健康状态误报为停止', async t => {
  const f = await fixture(t); const records = await targetFixture(f);
  await f.deployment.heartbeat(records.agent.serverId, { containers: [{ targetId: records.target.id, status: 'running', health: 'healthy' }] });
  assert.equal(f.deployment.overview().servers[0].online, true);
  await f.repository.store.change(state => { state.deployments.servers[0].lastSeenAt = new Date(Date.now() - 61000).toISOString(); });
  const overview = f.deployment.overview(); assert.equal(overview.servers[0].online, false); assert.equal(overview.targets[0].observation.health, 'healthy'); assert.ok(overview.targets[0].lastObservedAt);
});

test('固定源码失败封闭阶段并允许下一任务领取，过期源码按保留规则清理', async t => {
  const f = await fixture(t); const records = await targetFixture(f); const build = f.repository.builder.build;
  f.repository.builder.build = async () => { throw new Error('模拟远端故障'); };
  const failure = await ready(f, records.target.id); assert.equal(failure.status, 'failed'); assert.ok(failure.stageHistory[0].finishedAt);
  f.repository.builder.build = build;
  const task = await ready(f, records.target.id); await f.deployment.claim(records.agent.serverId);
  await f.deployment.events(records.agent.serverId, task.id, { seq: 1, stage: 'downloading', message: '开始下载' });
  await f.deployment.events(records.agent.serverId, task.id, { seq: 2, stage: 'building', message: '开始编译' });
  await f.deployment.events(records.agent.serverId, task.id, { seq: 3, stage: 'building', status: 'failed', message: '编译失败' });
  const detail = await f.deployment.taskDetails(task.id); assert.deepEqual(detail.task.stageHistory.map(stage => stage.stage), ['preparing', 'queued', 'downloading', 'building']);
  assert.ok(detail.task.stageHistory.every(stage => typeof stage.durationMs === 'number'));
  const archived = f.deployment.source(records.agent.serverId, task.id);
  assert.equal(await readFile(archived.file, 'utf8'), f.fake.content);
  await f.repository.store.change(state => {
    state.deployments.tasks.find(item => item.id === task.id).finishedAt = '2020-01-01T00:00:00Z';
    state.deployments.sourceArchives.find(item => item.id === archived.archiveId).createdAt = '2020-01-01T00:00:00Z';
  });
  await f.deployment.cleanupSources();
  assert.throws(() => f.deployment.source(records.agent.serverId, task.id), { status: 410 });
  await assert.rejects(readFile(path.join(f.root, 'deployments', 'tasks', task.id, 'source.zip')), { code: 'ENOENT' });
  assert.equal(detail.logs.length, 3);
});

test('Agent 源码大小限制提前报错，不破坏现有 Jenkins 源码同步', async t => {
  const root = await directory(t); const fake = builder(root); const original = fake.build.bind(fake);
  fake.build = async () => ({ ...await original(), size: 65 * 1024 * 1024 });
  const repository = new RepositoryService({ directory: root, builder: fake }); await repository.initialize(); const deployment = new DeploymentService(repository); await deployment.initialize();
  const f = { root, repository, deployment }; const records = await targetFixture(f); const task = await ready(f, records.target.id);
  assert.equal(task.status, 'failed'); assert.match(task.error, /64 MiB/);
  assert.equal((await repository.sync(records.source.project.id)).size, 65 * 1024 * 1024);
  assert.equal(repository.overview().projects[0].status, 'ready');
});

test('HTTP 管理接口沿用登录与 CSRF，Agent 来源文件严格隔离', async t => {
  const root = await directory(t); const app = await createApplication({ directory: root, builder: builder(root), secureCookies: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, method = 'GET', value, headers = {}) => fetch(base + route, { method, headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(value ? { body: JSON.stringify(value) } : {}) });
  assert.equal((await request('/api/deploy/overview')).status, 401);
  const response = await request('/api/setup', 'POST', { bootstrapToken: app.service.bootstrapToken, username: 'admin', password: 'isolated-admin-test' });
  const auth = { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await response.json()).csrf };
  assert.equal((await request('/api/deploy/servers', 'POST', { name: '测试服务器' }, { Cookie: auth.Cookie })).status, 403);
  assert.equal((await request('/api/deploy/servers', 'POST', { name: '测试服务器' }, auth)).status, 201);
  const temporary = await app.deployment.createServer({ name: '可删除服务器' });
  const removePath = `/api/deploy/servers/${temporary.server.id}`;
  assert.equal((await request(removePath, 'DELETE')).status, 401);
  assert.equal((await request(removePath, 'DELETE', null, { Cookie: auth.Cookie })).status, 403);
  assert.equal((await request(removePath, 'DELETE', null, auth)).status, 409);
  await app.deployment.revokeServer(temporary.server.id);
  assert.equal((await request(removePath, 'DELETE', null, auth)).status, 200);
  assert.equal((await request(removePath, 'DELETE', null, auth)).status, 404);
  const f = { repository: app.service, deployment: app.deployment }; const first = await targetFixture(f); const other = await targetFixture(f); const task = await ready(f, first.target.id); await app.deployment.claim(first.agent.serverId);
  const observer = await targetFixture(f);
  assert.equal((await request(`/api/deploy/servers/${observer.agent.serverId}/mode`, 'PUT', { mode: 'managed' }, { Cookie: auth.Cookie })).status, 403);
  assert.equal((await request(`/api/deploy/servers/${observer.agent.serverId}/mode`, 'PUT', { mode: 'managed' }, auth)).status, 404);
  assert.equal(app.deployment.data.targets.find(item => item.id === observer.target.id).mode, 'managed');
  const own = await request(`/api/agent/v1/tasks/${task.id}/source`, 'GET', null, { Authorization: `Bearer ${first.agent.token}` }); assert.equal(own.status, 200); assert.equal(await own.text(), '测试源码第一版');
  assert.equal((await request(`/api/agent/v1/tasks/${task.id}/source`, 'GET', null, { Authorization: `Bearer ${other.agent.token}` })).status, 403);
  assert.equal((await request('/api/deploy/overview', 'GET', null, { Authorization: `Bearer ${first.agent.token}` })).status, 401);
  assert.equal((await request('/api/agent/v1/heartbeat', 'POST', { metrics: {} }, auth)).status, 401);
});
