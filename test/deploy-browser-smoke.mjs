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
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('未找到浏览器，请设置 BROWSER_PATH 后重试');
const dataDirectory = path.join(temporary, 'data');
let version = 1;
const builder = {
  async initialize() { await mkdir(dataDirectory, { recursive: true }); await writeFile(path.join(dataDirectory, 'test.zip'), 'isolated-source'); },
  async history(source, credential, refresh) { if(refresh)this.cachedHistory={commits:[{revision:String(version).repeat(40),author:'测试作者',subject:`第 ${version} 次提交`,at:new Date().toISOString()}],refreshedAt:new Date().toISOString()}; return this.cachedHistory || {commits:[],refreshedAt:null}; },
  async build(source, credential, onPhase) { for(const phase of ['source_fetch','source_resolve','source_archive']) await onPhase?.(phase); return { file: path.join(dataDirectory, 'test.zip'), revision: String(version).repeat(40),
    sha256: createHash('sha256').update('isolated-source').digest('hex'), size: 15, cached: false }; },
};
const { server, service, deployment, workspaces } = await createApplication({ directory: dataDirectory, builder, secureCookies: false });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
deployment.publicOrigin = base;
const initialProject = await workspaces.create({ name: 'SOL 标准版' });
await service.saveProject({ applicationId: initialProject.id, name: '独立演示源码', repository: 'https://gitee.com/example/demo.git', branch: 'main', enabled: true });
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
  const animationsSettled = () => evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  const fill = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)}); const prototype = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const click = async selector => {
    if (selector.startsWith('[data-view=') && !await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`)) {
      await evaluate(`document.querySelector('[data-sidebar="trigger"]').click()`);
      await visible(selector);
    }
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const visible = selector => until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`), selector);
  const clickText = async (text, parent = '.deploy-dialog[data-state=open]') => {
    const role = await evaluate(`Array.from(document.querySelector(${JSON.stringify(parent)}).querySelectorAll('button')).find(item=>item.textContent===${JSON.stringify(text)}).getAttribute('role')`);
    if(role !== 'tab') return evaluate(`Array.from(document.querySelector(${JSON.stringify(parent)}).querySelectorAll('button')).find(item=>item.textContent===${JSON.stringify(text)}).click()`);
    await animationsSettled();
    const point=await evaluate(`(()=>{const b=Array.from(document.querySelector(${JSON.stringify(parent)}).querySelectorAll('button')).find(item=>item.textContent===${JSON.stringify(text)});b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  };
  const closeModal = async () => { if(await evaluate('Boolean(document.querySelector("#task-workbench"))')) { await click('[data-close-task]'); await until(()=>evaluate('!document.querySelector("#task-workbench")'),'返回记录'); return; } await click('.deploy-dialog[data-state=open] [data-slot=dialog-close]'); await until(() => evaluate('!document.querySelector(".deploy-dialog[data-state=open]")'), '关闭弹窗'); };
  const saved = async () => {
    try { await until(() => evaluate('!document.querySelector(".deploy-dialog[data-state=open]")'), '保存配置'); }
    catch (error) { throw new Error(`${error.message}：${await evaluate('document.querySelector(".deploy-dialog[data-state=open] .form-error")?.textContent || Array.from(document.querySelectorAll(".deploy-dialog[data-state=open] :invalid")).map(item=>item.name).join(",")')}`); }
  };
  await command('Runtime.enable'); await command('Log.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: base }); await visible('#bootstrap-field');
  await fill('#auth-form [name=bootstrapToken]', service.bootstrapToken);
  await fill('#auth-form [name=username]', 'admin'); await fill('#auth-form [name=password]', 'isolated-browser-password');
  await click('#auth-form [type=submit]'); await visible('#app-view');
  await click(`[data-workspace-id="${initialProject.id}"] button`); await until(() => evaluate('document.querySelector("#workspace-name").textContent === "SOL 标准版"'), '进入项目');
  await click('[data-view=servers]'); await visible('#deploy-view'); await click('#create-button'); await visible('.deploy-dialog');
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
  const managedAgent = await agentRequest('register', { registrationToken: managedToken, version: '1.1.0-browser', capabilities: ['static-site-v1'] }); await closeModal();
  await click('[data-view=applications]'); await visible('[role=tablist]');
  await clickText('新增服务', '#deploy-view'); await fill('#deploy-name', 'API 服务'); await fill('#deploy-module', 'brezze-api');
  await click('.deploy-dialog [type=submit]'); await saved();
  await clickText('配置当前环境源码', '#deploy-view'); await fill('#deploy-branch', 'main'); await click('.deploy-dialog [type=submit]'); await saved();
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
  await until(() => evaluate(`!document.querySelector('[data-target-id="${managed.id}"] .card-actions button:first-child').disabled`), '平台目标可发布');
  await click(`[data-target-id="${managed.id}"] .card-actions button:first-child`); await visible('#confirm-release'); await click('#confirm-release'); await visible('#deploy-task-logs');
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
  async function screenshot(name) { await animationsSettled(); const result = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(artifactDirectory, name), Buffer.from(result.data, 'base64')); }
  await screenshot('deploy-task-desktop.png'); await closeModal();
  await click('[data-view=deployments]'); await visible('[data-target-id]');
  version = 2;
  await until(() => evaluate(`!document.querySelector('[data-target-id="${managed.id}"] .card-actions button:first-child').disabled`), '首次发布已解锁');
  await click(`[data-target-id="${managed.id}"] .card-actions button:first-child`); await visible('#confirm-release'); await click('#confirm-release'); await visible('#deploy-task-logs');
  await until(() => deployment.data.tasks.some(item => item.status === 'queued'), '第二版本源码准备');
  const second = (await agentRequest('claim', {}, managedAgent.token)).task;
  await agentRequest(`tasks/${second.id}/events`, { seq: 1, stage: 'verifying', status: 'succeeded', message: '第二版健康检查通过', result: { release: { id: second.id, revision: second.revision, image: `cmr/${managed.id}:${second.id}`, config: second.config } } }, managedAgent.token);
  await until(() => evaluate('document.querySelector("#deploy-task-info").textContent.includes("发布成功")'), '第二次发布成功'); await closeModal();
  await click('[data-view=deployments]'); await visible('[data-target-id]');
  await until(() => evaluate(`!document.querySelector('[data-target-id="${managed.id}"] .card-actions button:first-child').disabled`), '第二次发布已解锁');
  await clickText('回退版本', `[data-target-id="${managed.id}"]`); await visible('#deploy-releaseId');
  assert.equal(await evaluate('document.querySelector("#deploy-releaseId").value'), task.id);
  await visible('#confirm-release'); await click('#confirm-release'); await visible('#deploy-task-logs');
  const rollback = (await agentRequest('claim', {}, managedAgent.token)).task;
  assert.equal(rollback.action, 'rollback'); assert.equal(rollback.release.id, task.id);
  await agentRequest(`tasks/${rollback.id}/events`, { seq: 1, stage: 'verifying', status: 'succeeded', message: '回退后健康检查通过', result: { release: rollback.release } }, managedAgent.token);
  await until(() => evaluate('document.querySelector("#deploy-task-info").textContent.includes("回退成功")'), '回退显示独立结果'); await closeModal();
  assert.equal(deployment.data.targets.find(item => item.id === managed.id).currentRelease.id, task.id);
  await click('[data-view=servers]'); await screenshot('deploy-servers-desktop.png');
  await click('[data-view=deployments]'); await screenshot('deploy-targets-desktop.png');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until(() => evaluate('!document.querySelector("[data-slot=sidebar-gap]")'), '等待手机导航');
  for (const page of ['overview', 'servers', 'applications', 'deployments', 'tasks', 'projects']) {
    await click(`[data-view=${page}]`); await until(() => evaluate(`document.querySelector('#page-title').textContent === ${JSON.stringify({overview:'项目概览', servers:'服务器', applications:'环境与服务', deployments:'部署发布', tasks:'发布记录', projects:'代码仓库'}[page])}`), '切换页面'); assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, `${page} 手机页面横向溢出`);
  }
  await click('[data-view=deployments]'); await visible('[data-target-id]'); await screenshot('deploy-targets-mobile.png');
  await clickText('编辑配置', `[data-target-id="${observed.id}"]`);
  assert.equal(await evaluate('document.querySelector("#deploy-mode").disabled'), true); await closeModal();
  await service.store.change(state => { state.deployments.servers.find(item => item.id === observeAgent.serverId).lastSeenAt = new Date(Date.now() - 120000).toISOString(); });
  deployment.changed('heartbeat', observeAgent.serverId);
  await until(() => evaluate(`document.querySelector('[data-target-id="${observed.id}"]').textContent.includes('当前待确认')`), '失联不误报业务停止');
  await click('[data-view=tasks]'); await visible('.task-row'); await click('.task-row button'); await visible('#deploy-task-logs');
  await until(() => evaluate('document.querySelector("#deploy-task-logs").textContent.includes("健康检查通过")'), '重开详情补读日志');
  assert.equal(await evaluate('document.querySelector("#deploy-task-logs").textContent.match(/健康检查通过/g).length'), 1);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, '手机日志弹窗溢出');
  await screenshot('deploy-task-mobile.png');
  const taskUrl = await evaluate('location.href'); await command('Page.navigate', { url: taskUrl }); await visible('#deploy-task-logs');
  await until(() => evaluate('document.querySelector("#deploy-task-logs").textContent.includes("健康检查通过")'), '直接访问任务链接'); await closeModal();
  // 故意延迟旧项目响应，再切换项目，旧数据不可覆盖新空间。
  const another = await workspaces.create({ name: '办公项目' });
  await evaluate(`window.originalWorkspaceFetch = window.fetch; window.delayOldWorkspace = true; window.fetch = async (...args) => { const response = await window.originalWorkspaceFetch(...args); if (window.delayOldWorkspace && String(args[0]) === '/api/workspaces/${initialProject.id}') { window.delayOldWorkspace = false; window.oldWorkspaceResponsePending = true; await new Promise(resolve => { window.releaseOldWorkspaceResponse = resolve; }); } return response; }; location.hash = '/projects/${initialProject.id}/overview';`);
  await until(() => evaluate('window.oldWorkspaceResponsePending'), '延迟旧项目响应');
  await evaluate(`location.hash = '/projects/${another.id}/overview'`);
  await until(() => evaluate('document.querySelector("#workspace-name").textContent === "办公项目"'), '切换第二项目');
  await evaluate('window.releaseOldWorkspaceResponse(); window.fetch = window.originalWorkspaceFetch');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await evaluate('document.querySelector("#workspace-name").textContent'), '办公项目');
  assert.equal(await evaluate('document.querySelector("#deploy-view").textContent.includes("API 服务")'), false);
  await click('[data-view=servers]'); await visible('.bind-server'); await click('.bind-server'); await visible('#deploy-serverId');
  await fill('#deploy-serverId', managedAgent.serverId); await click('.deploy-dialog [type=submit]'); await saved();
  assert.ok(workspaces.overview(another.id).servers.some(item => item.id === managedAgent.serverId));
  assert.equal(workspaces.overview(another.id).targets.length, 0);
  await clickText('解除项目绑定', `[data-server-id="${managedAgent.serverId}"]`);
  await until(() => !workspaces.overview(another.id).servers.length, '解除项目绑定');
  assert.equal(deployment.data.servers.find(item => item.id === managedAgent.serverId).revoked, false);
  // 前端服务使用共用 Nginx，只配置构建和站点验证，不出现 Java 容器字段。
  await evaluate(`location.hash = '/projects/${initialProject.id}/applications'`);
  await until(() => evaluate('document.querySelector("#workspace-name").textContent === "SOL 标准版"'), '返回原项目');
  await visible('[data-service-id]');
  await clickText('新增服务', '#deploy-view'); await fill('#deploy-kind', 'static');
  await fill('#deploy-name', '管理前端'); await fill('#deploy-module', 'web');
  await click('.deploy-dialog [type=submit]'); await saved();
  const staticService = deployment.data.services.find(item => item.name === '管理前端');
  assert.equal(staticService.kind, 'static');
  await clickText('配置当前环境源码', `[data-service-id="${staticService.id}"]`);
  await fill('#deploy-branch', 'frontend-test'); await click('.deploy-dialog [type=submit]'); await saved();
  await click('[data-view=deployments]'); await click('#create-button');
  await fill('#deploy-serviceId', staticService.id); await fill('#deploy-serverId', managedAgent.serverId); await fill('#deploy-mode', 'managed');
  await visible('#deploy-healthUrl');
  assert.equal(await evaluate('document.querySelector("#deploy-artifactPath").value'), 'web/dist');
  assert.equal(await evaluate('document.querySelector("#deploy-buildImage").value'), 'node:24-bookworm-slim');
  assert.equal(await evaluate('Boolean(document.querySelector("#deploy-runtimeImage, #deploy-jvmArgs, #deploy-ports, #deploy-networks"))'), false);
  await fill('#deploy-packageManager', 'pnpm'); await fill('#deploy-packageManagerVersion', '10.11.0');
  await fill('#deploy-buildArgs', '--mode\ntest'); await fill('#deploy-healthUrl', 'https://app.example.test/');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, '前端配置手机布局溢出');
  await screenshot('static-config-mobile.png');
  await click('.deploy-dialog [type=submit]'); await saved();
  const staticTarget = deployment.data.targets.find(item => item.serviceId === staticService.id);
  assert.equal(staticTarget.config.kind, 'static'); assert.equal(staticTarget.containerName, null);
  assert.equal(staticTarget.config.packageManager, 'pnpm'); assert.deepEqual(staticTarget.config.buildArgs, ['--mode', 'test']);
  assert.equal(staticTarget.config.runtime, undefined);
  await visible(`[data-target-id="${staticTarget.id}"]`);
  assert.equal(await evaluate(`Array.from(document.querySelector('[data-target-id="${staticTarget.id}"]').querySelectorAll('button')).some(b => b.textContent === '重启')`), false);
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await clickText('编辑配置', `[data-target-id="${staticTarget.id}"]`); await visible('#deploy-healthUrl');
  assert.ok(await evaluate(`document.querySelector('.deploy-dialog[data-state=open]').textContent.includes('/opt/cmr-agent-static/${staticTarget.id}/current')`));
  assert.equal(await evaluate('document.querySelector("#deploy-healthUrl").value'), 'https://app.example.test/');
  await screenshot('static-config-desktop.png'); await closeModal();
  await clickText('更新', `[data-target-id="${staticTarget.id}"]`);
  await visible('#release-workbench'); assert.ok(await evaluate('document.querySelector("#release-workbench").textContent.includes("站点")'));
  await visible('#confirm-release'); await click('#confirm-release'); await visible('#deploy-task-logs');
  await until(() => deployment.data.tasks.some(item => item.targetId === staticTarget.id && item.status === 'queued'), '前端源码准备');
  const staticTask = (await agentRequest('claim', {}, managedAgent.token)).task;
  assert.equal(staticTask.config.kind, 'static');
  await agentRequest(`tasks/${staticTask.id}/events`, { seq: 1, stage: 'deploying', message: '正在切换静态版本目录' }, managedAgent.token);
  await until(() => evaluate('document.querySelector("#deploy-task-progress").textContent.includes("切换站点")'), '前端发布阶段');
  assert.equal(await evaluate('document.querySelector("#deploy-task-progress").textContent.includes("更新容器")'), false);
  await agentRequest(`tasks/${staticTask.id}/events`, { seq: 2, stage: 'verifying', status: 'succeeded', message: '共用 Nginx 已返回本次版本', result: { release: { id: staticTask.id, kind: 'static', artifact: `static/${staticTarget.id}/${staticTask.id}`, revision: staticTask.revision, config: staticTask.config } } }, managedAgent.token);
  await until(() => evaluate('document.querySelector("#deploy-task-result").textContent.includes("静态版本")'), '前端版本结果');
  await screenshot('static-release-desktop.png'); await closeModal();
  // 系统级能力切换不能把已有 Jenkins 观察目标变成受管目标，也不能更换 Agent 身份。
  await click('[data-view=system-servers]');
  const observedServerCard = `[data-server-id="${observeAgent.serverId}"]`;
  await visible(observedServerCard);
  await clickText('启用平台部署', observedServerCard); await visible('[role=alertdialog]');
  assert.match(await evaluate('document.querySelector("[role=alertdialog]").textContent'), /现有 Jenkins 观察目标保持只读/);
  await clickText('确认', '[role=alertdialog]');
  await until(() => deployment.data.servers.find(item => item.id === observeAgent.serverId).mode === 'managed', '启用平台部署');
  await until(() => evaluate('!document.querySelector("[role=alertdialog]")'), '关闭模式确认');
  assert.equal(deployment.authenticate(observeAgent.token), observeAgent.serverId);
  assert.equal(deployment.data.targets.find(item => item.id === observed.id).mode, 'observe');
  await clickText('切换为仅观察', observedServerCard); await visible('[role=alertdialog]');
  await clickText('确认', '[role=alertdialog]');
  await until(() => deployment.data.servers.find(item => item.id === observeAgent.serverId).mode === 'observe', '恢复仅观察');
  await until(() => evaluate('!document.querySelector("[role=alertdialog]")'), '关闭模式确认');
  assert.equal(deployment.authenticate(observeAgent.token), observeAgent.serverId);
  assert.equal(deployment.data.targets.find(item => item.id === observed.id).containerName, 'solstandard-java-brezze-api-1');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until(() => evaluate('!document.querySelector("[data-slot=sidebar-gap]")'), '响应式导航切换到手机');
  await click('[data-view=home]'); await visible('#workspace-home');
  await screenshot('workspace-home-mobile.png');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await screenshot('workspace-home-desktop.png');
  assert.equal(await evaluate('document.body.textContent.includes("项目空间")'), false);
  assert.equal(await evaluate('document.body.textContent.includes("进行中的任务")'), false);
  const homeCard = `[data-workspace-id="${initialProject.id}"]`;
  const heightBefore = await evaluate(`document.querySelector('${homeCard}').getBoundingClientRect().height`);
  // All environment services are visible in the card's scroll area, without expanding it.
  for(let i=0;i<6;i++) await workspaces.saveEntity(initialProject.id,'services',{name:`额外服务 ${i}`,module:'.'});
  await until(()=>evaluate(`document.querySelector('${homeCard}').textContent.includes('额外服务 5')`),'新增服务显示');
  assert.equal(await evaluate(`document.querySelector('${homeCard}').getBoundingClientRect().height`),heightBefore);
  await clickText('生产',homeCard);
  await until(()=>evaluate(`document.querySelector('${homeCard}').textContent.includes('未关联仓库')`),'生产环境独立源码');
  await clickText('测试',homeCard);
  await screenshot('prototype-home-desktop.png');
  await evaluate(`location.hash='/projects/${initialProject.id}/release?environment=${managed.environmentId}&target=${managed.id}'`);
  await visible('#release-workbench');
  assert.equal(await evaluate('Boolean(document.querySelector("[role=dialog]"))'),false);
  await click('#refresh-commits');
  await until(()=>evaluate('Boolean(document.querySelector("[data-commit]"))'),'刷新提交记录');
  assert.equal(await evaluate('document.querySelector("[data-commit]").getAttribute("aria-pressed")'),'true');
  assert.equal(deployment.data.tasks.length,4,'更新代码不应创建发布任务');
  await screenshot('prototype-release-desktop.png');
  const releaseUrl=await evaluate('location.href');
  await command('Page.navigate',{url:releaseUrl});await visible('#release-workbench');
  assert.equal(await evaluate('Boolean(document.querySelector("[role=dialog]"))'),false);
  // A selected commit is submitted as a full SHA, not silently replaced with latest.
  await click('[data-commit]');await click('#confirm-release');await visible('#deploy-task-logs');
  await until(()=>deployment.data.tasks.some(t=>t.status==='queued'),'指定提交准备');
  const pinned=(await agentRequest('claim',{},managedAgent.token)).task;
  assert.equal(pinned.sourceSnapshot.revision,String(version).repeat(40));
  await agentRequest(`tasks/${pinned.id}/events`,{seq:1,stage:'downloading',message:'下载'},managedAgent.token);
  await agentRequest(`tasks/${pinned.id}/events`,{seq:2,stage:'building',message:'编译'},managedAgent.token);
  await agentRequest(`tasks/${pinned.id}/events`,{seq:3,stage:'image',message:'镜像'},managedAgent.token);
  await agentRequest(`tasks/${pinned.id}/events`,{seq:4,stage:'deploying',message:'更新'},managedAgent.token);
  await agentRequest(`tasks/${pinned.id}/events`,{seq:5,stage:'verifying',message:'检查'},managedAgent.token);
  await agentRequest(`tasks/${pinned.id}/events`,{seq:6,stage:'verifying',status:'succeeded',message:'验证完成',result:{release:{id:pinned.id,revision:pinned.revision,image:`cmr/${managed.id}:${pinned.id}`,config:pinned.config}}},managedAgent.token);
  await until(()=>evaluate('document.querySelector("#deploy-task-progress").textContent.includes("构建镜像")'),'镜像独立阶段');
  assert.ok(await evaluate('document.querySelector("#deploy-task-progress").textContent.includes("中心服务")'));
  await screenshot('prototype-flow-desktop.png');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true);
  await screenshot('prototype-flow-mobile.png');
  await evaluate(`location.hash='/projects/${initialProject.id}/release?environment=${managed.environmentId}&target=${managed.id}'`);await visible('#release-workbench');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true);
  await screenshot('prototype-release-mobile.png');
  await evaluate(`location.hash='/projects/${initialProject.id}/configuration?environment=${managed.environmentId}&target=${managed.id}'`);await visible('#deploy-view');
  await until(()=>evaluate('document.body.textContent.includes("下次发布配置")'),'服务配置详情');
  await clickText('版本链','#deploy-view');await until(()=>evaluate('document.querySelector("#deploy-view").textContent.includes("当前版本")'),'版本链');
  await screenshot('prototype-configuration-mobile.png');
  await click('[data-view=home]');await visible('#workspace-home');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true);
  await screenshot('prototype-home-mobile.png');
  assert.deepEqual(errors, []);
  assert.ok(!warnings.some(item => /Content Security Policy|Refused to/.test(item)), warnings.join('\n'));
  console.log('部署浏览器验证通过：服务器接入、系统管理模式切换保留身份和观察目标、项目/环境/服务配置、观察权限、平台模板发布、SSE 日志、阶段耗时、历史版本回退、失联状态、日志转义、前端静态服务与共用 Nginx 配置、桌面与手机布局。');
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
