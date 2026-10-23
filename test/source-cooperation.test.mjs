import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { RepositoryService } from '../src/service.mjs';
import { DeploymentService } from '../src/deployment.mjs';
import { sourceKey } from '../src/archive.mjs';
import { HttpError } from '../src/security.mjs';

const projectInput = { name: '源码协作测试', repository: 'https://gitee.com/example/source.git', branch: 'main' };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cmr-source-cooperation-'));
  const calls = [], hooks = {};
  const builder = Object.freeze({
    async initialize() { await mkdir(path.join(directory, 'cache')); },
    async build(project, credential, onPhase) {
      calls.push(['build', project.id, project.revision || 'latest']);
      await hooks.build?.(project);
      await onPhase?.('source_archive');
      const revision = project.revision || 'a'.repeat(40);
      const content = Buffer.from(revision);
      const file = path.join(directory, 'cache', sourceKey(project).replace(':', '-') + '.zip');
      await writeFile(file, content);
      return { file, revision, size: content.length, sha256: createHash('sha256').update(content).digest('hex'), cached: false };
    },
    async history(project, credential, refresh) {
      calls.push(['history', project.id, refresh]);
      await hooks.history?.(project);
      return { commits: [{ revision: 'a'.repeat(40), subject: '固定版本' }], refreshedAt: null };
    },
    async pinRevision(project, taskId) { calls.push(['pin', project.id, taskId]); await hooks.pin?.(); },
    async releasePin(project, taskId) { calls.push(['release', project.id, taskId]); },
    async cachedCommitSubject(project, revision) { calls.push(['subject', project.id, revision]); return '固定版本'; },
  });
  const repository = new RepositoryService({ directory, builder, maxConcurrent: 4 });
  await repository.initialize();
  t.after(async () => {
    await repository.waitForIdle();
    await repository.store.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cmr-source-cooperation-'));
    await rm(directory, { recursive: true, force: true });
  });
  const { project } = await repository.saveProject(projectInput);
  return { directory, repository, builder, calls, hooks, project };
}

test('部署初始化及再次装配不改写冻结构建器的方法身份', async t => {
  const f = await fixture(t);
  const build = f.builder.build, history = f.builder.history;
  for (let index = 0; index < 2; index++) {
    const deployment = new DeploymentService(f.repository);
    try {
      await deployment.initialize();
      assert.equal(f.repository.builder, f.builder);
      assert.equal(f.builder.build, build);
      assert.equal(f.builder.history, history);
      assert.equal((await f.repository.history(f.project, true)).commits.length, 1);
      const source = await f.repository.captureArchive(f.project.id, f.project, async archive => readFile(archive.file, 'utf8'));
      assert.equal(source, 'a'.repeat(40));
    } finally { await deployment.close(); }
  }
  assert.equal(f.calls.filter(call => call[0] === 'build').length, 2);
  assert.equal(f.calls.filter(call => call[0] === 'history').length, 2);
});

test('迟到的固定归档仍在共享源码锁内完成，单个归档失败不污染下载或其他项目', async t => {
  const f = await fixture(t);
  const { project: other } = await f.repository.saveProject({ ...projectInput, name: '独立源码项目' });
  const buildGate = Promise.withResolvers(), buildStarted = Promise.withResolvers();
  const copyGate = Promise.withResolvers(), copyStarted = Promise.withResolvers();
  f.hooks.build = async project => {
    if (project.id === f.project.id && !project.revision) { buildStarted.resolve(); await buildGate.promise; }
  };
  const phases = [];
  const download = f.repository.sync(f.project.id);
  const fixedFile = path.join(f.directory, 'fixed.zip');
  const first = f.repository.captureArchive(f.project.id, f.project, async archive => {
    copyStarted.resolve();
    await copyGate.promise;
    await copyFile(archive.file, fixedFile);
    return archive.revision;
  }, phase => phases.push(phase));
  const failure = new HttpError(507, '隔离的归档存储错误');
  let pending = [];
  try {
    await buildStarted.promise;
    buildGate.resolve();
    await copyStarted.promise;
    const late = f.repository.captureArchive(f.project.id, f.project, archive => readFile(archive.file, 'utf8'));
    const failed = assert.rejects(f.repository.captureArchive(f.project.id, f.project, archive => {
      archive.revision = 'c'.repeat(40);
      throw failure;
    }), error => error === failure);
    const history = f.repository.history(f.project, true);
    const next = f.repository.sync(f.project.id, { ...f.project, revision: 'b'.repeat(40) });
    pending = [late, failed, history, next];
    assert.equal((await f.repository.sync(other.id)).revision, 'a'.repeat(40));
    assert.equal(f.calls.filter(call => call[0] === 'build' && call[1] === f.project.id).length, 1);
    assert.equal(f.calls.filter(call => call[0] === 'history').length, 0);
    copyGate.resolve();
    const [archive, firstRevision, lateBytes, , , nextArchive] = await Promise.all([download, first, ...pending]);
    assert.equal(archive.revision, 'a'.repeat(40));
    assert.equal(firstRevision, 'a'.repeat(40));
    assert.equal(lateBytes, 'a'.repeat(40));
    assert.equal(nextArchive.revision, 'b'.repeat(40));
    assert.equal(await readFile(fixedFile, 'utf8'), 'a'.repeat(40));
    assert.equal(await readFile(nextArchive.file, 'utf8'), 'b'.repeat(40));
    assert.deepEqual(phases, ['source_archive']);
    assert.equal(f.repository.store.state.projects.find(project => project.id === f.project.id).status, 'ready');
    assert.equal(f.calls.filter(call => call[0] === 'build' && call[1] === f.project.id).length, 2);
  } finally {
    buildGate.resolve(); copyGate.resolve();
    await Promise.allSettled([download, first, ...pending]);
  }
});

test('提交固定、释放及历史说明共享源码锁，失败后仍可释放固定提交', async t => {
  const f = await fixture(t);
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  f.hooks.build = async () => { started.resolve(); await gate.promise; };
  const download = f.repository.sync(f.project.id);
  let pending = [];
  try {
    await started.promise;
    const taskId = randomUUID();
    pending = [f.repository.pinRevision({ ...f.project, revision: 'a'.repeat(40) }, taskId),
      f.repository.releasePin(f.project, taskId), f.repository.cachedCommitSubject(f.project, 'a'.repeat(40))];
    await setImmediate();
    assert.deepEqual(f.calls.map(call => call[0]), ['build']);
    gate.resolve();
    const [, , subject] = await Promise.all(pending);
    await download;
    assert.equal(subject, '固定版本');
    assert.deepEqual(f.calls.map(call => call[0]), ['build', 'pin', 'release', 'subject']);
    f.hooks.pin = () => { throw new HttpError(409, '提交不可用'); };
    const rejection = assert.rejects(f.repository.pinRevision(f.project, taskId), { status: 409 });
    await f.repository.releasePin(f.project, taskId);
    await rejection;
    await f.repository.waitForIdle();
  } finally { gate.resolve(); await Promise.allSettled([download, ...pending]); }
});

test('构建失败同时拒绝本次下载与归档，下一次同步重新构建', async t => {
  const f = await fixture(t);
  const failure = new HttpError(502, '隔离的源码连接错误');
  f.hooks.build = () => { throw failure; };
  let consumed = false;
  await Promise.all([
    assert.rejects(f.repository.sync(f.project.id), error => error === failure),
    assert.rejects(f.repository.captureArchive(f.project.id, f.project, () => { consumed = true; }), error => error === failure),
  ]);
  assert.equal(consumed, false);
  assert.equal(f.calls.filter(call => call[0] === 'build').length, 1);
  assert.equal(f.repository.store.state.projects[0].status, 'failed');
  f.hooks.build = undefined;
  assert.equal(await f.repository.captureArchive(f.project.id, f.project, archive => archive.revision), 'a'.repeat(40));
  assert.equal(f.calls.filter(call => call[0] === 'build').length, 2);
  assert.equal(f.repository.store.state.projects[0].status, 'ready');
});

test('排空等待覆盖尚在队列中的历史请求', async t => {
  const f = await fixture(t);
  f.repository.queue.limit = 1;
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const starts = [Promise.withResolvers(), Promise.withResolvers()];
  let entered = 0, idle = false;
  f.hooks.history = async () => {
    const index = entered++;
    starts[index].resolve();
    await gates[index].promise;
  };
  const first = f.repository.history(f.project, true);
  let second, drained;
  try {
    await starts[0].promise;
    second = f.repository.history(f.project, true);
    drained = f.repository.waitForIdle().then(() => { idle = true; });
    gates[0].resolve();
    await starts[1].promise;
    await setImmediate();
    assert.equal(idle, false);
    gates[1].resolve();
    await Promise.all([first, second, drained]);
    assert.equal(idle, true);
  } finally {
    gates.forEach(gate => gate.resolve());
    await Promise.allSettled([first, second, drained]);
  }
});

test('初始化尚未结束时停止接单，最终关闭仍释放稍后创建的清理计时器', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const deployment = new DeploymentService(f.repository);
  const started = Promise.withResolvers(), gate = Promise.withResolvers();
  let cleanupCalls = 0, shutdownEvents = 0;
  deployment.on('shutdown', () => { shutdownEvents++; });
  deployment.cleanupSources = async () => { cleanupCalls++; started.resolve(); await gate.promise; };
  const initializing = deployment.initialize();
  try {
    await started.promise;
    deployment.beginClose();
    gate.resolve();
    await initializing;
    await deployment.close();
    t.mock.timers.tick(3600000);
    await setImmediate();
    assert.equal(cleanupCalls, 1);
    assert.equal(shutdownEvents, 1);
  } finally {
    gate.resolve();
    await initializing.catch(() => {});
    await deployment.close();
    t.mock.timers.reset();
  }
});

test('小时档案队列完成后，关闭仍等待完整清理并删除终态任务源码副本', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const deployment = new DeploymentService(f.repository);
  const started = Promise.withResolvers(), gate = Promise.withResolvers();
  let closing, closed = false;
  try {
    await deployment.initialize();
    const taskId = randomUUID(), directory = path.join(deployment.root, 'tasks', taskId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'source.zip'), '待释放副本');
    await writeFile(path.join(directory, 'source.json'), '{}');
    await f.repository.store.change(state => {
      state.deployments.tasks.push({ id: taskId, status: 'succeeded', sourceArchiveId: randomUUID(), finishedAt: new Date().toISOString() });
    });
    const cleanup = deployment.archives.cleanup.bind(deployment.archives);
    t.mock.method(deployment.archives, 'cleanup', async () => {
      await cleanup();
      started.resolve();
      await gate.promise;
    });
    t.mock.timers.tick(3600000);
    await started.promise;
    await deployment.archives.pending;
    closing = deployment.close().then(() => { closed = true; });
    await setImmediate();
    assert.equal(closed, false);
    assert.equal(await readFile(path.join(directory, 'source.zip'), 'utf8'), '待释放副本');
    gate.resolve();
    await closing;
    assert.equal(closed, true);
    await assert.rejects(readFile(path.join(directory, 'source.zip')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(directory, 'source.json')), { code: 'ENOENT' });
  } finally {
    gate.resolve();
    await closing;
    await deployment.close();
    t.mock.timers.reset();
  }
});
