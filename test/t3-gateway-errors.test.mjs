import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createT3Gateway, T3_GATEWAY_PATH } from '../agent-demo/t3-adapters/gateway.mjs'

async function listen(t, handler) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  return `http://127.0.0.1:${server.address().port}`
}

test('读取超时明确返回504，不将部署读取描述成对话恢复', async t => {
  const upstream = await listen(t, () => {})
  const gateway = createT3Gateway(upstream, { timeout: 25 })
  const origin = await listen(t, (req, res) => gateway.request(req, res))
  const result = await fetch(origin + T3_GATEWAY_PATH + '/autoops/projects/p/deployments')
  assert.equal(result.status, 504)
  assert.deepEqual(await result.json(), { code: 'T3_UPSTREAM_TIMEOUT', error: '服务响应超时，请稍后重试。' })
})

test('上游断开区分读取失败和修改结果未知，不伪称输入未丢失', async t => {
  const upstream = await listen(t, req => req.socket.destroy())
  const gateway = createT3Gateway(upstream)
  const origin = await listen(t, (req, res) => gateway.request(req, res))
  for (const method of ['GET', 'POST']) {
    const result = await fetch(origin + T3_GATEWAY_PATH + '/autoops/projects/p/deployments', { method })
    assert.equal(result.status, 503)
    assert.deepEqual(await result.json(), {
      code: 'T3_UNAVAILABLE',
      error: method === 'POST' ? '操作响应中断，结果尚未确认，请核对原操作记录。' : '服务暂时无法连接，请稍后重试。',
    })
  }
})

test('提交历史允许完成受限Git查询，其他读取仍受原超时约束', async t => {
  const upstream = await listen(t, (_req, res) => setTimeout(() => res.end('{"commits":[]}'), 80))
  const gateway = createT3Gateway(upstream, { timeout: 25 })
  const origin = await listen(t, (req, res) => gateway.request(req, res))
  const response = await fetch(origin + T3_GATEWAY_PATH + '/autoops/projects/p/deployments/repositories/r/history?refKind=branch&ref=main')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { commits: [] })
})
