import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function handleInstallRequest(req, res, route, { assetsRoot = fileURLToPath(new URL('..', import.meta.url)) } = {}) {
  const assets = {
    '/agent/install.sh': { file: 'agent/install.sh', type: 'text/plain; charset=utf-8' },
    '/agent/bundle.tar.gz': { file: 'dist/agent-bundle.tar.gz', type: 'application/gzip' },
  };
  const asset = assets[route];
  if (!asset) return false;
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true;
  }
  if (typeof assetsRoot !== 'string' || !isAbsolute(assetsRoot)) throw new TypeError('Agent 安装资源目录必须是绝对路径');
  let handle;
  try {
    handle = await open(join(assetsRoot, asset.file), 'r');
    const stat = await handle.stat();
    res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end();
    else await pipeline(handle.createReadStream(), res);
  } catch (error) {
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(error.code === 'ENOENT' ? 503 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Agent 安装包暂不可用，请检查中心构建结果。' }));
    }
  } finally { if (handle) await handle.close().catch(() => {}); }
  return true;
}
