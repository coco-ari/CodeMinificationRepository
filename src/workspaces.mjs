import { randomUUID } from 'node:crypto';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, randomSecret, digest } from './security.mjs';
import { validateBranch, sourceKey } from './archive.mjs';

const now = () => new Date().toISOString();
const terminal = task => ['succeeded', 'failed', 'rolled_back', 'interrupted'].includes(task.status);
const required = (items, id, label) => {
  const item = items.find(item => item.id === id);
  if (!item) throw new HttpError(404, `${label}不存在`);
  return item;
};
const safeRepository = ({ tokenHash, ...item }) => item;
export function historyWorkspace(state) {
  let item = state.deployments.applications.find(item => item.legacySources);
  if (!item) {
    item = { id: randomUUID(), name: '历史源码', description: '保留旧下载入口和待整理的源码配置', legacySources: true, createdAt: now() };
    state.deployments.applications.push(item);
  }
  return item;
}

// 在开始接收 HTTP / Agent 请求之前执行；事务与版本标记保证可重复启动。
export async function migrateWorkspaces(store, directory) {
  if (store.state.deployments.workspaceVersion === 1) {
    if (store.state.deployments.version !== 2 || !Array.isArray(store.state.deployments.serverBindings) || !Array.isArray(store.state.deployments.environmentSources)) throw new Error('项目工作空间数据损坏');
    return;
  }
  if (store.state.deployments.version !== 1 || store.state.deployments.workspaceVersion !== undefined) throw new Error('不支持的项目工作空间版本');
  const hasData = store.state.projects.length || store.state.deployments.applications.length || store.state.deployments.servers.length;
  let backup;
  if (hasData) {
    backup = path.join(directory, `workspace-backup-${Date.now()}-${randomUUID()}`);
    await mkdir(backup, { mode: 0o700 });
    await copyFile(store.databaseFile, path.join(backup, 'state.sqlite'));
    await copyFile(path.join(directory, 'master.key'), path.join(backup, 'master.key'));
  }
  await store.change(state => {
    const data = state.deployments;
    if (data.workspaceVersion === 1) return;
    data.serverBindings = []; data.environmentSources = [];
    const mapping = new Map(); let copied = 0;
    for (const source of [...state.projects]) {
      const owners = [...new Set(data.environments.filter(env => env.sourceProjectId === source.id).map(env => env.applicationId))];
      for (const id of owners) required(data.applications, id, '旧环境所属项目');
      if (owners.length === 1) source.applicationId = owners[0];
      else source.applicationId = historyWorkspace(state).id;
      for (const applicationId of owners) {
        let selected = source;
        if (owners.length > 1) {
          selected = { ...structuredClone(source), id: randomUUID(), applicationId, tokenHash: digest(randomSecret()),
            status: 'idle', lastSuccess: null, error: null, downloads: 0, lastDownloadAt: null, needsDownloadTokenReset: true, createdAt: now() };
          state.projects.push(selected); copied++;
        }
        mapping.set(`${applicationId}:${source.id}`, selected.id);
      }
    }
    for (const env of data.environments) {
      if (!env.sourceProjectId) continue;
      const sourceId = mapping.get(`${env.applicationId}:${env.sourceProjectId}`);
      const source = required(state.projects, sourceId, '旧环境源码');
      for (const service of data.services.filter(service => service.applicationId === env.applicationId)) {
        data.environmentSources.push({ applicationId: env.applicationId, environmentId: env.id, serviceId: service.id,
          sourceProjectId: source.id, branch: source.branch, updatedAt: now() });
      }
      // 兼容字段同步到本项目副本；旧任务仍保留自己的原源码 ID。
      env.sourceProjectId = source.id;
    }
    for (const target of data.targets) {
      if (!data.serverBindings.some(item => item.applicationId === target.applicationId && item.serverId === target.serverId)) {
        data.serverBindings.push({ applicationId: target.applicationId, serverId: target.serverId, createdAt: now() });
      }
    }
    // 已有未完成任务固定到升级时的旧配置，不重新选择已迁移的新仓库。
    for (const task of data.tasks) {
      if (!terminal(task) && !task.sourceSnapshot) {
        const source = required(state.projects, task.sourceProjectId, '旧任务源码');
        task.sourceSnapshot = sourceSnapshot(source, source.branch);
      }
    }
    data.version = 2; data.workspaceVersion = 1;
    data.workspaceMigration = { at: now(), repositories: state.projects.length, copiedRepositories: copied,
      bindings: data.serverBindings.length, backup: backup ? path.basename(backup) : null };
  });
}
export function sourceSnapshot(source, branch = source.branch) {
  return { id: source.id, name: source.name, applicationId: source.applicationId, repository: source.repository, branch, credentialId: source.credentialId };
}

export class WorkspaceService {
  constructor(repository, deployment) { this.repository = repository; this.deployment = deployment; this.store = repository.store; }
  get data() { return this.store.state.deployments; }
  project(id) { return required(this.data.applications, id, '项目'); }
  owned(kind, id, applicationId) {
    this.project(applicationId);
    const item = required(kind === 'repositories' ? this.store.state.projects : this.data[kind], id, '记录');
    if (item.applicationId !== applicationId) throw new HttpError(404, '当前项目中不存在此记录');
    return item;
  }
  list() {
    return this.data.applications.map(project => {
      const targets = this.deployment.overview().targets.filter(item => item.applicationId === project.id);
      const tasks = this.data.tasks.filter(item => item.applicationId === project.id);
      const latestTasks = new Map();
      for (const task of tasks) if (task.action !== 'build-check') latestTasks.set(task.targetId, task);
      const overview = this.overview(project.id);
      const dashboard = {
        environments: overview.environments, services: overview.services, environmentSources: overview.environmentSources,
        repositories: overview.repositories.map(({ id, name, branch, enabled }) => ({ id, name, branch, enabled })),
        servers: overview.servers.map(({ id, name, online, revoked, metrics, version, mode, lastSeenAt }) => ({ id, name, online, revoked, metrics, version, mode, lastSeenAt })),
        targets: targets.map(({ id, serviceId, environmentId, serverId, mode, observation, currentRelease, lastDeployedAt, lastObservedAt }) => {
          const latestTask = latestTasks.get(id);
          return { id, serviceId, environmentId, serverId, mode, observation, lastDeployedAt, lastObservedAt,
            latestTask: latestTask ? { id: latestTask.id, status: latestTask.status, createdAt: latestTask.createdAt, finishedAt: latestTask.finishedAt } : null,
            currentRelease: currentRelease ? { id: currentRelease.id, revision: currentRelease.revision, commitSubject: currentRelease.commitSubject, createdAt: currentRelease.createdAt,
              sourceSnapshot: currentRelease.sourceSnapshot ? { id: currentRelease.sourceSnapshot.id, name: currentRelease.sourceSnapshot.name, branch: currentRelease.sourceSnapshot.branch } : null } : null };
        }),
        tasks: tasks.filter(task => !terminal(task)).map(({ id, targetId, status, stage, createdAt, startedAt }) => ({ id, targetId, status, stage, createdAt, startedAt })),
      };
      return { ...project, dashboard, repositories: this.store.state.projects.filter(item => item.applicationId === project.id).length,
        servers: this.data.serverBindings.filter(item => item.applicationId === project.id).length, targets: targets.length,
        runningTargets: targets.filter(item => ['running', 'published'].includes(item.observation?.state || item.observation?.status)).length,
        activeTasks: tasks.filter(task => !terminal(task)).length, latestTask: tasks.at(-1) || null };
    });
  }
  overview(applicationId) {
    const project = this.project(applicationId), all = this.deployment.overview();
    const scoped = items => items.filter(item => item.applicationId === applicationId);
    const bound = new Set(scoped(this.data.serverBindings).map(item => item.serverId));
    const targets = scoped(all.targets), targetIds = new Set(targets.map(item => item.id));
    const taskIds = new Set(scoped(this.data.tasks).map(item => item.id));
    return { project, repositories: scoped(this.store.state.projects).map(safeRepository),
      servers: all.servers.filter(item => bound.has(item.id)).map(item => ({ ...item,
        activeTaskId: taskIds.has(item.activeTaskId) ? item.activeTaskId : null,
        containers: item.containers.filter(container => targetIds.has(container.targetId)) })),
      applications: [project], environments: scoped(this.data.environments), services: scoped(this.data.services), targets,
      environmentSources: scoped(this.data.environmentSources), tasks: scoped(this.data.tasks).slice(-200).reverse() };
  }
  async targetSource(applicationId, targetId, refresh = false, branch) {
    const target = this.owned('targets', targetId, applicationId);
    const environment = this.owned('environments', target.environmentId, applicationId);
    const selected = this.data.environmentSources.find(item => item.environmentId === target.environmentId && item.serviceId === target.serviceId);
    const repository = this.owned('repositories', selected?.sourceProjectId || environment.sourceProjectId, applicationId);
    if (!repository.enabled) throw new HttpError(409, '代码仓库已停用');
    const running = target.currentRelease?.sourceSnapshot;
    const preferredBranch = running?.id === repository.id && running.repository === repository.repository ? running.branch : selected?.branch || repository.defaultBranch || repository.branch || null;
    const chosen = branch === undefined ? preferredBranch : validateBranch(branch);
    if (!chosen) return { commits: [], refreshedAt: null, repositoryId: repository.id, repositoryName: repository.name, branch: null, preferredBranch, configKey: this.deployment.configKey(targetId) };
    const snapshot = sourceSnapshot(repository, chosen);
    const history = await this.repository.history(snapshot, refresh);
    return { ...history, sourceKey: sourceKey(snapshot), repositoryId: repository.id, repositoryName: repository.name, branch: snapshot.branch, preferredBranch, configKey: this.deployment.configKey(targetId) };
  }
  async create(input) { return this.deployment.saveEntity('applications', input, undefined, { defaultEnvironments: true }); }
  async bind(applicationId, serverId, remove = false) {
    this.project(applicationId);
    await this.store.change(state => {
      const data = state.deployments, server = required(data.servers, serverId, '服务器');
      if (remove) {
        if (data.targets.some(item => item.applicationId === applicationId && item.serverId === serverId)) throw new HttpError(409, '该服务器仍有本项目部署目标，不能解除绑定');
        data.serverBindings = data.serverBindings.filter(item => item.applicationId !== applicationId || item.serverId !== serverId);
      } else {
        if (server.revoked) throw new HttpError(409, '服务器已撤销');
        if (!data.serverBindings.some(item => item.applicationId === applicationId && item.serverId === serverId)) data.serverBindings.push({ applicationId, serverId, createdAt: now() });
      }
    });
    this.deployment.changed('binding', serverId, applicationId);
  }
  async saveSource(applicationId, input) {
    const environment = this.owned('environments', input.environmentId, applicationId);
    this.owned('services', input.serviceId, applicationId);
    this.owned('repositories', input.sourceProjectId, applicationId);
    const value = { applicationId, environmentId: environment.id, serviceId: input.serviceId, sourceProjectId: input.sourceProjectId, ...(input.branch ? { branch: validateBranch(input.branch) } : {}), updatedAt: now() };
    await this.store.change(state => {
      const items = state.deployments.environmentSources;
      const previous = items.find(item => item.environmentId === value.environmentId && item.serviceId === value.serviceId);
      if (previous) { if (previous.sourceProjectId !== value.sourceProjectId) delete previous.branch; Object.assign(previous, value); } else items.push(value);
    });
    this.deployment.changed('environmentSources', environment.id, applicationId); return value;
  }
  async saveEntity(applicationId, kind, input, id) {
    this.project(applicationId);
    if (id) this.owned(kind, id, applicationId);
    if (kind === 'targets') {
      this.owned('environments', input.environmentId, applicationId); this.owned('services', input.serviceId, applicationId);
      if (!this.data.serverBindings.some(item => item.applicationId === applicationId && item.serverId === input.serverId)) throw new HttpError(400, '请先绑定此服务器');
      if (!this.data.environmentSources.some(item => item.environmentId === input.environmentId && item.serviceId === input.serviceId)) throw new HttpError(400, '请先为该环境的服务关联源码仓库');
    }
    const result = await this.deployment.saveEntity(kind, { ...input, applicationId, ...(kind === 'environments' ? { sourceProjectId: undefined } : {}) }, id);
    return result;
  }
  async deleteEnvironment(applicationId, id) {
    await this.store.change(state => {
      const data = state.deployments;
      const environment = required(data.environments, id, '环境');
      if (environment.applicationId !== applicationId) throw new HttpError(404, '当前项目中不存在此环境');
      if (data.targets.some(item => item.environmentId === id)) throw new HttpError(409, '环境仍有部署位置，不能删除');
      if (data.tasks.some(item => item.environmentId === id) || data.releases.some(item => item.environmentId === id)) throw new HttpError(409, '环境仍有发布历史，不能删除');
      data.environments = data.environments.filter(item => item.id !== id);
      data.environmentSources = data.environmentSources.filter(item => item.environmentId !== id);
      state.events.unshift({ id: randomUUID(), applicationId, action: 'environment_delete', message: `已删除环境：${environment.name}`, at: now() });
      state.events = state.events.slice(0, 100);
    });
    this.deployment.changed('environments', id, applicationId);
  }
  eventBelongs(value, applicationId) {
    if (value.applicationId) return value.applicationId === applicationId;
    if (['server', 'heartbeat'].includes(value.type)) return this.data.serverBindings.some(item => item.serverId === value.id && item.applicationId === applicationId);
    const kind = value.type === 'task' ? 'tasks' : value.type;
    return Array.isArray(this.data[kind]) && this.data[kind].some(item => item.id === value.id && (item.applicationId || item.id) === applicationId);
  }
}
