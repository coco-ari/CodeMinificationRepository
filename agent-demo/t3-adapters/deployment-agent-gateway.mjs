import http from 'node:http'

const task = '/api/agent/v1/tasks/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const sourcePath = new RegExp(`^${task}/source$`)
const routes = [
  [/^\/agent\/(?:install\.sh|bundle\.tar\.gz)$/, ['GET', 'HEAD']],
  [/^\/api\/agent\/v1\/(?:register|heartbeat|claim)$/, ['POST']],
  [new RegExp(`^${task}/events$`), ['POST']],
  [sourcePath, ['GET', 'HEAD']],
]
const requestHeaders = ['authorization', 'content-type', 'content-length', 'accept', 'user-agent']
const responseHeaders = ['content-type', 'content-length', 'content-disposition', 'cache-control', 'x-source-revision', 'x-archive-sha256', 'allow']
const pickHeaders = (headers, names) => Object.fromEntries(names.filter((name) => headers[name] !== undefined).map((name) => [name, headers[name]]))
const json = (res, status, error) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error })) }

export function configuredDeploymentAgentGateway(env) {
  if (env.AUTOOPS_DEPLOYMENT_ENABLED !== '1' || env.AUTOOPS_DEPLOYMENT_AGENT_PORT === undefined) return null
  if (!/^[1-9]\d{0,4}$/.test(env.AUTOOPS_DEPLOYMENT_AGENT_PORT) || Number(env.AUTOOPS_DEPLOYMENT_AGENT_PORT) > 65535) throw new Error('部署 Agent 监听端口必须为 1–65535')
  return createDeploymentAgentGateway(`http://127.0.0.1:${env.AUTOOPS_DEPLOYMENT_AGENT_PORT}`)
}

// 公网只转发部署 Agent 协议，登录身份和管理接口不进入此监听器。
export function createDeploymentAgentGateway(target, { timeout = 60000 } = {}) {
  const upstream = new URL(target)
  if (upstream.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(upstream.hostname) || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('部署 Agent 内部服务必须为本机 HTTP 地址')
  return {
    request(req, res) {
      const rawPath = (req.url || '').split('?')[0]
      if (!rawPath.startsWith('/agent/') && !rawPath.startsWith('/api/agent/v1/')) return false
      const route = routes.find(([pattern]) => pattern.test(rawPath))
      if (!route) { json(res, 404, 'Agent 接口不存在'); return true }
      if (!route[1].includes(req.method)) { res.setHeader('Allow', route[1].join(', ')); json(res, 405, '请求方法不支持'); return true }
      const url = new URL(req.url, 'http://localhost')
      if ([...url.searchParams].length && (!sourcePath.test(rawPath) || [...url.searchParams].length !== 1 || !['selected', 'baseline'].includes(url.searchParams.get('role')))) { json(res, 400, 'Agent 请求参数无效'); return true }
      const remote = http.request({ hostname: upstream.hostname.replace(/^\[|\]$/g, ''), port: upstream.port, method: req.method, path: req.url, headers: pickHeaders(req.headers, requestHeaders) }, (incoming) => {
        res.writeHead(incoming.statusCode ?? 502, pickHeaders(incoming.headers, responseHeaders))
        incoming.on('error', () => res.destroy())
        incoming.pipe(res)
      })
      remote.setTimeout(timeout, () => remote.destroy(new Error('部署 Agent 请求超时')))
      remote.on('error', () => { if (res.headersSent) res.destroy(); else json(res, 503, '部署服务暂不可用，请稍后重试') })
      req.on('aborted', () => remote.destroy())
      res.on('close', () => { if (!res.writableEnded) remote.destroy() })
      req.pipe(remote)
      return true
    },
  }
}
