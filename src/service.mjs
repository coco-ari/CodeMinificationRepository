import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { ArchiveBuilder, validateBranch, validateRepository, sourceKey, archiveKey } from './archive.mjs';
import { HttpError, randomSecret, digest, equal, encrypt, decrypt, requireText, hashPassword, checkPassword } from './security.mjs';

const timestamp = () => new Date().toISOString();
function audit(state, projectId, action, message) {
  state.events.unshift({ id: randomUUID(), projectId, action, message, at: timestamp() });
  state.events = state.events.slice(0, 100);
}
function publicProject(project) {
  const { tokenHash, ...safe } = project;
  return safe;
}
function publicCredential(credential) {
  const { secret, ...safe } = credential;
  return safe;
}

class WorkQueue {
  constructor(limit, maxPending) { this.limit = limit; this.maxPending = maxPending; this.active = 0; this.waiters = []; }
  async run(work) {
    if (this.active >= this.limit) {
      if (this.waiters.length >= this.maxPending) throw new HttpError(503, '同步任务已满，请稍后重试');
      await new Promise(resolve => this.waiters.push(resolve));
    } else this.active++;
    try { return await work(); }
    finally {
      const next = this.waiters.shift();
      if (next) next(); else this.active--;
    }
  }
}

export class RepositoryService {
  constructor({ directory, builder, maxConcurrent = 2, maxPending = 20, ...archiveOptions }) {
    this.directory = directory;
    this.store = new Store(directory);
    this.builder = builder || new ArchiveBuilder(path.join(directory, 'cache'), archiveOptions);
    this.queue = new WorkQueue(maxConcurrent, maxPending);
    this.inFlight = new Map();
    this.phaseListeners = new Map();
  }
  async initialize() {
    await this.store.open();
    await this.builder.initialize();
    await this.store.change(state => {
      for (const project of state.projects) {
        if (['syncing', 'queued'].includes(project.status)) {
          project.status = 'failed';
          project.error = '服务重启中断了上次同步，下次下载会重新检查远端';
        }
      }
    });
    this.bootstrapPath = path.join(this.directory, 'bootstrap-token');
    if (!this.store.state.admin) {
      try { this.bootstrapToken = (await readFile(this.bootstrapPath, 'utf8')).trim(); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.bootstrapToken = randomSecret();
        await writeFile(this.bootstrapPath, this.bootstrapToken, { flag: 'wx', mode: 0o600 });
      }
    } else await rm(this.bootstrapPath, { force: true });
  }
  async setup(input) {
    if (this.store.state.admin) throw new HttpError(409, '管理员已初始化');
    if (!equal(input.bootstrapToken || '', this.bootstrapToken)) throw new HttpError(401, '初始化口令错误');
    const username = requireText(input.username, '管理员账号', 80);
    const password = this.validateAdminPassword(input.password);
    const passwordHash = await hashPassword(password);
    await this.store.change(state => {
      if (state.admin) throw new HttpError(409, '管理员已初始化');
      state.admin = { username, passwordHash };
      audit(state, null, 'setup', '已创建管理员');
    });
    this.bootstrapToken = null;
    await rm(this.bootstrapPath, { force: true });
  }
  validateAdminPassword(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new HttpError(400, '管理员密码长度应为 12～256 个字符');
    }
    return password;
  }
  async login(input) {
    const admin = this.store.state.admin;
    if (typeof input.password !== 'string' || input.password.length > 256 || !admin
        || !equal(input.username || '', admin.username) || !await checkPassword(input.password, admin.passwordHash)) {
      throw new HttpError(401, '账号或密码错误');
    }
    return admin.username;
  }
  async changePassword(input) {
    const admin = this.store.state.admin;
    if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 256
        || !await checkPassword(input.currentPassword, admin.passwordHash)) throw new HttpError(401, '原密码错误');
    const passwordHash = await hashPassword(this.validateAdminPassword(input.password));
    await this.store.change(state => { state.admin.passwordHash = passwordHash; });
  }
  overview() {
    return {
      projects: this.store.state.projects.map(publicProject),
      credentials: this.store.state.credentials.map(publicCredential),
      events: this.store.state.events,
    };
  }
  async saveCredential(input, id) {
    const name = requireText(input.name, '凭证名称', 80);
    const username = requireText(input.username, 'Gitee 用户名', 100);
    let secret;
    if (input.password) {
      requireText(input.password, 'Gitee 密码或访问令牌', 2048);
      secret = encrypt(input.password, this.store.key);
    }
    return this.store.change(state => {
      let credential;
      if (id) {
        credential = state.credentials.find(item => item.id === id);
        if (!credential) throw new HttpError(404, '凭证不存在');
      } else {
        if (!secret) throw new HttpError(400, '请填写 Gitee 密码或访问令牌');
        if (state.credentials.length >= 100) throw new HttpError(400, '凭证数量已达到上限');
        credential = { id: randomUUID(), createdAt: timestamp() };
        state.credentials.push(credential);
      }
      Object.assign(credential, { name, username, updatedAt: timestamp() });
      if (secret) credential.secret = secret;
      audit(state, null, 'credential', `已保存凭证：${name}`);
      return publicCredential(credential);
    });
  }
  async deleteCredential(id) {
    await this.store.change(state => {
      if (state.projects.some(project => project.credentialId === id) || state.deployments?.tasks.some(task => task.sourceSnapshot?.credentialId === id && ['preparing', 'queued', 'running'].includes(task.status))) throw new HttpError(409, '仍有仓库或未完成任务使用此凭证，请先修改配置或等待任务完成');
      state.credentials = state.credentials.filter(item => item.id !== id);
    });
  }
  async saveProject(input, id) {
    const name = requireText(input.name, '项目名称', 80);
    const repository = validateRepository(input.repository);
    const branch = validateBranch(input.branch);
    const token = id ? undefined : randomSecret();
    return this.store.change(state => {
      if (input.credentialId && !state.credentials.some(item => item.id === input.credentialId)) throw new HttpError(400, '请选择有效的 Gitee 凭证');
      let project;
      if (id) {
        project = state.projects.find(item => item.id === id);
        if (!project) throw new HttpError(404, '项目不存在');
        if ([...this.inFlight.keys()].some(key => key.startsWith(`${id}:`))) throw new HttpError(409, '该项目正在同步，请完成后再修改');
      } else {
        if (state.projects.length >= 100) throw new HttpError(400, '项目数量已达到上限');
        project = { id: randomUUID(), createdAt: timestamp(), tokenHash: digest(token), status: 'idle', lastSuccess: null };
        state.projects.push(project);
      }
      if (project.repository !== repository || project.branch !== branch) {
        project.status = 'idle'; project.lastSuccess = null; project.error = null;
      }
      if (input.applicationId !== undefined) {
        if (!state.deployments?.applications.some(item => item.id === input.applicationId)) throw new HttpError(400, '项目不存在');
        if (project.applicationId && project.applicationId !== input.applicationId) throw new HttpError(400, '不能更改仓库所属项目');
        project.applicationId = input.applicationId;
      }
      Object.assign(project, { name, repository, branch, credentialId: input.credentialId || null,
        enabled: input.enabled !== false, updatedAt: timestamp() });
      audit(state, project.id, 'project', `已保存项目：${name}`);
      return { project: publicProject(project), ...(token ? { token } : {}) };
    });
  }
  async rotateToken(id) {
    const token = randomSecret();
    await this.store.change(state => {
      const project = state.projects.find(item => item.id === id);
      if (!project) throw new HttpError(404, '项目不存在');
      project.tokenHash = digest(token); delete project.needsDownloadTokenReset;
      audit(state, id, 'token', `已重置下载密码：${project.name}`);
    });
    return { token };
  }
  async setEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw new HttpError(400, '启用状态无效');
    await this.store.change(state => {
      const project = state.projects.find(item => item.id === id);
      if (!project) throw new HttpError(404, '项目不存在');
      project.enabled = enabled;
      audit(state, id, 'enabled', `${enabled ? '启用' : '停用'}项目：${project.name}`);
    });
  }
  authorizeDownload(id, token) {
    const project = this.store.state.projects.find(item => item.id === id);
    if (!project || !project.enabled || !token || !equal(digest(token), project.tokenHash)) {
      throw new HttpError(401, '项目下载密码无效，或项目已停用');
    }
    return project;
  }
  credential(project) {
    const record = this.store.state.credentials.find(item => item.id === project.credentialId);
    return record ? { username: record.username, password: decrypt(record.secret, this.store.key) } : null;
  }
  async history(project, refresh = false) {
    if (!this.builder.history) return { commits: [], refreshedAt: null };
    return this.queue.run(() => this.builder.history(project, this.credential(project), refresh));
  }
  async sync(id, frozen, onPhase) {
    const project = this.store.state.projects.find(item => item.id === id);
    if (!project) throw new HttpError(404, '项目不存在');
    if (!project.enabled) throw new HttpError(409, '项目已停用');
    const snapshot = structuredClone(frozen || project);
    if (snapshot.id !== id) throw new HttpError(400, '源码快照不匹配');
    const key = archiveKey(snapshot);
    if (onPhase) {
      if (!this.phaseListeners.has(key)) this.phaseListeners.set(key, new Set());
      this.phaseListeners.get(key).add(onPhase);
    }
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    // 仅合并同仓库地址和分支的任务；每次新任务仍向远端检查最新提交。
    const task = this.performSync(snapshot);
    this.inFlight.set(key, task);
    try { return await task; }
    finally { if (this.inFlight.get(key) === task) { this.inFlight.delete(key); this.phaseListeners.delete(key); } }
  }
  async performSync(project) {
    const update = async fields => this.store.change(state => {
      const current = state.projects.find(item => item.id === project.id);
      if (current && !project.revision && sourceKey(current) === sourceKey(project)) Object.assign(current, fields);
    });
    try {
      await update({ status: 'queued', error: null, lastAttemptAt: timestamp() });
      return await this.queue.run(async () => {
        await update({ status: 'syncing' });
        const record = this.store.state.credentials.find(item => item.id === project.credentialId);
        const credential = record ? { username: record.username, password: decrypt(record.secret, this.store.key) } : null;
        const result = await this.builder.build(project, credential, async phase => {
          await Promise.all([...(this.phaseListeners.get(archiveKey(project)) || [])].map(listener => listener(phase)));
        });
        await this.store.change(state => {
          const current = state.projects.find(item => item.id === project.id);
          if (current && !project.revision && sourceKey(current) === sourceKey(project)) {
            current.status = 'ready'; current.error = null;
            current.lastSuccess = { revision: result.revision, sha256: result.sha256, size: result.size, at: timestamp(), cached: result.cached };
          }
          audit(state, project.id, 'sync', `${project.name} / ${project.branch}：${result.cached ? '已确认最新，复用源码包' : '新版本源码包已生成'}`);
        });
        return result;
      });
    } catch (error) {
      const safe = error instanceof HttpError ? error : new HttpError(500, '同步失败，请检查凭证数据和服务存储');
      await this.store.change(state => {
        const current = state.projects.find(item => item.id === project.id);
        if (current && !project.revision && sourceKey(current) === sourceKey(project)) { current.status = 'failed'; current.error = safe.message; }
        audit(state, project.id, 'failure', `${project.name}：${safe.message}`);
      });
      throw safe;
    }
  }
  async recordDownload(id) {
    await this.store.change(state => {
      const project = state.projects.find(item => item.id === id);
      if (project) { project.lastDownloadAt = timestamp(); project.downloads = (project.downloads || 0) + 1; }
    });
  }
}
