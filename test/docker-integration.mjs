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
const agents = [], targets = [], outcomes = [], scenarios = [];
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
  const source = (await api('/api/projects', { name: '隔离演示源码', repository: 'https://gitee.com/example/cmr-demo.git', branch: 'main', enabled: true })).project;
  const project = await api('/api/deploy/applications', { name: '独立验收项目' });
  const environment = await api('/api/deploy/environments', { applicationId: project.id, sourceProjectId: source.id, name: '隔离测试' });
  const service = await api('/api/deploy/services', { applicationId: project.id, name: '演示 Java 服务', module: '.' });
  const first = await api('/api/deploy/servers', { name: '验收部署节点', mode: 'managed' });
  const second = await api('/api/deploy/servers', { name: '验收观察节点', mode: 'observe' });
  const config = { artifactPath: 'target/demo.jar', buildImage, runtimeImage: buildImage, jvmArgs: ['-Xms32m', '-Xmx96m'], profile: '', args: [], ports: [], networks: [], volumes: [], build: { cpus: 1, memoryMb: 768 }, runtime: { cpus: 0.5, memoryMb: 192 }, health: { path: '/health', port: 18081, status: 200, bodyIncludes: 'cmr-demo-ready', timeoutSeconds: 45, intervalSeconds: 2 } };
  const target = await api('/api/deploy/targets', { environmentId: environment.id, serviceId: service.id, serverId: first.server.id, mode: 'managed', config }); targets.push(target);
  const observed = await api('/api/deploy/targets', { environmentId: environment.id, serviceId: service.id, serverId: second.server.id, mode: 'observe', containerName: target.containerName, config });
  mavenCacheDirectory = `${workRoot}/agent-0/cache/${project.id}/maven`;
  const seedCache = process.env.CMR_IT_SEED_MAVEN_CACHE;
  if (seedCache) {
    if (!/^\/tmp\/cmr-it-[a-f0-9]{8}\/agent-0\/cache\/[a-f0-9-]{36}\/maven$/.test(seedCache)) throw new Error('只能复用以前隔离验收目录中的 Maven 缓存');
    await docker(['run', '--rm', '--network', 'none', '--label', `io.cmr.integration=${runId}`, '--entrypoint', 'cp', '--mount', `type=bind,src=${seedCache},dst=/seed,readonly`, '-v', `${mavenCacheDirectory}:/cache`, image, '-a', '/seed/.', '/cache/']);
  }
  const centerUrl = `http://${controller || 'host.docker.internal'}:${listenPort}`;
  for (const [index, registered] of [first, second].entries()) {
    const name = `${network}-agent-${index}`, directory = `${workRoot}/agent-${index}`; agents.push(name);
    await docker(['run', '-d', '--name', name, '--network', network, '--add-host', 'host.docker.internal:host-gateway', '--label', `io.cmr.integration=${runId}`, '--memory', '256m', '--cpus', '0.5', '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock', '-v', `${directory}:${directory}`, '--env', `CMR_AGENT_DIR=${directory}`, '--env', `CMR_CENTER_URL=${centerUrl}`, '--env', `CMR_REGISTRATION_TOKEN=${registered.registrationToken}`, '--env', 'CMR_ALLOW_HTTP_TEST=1', image]);
  }
  await until(async () => (await api('/api/deploy/overview')).servers.every(server => server.online), '两个 Agent 注册', 90000);
  for (const action of ['deploy', 'restart', 'rollback']) await assert.rejects(api('/api/deploy/tasks', { targetId: observed.id, action }), { status: 403 });
  const publish = async () => waitTask((await api('/api/deploy/tasks', { targetId: target.id, action: 'deploy' })).task.id);
  const good = await publish(); assert.equal(good.status, 'succeeded');
  const inspected = JSON.parse(await docker(['inspect', target.containerName]))[0]; assert.equal(inspected.State.Health.Status, 'healthy');
  await until(async () => (await api('/api/deploy/overview')).targets.find(item => item.id === observed.id)?.observation?.health === 'healthy', '只读节点上报业务健康状态', 45000);
  scenarios.push({ name: '两个 Agent 接入、观察隔离和真实健康状态', passed: true });
  const restart = await waitTask((await api('/api/deploy/tasks', { targetId: target.id, action: 'restart' })).task.id); assert.equal(restart.status, 'succeeded');
  await docker(['restart', agents[0]]);
  await until(async () => JSON.parse(await docker(['inspect', agents[0]]))[0].State.Running, 'Agent 重启');
  const update = { environmentId: environment.id, serviceId: service.id, serverId: first.server.id, mode: 'managed', config: { ...config, args: ['--unhealthy'], health: { ...config.health, timeoutSeconds: 12 } } };
  await api(`/api/deploy/targets/${target.id}`, update, 'PUT');
  const bad = await publish(); assert.equal(bad.status, 'rolled_back');
  assert.equal(JSON.parse(await docker(['inspect', target.containerName]))[0].Config.Image, good.result.release.image);
  const rollback = await waitTask((await api('/api/deploy/tasks', { targetId: target.id, action: 'rollback', releaseId: good.result.release.id })).task.id); assert.equal(rollback.status, 'succeeded');
  await api(`/api/deploy/targets/${target.id}`, { ...update, config }, 'PUT');
  archive = zip({ ...files, 'src/main/java/com/cmr/demo/Main.java': Buffer.from('这不是可编译的 Java 代码') }); revision = 'b'.repeat(40); await writeFile(archiveFile, archive);
  const failed = await publish(); assert.equal(failed.status, 'failed');
  assert.equal(JSON.parse(await docker(['inspect', target.containerName]))[0].Config.Image, good.result.release.image);
  scenarios.push({ name: '完整 ZIP、Maven 编译、发布、重启、自动和手动回退、编译失败保护', passed: true });

  // 中心关闭期间，已领取并下载完成的任务继续执行；重启后只补报，不重复更新容器。
  archive = zip(files); revision = 'c'.repeat(40); await writeFile(archiveFile, archive);
  const offline = (await api('/api/deploy/tasks', { targetId: target.id, action: 'deploy' })).task;
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
  const interrupted = (await api('/api/deploy/tasks', { targetId: target.id, action: 'deploy' })).task;
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
  await api(`/api/deploy/targets/${target.id}`, { ...update, config: { ...config, health: { ...config.health, intervalSeconds: 15 } } }, 'PUT');
  const verifying = (await api('/api/deploy/tasks', { targetId: target.id, action: 'deploy' })).task;
  await until(async () => { const record = await agentTask(verifying.id); return record?.stage === 'verifying' && record.status === 'running'; }, '部署进入健康检查');
  const beforeVerifyCrash = await inspectContainer(target.containerName);
  await docker(['kill', '--signal', 'KILL', agents[0]]); await docker(['start', agents[0]]);
  const verified = await waitTask(verifying.id); assert.equal(verified.status, 'succeeded');
  const recoveryLogs = (await api(`/api/deploy/tasks/${verifying.id}`)).logs;
  assert.ok(recoveryLogs.some(event => event.message.includes('Agent 重启，正在核对已执行的部署状态')));
  const afterVerifyCrash = await inspectContainer(target.containerName);
  assert.equal(afterVerifyCrash.Id, beforeVerifyCrash.Id); assert.equal(afterVerifyCrash.State.StartedAt, beforeVerifyCrash.State.StartedAt);
  scenarios.push({ name: '部署健康检查中 Agent 崩溃恢复，不重复创建或重启业务容器', passed: true, taskId: verifying.id });
  passed = true;
  console.log('真实 Docker 验收通过：发布与回退、中心离线和重启、日志补报、编译中及部署中 Agent 崩溃恢复、观察隔离。');
} finally {
  const artifactDirectory = path.join(repo, '.test-artifacts'); await mkdir(artifactDirectory, { recursive: true });
  for (const name of agents) {
    await writeFile(path.join(artifactDirectory, `${name}.log`), await docker(['logs', name], true));
    const found = await docker(['inspect', '--format', '{{index .Config.Labels "io.cmr.integration"}}', name], true);
    if (found === runId) await docker(['rm', '-f', name], true);
  }
  for (const target of targets) {
    const resources = await docker(['ps', '-aq', '--filter', `label=io.cmr.target=${target.id}`], true);
    for (const id of resources.split(/\s+/).filter(Boolean)) await docker(['rm', '-f', id], true);
    await docker(['network', 'rm', `cmr-${target.id}-network`], true);
  }
  if (process.env.CMR_IT_CONTROLLER_CONTAINER) await docker(['network', 'disconnect', network, process.env.CMR_IT_CONTROLLER_CONTAINER], true);
  await docker(['network', 'rm', network], true);
  if (application) await application.close({ timeoutMs: 10000 });
  await writeFile(path.join(artifactDirectory, 'docker-verification.json'), JSON.stringify({ runId, passed, scenarios, outcomes, directory: root, workRoot, mavenCacheDirectory, at: new Date().toISOString() }, null, 2));
}
