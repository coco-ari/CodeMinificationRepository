import http from 'node:http';
import { readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { RepositoryService } from './service.mjs';
import { HttpError, RateLimiter, randomSecret, equal } from './security.mjs';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const idPattern = '[a-f0-9-]{36}';
const SESSION_MS = 8 * 60 * 60 * 1000;

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, '请使用 application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new HttpError(413, '请求内容过大');
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
  const sessions = new Map();
  const loginLimiter = new RateLimiter(10, 10 * 60 * 1000);
  const downloadFailures = new RateLimiter(30, 60 * 1000);
  const downloadLimiter = new RateLimiter(60, 60 * 1000);
  const adminLimiter = new RateLimiter(120, 60 * 1000);
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ].map(async ([url, file, type]) => [url, { content: await readFile(path.join(publicDirectory, file)), type }])));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let file;
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      const ip = req.socket.remoteAddress || 'unknown';
      if (req.method === 'GET' && (assets.has(route) || new RegExp(`^/download/${idPattern}$`).test(route))) {
        const asset = assets.get(route) || assets.get('/');
        res.writeHead(200, { 'Content-Type': asset.type }); res.end(asset.content); return;
      }
      if (req.method === 'GET' && route === '/healthz') { json(res, 200, { status: 'ok' }); return; }
      const now = Date.now();
      for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
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
        sessions.set(key, { username, csrf, expires: now + SESSION_MS });
        res.setHeader('Set-Cookie', sessionCookie(key, secureCookies));
        json(res, 200, { username, csrf }); return;
      }
      const download = new RegExp(`^/api/projects/(${idPattern})/source/latest$`).exec(route);
      if (req.method === 'GET' && download) {
        const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
        try { service.authorizeDownload(download[1], token); }
        catch (error) { downloadFailures.take(ip); throw error; }
        downloadLimiter.take(download[1]);
        const archive = await service.sync(download[1]);
        // 等待过程中可能被停用或换密钥，发送文件前再次验证权限。
        service.authorizeDownload(download[1], token);
        if (res.destroyed) return;
        file = await open(archive.file, 'r');
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.size,
          'Content-Disposition': `attachment; filename="source-${archive.revision.slice(0, 12)}.zip"`,
          'X-Source-Revision': archive.revision, 'X-Archive-SHA256': archive.sha256,
          'X-Archive-Cache': archive.cached ? 'hit' : 'miss' });
        await pipeline(file.createReadStream(), res);
        await service.recordDownload(download[1]); return;
      }
      if (!session) throw new HttpError(401, '请先登录管理后台');
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (!equal(req.headers['x-csrf-token'] || '', session.csrf)) throw new HttpError(403, '会话校验失败，请刷新页面');
        adminLimiter.take(cookie);
      }
      if (req.method === 'POST' && route === '/api/logout') {
        sessions.delete(cookie); res.setHeader('Set-Cookie', sessionCookie('', secureCookies, 0)); json(res, 200, { ok: true }); return;
      }
      if (req.method === 'POST' && route === '/api/password') {
        loginLimiter.take(ip); await service.changePassword(await body(req)); sessions.clear();
        res.setHeader('Set-Cookie', sessionCookie('', secureCookies, 0)); json(res, 200, { ok: true }); return;
      }
      if (req.method === 'GET' && route === '/api/overview') { json(res, 200, service.overview()); return; }
      if (req.method === 'POST' && route === '/api/credentials') { json(res, 201, await service.saveCredential(await body(req))); return; }
      const credential = new RegExp(`^/api/credentials/(${idPattern})$`).exec(route);
      if (credential && req.method === 'PUT') { json(res, 200, await service.saveCredential(await body(req), credential[1])); return; }
      if (credential && req.method === 'DELETE') { await service.deleteCredential(credential[1]); json(res, 200, { ok: true }); return; }
      if (req.method === 'POST' && route === '/api/projects') { json(res, 201, await service.saveProject(await body(req))); return; }
      const project = new RegExp(`^/api/projects/(${idPattern})(?:/(rotate-token|sync|enabled))?$`).exec(route);
      if (project) {
        const [, id, action] = project;
        if (!action && req.method === 'PUT') { json(res, 200, await service.saveProject(await body(req), id)); return; }
        if (req.method === 'POST' && action === 'rotate-token') { json(res, 200, await service.rotateToken(id)); return; }
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
    } finally { if (file) await file.close().catch(() => {}); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return { server, service };
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
    const { server, service } = await createApplication({ directory, publicOrigin,
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
    const stop = () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 25000).unref();
    };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch (error) { console.error(`启动失败：${error.message}`); process.exit(1); }
}
