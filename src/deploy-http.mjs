import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './security.mjs';

const id = '([a-f0-9-]{36})';
export async function handleAgentRequest(req, res, url, { deployment, body, json }) {
  if (!url.pathname.startsWith('/api/agent/v1/')) return false;
  const route = url.pathname.slice('/api/agent/v1'.length);
  if (route === '/register' && req.method === 'POST') { json(res, 201, await deployment.register(await body(req))); return true; }
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
  const serverId = deployment.authenticate(token);
  if (route === '/heartbeat' && req.method === 'POST') { json(res, 200, await deployment.heartbeat(serverId, await body(req))); return true; }
  if (route === '/claim' && req.method === 'POST') {
    const controller = new AbortController(); const abort = () => controller.abort(); res.once('close', abort);
    try {
      const task = await deployment.waitForTask(serverId, 25000, controller.signal);
      if (!res.destroyed) { deployment.authenticate(token); json(res, 200, { task }); }
    } finally { res.off('close', abort); }
    return true;
  }
  const task = new RegExp(`^/tasks/${id}/(source|events)$`).exec(route);
  if (task?.[2] === 'events' && req.method === 'POST') { json(res, 200, await deployment.events(serverId, task[1], await body(req))); return true; }
  if (task?.[2] === 'source' && ['GET', 'HEAD'].includes(req.method)) {
    const selected = deployment.source(serverId, task[1], url.searchParams.get('role') || 'selected');
    const archive = selected.archiveId ? await deployment.archives.verify(selected) : selected;
    const file = await open(archive.file, 'r');
    try {
      deployment.authenticate(token);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.size,
        'Content-Disposition': `attachment; filename="source-${archive.revision.slice(0, 12)}.zip"`, 'X-Source-Revision': archive.revision, 'X-Archive-SHA256': archive.sha256 });
      if (req.method === 'HEAD') res.end();
      else await pipeline(file.createReadStream(), res);
    } finally { await file.close().catch(() => {}); }
    return true;
  }
  throw new HttpError(404, 'Agent 接口不存在');
}

export async function handleDeployRequest(req, res, url, { deployment, body, json, expiresAt, sessionValid = () => true, trackStream = () => {} }) {
  if (!url.pathname.startsWith('/api/deploy/')) return false;
  const route = url.pathname.slice('/api/deploy'.length);
  if (route === '/overview' && req.method === 'GET') { json(res, 200, deployment.overview()); return true; }
  if (route === '/servers' && req.method === 'POST') { json(res, 201, await deployment.createServer(await body(req))); return true; }
  const revoke = new RegExp(`^/servers/${id}/revoke$`).exec(route);
  if (revoke && req.method === 'POST') { await deployment.revokeServer(revoke[1]); json(res, 200, { ok: true }); return true; }
  const server = new RegExp(`^/servers/${id}$`).exec(route);
  if (server && req.method === 'DELETE') { await deployment.deleteServer(server[1]); json(res, 200, { ok: true }); return true; }
  const entity = new RegExp(`^/(applications|environments|services|targets)(?:/${id})?$`).exec(route);
  if (entity && ((req.method === 'POST' && !entity[2]) || (req.method === 'PUT' && entity[2]))) {
    const result = await deployment.saveEntity(entity[1], await body(req), entity[2]);
    json(res, req.method === 'POST' ? 201 : 200, result); return true;
  }
  if (route === '/tasks' && req.method === 'POST') { json(res, 202, { task: await deployment.createTask(await body(req)) }); return true; }
  const detail = new RegExp(`^/tasks/${id}$`).exec(route);
  if (detail && req.method === 'GET') { json(res, 200, await deployment.taskDetails(detail[1], Number(url.searchParams.get('after') || 0))); return true; }
  const releases = new RegExp(`^/targets/${id}/releases$`).exec(route);
  if (releases && req.method === 'GET') { json(res, 200, { releases: deployment.releases(releases[1]) }); return true; }
  if (route === '/events' && req.method === 'GET') {
    if (!sessionValid()) throw new HttpError(401, '会话已失效');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write('retry: 3000\n\nevent: update\ndata: {"type":"connected"}\n\n');
    trackStream(res);
    const update = value => { if (!sessionValid()) { res.end(); return; } if (!res.destroyed && !res.write(`event: update\ndata: ${JSON.stringify(value)}\n\n`)) res.end(); };
    deployment.on('update', update);
    const timer = setInterval(() => { if (expiresAt <= Date.now() || !sessionValid()) res.end(); else if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
    res.once('close', () => { clearInterval(timer); deployment.off('update', update); }); return true;
  }
  throw new HttpError(404, '部署接口不存在');
}
