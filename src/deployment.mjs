import { EventEmitter } from 'node:events';
import { mkdir, copyFile, readFile, stat, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sourceKey, validateRevision, validateBranch } from './archive.mjs';
import { SourceArchives, checksum } from './source-archives.mjs';
import { migrateWorkspaces, sourceSnapshot } from './workspaces.mjs';
import { atomicWrite } from './store.mjs';
import { HttpError, requireText, digest, equal, randomSecret } from './security.mjs';
import { DEFAULT_STORAGE_POLICY, storagePolicy, artifactId } from '../agent/storage-policy.mjs';
import { networkIdentity } from '../agent/config.mjs';
import { normalizeEnvFiles, assertEnvFileAgent } from '../agent/env-files.mjs';
import { createProjectDeployments, normalizeDeploymentSourceSelection, projectDeploymentReferences, deploymentSourceRefs } from './deployment-projects.mjs';

export function readDeploymentDeletionReferences(directory, projectId, environmentId) {
  const file = path.join(directory,'state.sqlite');
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file,{readOnly:true});
  try {
    if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new HttpError(503,'部署存储版本不可读，尚未删除');
    const row = db.prepare('SELECT value FROM application_state WHERE id=1').get();
    return projectDeploymentReferences(JSON.parse(row.value),projectId,environmentId);
  } finally { db.close(); }
}

const now = () => new Date().toISOString();
const terminal = new Set(['succeeded', 'failed', 'rolled_back', 'interrupted']);
const stages = new Set(['queued', 'downloading', 'building', 'image', 'deploying', 'verifying', ...terminal]);
const collections = ['servers', 'applications', 'environments', 'services', 'targets', 'tasks', 'releases'];
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const imagePattern = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/;
function fail(message) { throw new HttpError(400, message); }
function find(items, id, label = '记录') { const item = items.find(entry => entry.id === id); if (!item) throw new HttpError(404, `${label}不存在`); return item; }
function number(value, fallback, min, max, label) {
  value ??= fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label}超出允许范围`);
  return value;
}
function integer(value, fallback, min, max, label) { const result = number(value, fallback, min, max, label); if (!Number.isInteger(result)) fail(`${label}必须是整数`); return result; }
function list(value, max, label) { value ??= []; if (!Array.isArray(value) || value.length > max) fail(`${label}格式错误`); return value; }
function relative(value, label, allowGlob = false) {
  value = requireText(value, label, 240);
  if (value.startsWith('/') || value.startsWith('-') || value.includes('\\') || value.split('/').some(part => part === '..' || !part || (part === '.' && value !== '.')) || !/^[a-zA-Z0-9_./*+-]+$/.test(value) || (!allowGlob && value.includes('*')) || (allowGlob && value.slice(0, value.lastIndexOf('/') + 1).includes('*'))) fail(`${label}必须是安全的相对路径`);
  return value;
}
function managedMode(value) { if (value !== undefined && value !== 'managed') fail('仅支持平台部署，不再提供监控模式'); return 'managed'; }
function capabilities(value) { return [...new Set(list(value, 20, 'Agent 能力').map(item => requireText(item, 'Agent 能力', 80)))]; }
function workspaceSourceIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('工作区源码身份格式错误');
  const identity = {};
  for (const key of ['projectId', 'sourceVersionId', 'packageId']) {
    const value = requireText(input[key], '工作区源码标识', 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value)) fail('工作区源码标识无效');
    identity[key] = value;
  }
  if (!['frontend', 'backend'].includes(input.service)) fail('工作区源码服务无效');
  if (typeof input.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.contentHash)) fail('工作区内容校验值无效');
  const repositories = list(input.repositories, 32, '工作区仓库来源').map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('工作区仓库来源格式错误');
    const repositoryPath = relative(entry.path, '工作区仓库目录');
    validateRevision(entry.commit);
    return { path: repositoryPath, commit: entry.commit };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(repositories.map(entry => entry.path)).size !== repositories.length) fail('工作区仓库目录重复');
  return { ...identity, service: input.service, contentHash: input.contentHash, repositories };
}
function deploymentActor(input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('发布操作人格式错误');
  return { id: requireText(input.id, '发布操作人', 128), ...(input.displayName === undefined ? {} : { displayName: requireText(input.displayName, '发布操作人名称', 160) }) };
}
function transition(task, stage, done = false, occurredAt = now()) {
  task.stageHistory ||= [];
  const previous = task.stageHistory.at(-1);
  const at = new Date(Math.max(Date.parse(occurredAt), Date.parse(previous?.startedAt || occurredAt))).toISOString();
  if (previous && !previous.finishedAt && (previous.stage !== stage || done)) Object.assign(previous, { finishedAt: at, durationMs: Math.max(0, Date.parse(at) - Date.parse(previous.startedAt)) });
  if (!done && previous?.stage !== stage) task.stageHistory.push({ stage, startedAt: at });
}
function agentEventTime(task, timestamp, receivedAt) {
  const earliest = Date.parse(task.lastEventAt || task.startedAt || task.createdAt);
  const latest = Math.max(earliest, Date.parse(receivedAt));
  if (timestamp === undefined) return { at: new Date(latest).toISOString(), receivedAt };
  const reported = Date.parse(timestamp);
  // 首条带时间的事件估算固定时钟差，后续沿用，避免离线补报把耗时压缩到接收时刻。
  if (task.agentClockOffsetMs === undefined) task.agentClockOffsetMs = reported < earliest ? earliest - reported : reported > latest ? latest - reported : 0;
  const adjusted = reported + task.agentClockOffsetMs;
  // 异常时钟跳变或乱序日期只钳制到已确认时间和接收时间之间，不永久阻断补报。
  const accepted = Math.max(earliest, Math.min(adjusted, latest));
  return { at: new Date(accepted).toISOString(), receivedAt, agentTimestamp: timestamp, ...(accepted !== reported ? { timeAdjusted: true } : {}) };
}
function safeServer(server) {
  const { tokenHash, registrationHash, registrationExpiresAt, ...safe } = server;
  const policy = storagePolicy(server.storagePolicy);
  const online = !server.revoked && !!server.lastSeenAt && Date.now() - Date.parse(server.lastSeenAt) <= 60000;
  const storageState = !server.registeredAt ? 'pending' : !server.capabilities?.includes('storage-policy-v1') ? 'unsupported'
    : server.storageStatus?.revision === policy.revision ? server.storageStatus.state : server.activeTaskId ? 'waiting' : 'pending';
  return { ...safe, storagePolicy: policy, storageState, online,
    storageWaitingReason: ['pending', 'waiting'].includes(storageState) ? (!online ? 'offline' : server.activeTaskId ? 'busy' : null) : null,
    registrationState: server.revoked ? 'revoked' : server.registeredAt ? 'registered' : Date.parse(registrationExpiresAt) > Date.now() ? 'pending' : 'expired',
    registrationExpiresAt: !server.revoked && !server.registeredAt ? registrationExpiresAt ?? null : null };
}

function revokeServerRecord(state, id) {
  const server = find(state.deployments.servers, id, '服务器'); server.revoked = true; server.revokedAt = now(); delete server.tokenHash; delete server.registrationHash;
  for (const task of state.deployments.tasks.filter(task => task.serverId === id && ['queued', 'preparing'].includes(task.status))) Object.assign(task, { status: 'interrupted', stage: 'interrupted', finishedAt: now(), error: '服务器接入已撤销' });
  return { ok: true };
}
function deleteServerRecord(state, id) {
  const data = state.deployments,
    server = find(data.servers, id, '服务器')
  const targetIds = new Set(data.targets.filter((row) => row.serverId === id).map((row) => row.id))
  data.targets = data.targets.filter((row) => row.serverId !== id)
  data.tasks = data.tasks.filter((row) => row.serverId !== id && !targetIds.has(row.targetId))
  data.releases = data.releases.filter((row) => row.serverId !== id && !targetIds.has(row.targetId))
  state.events = state.events.filter((row) => row.serverId !== id && !targetIds.has(row.targetId))
  data.serverBindings = data.serverBindings.filter((item) => item.serverId !== id)
  data.servers = data.servers.filter((item) => item.id !== id)
  const requests=state.autoopsDeploymentBindings?.nodeMutationRequests;
  if(requests)requests.splice(0,requests.length,...requests.filter(row=>!JSON.stringify(row).includes(id)));

  for (const map of state.autoopsDeploymentBindings?.projects || []) {
    map.targetRequests = map.targetRequests.filter((row) => !targetIds.has(row.targetId))
    for (const key of ['serverRequests', 'mutationRequests'])
      map[key] = (map[key] || []).filter(
        (row) =>
          !JSON.stringify(row).includes(id) &&
          ![...targetIds].some((target) => JSON.stringify(row).includes(target)),
      )
    map.servers = map.servers.filter((item) => item.serverId !== id)
    if (Array.isArray(map.allowedServerIds) && map.allowedServerIds.includes(id)) {
      map.allowedServerIds = map.allowedServerIds.filter(serverId => serverId !== id);
      map.nodeAccessRevision++;
    }
  }
  return { ok: true };
}
function saveStoragePolicyRecord(state, serverId, input) {
  let next;
  try { next = storagePolicy({ ...input, revision: 1 }); } catch (error) { fail(error.message); }
  const server = find(state.deployments.servers, serverId, '服务器');
  if (server.revoked) throw new HttpError(409, '服务器接入已撤销');
  server.storagePolicy = { ...next, revision: (server.storagePolicy?.revision || DEFAULT_STORAGE_POLICY.revision) + 1 };
  state.events.unshift({ id: randomUUID(), projectId: null, action: 'server-storage-policy', serverId, at: now(), message: `更新 ${server.name} 存储策略：保留 ${next.retainedVersions} 个成功节点，平台 Docker 构建缓存 ${next.buildCacheGiB} GiB` });
  state.events = state.events.slice(0, 100);
  return safeServer(find(state.deployments.servers, serverId));
}

export function validateConfig(input = {}, module = '.', kind = input?.kind || 'java') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('部署配置格式错误');
  if (!['java', 'static'].includes(kind)) fail('服务类型无效');
  const isStatic = kind === 'static';
  const result = {
    kind,
    module: module === '.' || module === '' ? '' : relative(module, isStatic ? '前端项目目录' : 'Maven 模块'),
    artifactPath: relative(input.artifactPath || `${module === '.' || module === '' ? '' : `${module}/`}${isStatic ? 'dist' : 'target/*.jar'}`, isStatic ? '静态产物目录' : 'JAR 路径', !isStatic),
    buildImage: input.buildImage || (isStatic ? 'node:24-bookworm-slim' : 'maven:3.9.9-eclipse-temurin-8'),
    runtimeImage: isStatic ? undefined : input.runtimeImage || 'eclipse-temurin:8-jre',
    jvmArgs: list(input.jvmArgs ?? ['-Xms64m', '-Xmx192m'], 40, 'JVM 参数').map(value => requireText(value, 'JVM 参数', 1024)),
    args: list(input.args, 40, '启动参数').map(value => requireText(value, '启动参数', 1024)),
    profile: input.profile || '',
    ports: list(input.ports, 16, '端口').map(port => ({ host: port.host || '127.0.0.1', hostPort: integer(port.hostPort, undefined, 1024, 65535, '宿主机端口'), containerPort: integer(port.containerPort, undefined, 1, 65535, '容器端口') })),
    networks: list(input.networks, 8, '网络').map(value => requireText(value, '网络名称', 100)),
    volumes: list(input.volumes, 16, '数据卷').map(volume => ({ name: requireText(volume.name, '数据卷名称', 63), mountPath: requireText(volume.mountPath, '挂载目录', 200) })),
    build: { cpus: number(input.build?.cpus, 1, 0.1, 32, '构建 CPU'), memoryMb: integer(input.build?.memoryMb, 1024, 256, 65536, '构建内存') },
    runtime: { cpus: number(input.runtime?.cpus, 0.5, 0.1, 32, '运行 CPU'), memoryMb: integer(input.runtime?.memoryMb, 512, 128, 65536, '运行内存') },
    health: { path: input.health?.path || (isStatic ? '/' : '/health'), port: integer(input.health?.port, 8080, 1, 65535, '健康检查端口'), status: integer(input.health?.status, 200, 200, 399, '健康检查状态码'),
      bodyIncludes: input.health?.bodyIncludes || '', timeoutSeconds: integer(input.health?.timeoutSeconds, 180, 10, 900, '健康检查超时'), intervalSeconds: integer(input.health?.intervalSeconds, 5, 2, 60, '健康检查间隔') },
  };
  if (isStatic) {
    Object.assign(result, { packageManager: input.packageManager || 'npm', packageManagerVersion: input.packageManagerVersion || (input.packageManager === 'pnpm' ? '10.11.0' : '10.9.9'),
      buildScript: input.buildScript || 'build', buildArgs: list(input.buildArgs, 40, '构建参数').map(value => requireText(value, '构建参数', 1024)),
      jvmArgs: [], args: [], profile: '' });
    if (!['npm', 'pnpm'].includes(result.packageManager) || result.packageManagerVersion.length > 40 || !/^\d+\.\d+\.\d+$/.test(result.packageManagerVersion)) fail('请选择 npm 或指定准确版本的 pnpm');
    if (result.buildArgs.some(value => /[\x00-\x1f]/.test(value))) fail('构建参数不能包含控制字符');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(result.buildScript)) fail('构建脚本必须是 package.json 中的脚本名称');
    if (result.artifactPath === '.' || result.artifactPath.split('/').some(part => part === 'node_modules' || part === '.git')) fail('静态产物必须是独立的构建输出目录');
    if (result.volumes.length || result.ports.length || result.networks.length) fail('静态站点使用已有 Nginx，不单独配置容器端口、网络和存储');
    result.health.url = input.health?.url || '';
    if (result.health.url.length > 2000 || result.health.status !== 200) fail('静态站点访问地址过长或成功状态码不是 200');
    if (result.health.url) {
      let url; try { url = new URL(result.health.url); } catch { fail('站点访问地址无效'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('站点访问地址必须是无凭据和查询参数的 HTTP(S) 地址');
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      result.health.url = url.href;
    }
    delete result.runtimeImage; delete result.runtime;
  }
  if (!(isStatic ? [result.buildImage] : [result.buildImage, result.runtimeImage]).every(value => typeof value === 'string' && imagePattern.test(value))) fail('容器镜像名称无效');
  if (typeof result.profile !== 'string' || !/^[a-zA-Z0-9_,.-]{0,100}$/.test(result.profile)) fail('Spring Profile 无效');
  if (result.jvmArgs.some(arg => !arg.startsWith('-') || /^-(?:jar|cp|classpath|javaagent|agentlib|agentpath)(?:[:=]|$)/.test(arg))) fail('JVM 参数不能替换程序入口或加载代理');
  if (result.ports.some(port => !['127.0.0.1', '0.0.0.0'].includes(port.host))) fail('端口只允许绑定 127.0.0.1 或 0.0.0.0');
  if (new Set(result.ports.map(port => port.hostPort)).size !== result.ports.length) fail('端口配置重复');
  if (result.networks.some(value => !namePattern.test(value))) fail('网络名称无效');
  if (result.volumes.some(volume => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(volume.name) || !/^\/app\/[a-zA-Z0-9_/.-]+$/.test(volume.mountPath) || volume.mountPath.split('/').some(part => ['.', '..'].includes(part)) || volume.mountPath === '/app/app.jar')) fail('数据卷只能使用平台命名卷并挂载到 /app 下的子目录');
  if (typeof result.health.path !== 'string' || !result.health.path.startsWith('/') || result.health.path.startsWith('//') || /[\x00-\x20]/.test(result.health.path) || result.health.path.length > 512) fail('健康检查路径无效');
  if (typeof result.health.bodyIncludes !== 'string' || result.health.bodyIncludes.length > 1024) fail('健康检查响应内容过长');
  let envFiles;
  try { envFiles = normalizeEnvFiles(input.envFiles); } catch (error) { fail(error.message); }
  if (isStatic && envFiles.length) fail('静态站点不使用容器环境文件');
  if (envFiles.length) result.envFiles = envFiles;
  return result;
}

function requireEnvFileAgent(server, ...configs) {
  try { for (const config of configs) assertEnvFileAgent(config, server.capabilities); }
  catch (error) { throw new HttpError(409, error.message); }
}

// 两种项目入口共用服务器登记规则，归属映射由同一个事务提交。
function insertServer(data, input, origin) {
  const name = requireText(input.name, '服务器名称', 80), mode = managedMode(input.mode);
  if (data.servers.length >= 500) fail('服务器数量已达到上限');
  if (input.applicationId) find(data.applications, input.applicationId, '项目');
  const server = { id: randomUUID(), name, mode, createdAt: now(),
    registeredAt: null, lastSeenAt: null, version: null, revoked: false, metrics: null, containers: [] };
  data.servers.push(server);
  if (input.applicationId) data.serverBindings.push({ applicationId: input.applicationId, serverId: server.id, createdAt: now() });
  return issueRegistration(server, origin);
}

function issueRegistration(server, origin) {
  if (server.registeredAt || server.revoked || server.deleting) throw new HttpError(409, '节点已注册、已撤销或正在删除，不能重新生成接入口令');
  const registrationToken = randomSecret(), expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
  server.registrationHash = digest(registrationToken);
  server.registrationExpiresAt = expiresAt;
  // 独立临时文件避免其他账号安装后留下的固定文件阻止重试；子 Shell 保留失败退出码。
  const installCommand = origin ? `(cmr_installer=$(mktemp /tmp/cmr-agent-install.XXXXXX) && trap 'rm -f -- "$cmr_installer"' EXIT && curl -fsS --proto '=https' --tlsv1.2 '${origin}/agent/install.sh' -o "$cmr_installer" && sudo bash "$cmr_installer" --url '${origin}' --token '${registrationToken}')` : null;
  return { server: structuredClone(safeServer(server)), registrationToken, expiresAt, installCommand };
}

// 旧入口与项目用例复用同一事务规则，避免配置和归属校验产生两套实现。
function saveEntityRecord(state, kind, input, id, { defaultEnvironments = false } = {}) {
  if (!['applications', 'environments', 'services', 'targets'].includes(kind)) fail('配置类型错误');
  const data = state.deployments; let item = id ? find(data[kind], id) : { id: randomUUID(), createdAt: now() };
  if (!id && data[kind].length >= 2000) fail('配置数量已达到上限');
  if (id && data.tasks.some(task => task.targetId === id && !terminal.has(task.status))) throw new HttpError(409, '目标存在未完成任务，请完成后再修改');
  let fields;
  if (kind === 'applications') {
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) fail('项目说明最多 500 字');
    fields = { name: requireText(input.name, '业务项目名称', 80), description: input.description || '' };
  }
  if (kind === 'environments') {
    find(data.applications, input.applicationId, '项目');
    if (input.sourceProjectId) {
      const source = find(state.projects, input.sourceProjectId, '源码仓库');
      if (source.applicationId && source.applicationId !== input.applicationId) fail('仓库不属于当前项目');
      source.applicationId = input.applicationId;
    }
    if (id && item.applicationId !== input.applicationId) fail('不能修改环境所属项目');
    fields = { applicationId: input.applicationId, sourceProjectId: input.sourceProjectId, name: requireText(input.name, '环境名称', 80) };
  }
  if (kind === 'services') {
    find(data.applications, input.applicationId, '业务项目'); if (id && item.applicationId !== input.applicationId) fail('不能修改服务所属项目');
    const serviceKind = input.kind || item.kind || 'java';
    if (!['java', 'static'].includes(serviceKind)) fail('服务类型无效');
    if (id && serviceKind !== (item.kind || 'java') && data.targets.some(target => target.serviceId === id)) fail('已有部署目标的服务不能切换类型，请新建服务');
    if (id && data.tasks.some(task => !terminal.has(task.status) && data.targets.some(target => target.id === task.targetId && target.serviceId === id))) throw new HttpError(409, '服务存在未完成任务，请完成后再修改');
    fields = { applicationId: input.applicationId, name: requireText(input.name, '服务名称', 80), kind: serviceKind, module: relative(input.module || '.', '项目目录或模块') };
    for (const target of data.targets.filter(target => target.serviceId === id)) validateConfig(target.config, fields.module, serviceKind);
  }
  if (kind === 'targets') {
    const environment = find(data.environments, input.environmentId, '环境'); const service = find(data.services, input.serviceId, '服务'); const server = find(data.servers, input.serverId, '服务器');
    if (environment.applicationId !== service.applicationId) fail('环境与服务不属于同一个项目');
    if (!data.serverBindings.some(item => item.applicationId === environment.applicationId && item.serverId === server.id)) {
      if (!environment.sourceProjectId) fail('请先在项目内绑定服务器');
      data.serverBindings.push({ applicationId: environment.applicationId, serverId: server.id, createdAt: now() });
    }
    managedMode(input.mode);
    if (server.revoked) fail('服务器已撤销');
    if (id && (item.retiredAt || item.mode !== 'managed')) fail('旧外部目标已停用，请新建部署目标');
    if (id && ['serverId', 'environmentId', 'serviceId'].some(key => item[key] !== input[key])) fail('不能改变已有目标的归属，请新建隔离目标');
    if (data.targets.some(target => !target.retiredAt && target.id !== id && target.environmentId === environment.id && target.serviceId === service.id && target.serverId === server.id)) fail('该服务在此服务器已存在部署目标');
    if (input.containerName) fail('平台目标不能指定外部容器名称');
    let binding;
    try { binding = networkIdentity(input.networkIdentity === undefined ? item.networkIdentity : input.networkIdentity); } catch (error) { fail(error.message); }
    if (binding && service.kind === 'static') fail('静态站点无需固定容器网络别名');
    if (item.networkIdentity && JSON.stringify(binding) !== JSON.stringify(networkIdentity(item.networkIdentity))) fail('固定网络别名不能更改或移除，请为不同网络身份新建部署位置');
    if (binding && data.targets.some(target => !target.retiredAt && target.id !== item.id && target.serverId === server.id && target.networkIdentity?.network === binding.network && target.networkIdentity?.alias === binding.alias)) fail('该服务器网络中的固定别名已被其他部署位置使用');
    fields = { environmentId: environment.id, serviceId: service.id, serverId: server.id, applicationId: environment.applicationId, mode: 'managed', containerName: service.kind === 'static' ? null : `cmr-${item.id}`,
      config: validateConfig(input.config, service.module, service.kind || 'java'), networkIdentity: binding, owner: 'platform' };
  }
  Object.assign(item, fields, { updatedAt: now() });
  if (!id) {
    data[kind].push(item);
    if (kind === 'applications' && defaultEnvironments) {
      if (data.environments.length + 2 > 2000) fail('环境数量已达到上限');
      for (const name of ['测试', '生产']) data.environments.push({ id: randomUUID(), applicationId: item.id, name, createdAt: now() });
    }
  }
  return structuredClone(item);
}

function effectiveTargetConfig(data, targetId) {
  const target = find(data.targets, targetId), service = find(data.services, target.serviceId);
  return validateConfig(target.config, service.module, service.kind || 'java');
}

function targetConfigKey(data, targetId) {
  const target = find(data.targets, targetId);
  const source = data.environmentSources.find(item => item.environmentId === target.environmentId && item.serviceId === target.serviceId);
  return digest(JSON.stringify([effectiveTargetConfig(data, targetId), source?.sourceProjectId, target.networkIdentity || null]));
}

function submissionFingerprint(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('发布请求收据校验值无效');
  return value;
}

function sameTaskRequest(task, requestFingerprint, submission) {
  return task.submissionFingerprint && submission
    ? task.submissionFingerprint === submission
    : task.requestFingerprint === requestFingerprint;
}

export class DeploymentService extends EventEmitter {
  constructor(
    repository,
    {
      publicOrigin = '',
      authorizeTask,
      authorizeProjectMutation,
      resolveWorkspaceSource,
      maintainWorkspacePackages,
    } = {},
  ) {
    super()
    if (authorizeTask !== undefined && typeof authorizeTask !== 'function')
      throw new TypeError('任务授权端口必须是函数')
    if (resolveWorkspaceSource !== undefined && typeof resolveWorkspaceSource !== 'function')
      throw new TypeError('工作区源码解析端口必须是函数')
    if (authorizeProjectMutation !== undefined && typeof authorizeProjectMutation !== 'function')
      throw new TypeError('部署写入授权端口必须是函数')
    this.authorizeTask = authorizeTask
    this.authorizeProjectMutation = authorizeProjectMutation
    this.resolveWorkspaceSource = resolveWorkspaceSource
    this.maintainWorkspacePackages = maintainWorkspacePackages
    this.repository = repository
    this.store = repository.store
    this.publicOrigin = publicOrigin
    this.root = path.join(repository.directory, 'deployments')
    this.preparations = new Map()
    this.sourceCleanups = new Set()
    this.archives = new SourceArchives(this)
    this.projects = createProjectDeployments({
      store: this.store,
      validateConfig,
      saveEntity: saveEntityRecord,
      configKey: targetConfigKey,
      publicServer: (server) => structuredClone(safeServer(server)),
      revokeServer: revokeServerRecord,
      deleteServer: deleteServerRecord,
      saveStoragePolicy: saveStoragePolicyRecord,
      authorizeMutation: authorizeProjectMutation,
      cleanupTasks: (ids) => this.cleanupDeletedTasks(ids),
      insertServer: (data, input) => insertServer(data, input, this.publicOrigin),
      renewRegistration: (state, serverId) => issueRegistration(find(state.deployments.servers, serverId, '服务器'), this.publicOrigin),
      changed: (type, id) => this.changed(type, id),
    })
  }
  async cleanupDeletedTasks(taskIds) {
    const ids = new Set(taskIds)
    await this.store.change((state) => {
      for (const task of state.deployments.tasks)
        if (ids.has(task.id) && ['queued', 'preparing'].includes(task.status)) {
          transition(task, 'interrupted', true)
          Object.assign(task, {
            status: 'interrupted',
            stage: 'interrupted',
            finishedAt: now(),
            error: '所属对象正在删除',
          })
        }
    })
    await Promise.allSettled(taskIds.map((id) => this.preparations.get(id)).filter(Boolean))
    // 已领取的远端操作仍需回传最终结果；不提前撤销身份或释放任务锁。
    if (this.data.tasks.some((task) => ids.has(task.id) && task.status === 'running'))
      throw new HttpError(409, '部署任务仍在执行，结束后可继续原删除')
    await this.archives.removeForTasks(taskIds);
    for (const id of taskIds)
      await rm(path.join(this.root, 'tasks', id), { recursive: true, force: true })
  }
  async purgeScope(projectId, environmentId) {
    await this.cleanupDeletedTasks(this.projects.scopeTaskIds(projectId, environmentId))
    await this.projects.purgeScope(projectId, environmentId)
  }
  get data() { return this.store.state.deployments; }
  changed(type, id, applicationId) { this.emit('update', { type, id, applicationId, at: now() }); }
  async initialize() {
    await mkdir(path.join(this.root, 'tasks'), { recursive: true, mode: 0o700 });
    await this.store.change(state => {
      state.deployments ||= { version: 1 };
      if (![1, 2].includes(state.deployments.version)) throw new Error('不支持的部署数据版本');
      for (const key of collections) state.deployments[key] ||= [];
      // 升级只开放服务器部署能力，旧外部目标停止采集并保留历史，不转换其容器归属。
      for (const server of state.deployments.servers) if (server.mode === 'observe') server.mode = 'managed';
      for (const target of state.deployments.targets) if (target.mode !== 'managed' && !target.retiredAt) target.retiredAt = now();
    });
    await migrateWorkspaces(this.store, this.repository.directory);
    await this.archives.migrate();
    await this.cleanupSources();
    this.archiveCleanupTimer = setInterval(() => this.cleanupSources().catch(() => this.emit('error-safe', { message: '过期失败源码清理延后' })), 3600000);
    this.archiveCleanupTimer.unref();
    for (const task of this.data.tasks.filter(task => task.status === 'preparing')) this.startPrepare(task.id);
    this.commitBackfill = this.backfillCommitSubjects().catch(() => {
      this.emit('error-safe', { message: '部分历史版本的提交说明暂时无法补齐' });
    });
  }
  async backfillCommitSubjects() {
    const updates = new Map(), cache = new Map();
    const releases = this.data.releases.filter(release => typeof release.commitSubject !== 'string');
    for (const release of releases) {
      if (this.closing) break;
      const task = this.data.tasks.find(task => task.id === release.id);
      const snapshot = release.sourceSnapshot || task?.sourceSnapshot;
      if (!snapshot || !release.revision) continue;
      const key = `${sourceKey(snapshot)}:${release.revision}`;
      if (!cache.has(key)) {
        const subject = await this.repository.cachedCommitSubject(snapshot, release.revision).catch(() => null);
        cache.set(key, subject);
      }
      const subject = cache.get(key);
      if (typeof subject === 'string') updates.set(release.id, { revision: release.revision, subject: subject.slice(0, 500) });
    }
    if (!updates.size) return;
    await this.store.change(state => {
      const apply = release => {
        const update = release && updates.get(release.id);
        if (update && release.revision === update.revision && typeof release.commitSubject !== 'string') release.commitSubject = update.subject;
      };
      for (const release of state.deployments.releases) apply(release);
      for (const target of state.deployments.targets) apply(target.currentRelease);
      for (const task of state.deployments.tasks) {
        apply(task); apply(task.previousRelease); apply(task.release);
      }
    });
    this.changed('releases');
  }
  async copyArchive(archive, taskId) {
    if (archive.size > 64 * 1024 * 1024) throw new HttpError(413, 'Agent 仅支持不超过 64 MiB 的源码 ZIP；普通源码下载接口不受此限制');
    const directory = path.join(this.root, 'tasks', taskId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const source = await this.archives.import(find(this.data.tasks, taskId, '任务'), archive);
    await copyFile(archive.file, path.join(directory, 'source.zip'));
    await atomicWrite(path.join(directory, 'source.json'), JSON.stringify(source));
    return source;
  }
  overview() {
    return { servers: this.data.servers.map(safeServer), applications: this.data.applications, environments: this.data.environments,
      services: this.data.services, targets: this.data.targets.filter(target => !target.retiredAt && target.mode === 'managed'), tasks: this.data.tasks.slice(-200).reverse() };
  }
  async createServer(input) {
    const result = await this.store.change(state => insertServer(state.deployments, input, this.publicOrigin));
    this.changed('server', result.server.id);
    return result;
  }
  async revokeServer(id) {
    await this.store.change(state => revokeServerRecord(state, id));
    this.changed('server', id);
  }
  async deleteServer(id) {
    await this.store.change((state) => {
      find(state.deployments.servers, id, '服务器').deleting = true
    })
    await this.cleanupDeletedTasks(
      this.data.tasks.filter((task) => task.serverId === id).map((task) => task.id),
    )
    await this.store.change((state) => deleteServerRecord(state, id))
    this.changed('server', id)
  }
  async register(input) {
    if (typeof input.registrationToken !== 'string') throw new HttpError(401, '接入口令无效');
    const token = randomSecret(); let id;
    await this.store.change(state => {
      const server = state.deployments.servers.find(server => !server.revoked && server.registrationHash && equal(server.registrationHash, digest(input.registrationToken)));
      if (!server || server.registeredAt || Date.parse(server.registrationExpiresAt) <= Date.now()) throw new HttpError(401, '接入口令无效、已使用或已过期');
      id = server.id; server.tokenHash = digest(token); server.registeredAt = now(); server.lastSeenAt = now(); server.version = requireText(input.version || 'unknown', 'Agent 版本', 80); server.capabilities = capabilities(input.capabilities);
      delete server.registrationHash;
    });
    this.changed('server', id);
    return { serverId: id, token, ...this.assignment(id) };
  }
  authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'Agent 凭据无效');
    const server = this.data.servers.find(server => !server.revoked && server.tokenHash && equal(server.tokenHash, digest(token)));
    if (!server) throw new HttpError(401, 'Agent 凭据无效或已撤销');
    return server.id;
  }
  assignment(serverId) { const server = find(this.data.servers, serverId, '服务器'); return { mode: 'managed', storagePolicy: storagePolicy(server.storagePolicy), targets: this.overview().targets.filter(target => target.serverId === serverId) }; }
  async saveStoragePolicy(serverId, input) {
    const result = await this.store.change(state => saveStoragePolicyRecord(state, serverId, input));
    this.changed('server', serverId); return result;
  }
  async heartbeat(serverId, input) {
    if (input.staticRoot !== undefined && (typeof input.staticRoot !== 'string' || input.staticRoot.length > 512 || !/^\/[A-Za-z0-9_./-]+$/.test(input.staticRoot) || input.staticRoot.split('/').some(part => part === '..' || part === '.'))) fail('静态发布根目录报告无效');
    if (input.metrics !== undefined && (!input.metrics || typeof input.metrics !== 'object' || Array.isArray(input.metrics))) fail('主机指标格式错误');
    const containers = list(input.containers, 500, '容器状态');
    const version = input.version === undefined ? undefined : requireText(input.version, 'Agent 版本', 80);
    const storageStatus = input.storageStatus;
    if (storageStatus != null && (typeof storageStatus !== 'object' || Array.isArray(storageStatus) || JSON.stringify(storageStatus).length > 65536 || !Number.isSafeInteger(storageStatus.revision) || storageStatus.revision < 1 || !['applying', 'applied', 'failed'].includes(storageStatus.state))) fail('存储策略执行状态无效');
    if (storageStatus != null) {
      if (storageStatus.errors !== undefined && (!Array.isArray(storageStatus.errors) || storageStatus.errors.length > 500 || storageStatus.errors.some(error => typeof error !== 'string' || error.length > 1000))) fail('清理错误报告无效');
      if (storageStatus.targets !== undefined && (!Array.isArray(storageStatus.targets) || storageStatus.targets.length > 2000 || storageStatus.targets.some(target => !target || typeof target.targetId !== 'string' || !Number.isSafeInteger(target.retainedNodes) || target.retainedNodes < 0))) fail('本机版本用量无效');
      if (storageStatus.cache !== undefined && (!storageStatus.cache || typeof storageStatus.cache !== 'object' || ['bytes', 'limitBytes', 'reclaimedBytes'].some(key => !Number.isSafeInteger(storageStatus.cache[key]) || storageStatus.cache[key] < 0))) fail('构建缓存用量无效');
    }
    await this.store.change(state => {
      const server = find(state.deployments.servers, serverId, '服务器');
      if (server.revoked) throw new HttpError(401, 'Agent 已撤销');
      Object.assign(server, { lastSeenAt: now(), metrics: input.metrics || null, activeTaskId: input.activeTaskId || null });
      server.staticRoot = input.staticRoot ?? null;
      if (version !== undefined) server.version = version;
      if (storageStatus != null) server.storageStatus = structuredClone(storageStatus);
      if (input.capabilities !== undefined || version !== undefined) server.capabilities = capabilities(input.capabilities);
      const targets = state.deployments.targets.filter(target => target.serverId === serverId && target.mode === 'managed' && !target.retiredAt);
      server.containers = containers.filter(container => container && targets.some(target => container.targetId === target.id)).map(container => structuredClone(container));
      for (const target of targets) {
        const observation = server.containers.find(container => container.targetId === target.id);
        if (observation) { target.observation = observation; target.lastObservedAt = now(); }
      }
    });
    this.changed('heartbeat', serverId); return this.assignment(serverId);
  }
  async saveEntity(kind, input, id, options) {
    const result = await this.store.change(state => saveEntityRecord(state, kind, input, id, options));
    this.changed(kind, result.id); return result;
  }
  ensureManaged(data, targetId, allowDeleting = false) {
    const target = find(data.targets, targetId, '部署目标')
    const server = find(data.servers, target.serverId, '服务器')
    if (!allowDeleting && (target.deleting || server.deleting))
      throw new HttpError(409, '部署位置正在删除，请继续原删除')
    if (target.retiredAt || target.mode !== 'managed' || server.mode !== 'managed')
      throw new HttpError(403, '目标不属于平台，禁止发布、重启和回退')
    if (server.revoked) throw new HttpError(409, '服务器已撤销')
    return target
  }
  configKey(targetId) { return targetConfigKey(this.data, targetId); }
  // 读取下次任务使用的配置，不回写目标草稿或历史版本快照。
  effectiveConfig(targetId) { return effectiveTargetConfig(this.data, targetId); }
  authorizeWorkspaceTask(task, target) {
    if (!this.authorizeTask) return;
    const decision = this.authorizeTask({ task: structuredClone(task), target: structuredClone(target) });
    if (decision?.then) { Promise.resolve(decision).catch(() => {}); throw new HttpError(503, '任务授权端口不支持异步返回'); }
  }
  async createTaskFromWorkspaceSource(input) {
    if (this.closing) throw new HttpError(503, '中心正在停止，请稍后重试');
    if (!this.resolveWorkspaceSource) throw new HttpError(503, '工作区源码发布尚未配置');
    if (!input || typeof input !== 'object' || Array.isArray(input) || (input.action !== undefined && input.action !== 'deploy')) fail('源码选择发布参数无效');
    if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) fail('幂等请求标识无效');
    if (typeof input.configKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.configKey)) fail('发布配置校验值无效');
    const projectId = requireText(input.projectId, '项目标识', 128), actor = deploymentActor(input.actor), submission = submissionFingerprint(input.submissionFingerprint);
    if (!actor) fail('发布操作人不能为空');
    const scope = this.projects.target(projectId, input.targetId);
    const sourceSelection = normalizeDeploymentSourceSelection(input.sourceSelection || {}, scope.service, validateConfig);
    const sourceRefs = deploymentSourceRefs(input.sourceRefs, sourceSelection);
    const fingerprint = digest(JSON.stringify(['workspace-selection', projectId, input.targetId, sourceSelection, input.configKey, actor.id, ...(sourceRefs ? [sourceRefs] : [])]));
    const task = await this.store.change(state => {
      if (this.closing) throw new HttpError(503, '中心正在停止，请稍后重试');
      const data = state.deployments, existing = data.tasks.find(entry => entry.requestId === input.requestId);
      if (existing) {
        if (!sameTaskRequest(existing, fingerprint, submission)) throw new HttpError(409, '同一请求标识不能用于不同发布参数');
        return structuredClone(existing);
      }
      const target = this.ensureManaged(data, input.targetId), service = find(data.services, target.serviceId), server = find(data.servers, target.serverId);
      if (target.applicationId !== scope.target.applicationId || service.applicationId !== target.applicationId || !data.serverBindings.some(binding => binding.applicationId === target.applicationId && binding.serverId === target.serverId)) fail('部署目标的项目归属或服务器绑定无效');
      if (input.configKey !== targetConfigKey(data, target.id)) throw new HttpError(409, '发布配置已变化，请刷新后重新确认');
      if (target.networkIdentity && !server.capabilities?.includes('fixed-network-alias-v1')) throw new HttpError(409, '请先升级目标 Agent，使其支持固定网络别名');
      if (service.kind === 'static' && !server.capabilities?.includes('static-site-v1')) throw new HttpError(409, '请先升级目标服务器 Agent，使其支持静态站点发布');
      if (service.kind === 'static' && !target.config.health?.url) fail('请先配置站点访问地址，并将已有 Nginx 指向该目标的发布目录');
      if (data.tasks.filter(entry => !terminal.has(entry.status)).length >= 200) throw new HttpError(503, '部署队列已满');
      const created = { id: randomUUID(), targetId: target.id, applicationId: target.applicationId, serverId: target.serverId, action: 'deploy', status: 'preparing', stage: 'preparing',
        sourceKind: 'workspace-package', workspaceProjectId: projectId, sourceSelection, ...(sourceRefs ? { sourceRefs } : {}), actor, requestId: input.requestId, requestFingerprint: fingerprint,
        ...(submission ? { submissionFingerprint: submission } : {}),
        detailedAgentStages: !!server.capabilities?.includes('delivery-telemetry-v1'), recoveryAllowed: !!server.capabilities?.includes('source-archive-recovery-v1'),
        networkIdentity: structuredClone(target.networkIdentity || null), config: effectiveTargetConfig(data, target.id),
        sourceSnapshot: null, source: null, createdAt: now(), updatedAt: now(), lastSeq: 0 };
      this.authorizeWorkspaceTask(created, target);
      requireEnvFileAgent(server, created.config, target.currentRelease?.config);
      transition(created, 'preparing'); data.tasks.push(created); return structuredClone(created);
    });
    if (task.status === 'preparing') this.startPrepare(task.id);
    this.changed('task', task.id, task.applicationId); return task;
  }
  // 内部接口：调用方先校验用户、业务项目与工作区包权限；文件路径绝不来自浏览器。
  async createTaskFromArchive(input, archive) {
    if (this.closing) throw new HttpError(503, '中心正在停止，请稍后重试');
    if (!input || typeof input !== 'object' || Array.isArray(input) || (input.action !== undefined && input.action !== 'deploy')) fail('仅支持工作区源码发布');
    input = { ...input };
    if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) fail('幂等请求标识无效');
    if (typeof input.configKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.configKey)) fail('发布配置校验值无效');
    const sourceIdentity = workspaceSourceIdentity(input.sourceIdentity), actor = deploymentActor(input.actor), submission = submissionFingerprint(input.submissionFingerprint);
    if (!archive || typeof archive !== 'object' || Array.isArray(archive) || typeof archive.file !== 'string' || !path.isAbsolute(archive.file)) fail('工作区源码档案无效');
    if (typeof archive.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(archive.sha256)) fail('源码包校验值无效');
    integer(archive.size, undefined, 1, Number.MAX_SAFE_INTEGER, '源码包大小');
    if (archive.size > 64 * 1024 * 1024) throw new HttpError(413, 'Agent 仅支持不超过 64 MiB 的源码 ZIP');
    validateRevision(archive.revision);
    const fixedArchive = { file: archive.file, sha256: archive.sha256, size: archive.size, revision: archive.revision,
      ...(archive.commitSubject === undefined ? {} : { commitSubject: requireText(archive.commitSubject, '源码提交说明', 500) }) };
    const requestFingerprint = digest(JSON.stringify(['workspace-package', input.targetId, input.configKey, sourceIdentity, fixedArchive.sha256, fixedArchive.size, fixedArchive.revision, fixedArchive.commitSubject || null, actor?.id || null]));
    const duplicate = data => {
      const existing = data.tasks.find(item => item.requestId === input.requestId);
      if (existing && !sameTaskRequest(existing, requestFingerprint, submission)) throw new HttpError(409, '同一请求标识不能用于不同发布参数');
      return existing;
    };
    const repeated = duplicate(this.data); if (repeated) return structuredClone(repeated);
    const info = await lstat(fixedArchive.file);
    if (!info.isFile() || info.isSymbolicLink()) fail('源码档案必须是普通文件');
    const actual = await checksum(fixedArchive.file);
    if (actual.size !== fixedArchive.size || actual.sha256 !== fixedArchive.sha256) throw new HttpError(409, '源码包校验失败，未创建发布任务');
    const taskId = randomUUID();
    const task = await this.store.change(state => {
      if (this.closing) throw new HttpError(503, '中心正在停止，请稍后重试');
      const data = state.deployments, existing = duplicate(data); if (existing) return structuredClone(existing);
      const target = this.ensureManaged(data, input.targetId), environment = find(data.environments, target.environmentId), service = find(data.services, target.serviceId), server = find(data.servers, target.serverId);
      if (target.applicationId !== environment.applicationId || target.applicationId !== service.applicationId || !data.serverBindings.some(binding => binding.applicationId === target.applicationId && binding.serverId === server.id)) fail('部署目标的项目归属或服务器绑定无效');
      if (input.configKey !== this.configKey(target.id)) throw new HttpError(409, '发布配置已变化，请刷新后重新确认');
      if ((service.kind === 'static') !== (sourceIdentity.service === 'frontend')) fail('工作区部署包与服务类型不匹配');
      if (target.networkIdentity && !server.capabilities?.includes('fixed-network-alias-v1')) throw new HttpError(409, '请先升级目标 Agent，使其支持固定网络别名');
      if (service.kind === 'static' && !server.capabilities?.includes('static-site-v1')) throw new HttpError(409, '请先升级目标服务器 Agent，使其支持静态站点发布');
      if (service.kind === 'static' && !target.config.health?.url) fail('请先配置站点访问地址，并将已有 Nginx 指向该目标的发布目录');
      if (data.tasks.filter(item => !terminal.has(item.status)).length >= 200) throw new HttpError(503, '部署队列已满');
      const current = { id: taskId, targetId: target.id, applicationId: target.applicationId, serverId: target.serverId, action: 'deploy', status: 'preparing', stage: 'preparing',
        sourceKind: 'workspace-package', sourceIdentity, ...(actor ? { actor } : {}),
        detailedAgentStages: server.capabilities?.includes('delivery-telemetry-v1') || false,
        networkIdentity: structuredClone(target.networkIdentity || null), createdAt: now(), updatedAt: now(),
        config: effectiveTargetConfig(data, target.id), sourceSnapshot: null, source: null,
        revision: fixedArchive.revision, commitSubject: fixedArchive.commitSubject,
        recoveryAllowed: !!server.capabilities?.includes('source-archive-recovery-v1'), requestId: input.requestId, requestFingerprint, ...(submission ? { submissionFingerprint: submission } : {}), lastSeq: 0 };
      this.authorizeWorkspaceTask(current, target);
      requireEnvFileAgent(server, current.config, target.currentRelease?.config);
      transition(current, 'preparing'); data.tasks.push(current); return structuredClone(current);
    });
    if (task.id === taskId) await this.startPrepare(task.id, fixedArchive);
    this.changed('task', task.id, task.applicationId);
    return structuredClone(find(this.data.tasks, task.id, '任务'));
  }
  async createTask(input) {
    if (this.closing) throw new HttpError(503, '中心正在停止，请稍后重试');
    if (!['deploy', 'restart', 'rollback'].includes(input.action)) fail('操作类型无效');
    const requestFingerprint = digest(JSON.stringify([input.targetId, input.action, input.branch || null, input.revision || null, input.releaseId || null, input.sourceKey || null, input.configKey || null, input.actor?.id || null]));
    const submission = submissionFingerprint(input.submissionFingerprint);
    if (input.requestId && !/^[a-f0-9-]{36}$/.test(input.requestId)) fail('幂等请求标识无效');
    const duplicate = data => {
      const existing = input.requestId && data.tasks.find(item => item.requestId === input.requestId);
      if (existing && !sameTaskRequest(existing, requestFingerprint, submission)) throw new HttpError(409, '同一请求标识不能用于不同发布参数');
      return existing;
    };
    const repeated = duplicate(this.data); if (repeated) return structuredClone(repeated);
    if (input.action === 'rollback') {
      const release = this.data.releases.find(item => item.id === input.releaseId && item.targetId === input.targetId);
      if (release?.sourceArchiveId && !release.sourceClearedAt) await this.archives.verify(release);
    }
    if (input.branch !== undefined && input.action === 'deploy' && (!input.revision || !input.sourceKey || !input.configKey || !input.requestId)) fail('请选择分支和具体提交，并刷新发布配置');
    const taskId = randomUUID();
    let selection, selectedCommit;
    if (input.action === 'deploy' && input.revision) {
      validateRevision(input.revision);
      const target = this.ensureManaged(this.data, input.targetId);
      const environment = find(this.data.environments, target.environmentId);
      const source = this.data.environmentSources.find(item => item.environmentId === target.environmentId && item.serviceId === target.serviceId);
      const repository = find(this.store.state.projects, source?.sourceProjectId || environment.sourceProjectId);
      selection = sourceSnapshot(repository, validateBranch(input.branch || source?.branch || repository.defaultBranch || repository.branch));
      const history = await this.repository.history(selection);
      selectedCommit = history.commits.find(commit => commit.revision === input.revision);
      if (!selectedCommit) throw new HttpError(409, '提交记录已变化，请更新代码后重新选择');
      await this.repository.pinRevision({ ...selection, revision: input.revision }, taskId);
    }
    let task;
    try { task = await this.store.change(state => {
      if (this.closing) throw new HttpError(503, '中心正在停止，请稍后重试');
      const data = state.deployments; const target = this.ensureManaged(data, input.targetId); const environment = find(data.environments, target.environmentId); const service = find(data.services, target.serviceId);
      const previousRequest = duplicate(data); if (previousRequest) return structuredClone(previousRequest);
      if (target.networkIdentity && !find(data.servers, target.serverId).capabilities?.includes('fixed-network-alias-v1')) throw new HttpError(409, '请先升级目标 Agent，使其支持固定网络别名');
      if (service.kind === 'static' && !find(data.servers, target.serverId).capabilities?.includes('static-site-v1')) throw new HttpError(409, '请先升级目标服务器 Agent，使其支持静态站点发布');
      if (service.kind === 'static' && input.action === 'restart') throw new HttpError(400, '静态站点无需重启共用 Nginx，请使用发布或回退');
      if (service.kind === 'static' && input.action === 'deploy' && !target.config.health?.url) throw new HttpError(400, '请先配置站点访问地址，并将已有 Nginx 指向该目标的发布目录');
      if (data.tasks.filter(task => !terminal.has(task.status)).length >= 200) throw new HttpError(503, '部署队列已满');
      const selected = data.environmentSources.find(item => item.environmentId === environment.id && item.serviceId === service.id);
      let release;
      if (input.action === 'rollback') {
        release = find(data.releases.filter(release => release.targetId === target.id), input.releaseId, '回退版本');
        if (!release.available || release.sourceClearedAt) throw new HttpError(409, '该版本源码已清理或无法恢复');
      }
      if (input.action === 'restart') { release = target.currentRelease; if (!release) throw new HttpError(409, '目标尚无成功部署版本'); }
      const sourceProject = input.action === 'deploy' ? find(state.projects, selected?.sourceProjectId || environment.sourceProjectId, '源码仓库') : (release.sourceSnapshot || { id: release.sourceProjectId });
      if (sourceProject.applicationId && sourceProject.applicationId !== target.applicationId) fail('仓库不属于当前项目');
      if (!sourceProject.enabled && input.action === 'deploy') throw new HttpError(409, '源码项目已停用');
      const snapshot = input.action === 'deploy' ? sourceSnapshot(sourceProject, validateBranch(input.branch || selected?.branch || sourceProject.defaultBranch || sourceProject.branch)) : structuredClone(release.sourceSnapshot || null);
      if (input.action === 'deploy' && input.sourceKey && input.sourceKey !== sourceKey(snapshot)) throw new HttpError(409, '环境源码配置已变化，请刷新发布工作台');
      if (selection && sourceKey(selection) !== sourceKey(snapshot)) throw new HttpError(409, '环境源码配置已变化，请重新选择提交');
      if (input.configKey && input.configKey !== this.configKey(target.id)) throw new HttpError(409, '发布配置已变化，请刷新后重新确认');
      if (input.revision && input.action === 'deploy') snapshot.revision = input.revision;
      const archived = release && this.archives.releaseSource(release);
      const supportsRecovery = find(data.servers, target.serverId).capabilities?.includes('source-archive-recovery-v1');
      if (input.action === 'rollback' && archived && input.requestId && !supportsRecovery) throw new HttpError(409, '请先升级目标 Agent 以支持源码档案恢复；旧客户端仍可使用原本机缓存恢复接口');
      const task = { id: taskId, targetId: target.id, applicationId: target.applicationId, serverId: target.serverId, action: input.action, status: input.action === 'deploy' ? 'preparing' : 'queued', stage: 'queued',
        detailedAgentStages: find(data.servers, target.serverId).capabilities?.includes('delivery-telemetry-v1') || false,
        networkIdentity: structuredClone(target.networkIdentity || null),
        createdAt: now(), updatedAt: now(), config: release ? structuredClone(release.config) : effectiveTargetConfig(data, target.id),
        sourceProjectId: sourceProject.id, sourceSnapshot: snapshot, source: archived ? { ...archived, url: `/api/agent/v1/tasks/${taskId}/source` } : null,
        ...(release?.sourceKind === 'workspace-package' ? { sourceKind: release.sourceKind, sourceIdentity: structuredClone(release.sourceIdentity) } : {}),
        ...(release?.sourceRefs ? { sourceRefs: structuredClone(release.sourceRefs) } : {}),
        ...((release?.sourceSelection || data.tasks.find(entry => entry.id === release?.id)?.sourceSelection) ? { sourceSelection: structuredClone(release.sourceSelection || data.tasks.find(entry => entry.id === release.id).sourceSelection) } : {}),
        ...(input.actor === undefined ? {} : { actor: deploymentActor(input.actor) }),
        sourceArchiveId: archived?.archiveId, revision: release?.revision || input.revision, commitSubject: release?.commitSubject || selectedCommit?.subject,
        recoveryAllowed: !!supportsRecovery, requestId: input.requestId, requestFingerprint, ...(submission ? { submissionFingerprint: submission } : {}), lastSeq: 0, ...(release ? { release: structuredClone(release) } : {}) };
      this.authorizeWorkspaceTask(task, target);
      transition(task, task.status);
      requireEnvFileAgent(find(data.servers, target.serverId), task.config, target.currentRelease?.config);
      data.tasks.push(task); return structuredClone(task);
    }); } catch (error) {
      if (selection) await this.repository.releasePin(selection, taskId).catch(() => {});
      throw error;
    }
    if (task.id !== taskId && selection) await this.repository.releasePin(selection, taskId).catch(() => {});
    if (task.status === 'preparing') this.startPrepare(task.id);
    this.changed('task', task.id); return task;
  }
  startPrepare(id, archive) {
    if (this.preparations.has(id)) return this.preparations.get(id);
    const promise = this.prepare(id, archive).catch(error => { this.emit('error-safe', { taskId: id, message: error.message }); }).finally(() => this.preparations.delete(id));
    this.preparations.set(id, promise); return promise;
  }
  async prepareWorkspaceArchive(id, archive) {
    let cleanup;
    try {
      let task = find(this.data.tasks, id, '任务');
      if (task.status !== 'preparing') return;
      if (task.sourceSelection) this.authorizeWorkspaceTask(task, this.ensureManaged(this.data, task.targetId));
      if (!task.source?.archiveId && task.sourceSelection) {
        if (!this.resolveWorkspaceSource) throw new HttpError(503, '工作区源码解析端口不可用，尚未发布');
        const resolved = await this.resolveWorkspaceSource(structuredClone(task));
        cleanup = resolved?.cleanup;
        archive = resolved?.archive;
        if (!archive || typeof archive.file !== 'string' || !path.isAbsolute(archive.file) || !/^[a-f0-9]{64}$/.test(archive.sha256)) fail('工作区源码档案无效');
        integer(archive.size, undefined, 1, 64 * 1024 * 1024, '源码包大小'); validateRevision(archive.revision);
        const info = await lstat(archive.file);
        if (!info.isFile() || info.isSymbolicLink()) fail('源码档案必须是普通文件');
        const identity = workspaceSourceIdentity(resolved.sourceIdentity);
        if (identity.projectId !== task.workspaceProjectId || (identity.service === 'frontend') !== (task.config.kind === 'static')) fail('固定源码与发布项目或服务类型不匹配');
        const pendingSource = { sha256: archive.sha256, size: archive.size, revision: archive.revision, ...(archive.commitSubject === undefined ? {} : { commitSubject: requireText(archive.commitSubject, '源码提交说明', 500) }) };
        const accepted = await this.store.change(state => {
          const current = find(state.deployments.tasks, id, '任务');
          if (current.status !== 'preparing') return false;
          this.authorizeWorkspaceTask(current, this.ensureManaged(state.deployments, current.targetId));
          if (current.sourceIdentity && JSON.stringify(current.sourceIdentity) !== JSON.stringify(identity)) throw new HttpError(409, '原发布请求的源码身份已改变，停止发布');
          if (current.pendingSource && JSON.stringify(current.pendingSource) !== JSON.stringify(pendingSource)) throw new HttpError(409, '原发布请求的固定源码已改变，停止发布');
          Object.assign(current, { sourceIdentity: identity, pendingSource, revision: pendingSource.revision, commitSubject: pendingSource.commitSubject, updatedAt: now() });
          return true;
        });
        if (!accepted) return;
        task = find(this.data.tasks, id, '任务');
      }
      if (archive && !task.source?.archiveId) await this.archives.import(task, archive);
      // 已有档案只核对原版本；未完成选择按原请求恢复，不能退回当前仓库配置。
      const current = find(this.data.tasks, id, '任务');
      if (!current.source?.archiveId) throw new HttpError(410, '工作区固定源码档案尚未完成或已丢失，请重新创建发布任务');
      const source = await this.archives.verify(current.source);
      if (source.revision !== current.revision || source.sha256 !== current.source.sha256 || source.size !== current.source.size) throw new HttpError(409, '固定源码档案与任务版本不一致');
      await this.store.change(state => {
        const saved = find(state.deployments.tasks, id, '任务'); if (saved.status !== 'preparing') return;
        if (saved.sourceSelection) this.authorizeWorkspaceTask(saved, this.ensureManaged(state.deployments, saved.targetId));
        transition(saved, 'queued'); Object.assign(saved, { status: 'queued', stage: 'queued', sourceArchiveId: source.archiveId,
          source: { archiveId: source.archiveId, revision: source.revision, sha256: source.sha256, size: source.size, commitSubject: source.commitSubject, url: `/api/agent/v1/tasks/${id}/source` }, updatedAt: now() });
      });
    } catch (error) {
      await this.store.change(state => {
        const current = find(state.deployments.tasks, id, '任务'); if (current.status !== 'preparing') return;
        transition(current, 'failed', true); Object.assign(current, { status: 'failed', stage: 'failed', error: error instanceof HttpError || [400, 401, 403, 404, 409, 410, 413, 503].includes(error?.status) ? error.message : '固定工作区源码失败，请检查服务存储', finishedAt: now(), updatedAt: now() });
      });
    } finally {
      if (typeof cleanup === 'function') await Promise.resolve().then(cleanup).catch(() => this.emit('error-safe', { taskId: id, message: '固定源码临时文件清理延后' }));
      this.changed('task', id);
    }
  }
  async prepare(id, archive) {
    const task = find(this.data.tasks, id, '任务'); const sourceId = task.sourceProjectId;
    if (task.sourceKind === 'workspace-package') return this.prepareWorkspaceArchive(id, archive);
    const snapshot = task.sourceSnapshot || sourceSnapshot(find(this.store.state.projects, sourceId));
    try {
      let source;
      try {
        if (task.source?.archiveId) { await this.archives.verify(task.source); source = task.source; }
        else { source = JSON.parse(await readFile(path.join(this.root, 'tasks', id, 'source.json'), 'utf8')); await stat(path.join(this.root, 'tasks', id, 'source.zip')); }
      }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        source = await this.repository.captureArchive(sourceId, snapshot, archive => this.copyArchive(archive, id), async phase => {
          await this.store.change(state => {
            const current = find(state.deployments.tasks, id);
            if (current.status === 'preparing') { transition(current, phase); current.stage = phase; current.updatedAt = now(); }
          });
          this.changed('task', id);
        });
      }
      if (source.archiveId) await this.archives.verify(source);
      await this.store.change(state => {
        const current = find(state.deployments.tasks, id); if (current.status !== 'preparing') return;
        transition(current, 'queued'); current.stage = 'queued';
        Object.assign(current, { sourceArchiveId: source.archiveId, source: { ...source, url: `/api/agent/v1/tasks/${id}/source` }, revision: source.revision, commitSubject: typeof source.commitSubject === 'string' ? source.commitSubject.slice(0, 500) : undefined, status: 'queued', updatedAt: now() });
      });
    } catch (error) {
      await this.store.change(state => {
        const current = find(state.deployments.tasks, id); if (current.status !== 'preparing') return;
        transition(current, 'failed', true);
        Object.assign(current, { status: 'failed', stage: 'failed', error: error instanceof HttpError ? error.message : '固定源码失败，请检查服务存储', finishedAt: now(), updatedAt: now() });
      });
    } finally {
      if (snapshot.revision) await this.repository.releasePin(snapshot, id).catch(() => {});
      this.changed('task', id);
    }
  }
  async claim(serverId) {
    if (this.closing) return null
    let interruptedId
    const task = await this.store.change((state) => {
      if (this.closing) return null
      const data = state.deployments
      const server = find(data.servers, serverId)
      if (server.revoked) throw new HttpError(401, 'Agent 已撤销')
      if (server.mode !== 'managed') return null
      const active = data.tasks.find(
        (task) => task.serverId === serverId && task.status === 'running',
      )
      if (active) return structuredClone(active)
      if (server.deleting) return null
      // 准备源码也占据队列位置，防止后提交的重启越过前面的发布。
      const next = data.tasks.find(task => task.serverId === serverId && ['preparing', 'queued'].includes(task.status));
      if (!next || next.status !== 'queued') return null;
      const target = this.ensureManaged(data, next.targetId);
      if (this.authorizeTask) {
        try {
          // 同步裁决紧邻领取写入；不在事务里请求外部服务，也不保存浏览器会话。
          const decision = this.authorizeTask({ task: structuredClone(next), target: structuredClone(target) });
          if (decision?.then) {
            Promise.resolve(decision).catch(() => {});
            throw new Error('任务授权端口不支持异步返回');
          }
        } catch (error) {
          if (![401, 403, 404].includes(error?.status)) throw new HttpError(503, '任务授权暂时不可用，尚未执行');
          transition(next, 'interrupted', true);
          Object.assign(next, { status: 'interrupted', stage: 'interrupted', error: '发布操作人权限已失效，任务未执行', finishedAt: now(), updatedAt: now() });
          interruptedId = next.id;
          return null;
        }
      }
      if (next.networkIdentity && !server.capabilities?.includes('fixed-network-alias-v1')) {
        Object.assign(next, { status: 'interrupted', stage: 'interrupted', error: 'Agent 不支持固定网络别名，请升级后重新创建任务', finishedAt: now() }); transition(next, 'interrupted', true); interruptedId = next.id; return null;
      }
      if (next.config?.kind === 'static' && !server.capabilities?.includes('static-site-v1')) {
        transition(next, 'interrupted', true);
        Object.assign(next, { status: 'interrupted', stage: 'interrupted', finishedAt: now(), updatedAt: now(), error: '当前 Agent 不支持静态站点发布，请升级后重试' });
        interruptedId = next.id;
        return null;
      }
      if ((next.config?.envFiles?.length || target.currentRelease?.config?.envFiles?.length) && !server.capabilities?.includes('env-file-v1')) {
        transition(next, 'interrupted', true);
        Object.assign(next, { status: 'interrupted', stage: 'interrupted', finishedAt: now(), updatedAt: now(), error: 'Agent 不支持环境文件，请升级后重新创建任务' });
        interruptedId = next.id;
        return null;
      }
      Object.assign(next, { status: 'running', startedAt: now(), updatedAt: now(), previousRelease: target.currentRelease || null });
      if (next.recoveryAllowed && !server.capabilities?.includes('source-archive-recovery-v1')) {
        Object.assign(next, { status: 'interrupted', stage: 'interrupted', error: 'Agent 已降级，请升级后重新创建任务', finishedAt: now() }); transition(next, 'interrupted', true); interruptedId = next.id; return null;
      }
      const baselineSource = this.archives.releaseSource(target.currentRelease);
      if (baselineSource && next.recoveryAllowed) Object.assign(next, { baselineReleaseId: randomUUID(), baselineSource: { ...baselineSource, url: `/api/agent/v1/tasks/${next.id}/source?role=baseline` } });
      if (next.action !== 'deploy') { const release = next.release || target.currentRelease; next.revision = release?.revision || null; next.commitSubject = release?.commitSubject; }
      return structuredClone(next);
    });
    if (interruptedId) this.changed('task', interruptedId);
    if (task) this.changed('task', task.id); return task;
  }
  async waitForTask(serverId, milliseconds = 25000, signal) {
    let task = await this.claim(serverId); if (task || signal?.aborted || this.closing) return task;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.off('update', listener); this.off('shutdown', finish); signal?.removeEventListener('abort', finish); resolve(); };
      const listener = update => {
        if (update.type !== 'task') return;
        const changed = this.data.tasks.find(item => item.id === update.id);
        // 配置保存和源码准备尚不可领取，提前唤醒只会让 Agent 进入空轮询退避。
        if (changed?.serverId === serverId && (changed.status === 'queued' || terminal.has(changed.status))) finish();
      };
      const timer = setTimeout(finish, milliseconds); this.on('update', listener); this.once('shutdown', finish); signal?.addEventListener('abort', finish, { once: true });
      if (this.closing || signal?.aborted) finish();
    });
    return signal?.aborted ? null : this.claim(serverId);
  }
  ownedTask(serverId, taskId) {
    const task = find(this.data.tasks, taskId, '任务')
    if (task.serverId !== serverId || !task.startedAt) throw new HttpError(403, '无权访问此任务')
    this.ensureManaged(this.data, task.targetId, true)
    return task
  }
  source(serverId, taskId, role = 'selected') {
    const task = this.ownedTask(serverId, taskId);
    if (!['selected', 'baseline'].includes(role)) throw new HttpError(400, '源码用途无效');
    const source = role === 'baseline' ? task.baselineSource : task.source;
    if (!source) throw new HttpError(409, '任务没有源码包');
    if (source.archiveId) return this.archives.resolve(source);
    if (role === 'baseline') throw new HttpError(410, '恢复基线源码不可用');
    if (terminal.has(task.status) && !this.data.releases.some(release => release.id === taskId && release.available)) throw new HttpError(410, '已完成任务的源码包已清理');
    return { ...task.source, file: path.join(this.root, 'tasks', taskId, 'source.zip') };
  }
  async events(serverId, taskId, input) {
    this.ownedTask(serverId, taskId)
    const seq = integer(input.seq, undefined, 1, Number.MAX_SAFE_INTEGER, '日志序号')
    if (!stages.has(input.stage)) fail('任务阶段无效')
    if (
      input.message !== undefined &&
      (typeof input.message !== 'string' || input.message.length > 32768)
    )
      fail('日志内容过长')
    const status = input.status || (terminal.has(input.stage) ? input.stage : 'running')
    if (!['running', ...terminal].includes(status)) fail('任务状态无效')
    if (
      input.timestamp !== undefined &&
      (typeof input.timestamp !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
          input.timestamp,
        ) ||
        !Number.isFinite(Date.parse(input.timestamp)))
    )
      fail('事件 timestamp 必须是有效的 ISO 8601 时间')
    const result = input.result
    if (
      result !== undefined &&
      (!result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        JSON.stringify(result).length > 65536)
    )
      fail('任务结果格式错误')
    const ack = await this.store.change(async (state) => {
      const data = state.deployments
      const task = find(data.tasks, taskId)
      const target = this.ensureManaged(data, task.targetId, true)
      if (task.serverId !== serverId) throw new HttpError(403, '无权更新此任务')
      if (seq <= task.lastSeq) return task.lastSeq
      if (seq !== task.lastSeq + 1)
        throw new HttpError(409, `日志序号不连续，下一序号为 ${task.lastSeq + 1}`)
      if (terminal.has(task.status)) throw new HttpError(409, '任务已完成')
      const baseline =
        result?.baseline || (status === 'rolled_back' ? result?.rollback?.release : null)
      if (baseline?.id === task.baselineReleaseId && baseline) {
        const prior = task.previousRelease;
        const valid = task.recoveryAllowed && task.baselineSource && prior && baseline.restoredFromReleaseId === prior.id && baseline.revision === prior.revision
          && (prior.kind === 'static' ? baseline.artifact === `static/${target.id}/${baseline.id}` : baseline.image === `cmr/${target.id}:${baseline.id}`);
        if (!valid) fail('恢复基线与任务授权不一致');
        if (!data.releases.some(item => item.id === baseline.id)) data.releases.push({ ...structuredClone(prior), id: baseline.id, image: baseline.image, artifact: baseline.artifact,
          artifactId: baseline.id, internalBaseline: true, restoredFromReleaseId: prior.id, buildSnapshot: baseline.buildSnapshot || prior.buildSnapshot, createdAt: now(), available: true });
        task.recoveryBaselineId = baseline.id;
      }
      const release = result?.release;
      for (const value of [release, baseline].filter(Boolean)) if (value.buildSnapshot) {
        const snapshot = value.buildSnapshot;
        if (typeof snapshot !== 'object' || Array.isArray(snapshot) || Object.keys(snapshot).some(key => !['buildImage', 'runtimeImage', 'packageManager', 'packageManagerVersion', 'mavenVersion', 'nodeVersion'].includes(key))) fail('实际构建信息格式错误');
        for (const key of ['buildImage', 'runtimeImage']) if (snapshot[key] !== undefined && (!imagePattern.test(snapshot[key]) || !/(?:^|@)sha256:[a-f0-9]{64}$/.test(snapshot[key]))) fail('实际构建镜像必须固定到摘要');
        for (const key of ['packageManager', 'packageManagerVersion', 'mavenVersion', 'nodeVersion']) if (snapshot[key] !== undefined && (typeof snapshot[key] !== 'string' || snapshot[key].length > 200 || /[\x00-\x1f]/.test(snapshot[key]))) fail('实际构建工具版本无效');
      }
      if (release) {
        const ownedArtifactId = artifactId(release);
        const validArtifact = task.config.kind === 'static'
          ? release.kind === 'static' && release.artifact === `static/${target.id}/${ownedArtifactId}`
          : release.image === `cmr/${target.id}:${ownedArtifactId}`;
        if (typeof release.id !== 'string' || !/^[a-f0-9-]{36}$/.test(release.id) || !validArtifact) fail('发布版本不属于平台目标');
        if (task.action === 'deploy' && status === 'succeeded' && (release.id !== task.id || ownedArtifactId !== task.id || release.revision !== task.revision)) fail('发布版本与任务源码不一致');
        const rebuilt = task.action === 'rollback' && task.recoveryAllowed && task.sourceArchiveId && release.id === task.id && release.revision === task.release?.revision && release.restoredFromReleaseId === task.release?.id;
        const cached = task.action === 'rollback' && release.id === task.id && release.restoredFromReleaseId === task.release?.id && ownedArtifactId === artifactId(task.release)
          && release.image === task.release.image && release.artifact === task.release.artifact && release.recoveryMethod === 'cache';
        if (rebuilt && !cached && ownedArtifactId !== task.id) fail('重建产物标识与任务不一致');
        if (task.action !== 'deploy' && status === 'succeeded' && !rebuilt && !cached && !(task.action === 'restart' && release.id === task.release?.id && ownedArtifactId === artifactId(task.release))) fail('目标历史版本不存在');
        if (task.action === 'rollback' && status === 'succeeded' && release.revision !== task.release?.revision) fail('回退版本与历史源码不一致');
      }
      if (status === 'succeeded' && !release) fail('成功任务必须包含实际运行版本');
      const timing = agentEventTime(task, input.timestamp, now());
      const record = { seq, stage: input.stage, message: input.message || '', status, ...timing };
      const directory = path.join(this.root, 'tasks', taskId, 'logs'); await mkdir(directory, { recursive: true, mode: 0o700 });
      // 日志先持久化再提交确认序号；崩溃后的重发覆盖同一序号，不产生重复记录。
      await atomicWrite(path.join(directory, `${seq}.json`), JSON.stringify(record));
      transition(task, input.stage, terminal.has(status), timing.at);
      Object.assign(task, { lastSeq: seq, lastEventAt: timing.at, stage: input.stage, status, updatedAt: timing.receivedAt });
      if (terminal.has(status)) {
        task.finishedAt = timing.at; task.resultReceivedAt = timing.receivedAt; task.result = result || {}; if (status !== 'succeeded') task.error = input.message || '任务执行失败';
        if (release && status === 'succeeded') {
          const saved = { id: release.id, artifactId: artifactId(release), action: task.action, recoveryMethod: release.recoveryMethod, ...(task.config.kind === 'static' ? { kind: 'static', artifact: release.artifact } : { image: release.image }), revision: release.revision,
            commitSubject: task.commitSubject, config: structuredClone(task.config), targetId: target.id, applicationId: target.applicationId,
            sourceSnapshot: task.sourceSnapshot, sourceArchiveId: task.sourceArchiveId,
            ...(task.sourceKind === 'workspace-package' ? { sourceKind: task.sourceKind, sourceIdentity: structuredClone(task.sourceIdentity) } : {}),
            ...(task.sourceSelection ? { sourceSelection: structuredClone(task.sourceSelection) } : {}),
            ...(task.sourceRefs ? { sourceRefs: structuredClone(task.sourceRefs) } : {}),
            ...(task.actor ? { actor: structuredClone(task.actor) } : {}),
            buildSnapshot: release.buildSnapshot || task.release?.buildSnapshot,
            ...(release.id === task.id && task.action === 'rollback' ? { restoredFromReleaseId: task.release.id } : {}), createdAt: timing.at, available: true };
          if (!data.releases.some(existing => existing.id === saved.id && existing.targetId === target.id)) data.releases.push(saved);
          target.currentRelease = structuredClone(data.releases.find(existing => existing.id === saved.id && existing.targetId === target.id));
          if (task.action !== 'restart') {
            target.rollbackBaselineId = task.recoveryBaselineId || task.previousRelease?.id || null;
            target.lastDeployedAt = timing.at;
          }
        }
        const rollbackRelease = result?.rollback?.release;
        if (status === 'rolled_back' && rollbackRelease) {
          const saved = data.releases.find(existing => existing.id === rollbackRelease.id && existing.targetId === target.id);
          if (!saved || ![task.previousRelease?.id, task.recoveryBaselineId].includes(saved.id) || saved.image !== rollbackRelease.image || saved.artifact !== rollbackRelease.artifact) fail('回退版本不属于此目标'); target.currentRelease = structuredClone(saved);
        }
        for (const existing of data.releases.filter(existing => existing.targetId === target.id)) if (existing.sourceArchiveId && !existing.sourceClearedAt) existing.available = true;
      }
      return seq;
    });
    this.changed('task', taskId);
    if (terminal.has(status)) await this.cleanupSources().catch(() => {});
    return { ackSeq: ack };
  }
  cleanupSources() {
    // 档案队列结束后还有任务副本清理，关闭必须等待整个操作。
    const operation = this.#cleanupSources();
    this.sourceCleanups.add(operation);
    void operation.then(() => this.sourceCleanups.delete(operation), () => this.sourceCleanups.delete(operation));
    return operation;
  }
  workspacePackageReferences() {
    const references = [], retain = (value) => {
      const projectId = value.workspaceProjectId || value.sourceIdentity?.projectId;
      if (projectId) references.push({ projectId, requestId: value.requestId, packageId: value.sourceIdentity?.packageId, versionId: value.sourceIdentity?.sourceVersionId });
    };
    for (const task of this.data.tasks) {
      const finishedAt = Date.parse(task.finishedAt || task.createdAt);
      if (task.sourceKind === 'workspace-package' && (!terminal.has(task.status) || !Number.isFinite(finishedAt) || Date.now() - finishedAt < 7 * 86400000)) retain(task);
    }
    // 链上原包已经完整交付中心后，工作区副本不再是恢复依赖；缺失或损坏时保守保留。
    for (const release of this.data.releases) if (!release.sourceClearedAt && release.sourceKind === 'workspace-package' && this.archives.status(release) !== 'available') retain(release);
    return references;
  }
  async #cleanupSources() {
    await this.archives.cleanup();
    if (this.maintainWorkspacePackages) {
      try { await this.maintainWorkspacePackages(this.workspacePackageReferences()); }
      catch { this.emit('error-safe', { message: '工作区临时源码包清理延后' }); }
    }
    for (const task of this.data.tasks) if (terminal.has(task.status) && task.sourceArchiveId) {
      const directory = path.join(this.root, 'tasks', task.id);
      await rm(path.join(directory, 'source.zip'), { force: true }); await rm(path.join(directory, 'source.json'), { force: true });
    }
  }
  async taskDetails(id, after = 0) {
    const task = structuredClone(find(this.data.tasks, id, '任务')); after = integer(after, 0, 0, Number.MAX_SAFE_INTEGER, '日志起始序号');
    const logs = [];
    for (let seq = after + 1; seq <= Math.min(task.lastSeq, after + 500); seq++) logs.push(JSON.parse(await readFile(path.join(this.root, 'tasks', id, 'logs', `${seq}.json`), 'utf8')));
    return { task, logs, nextSeq: (logs.at(-1)?.seq ?? after) + 1 };
  }
  releases(targetId) { find(this.data.targets, targetId, '部署目标'); return this.data.releases.filter(release => release.targetId === targetId && !release.internalBaseline).slice().reverse().map(release => {
    const selection = release.sourceSelection || this.data.tasks.find(task => task.id === release.id)?.sourceSelection;
    return { ...release, ...(selection ? { sourceSelection: structuredClone(selection) } : {}), archiveStatus: this.archives.status(release), archiveProtected: this.archives.protected(this.data, release), current: release.id === find(this.data.targets, targetId).currentRelease?.id };
  }); }
  release(targetId, releaseId) {
    return structuredClone(find(this.releases(targetId), releaseId, '发布版本'));
  }
  async releaseSource(targetId, releaseId) {
    const release = this.release(targetId, releaseId);
    if (release.sourceClearedAt) throw new HttpError(410, '该版本源码已清理');
    return this.archives.verify(release);
  }
  async clearReleaseSource(targetId, releaseId, input) {
    const release = this.release(targetId, releaseId);
    const authorize = this.authorizeProjectMutation ? () => {
      const target = find(this.data.targets, targetId, '部署目标');
      const scope = this.projects.claimScope({ ...target, actor: input?.actor }, target);
      const decision = this.authorizeProjectMutation({ ...scope, action: 'source.clear', actor: input?.actor });
      if (decision?.then) { Promise.resolve(decision).catch(() => {}); throw new HttpError(503, '部署写入授权必须同步裁决'); }
    } : undefined;
    return this.archives.clear(release.id, release.applicationId, input, authorize);
  }
  releasePage(targetId, offset = 0, limit = 20) {
    offset = integer(offset, 0, 0, 1000000000, '分页起点'); limit = integer(limit, 20, 1, 100, '分页条数');
    const releases = this.releases(targetId); return { releases: releases.slice(offset, offset + limit), total: releases.length, offset, nextOffset: offset + limit < releases.length ? offset + limit : null };
  }
  beginClose() {
    // 初始化可能在首次拒新之后才创建计时器，重复关闭仍需释放它。
    clearInterval(this.archiveCleanupTimer);
    if (!this.closing) { this.closing = true; this.emit('shutdown'); }
  }
  async close() {
    this.beginClose();
    await Promise.allSettled([this.commitBackfill, ...this.preparations.values()]);
    await this.repository.waitForIdle();
    await Promise.allSettled([...this.sourceCleanups]);
    await this.archives.pending;
    this.removeAllListeners();
  }
}
