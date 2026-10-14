import { HttpError } from './security.mjs';

const id = '([a-f0-9-]{36})';
export async function handleWorkspaceRequest(req, res, url, { workspaces, deployment, service, body, json, expiresAt, sessionValid, trackStream }) {
  if (!/^\/api\/workspaces(?:\/|$)/.test(url.pathname)) return false;
  const route = url.pathname.slice('/api/workspaces'.length);
  const respond = (value, status = 200) => { json(res, status, value); return true; };
  if (!route && req.method === 'GET') return respond({ projects: workspaces.list(), migration: workspaces.data.workspaceMigration });
  if (!route && req.method === 'POST') return respond(await workspaces.create(await body(req)), 201);
  const match = new RegExp(`^/${id}(.*)$`).exec(route);
  if (!match) throw new HttpError(404, '项目接口不存在');
  const [, applicationId, sub] = match;
  workspaces.project(applicationId);
  if (!sub && req.method === 'GET') return respond(workspaces.overview(applicationId));
  if (!sub && req.method === 'PUT') return respond(await deployment.saveEntity('applications', await body(req), applicationId));
  if (sub === '/server-candidates' && req.method === 'GET') {
    return respond({ servers: deployment.overview().servers.filter(item => !item.revoked).map(({ id, name, mode, online }) => ({ id, name, mode, online })) });
  }
  if (sub === '/servers' && req.method === 'POST') return respond(await deployment.createServer({ ...await body(req), applicationId }), 201);
  const binding = new RegExp(`^/servers/${id}$`).exec(sub);
  if (binding && ['PUT', 'DELETE'].includes(req.method)) {
    await workspaces.bind(applicationId, binding[1], req.method === 'DELETE'); return respond({ ok: true });
  }
  if (sub === '/environment-sources' && req.method === 'PUT') return respond(await workspaces.saveSource(applicationId, await body(req)));
  const repository = new RegExp(`^/repositories(?:/${id})?(?:/(sync|rotate-token|enabled))?$`).exec(sub);
  if (repository) {
    const [, sourceId, action] = repository;
    if (sourceId) workspaces.owned('repositories', sourceId, applicationId);
    if (!action && ((req.method === 'POST' && !sourceId) || (req.method === 'PUT' && sourceId))) {
      const value = await service.saveProject({ ...await body(req), applicationId }, sourceId);
      deployment.changed('repository', value.project.id, applicationId); return respond(value, sourceId ? 200 : 201);
    }
    if (sourceId && req.method === 'POST') {
      let value;
      if (action === 'sync') { const { file, ...result } = await service.sync(sourceId); value = result; }
      else if (action === 'rotate-token') value = await service.rotateToken(sourceId);
      else if (action === 'enabled') { await service.setEnabled(sourceId, (await body(req)).enabled); value = { ok: true }; }
      if (value) { deployment.changed('repository', sourceId, applicationId); return respond(value); }
    }
  }
  const entity = new RegExp(`^/(environments|services|targets)(?:/${id})?$`).exec(sub);
  if (entity && ((req.method === 'POST' && !entity[2]) || (req.method === 'PUT' && entity[2]))) {
    return respond(await workspaces.saveEntity(applicationId, entity[1], await body(req), entity[2]), entity[2] ? 200 : 201);
  }
  if (sub === '/tasks' && req.method === 'POST') {
    const input = await body(req); workspaces.owned('targets', input.targetId, applicationId);
    return respond({ task: await deployment.createTask(input) }, 202);
  }
  const task = new RegExp(`^/tasks/${id}$`).exec(sub);
  if (task && req.method === 'GET') {
    workspaces.owned('tasks', task[1], applicationId); return respond(await deployment.taskDetails(task[1], Number(url.searchParams.get('after') || 0)));
  }
  const releases = new RegExp(`^/targets/${id}/releases$`).exec(sub);
  if (releases && req.method === 'GET') {
    workspaces.owned('targets', releases[1], applicationId); return respond({ releases: deployment.releases(releases[1]) });
  }
  if (sub === '/events' && req.method === 'GET') {
    if (!sessionValid()) throw new HttpError(401, '会话已失效');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write('retry: 3000\n\nevent: update\ndata: {"type":"connected"}\n\n'); trackStream(res);
    const update = value => {
      if (!sessionValid()) { res.end(); return; }
      if (workspaces.eventBelongs(value, applicationId) && !res.destroyed && !res.write(`event: update\ndata: ${JSON.stringify(value)}\n\n`)) res.end();
    };
    deployment.on('update', update);
    const timer = setInterval(() => { if (expiresAt <= Date.now() || !sessionValid()) res.end(); else if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
    res.once('close', () => { clearInterval(timer); deployment.off('update', update); }); return true;
  }
  throw new HttpError(404, '项目接口不存在');
}
