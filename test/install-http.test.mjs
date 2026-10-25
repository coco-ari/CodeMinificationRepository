import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { handleInstallRequest } from '../src/install-http.mjs';

class Response extends Writable {
  chunks = [];
  status = null;
  headers = {};
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
  _write(chunk, encoding, done) { this.chunks.push(Buffer.from(chunk)); done(); }
  get bytes() { return Buffer.concat(this.chunks); }
}

async function relocated(t) {
  const root = await mkdtemp(join(tmpdir(), 'autoops-install-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'vendor/t3code/apps/server/dist/install-entry.mjs');
  await mkdir(dirname(entry), { recursive: true });
  await copyFile(new URL('../src/install-http.mjs', import.meta.url), entry);
  const module = await import(pathToFileURL(entry).href);
  const assets = [
    { route: '/agent/install.sh', file: 'agent/install.sh', bytes: Buffer.from('#!/bin/sh\nprintf fixture-install\n'), type: 'text/plain; charset=utf-8' },
    { route: '/agent/bundle.tar.gz', file: 'dist/agent-bundle.tar.gz', bytes: Buffer.from([31, 139, 8, 0, 1, 2, 3]), type: 'application/gzip' },
  ];
  for (const asset of assets) { await mkdir(dirname(join(root, asset.file)), { recursive: true }); await writeFile(join(root, asset.file), asset.bytes); }
  return { root, module, assets };
}

test('安装路由移入真实 Worker 目录结构后仍从显式发行根读取完整资产', async t => {
  const { root, module, assets } = await relocated(t);
  for (const asset of assets) {
    for (const method of ['GET', 'HEAD']) {
      const response = new Response();
      assert.equal(await module.handleInstallRequest({ method }, response, asset.route, { assetsRoot: root }), true);
      assert.equal(response.status, 200, `${method} ${asset.route}`);
      assert.equal(response.headers['Content-Type'], asset.type);
      assert.equal(response.headers['Content-Length'], asset.bytes.length);
      assert.equal(response.headers['Cache-Control'], 'no-store');
      assert.deepEqual(response.bytes, method === 'HEAD' ? Buffer.alloc(0) : asset.bytes);
    }
  }
});

test('安装资源缺失、未知路径和写入方法保持明确边界', async t => {
  const { root, module } = await relocated(t);
  await rm(join(root, 'agent/install.sh'));
  const missing = new Response();
  assert.equal(await module.handleInstallRequest({ method: 'GET' }, missing, '/agent/install.sh', { assetsRoot: root }), true);
  assert.equal(missing.status, 503);
  assert.deepEqual(JSON.parse(missing.bytes.toString()), { error: 'Agent 安装包暂不可用，请检查中心构建结果。' });
  assert.ok(!missing.bytes.toString().includes(root));
  const invalid = new Response();
  assert.equal(await module.handleInstallRequest({ method: 'POST' }, invalid, '/agent/bundle.tar.gz', { assetsRoot: root }), true);
  assert.equal(invalid.status, 405);
  assert.equal(invalid.headers.Allow, 'GET, HEAD');
  const unknown = new Response();
  assert.equal(await module.handleInstallRequest({ method: 'GET' }, unknown, '/agent/../master.key', { assetsRoot: root }), false);
  assert.equal(unknown.status, null);
});

test('独立中心未传发行根时仍从原模块所在源码树提供安装脚本', async () => {
  const response = new Response();
  assert.equal(await handleInstallRequest({ method: 'GET' }, response, '/agent/install.sh'), true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.bytes, await readFile(new URL('../agent/install.sh', import.meta.url)));
});
