import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { RepositoryService } from '../src/service.mjs';
import { DeploymentService } from '../src/deployment.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const revision = 'a'.repeat(40);
async function fixture(t, kind = 'static') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cmr-workspace-deploy-'));
  const instances = [];
  let remoteCalls = 0;
  async function open() {
    const refuseRemote = async () => { remoteCalls++; throw new Error('工作区发布不得访问源码仓库'); };
    const repository = new RepositoryService({ directory: root, builder: { initialize: async () => {}, build: refuseRemote, history: refuseRemote, cachedCommitSubject: refuseRemote } });
    await repository.initialize();
    const deployment = new DeploymentService(repository); await deployment.initialize();
    const instance = { repository, deployment }; instances.push(instance); return instance;
  }
  const initial = await open();
  t.after(async () => {
    for (const instance of instances) { await instance.deployment.close(); await instance.repository.store.close(); }
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('cmr-workspace-deploy-')) throw new Error('临时目录范围错误');
    await rm(root, { recursive: true, force: true });
  });
  const { deployment } = initial;
  const application = await deployment.saveEntity('applications', { name: '工作区发布验证' });
  const environment = await deployment.saveEntity('environments', { applicationId: application.id, name: '隔离测试' });
  const service = await deployment.saveEntity('services', { applicationId: application.id, name: kind === 'static' ? '前端' : '后端', kind, module: '.' });
  const created = await deployment.createServer({ name: '临时服务记录', applicationId: application.id }), server = created.server;
  // 仅在临时 Store 调用接入协议，不启动或连接服务器。
  const agent = await deployment.register({ registrationToken: created.registrationToken, version: 'test', capabilities: ['static-site-v1', 'source-archive-recovery-v1'] });
  const target = await deployment.saveEntity('targets', { environmentId: environment.id, serviceId: service.id, serverId: server.id, config: kind === 'static' ? { health: { url: 'https://site.invalid/' } } : {} });
  const bytes = Buffer.from('固定工作区源码包，仅验证归档身份，解压由 Agent 验证');
  const file = path.join(root, 'selected-workspace.zip'); await writeFile(file, bytes);
  const archive = { file, sha256: hash(bytes), size: bytes.length, revision, commitSubject: '工作区固定版本' };
  const sourceIdentity = { projectId: 'p-workspace-test', sourceVersionId: randomUUID(), packageId: randomUUID(), service: kind === 'static' ? 'frontend' : 'backend', contentHash: hash('工作区文件树'), repositories: [{ path: '.', commit: revision }] };
  const input = { targetId: target.id, requestId: randomUUID(), configKey: deployment.configKey(target.id), actor: { id: 'u-manager', displayName: '内部管理者' }, sourceIdentity };
  return { root, ...initial, application, environment, service, server, target, archive, bytes, input, agent,
    remoteCalls: () => remoteCalls, reopen: open };
}
const successful = task => ({ id: task.id, kind: 'static', artifact: `static/${task.targetId}/${task.id}`, revision: task.revision });

test('工作区固定包不依赖源码仓库，输入文件变化不影响任务档案', async t => {
  const f = await fixture(t), task = await f.deployment.createTaskFromArchive(f.input, f.archive);
  assert.equal(task.status, 'queued'); assert.equal(task.sourceKind, 'workspace-package');
  assert.equal(f.repository.store.state.projects.length, 0);
  assert.deepEqual(task.sourceIdentity, f.input.sourceIdentity); assert.deepEqual(task.actor, f.input.actor);
  assert.equal(task.sourceSnapshot, null); assert.equal(task.source.sha256, f.archive.sha256);
  await writeFile(f.archive.file, '调用方后续更新或删除的包'); await rm(f.archive.file);
  assert.equal((await f.deployment.claim(f.server.id)).id, task.id);
  const source = f.deployment.source(f.server.id, task.id);
  assert.deepEqual(await readFile(source.file), f.bytes);
  assert.notEqual(source.file, f.archive.file); assert.equal(f.remoteCalls(), 0);
  const origin = f.deployment.archives.record(task.sourceArchiveId).origins[0];
  assert.equal(origin.sourceKind, 'workspace-package'); assert.deepEqual(origin.sourceIdentity, task.sourceIdentity);
});

test('工作区发布严格幂等，并发重复不建新任务，不同来源或操作人冲突', async t => {
  const f = await fixture(t);
  const tasks = await Promise.all([f.deployment.createTaskFromArchive(f.input, f.archive), f.deployment.createTaskFromArchive(structuredClone(f.input), f.archive)]);
  assert.equal(tasks[0].id, tasks[1].id); assert.equal(f.deployment.data.tasks.length, 1); assert.equal(f.deployment.data.sourceArchives.length, 1);
  for (const input of [
    { ...f.input, sourceIdentity: { ...f.input.sourceIdentity, packageId: randomUUID() } },
    { ...f.input, sourceIdentity: { ...f.input.sourceIdentity, contentHash: 'b'.repeat(64) } },
    { ...f.input, actor: { id: 'different-user' } },
    { ...f.input, configKey: 'c'.repeat(64) },
  ]) await assert.rejects(f.deployment.createTaskFromArchive(input, f.archive), { status: 409 });
  await assert.rejects(f.deployment.createTaskFromArchive(f.input, { ...f.archive, sha256: 'd'.repeat(64) }), { status: 409 });
  const renamed = await f.deployment.createTaskFromArchive({ ...f.input, actor: { ...f.input.actor, displayName: '新名称' } }, f.archive);
  assert.equal(renamed.id, tasks[0].id); assert.equal(renamed.actor.displayName, '内部管理者');
});

test('工作区包校验、服务类型、绑定与配置变化在提交前拒绝', async t => {
  const f = await fixture(t);
  const attempts = [
    [f.input, { ...f.archive, sha256: 'b'.repeat(64) }, 409],
    [f.input, { ...f.archive, size: f.archive.size + 1 }, 409],
    [f.input, { ...f.archive, size: 64 * 1024 * 1024 + 1 }, 413],
    [{ ...f.input, configKey: 'c'.repeat(64) }, f.archive, 409],
    [{ ...f.input, requestId: undefined }, f.archive, 400],
    [{ ...f.input, action: 'rollback' }, f.archive, 400],
    [{ ...f.input, sourceIdentity: { ...f.input.sourceIdentity, service: 'backend' } }, f.archive, 400],
    [{ ...f.input, sourceIdentity: { ...f.input.sourceIdentity, repositories: [{ path: '../private', commit: revision }] } }, f.archive, 400],
  ];
  for (const [input, archive, status] of attempts) await assert.rejects(f.deployment.createTaskFromArchive(input, archive), { status });
  const link = path.join(f.root, 'linked.zip'); await symlink(f.archive.file, link);
  await assert.rejects(f.deployment.createTaskFromArchive(f.input, { ...f.archive, file: link }), { status: 400 });
  await f.repository.store.change(state => { state.deployments.serverBindings = []; });
  await assert.rejects(f.deployment.createTaskFromArchive(f.input, f.archive), { status: 400 });
  assert.equal(f.deployment.data.tasks.length, 0); assert.equal(f.deployment.data.sourceArchives.length, 0); assert.equal(f.remoteCalls(), 0);
});

test('来源与配置使用创建快照，成功版本及原回退流程保留工作区身份', async t => {
  const f = await fixture(t), expectedIdentity = structuredClone(f.input.sourceIdentity), expectedActor = structuredClone(f.input.actor);
  const task = await f.deployment.createTaskFromArchive(f.input, f.archive);
  f.input.sourceIdentity.packageId = randomUUID(); f.input.actor.displayName = '后续修改';
  await f.repository.store.change(state => { state.deployments.targets[0].config.buildScript = 'other-build'; });
  const claimed = await f.deployment.claim(f.server.id);
  assert.equal(claimed.config.buildScript, 'build'); assert.deepEqual(claimed.sourceIdentity, expectedIdentity); assert.deepEqual(claimed.actor, expectedActor);
  // Agent 回报的额外来源不可覆盖中心固定的工作区身份。
  await f.deployment.events(f.server.id, task.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: { ...successful(task), sourceIdentity: { packageId: 'forged' } } } });
  const release = f.deployment.releases(f.target.id)[0];
  assert.deepEqual(release.sourceIdentity, expectedIdentity); assert.deepEqual(release.actor, expectedActor);
  const rollback = await f.deployment.createTask({ targetId: f.target.id, action: 'rollback', releaseId: release.id, requestId: randomUUID(), actor: { id: 'u-second' } });
  assert.equal(rollback.sourceKind, 'workspace-package'); assert.deepEqual(rollback.sourceIdentity, expectedIdentity);
  assert.equal(rollback.source.sha256, task.source.sha256); assert.equal(rollback.config.buildScript, 'build');
  await f.deployment.claim(f.server.id);
  await f.deployment.events(f.server.id, rollback.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: { ...successful(rollback), artifact: release.artifact, artifactId: release.id, restoredFromReleaseId: release.id, recoveryMethod: 'cache' } } });
  const restored = f.deployment.releases(f.target.id)[0];
  assert.equal(restored.restoredFromReleaseId, release.id); assert.deepEqual(restored.sourceIdentity, expectedIdentity); assert.equal(restored.actor.id, 'u-second');
  assert.equal(f.remoteCalls(), 0);
});

for (const state of ['fixed', 'missing', 'corrupt']) test(`工作区 preparing 重启恢复只用固定档案：${state}`, async t => {
  const f = await fixture(t), task = await f.deployment.createTaskFromArchive(f.input, f.archive);
  if (state === 'corrupt') await writeFile(f.deployment.archives.resolve(task.source).file, Buffer.alloc(task.source.size, 1));
  await f.repository.store.change(value => {
    const saved = value.deployments.tasks.find(entry => entry.id === task.id);
    saved.status = 'preparing'; saved.stage = 'preparing';
    if (state === 'missing') { saved.source = null; delete saved.sourceArchiveId; }
  });
  await f.deployment.close(); await f.repository.store.close(); await rm(f.archive.file);
  const restarted = await f.reopen();
  await restarted.deployment.preparations.get(task.id);
  const recovered = restarted.deployment.data.tasks.find(entry => entry.id === task.id);
  assert.equal(recovered.status, state === 'fixed' ? 'queued' : 'failed');
  assert.deepEqual(recovered.sourceIdentity, f.input.sourceIdentity);
  if (state === 'fixed') assert.deepEqual(await readFile(restarted.deployment.archives.resolve(recovered.source).file), f.bytes);
  else { assert.ok(recovered.error); assert.equal(await restarted.deployment.claim(f.server.id), null); }
  assert.equal(f.remoteCalls(), 0);
});

test('Java 工作区包也可进入原队列，不需要旧环境源码仓库关联', async t => {
  const f = await fixture(t, 'java'), task = await f.deployment.createTaskFromArchive(f.input, f.archive);
  assert.equal(task.status, 'queued'); assert.equal(task.config.kind, 'java'); assert.equal(task.sourceIdentity.service, 'backend');
  assert.equal(f.deployment.data.environmentSources.length, 0); assert.equal(f.repository.store.state.projects.length, 0);
  assert.equal((await f.deployment.claim(f.server.id)).id, task.id); assert.equal(f.remoteCalls(), 0);
});
