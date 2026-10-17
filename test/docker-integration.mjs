import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApplication } from '../src/server.mjs';

// 此脚本必须显式执行，所有 Docker 资源使用本次随机标识，绝不接管业务容器。
const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const runId = randomUUID().slice(0, 8);
const network = `cmr-it-${runId}`;
const image = process.env.CMR_IT_AGENT_IMAGE || 'cmr-agent:verification';
const buildImage = process.env.CMR_IT_BUILD_IMAGE || 'maven:3.9.9-eclipse-temurin-8';
const root = await mkdtemp(path.join(os.tmpdir(), 'cmr-docker-test-'));
const workRoot = `/tmp/cmr-it-${runId}`;
const agents = [], targets = [], outcomes = [], scenarios = [], fixtures = [];
const adminPassword = `integration-${randomUUID()}`;
let application, base, csrf, cookie, mavenCacheDirectory, passed = false;
async function docker(args, tolerate = false) {
  try { return (await execute('docker', args, { maxBuffer: 20 * 1024 * 1024, windowsHide: true, timeout: 900000 })).stdout.trim(); }
  catch (error) { if (tolerate) return ''; throw new Error(`Docker ${args.slice(0, 3).join(' ')} 失败：${error.stderr || error.message}`); }
}
function zip(files) {
  const blocks = [], entries = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(content); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    blocks.push(header, filename, data); entries.push(entry, filename); offset += header.length + filename.length + data.length;
  }
  const central = Buffer.concat(entries), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...blocks, central, end]);
}
async function api(route, input, method = 'POST') {
  const response = await fetch(base + route, { method: input === undefined ? 'GET' : method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(`${route}: ${result.error}`), { status: response.status });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return result;
}
async function until(action, label, timeout = 900000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await action(); if (value) return value; await sleep(1000); }
  throw new Error(`等待超时：${label}`);
}
async function waitTask(id) {
  let after = 0, priorStage;
  return until(async () => {
    const detail = await api(`/api/deploy/tasks/${id}?after=${after}`);
    for (const event of detail.logs) { after = event.seq; if (event.message) process.stdout.write(event.message.endsWith('\n') ? event.message : event.message + '\n'); }
    if (detail.task.stage !== priorStage) { console.log(`阶段：${detail.task.stage}`); priorStage = detail.task.stage; }
    if (!['succeeded', 'failed', 'rolled_back', 'interrupted'].includes(detail.task.status)) return null;
    outcomes.push({ id, status: detail.task.status, stages: detail.task.stageHistory }); return detail.task;
  }, `任务 ${id}`);
}
async function agentTask(id) {
  const text = await docker(['exec', agents[0], 'cat', `${workRoot}/agent-0/tasks/${id}.json`], true);
  return text ? JSON.parse(text) : null;
}
async function inspectContainer(name) {
  const text = await docker(['inspect', name], true);
  return text ? JSON.parse(text)[0] : null;
}
try {
  await docker(['version']);
  if (!process.env.CMR_IT_AGENT_IMAGE) console.log(await docker(['build', '-t', image, path.join(repo, 'agent')]));
  await docker(['network', 'create', '--label', `io.cmr.integration=${runId}`, network]);
  const controller = process.env.CMR_IT_CONTROLLER_CONTAINER;
  if (controller) {
    if (!/^cmr-it-[a-z0-9-]+$/.test(controller)) throw new Error('验收控制器名称必须使用 cmr-it- 前缀');
    await docker(['network', 'connect', network, controller]);
  }
  const demo = path.join(repo, 'examples/demo-java');
  const files = { 'pom.xml': await readFile(path.join(demo, 'pom.xml')), 'src/main/java/com/cmr/demo/Main.java': await readFile(path.join(demo, 'src/main/java/com/cmr/demo/Main.java')) };
  let archive = zip(files), revision = 'a'.repeat(40);
  const archiveFile = path.join(root, 'demo.zip'); await writeFile(archiveFile, archive);
  const builder = { async initialize() {}, async build() { return { file: archiveFile, revision, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), cached: true }; } };
  const listenPort = Number(process.env.CMR_IT_PORT || 18888);
  application = await createApplication({ directory: path.join(root, 'center'), builder, secureCookies: false });
  await new Promise(resolve => application.server.listen(listenPort, '0.0.0.0', resolve));
  base = `http://127.0.0.1:${listenPort}`;
  csrf = (await api('/api/setup', { bootstrapToken: application.service.bootstrapToken, username: 'admin', password: adminPassword })).csrf;
  const project = await api('/api/workspaces', { name: '独立验收项目' });
  const workspacePath = `/api/workspaces/${project.id}`;
  const source = (await api(`${workspacePath}/repositories`, { name: '隔离演示源码', repository: 'https://gitee.com/example/cmr-demo.git', branch: 'main', enabled: true })).project;
  const environment = (await api(workspacePath)).environments.find(item => item.name === '测试');
  const service = await api(`${workspacePath}/services`, { name: '演示 Java 服务', module: '.' });
  await api(`${workspacePath}/environment-sources`, { environmentId: environment.id, serviceId: service.id, sourceProjectId: source.id, branch: 'main' }, 'PUT');
  const first = await api(`${workspacePath}/servers`, { name: '验收部署节点', mode: 'managed' });
  const second = await api(`${workspacePath}/servers`, { name: '验收隔离节点' });
  const config = { artifactPath: 'target/demo.jar', buildImage, runtimeImage: buildImage, jvmArgs: ['-Xms32m', '-Xmx96m'], profile: '', args: [], ports: [], networks: [], volumes: [], build: { cpus: 1, memoryMb: 768 }, runtime: { cpus: 0.5, memoryMb: 192 }, health: { path: '/health', port: 18081, status: 200, bodyIncludes: 'cmr-demo-ready', timeoutSeconds: 45, intervalSeconds: 2 } };
  const target = await api(`${workspacePath}/targets`, { environmentId: environment.id, serviceId: service.id, serverId: first.server.id, mode: 'managed', config }); targets.push(target);
  mavenCacheDirectory = `${workRoot}/agent-0/cache/${project.id}/maven`;
  const seedCache = process.env.CMR_IT_SEED_MAVEN_CACHE;
  if (seedCache) {
    if (!/^\/tmp\/cmr-it-[a-f0-9]{8}\/agent-0\/cache\/[a-f0-9-]{36}\/maven$/.test(seedCache)) throw new Error('只能复用以前隔离验收目录中的 Maven 缓存');
    await docker(['run', '--rm', '--network', 'none', '--label', `io.cmr.integration=${runId}`, '--entrypoint', 'cp', '--mount', `type=bind,src=${seedCache},dst=/seed,readonly`, '-v', `${mavenCacheDirectory}:/cache`, image, '-a', '/seed/.', '/cache/']);
  }
  const centerUrl = `http://${controller || 'host.docker.internal'}:${listenPort}`;
  for (const [index, registered] of [first, second].entries()) {
    const name = `${network}-agent-${index}`, directory = `${workRoot}/agent-${index}`; agents.push(name);
    await docker(['run', '-d', '--name', name, '--network', network, '--add-host', 'host.docker.internal:host-gateway', '--label', `io.cmr.integration=${runId}`, '--memory', '256m', '--cpus', '0.5', '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock', '-v', `${directory}:${directory}`, '-v', `${directory}-static:${directory}-static`, '--env', `CMR_AGENT_DIR=${directory}`, '--env', `CMR_CENTER_URL=${centerUrl}`, '--env', `CMR_REGISTRATION_TOKEN=${registered.registrationToken}`, '--env', 'CMR_ALLOW_HTTP_TEST=1', image]);
    await docker(['exec', name, 'node', '--input-type=module', '-e', 'import fs from "node:fs/promises"; const root=process.argv[1]; await fs.chmod(root, 0o755); await fs.writeFile(root+"/.cmr-static-root", root, {mode:0o644});', `${directory}-static`]);
  }
  await until(async () => (await api('/api/deploy/overview')).servers.every(server => server.online), '两个 Agent 注册', 90000);
  await api(`/api/deploy/servers/${first.server.id}/storage-policy`, { retainedVersions: 2, buildCacheGiB: 1 }, 'PUT');
  async function localVersions(deploymentTarget) {
    return JSON.parse(await docker(['exec', agents[0], 'node', '--input-type=module', '-e', 'import fs from "node:fs/promises"; const root=process.argv[1]; const names=await fs.readdir(root); const values=await Promise.all(names.filter(n=>n.endsWith(".json")).map(n=>fs.readFile(root+"/"+n,"utf8").then(JSON.parse))); console.log(JSON.stringify(values));', `${workRoot}/agent-0/targets/${deploymentTarget.id}/releases`]));
  }
  await assert.rejects(api(`${workspacePath}/targets`, { environmentId: environment.id, serviceId: service.id, serverId: second.server.id, mode: 'observe', containerName: target.containerName, config }), { status: 400 });
  const publish = async () => waitTask((await api(`${workspacePath}/tasks`, { targetId: target.id, action: 'deploy' })).task.id);
  const good = await publish(); assert.equal(good.status, 'succeeded');
  if (good.detailedAgentStages) assert.ok(good.stageHistory.some(entry => entry.stage === 'image' && Number.isFinite(entry.durationMs)), '新 Agent 应独立上报镜像构建耗时');
  const inspected = JSON.parse(await docker(['inspect', target.containerName]))[0]; assert.equal(inspected.State.Health.Status, 'healthy');
  assert.deepEqual((await api('/api/deploy/overview')).servers.find(s=>s.id===second.server.id).containers, []);
  scenarios.push({ name: '两个 Agent 接入、空节点隔离和真实健康状态', passed: true });
  const restart = await waitTask((await api(`${workspacePath}/tasks`, { targetId: target.id, action: 'restart' })).task.id); assert.equal(restart.status, 'succeeded');
  await docker(['restart', agents[0]]);
  await until(async () => JSON.parse(await docker(['inspect', agents[0]]))[0].State.Running, 'Agent 重启');
  const update = { environmentId: environment.id, serviceId: service.id, serverId: first.server.id, mode: 'managed', config: { ...config, args: ['--unhealthy'], health: { ...config.health, timeoutSeconds: 12 } } };
  await api(`${workspacePath}/targets/${target.id}`, update, 'PUT');
  const bad = await publish(); assert.equal(bad.status, 'rolled_back');
  assert.ok((await api(`/api/deploy/tasks/${bad.id}`)).logs.some(event => event.message?.includes('已复用并校验本机源码包')), 'Agent 重启后仍应复用已校验源码包');
  assert.equal(JSON.parse(await docker(['inspect', target.containerName]))[0].Config.Image, good.result.release.image);
  const rollback = await waitTask((await api(`${workspacePath}/tasks`, { targetId: target.id, action: 'rollback', releaseId: good.result.release.id })).task.id); assert.equal(rollback.status, 'succeeded');
  await api(`${workspacePath}/targets/${target.id}`, { ...update, config }, 'PUT');
  archive = zip({ ...files, 'src/main/java/com/cmr/demo/Main.java': Buffer.from('这不是可编译的 Java 代码') }); revision = 'b'.repeat(40); await writeFile(archiveFile, archive);
  const failed = await publish(); assert.equal(failed.status, 'failed');
  assert.equal(JSON.parse(await docker(['inspect', target.containerName]))[0].Config.Image, good.result.release.image);
  scenarios.push({ name: '完整 ZIP、Maven 编译、发布、重启、自动和手动回退、编译失败保护', passed: true });

  // 中心关闭期间，已领取并下载完成的任务继续执行；重启后只补报，不重复更新容器。
  archive = zip(files); revision = 'c'.repeat(40); await writeFile(archiveFile, archive);
  const offline = (await api(`${workspacePath}/tasks`, { targetId: target.id, action: 'deploy' })).task;
  await until(async () => (await agentTask(offline.id))?.stage === 'building', '源码已下载并开始编译');
  const closed = await application.close({ timeoutMs: 10000 }); assert.equal(closed.graceful, true);
  const localCompletion = await until(async () => { const record = await agentTask(offline.id); return record && ['succeeded', 'failed', 'rolled_back'].includes(record.status) ? record : null; }, '中心离线时 Agent 独立完成任务');
  assert.equal(localCompletion.status, 'succeeded'); assert.ok(localCompletion.seq > localCompletion.ackSeq);
  const whileOffline = await inspectContainer(target.containerName); assert.equal(whileOffline.State.Health.Status, 'healthy');
  application = await createApplication({ directory: path.join(root, 'center'), builder, secureCookies: false });
  await new Promise(resolve => application.server.listen(listenPort, '0.0.0.0', resolve));
  cookie = null; csrf = null; csrf = (await api('/api/login', { username: 'admin', password: adminPassword })).csrf;
  const recovered = await waitTask(offline.id); assert.equal(recovered.status, 'succeeded');
  const afterReconnect = await inspectContainer(target.containerName);
  assert.equal(afterReconnect.Id, whileOffline.Id); assert.equal(afterReconnect.State.StartedAt, whileOffline.State.StartedAt);
  const replayed = await api(`/api/deploy/tasks/${offline.id}`);
  assert.deepEqual(replayed.logs.map(event => event.seq), Array.from({ length: replayed.logs.length }, (_, index) => index + 1));
  scenarios.push({ name: '中心离线继续部署、中心重启、日志连续补报、不重复更新容器', passed: true, taskId: offline.id, offlineUnacknowledgedEvents: localCompletion.seq - localCompletion.ackSeq, containerId: whileOffline.Id });

  // 暂停本任务的构建容器，使故障注入不依赖 Maven 编译速度；所有目标均为本次随机资源。
  const interrupted = (await api(`${workspacePath}/tasks`, { targetId: target.id, action: 'deploy' })).task;
  const buildContainer = `cmr-build-${interrupted.id}-maven`;
  await until(async () => (await inspectContainer(buildContainer))?.State?.Running, '构建容器启动');
  await docker(['pause', buildContainer]);
  const beforeCrash = await inspectContainer(target.containerName);
  await docker(['kill', '--signal', 'KILL', agents[0]]); await docker(['start', agents[0]]);
  const interruptedResult = await waitTask(interrupted.id); assert.equal(interruptedResult.status, 'interrupted');
  assert.equal(await inspectContainer(buildContainer), null);
  const afterCrash = await inspectContainer(target.containerName);
  assert.equal(afterCrash.Id, beforeCrash.Id); assert.equal(afterCrash.State.StartedAt, beforeCrash.State.StartedAt);
  scenarios.push({ name: '编译中 Agent 崩溃恢复、仅清理自身构建容器、现有业务不变', passed: true, taskId: interrupted.id });

  // 健康检查阶段终止 Agent，恢复时应核验当前容器而不是重新执行发布。
  await api(`${workspacePath}/targets/${target.id}`, { ...update, config: { ...config, health: { ...config.health, intervalSeconds: 15 } } }, 'PUT');
  const verifying = (await api(`${workspacePath}/tasks`, { targetId: target.id, action: 'deploy' })).task;
  await until(async () => { const record = await agentTask(verifying.id); return record?.stage === 'verifying' && record.status === 'running'; }, '部署进入健康检查');
  const beforeVerifyCrash = await inspectContainer(target.containerName);
  await docker(['kill', '--signal', 'KILL', agents[0]]); await docker(['start', agents[0]]);
  const verified = await waitTask(verifying.id); assert.equal(verified.status, 'succeeded');
  const recoveryLogs = (await api(`/api/deploy/tasks/${verifying.id}`)).logs;
  assert.ok(recoveryLogs.some(event => event.message.includes('Agent 重启，正在核对已执行的部署状态')));
  const afterVerifyCrash = await inspectContainer(target.containerName);
  assert.equal(afterVerifyCrash.Id, beforeVerifyCrash.Id); assert.equal(afterVerifyCrash.State.StartedAt, beforeVerifyCrash.State.StartedAt);
  scenarios.push({ name: '部署健康检查中 Agent 崩溃恢复，不重复创建或重启业务容器', passed: true, taskId: verifying.id });
  const otherProject = await api('/api/workspaces', { name: '共享服务器的第二项目' });
  const otherPath = `/api/workspaces/${otherProject.id}`;
  const otherSource = (await api(`${otherPath}/repositories`, { name: '第二项目源码', repository: source.repository, branch: 'main' })).project;
  const otherEnvironment = (await api(otherPath)).environments.find(item => item.name === '测试');
  const otherService = await api(`${otherPath}/services`, { name: '第二项目服务', module: '.' });
  await api(`${otherPath}/environment-sources`, { environmentId: otherEnvironment.id, serviceId: otherService.id, sourceProjectId: otherSource.id, branch: 'main' }, 'PUT');
  await api(`${otherPath}/servers/${first.server.id}`, {}, 'PUT');
  const otherTarget = await api(`${otherPath}/targets`, { environmentId: otherEnvironment.id, serviceId: otherService.id, serverId: first.server.id, mode: 'managed', config }); targets.push(otherTarget);
  const queuedA = (await api(`${workspacePath}/tasks`, { targetId: target.id, action: 'deploy' })).task;
  const queuedB = (await api(`${otherPath}/tasks`, { targetId: otherTarget.id, action: 'deploy' })).task;
  await application.deployment.preparations.get(queuedB.id);
  assert.ok(application.deployment.data.tasks.filter(item => item.serverId === first.server.id && item.status === 'running').length <= 1);
  assert.equal((await waitTask(queuedA.id)).status, 'succeeded');
  assert.equal((await waitTask(queuedB.id)).status, 'succeeded');
  const firstDone = application.deployment.data.tasks.find(item => item.id === queuedA.id);
  const secondDone = application.deployment.data.tasks.find(item => item.id === queuedB.id);
  assert.ok(Date.parse(secondDone.startedAt) >= Date.parse(firstDone.resultReceivedAt));
  assert.equal((await inspectContainer(otherTarget.containerName)).State.Health.Status, 'healthy');
  assert.ok(!(await api(workspacePath)).targets.some(item => item.id === otherTarget.id));
  scenarios.push({ name: '两个项目共享真实 Agent，跨项目串行发布且目标独立', passed: true });
  // 清理目标历史镜像、停用远端并修改当前模块，恢复必须只依赖中心历史档案。
  await docker(['image', 'rm', good.result.release.image], true);
  await application.service.setEnabled(source.id, false);
  await api(`${workspacePath}/services/${service.id}`, { name: service.name, module: 'missing-current-module', kind: 'java' }, 'PUT');
  const rebuiltJava = await waitTask((await api(`${workspacePath}/tasks`, { targetId: target.id, action: 'rollback', releaseId: good.id })).task.id);
  assert.equal(rebuiltJava.status, 'succeeded'); assert.equal(rebuiltJava.result.recoveryMethod, 'rebuild');
  assert.equal(rebuiltJava.result.release.restoredFromReleaseId, good.id); assert.notEqual(rebuiltJava.result.release.image, good.result.release.image);
  assert.equal((await inspectContainer(target.containerName)).State.Health.Status, 'healthy');
  assert.equal(application.deployment.data.releases.find(item => item.id === good.id).image, good.result.release.image);
  assert.equal(application.deployment.archives.status(application.deployment.data.releases.find(item => item.id === good.id)), 'available');
  await application.service.setEnabled(source.id, true);
  await api(`${workspacePath}/services/${service.id}`, { name: service.name, module: '.', kind: 'java' }, 'PUT');
  scenarios.push({ name: '历史 Java 镜像删除、仓库停用及当前模块改变后按中心原 ZIP 与历史配置重建', passed: true, taskId: rebuiltJava.id });
  const cacheJava = await waitTask((await api(`${workspacePath}/tasks`, { targetId: target.id, action: 'rollback', releaseId: queuedA.id })).task.id);
  assert.equal(cacheJava.status, 'succeeded'); assert.equal(cacheJava.result.release.id, cacheJava.id); assert.equal(cacheJava.result.release.recoveryMethod, 'cache');
  const olderJava = await waitTask((await api(`${workspacePath}/tasks`, { targetId: target.id, action: 'rollback', releaseId: good.id })).task.id);
  assert.equal(olderJava.status, 'succeeded'); assert.equal(olderJava.result.release.recoveryMethod, 'rebuild');
  assert.deepEqual((await localVersions(target)).map(value => value.id).sort(), [cacheJava.id, olderJava.id].sort());
  assert.equal((await docker(['image', 'ls', '-q', '--filter', `label=io.cmr.target=${target.id}`])).split(/\s+/).filter(Boolean).length, 2);
  const javaHistory = application.deployment.data.releases.filter(value => value.targetId === target.id);
  assert.ok(javaHistory.length > 5); assert.ok(javaHistory.every(value => application.deployment.archives.status(value) === 'available'));
  scenarios.push({ name: 'Java 回退产生新节点，只保留发布链末尾两份产物，超过五个中心版本仍可恢复', passed: true });
  // 一个已有 Nginx 同时提供静态页面和 Java API；发布不重建或重启该 Nginx。
  const nginx = `${network}-nginx`, publicRoot = `${workRoot}/agent-0-static`;
  const frontendService = await api(`${workspacePath}/services`, { name: '演示前端', kind: 'static', module: '.' });
  await api(`${workspacePath}/environment-sources`, { environmentId: environment.id, serviceId: frontendService.id, sourceProjectId: source.id, branch: 'main' }, 'PUT');
  const frontendConfig = { buildImage: process.env.CMR_IT_NODE_IMAGE || 'node:24-bookworm-slim', artifactPath: 'dist', packageManager: 'npm', packageManagerVersion: '10.9.9', buildScript: 'build', build: { cpus: 1, memoryMb: 512 }, health: { url: `http://${nginx}/`, bodyIncludes: 'static-ready', timeoutSeconds: 12, intervalSeconds: 2 } };
  const frontendInput = { environmentId: environment.id, serviceId: frontendService.id, serverId: first.server.id, mode: 'managed', config: frontendConfig };
  const frontend = await api(`${workspacePath}/targets`, frontendInput); targets.push(frontend);
  const nginxConfig = `server {
    listen 80;
    root /srv/cmr-sites/${frontend.id}/current;
    index index.html;
    open_file_cache off;
    location = /__cmr_release.txt { add_header Cache-Control "no-store" always; try_files $uri =404; }
    location = /index.html { add_header Cache-Control "no-cache" always; }
    location /api/ { proxy_pass http://${otherTarget.containerName}:18081/; }
    location / { try_files $uri $uri/ /index.html; }
  }`;
  const nginxConfigPath = `${workRoot}/agent-0/nginx-test.conf`;
  await docker(['exec', agents[0], 'node', '--input-type=module', '-e', 'import fs from "node:fs/promises"; await fs.writeFile(process.argv[1], process.argv[2], {mode:0o644}); await fs.chmod(process.argv[1], 0o644);', nginxConfigPath, nginxConfig]);
  await docker(['network', 'connect', network, otherTarget.containerName]);
  fixtures.push(nginx);
  await docker(['run', '-d', '--name', nginx, '--network', network, '--label', `io.cmr.integration=${runId}`, '--mount', `type=bind,src=${publicRoot},dst=/srv/cmr-sites,readonly`, '--mount', `type=bind,src=${nginxConfigPath},dst=/etc/nginx/conf.d/default.conf,readonly`, process.env.CMR_IT_NGINX_IMAGE || 'nginx:stable-alpine']);
  async function readSite(route = '') {
    return docker(['exec', agents[0], 'node', '--input-type=module', '-e', 'const r=await fetch(process.argv[1], {signal:AbortSignal.timeout(5000)}); if(r.status!==200) throw Error(`HTTP ${r.status}`); process.stdout.write(await r.text());', `http://${nginx}/${route}`]);
  }
  await until(async () => { try { return (await readSite('api/health')).includes('cmr-demo-ready'); } catch { return false; } }, '共用 Nginx 的后端转发', 30000);
  const nginxBefore = await inspectContainer(nginx), backendBefore = await inspectContainer(otherTarget.containerName);
  async function frontendSource(label, invalid = false) {
    const manifest = { name: 'cmr-static-demo', version: '1.0.0', private: true, scripts: { build: 'node build.mjs' } };
    const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: { '': { name: manifest.name, version: manifest.version } } };
    archive = zip({ 'package.json': JSON.stringify(manifest), 'package-lock.json': JSON.stringify(lock), 'build.mjs': invalid ? 'process.exit(1);' : `import fs from 'node:fs/promises'; await fs.mkdir('dist'); await fs.writeFile('dist/index.html', ${JSON.stringify(`<html><body>static-ready ${label}</body></html>`)});` });
    revision = createHash('sha1').update(archive).digest('hex'); await writeFile(archiveFile, archive);
  }
  const publishFrontend = async () => waitTask((await api(`${workspacePath}/tasks`, { targetId: frontend.id, action: 'deploy' })).task.id);
  await frontendSource('v1'); const frontendV1 = await publishFrontend(); assert.equal(frontendV1.status, 'succeeded');
  assert.equal(await readSite('__cmr_release.txt'), frontendV1.id); assert.match(await readSite(), /static-ready v1/);
  await frontendSource('v2'); const frontendV2 = await publishFrontend(); assert.equal(frontendV2.status, 'succeeded');
  assert.equal(await readSite('__cmr_release.txt'), frontendV2.id);
  const frontendRollback = await waitTask((await api(`${workspacePath}/tasks`, { targetId: frontend.id, action: 'rollback', releaseId: frontendV1.id })).task.id);
  assert.equal(frontendRollback.status, 'succeeded'); assert.equal(await readSite('__cmr_release.txt'), frontendV1.id);
  await frontendSource('bad-build', true); assert.equal((await publishFrontend()).status, 'failed');
  assert.equal(await readSite('__cmr_release.txt'), frontendV1.id);
  await api(`${workspacePath}/targets/${frontend.id}`, { ...frontendInput, config: { ...frontendConfig, health: { ...frontendConfig.health, bodyIncludes: 'missing-health-marker' } } }, 'PUT');
  await frontendSource('bad-health'); assert.equal((await publishFrontend()).status, 'rolled_back');
  assert.equal(await readSite('__cmr_release.txt'), frontendV1.id); assert.match(await readSite('api/health'), /cmr-demo-ready/);
  await docker(['exec', agents[0], 'node', '--input-type=module', '-e', 'import fs from "node:fs/promises"; const [root,target,release]=process.argv.slice(1); if(!new RegExp("^/tmp/cmr-it-[a-f0-9]{8}/agent-0-static$").test(root)||![target,release].every(v=>/^[a-f0-9-]{36}$/.test(v))) throw Error("验收目录无效"); await fs.rm(`${root}/${target}/releases/${release}`,{recursive:true,force:true});', publicRoot, frontend.id, frontendV2.id]);
  await application.service.setEnabled(source.id, false);
  const rebuiltStatic = await waitTask((await api(`${workspacePath}/tasks`, { targetId: frontend.id, action: 'rollback', releaseId: frontendV2.id })).task.id);
  assert.equal(rebuiltStatic.status, 'succeeded'); assert.equal(rebuiltStatic.result.recoveryMethod, 'rebuild');
  assert.equal(rebuiltStatic.result.release.restoredFromReleaseId, frontendV2.id);
  assert.equal(await readSite('__cmr_release.txt'), rebuiltStatic.id); assert.match(await readSite(), /static-ready v2/);
  await application.service.setEnabled(source.id, true);
  scenarios.push({ name: '静态历史目录删除、远端停用及当前健康配置改变后按历史源码重建，原发布记录不变', passed: true, taskId: rebuiltStatic.id });
  await api(`${workspacePath}/targets/${frontend.id}`, frontendInput, 'PUT');
  await frontendSource('v3'); const frontendV3 = await publishFrontend(); assert.equal(frontendV3.status, 'succeeded');
  await frontendSource('v4'); assert.equal((await publishFrontend()).status, 'succeeded');
  const cachedStatic = await waitTask((await api(`${workspacePath}/tasks`, { targetId: frontend.id, action: 'rollback', releaseId: frontendV3.id })).task.id);
  assert.equal(cachedStatic.status, 'succeeded'); assert.equal(cachedStatic.result.release.recoveryMethod, 'cache');
  const olderStatic = await waitTask((await api(`${workspacePath}/tasks`, { targetId: frontend.id, action: 'rollback', releaseId: frontendV1.id })).task.id);
  assert.equal(olderStatic.status, 'succeeded'); assert.equal(olderStatic.result.release.recoveryMethod, 'rebuild');
  assert.deepEqual((await localVersions(frontend)).map(value => value.id).sort(), [cachedStatic.id, olderStatic.id].sort());
  const staticArtifacts = JSON.parse(await docker(['exec', agents[0], 'node', '--input-type=module', '-e', 'import fs from "node:fs/promises"; console.log(JSON.stringify(await fs.readdir(process.argv[1])));', `${publicRoot}/${frontend.id}/releases`]));
  assert.deepEqual(staticArtifacts.sort(), [frontendV3.id, olderStatic.id].sort());
  await until(async () => {
    const servers = (await api('/api/deploy/overview')).servers, server = servers.find(value => value.id === first.server.id);
    assert.equal(servers.find(value => value.id === second.server.id).storagePolicy.buildCacheGiB, 2);
    return server.storageState === 'applied' && server.storageStatus.targets.length === 3 && server.storageStatus.cache.bytes <= 1024 ** 3;
  }, '服务器独立策略执行与缓存容量上报', 120000);
  scenarios.push({ name: '静态回退缓存与重建均新增节点，严格保留最后两个节点，中心下发缓存额度并收到执行回执', passed: true });
  // 在本次隔离 Builder 中制造超过 1 GiB 的缓存，验证实际回收而非仅校验命令参数。
  const quota = JSON.parse(await docker(['exec', agents[0], 'node', '--input-type=module', '-e', `
    import fs from 'node:fs/promises'; import {BuildCache} from '/agent/build-cache.mjs'; import {Docker} from '/agent/docker.mjs';
    const root=process.argv[1], identity=JSON.parse(await fs.readFile(root+'/identity.json','utf8'));
    const cache=new BuildCache({root,docker:new Docker(),identity:()=>identity}), context=root+'/quota-verification';
    await fs.mkdir(context,{recursive:true}); await fs.writeFile(context+'/Dockerfile','FROM scratch\\nCOPY payload /payload\\n');
    const file=await fs.open(context+'/payload','w'); await file.truncate(1153433600); await file.close();
    await cache.ensure(); await cache.run(['build','--builder',cache.name,'--output','type=cacheonly',context]);
    const report=await cache.prune({buildCacheGiB:1}); await fs.rm(context,{recursive:true,force:true}); console.log(JSON.stringify(report));
  `, `${workRoot}/agent-0`]));
  assert.ok(quota.beforeBytes > 1024 ** 3); assert.ok(quota.bytes <= 1024 ** 3); assert.ok(quota.reclaimedBytes > 0);
  scenarios.push({ name: '平台专用构建缓存实际超额后回收到 1 GiB 内', passed: true, cache: quota });
  const nginxAfter = await inspectContainer(nginx), backendAfter = await inspectContainer(otherTarget.containerName);
  assert.equal(nginxAfter.Id, nginxBefore.Id); assert.equal(nginxAfter.State.StartedAt, nginxBefore.State.StartedAt); assert.equal(nginxAfter.RestartCount, nginxBefore.RestartCount);
  assert.equal(backendAfter.Id, backendBefore.Id); assert.equal(backendAfter.State.StartedAt, backendBefore.State.StartedAt);
  assert.equal(await docker(['ps', '-aq', '--filter', `label=io.cmr.target=${frontend.id}`]), '');
  scenarios.push({ name: '真实 Node 构建、共用 Nginx 静态版本切换、手动与失败回退、后端转发和 Nginx 持续运行', passed: true, nginxId: nginxBefore.Id });
  passed = true;
  console.log('真实 Docker 验收通过：Java 与前端发布、共用 Nginx、自动和手动回退、中心离线和重启、日志补报、Agent 崩溃恢复、资源归属隔离。');
} finally {
  const artifactDirectory = path.join(repo, '.test-artifacts'); await mkdir(artifactDirectory, { recursive: true });
  for (const name of agents) {
    await writeFile(path.join(artifactDirectory, `${name}.log`), await docker(['logs', name], true));
    const found = await docker(['inspect', '--format', '{{index .Config.Labels "io.cmr.integration"}}', name], true);
    if (found === runId) {
      const directory = `${workRoot}/agent-${agents.indexOf(name)}`;
      const serverId = await docker(['exec', name, 'node', '--input-type=module', '-e', 'import fs from "node:fs/promises"; console.log(JSON.parse(await fs.readFile(process.argv[1],"utf8")).serverId);', `${directory}/identity.json`], true);
      if (/^[a-f0-9-]{36}$/.test(serverId)) await docker(['exec', name, 'docker', '--config', `${directory}/docker-config`, 'buildx', 'rm', `cmr-${serverId}`], true);
      await docker(['rm', '-f', name], true);
    }
  }
  for (const name of fixtures) {
    await writeFile(path.join(artifactDirectory, `${name}.log`), await docker(['logs', name], true));
    if (await docker(['inspect', '--format', '{{index .Config.Labels "io.cmr.integration"}}', name], true) === runId) await docker(['rm', '-f', name], true);
  }
  for (const target of targets) {
    const resources = await docker(['ps', '-aq', '--filter', `label=io.cmr.target=${target.id}`], true);
    for (const id of resources.split(/\s+/).filter(Boolean)) await docker(['rm', '-f', id], true);
    const images = await docker(['image', 'ls', '-q', '--filter', `label=io.cmr.target=${target.id}`], true);
    for (const id of new Set(images.split(/\s+/).filter(Boolean))) await docker(['image', 'rm', id], true);
    await docker(['network', 'rm', `cmr-${target.id}-network`], true);
  }
  if (process.env.CMR_IT_CONTROLLER_CONTAINER) await docker(['network', 'disconnect', network, process.env.CMR_IT_CONTROLLER_CONTAINER], true);
  await docker(['network', 'rm', network], true);
  if (application) await application.close({ timeoutMs: 10000 });
  await writeFile(path.join(artifactDirectory, 'docker-verification.json'), JSON.stringify({ runId, passed, scenarios, outcomes, directory: root, workRoot, mavenCacheDirectory, at: new Date().toISOString() }, null, 2));
}
