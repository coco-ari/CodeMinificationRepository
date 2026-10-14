import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApplication } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

async function fixture(t, builderHook = async () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cmr-lifecycle-test-')), apps = []; const content = Buffer.from('固定源码');
  const builder = () => ({ async initialize() { await mkdir(path.join(root, 'cache'), { recursive: true }); }, async build() {
    await builderHook(); const file = path.join(root, 'cache', 'source.zip'); await writeFile(file, content);
    return { file, revision: 'a'.repeat(40), sha256: createHash('sha256').update(content).digest('hex'), size: content.length, cached: false };
  } });
  const f = { root, apps };
  f.start = async () => { f.app = await createApplication({ directory: root, builder: builder(), secureCookies: false }); apps.push(f.app); await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve)); f.url = `http://127.0.0.1:${f.app.server.address().port}`; };
  f.post = async (route, body, auth = {}) => fetch(f.url + route, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) });
  f.login = async (setup = false) => {
    const response = await f.post(setup ? '/api/setup' : '/api/login', { username: 'admin', password: 'lifecycle-admin-password', ...(setup ? { bootstrapToken: f.app.service.bootstrapToken } : {}) });
    assert.equal(response.status, 200); return { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await response.json()).csrf };
  };
  f.stream = async auth => { const response = await fetch(f.url + '/api/deploy/events', { headers: auth }); assert.equal(response.status, 200); const reader = response.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /connected/); return reader; };
  t.after(async () => { for (const app of apps) await app.close({ timeoutMs: 1000 }); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('cmr-lifecycle-test-')) throw new Error('临时目录范围错误'); await rm(root, { recursive: true, force: true }); });
  await f.start(); f.auth = await f.login(true); return f;
}
async function stopped(reader) {
  let timer;
  try {
    // 允许读取失效之前已经发送的缓冲数据，随后必须及时结束连接。
    await Promise.race([(async () => { while (!(await reader.read()).done) {} })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('已失效的 SSE 没有及时关闭')), 1500); })]);
  }
  finally { clearTimeout(timer); }
}
async function createTarget(app) {
  const source = await app.service.saveProject({ name: '演示源码', repository: 'https://gitee.com/example/demo.git', branch: 'main' });
  const application = await app.deployment.saveEntity('applications', { name: '演示项目' });
  const environment = await app.deployment.saveEntity('environments', { name: '隔离验证', applicationId: application.id, sourceProjectId: source.project.id });
  const service = await app.deployment.saveEntity('services', { name: '演示服务', applicationId: application.id, module: '.' });
  const server = await app.deployment.createServer({ name: '验证服务器', mode: 'managed' });
  const agent = await app.deployment.register({ registrationToken: server.registrationToken, version: 'test' });
  const target = await app.deployment.saveEntity('targets', { environmentId: environment.id, serviceId: service.id, serverId: agent.serverId, mode: 'managed', config: {} });
  return { target, agent };
}

test('退出登录立即关闭该会话 SSE，其他有效会话继续收到事件', async t => {
  const f = await fixture(t); const other = await f.login(); const first = await f.stream(f.auth), second = await f.stream(other);
  assert.equal((await f.post('/api/logout', {}, f.auth)).status, 200); await stopped(first);
  f.app.deployment.changed('test', 'still-authorized');
  assert.match(new TextDecoder().decode((await second.read()).value), /still-authorized/);
  assert.equal((await fetch(f.url + '/api/deploy/events', { headers: f.auth })).status, 401);
  await second.cancel();
});

test('修改密码立即撤销所有已打开 SSE，旧会话无法重连', async t => {
  const f = await fixture(t); const other = await f.login(); const first = await f.stream(f.auth), second = await f.stream(other);
  assert.equal((await f.post('/api/password', { currentPassword: 'lifecycle-admin-password', password: 'lifecycle-new-password' }, f.auth)).status, 200);
  await Promise.all([stopped(first), stopped(second)]);
  for (const headers of [f.auth, other]) assert.equal((await fetch(f.url + '/api/deploy/events', { headers })).status, 401);
});

test('优雅关闭结束 SSE 和领取长轮询，等待准备源码提交完成后才返回', async t => {
  let release, started; const gate = new Promise(resolve => { release = resolve; }), beginning = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async () => { started(); await gate; }); const { target, agent } = await createTarget(f.app);
  const stream = await f.stream(f.auth); const task = await f.app.deployment.createTask({ targetId: target.id, action: 'deploy' }); await beginning;
  const claim = f.post('/api/agent/v1/claim', {}, { authorization: `Bearer ${agent.token}` });
  // 确保长轮询已经进入等待，再触发关闭，避免把连接拒绝误当作正常唤醒。
  for (let attempt = 0; attempt < 100 && f.app.deployment.listenerCount('shutdown') === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  let done = false; const closing = f.app.close({ timeoutMs: 5000 }).then(result => { done = true; return result; });
  await stopped(stream); assert.deepEqual(await (await claim).json(), { task: null });
  assert.equal(done, false); assert.equal(f.app.service.store.state.deployments.tasks.find(item => item.id === task.id).status, 'preparing');
  release(); assert.deepEqual(await closing, { graceful: true });
  await f.start(); const restored = f.app.deployment.data.tasks.find(item => item.id === task.id); assert.equal(restored.status, 'queued'); assert.equal(restored.source.revision, 'a'.repeat(40));
  assert.equal((await f.app.deployment.claim(agent.serverId)).id, task.id);
});

test('停止超时仍保留已持久化 preparing 状态，不误报成功或删除任务', async t => {
  let release, started; const gate = new Promise(resolve => { release = resolve; }), beginning = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async () => { started(); await gate; }); const { target } = await createTarget(f.app);
  const task = await f.app.deployment.createTask({ targetId: target.id, action: 'deploy' }); await beginning;
  try {
    assert.deepEqual(await f.app.close({ timeoutMs: 20 }), { graceful: false });
    const persisted = new Store(f.root); await persisted.open();
    const restored = persisted.state.deployments.tasks.find(item => item.id === task.id);
    assert.equal(restored.status, 'preparing'); assert.equal(restored.finishedAt, undefined); await persisted.close();
  } finally { release(); await f.app.deployment.close(); await f.app.service.store.close(); }
});

test('领取请求等待事务时开始停止，不再把新任务分配给 Agent', async t => {
  const f = await fixture(t); const { target, agent } = await createTarget(f.app);
  const task = await f.app.deployment.createTask({ targetId: target.id, action: 'deploy' }); await f.app.deployment.preparations.get(task.id);
  let release, started; const gate = new Promise(resolve => { release = resolve; }), beginning = new Promise(resolve => { started = resolve; });
  const pendingWrite = f.app.service.store.change(async () => { started(); await gate; }); await beginning;
  const pendingClaim = f.app.deployment.waitForTask(agent.serverId);
  const closing = f.app.close({ timeoutMs: 5000 }); release(); await pendingWrite;
  assert.equal(await pendingClaim, null); assert.deepEqual(await closing, { graceful: true });
  const saved = f.app.service.store.state.deployments.tasks.find(item => item.id === task.id);
  assert.equal(saved.status, 'queued'); assert.equal(saved.startedAt, undefined);
});
