import http from 'node:http'

export const T3_GATEWAY_PATH = '/api/agent-demo/t3'
// Transparent transport only. The worker validates the original cookie for
// every HTTP request and native WebSocket session; no principal header exists.
export function createT3Gateway(target, { timeout = 30000 } = {}) {
  const upstream = new URL(target)
  if (upstream.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(upstream.hostname) || upstream.username || upstream.password)
    throw new Error('T3 内部服务必须监听本机 HTTP 地址')
  const matches = (url = '') => url === T3_GATEWAY_PATH || url.startsWith(T3_GATEWAY_PATH + '/') || url.startsWith(T3_GATEWAY_PATH + '?')
  const options = (req) => ({
    hostname: upstream.hostname, port: upstream.port,
    method: req.method, path: req.url.slice(T3_GATEWAY_PATH.length) || '/',
    // Keep Host and Origin aligned for the upstream CSRF check.
    headers: { ...req.headers },
  })
  function request(req, res) {
    if (!matches(req.url)) return false
    const remote = http.request(options(req), (incoming) => {
      res.writeHead(incoming.statusCode ?? 502, incoming.headers)
      incoming.pipe(res)
      incoming.on('error', () => res.destroy())
    })
    const skillImport = req.method === 'POST' && req.url.split('?')[0] === T3_GATEWAY_PATH + '/autoops/skill-library'
    const workspaceWrite = req.method === 'POST' && req.url.startsWith(T3_GATEWAY_PATH + '/api/v1/projects/')
    const repositoryHistory = req.method === 'GET' && /^\/autoops\/projects\/[^/]+\/deployments\/repositories\/[^/]+\/history$/.test(req.url.slice(T3_GATEWAY_PATH.length).split('?')[0])
    let timedOut = false
    remote.setTimeout(repositoryHistory ? Math.max(timeout, 200000) : workspaceWrite ? Math.max(timeout, 180000) : skillImport ? Math.max(timeout, 120000) : timeout, () => {
      timedOut = true
      remote.destroy(new Error('T3 gateway timeout'))
    })
    remote.on('error', () => {
      if (res.headersSent) return res.destroy()
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      res.writeHead(timedOut ? 504 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        code: timedOut ? 'T3_UPSTREAM_TIMEOUT' : 'T3_UNAVAILABLE',
        error: mutation ? '操作响应中断，结果尚未确认，请核对原操作记录。' : timedOut ? '服务响应超时，请稍后重试。' : '服务暂时无法连接，请稍后重试。',
      }))
    })
    req.on('aborted', () => remote.destroy())
    res.on('close', () => { if (!res.writableEnded) remote.destroy() })
    req.pipe(remote)
    return true
  }
  function upgrade(req, socket, head) {
    if (!matches(req.url)) return socket.destroy()
    const remote = http.request(options(req))
    remote.setTimeout(timeout, () => remote.destroy())
    remote.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      remote.setTimeout(0)
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`)
      for (let i = 0; i < response.rawHeaders.length; i += 2)
        socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`)
      socket.write('\r\n')
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) upstreamSocket.write(head)
      socket.pipe(upstreamSocket).pipe(socket)
      socket.on('error', () => upstreamSocket.destroy())
      upstreamSocket.on('error', () => socket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.on('close', () => socket.destroy())
    })
    remote.on('response', (response) => {
      socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      response.resume()
    })
    remote.on('error', () => socket.destroy())
    socket.on('error', () => remote.destroy())
    remote.end()
  }
  return { request, upgrade, matches }
}
