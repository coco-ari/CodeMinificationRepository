import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { zipSync, strToU8 } from 'fflate';
import { Store } from '../src/store.mjs';
import { SourceArchives } from '../src/source-archives.mjs';

const oldAt = '2000-01-01T00:00:00.000Z';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'autoops-source-migration-'));
  let store = new Store(root), archives;
  const bindArchives = () => { archives = new SourceArchives({ root, store, changed() {} }); };
  await store.open();
  await store.change(state => {
    state.deployments = { tasks: [], releases: [], targets: [], sourceArchives: [],
      sourceArchiveMigration: { at: oldAt, imported: 0, missing: 0, invalid: 0, version: 1 } };
  });
  bindArchives();
  t.after(async () => { await archives.pending; await store.close(); await rm(root, { recursive: true, force: true }); });
  const bytes = Buffer.from(zipSync({ 'README.txt': strToU8('真实归档校验的隔离源码') }));
  const inputFile = path.join(root, 'input.zip');
  await writeFile(inputFile, bytes);
  const task = { id: randomUUID(), applicationId: randomUUID(), targetId: randomUUID(),
    status: 'succeeded', sourceKind: 'workspace-package', sourceIdentity: { projectId: 'p-source-migration' },
    config: { module: '.' }, commitSubject: '隔离版本' };
  const input = { file: inputFile, revision: 'a'.repeat(40), commitSubject: task.commitSubject, sha256: sha(bytes), size: bytes.length };
  async function reportAtOldTime() { await store.change(state => { state.deployments.sourceArchiveMigration.at = oldAt; }); }
  function persistedRow() {
    const db = new DatabaseSync(store.databaseFile, { readOnly: true });
    try { return db.prepare('SELECT value FROM application_state WHERE id=1').get().value; }
    finally { db.close(); }
  }
  async function registeredArchive() {
    await store.change(state => { state.deployments.tasks.push(structuredClone(task)); });
    const source = await archives.import(task, input);
    await store.change(state => {
      const release = { id: task.id, applicationId: task.applicationId, targetId: task.targetId, sourceArchiveId: source.archiveId,
        sourceKind: task.sourceKind, sourceIdentity: structuredClone(task.sourceIdentity), config: structuredClone(task.config),
        revision: source.revision, commitSubject: task.commitSubject, available: true };
      state.deployments.releases.push(release);
      state.deployments.targets.push({ id: task.targetId, currentRelease: structuredClone(release) });
    });
    await archives.migrate();
    await reportAtOldTime();
    return { source, file: archives.resolve(source).file };
  }
  return { root, task, input, bytes, reportAtOldTime, persistedRow, registeredArchive,
    get store() { return store; }, get archives() { return archives; },
    async reopen() { await archives.pending; await store.close(); store = new Store(root); await store.open(); bindArchives(); } };
}

test('有效档案重启后仍真实校验，无实质变化时保留报告和完整持久行摘要', async t => {
  const f = await fixture(t), item = await f.registeredArchive();
  const before = f.persistedRow(), archiveHash = sha(await readFile(item.file));
  await f.reopen();
  await f.archives.migrate();
  assert.equal(f.store.state.deployments.sourceArchiveMigration.at, oldAt);
  assert.equal(sha(f.persistedRow()), sha(before));
  assert.deepEqual(JSON.parse(f.persistedRow()), JSON.parse(before));
  assert.equal(sha(await readFile(item.file)), archiveHash);
  assert.equal((await f.archives.verify(item.source)).sha256, f.input.sha256);
});

test('无档案且报告内容相同时重复迁移保持原报告时间', async t => {
  const f = await fixture(t), before = f.persistedRow();
  await f.archives.migrate();
  assert.equal(f.persistedRow(), before);
});

test('已有档案实际缺失与恢复时仍重新校验并更新报告', async t => {
  const f = await fixture(t), item = await f.registeredArchive();
  await rm(item.file);
  await f.archives.migrate();
  assert.equal(f.store.state.deployments.sourceArchiveMigration.missing, 1);
  assert.notEqual(f.store.state.deployments.sourceArchiveMigration.at, oldAt);
  assert.equal(f.archives.status({ sourceArchiveId: item.source.archiveId }), 'missing');
  await f.reportAtOldTime();
  await writeFile(item.file, f.bytes);
  await f.archives.migrate();
  assert.equal(f.store.state.deployments.sourceArchiveMigration.missing, 0);
  assert.notEqual(f.store.state.deployments.sourceArchiveMigration.at, oldAt);
  assert.equal((await f.archives.verify(item.source)).sha256, f.input.sha256);
});

test('同大小文件损坏仍做内容校验，记录 invalid 并保留真实损坏内容', async t => {
  const f = await fixture(t), item = await f.registeredArchive();
  const corrupt = Buffer.from(f.bytes); corrupt[corrupt.length - 1] ^= 1;
  await writeFile(item.file, corrupt);
  await f.archives.migrate();
  assert.equal(f.store.state.deployments.sourceArchiveMigration.invalid, 1);
  assert.notEqual(f.store.state.deployments.sourceArchiveMigration.at, oldAt);
  assert.equal(f.archives.status({ sourceArchiveId: item.source.archiveId }), 'invalid');
  assert.deepEqual(await readFile(item.file), corrupt);
  await assert.rejects(f.archives.verify(item.source), { status: 410 });
});

test('通过原导入接口修复同内容档案后更新报告，版本和档案身份不变', async t => {
  const f = await fixture(t), item = await f.registeredArchive();
  await writeFile(item.file, Buffer.alloc(f.bytes.length, 0));
  await f.archives.migrate();
  assert.equal(f.store.state.deployments.sourceArchiveMigration.invalid, 1);
  await f.reportAtOldTime();
  const repaired = await f.archives.import(f.task, f.input);
  await f.archives.migrate();
  assert.equal(repaired.archiveId, item.source.archiveId);
  assert.equal(f.store.state.deployments.releases[0].id, f.task.id);
  assert.equal(f.store.state.deployments.sourceArchiveMigration.invalid, 0);
  assert.equal(f.store.state.deployments.sourceArchiveMigration.missing, 0);
  assert.notEqual(f.store.state.deployments.sourceArchiveMigration.at, oldAt);
  assert.deepEqual(await readFile(item.file), f.bytes);
});

test('imported 是当次执行计数，成功导入到下次零导入需更新，后续零导入才保持', async t => {
  const f = await fixture(t);
  const taskRoot = path.join(f.root, 'tasks', f.task.id);
  await mkdir(taskRoot, { recursive: true });
  await writeFile(path.join(taskRoot, 'source.zip'), f.bytes);
  await f.store.change(state => { state.deployments.tasks.push({ ...f.task, source: { ...f.input, file: undefined } }); });
  await f.archives.migrate();
  const archiveId = f.store.state.deployments.tasks[0].sourceArchiveId;
  assert.equal(f.store.state.deployments.sourceArchiveMigration.imported, 1);
  assert.equal(f.store.state.deployments.sourceArchives.length, 1);
  await f.reportAtOldTime();
  await f.archives.migrate();
  assert.equal(f.store.state.deployments.sourceArchiveMigration.imported, 0);
  assert.notEqual(f.store.state.deployments.sourceArchiveMigration.at, oldAt);
  assert.equal(f.store.state.deployments.tasks[0].sourceArchiveId, archiveId);
  assert.equal(f.store.state.deployments.sourceArchives.length, 1);
  const settled = f.persistedRow();
  await f.archives.migrate();
  assert.equal(f.persistedRow(), settled);
});
