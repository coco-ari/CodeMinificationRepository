import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RepositoryService } from './service.mjs';
import { HttpError, RateLimiter, randomSecret, equal } from './security.mjs';
import { DeploymentService } from './deployment.mjs';
import { handleAgentRequest, handleDeployRequest } from './deploy-http.mjs';
import { WorkspaceService, historyWorkspace } from './workspaces.mjs';
import { handleWorkspaceRequest } from './workspace-http.mjs';
import { handleInstallRequest } from './install-http.mjs';

const publicDirectory = fileURLToPath(new URL('../dist/web/', import.meta.url));
const idPattern = '[a-f0-9-]{36}';
const SESSION_MS = 8 * 60 * 60 * 1000;

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, '请使用 application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 262144) throw new HttpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw new HttpError(400, 'JSON 请求格式错误'); }
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
function sessionCookie(value, secure, age = SESSION_MS / 1000) {
  return `cmr_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
}

export async function createApplication({ directory, service, secureCookies = true, publicOrigin = '', ...options }) {
  service ||= new RepositoryService({ directory, ...options });
  await service.initialize();
  const deployment = new DeploymentService(service, { publicOrigin });
  await deployment.initialize();
  const workspaces = new WorkspaceService(service, deployment);
  const sessions = new Map();
  const revokeSession = key => {
    const session = sessions.get(key); sessions.delete(key);
    for (const stream of session?.streams || []) stream.end();
  };
  let stopping = false, closePromise, resourcesPromise;
  const activeRequests = new Set();
  const loginLimiter = new RateLimiter(10, 10 * 60 * 1000);
  const adminLimiter = new RateLimiter(120, 60 * 1000);
  // 仅提供构建目录内的已知静态资源，不把请求路径拼接为文件系统路径。
  const assets = new Map();
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  async function loadAssets(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), url = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await loadAssets(file, url);
      else if (mime[path.extname(entry.name)]) assets.set(url === '/index.html' ? '/' : url, { content: await readFile(file), type: mime[path.extname(entry.name)] });
    }
  }
  try { await loadAssets(publicDirectory); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('缺少前端构建产物，请先执行 pnpm install --frozen-lockfile 和 pnpm build'); throw error; }
  const server = http.createServer((req, res) => {
    const pending = handleRequest(req, res); activeRequests.add(pending);
    pending.finally(() => activeRequests.delete(pending)).catch(() => {});
  });
  async function handleRequest(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (stopping) throw new HttpError(503, '中心正在停止，请稍后重试');
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      const ip = req.socket.remoteAddress || 'unknown';
      if (await handleInstallRequest(req, res, route, { publicOrigin })) return;
      if (req.method === 'GET' && assets.has(route)) {
        const asset = assets.get(route);
        let content = asset.content;
        if (asset.type.startsWith('text/html')) {
          const nonce = randomSecret();
          res.setHeader('Content-Security-Policy', res.getHeader('Content-Security-Policy').replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`));
          content = content.toString('utf8').replace('__CMR_STYLE_NONCE__', nonce);
        }
        res.writeHead(200, { 'Content-Type': asset.type }); res.end(content); return;
      }
      if (req.method === 'GET' && route === '/healthz') { json(res, 200, { status: 'ok' }); return; }
      const now = Date.now();
      for (const [key, session] of sessions) if (session.expires <= now) revokeSession(key);
      const cookie = /(?:^|;\s*)cmr_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
      const session = sessions.get(cookie);
      if (req.method === 'GET' && route === '/api/session') {
        json(res, 200, { initialized: !!service.store.state.admin, authenticated: !!session,
          ...(session ? { username: session.username, csrf: session.csrf } : {}) }); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        const origin = publicOrigin || `${secureCookies ? 'https' : 'http'}://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, '请求来源不匹配');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '不允许跨站请求');
      }
      if (req.method === 'POST' && ['/api/setup', '/api/login'].includes(route)) {
        loginLimiter.take(ip);
        const input = await body(req);
        if (route === '/api/setup') await service.setup(input);
        const username = await service.login(input);
        if (sessions.size >= 1000) throw new HttpError(503, '会话数量已满');
        const key = randomSecret();
        const csrf = randomSecret();
        sessions.set(key, { username, csrf, expires: now + SESSION_MS, streams: new Set() });
        res.setHeader('Set-Cookie', sessionCookie(key, secureCookies));
        json(res, 200, { username, csrf }); return;
      }
      if (await handleAgentRequest(req, res, url, { deployment, body, json })) return;
      if (!session) throw new HttpError(401, '请先登录管理后台');
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (!equal(req.headers['x-csrf-token'] || '', session.csrf)) throw new HttpError(403, '会话校验失败，请刷新页面');
        adminLimiter.take(cookie);
      }
      if (await handleWorkspaceRequest(req, res, url, { workspaces, deployment, service, body, json, expiresAt: session.expires,
        sessionValid: () => !stopping && sessions.get(cookie) === session && session.expires > Date.now(),
        trackStream: stream => { session.streams.add(stream); stream.once('close', () => session.streams.delete(stream)); },
      })) return;
      if (await handleDeployRequest(req, res, url, { deployment, body, json, expiresAt: session.expires,
        sessionValid: () => !stopping && sessions.get(cookie) === session && session.expires > Date.now(),
        trackStream: stream => { session.streams.add(stream); stream.once('close', () => session.streams.delete(stream)); },
      })) return;
      if (req.method === 'POST' && route === '/api/logout') {
        revokeSession(cookie); res.setHeader('Set-Cookie', sessionCookie('', secureCookies, 0)); json(res, 200, { ok: true }); return;
      }
      if (req.method === 'POST' && route === '/api/password') {
        loginLimiter.take(ip); await service.changePassword(await body(req)); for (const key of sessions.keys()) revokeSession(key);
        res.setHeader('Set-Cookie', sessionCookie('', secureCookies, 0)); json(res, 200, { ok: true }); return;
      }
      if (req.method === 'GET' && route === '/api/overview') { json(res, 200, service.overview()); return; }
      if (req.method === 'GET' && route === '/api/credentials') { json(res, 200, { credentials: service.overview().credentials }); return; }
      if (req.method === 'POST' && route === '/api/credentials') { json(res, 201, await service.saveCredential(await body(req))); return; }
      const credential = new RegExp(`^/api/credentials/(${idPattern})$`).exec(route);
      if (credential && req.method === 'PUT') { json(res, 200, await service.saveCredential(await body(req), credential[1])); return; }
      if (credential && req.method === 'DELETE') { await service.deleteCredential(credential[1]); json(res, 200, { ok: true }); return; }
      if (req.method === 'POST' && route === '/api/projects') { const input = await body(req);
        if (!input.applicationId) input.applicationId = await service.store.change(state => historyWorkspace(state).id);
        json(res, 201, await service.saveProject(input)); return; }
      const project = new RegExp(`^/api/projects/(${idPattern})(?:/(sync|enabled))?$`).exec(route);
      if (project) {
        const [, id, action] = project;
        if (!action && req.method === 'PUT') { json(res, 200, await service.saveProject(await body(req), id)); return; }
        if (req.method === 'POST' && action === 'enabled') { await service.setEnabled(id, (await body(req)).enabled); json(res, 200, { ok: true }); return; }
        if (req.method === 'POST' && action === 'sync') {
          const { file: privatePath, ...result } = await service.sync(id);
          json(res, 200, result); return;
        }
      }
      throw new HttpError(404, '接口不存在');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (res.destroyed) return;
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 429 || status === 503) res.setHeader('Retry-After', '60');
      json(res, status, { error: error instanceof HttpError ? error.message : '服务处理失败，请检查磁盘和服务配置' });
    }
  }
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  const settleResources = () => resourcesPromise ||= (async () => {
    // HTTP 连接结束后仍可能有源码准备和事务正在收尾，必须等待这些工作。
    await Promise.allSettled([...activeRequests]); await deployment.close(); await service.store.close();
  })();
  const close = ({ timeoutMs = 25000 } = {}) => {
    if (closePromise) return closePromise;
    stopping = true; deployment.beginClose();
    for (const key of sessions.keys()) revokeSession(key);
    closePromise = (async () => {
      const httpClosed = new Promise(resolve => { server.close(() => resolve()); });
      let timer;
      const drained = (async () => { await httpClosed; await settleResources(); return { graceful: true }; })();
      const deadline = new Promise(resolve => { timer = setTimeout(() => {
        // 强制断开连接但不改写准备中的任务，重启后根据持久状态继续恢复。
        server.closeAllConnections(); resolve({ graceful: false });
      }, timeoutMs); });
      try { return await Promise.race([drained, deadline]); } finally { clearTimeout(timer); }
    })();
    return closePromise;
  };
  server.on('close', () => { settleResources().catch(() => {}); });
  return { server, service, deployment, workspaces, close };
}

function integerEnv(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 配置无效`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const directory = path.resolve(process.env.DATA_DIR || './data');
    const publicOrigin = process.env.PUBLIC_ORIGIN || '';
    if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) throw new Error('PUBLIC_ORIGIN 必须是完整来源地址，不能包含路径或末尾斜杠');
    const { server, service, close } = await createApplication({ directory, publicOrigin,
      secureCookies: process.env.COOKIE_SECURE !== 'false',
      maxConcurrent: integerEnv('MAX_CONCURRENT_SYNCS', 2, 1, 8),
      maxPending: integerEnv('MAX_PENDING_SYNCS', 20, 0, 100),
      timeoutMs: integerEnv('SYNC_TIMEOUT_SECONDS', 180, 10, 1800) * 1000,
      maxArchiveBytes: integerEnv('MAX_ARCHIVE_MB', 1024, 1, 10240) * 1024 * 1024,
    });
    const port = integerEnv('PORT', 8080, 1, 65535);
    server.listen(port, process.env.HOST || '0.0.0.0', () => {
      console.log(`CodeMinificationRepository 已启动，端口 ${port}`);
      if (!service.store.state.admin) console.log(`请读取 ${service.bootstrapPath}，在网页中输入初始化口令并创建管理员。`);
    });
    const stop = () => close({ timeoutMs: integerEnv('SHUTDOWN_TIMEOUT_SECONDS', 25, 1, 1800) * 1000 })
      .then(result => process.exit(result.graceful ? 0 : 1)).catch(() => process.exit(1));
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch (error) { console.error(`启动失败：${error.message}`); process.exit(1); }
}
