import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplication } from '../src/server.mjs';
import { migrateWorkspaces } from '../src/workspaces.mjs';
import { ArchiveBuilder, sourceKey } from '../src/archive.mjs';

const execute = promisify(execFile);
const repositoryInput = { name: '订单源码', repository: 'https://gitee.com/example/orders.git', branch: 'main', enabled: true };
async function fixture(t, http = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cmr-workspace-'));
  const builder = { calls: [], histories: [], async initialize() {}, async history(source) { this.histories.push(source.branch); return { commits: [], refreshedAt: null }; }, async build(source) {
    this.calls.push(structuredClone(source)); if (this.gate) await this.gate;
    const content = JSON.stringify([source.repository, source.branch]);
    const file = path.join(directory, sourceKey(source).replace(':', '-') + '.zip'); await writeFile(file, content);
    return { file, revision: createHash('sha1').update(content).digest('hex'), sha256: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content), cached: false };
  } };
  const app = await createApplication({ directory, builder, publicOrigin: 'https://center.example', secureCookies: false });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const result = { ...app, directory, builder };
  if (http) {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    result.url = `http://127.0.0.1:${app.server.address().port}`;
    const setup = await fetch(`${result.url}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrapToken: app.service.bootstrapToken, username: 'admin', password: 'workspace-test-password' }) });
    const session = await setup.json(); result.cookie = setup.headers.get('set-cookie').split(';')[0]; result.csrf = session.csrf;
    result.request = async (route, method = 'GET', body) => {
      const response = await fetch(`${result.url}${route}`, { method, headers: { cookie: result.cookie, 'x-csrf-token': result.csrf, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, value: await response.json() };
    };
  }
  return result;
}
async function project(f, name, server) {
  const app = await f.workspaces.create({ name });
  const source = await f.service.saveProject({ ...repositoryInput, applicationId: app.id });
  const service = await f.workspaces.saveEntity(app.id, 'services', { name: '订单服务', module: '.' });
  const environments = f.workspaces.overview(app.id).environments;
  for (const env of environments) await f.workspaces.saveSource(app.id, { environmentId: env.id, serviceId: service.id, sourceProjectId: source.project.id, branch: env.name === '测试' ? 'develop' : 'main' });
  if (!server) server = (await f.deployment.createServer({ name: '共享服务器', mode: 'managed', applicationId: app.id })).server;
  else await f.workspaces.bind(app.id, server.id);
  const targets = [];
  for (const env of environments) targets.push(await f.workspaces.saveEntity(app.id, 'targets', { environmentId: env.id, serviceId: service.id, serverId: server.id, mode: 'managed', config: {} }));
  return { app, source, service, environments, server, targets };
}
async function ready(f, target) { const task = await f.deployment.createTask({ targetId: target.id, action: 'deploy' }); await f.deployment.preparations.get(task.id); return f.deployment.data.tasks.find(item => item.id === task.id); }

test('共享服务器的项目归属、环境源码、目标、日志与版本接口隔离', async t => {
  const f = await fixture(t, true), a = await project(f, '商城'), b = await project(f, '办公', a.server);
  const base = `/api/workspaces/${a.app.id}`;
  for (const route of [`/tasks/${(await ready(f, b.targets[0])).id}`, `/targets/${b.targets[0].id}/releases`]) assert.equal((await f.request(base + route)).status, 404);
  for (const [route, method, body] of [
    [`/repositories/${b.source.project.id}/sync`, 'POST', {}], [`/repositories/${b.source.project.id}/rotate-token`, 'POST', {}],
    [`/repositories/${b.source.project.id}`, 'PUT', repositoryInput], ['/tasks', 'POST', { targetId: b.targets[0].id, action: 'deploy' }],
    ['/environment-sources', 'PUT', { environmentId: a.environments[0].id, serviceId: a.service.id, sourceProjectId: b.source.project.id, branch: 'main' }],
    ['/targets', 'POST', { environmentId: b.environments[0].id, serviceId: a.service.id, serverId: a.server.id, mode: 'managed' }],
  ]) assert.equal((await f.request(base + route, method, body)).status, 404, route);
  await f.deployment.heartbeat(a.server.id, { activeTaskId: f.deployment.data.tasks[0].id, containers: [{ targetId: a.targets[0].id }, { targetId: b.targets[0].id }], metrics: { cpuPercent: 12 } });
  const overview = (await f.request(base)).value;
  assert.equal(overview.repositories.length, 1); assert.equal(overview.tasks.length, 0);
  assert.equal(overview.servers[0].containers.length, 1); assert.equal(overview.servers[0].activeTaskId, null);
  assert.ok(!JSON.stringify(overview).includes(b.source.project.id));
  assert.equal((await f.request(base + `/servers/${a.server.id}`, 'DELETE', {})).status, 409);
  const unbound = await f.deployment.createServer({ name: '待绑定', mode: 'managed' });
  assert.equal((await f.request(base + '/targets', 'POST', { environmentId: a.environments[0].id, serviceId: a.service.id, serverId: unbound.server.id, mode: 'managed' })).status, 400);
  assert.equal((await f.request(base + `/servers/${unbound.server.id}`, 'PUT', {})).status, 200);
  assert.equal((await f.request(base + `/servers/${unbound.server.id}`, 'DELETE', {})).status, 200);
  assert.equal(f.deployment.data.servers.find(item => item.id === unbound.server.id).revoked, false);
  const installed = await f.request(base + '/servers', 'POST', { name: '项目内接入' });
  const agent = await f.deployment.register({ registrationToken: installed.value.registrationToken, version: 'test' });
  assert.ok(f.workspaces.overview(a.app.id).servers.some(item => item.id === agent.serverId));
  assert.ok(!f.workspaces.overview(b.app.id).servers.some(item => item.id === agent.serverId));
});

test('默认下载与测试生产分支并发，发布任务固定源码选择和运行配置', async t => {
  const f = await fixture(t), a = await project(f, '分支验证');
  let unlock; f.builder.gate = new Promise(resolve => { unlock = resolve; });
  const first = await f.deployment.createTask({ targetId: a.targets[0].id, action: 'deploy' });
  const second = await f.deployment.createTask({ targetId: a.targets[1].id, action: 'deploy' });
  const download = f.service.sync(a.source.project.id);
  await f.workspaces.saveSource(a.app.id, { environmentId: a.environments[0].id, serviceId: a.service.id, sourceProjectId: a.source.project.id, branch: 'future' });
  unlock(); await Promise.all([download, ...f.deployment.preparations.values()]);
  assert.deepEqual(f.builder.calls.map(item => item.branch).sort(), ['develop', 'main']);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'deployments/tasks', first.id, 'source.zip'), 'utf8'))[1], 'develop');
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'deployments/tasks', second.id, 'source.zip'), 'utf8'))[1], 'main');
  assert.equal(f.service.store.state.projects.find(item => item.id === a.source.project.id).branch, 'main');
  assert.equal(first.sourceSnapshot.branch, 'develop'); assert.deepEqual(first.config, a.targets[0].config);
  const changed = await ready(f, a.targets[0]); assert.equal(changed.sourceSnapshot.branch, 'future');
});

test('同服务器跨项目串行，另一个服务不随单服务发布而更新；项目任务先筛选后限量', async t => {
  const f = await fixture(t), a = await project(f, '商城'), b = await project(f, '办公', a.server);
  const first = await ready(f, a.targets[0]), second = await ready(f, b.targets[0]);
  assert.equal((await f.deployment.claim(a.server.id)).id, first.id);
  assert.equal((await f.deployment.claim(a.server.id)).id, first.id);
  await f.deployment.events(a.server.id, first.id, { seq: 1, stage: 'failed', message: '测试终止' });
  assert.equal((await f.deployment.claim(a.server.id)).id, second.id);
  assert.equal(a.targets[1].currentRelease, undefined);
  await f.service.store.change(state => { for (let i = 0; i < 205; i++) state.deployments.tasks.push({ ...second, id: randomUUID(), status: 'failed' }); });
  assert.equal(f.workspaces.overview(a.app.id).tasks[0].id, first.id);
  assert.equal(f.workspaces.overview(b.app.id).tasks.length, 200);
});

test('旧共享仓库迁移保留下载、身份、目标、未完成快照，重复启动不复制数据', async t => {
  const f = await fixture(t);
  const solo = await f.service.saveProject({ ...repositoryInput, name: '独占' });
  const shared = await f.service.saveProject({ ...repositoryInput, name: '共用' });
  const orphan = await f.service.saveProject({ ...repositoryInput, name: '独立下载' });
  const a = randomUUID(), b = randomUUID(), serverId = randomUUID(), serviceId = randomUUID(), targetId = randomUUID(), taskId = randomUUID();
  await f.service.store.change(state => {
    const d = state.deployments; d.version = 1; delete d.workspaceVersion;
    d.applications = [{ id: a, name: 'A' }, { id: b, name: 'B' }];
    d.environments = [{ id: randomUUID(), applicationId: a, name: '独占环境', sourceProjectId: solo.project.id }, { id: randomUUID(), applicationId: a, name: '共用环境', sourceProjectId: shared.project.id }, { id: randomUUID(), applicationId: b, name: '生产', sourceProjectId: shared.project.id }];
    d.services = [{ id: serviceId, applicationId: a, name: '服务', module: '.' }, { id: randomUUID(), applicationId: b, name: '服务', module: '.' }];
    d.servers = [{ id: serverId, name: '原服务器', tokenHash: 'original-agent-hash', mode: 'managed' }];
    d.targets = [{ id: targetId, applicationId: a, environmentId: d.environments[1].id, serviceId, serverId, mode: 'managed', containerName: `cmr-${targetId}` }];
    d.tasks = [{ id: taskId, targetId, applicationId: a, serverId, sourceProjectId: shared.project.id, status: 'queued', lastSeq: 1 }];
  });
  await migrateWorkspaces(f.service.store, f.directory);
  const d = f.deployment.data;
  assert.equal(f.service.authorizeDownload(shared.project.id, shared.token).id, shared.project.id);
  assert.equal(f.service.authorizeDownload(orphan.project.id, orphan.token).id, orphan.project.id);
  assert.equal(f.service.authorizeDownload(solo.project.id, solo.token).applicationId, a);
  assert.equal(d.tasks[0].sourceSnapshot.id, shared.project.id); assert.equal(d.tasks[0].lastSeq, 1);
  assert.equal(d.targets[0].id, targetId); assert.equal(d.servers[0].tokenHash, 'original-agent-hash');
  const copied = f.service.store.state.projects.filter(item => item.needsDownloadTokenReset);
  assert.equal(copied.length, 2); assert.notEqual(copied[0].tokenHash, copied[1].tokenHash);
  assert.ok(d.environmentSources.every(item => f.service.store.state.projects.find(source => source.id === item.sourceProjectId).applicationId === item.applicationId));
  const before = JSON.stringify(f.service.store.state); await migrateWorkspaces(f.service.store, f.directory); assert.equal(JSON.stringify(f.service.store.state), before);
  assert.equal((await readdir(f.directory)).filter(item => item.startsWith('workspace-backup-')).length, 1);
});

test('真实 Git 的不同分支拥有独立缓存，并发打包不污染默认分支', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cmr-workspace-git-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execute('git', args, { cwd: directory });
  await git('init', '-b', 'main'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', '测试');
  await writeFile(path.join(directory, 'branch.txt'), 'main'); await git('add', '.'); await git('commit', '-m', '测试主分支');
  await git('checkout', '-b', 'develop'); await writeFile(path.join(directory, 'branch.txt'), 'develop'); await git('commit', '-am', '测试开发分支');
  const builder = new ArchiveBuilder(path.join(directory, 'cache'), { allowLocal: true }); await builder.initialize();
  const source = { id: randomUUID(), repository: directory, branch: 'main' };
  const [main, dev] = await Promise.all([builder.build(source), builder.build({ ...source, branch: 'develop' })]);
  assert.notEqual(main.revision, dev.revision); assert.notEqual(path.dirname(main.file), path.dirname(dev.file));
  assert.equal((await execute('unzip', ['-p', main.file, 'branch.txt'])).stdout, 'main');
  assert.equal((await execute('unzip', ['-p', dev.file, 'branch.txt'])).stdout, 'develop');
  assert.equal((await builder.build(source)).cached, true);
});

test('项目 SSE 过滤其他项目，退出登录关闭连接', async t => {
  const f = await fixture(t, true), a = await project(f, 'A'), b = await project(f, 'B');
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${f.url}/api/workspaces/${a.app.id}/events`, { headers: { cookie: f.cookie }, signal: controller.signal });
  const reader = response.body.getReader(); await reader.read();
  f.deployment.changed('repository', b.source.project.id, b.app.id);
  f.deployment.changed('repository', a.source.project.id, a.app.id);
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.ok(event.includes(a.source.project.id)); assert.ok(!event.includes(b.source.project.id));
  await f.request('/api/logout', 'POST', {}); assert.equal((await reader.read()).done, true);
});


test('单项目多仓库单独发布一个服务，另一服务的目标和当前版本不变', async t => {
  const f = await fixture(t), a = await project(f, '多服务项目');
  const secondSource = await f.service.saveProject({ ...repositoryInput, applicationId: a.app.id, name: '支付源码', repository: 'https://gitee.com/example/payments.git' });
  const secondService = await f.workspaces.saveEntity(a.app.id, 'services', { name: '支付服务', module: '.' });
  await f.workspaces.saveSource(a.app.id, { environmentId: a.environments[0].id, serviceId: secondService.id, sourceProjectId: secondSource.project.id, branch: 'payment-test' });
  const secondTarget = await f.workspaces.saveEntity(a.app.id, 'targets', { environmentId: a.environments[0].id, serviceId: secondService.id, serverId: a.server.id, mode: 'managed' });
  const before = structuredClone(f.deployment.data.targets.find(item => item.id === secondTarget.id));
  const orderTask = await ready(f, a.targets[0]);
  assert.equal(orderTask.sourceSnapshot.repository, repositoryInput.repository); assert.equal(orderTask.sourceSnapshot.branch, 'develop');
  assert.deepEqual(f.deployment.data.targets.find(item => item.id === secondTarget.id), before);
  assert.equal(f.deployment.data.tasks.filter(item => item.targetId === secondTarget.id).length, 0);
  const paymentTask = await ready(f, secondTarget);
  assert.equal(paymentTask.sourceSnapshot.repository, secondSource.project.repository); assert.equal(paymentTask.sourceSnapshot.branch, 'payment-test');
});

test('迁移引用损坏时事务回滚；未知迁移版本和缺失集合拒绝启动', async t => {
  const f = await fixture(t);
  await f.service.store.change(state => { state.deployments.version = 1; delete state.deployments.workspaceVersion; state.deployments.environments.push({ id: randomUUID(), applicationId: randomUUID(), sourceProjectId: randomUUID() }); });
  const original = JSON.stringify(f.service.store.state);
  await assert.rejects(migrateWorkspaces(f.service.store, f.directory), /旧环境源码不存在/);
  assert.equal(JSON.stringify(f.service.store.state), original);
  await f.service.store.change(state => { state.deployments.workspaceVersion = 99; });
  await assert.rejects(migrateWorkspaces(f.service.store, f.directory), /不支持/);
  await f.service.store.change(state => { state.deployments.workspaceVersion = 1; delete state.deployments.serverBindings; });
  await assert.rejects(migrateWorkspaces(f.service.store, f.directory), /数据损坏/);
});

test('真实 Git 提交刷新、指定历史提交、并发快照与旧下载分支互不污染', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cmr-commits-'));
  const gitRoot = path.join(directory, 'git');
  const { mkdir } = await import('node:fs/promises'); await mkdir(gitRoot);
  const git = (...args) => execute('git', args, { cwd: gitRoot });
  await git('init', '-b', 'main'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', '测试作者');
  const commits = [];
  for (const content of ['第一版', '第二版', '第三版']) {
    await writeFile(path.join(gitRoot, 'version.txt'), content); await git('add', '.'); await git('commit', '-m', content);
    commits.push((await git('rev-parse', 'HEAD')).stdout.trim());
  }
  await git('branch', 'develop');
  const builder = new ArchiveBuilder(path.join(directory, 'cache'), { allowLocal: true });
  const f = await createApplication({ directory: path.join(directory, 'data'), builder, secureCookies: false });
  t.after(async () => { await f.close(); await rm(directory, { recursive: true, force: true }); });
  const a = await project(f, '真实提交'); const b = await project(f, '其他项目', a.server);
  await f.service.store.change(state => { state.projects.find(r => r.id === a.source.project.id).repository = gitRoot; });
  const empty = await f.workspaces.targetSource(a.app.id, a.targets[0].id); assert.equal(empty.commits.length, 0);
  const history = await f.workspaces.targetSource(a.app.id, a.targets[0].id, true);
  assert.deepEqual(history.commits.map(c => c.revision), commits.toReversed());
  assert.equal(history.commits[0].subject, '第三版');
  await assert.rejects(f.workspaces.targetSource(b.app.id, a.targets[0].id, true), /当前项目/);
  await assert.rejects(f.deployment.createTask({targetId:a.targets[0].id,action:'deploy',revision:'--upload-pack=bad'}), /完整的 Git commit/);
  await assert.rejects(f.deployment.createTask({targetId:a.targets[0].id,action:'deploy',revision:'f'.repeat(40)}), /提交记录已变化/);
  await assert.rejects(f.deployment.createTask({targetId:a.targets[0].id,action:'deploy',revision:commits[0],sourceKey:'wrong'}), /源码配置已变化/);
  const first = await f.deployment.createTask({ targetId:a.targets[0].id, action:'deploy', revision:commits[0], sourceKey:history.sourceKey });
  const second = await f.deployment.createTask({ targetId:a.targets[0].id, action:'deploy', revision:commits[1], sourceKey:history.sourceKey });
  const latest = f.service.sync(a.source.project.id);
  await Promise.all([latest, ...f.deployment.preparations.values()]);
  const firstTask=f.deployment.data.tasks.find(t=>t.id===first.id), secondTask=f.deployment.data.tasks.find(t=>t.id===second.id);
  assert.equal(firstTask.revision, commits[0]); assert.equal(secondTask.revision, commits[1]);
  for (const [task, content] of [[firstTask,'第一版'],[secondTask,'第二版']]) {
    assert.equal((await execute('unzip',['-p',path.join(f.deployment.root,'tasks',task.id,'source.zip'),'version.txt'])).stdout, content);
    for (const phase of ['source_fetch','source_resolve','source_archive']) assert.ok(task.stageHistory.some(s=>s.stage===phase && Number.isFinite(s.durationMs)));
  }
  const download = await latest;
  assert.equal(download.revision, commits[2]);
  assert.equal(f.service.store.state.projects.find(r=>r.id===a.source.project.id).lastSuccess.revision,commits[2]);
  assert.equal(f.service.store.state.projects.find(r=>r.id===a.source.project.id).branch,'main');
  await f.workspaces.saveSource(a.app.id,{environmentId:a.environments[0].id,serviceId:a.service.id,sourceProjectId:a.source.project.id,branch:'main'});
  await assert.rejects(f.deployment.createTask({targetId:a.targets[0].id,action:'deploy',sourceKey:history.sourceKey}), /源码配置已变化/);
});

test('首页卡片数据只包含本项目服务和绑定服务器，排除密钥与完整运行参数', async t => {
  const f=await fixture(t), a=await project(f,'项目 A'), b=await project(f,'项目 B',a.server);
  await f.deployment.heartbeat(a.server.id,{containers:[{targetId:a.targets[0].id,status:'running',health:'healthy'},{targetId:b.targets[0].id,status:'running'}],metrics:{cpuPercent:20}});
  const dashboard=f.workspaces.list().find(p=>p.id===a.app.id).dashboard;
  assert.equal(dashboard.services.length,1); assert.equal(dashboard.targets.length,2);
  assert.equal(dashboard.servers.length,1); assert.equal(dashboard.servers[0].metrics.cpuPercent,20);
  const json=JSON.stringify(dashboard);
  assert.ok(!json.includes(b.service.id)); assert.ok(!json.includes(b.targets[0].id));
  assert.ok(!json.includes('tokenHash')); assert.ok(!json.includes('registrationHash')); assert.ok(!json.includes('jvmArgs'));
});

test('提交刷新与发布同步共用并发队列，按队列再缓存锁的顺序执行', async t => {
  const f=await fixture(t), a=await project(f,'并发刷新'); f.service.queue.limit=1;
  let unlock; f.builder.gate=new Promise(resolve=>{unlock=resolve});
  const source=f.service.store.state.projects.find(s=>s.id===a.source.project.id);
  const first=f.service.sync(source.id);
  while(!f.builder.calls.length) await new Promise(resolve=>setTimeout(resolve,2));
  const history=f.workspaces.targetSource(a.app.id,a.targets[1].id,true);
  const second=f.service.sync(source.id,{...source,revision:'a'.repeat(40)});
  await new Promise(resolve=>setTimeout(resolve,5)); unlock();
  const results=await Promise.race([
    Promise.all([first,history,second]),
    new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('提交刷新与发布同步死锁')),2000);timer.unref()})
  ]);
  assert.equal(results.length,3);assert.deepEqual(f.builder.histories,['main']);assert.equal(f.builder.calls.length,2);
});
