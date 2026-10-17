import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildCache } from '../agent/build-cache.mjs';

function cache(output, code = 0) {
  return new BuildCache({ root: '/tmp/cmr-cache-test', identity: () => ({ serverId: 'server-1' }),
    docker: { async run() { if (code) throw new Error('构建器连接失败'); return { code, output }; } } });
}

test('全新构建器返回 null 时按零缓存处理', async () => {
  assert.equal(await cache('null\n').usage(), 0);
  assert.equal(await cache('[]\n').usage(), 0);
});

test('构建缓存使用精确字节统计且拒绝非法用量', async () => {
  assert.equal(await cache('[{"size":1073741824},{"size":8192}]').usage(), 1073750016);
  for (const output of ['{}', '[{"size":"1GiB"}]', '[{"size":-1}]', '[{"size":1.5}]', 'invalid']) {
    await assert.rejects(cache(output).usage());
  }
});

test('构建器连接失败不能被解释成空缓存', async () => {
  await assert.rejects(cache('', 1).usage(), /构建器连接失败/);
});
