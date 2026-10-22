import { createReadStream, lstatSync } from 'node:fs';
import { mkdir, copyFile, rename, rm, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { HttpError } from './security.mjs';

const terminal = new Set(['succeeded', 'failed', 'rolled_back', 'interrupted']);
const stamp = () => new Date().toISOString();
export async function checksum(file) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; hash.update(chunk); }
  return { sha256: hash.digest('hex'), size };
}

export class SourceArchives {
  constructor(deployment) { this.deployment = deployment; this.store = deployment.store; this.root = path.join(deployment.root, 'archives'); this.pending = Promise.resolve(); }
  serial(work) { const next = this.pending.then(work); this.pending = next.catch(() => {}); return next; }
  file(record) {
    if (!/^[a-f0-9-]{36}$/.test(record.applicationId) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new HttpError(500, '源码档案路径无效');
    return path.join(this.root, record.applicationId, `${record.sha256}.zip`);
  }
  record(id) { return this.store.state.deployments.sourceArchives.find(item => item.id === id && !item.deletedAt); }
  present(record) {
    if (!record || record.integrity === 'invalid') return false;
    try { const info = lstatSync(this.file(record)); return info.isFile() && !info.isSymbolicLink() && info.size === record.size; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  resolve(source) {
    const record = this.record(source?.archiveId || source?.sourceArchiveId);
    if (!this.present(record)) throw new HttpError(410, '中心源码档案缺失、损坏或已清理，不能重新构建');
    return { ...source, archiveId: record.id, sha256: record.sha256, size: record.size, file: this.file(record) };
  }
  async verify(source) {
    const archive = this.resolve(source), actual = await checksum(archive.file);
    if (actual.sha256 !== archive.sha256 || actual.size !== archive.size) {
      await this.store.change(state => { const record = state.deployments.sourceArchives.find(item => item.id === archive.archiveId); if (record) record.integrity = 'invalid'; });
      throw new HttpError(409, '中心源码档案校验失败，停止下载和重建');
    }
    return archive;
  }
  async import(task, archive) {
    return this.serial(async () => {
      const actual = await checksum(archive.file);
      if (actual.sha256 !== archive.sha256 || actual.size !== archive.size) throw new HttpError(409, '源码包校验失败，未登记版本档案');
      const existing = this.store.state.deployments.sourceArchives.find(item => item.applicationId === task.applicationId && item.sha256 === actual.sha256);
      const record = { ...(existing || { id: randomUUID(), applicationId: task.applicationId, createdAt: stamp() }), ...actual, deletedAt: null, integrity: 'verified' };
      record.origins ||= [];
      const origin = task.sourceKind === 'workspace-package'
        ? { sourceKind: task.sourceKind, sourceIdentity: structuredClone(task.sourceIdentity), revision: archive.revision }
        : { repositoryId: task.sourceProjectId, repository: task.sourceSnapshot?.repository, revision: archive.revision };
      const knownOrigin = task.sourceKind === 'workspace-package'
        ? record.origins.some(item => JSON.stringify(item) === JSON.stringify(origin))
        : record.origins.some(item => item.repositoryId === task.sourceProjectId && item.revision === archive.revision);
      if (!knownOrigin) record.origins = [...record.origins, origin];
      const destination = this.file(record); await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      let valid = false;
      try { const saved = await checksum(destination); valid = saved.sha256 === actual.sha256 && saved.size === actual.size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!valid) {
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
          await copyFile(archive.file, temporary);
          const copied = await checksum(temporary); if (copied.sha256 !== actual.sha256 || copied.size !== actual.size) throw new HttpError(409, '源码归档复制校验失败');
          const handle = await open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
          await rename(temporary, destination);
          if (process.platform !== 'win32') { const parent = await open(path.dirname(destination), 'r'); try { await parent.sync(); } finally { await parent.close(); } }
        } catch (error) { if (error.code === 'ENOSPC') throw new HttpError(507, '中心磁盘空间不足，已停止归档；不会自动删除成功版本'); throw error; }
        finally { await rm(temporary, { force: true }); }
      }
      await this.store.change(state => {
        const data = state.deployments, saved = data.sourceArchives.find(item => item.id === record.id);
        if (saved) Object.assign(saved, record); else data.sourceArchives.push(record);
        const current = data.tasks.find(item => item.id === task.id);
        if (current) { current.sourceArchiveId = record.id; current.source = { ...(current.source || {}), archiveId: record.id, revision: archive.revision, commitSubject: archive.commitSubject, ...actual }; }
      });
      return { archiveId: record.id, revision: archive.revision, commitSubject: archive.commitSubject, ...actual };
    });
  }
  async migrate() {
    await this.store.change(state => { state.deployments.sourceArchives ||= []; });
    const report = { at: stamp(), imported: 0, missing: 0, invalid: 0 };
    for (const record of this.store.state.deployments.sourceArchives.filter(item => !item.deletedAt)) {
      try { await this.verify({ archiveId: record.id }); }
      catch (error) { if (error.code === 'ENOENT' || error.status === 410) report.missing++; else if (error instanceof HttpError) report.invalid++; else throw error; }
    }
    for (const task of this.store.state.deployments.tasks) {
      if (!task.applicationId || task.sourceArchiveId || !task.source) continue;
      try {
        const file = path.join(this.deployment.root, 'tasks', task.id, 'source.zip');
        const archive = { ...task.source, file };
        const imported = await this.import(task, archive);
        await this.store.change(state => { const current = state.deployments.tasks.find(item => item.id === task.id); if (current) current.source = { ...current.source, ...imported }; });
        report.imported++;
      } catch (error) { if (error.code === 'ENOENT') report.missing++; else if (error instanceof HttpError) report.invalid++; else throw error; }
    }
    await this.store.change(state => {
      const data = state.deployments;
      for (const release of data.releases) {
        const task = data.tasks.find(item => item.id === release.id);
        release.applicationId ||= data.targets.find(item => item.id === release.targetId)?.applicationId;
        if (task?.source?.revision && (!release.revision || release.revision === task.source.revision)) {
          release.revision ||= task.source.revision;
          release.sourceSnapshot ||= task.sourceSnapshot ? structuredClone(task.sourceSnapshot) : undefined;
          if (task.sourceKind === 'workspace-package') {
            release.sourceKind ||= task.sourceKind;
            release.sourceIdentity ||= structuredClone(task.sourceIdentity);
          }
          if (task.actor) release.actor ||= structuredClone(task.actor);
          release.config ||= task.config ? structuredClone(task.config) : undefined;
          release.commitSubject ||= task.commitSubject || task.source.commitSubject;
          if (!release.sourceClearedAt && task.sourceArchiveId) release.sourceArchiveId ||= task.sourceArchiveId;
        }
        if (!release.sourceClearedAt && this.status(release) === 'available') release.available = true;
      }
      for (const target of data.targets) if (target.currentRelease) {
        const release = data.releases.find(item => item.id === target.currentRelease.id && item.targetId === target.id);
        if (release) target.currentRelease = structuredClone(release);
      }
      data.sourceArchiveMigration = { ...(data.sourceArchiveMigration || {}), ...report, version: 1 };
    });
  }
  status(release) {
    if (release.sourceClearedAt) return 'cleared';
    const record = this.record(release.sourceArchiveId);
    if (record?.integrity === 'invalid') return 'invalid';
    return this.present(record) ? 'available' : 'missing';
  }
  releaseSource(release) {
    if (!release || this.status(release) !== 'available') return null;
    const archive = this.resolve(release);
    return { archiveId: archive.archiveId, revision: release.revision, commitSubject: release.commitSubject, sha256: archive.sha256, size: archive.size };
  }
  protected(data, release) {
    return data.targets.some(target => target.currentRelease?.id === release.id || target.rollbackBaselineId === release.id)
      || data.tasks.some(task => !terminal.has(task.status) && [task.release?.id, task.previousRelease?.id].includes(release.id));
  }
  async clear(releaseId, applicationId) {
    return this.serial(async () => {
      let discarded;
      await this.store.change(state => {
        const data = state.deployments, release = data.releases.find(item => item.id === releaseId && item.applicationId === applicationId);
        if (!release) throw new HttpError(404, '版本不存在');
        if (this.protected(data, release)) throw new HttpError(409, '当前版本、恢复基线或执行中任务引用的版本不能清理');
        const archiveId = release.sourceArchiveId;
        if (data.tasks.some(task => !terminal.has(task.status) && [task.sourceArchiveId, task.baselineSource?.archiveId].includes(archiveId))) throw new HttpError(409, '执行中任务正在使用此源码档案');
        release.sourceClearedAt = stamp(); release.available = false;
        const references = data.releases.some(item => item.sourceArchiveId === archiveId && !item.sourceClearedAt);
        const recentFailure = data.tasks.some(task => task.sourceArchiveId === archiveId && !data.releases.some(item => item.id === task.id) && (!terminal.has(task.status) || Date.now() - Date.parse(task.finishedAt || task.createdAt) < 7 * 86400000));
        if (!references && !recentFailure) {
          const record = data.sourceArchives.find(item => item.id === archiveId);
          if (record && !record.deletedAt) { record.deletedAt = stamp(); discarded = { ...record }; }
        }
        state.events.unshift({ id: randomUUID(), projectId: release.sourceSnapshot?.id || null, applicationId, action: 'archive-clear', message: `已清理版本源码档案：${releaseId}`, at: stamp() });
      });
      if (discarded) await rm(this.file(discarded), { force: true });
      this.deployment.changed('releases', releaseId, applicationId);
      return { ok: true };
    });
  }
  async cleanup() {
    return this.serial(async () => {
      const discarded = [];
      await this.store.change(state => {
        const data = state.deployments, keep = new Set(data.releases.filter(item => !item.sourceClearedAt).map(item => item.sourceArchiveId));
        for (const task of data.tasks) if (!terminal.has(task.status) || Date.now() - Date.parse(task.finishedAt || task.createdAt) < 7 * 86400000) {
          keep.add(task.sourceArchiveId); keep.add(task.baselineSource?.archiveId);
        }
        for (const record of data.sourceArchives) if (!record.deletedAt && !keep.has(record.id) && Date.now() - Date.parse(record.createdAt) >= 7 * 86400000) { record.deletedAt = stamp(); discarded.push({ ...record }); }
      });
      for (const record of discarded) await rm(this.file(record), { force: true });
    });
  }
}
