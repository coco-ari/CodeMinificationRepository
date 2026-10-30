import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CenterClient } from '../agent/client.mjs';
import { SourceCache } from '../agent/source-cache.mjs';
import { AgentRunner } from '../agent/runner.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cmr-source-cache-'));
  const content = Buffer.from('固定源码压缩包测试数据'), sha256 = createHash('sha256').update(content).digest('hex');
  const f = { root, content, requests: [], status: 200, badBody: false, badHeader: false };
  f.task = { id: 'task-1', applicationId: 'app-1', targetId: 'target-1', sourceProjectId: 'repo-1', source: { url: '/api/agent/v1/tasks/task-1/source', revision: 'a'.repeat(40), sha256, size: content.length } };
  const server = http.createServer((req, res) => {
    f.requests.push([req.method, req.url]); assert.equal(req.headers.authorization, 'Bearer test-token');
    if (req.method === 'HEAD' && f.status !== 200) { res.writeHead(f.status); res.end(); return; }
    res.writeHead(200, { 'content-length': content.length, 'x-source-revision': f.task.source.revision, 'x-archive-sha256': f.badHeader ? '0'.repeat(64) : sha256 });
    res.end(f.badBody ? Buffer.alloc(content.length) : content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.url = `http://127.0.0.1:${server.address().port}`;
  f.client = () => new CenterClient(f.url, { allowHttpTest: true, token: 'test-token', cacheDirectory: path.join(root, 'cache') });
  f.destination = name => path.join(root, name + '.zip');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return f;
}

test('跨任务及 Agent 重启复用完整包，命中仍核验任务授权且复制独立文件', async t => {
  const f = await fixture(t), reports = [], client = f.client();
  await client.download(f.task, f.destination('first'), 1000, info => reports.push(info));
  const next = { ...f.task, id: 'task-2', source: { ...f.task.source, url: '/api/agent/v1/tasks/task-2/source' } };
  await f.client().download(next, f.destination('next'), 1000, info => reports.push(info));
  assert.deepEqual(f.requests, [['GET', f.task.source.url], ['HEAD', next.source.url]]);
  assert.deepEqual(reports.map(info => info.cached), [false, true]);
  await writeFile(f.destination('next'), '构建修改工作区');
  await client.download(f.task, f.destination('third'));
  assert.deepEqual(await readFile(f.destination('third')), f.content);
});

test('损坏缓存重新下载固定包，中心校验失败不留缓存和半包', async t => {
  const f = await fixture(t), client = f.client();
  await client.download(f.task, f.destination('first'));
  const entry = (await readdir(client.cache.directory))[0];
  await writeFile(path.join(client.cache.directory, entry), '损坏');
  await client.download(f.task, f.destination('next'));
  assert.deepEqual(f.requests.map(r => r[0]), ['GET', 'HEAD', 'GET']);
  await rm(path.join(client.cache.directory, entry)); f.badBody = true;
  await assert.rejects(client.download(f.task, f.destination('bad')), /ZIP 校验失败/);
  assert.deepEqual(await readdir(client.cache.directory), []);
  await assert.rejects(readFile(f.destination('bad')), { code: 'ENOENT' });
});

test('缓存不能绕过撤销授权、错误摘要和外部下载地址', async t => {
  const f = await fixture(t), client = f.client(); await client.download(f.task, f.destination('first'));
  f.status = 403;
  await assert.rejects(client.download(f.task, f.destination('denied')), /HTTP 403/);
  f.status = 200; f.badHeader = true;
  await assert.rejects(client.download(f.task, f.destination('wrong')), /任务版本不一致/);
  await assert.rejects(client.download({ ...f.task, source: { ...f.task.source, url: 'https://other.example/source' } }, f.destination('external')), /非当前中心/);
  assert.deepEqual(f.requests.map(r => r[0]), ['GET', 'HEAD', 'HEAD']);
});

test('旧中心不支持 HEAD 时回退完整下载，项目和仓库隔离缓存', async t => {
  const f = await fixture(t), client = f.client(); await client.download(f.task, f.destination('first'));
  f.status = 405; await client.download(f.task, f.destination('old'));
  await client.download({ ...f.task, applicationId: 'app-2' }, f.destination('other-app'));
  await client.download({ ...f.task, sourceProjectId: 'repo-2' }, f.destination('other-repo'));
  assert.deepEqual(f.requests.map(r => r[0]), ['GET', 'HEAD', 'GET', 'GET', 'GET']);
});

test('恢复基线沿用原任务授权路径，包大小限制和独占目标文件仍生效', async t => {
  const f = await fixture(t), client = f.client(); await client.download(f.task, f.destination('first'));
  const baseline = { ...f.task, id: 'baseline-1', downloadTaskId: f.task.id, source: { ...f.task.source, url: f.task.source.url + '?role=baseline' } };
  await client.download(baseline, f.destination('baseline'));
  assert.equal(f.requests.at(-1)[1], baseline.source.url);
  await assert.rejects(client.download(f.task, f.destination('first')), { code: 'EEXIST' });
  await assert.rejects(client.download(f.task, f.destination('small'), 1), /过大/);
  await assert.rejects(readFile(f.destination('small')), { code: 'ENOENT' });
});

test('缓存按最近使用淘汰，条数和字节上限生效，临时文件可恢复清理', async t => {
  const f = await fixture(t), cache = new SourceCache(path.join(f.root, 'limited'), { maxEntries: 2, maxBytes: f.content.length * 2 });
  await writeFile(f.destination('source'), f.content);
  const keys = ['1', '2', '3'].map(c => c.repeat(64));
  for (const key of keys.slice(0, 2)) await cache.store(key, f.destination('source'), f.task.source);
  await utimes(cache.file(keys[0]), new Date(0), new Date(0));
  await cache.store(keys[2], f.destination('source'), f.task.source);
  assert.deepEqual((await readdir(cache.directory)).sort(), keys.slice(1).map(k => k + '.zip'));
  const partial = path.join(cache.directory, `${'4'.repeat(64)}.11111111-1111-1111-1111-111111111111.part`);
  await writeFile(partial, '中断写入'); await writeFile(path.join(cache.directory, 'unrelated.txt'), '保留');
  cache.maxBytes = f.content.length; await cache.prune();
  assert.equal((await readdir(cache.directory)).filter(n => n.endsWith('.zip')).length, 1);
  assert.equal(await readFile(path.join(cache.directory, 'unrelated.txt'), 'utf8'), '保留');
  await assert.rejects(readFile(partial), { code: 'ENOENT' });
});

test('连续完成任务立即领取下一项，空闲和异常仍有退避', async () => {
  const runner = new AgentRunner({ centerUrl: 'https://center.example', logger: { warn() {} } });
  let calls = 0;
  const start = performance.now();
  await runner.loop('任务', async () => { if (++calls === 3) runner.stop(); return true; }, 1000);
  assert.equal(calls, 3); assert.ok(performance.now() - start < 900);
  runner.stopped = false; calls = 0;
  const idleStart = performance.now();
  await runner.loop('任务', async () => { if (++calls === 1) throw new Error('暂时断线'); if (calls === 3) runner.stop(); }, 30);
  assert.ok(performance.now() - idleStart >= 50);
});

test('试构建完成只补报结果，不强制触发版本和构建缓存清理', async () => {
  const runner = new AgentRunner({ centerUrl: 'https://center.example', logger: { warn() {} } });
  runner.identity = { mode: 'managed' };
  runner.lock = { held: true };
  runner.flushEvents = async () => {};
  runner.heartbeat = async () => {};
  runner.client.post = async () => ({ task: { id: 'trial', action: 'build-check' } });
  runner.journal.get = async () => null;
  runner.executor.execute = async () => {};
  let maintenanceCalls = 0;
  // 领取前保留正常的周期维护，试构建结束不额外触发维护。
  runner.maintain = async () => { maintenanceCalls++; };
  assert.equal(await runner.tick(), true);
  assert.equal(maintenanceCalls, 1);
  assert.notEqual(runner.maintenanceDue, true);
});
