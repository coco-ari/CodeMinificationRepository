import { promisify } from 'node:util';
import { ArchiveBuilder } from '../src/archive.mjs';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApplication } from '../src/server.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'cmr-browser-'));
const candidates = [process.env.BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('未找到浏览器，请设置 BROWSER_PATH 后重试');

const dataDirectory = path.join(temporary, 'data');
const localRepository = path.join(temporary,'repository');
await mkdir(localRepository);
const exec = promisify(execFile);
const git = (...args) => exec('git',['-c','user.name=测试','-c','user.email=test@example.invalid','-c','commit.gpgsign=false',...args],{cwd:localRepository});
await git('init','-b','release/vietnam'); await writeFile(path.join(localRepository,'app.js'),'export const answer = 42;\n'); await git('add','.'); await git('commit','-m','浏览器测试源码');
const archive = new ArchiveBuilder(path.join(temporary,'cache'),{allowLocal:true});
const builder = { initialize:() => archive.initialize(),build:project => archive.build({...project,repository:localRepository},null) };
const { server, service } = await createApplication({ directory: dataDirectory, builder, secureCookies: false });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browserDirectory = path.join(temporary, 'browser');
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${browserDirectory}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
const errors = [];
const warnings = [];
async function until(action, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { const result = await action(); if (result) return result; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`等待失败：${label}`);
}
try {
  const port = await until(async () => Number((await readFile(path.join(browserDirectory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), '浏览器启动');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject, timer } = pending.get(data.id); clearTimeout(timer); pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
    }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text);
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') warnings.push(data.params.entry.text);
  });
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`浏览器命令超时：${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  }
  const fill = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const visible = selector => until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`), selector);
  await command('Runtime.enable'); await command('Log.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: base });
  await visible('#bootstrap-field');
  await fill('#auth-form [name=bootstrapToken]', service.bootstrapToken);
  await fill('#auth-form [name=username]', 'admin'); await fill('#auth-form [name=password]', 'browser-test-password');
  await click('#auth-form [type=submit]'); await visible('#app-view');
  await click('[data-view=credentials]'); await click('#create-button'); await visible('#credential-dialog');
  await fill('#credential-form [name=name]', 'Gitee 交付专用账号'); await fill('#credential-form [name=username]', 'delivery-reader');
  await fill('#credential-form [name=password]', 'test-only-password'); await click('#credential-form [type=submit]');
  await until(() => evaluate('!document.querySelector("#credential-dialog").open'), '保存凭证');
  await click('[data-view=projects]'); await click('#create-button'); await visible('#project-dialog');
  await fill('#project-form [name=name]', '越南 SOL 标准版');
  await fill('#project-form [name=repository]', 'https://gitee.com/example/sol-standard.git');
  await fill('#project-form [name=branch]', 'release/vietnam');
  await fill('#project-form [name=credentialId]', service.store.state.credentials[0].id);
  await click('#project-form [name=sourceEnabled]'); await fill('#project-form [name=syncIntervalSeconds]','300');
  await click('#project-form [type=submit]'); await visible('#secret-dialog');
  const secret = await evaluate('document.querySelector("#secret-value").value'); assert.equal(secret.length, 43);
  assert.equal(await evaluate('document.querySelector("#secret-source-url").value'),base);
  assert.equal(await evaluate('document.querySelector("#secret-source-project").value'),service.store.state.projects[0].id);
  const publicUrl = await evaluate('document.querySelector("#secret-page").value');
  await click('#secret-dialog [data-close]');
  await until(() => evaluate('document.querySelector("#secret-value").value === ""'), '关闭弹窗后清除密码');
  await evaluate('Array.from(document.querySelectorAll(".card-actions button")).find(x => x.textContent === "立即同步").click()');
  await until(() => evaluate('document.querySelector(".project-card .badge").textContent === "已就绪"'), '手动同步');
  await until(() => evaluate('document.querySelector(".project-card").textContent.includes("1 个文件")'),'源码快照生成');
  assert.equal(service.store.state.projects[0].sourceEnabled,true); assert.equal(service.store.state.projects[0].syncIntervalSeconds,300);
  const head=await fetch(`${base}/api/v1/projects/${service.store.state.projects[0].id}/source/head`,{headers:{Authorization:`Bearer ${secret}`}});assert.equal(head.status,200);assert.equal((await head.json()).snapshot.fileCount,1);
  assert.equal(service.store.state.projects.length, 1);
  assert.equal(service.store.state.projects[0].branch, 'release/vietnam');
  assert.ok(!await evaluate('document.body.textContent.includes("test-only-password")'));
  const artifactDirectory = path.resolve('.test-artifacts'); await mkdir(artifactDirectory, { recursive: true });
  let screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(artifactDirectory, 'dashboard-desktop.png'), Buffer.from(screenshot.data, 'base64'));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(artifactDirectory, 'dashboard-mobile.png'), Buffer.from(screenshot.data, 'base64'));
  await command('Page.navigate', { url: publicUrl }); await visible('#download-view');
  assert.equal(await evaluate('document.querySelector("#app-view").hidden'), true);
  await fill('#download-form [name=token]', 'invalid'); await click('#download-form [type=submit]');
  await until(() => evaluate('document.querySelector("#download-error").textContent.includes("密码无效")'), '无效下载密码');
  assert.deepEqual(errors, []);
  assert.ok(!warnings.some(item => /Content Security Policy|Refused to/.test(item)), warnings.join('\n'));
  console.log('浏览器验证通过：初始化、凭证配置、新增项目、密码显示与清理、手动同步、快照开关/调度设置/源码 API、桌面与手机布局、下载页鉴权。');
  console.log(`截图目录：${artifactDirectory}`);
} finally {
  socket?.close();
  browser.kill();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('cmr-browser-')) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
