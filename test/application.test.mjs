import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { RepositoryService } from '../src/service.mjs';
import { ArchiveBuilder, validateRepository, validateBranch } from '../src/archive.mjs';
import { createApplication } from '../src/server.mjs';
import { HttpError } from '../src/security.mjs';

const execute = promisify(execFile);
const projectInput = { name: '客户 A', repository: 'https://gitee.com/example/project.git', branch: 'main', enabled: true };

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cmr-test-'));
  t.after(async () => {
    // 只删除本测试创建的临时目录，先检查目标范围。
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cmr-test-')) throw new Error('临时目录范围错误');
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
function mockBuilder(directory) {
  return {
    calls: 0, failure: null, gate: null,
    async initialize() { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'archive.zip'), 'archive-content'); },
    async build(project, credential) {
      this.calls++; this.credential = credential;
      if (this.gate) await this.gate;
      if (this.failure) throw this.failure;
      return { file: path.join(directory, 'archive.zip'), revision: 'a'.repeat(40), sha256: createHash('sha256').update('archive-content').digest('hex'), size: 15, cached: this.calls > 1 };
    },
  };
}
async function fixture(t) {
  const directory = await temporary(t);
  const builder = mockBuilder(directory);
  const service = new RepositoryService({ directory, builder }); await service.initialize();
  return { directory, builder, service };
}
async function waitFor(condition) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('等待测试条件超时');
}

test('仓库地址与分支仅允许明确的 Gitee HTTPS 目标', () => {
  assert.equal(validateRepository(projectInput.repository), projectInput.repository);
  assert.equal(validateBranch('release/customer-a'), 'release/customer-a');
  for (const url of ['file:///etc/passwd', 'https://127.0.0.1/project.git', 'https://gitee.com.evil.com/a/b',
    'https://user:secret@gitee.com/a/b', 'https://gitee.com/a/b?ref=main', 'https://gitee.com/a/..', 'https://gitee.com/../b', 'https://gitee.com:444/a/b']) {
    assert.throws(() => validateRepository(url), HttpError);
  }
  for (const branch of ['--upload-pack=evil', 'main:other', '../main', 'main~1', 'refs/*', '.hidden', 'a//b', 'a.lock', 'a\\b', 'main\n']) {
    assert.throws(() => validateBranch(branch), HttpError);
  }
});

test('下载密码隔离项目，重置及停用立即阻止新请求', async t => {
  const { service } = await fixture(t);
  const a = await service.saveProject(projectInput);
  const b = await service.saveProject({ ...projectInput, name: '客户 B' });
  assert.equal(service.authorizeDownload(a.project.id, a.token).id, a.project.id);
  assert.throws(() => service.authorizeDownload(b.project.id, a.token), { status: 401 });
  const rotated = await service.rotateToken(a.project.id);
  assert.throws(() => service.authorizeDownload(a.project.id, a.token), { status: 401 });
  service.authorizeDownload(a.project.id, rotated.token);
  await service.setEnabled(a.project.id, false);
  assert.throws(() => service.authorizeDownload(a.project.id, rotated.token), { status: 401 });
  assert.ok(!JSON.stringify(service.overview()).includes(rotated.token));
  assert.ok(!JSON.stringify(service.overview()).includes('tokenHash'));
});

test('凭证加密存储，重启后能使用，接口不返回秘密', async t => {
  const { directory, builder, service } = await fixture(t);
  const password = ' gitee-private-password-that-must-stay-secret ';
  const credential = await service.saveCredential({ name: '只读凭证', username: 'reader', password });
  const created = await service.saveProject({ ...projectInput, credentialId: credential.id });
  const file = await readFile(path.join(directory, 'state.json'), 'utf8');
  assert.ok(!file.includes(password)); assert.ok(!file.includes(created.token));
  const restored = new RepositoryService({ directory, builder }); await restored.initialize();
  restored.authorizeDownload(created.project.id, created.token);
  await restored.sync(created.project.id);
  assert.deepEqual(builder.credential, { username: 'reader', password });
  assert.ok(!JSON.stringify(restored.overview()).includes(password));
  await assert.rejects(restored.deleteCredential(credential.id), { status: 409 });
});

test('并发下载共享同步，下一次下载仍重新检查远端', async t => {
  const { service, builder } = await fixture(t);
  const created = await service.saveProject(projectInput);
  let release; builder.gate = new Promise(resolve => { release = resolve; });
  const first = service.sync(created.project.id);
  const second = service.sync(created.project.id);
  await waitFor(() => builder.calls === 1);
  await assert.rejects(service.saveProject(projectInput, created.project.id), { status: 409 });
  release(); const results = await Promise.all([first, second]);
  assert.equal(results[0].revision, results[1].revision); assert.equal(builder.calls, 1);
  await service.sync(created.project.id); assert.equal(builder.calls, 2);
});

test('同步失败不会返回上一次成功的包，失败后可重试', async t => {
  const { service, builder } = await fixture(t);
  const created = await service.saveProject(projectInput); await service.sync(created.project.id);
  builder.failure = new HttpError(502, '远端不可用');
  await assert.rejects(service.sync(created.project.id), { status: 502 });
  assert.equal(service.overview().projects[0].status, 'failed');
  assert.equal(service.overview().projects[0].lastSuccess.revision, 'a'.repeat(40));
  builder.failure = null; await service.sync(created.project.id);
  assert.equal(service.overview().projects[0].status, 'ready');
});

test('全局队列限制并发和积压任务', async t => {
  const directory = await temporary(t); const builder = mockBuilder(directory);
  let release; builder.gate = new Promise(resolve => { release = resolve; });
  const service = new RepositoryService({ directory, builder, maxConcurrent: 1, maxPending: 1 }); await service.initialize();
  const projects = [];
  for (let i = 0; i < 3; i++) projects.push(await service.saveProject({ ...projectInput, name: `项目 ${i}` }));
  const first = service.sync(projects[0].project.id); await waitFor(() => builder.calls === 1);
  const second = service.sync(projects[1].project.id); await waitFor(() => service.queue.waiters.length === 1);
  await assert.rejects(service.sync(projects[2].project.id), { status: 503 });
  assert.equal(builder.calls, 1); release(); await Promise.all([first, second]); assert.equal(builder.calls, 2);
});

test('HTTP 初始化、登录、CSRF、下载鉴权及响应头完整闭环', async t => {
  const directory = await temporary(t); const builder = mockBuilder(directory);
  const app = await createApplication({ directory, builder, secureCookies: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (url, method = 'GET', value, headers = {}) => fetch(base + url, { method, headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(value ? { body: JSON.stringify(value) } : {}) });
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await request('/api/overview')).status, 401);
  const setup = { bootstrapToken: app.service.bootstrapToken, username: 'admin', password: 'safe-admin-password' };
  assert.equal((await request('/api/setup', 'POST', { ...setup, bootstrapToken: 'wrong' })).status, 401);
  const response = await request('/api/setup', 'POST', setup); assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0]; assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  const session = await response.json();
  const auth = { Cookie: cookie, 'X-CSRF-Token': session.csrf };
  assert.equal((await request('/api/projects', 'POST', projectInput, { Cookie: cookie })).status, 403);
  assert.equal((await request('/api/projects', 'POST', projectInput, { ...auth, Origin: 'https://evil.invalid' })).status, 403);
  const createdResponse = await request('/api/projects', 'POST', projectInput, auth); assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json(); const endpoint = `/api/projects/${created.project.id}/source/latest`;
  assert.equal((await request(`/download/${created.project.id}`)).status, 200);
  assert.equal((await request(endpoint)).status, 401); assert.equal(builder.calls, 0);
  assert.equal((await request(`${endpoint}?password=${created.token}`)).status, 401); assert.equal(builder.calls, 0);
  const archive = await request(endpoint, 'GET', null, { Authorization: `Bearer ${created.token}` });
  assert.equal(archive.status, 200); assert.equal(archive.headers.get('content-type'), 'application/zip');
  assert.equal(archive.headers.get('x-source-revision'), 'a'.repeat(40));
  assert.equal(archive.headers.get('x-archive-sha256'), createHash('sha256').update('archive-content').digest('hex'));
  assert.equal(await archive.text(), 'archive-content');
  builder.failure = new HttpError(502, '拉取失败');
  assert.equal((await request(endpoint, 'GET', null, { Authorization: `Bearer ${created.token}` })).status, 502);
  builder.failure = null;
  await request(`/api/projects/${created.project.id}/rotate-token`, 'POST', {}, auth);
  assert.equal((await request(endpoint, 'GET', null, { Authorization: `Bearer ${created.token}` })).status, 401);
  const changed = await request('/api/password', 'POST', { currentPassword: setup.password, password: 'new-safe-admin-password' }, auth);
  assert.equal(changed.status, 200); assert.equal((await request('/api/overview', 'GET', null, auth)).status, 401);
  assert.equal((await request('/api/login', 'POST', { username: 'admin', password: 'new-safe-admin-password' })).status, 200);
});

test('等待同步时密码被重置，已排队的旧密码请求也不能获取文件', async t => {
  const directory = await temporary(t); const builder = mockBuilder(directory);
  let release; builder.gate = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ directory, builder, secureCookies: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const created = await app.service.saveProject(projectInput);
  const pending = fetch(`http://127.0.0.1:${app.server.address().port}/api/projects/${created.project.id}/source/latest`, { headers: { Authorization: `Bearer ${created.token}` } });
  await waitFor(() => builder.calls === 1); await app.service.rotateToken(created.project.id); release();
  assert.equal((await pending).status, 401);
});

async function git(directory, ...args) {
  return (await execute('git', ['-c', 'user.name=测试用户', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-C', directory, ...args], { windowsHide: true })).stdout.trim();
}
function zipFiles(buffer) {
  const entries = new Map();
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, '应包含有效 ZIP 尾部');
  let cursor = buffer.readUInt32LE(end + 16);
  const count = buffer.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10); const size = buffer.readUInt32LE(cursor + 20);
    const nameSize = buffer.readUInt16LE(cursor + 28); const extraSize = buffer.readUInt16LE(cursor + 30); const commentSize = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42); const name = buffer.subarray(cursor + 46, cursor + 46 + nameSize).toString();
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const compressed = buffer.subarray(start, start + size);
    entries.set(name, (method === 8 ? inflateRawSync(compressed) : compressed).toString());
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  return entries;
}

test('真实 Git 集成：只交付指定分支最新源码，不包含历史与其他分支，支持缓存和新提交', async t => {
  const directory = await temporary(t); const repository = path.join(directory, 'source'); await mkdir(repository);
  await git(repository, 'init', '-b', 'main');
  await writeFile(path.join(repository, 'old-secret.txt'), '历史机密'); await git(repository, 'add', '.'); await git(repository, 'commit', '-m', '初始提交');
  await git(repository, 'checkout', '-b', 'internal'); await writeFile(path.join(repository, 'internal-only.txt'), '其他分支机密');
  await git(repository, 'add', '.'); await git(repository, 'commit', '-m', '内部功能'); await git(repository, 'checkout', 'main');
  await git(repository, 'rm', 'old-secret.txt');
  await writeFile(path.join(repository, 'app.txt'), '客户源码版本一');
  await writeFile(path.join(repository, '.gitattributes'), 'private.txt export-ignore\n');
  await writeFile(path.join(repository, 'private.txt'), '禁止交付');
  await git(repository, 'add', '.'); await git(repository, 'commit', '-m', '交付版本一');
  const builder = new ArchiveBuilder(path.join(directory, 'cache'), { allowLocal: true }); await builder.initialize();
  const project = { id: randomUUID(), repository, branch: 'main' };
  const first = await builder.build(project, null); const files = zipFiles(await readFile(first.file));
  assert.equal(files.get('app.txt'), '客户源码版本一');
  for (const name of ['old-secret.txt', 'internal-only.txt', 'private.txt', '.git/config']) assert.ok(!files.has(name));
  assert.ok(![...files.keys()].some(name => name.startsWith('.git/')));
  assert.equal(first.revision, await git(repository, 'rev-parse', 'HEAD')); assert.equal(first.cached, false);
  const same = await builder.build(project, null); assert.equal(same.cached, true); assert.equal(same.sha256, first.sha256);
  await writeFile(path.join(repository, 'app.txt'), '客户源码版本二'); await git(repository, 'add', '.'); await git(repository, 'commit', '-m', '交付版本二');
  const next = await builder.build(project, null); assert.notEqual(next.revision, first.revision);
  assert.equal(zipFiles(await readFile(next.file)).get('app.txt'), '客户源码版本二');
  await assert.rejects(builder.build({ ...project, branch: 'missing' }, null), { status: 502 });
  await writeFile(path.join(repository, 'model.bin'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n');
  await git(repository, 'add', '.'); await git(repository, 'commit', '-m', '添加 LFS 指针');
  await assert.rejects(builder.build(project, null), { status: 422 });
});

test('源码包大小限制生效且不会发布临时文件', async t => {
  const directory = await temporary(t); const repository = path.join(directory, 'source'); await mkdir(repository);
  await git(repository, 'init', '-b', 'main'); await writeFile(path.join(repository, 'file.txt'), '交付内容');
  await git(repository, 'add', '.'); await git(repository, 'commit', '-m', '初始化');
  const builder = new ArchiveBuilder(path.join(directory, 'cache'), { allowLocal: true, maxArchiveBytes: 1 }); await builder.initialize();
  await assert.rejects(builder.build({ id: randomUUID(), repository, branch: 'main' }, null), { status: 413 });
});

test('真实 HTTP Git 鉴权通过 askpass 注入，凭证不写入缓存配置', async t => {
  const directory = await temporary(t); const source = path.join(directory, 'source'); await mkdir(source);
  await git(source, 'init', '-b', 'main'); await writeFile(path.join(source, 'app.txt'), '需要凭证的源码');
  await git(source, 'add', '.'); await git(source, 'commit', '-m', '初始化');
  await git(directory, 'clone', '--bare', source, path.join(directory, 'source.git'));
  const credential = { username: 'delivery-reader', password: 'test-http-private-password' };
  const expected = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`;
  let authorized = 0;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }); res.end(); return;
    }
    authorized++;
    const url = new URL(req.url, 'http://localhost');
    const backend = spawn('git', ['http-backend'], { windowsHide: true, env: {
      ...process.env, GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname,
      REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '',
      REMOTE_USER: credential.username, SERVER_PROTOCOL: 'HTTP/1.1',
    } });
    const chunks = []; backend.stdout.on('data', data => chunks.push(data)); backend.stderr.resume();
    backend.on('error', () => { res.writeHead(500); res.end(); });
    backend.on('close', code => {
      if (res.writableEnded) return;
      if (code !== 0) { res.writeHead(500); res.end(); return; }
      const output = Buffer.concat(chunks); const index = output.indexOf('\r\n\r\n');
      if (index < 0) { res.writeHead(500); res.end(); return; }
      const headers = {}; let status = 200;
      for (const line of output.subarray(0, index).toString().split('\r\n')) {
        const separator = line.indexOf(':'); const key = line.slice(0, separator); const value = line.slice(separator + 1).trim();
        if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]); else headers[key] = value;
      }
      res.writeHead(status, headers); res.end(output.subarray(index + 4));
    });
    req.pipe(backend.stdin); backend.stdin.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const builder = new ArchiveBuilder(path.join(directory, 'cache with spaces'), { allowLocal: true }); await builder.initialize();
  const id = randomUUID();
  const result = await builder.build({ id, repository: `http://127.0.0.1:${server.address().port}/source.git`, branch: 'main' }, credential);
  assert.equal(zipFiles(await readFile(result.file)).get('app.txt'), '需要凭证的源码'); assert.ok(authorized >= 2);
  const config = await readFile(path.join(directory, 'cache with spaces', id, 'repository.git', 'config'), 'utf8');
  assert.ok(!config.includes(credential.password)); assert.ok(!config.includes(credential.username));
});
