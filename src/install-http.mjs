import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export async function handleInstallRequest(req, res, route) {
  const assets = {
    '/agent/install.sh': { file: new URL('../agent/install.sh', import.meta.url), type: 'text/plain; charset=utf-8' },
    '/agent/bundle.tar.gz': { file: new URL('../dist/agent-bundle.tar.gz', import.meta.url), type: 'application/gzip' },
  };
  const asset = assets[route];
  if (!asset) return false;
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true;
  }
  let handle;
  try {
    handle = await open(asset.file, 'r');
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
