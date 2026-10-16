import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { VERSION, CAPABILITIES, identifier } from './config.mjs';
import { SourceCache } from './source-cache.mjs';

export class CenterClient {
  constructor(url, { allowHttpTest = false, token = null, timeoutMs = 35000, cacheDirectory = null } = {}) {
    this.url = new URL(url); this.token = token; this.timeoutMs = timeoutMs;
    if (this.url.username || this.url.password || this.url.search || this.url.hash || this.url.pathname !== '/' || (this.url.protocol !== 'https:' && !(allowHttpTest && this.url.protocol === 'http:'))) throw new Error('中心地址必须是 HTTPS 源站；HTTP 仅允许显式隔离测试');
    this.cache = cacheDirectory ? new SourceCache(cacheDirectory) : null;
  }
  async post(endpoint, body = {}, timeoutMs = this.timeoutMs) {
    const response = await fetch(new URL(`/api/agent/v1/${endpoint}`, this.url), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`中心请求失败（HTTP ${response.status}）`);
    const text = await response.text(); if (text.length > 4 * 1024 * 1024) throw new Error('中心响应过大');
    return JSON.parse(text);
  }
  register(registrationToken) { return this.post('register', { registrationToken, version: VERSION, capabilities: CAPABILITIES }); }
  async download(task, destination, maxBytes = 64 * 1024 * 1024, report = () => {}) {
    identifier(task.id);
    const expectedPath = `/api/agent/v1/tasks/${identifier(task.downloadTaskId || task.id)}/source`, url = new URL(task.source.url, this.url);
    if (url.origin !== this.url.origin || url.pathname !== expectedPath || (url.search && url.search !== '?role=baseline') || url.hash || (url.search && !task.downloadTaskId)) throw new Error('拒绝下载非当前中心或非当前任务的源码');
    if (!/^[a-f0-9]{64}$/.test(task.source.sha256) || !/^[a-f0-9]{40,64}$/.test(task.source.revision)) throw new Error('源码摘要或版本无效');
    const started = performance.now();
    const key = createHash('sha256').update(JSON.stringify([this.url.origin, task.applicationId || task.targetId, task.sourceProjectId || task.targetId, task.source.revision, task.source.sha256])).digest('hex');
    const available = this.cache && await this.cache.has(key).catch(() => false);
    if (available) {
      // 即使命中缓存，也必须通过当前任务授权，不能用缓存绕过撤销或跨 Agent 隔离。
      const response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { authorization: `Bearer ${this.token}` } });
      if (response.ok) {
        if (response.headers.get('x-archive-sha256') !== task.source.sha256 || response.headers.get('x-source-revision') !== task.source.revision || (task.source.size != null && Number(response.headers.get('content-length')) !== task.source.size)) throw new Error('中心源码确认与任务版本不一致');
        const size = await this.cache.restore(key, destination, task.source, maxBytes);
        if (size !== null) { await report({ cached: true, size, durationMs: Math.round(performance.now() - started) }); return size; }
      } else if (![404, 405, 501].includes(response.status)) throw new Error(`确认源码权限失败（HTTP ${response.status}）`);
      // 旧中心不支持 HEAD 时仍走原始下载接口，不降低授权检查。
    }
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(900000), headers: { authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new Error(`下载源码失败（HTTP ${response.status}）`);
    const handle = await open(destination, 'wx', 0o600), hash = createHash('sha256'); let size = 0;
    try {
      for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) throw new Error('源码压缩包过大'); hash.update(chunk); await handle.writeFile(chunk); }
      if (hash.digest('hex') !== task.source.sha256 || (task.source.size != null && size !== task.source.size)) throw new Error('源码 ZIP 校验失败');
      await handle.sync();
    } catch (error) { await handle.close(); await rm(destination, { force: true }); throw error; }
    await handle.close();
    if (this.cache) await this.cache.store(key, destination, task.source).catch(() => {});
    await report({ cached: false, size, durationMs: Math.round(performance.now() - started) });
    return size;
  }
}
