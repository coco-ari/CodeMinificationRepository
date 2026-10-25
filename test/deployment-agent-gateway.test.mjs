import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createDeploymentAgentGateway, configuredDeploymentAgentGateway } from '../agent-demo/t3-adapters/deployment-agent-gateway.mjs'

async function listen(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  return `http://127.0.0.1:${server.address().port}`
}
async function fixture(t, handler, options) {
  const upstream = await listen(t, handler), gateway = createDeploymentAgentGateway(upstream, options)
  return listen(t, (req, res) => { if (!gateway.request(req, res)) { res.writeHead(418); res.end('工作台入口') } })
}

test('仅在部署明确启用且端口有效时接通本机监听，拒绝远端或含额外 URL 信息的上游', () => {
  assert.equal(configuredDeploymentAgentGateway({}), null)
  assert.equal(configuredDeploymentAgentGateway({ AUTOOPS_DEPLOYMENT_ENABLED: '1' }), null)
  for (const port of ['0', '65536', '1234/path', '-1', 'NaN']) assert.throws(() => configuredDeploymentAgentGateway({ AUTOOPS_DEPLOYMENT_ENABLED: '1', AUTOOPS_DEPLOYMENT_AGENT_PORT: port }), /端口/)
  for (const target of ['http://remote.invalid', 'https://127.0.0.1', 'http://u:p@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?query=1']) assert.throws(() => createDeploymentAgentGateway(target), /本机 HTTP/)
})

test('HTTPS 入口转发所需安装、注册、心跳、领取、日志与源码路径，保留原授权和校验头', async (t) => {
  const received = [], payload = Buffer.from('隔离下载内容')
  const url = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length, 'x-archive-sha256': 'isolated-checksum', 'set-cookie': 'must-not-forward=1' }); res.end(payload)
  })
  const id = randomUUID()
  for (const [route, method] of [['/agent/install.sh', 'GET'], ['/agent/bundle.tar.gz', 'HEAD'], ['/api/agent/v1/register', 'POST'], ['/api/agent/v1/heartbeat', 'POST'], ['/api/agent/v1/claim', 'POST'], [`/api/agent/v1/tasks/${id}/events`, 'POST'], [`/api/agent/v1/tasks/${id}/source?role=baseline`, 'GET']]) {
    const response = await fetch(url + route, { method, headers: { Authorization: 'Bearer isolated-test-token', Cookie: 'demo_session=must-not-forward', 'X-AutoOps-Principal': 'must-not-forward' }, ...(method === 'POST' ? { body: '{"seq":1}' } : {}) })
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-archive-sha256'), 'isolated-checksum'); assert.equal(response.headers.get('set-cookie'), null)
    assert.equal((await response.arrayBuffer()).byteLength, method === 'HEAD' ? 0 : payload.length)
    assert.equal(received.at(-1).url, route)
    assert.equal(received.at(-1).headers.authorization, 'Bearer isolated-test-token')
    assert.equal(received.at(-1).headers.cookie, undefined)
    assert.equal(received.at(-1).headers['x-autoops-principal'], undefined)
    if (method === 'POST') assert.equal(received.at(-1).body, '{"seq":1}')
  }
})

test('未知接口、方法和查询不进入 Agent 监听；管理与旧源码下载入口保持隔离', async (t) => {
  let calls = 0
  const url = await fixture(t, (_req, res) => { calls++; res.end() })
  for (const [route, method, expected] of [['/api/agent/v1/overview', 'GET', 404], ['/agent/install.sh', 'POST', 405], ['/api/agent/v1/claim', 'GET', 405], ['/agent/install.sh?url=bad', 'GET', 400], [`/api/agent/v1/tasks/${randomUUID()}/source?role=baseline&role=selected`, 'GET', 400], ['/api/deploy/overview', 'GET', 418], ['/api/projects/id/source/latest', 'GET', 418]]) {
    const response = await fetch(url + route, { method }); assert.equal(response.status, expected); await response.arrayBuffer()
  }
  assert.equal(calls, 0)
})

test('上游不可用或超时提供明确失败，不无限等待或泄露内部地址', async (t) => {
  const url = await fixture(t, () => {}, { timeout: 30 })
  const response = await fetch(url + '/api/agent/v1/claim', { method: 'POST' })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: '部署服务暂不可用，请稍后重试' })
})
