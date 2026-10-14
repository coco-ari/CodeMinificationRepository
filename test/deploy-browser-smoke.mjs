import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../src/server.mjs';

// 使用真实管理接口和模拟 Agent 回报验证界面，不连接任何远程服务器或 Docker。
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cmr-deploy-browser-'));
const candidates = [process.env.BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('未找到浏览器，请设置 BROWSER_PATH 后重试');
const dataDirectory = path.join(temporary, 'data');
let version = 1;
const builder = {
  async initialize() { await mkdir(dataDirectory, { recursive: true }); await writeFile(path.join(dataDirectory, 'test.zip'), 'isolated-source'); },
  async build() { return { file: path.join(dataDirectory, 'test.zip'), revision: String(version).repeat(40),
    sha256: createHash('sha256').update('isolated-source').digest('hex'), size: 15, cached: false }; },
};
const { server, service, deployment } = await createApplication({ directory: dataDirectory, builder, secureCookies: false });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
deployment.publicOrigin = base;
await service.saveProject({ name: '独立演示源码', repository: 'https://gitee.com/example/demo.git', branch: 'main', enabled: true });
const browserDirectory = path.join(temporary, 'browser');
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${browserDirectory}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
const errors = [], warnings = [];
async function until(action, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { const result = await action(); if (result) return result; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`等待失败：${label}`);
}
async function agentRequest(endpoint, body, token) {
  const response = await fetch(`${base}/api/agent/v1/${endpoint}`, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(body) });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
}
try {
  const port = await until(async () => Number((await readFile(path.join(browserDirectory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), '浏览器启动');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (value.id && pending.has(value.id)) {
      const { resolve, reject, timer } = pending.get(value.id); clearTimeout(timer); pending.delete(value.id);
      if (value.error) reject(new Error(value.error.message)); else resolve(value.result);
    }
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.text);
    if (value.method === 'Log.entryAdded' && value.params.entry.level === 'error') warnings.push(value.params.entry.text);
  });
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`浏览器命令超时：${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value;
  }
  const fill = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector.startsWith('#deploy-') ? `.deploy-dialog[open] ${selector}` : selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const visible = selector => until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`), selector);
  const clickText = (text, parent = '.deploy-dialog[open]') => evaluate(`Array.from(document.querySelector(${JSON.stringify(parent)}).querySelectorAll('button')).find(item=>item.textContent===${JSON.stringify(text)}).click()`);
  const closeModal = async () => { await click('.deploy-dialog[open] .icon-button'); await until(() => evaluate('!document.querySelector(".deploy-dialog[open]")'), '关闭弹窗'); };
  const saved = async () => {
    try { await until(() => evaluate('!document.querySelector(".deploy-dialog[open]")'), '保存配置'); }
    catch (error) { throw new Error(`${error.message}：${await evaluate('document.querySelector(".deploy-dialog[open] .form-error")?.textContent || Array.from(document.querySelectorAll(".deploy-dialog[open] :invalid")).map(item=>item.name).join(",")')}`); }
  };
  await command('Runtime.enable'); await command('Log.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: base }); await visible('#bootstrap-field');
  await fill('#auth-form [name=bootstrapToken]', service.bootstrapToken);
  await fill('#auth-form [name=username]', 'admin'); await fill('#auth-form [name=password]', 'isolated-browser-password');
  await click('#auth-form [type=submit]'); await visible('#app-view');
  await click('[data-view=servers]'); await click('#create-button'); await visible('.deploy-dialog');
  assert.equal(await evaluate('document.querySelector("#deploy-mode").value'), 'observe');
  await fill('#deploy-name', 'SOL 测试服务器 · Jenkins'); await click('.deploy-dialog [type=submit]');
  await visible('#deploy-installCommand');
  const commandValue = await evaluate('document.querySelector("#deploy-installCommand").value');
  const observeToken = commandValue.match(/'([A-Za-z0-9_-]{43})'$/)[1];
  const observeAgent = await agentRequest('register', { registrationToken: observeToken, version: '1.0.0-browser' });
  await closeModal(); assert.ok(!await evaluate(`document.body.textContent.includes(${JSON.stringify(observeToken)})`));
  await click('#create-button'); await fill('#deploy-name', '独立验证服务器'); await fill('#deploy-mode', 'managed');
  await click('.deploy-dialog [type=submit]'); await visible('#deploy-installCommand');
  const managedToken = (await evaluate('document.querySelector("#deploy-installCommand").value')).match(/'([A-Za-z0-9_-]{43})'$/)[1];
  const managedAgent = await agentRequest('register', { registrationToken: managedToken, version: '1.0.0-browser' }); await closeModal();
  await click('[data-view=applications]'); await click('#create-button');
  await fill('#deploy-name', 'SOL 标准版'); await click('.deploy-dialog [type=submit]'); await saved();
  await clickText('＋ 新增环境', '#deploy-view'); await fill('#deploy-name', '独立验证'); await click('.deploy-dialog [type=submit]'); await saved();
  await clickText('＋ 新增Java 服务', '#deploy-view'); await fill('#deploy-name', 'API 服务'); await fill('#deploy-module', 'brezze-api');
  await click('.deploy-dialog [type=submit]'); await saved();
  await click('[data-view=deployments]'); await click('#create-button');
  await fill('#deploy-containerName', 'solstandard-java-brezze-api-1'); await click('.deploy-dialog [type=submit]'); await saved();
  const observed = deployment.data.targets.find(item => item.mode === 'observe');
  const metrics = { cpuPercent: 18.5, memory: { used: 2.1 * 1024 ** 3, total: 3.5 * 1024 ** 3 }, disk: { used: 17 * 1024 ** 3, total: 50 * 1024 ** 3 } };
  await agentRequest('heartbeat', { metrics, containers: [{ targetId: observed.id, containerName: observed.containerName, status: 'running', health: 'healthy', restartCount: 0, image: 'solstandard/brezze-api:jenkins', observedAt: new Date().toISOString() }] }, observeAgent.token);
  await until(() => evaluate(`document.querySelector('[data-target-id="${observed.id}"]').textContent.includes('健康')`), '观察状态更新');
  assert.equal(await evaluate(`Array.from(document.querySelector('[data-target-id="${observed.id}"]').querySelectorAll('.card-actions button')).slice(0,3).every(item=>item.disabled)`), true);
  await click('#create-button'); await fill('#deploy-serverId', managedAgent.serverId); await fill('#deploy-mode', 'managed');
  assert.equal(await evaluate('document.querySelector("#deploy-artifactPath").value'), 'brezze-api/target/*.jar');
  await fill('#deploy-healthPath', '/api/swagger-resources'); await fill('#deploy-healthBody', 'swaggerVersion');
  await click('.deploy-dialog [type=submit]'); await saved();
  const managed = deployment.data.targets.find(item => item.mode === 'managed');
  assert.equal(managed.config.health.path, '/api/swagger-resources'); assert.equal(managed.config.runtime.memoryMb, 512);
  await agentRequest('heartbeat', { metrics, containers: [] }, managedAgent.token);
  await until(() => evaluate(`!document.querySelector('[data-target-id="${managed.id}"] .primary').disabled`), '平台目标可发布');
  await click(`[data-target-id="${managed.id}"] .primary`); await click('.deploy-dialog [type=submit]'); await visible('#deploy-task-logs');
  await until(() => deployment.data.tasks.some(item => item.status === 'queued'), '准备源码');
  const { task } = await agentRequest('claim', {}, managedAgent.token);
  await agentRequest(`tasks/${task.id}/events`, { seq: 1, stage: 'downloading', message: '完整源码包下载完成，校验通过' }, managedAgent.token);
  await agentRequest(`tasks/${task.id}/events`, { seq: 2, stage: 'building', message: '正在编译 brezze-api 及公共依赖\n<script>window.invalidLog=true</script>' }, managedAgent.token);
  await until(() => evaluate('document.querySelector("#deploy-task-logs").textContent.includes("公共依赖")'), 'SSE 实时日志');
  assert.equal(await evaluate('Boolean(window.invalidLog)'), false);
  await agentRequest(`tasks/${task.id}/events`, { seq: 3, stage: 'deploying', message: '镜像构建完成，开始更新目标容器' }, managedAgent.token);
  await agentRequest(`tasks/${task.id}/events`, { seq: 4, stage: 'verifying', message: '正在检查 HTTP 响应' }, managedAgent.token);
  await agentRequest(`tasks/${task.id}/events`, { seq: 5, stage: 'verifying', status: 'succeeded', message: '健康检查通过', result: { release: { id: task.id, revision: task.revision, image: `cmr/${managed.id}:${task.id}`, config: task.config } } }, managedAgent.token);
  await until(() => evaluate('document.querySelector("#deploy-task-info").textContent.includes("发布成功")'), '成功结果');
  const artifactDirectory = path.resolve('.test-artifacts'); await mkdir(artifactDirectory, { recursive: true });
  async function screenshot(name) { const result = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(artifactDirectory, name), Buffer.from(result.data, 'base64')); }
  await screenshot('deploy-task-desktop.png'); await closeModal();
  version = 2;
  await until(() => evaluate(`!document.querySelector('[data-target-id="${managed.id}"] .primary').disabled`), '首次发布已解锁');
  await click(`[data-target-id="${managed.id}"] .primary`); await click('.deploy-dialog [type=submit]'); await visible('#deploy-task-logs');
  await until(() => deployment.data.tasks.some(item => item.status === 'queued'), '第二版本源码准备');
  const second = (await agentRequest('claim', {}, managedAgent.token)).task;
  await agentRequest(`tasks/${second.id}/events`, { seq: 1, stage: 'verifying', status: 'succeeded', message: '第二版健康检查通过', result: { release: { id: second.id, revision: second.revision, image: `cmr/${managed.id}:${second.id}`, config: second.config } } }, managedAgent.token);
  await until(() => evaluate('document.querySelector("#deploy-task-info").textContent.includes("发布成功")'), '第二次发布成功'); await closeModal();
  await until(() => evaluate(`!document.querySelector('[data-target-id="${managed.id}"] .primary').disabled`), '第二次发布已解锁');
  await clickText('回退版本', `[data-target-id="${managed.id}"]`); await visible('#deploy-releaseId');
  assert.equal(await evaluate('document.querySelector("#deploy-releaseId").value'), task.id);
  await click('.deploy-dialog [type=submit]'); await visible('#deploy-task-logs');
  const rollback = (await agentRequest('claim', {}, managedAgent.token)).task;
  assert.equal(rollback.action, 'rollback'); assert.equal(rollback.release.id, task.id);
  await agentRequest(`tasks/${rollback.id}/events`, { seq: 1, stage: 'verifying', status: 'succeeded', message: '回退后健康检查通过', result: { release: rollback.release } }, managedAgent.token);
  await until(() => evaluate('document.querySelector("#deploy-task-info").textContent.includes("回退成功")'), '回退显示独立结果'); await closeModal();
  assert.equal(deployment.data.targets.find(item => item.id === managed.id).currentRelease.id, task.id);
  await click('[data-view=servers]'); await screenshot('deploy-servers-desktop.png');
  await click('[data-view=deployments]'); await screenshot('deploy-targets-desktop.png');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const page of ['servers', 'applications', 'deployments', 'tasks', 'projects', 'credentials']) {
    await click(`[data-view=${page}]`); assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, `${page} 手机页面横向溢出`);
  }
  await click('[data-view=deployments]'); await screenshot('deploy-targets-mobile.png');
  await clickText('编辑配置', `[data-target-id="${observed.id}"]`);
  assert.equal(await evaluate('document.querySelector("#deploy-mode").disabled'), true); await closeModal();
  await service.store.change(state => { state.deployments.servers.find(item => item.id === observeAgent.serverId).lastSeenAt = new Date(Date.now() - 120000).toISOString(); });
  deployment.changed('heartbeat', observeAgent.serverId);
  await until(() => evaluate(`document.querySelector('[data-target-id="${observed.id}"]').textContent.includes('当前待确认')`), '失联不误报业务停止');
  await click('[data-view=tasks]'); await click('.task-row .secondary'); await visible('#deploy-task-logs');
  await until(() => evaluate('document.querySelector("#deploy-task-logs").textContent.includes("健康检查通过")'), '重开详情补读日志');
  assert.equal(await evaluate('document.querySelector("#deploy-task-logs").textContent.match(/健康检查通过/g).length'), 1);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, '手机日志弹窗溢出');
  await screenshot('deploy-task-mobile.png'); await closeModal();
  assert.deepEqual(errors, []);
  assert.ok(!warnings.some(item => /Content Security Policy|Refused to/.test(item)), warnings.join('\n'));
  console.log('部署浏览器验证通过：服务器接入、项目/环境/服务配置、观察权限、平台模板发布、SSE 日志、阶段耗时、历史版本回退、失联状态、日志转义、桌面与手机布局。');
  console.log(`截图目录：${artifactDirectory}`);
} finally {
  socket?.close(); browser.kill();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await deployment.close(); await service.store.close();
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('cmr-deploy-browser-')) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
