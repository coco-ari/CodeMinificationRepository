import { mkdir, readFile, writeFile, copyFile, lstat, readdir, readlink, symlink, rename, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertManaged, identifier, normalizeConfig, safeChild } from './config.mjs';
import { readJson, writeJson } from './state.mjs';
import { extractZip } from './archive.mjs';
import { copyStaticSite } from './static-site.mjs';

const terminal = status => ['succeeded', 'failed', 'rolled_back', 'interrupted'].includes(status);
const directory = path.dirname(fileURLToPath(import.meta.url));

export async function checkStaticResponse(release, { fetchFn = fetch, timeoutMs = 5000 } = {}) {
  const config = normalizeConfig(release.config), base = new URL(config.health.url);
  async function get(url, limit) {
    const response = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'cache-control': 'no-cache' } });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error('站点尚未返回 HTTP 200'); }
    let bytes = 0, body = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body || []) {
      if ((bytes += chunk.length) > limit) throw new Error('站点检查响应过大');
      body += decoder.decode(chunk, { stream: true });
    }
    return body + decoder.decode();
  }
  const marker = new URL('__cmr_release.txt', base); marker.searchParams.set('version', release.id);
  if ((await get(marker, 256)).trim() !== release.id) throw new Error('Nginx 尚未提供本次发布版本，请检查目录挂载、站点路径和缓存');
  base.searchParams.set('cmr_check', release.id);
  const page = await get(base, 1024 * 1024);
  if (config.health.bodyIncludes && !page.includes(config.health.bodyIncludes)) throw new Error('站点响应未包含期望内容');
}

export class StaticDeployment {
  constructor(executor) { this.owner = executor; this.root = `${executor.root}-static`; }
  event(task, stage, message, extra) { return this.owner.event(task, stage, String(message).slice(0, 3000), extra); }
  target(task) { return safeChild(this.root, identifier(task.targetId)); }
  releasePath(task, id) { return safeChild(this.target(task), 'releases', identifier(id)); }
  async preflight(task) {
    assertManaged(this.owner.getIdentity(), task);
    const rootInfo = await lstat(this.root).catch(() => null);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || await readFile(path.join(this.root, '.cmr-static-root'), 'utf8').catch(() => '') !== this.root) throw new Error('缺少前端产物目录挂载，请按前端部署文档升级 Agent 并接入共用 Nginx');
    const target = this.target(task), ownerFile = path.join(target, '.cmr-owner.json');
    const expected = { serverId: this.owner.getIdentity().serverId, targetId: task.targetId };
    try { await mkdir(target, { mode: 0o755 }); await writeJson(ownerFile, expected); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(target), actual = await readJson(ownerFile);
    if (info.isSymbolicLink() || !info.isDirectory() || actual?.serverId !== expected.serverId || actual?.targetId !== expected.targetId) throw new Error('静态目录归属不匹配，拒绝覆盖');
    await chmod(target, 0o755);
    await mkdir(path.join(target, 'releases'), { mode: 0o755, recursive: true });
    if ((await lstat(path.join(target, 'releases'))).isSymbolicLink()) throw new Error('静态版本目录不能是符号链接');
    await chmod(path.join(target, 'releases'), 0o755);
  }
  async selected(task) {
    try {
      const link = await readlink(path.join(this.target(task), 'current'));
      if (!/^releases\/[a-z0-9][a-z0-9-]{0,63}$/.test(link)) throw new Error('当前站点指针不属于平台版本');
      return link.slice('releases/'.length);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async requireRelease(task, release) {
    if (release?.kind !== 'static' || release.artifact !== `static/${task.targetId}/${release.id}`) throw new Error('静态版本不属于当前部署目标');
    normalizeConfig(release.config);
    const root = this.releasePath(task, release.id), info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readFile(path.join(root, '__cmr_release.txt'), 'utf8')).trim() !== release.id) throw new Error('静态版本文件缺失或不匹配');
    return release;
  }
  async build(task, config) {
    const work = this.owner.taskRoot(task); await mkdir(work, { recursive: true, mode: 0o700 });
    const zip = path.join(work, 'source.zip'), source = path.join(work, 'source');
    await this.event(task, 'downloading', '正在下载固定提交的前端源码');
    await this.owner.client.download(task, zip); await extractZip(zip, source); await this.owner.makeSourceWritable(source);
    const project = config.module ? safeChild(source, ...config.module.split('/')) : source;
    await lstat(path.join(project, 'package.json'));
    const cache = safeChild(this.owner.root, 'cache', identifier(task.applicationId || task.targetId), 'node');
    const tools = path.join(work, 'static-tools');
    await this.owner.mountDirectory(cache); await this.owner.mountDirectory(tools);
    await copyFile(path.join(directory, 'static-build.mjs'), path.join(tools, 'static-build.mjs'));
    await this.event(task, 'building', `正在安装锁定依赖并执行 ${config.packageManager} run ${config.buildScript}`);
    await this.owner.builder(task, config, 'node', [[source, '/workspace'], [cache, '/cache'], [tools, '/cmr', true]], ['node', '/cmr/static-build.mjs', config.packageManager, config.packageManagerVersion, config.buildScript, ...config.buildArgs]);
    const output = this.releasePath(task, task.id);
    try { await lstat(output); throw new Error('本次版本目录已存在，拒绝覆盖'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const copied = await copyStaticSite(source, config.artifactPath, output);
    await writeFile(path.join(output, '__cmr_release.txt'), task.id, { mode: 0o644 });
    await chmod(path.join(output, '__cmr_release.txt'), 0o644);
    await this.event(task, 'building', `静态产物已固定：${copied.files} 个文件，共 ${copied.bytes} 字节`);
    return { id: task.id, kind: 'static', artifact: `static/${task.targetId}/${task.id}`, revision: task.source.revision, config, createdAt: new Date().toISOString() };
  }
  async activate(task, release) {
    await this.preflight(task); await this.requireRelease(task, release); await this.selected(task);
    const temp = path.join(this.target(task), `next-${task.id}`);
    await rm(temp, { force: true });
    await symlink(`releases/${release.id}`, temp);
    await rename(temp, path.join(this.target(task), 'current'));
  }
  async health(task, release) {
    await this.requireRelease(task, release);
    const config = normalizeConfig(release.config), deadline = Date.now() + config.health.timeoutSeconds * 1000;
    let failure;
    do {
      if (await this.selected(task) !== release.id) throw new Error('当前静态版本与发布任务不一致');
      try { await checkStaticResponse(release); return; } catch (error) { failure = error; }
      await this.owner.sleep(config.health.intervalSeconds * 1000);
    } while (Date.now() < deadline);
    throw new Error(`静态站点验证失败：${failure?.message || '访问超时'}`);
  }
  async finish(task, release, previous) {
    await this.owner.saveRelease(task, release, previous);
    // 清理只处理本目标的版本；不操作共用 Nginx、其他站点或中间件。
    try { await this.cleanup(task, release, previous); } catch (error) { await this.event(task, 'verifying', `静态站点已更新，历史清理延后：${error.message}`); }
    await this.event(task, 'verifying', '前端发布成功，站点已返回本次版本', { status: 'succeeded', result: { release } });
  }
  async rollbackFailure(task, error, previous) {
    if (!previous) {
      let cleanupError;
      try { if (await this.selected(task) === task.id) await rm(path.join(this.target(task), 'current')); }
      catch (failure) { cleanupError = failure.message; }
      await this.event(task, 'verifying', error.message, { status: 'failed', result: { error: error.message, rollback: { status: 'unavailable' }, ...(cleanupError ? { cleanupError } : {}) } }); return;
    }
    try {
      await this.event(task, 'deploying', '前端验证失败，正在恢复上一静态版本');
      await this.activate(task, previous); await this.health(task, previous); await this.owner.saveRelease(task, previous, null);
      await this.event(task, 'verifying', '前端发布失败，已恢复上一版本', { status: 'rolled_back', result: { error: error.message, release: previous, rollback: { status: 'succeeded', release: previous } } });
    } catch (failure) {
      await this.event(task, 'verifying', '前端发布失败，恢复验证也未通过', { status: 'failed', result: { error: error.message, rollback: { status: 'failed', error: failure.message } } });
    }
  }
  async execute(task) {
    const journal = this.owner.journal, existing = await journal.get(task.id);
    if (existing) return terminal(existing.status) ? undefined : this.recover(existing);
    await journal.create(task);
    let previous, deploying = false;
    try {
      const config = normalizeConfig(task.config);
      if (!['deploy', 'rollback'].includes(task.action)) throw new Error('静态站点不重启共用 Nginx，请发布或回退版本');
      await this.preflight(task); previous = await this.owner.current(task);
      if (await this.selected(task) !== (previous?.id || null) || (!previous && task.previousRelease)) throw new Error('站点指针与本地成功版本记录不一致，请先恢复 Agent 数据');
      if (previous) await this.requireRelease(task, previous);
      await journal.update(task.id, { previousRelease: previous });
      const release = task.action === 'deploy' ? await this.build(task, config) : await readJson(safeChild(this.owner.targetRoot(task), 'releases', `${identifier(task.release?.id)}.json`));
      await this.requireRelease(task, release);
      if (task.action === 'rollback' && release.artifact !== task.release.artifact) throw new Error('回退版本与本机保留版本不一致');
      await journal.update(task.id, { release });
      await this.event(task, 'deploying', '正在原子切换站点版本，共用 Nginx 保持运行');
      deploying = true; await this.activate(task, release);
      await this.event(task, 'verifying', '正在通过站点地址验证版本与页面响应');
      await this.health(task, release); await this.finish(task, release, previous);
    } catch (error) {
      if (deploying) await this.rollbackFailure(task, error, previous);
      else await this.event(task, (await journal.get(task.id)).stage, error.message, { status: 'failed', result: { error: error.message } });
    } finally { if (terminal((await journal.get(task.id))?.status)) await this.cleanupWork(task).catch(() => {}); }
  }
  async recover(record) {
    const task = record.task;
    try {
      await this.preflight(task);
      if (['deploying', 'verifying'].includes(record.stage) && record.release) {
        await this.event(task, 'verifying', 'Agent 恢复，正在核对静态版本');
        try { await this.health(task, record.release); await this.finish(task, record.release, record.previousRelease); }
        catch (error) { await this.rollbackFailure(task, error, record.previousRelease); }
      } else {
        const name = `cmr-build-${task.id}-node`;
        if (await this.owner.requireOwned(task, name)) await this.owner.mutation(task, ['rm', '-f', name], { timeoutMs: 15000 });
        await this.event(task, record.stage, '前端构建被中断，未修改线上版本，请重新发布', { status: 'interrupted' });
      }
    } catch (error) { await this.event(task, record.stage, error.message, { status: 'interrupted' }); }
    finally { if (terminal((await this.owner.journal.get(task.id))?.status)) await this.cleanupWork(task).catch(() => {}); }
  }
  async cleanupWork(task) {
    assertManaged(this.owner.getIdentity(), task);
    for (const name of ['source.zip', 'source', 'static-tools']) await rm(path.join(this.owner.taskRoot(task), name), { recursive: true, force: true });
    const record = await this.owner.journal.get(task.id);
    if (task.action === 'deploy' && record?.status !== 'succeeded') {
      await this.preflight(task);
      if (await this.selected(task) !== task.id) await rm(this.releasePath(task, task.id), { recursive: true, force: true });
    }
  }
  async cleanup(task, current, previous) {
    await this.preflight(task);
    const root = safeChild(this.owner.targetRoot(task), 'releases');
    const releases = (await Promise.all((await readdir(root)).filter(name => name.endsWith('.json')).map(name => readJson(safeChild(root, name))))).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const keep = new Set([...releases.slice(0, 5).map(item => item.id), current.id, previous?.id]);
    for (const release of releases) if (!keep.has(release.id)) {
      await this.requireRelease(task, release);
      await rm(this.releasePath(task, release.id), { recursive: true }); await rm(safeChild(root, `${identifier(release.id)}.json`));
    }
  }
}
