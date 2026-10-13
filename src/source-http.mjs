import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import path from 'node:path';
import { HttpError, RateLimiter, digest } from './security.mjs';
import { SOURCE_PROTOCOL } from './source-snapshots.mjs';

const compress = promisify(gzip);
const routePattern = /^\/api\/v1\/projects\/([a-f0-9-]{36})\/source\/(head|events|snapshots\/([a-f0-9]{64})\/(manifest|archive|files))$/;
const json = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };

export class SourceHttp {
  constructor(service) {
    this.service = service;
    this.clients = new Set();
    this.limiter = new RateLimiter(180, 60000);
    this.failures = new RateLimiter(30, 60000);
    this.changed = ({ projectId, snapshotId }) => {
      for (const client of this.clients) if (client.projectId === projectId) this.send(client, { snapshotId });
    };
    this.revoked = projectId => { for (const client of this.clients) if (client.projectId === projectId) client.res.end(); };
    service.events.on('source-change', this.changed);
    service.events.on('access-changed', this.revoked);
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) if (!client.res.write(': heartbeat\n\n')) client.res.destroy();
    }, 15000);
    this.heartbeat.unref();
  }
  send(client, value) {
    if (!client.res.write(`event: source\ndata: ${JSON.stringify({ protocol: SOURCE_PROTOCOL, ...value })}\n\n`)) client.res.destroy();
  }
  close() {
    clearInterval(this.heartbeat);
    this.service.events.off('source-change', this.changed);
    this.service.events.off('access-changed', this.revoked);
    for (const client of this.clients) client.res.end();
    this.clients.clear();
  }
  async handle(req, res, pathname, readBody) {
    const match = routePattern.exec(pathname);
    if (!match) return false;
    const [, projectId, operation, snapshotId, action] = match;
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    try { this.service.authorizeSource(projectId, token); }
    catch (error) { this.failures.take(req.socket.remoteAddress || 'unknown'); throw error; }
    this.limiter.take(projectId);
    const check = () => this.service.authorizeSource(projectId, token);
    if (operation === 'head' && req.method === 'GET') { json(res, await this.service.sourceHead(projectId, token)); return true; }
    if (operation === 'events' && req.method === 'GET') {
      if (this.clients.size >= 256 || [...this.clients].filter(c => c.projectId === projectId).length >= 32) throw new HttpError(429, '更新订阅数量过多');
      const head = await this.service.sourceHead(projectId, token);
      check();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const client = { projectId, res };
      this.clients.add(client);
      res.on('close', () => this.clients.delete(client));
      this.send(client, { snapshotId: head.snapshot?.snapshotId ?? null });
      return true;
    }
    if (!snapshotId || (action === 'files' ? req.method !== 'POST' : req.method !== 'GET')) throw new HttpError(405, '请求方法不支持');
    const current = this.service.store.state.projects.find(p => p.id === projectId);
    if (!current.sourceStatus?.snapshot) throw new HttpError(409, '源码快照尚未准备完成');
    const sourceIdentity = digest(`${current.repository}\n${current.branch}`);
    const lease = await this.service.snapshots.acquire(projectId, snapshotId);
    try {
      const { manifest } = lease;
      if (manifest.sourceIdentity !== sourceIdentity) throw new HttpError(410, '源码配置已变化，请刷新版本');
      // Recheck source binding as well as token after any asynchronous preparation.
      const recheck = () => { const p = check(); if (digest(`${p.repository}\n${p.branch}`) !== sourceIdentity) throw new HttpError(410, '源码配置已变化，请刷新版本'); };
      if (action === 'manifest') { recheck(); json(res, manifest); return true; }
      if (action === 'files') {
        const input = await readBody(req);
        if (Object.keys(input).some(key => key !== 'hashes')) throw new HttpError(400, '增量请求包含未知参数');
        const data = await this.service.snapshots.batch(projectId, manifest, input.hashes);
        recheck();
        const acceptsGzip = /(?:^|,)\s*gzip(?:\s*[,;]|\s*$)/i.test(req.headers['accept-encoding'] || '');
        const content = acceptsGzip ? await compress(Buffer.from(JSON.stringify(data))) : Buffer.from(JSON.stringify(data));
        recheck();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': content.length,
          ...(acceptsGzip ? { 'Content-Encoding': 'gzip' } : {}), Vary: 'Accept-Encoding' });
        res.end(content);
        return true;
      }
      const file = await open(path.join(this.service.snapshots.snapshotDirectory(projectId, snapshotId), 'source.zip'), 'r');
      try {
        recheck();
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': manifest.archiveBytes,
          'X-Source-Snapshot': snapshotId, 'X-Source-Revision': manifest.revision, 'X-Archive-SHA256': manifest.archiveSha256,
          'Content-Disposition': `attachment; filename="source-${snapshotId.slice(0, 12)}.zip"` });
        await pipeline(file.createReadStream(), res);
      } finally { await file.close().catch(() => {}); }
      return true;
    } finally { lease.release(); }
  }
}
