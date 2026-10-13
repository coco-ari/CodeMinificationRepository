import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, readdir, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ArchiveBuilder } from '../src/archive.mjs';
import { RepositoryService } from '../src/service.mjs';
import { createApplication } from '../src/server.mjs';
import { SourceSnapshots, SOURCE_LIMITS, sourcePath } from '../src/source-snapshots.mjs';
import { SourceScheduler } from '../src/source-scheduler.mjs';
import { HttpError } from '../src/security.mjs';

const exec = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const input = { name: '测试源码', repository: 'https://gitee.com/example/source.git', branch: 'main', enabled: true, sourceEnabled: true };
const git = async (cwd, ...args) => (await exec('git', ['-c', 'user.name=测试', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd })).stdout.trim();
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cmr-source-test-'));
  const repository = path.join(directory, 'repo');
  await mkdir(path.join(repository, 'src'), { recursive: true });
  await git(repository, 'init', '-b', 'main');
  await writeFile(path.join(repository, 'src/app.js'), 'export const answer = 42;\n');
  await writeFile(path.join(repository, 'stable.txt'), 'unchanged\n');
  await writeFile(path.join(repository, 'private.txt'), 'not distributed\n');
  await writeFile(path.join(repository, '.gitattributes'), 'private.txt export-ignore\n');
  await git(repository, 'add', '.'); await git(repository, 'commit', '-m', '测试初始源码');
  const actual = new ArchiveBuilder(path.join(directory, 'cache'), { allowLocal: true });
  const builder = { calls: 0, failure: null, initialize: () => actual.initialize(), build(project) {
    this.calls++; if (this.failure) throw this.failure;
    return actual.build({ ...project, repository }, null);
  } };
  const app = await createApplication({ directory: path.join(directory, 'data'), builder, secureCookies: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); });
  const created = await app.service.saveProject(input);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const root = `/api/v1/projects/${created.project.id}/source`;
  const request = (suffix, options = {}) => fetch(`${base}${root}${suffix}`, { ...options, headers: { Authorization: `Bearer ${created.token}`, ...options.headers } });
  return { ...app, directory, repository, builder, created, base, root, request };
}

test('真实源码协议：首次 ZIP、文件清单、增量对象、跨版本和导出排除保持一致', async t => {
  const f = await fixture(t), id = f.created.project.id;
  assert.equal((await (await f.request('/head')).json()).snapshot, null);
  assert.equal(f.builder.calls, 0, '只查询版本不触发 Git');
  await f.service.sync(id);
  const head = await (await f.request('/head')).json();
  assert.equal(head.protocol, 'cmr-source/1');
  assert.ok(head.snapshot, JSON.stringify(head.sync));
  const firstId = head.snapshot.snapshotId;
  const manifest = await (await f.request(`/snapshots/${firstId}/manifest`)).json();
  assert.deepEqual(manifest.files.map(x => x.path), ['.gitattributes', 'src/app.js', 'stable.txt']);
  assert.equal(manifest.fileCount, 3);
  const archive = await f.request(`/snapshots/${firstId}/archive`);
  const bytes = Buffer.from(await archive.arrayBuffer());
  assert.equal(digest(bytes), manifest.archiveSha256);
  assert.equal(archive.headers.get('x-source-revision'), manifest.revision);
  const hashes = manifest.files.map(x => x.sha256);
  const batchResponse = await f.request(`/snapshots/${firstId}/files`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' }, body: JSON.stringify({ hashes }) });
  assert.equal(batchResponse.status, 200);
  assert.equal(batchResponse.headers.get('content-encoding'), 'gzip');
  const batch = await batchResponse.json();
  for (const file of batch.files) assert.equal(digest(Buffer.from(file.data, 'base64')), file.sha256);
  await f.service.sync(id);
  assert.equal((await f.service.sourceHead(id, f.created.token)).snapshot.snapshotId, firstId);
  await rename(path.join(f.repository, 'src/app.js'), path.join(f.repository, 'src/renamed.js'));
  await writeFile(path.join(f.repository, 'new.txt'), 'new data');
  await git(f.repository, 'add', '-A'); await git(f.repository, 'commit', '-m', '测试重命名与新增');
  await f.service.sync(id);
  await rm(path.join(f.repository, 'new.txt'));
  await writeFile(path.join(f.repository, 'src/renamed.js'), 'export const answer = 43;\n');
  await git(f.repository, 'add', '-A'); await git(f.repository, 'commit', '-m', '测试删除与修改');
  await f.service.sync(id);
  const target = (await f.service.sourceHead(id, f.created.token)).snapshot;
  const next = await (await f.request(`/snapshots/${target.snapshotId}/manifest`)).json();
  const missing = next.files.filter(file => !hashes.includes(file.sha256));
  assert.deepEqual(missing.map(file => file.path), ['src/renamed.js']);
  assert.ok(!next.files.some(file => file.path === 'src/app.js' || file.path === 'new.txt'));
  const delta = await (await f.request(`/snapshots/${target.snapshotId}/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: missing.map(file => file.sha256) }) })).json();
  assert.equal(delta.files.length, 1, '跳过中间版本只下载一个变化文件');
  assert.equal(Buffer.from(delta.files[0].data, 'base64').toString(), 'export const answer = 43;\n');
  assert.equal((await f.request(`/snapshots/${firstId}/archive`)).status, 200, '旧会话可继续读取原快照');
  const restarted = new RepositoryService({ directory: path.join(f.directory, 'data'), builder: f.builder }); await restarted.initialize();
  assert.equal((await restarted.sourceHead(id, f.created.token)).snapshot.snapshotId, target.snapshotId);
});

test('快照接口按项目鉴权、仅允许清单对象、重置立即关闭订阅', async t => {
  const f = await fixture(t), id = f.created.project.id;
  await f.service.sync(id);
  const sid = (await f.service.sourceHead(id, f.created.token)).snapshot.snapshotId;
  const other = await f.service.saveProject({ ...input, name: '另一个项目' });
  assert.equal((await f.request('/head', { headers: { Authorization: `Bearer ${other.token}` } })).status, 401);
  for (const hashes of [['0'.repeat(64)], []]) {
    const response = await f.request(`/snapshots/${sid}/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes }) });
    assert.equal(response.status, hashes.length ? 404 : 400);
  }
  const events = await f.request('/events');
  const reader = events.body.getReader();
  const initial = await reader.read();
  assert.match(new TextDecoder().decode(initial.value), new RegExp(sid));
  await f.service.rotateToken(id);
  assert.equal((await reader.read()).done, true);
  assert.equal((await f.request(`/snapshots/${sid}/manifest`)).status, 401);
});

test('快照构建失败不会破坏旧 ZIP，Git 失败仍拒绝 latest 且保留明确标注的已发布快照', async t => {
  const f = await fixture(t), id = f.created.project.id;
  await f.service.sync(id);
  const first = (await f.service.sourceHead(id, f.created.token)).snapshot;
  f.service.snapshots.publish = async () => { throw new HttpError(422, '测试快照失败'); };
  const legacy = await fetch(`${f.base}/api/projects/${id}/source/latest`, { headers: { Authorization: `Bearer ${f.created.token}` } });
  assert.equal(legacy.status, 200); await legacy.arrayBuffer();
  assert.match((await f.service.sourceHead(id, f.created.token)).sync.error, /测试快照失败/);
  f.builder.failure = new HttpError(502, '测试上游不可用');
  assert.equal((await fetch(`${f.base}/api/projects/${id}/source/latest`, { headers: { Authorization: `Bearer ${f.created.token}` } })).status, 502);
  assert.equal((await f.service.sourceHead(id, f.created.token)).snapshot.snapshotId, first.snapshotId);
  assert.equal((await f.request(`/snapshots/${first.snapshotId}/archive`)).status, 200);
});

test('变更来源后不能通过原快照读取旧来源；停用源码能力不改变 legacy 下载', async t => {
  const f = await fixture(t), id = f.created.project.id;
  await f.service.sync(id);
  const original = (await f.service.sourceHead(id, f.created.token)).snapshot;
  await f.service.saveProject({ ...input, repository: 'https://gitee.com/example/other.git' }, id);
  assert.equal((await f.request(`/snapshots/${original.snapshotId}/manifest`)).status, 409);
  await f.service.sync(id);
  assert.equal((await f.request(`/snapshots/${original.snapshotId}/manifest`)).status, 410);
  await f.service.saveProject({ ...input, sourceEnabled: false }, id);
  assert.equal((await f.request('/head')).status, 409);
  const legacy = await fetch(`${f.base}/api/projects/${id}/source/latest`, { headers: { Authorization: `Bearer ${f.created.token}` } });
  assert.equal(legacy.status, 200); await legacy.arrayBuffer();
});

test('文件损坏、大小限制与不安全路径明确失败', async t => {
  const f = await fixture(t), id = f.created.project.id;
  await f.service.sync(id);
  const sid = (await f.service.sourceHead(id, f.created.token)).snapshot.snapshotId;
  const manifest = await f.service.snapshots.manifest(id, sid);
  const entry = manifest.files[0];
  await writeFile(path.join(f.service.snapshots.root(id), 'objects', entry.sha256), 'broken');
  await assert.rejects(f.service.snapshots.batch(id, manifest, [entry.sha256]), { status: 500 });
  await f.service.sync(id);
  assert.equal((await f.service.snapshots.batch(id, manifest, [entry.sha256])).files.length, 1, '重建可修复损坏缓存');
  for (const unsafe of ['../a', '/a', 'a/../../b', 'a\\b', '.git/config', 'con.txt', 'a:stream', 'a.', 'a\u0000']) assert.throws(() => sourcePath(unsafe));
  const tiny = new SourceSnapshots(path.join(f.directory, 'tiny'), { limits: { ...SOURCE_LIMITS, maxFileBytes: 1 } });
  const archive = await f.builder.build(f.created.project);
  await assert.rejects(tiny.publish(id, archive), { status: 422 });
  assert.equal(await tiny.head(id), null);
  await symlink('stable.txt', path.join(f.repository, 'link'));
  await git(f.repository, 'add', '.'); await git(f.repository, 'commit', '-m', '测试符号链接');
  await f.service.sync(id);
  assert.match((await f.service.sourceHead(id, f.created.token)).sync.error, /符号链接/);
  assert.equal((await f.service.sourceHead(id, f.created.token)).snapshot.snapshotId, sid);
});

test('旧快照清理保护下载租约，并回收无引用对象', async t => {
  const f = await fixture(t), id = f.created.project.id;
  await f.service.sync(id);
  const first = (await f.service.sourceHead(id, f.created.token)).snapshot;
  const lease = await f.service.snapshots.acquire(id, first.snapshotId);
  await writeFile(path.join(f.repository, 'src/app.js'), 'changed');
  await git(f.repository, 'add', '.'); await git(f.repository, 'commit', '-m', '测试缓存清理');
  f.service.snapshots.retentionMs = -1;
  await f.service.sync(id);
  await f.service.snapshots.manifest(id, first.snapshotId);
  lease.release();
  await f.service.snapshots.prune(id);
  await assert.rejects(f.service.snapshots.manifest(id, first.snapshotId), { status: 410 });
  const current = (await f.service.sourceHead(id, f.created.token)).snapshot;
  const manifest = await f.service.snapshots.manifest(id, current.snapshotId);
  assert.equal((await readdir(path.join(f.service.snapshots.root(id), 'objects'))).length, new Set(manifest.files.map(x => x.sha256)).size);
});

test('调度器只同步启用项目，合并在途任务并按间隔重试', async () => {
  let now = 0, calls = 0, finish;
  const id = randomUUID();
  const project = { id, enabled: true, sourceEnabled: true, syncIntervalSeconds: 60, updatedAt: 'initial' };
  const service = { store: { state: { projects: [project] } }, inFlight: new Map(), sync: () => { calls++; return new Promise(resolve => { finish = resolve; }); } };
  const scheduler = new SourceScheduler(service, { now: () => now });
  scheduler.tick(); now = 10000; scheduler.tick(); scheduler.tick(); assert.equal(calls, 1);
  now = 80000; scheduler.tick(); assert.equal(calls, 1);
  finish(); await Promise.all(scheduler.pending.values());
  scheduler.tick(); assert.equal(calls, 2); finish(); await Promise.all(scheduler.pending.values());
  project.enabled = false; now = 200000; scheduler.tick(); assert.equal(calls, 2);
});

test('连续同步失败指数退避，成功后恢复普通间隔',async()=>{
 let now=10000,calls=0,fail=true;
 const project={id:'00000000-0000-4000-8000-000000000001',enabled:true,sourceEnabled:true,syncIntervalSeconds:60,updatedAt:'initial'};
 const service={store:{state:{projects:[project]}},inFlight:new Map(),sync:async()=>{calls++;if(fail)throw new Error('fixture');}};
 const scheduler=new SourceScheduler(service,{now:()=>now});scheduler.tick();await Promise.all(scheduler.pending.values());assert.equal(calls,1);assert.equal(scheduler.next.get(project.id).due,130000);
 now=70000;scheduler.tick();assert.equal(calls,1);now=130000;scheduler.tick();await Promise.all(scheduler.pending.values());assert.equal(calls,2);assert.equal(scheduler.next.get(project.id).due,370000);
 fail=false;now=370000;scheduler.tick();await Promise.all(scheduler.pending.values());assert.equal(scheduler.next.get(project.id).failures,0);assert.equal(scheduler.next.get(project.id).due,430000);
});
