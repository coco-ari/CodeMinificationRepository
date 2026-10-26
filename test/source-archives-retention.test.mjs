import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { SourceArchives } from '../src/source-archives.mjs';

const expiredAt = '2000-01-01T00:00:00.000Z';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'autoops-archive-retention-'));
  const store = new Store(root);
  await store.open();
  await store.change(state => {
    state.deployments = { tasks: [], releases: [], targets: [], sourceArchives: [] };
  });
  const archives = new SourceArchives({ root, store, changed() {} });
  t.after(async () => { await archives.pending; await store.close(); await rm(root, { recursive: true, force: true }); });
  const applicationId = randomUUID();
  async function archivedTask(status = 'failed') {
    const bytes = Buffer.from(`隔离源码 ${randomUUID()}`), file = path.join(root, `${randomUUID()}.zip`);
    await writeFile(file, bytes);
    const task = { id: randomUUID(), applicationId, status, createdAt: expiredAt, finishedAt: expiredAt, sourceKind: 'workspace-package', sourceIdentity: { projectId: 'p-test' } };
    await store.change(state => { state.deployments.tasks.push(task); });
    const source = await archives.import(task, { file, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, revision: 'a'.repeat(40) });
    await store.change(state => { state.deployments.sourceArchives.find(item => item.id === source.archiveId).createdAt = expiredAt; });
    return { task, source, bytes, file: archives.resolve(source).file, inputFile: file };
  }
  return { root, store, archives, archivedTask };
}

test('临时档案删除失败后保留清理收据，重启后继续物理回收', async t => {
  const f = await fixture(t), item = await f.archivedTask();
  // 用真实文件系统错误模拟磁盘清理失败，不替换存储或删除函数。
  await rm(item.file);
  await mkdir(item.file);
  await assert.rejects(f.archives.cleanup());
  assert.ok(f.store.state.deployments.sourceArchives[0].deletedAt);
  assert.throws(() => f.archives.resolve(item.source), { status: 410 });
  await rm(item.file, { recursive: true });
  await writeFile(item.file, item.bytes);
  const reopened = new Store(f.root);
  await reopened.open();
  const archives = new SourceArchives({ root: f.root, store: reopened, changed() {} });
  try {
    await archives.cleanup();
    await assert.rejects(readFile(item.file), { code: 'ENOENT' });
    assert.equal(reopened.state.deployments.tasks.length, 1);
  } finally { await archives.pending; await reopened.close(); }
});

test('单个档案删除失败不阻止同批其他无引用档案回收', async t => {
  const f = await fixture(t), blocked = await f.archivedTask(), other = await f.archivedTask();
  await rm(blocked.file);
  await mkdir(blocked.file);
  await assert.rejects(f.archives.cleanup());
  await assert.rejects(readFile(other.file), { code: 'ENOENT' });
  assert.equal(f.store.state.deployments.tasks.length, 2);
});

test('手动清理物理删除失败后原请求可重试，不改历史收据且不重新开放下载', async t => {
  const f = await fixture(t), item = await f.archivedTask('succeeded');
  await f.store.change(state => {
    state.deployments.releases.push({ id: item.task.id, applicationId: item.task.applicationId, sourceArchiveId: item.source.archiveId, available: true });
  });
  const request = { requestId: randomUUID(), actor: { id: 'archive-manager' } };
  await rm(item.file);
  await mkdir(item.file);
  await assert.rejects(f.archives.clear(item.task.id, item.task.applicationId, request));
  const clearedAt = f.store.state.deployments.releases[0].sourceClearedAt;
  assert.ok(clearedAt);
  assert.throws(() => f.archives.resolve(item.source), { status: 410 });
  await rm(item.file, { recursive: true });
  await writeFile(item.file, item.bytes);
  await f.archives.clear(item.task.id, item.task.applicationId, request);
  await assert.rejects(readFile(item.file), { code: 'ENOENT' });
  assert.equal(f.store.state.deployments.releases[0].sourceClearedAt, clearedAt);
  assert.equal(f.store.state.deployments.sourceClearRequests.length, 1);
  assert.ok(f.store.state.deployments.sourceArchives[0].purgedAt);
});

test('长期版本链、活动任务和未知结果保护源码，终态无引用档案才到期回收', async t => {
  const f = await fixture(t), protectedItems = [];
  for (const status of ['preparing', 'queued', 'claimed', 'running', 'recovering', 'unknown']) {
    protectedItems.push(await f.archivedTask(status));
  }
  const published = await f.archivedTask('succeeded');
  await f.store.change(state => {
    state.deployments.releases.push({ id: published.task.id, sourceArchiveId: published.source.archiveId });
  });
  protectedItems.push(published);
  const baseline = await f.archivedTask();
  await f.store.change(state => {
    state.deployments.tasks.find(item => item.id === protectedItems[0].task.id).baselineSource = baseline.source;
  });
  protectedItems.push(baseline);
  const recent = await f.archivedTask();
  await f.store.change(state => { state.deployments.tasks.find(item => item.id === recent.task.id).finishedAt = new Date().toISOString(); });
  protectedItems.push(recent);
  const unused = await f.archivedTask();
  await f.archives.cleanup();
  for (const item of protectedItems) assert.deepEqual(await readFile(item.file), item.bytes);
  await assert.rejects(readFile(unused.file), { code: 'ENOENT' });
  assert.throws(() => f.archives.resolve(unused.source), { status: 410 });
});

test('已标记清理的同内容档案被新任务重新登记后不能被清理重试删除', async t => {
  const f = await fixture(t), item = await f.archivedTask();
  await rm(item.file);
  await mkdir(item.file);
  await assert.rejects(f.archives.cleanup());
  await rm(item.file, { recursive: true });
  const next = { ...item.task, id: randomUUID(), status: 'queued', createdAt: new Date().toISOString() };
  await f.store.change(state => { state.deployments.tasks.push(next); });
  const recovered = await f.archives.import(next, { ...item.source, file: item.inputFile });
  assert.equal(recovered.archiveId, item.source.archiveId);
  await f.archives.cleanup();
  assert.deepEqual(await readFile(f.archives.resolve(recovered).file), item.bytes);
});
