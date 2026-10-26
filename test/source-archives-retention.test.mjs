import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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

test('源码复制成功但登记事务失败后，未知任务保护原件，确定失败到期后回收未登记文件', async t => {
  const f = await fixture(t), bytes = Buffer.from('登记事务失败的隔离源码'), inputFile = path.join(f.root, 'unregistered-input.zip');
  await writeFile(inputFile, bytes);
  const task = { id: randomUUID(), applicationId: randomUUID(), sourceKind: 'workspace-package', status: 'unknown', createdAt: expiredAt };
  await f.store.change(state => { state.deployments.tasks.push(task); });
  const archive = { file: inputFile, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, revision: 'b'.repeat(40) };
  const db = new DatabaseSync(f.store.databaseFile);
  try {
    // 用真实 SQLite 事务拒绝登记，文件复制与 fsync 仍执行原实现。
    db.exec("CREATE TRIGGER reject_archive_registration BEFORE UPDATE ON application_state BEGIN SELECT RAISE(ABORT,'隔离登记故障'); END");
    await assert.rejects(f.archives.import(task, archive), /隔离登记故障/);
  } finally { db.exec('DROP TRIGGER IF EXISTS reject_archive_registration'); db.close(); }
  assert.equal(f.store.state.deployments.sourceArchives.length, 0);
  const orphan = f.archives.file({ ...archive, applicationId: task.applicationId });
  assert.deepEqual(await readFile(orphan), bytes);
  await utimes(orphan, new Date(expiredAt), new Date(expiredAt));
  await f.archives.cleanup();
  assert.deepEqual(await readFile(orphan), bytes);
  await f.store.change(state => { Object.assign(state.deployments.tasks[0], { status: 'failed', finishedAt: expiredAt }); });
  await f.archives.cleanup();
  await assert.rejects(readFile(orphan), { code: 'ENOENT' });
  assert.equal(f.store.state.deployments.tasks.length, 1);
});

test('未登记回收只处理到期的受控普通文件，保留新文件、非档案路径和符号链接目标', async t => {
  const f = await fixture(t), applicationId = randomUUID(), directory = path.join(f.archives.root, applicationId);
  await mkdir(directory, { recursive: true });
  const old = path.join(directory, `${'a'.repeat(64)}.zip`), fresh = path.join(directory, `${'b'.repeat(64)}.zip`);
  const temporary = path.join(directory, `${'c'.repeat(64)}.zip.${randomUUID()}.tmp`), unrelated = path.join(directory, 'manual.zip');
  const outside = path.join(f.root, 'outside.zip'), linked = path.join(directory, `${'d'.repeat(64)}.zip`);
  for (const file of [old, fresh, temporary, unrelated, outside]) await writeFile(file, '隔离文件');
  for (const file of [old, temporary, unrelated, outside]) await utimes(file, new Date(expiredAt), new Date(expiredAt));
  if (process.platform !== 'win32') await symlink(outside, linked);
  await f.archives.cleanup();
  for (const file of [old, temporary]) await assert.rejects(readFile(file), { code: 'ENOENT' });
  for (const file of [fresh, unrelated, outside]) assert.equal(await readFile(file, 'utf8'), '隔离文件');
  if (process.platform !== 'win32') assert.equal(await readFile(linked, 'utf8'), '隔离文件');
});

for (const cleared of [false, true]) test(`同内容登记失败保留未知任务，终态后继续回收：先前${cleared ? '已清理' : '仍存在'}`, async t => {
  const f = await fixture(t), item = await f.archivedTask();
  if (cleared) await f.archives.cleanup();
  const task = { id: randomUUID(), applicationId: item.task.applicationId, sourceKind: 'workspace-package', status: 'unknown', createdAt: expiredAt };
  await f.store.change(state => { state.deployments.tasks.push(task); });
  const db = new DatabaseSync(f.store.databaseFile);
  try {
    db.exec("CREATE TRIGGER reject_archive_registration BEFORE UPDATE ON application_state BEGIN SELECT RAISE(ABORT,'隔离重复登记故障'); END");
    await assert.rejects(f.archives.import(task, { ...item.source, file: item.inputFile }), /隔离重复登记故障/);
  } finally { db.exec('DROP TRIGGER IF EXISTS reject_archive_registration'); db.close(); }
  await utimes(item.file, new Date(expiredAt), new Date(expiredAt));
  await f.archives.cleanup();
  assert.deepEqual(await readFile(item.file), item.bytes);
  await f.store.change(state => { Object.assign(state.deployments.tasks.find(value => value.id === task.id), { status: 'failed', finishedAt: expiredAt }); });
  await f.archives.cleanup();
  await assert.rejects(readFile(item.file), { code: 'ENOENT' });
});

test('手动清理不能越过同项目尚未完成档案登记的未知任务', async t => {
  const f = await fixture(t), item = await f.archivedTask('succeeded');
  await f.store.change(state => {
    state.deployments.releases.push({ id: item.task.id, applicationId: item.task.applicationId, sourceArchiveId: item.source.archiveId });
    state.deployments.tasks.push({ id: randomUUID(), applicationId: item.task.applicationId, status: 'preparing', createdAt: expiredAt, sourceKind: 'workspace-package' });
  });
  await assert.rejects(f.archives.clear(item.task.id, item.task.applicationId, { requestId: randomUUID(), actor: { id: 'manager' } }), { status: 409 });
  assert.deepEqual(await readFile(item.file), item.bytes);
});
