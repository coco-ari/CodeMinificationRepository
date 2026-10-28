import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { autoOpsApiUrl, autoOpsRequest, AutoOpsRequestError } from './apiClient'

const context = vi.hoisted(() => ({
  host: {
    gatewayBasePath: '/api/agent-demo/t3',
    httpBaseUrl: 'https://work.test/api/agent-demo/t3',
    csrfToken: 'isolated-test-csrf',
    principal: { id: 'test-user' },
  },
}))
vi.mock('./hostSnapshot', () => ({ readAutoOpsHost: () => context.host }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('统一业务请求边界', () => {
  it.each(['PUT', 'PATCH', 'DELETE'] as const)(
    '%s 修改沿用 CSRF 和未知结果保护',
    async (method) => {
      const fetcher = vi.fn().mockRejectedValue(new TypeError('network'))
      vi.stubGlobal('fetch', fetcher)
      await expect(
        autoOpsRequest('/autoops/projects/p/deployments/targets/t', {
          label: '部署配置',
          method,
          body: { requestId: 'original-request' },
        }),
      ).rejects.toMatchObject({ uncertain: true, code: 'CONNECTION_FAILED' })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
        method,
        credentials: 'same-origin',
        headers: { 'X-Demo-CSRF': 'isolated-test-csrf' },
        body: JSON.stringify({ requestId: 'original-request' }),
      })
    },
  )
  it('拒绝携带修改内容的 GET 请求', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(
      autoOpsRequest('/autoops/projects/p/deployments', { label: '部署', method: 'GET', body: {} }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST_METHOD', uncertain: false })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('工作区和skill写入复用同源身份与 CSRF，不自行重试', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accepted: true })))
    vi.stubGlobal('fetch', fetcher)
    expect(
      await autoOpsRequest('/autoops/skill-library', {
        label: 'skill库',
        body: { action: 'set-enabled', enabled: false },
      }),
    ).toEqual({ accepted: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/agent-demo/t3/autoops/skill-library')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { 'X-Demo-CSRF': 'isolated-test-csrf' },
      body: JSON.stringify({ action: 'set-enabled', enabled: false }),
    })
  })
  it('取消后到达的响应不能交给新页面', async () => {
    const controller = new AbortController()
    let deliver!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            deliver = resolve
          }),
      ),
    )
    const request = autoOpsRequest('/autoops/projects/old/workspaces', {
      label: '工作区',
      signal: controller.signal,
    })
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    deliver(new Response(JSON.stringify({ projectId: 'old' })))
    await rejected
  })
  it('已取消的请求不会发送', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    controller.abort()
    await expect(
      autoOpsRequest('/autoops/customer/devices', {
        label: '设备',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([200, 408, 500, 502])('写入返回 %s 且结果无法确认时保留未知结果语义', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid-json', { status })))
    await expect(
      autoOpsRequest('/autoops/projects/p/deployments/tasks', {
        label: '部署',
        body: { requestId: 'fixed-request' },
      }),
    ).rejects.toMatchObject({ uncertain: true, status })
  })
  it('明确拒绝的写入保留业务错误，不能标为结果未知', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'ENVIRONMENT_FORBIDDEN', message: '无权访问当前环境' },
          }),
          { status: 403 },
        ),
      ),
    )
    await expect(
      autoOpsRequest('/autoops/projects/p/deployments/tasks', {
        label: '部署',
        body: { requestId: 'fixed-request' },
      }),
    ).rejects.toMatchObject({
      uncertain: false,
      status: 403,
      code: 'ENVIRONMENT_FORBIDDEN',
      message: '无权访问当前环境',
    })
  })
  it('网络中断仅产生一次请求，保留可核查错误', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('network'))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      autoOpsRequest('/autoops/skill-library', { label: 'skill库', body: {} }),
    ).rejects.toMatchObject({ uncertain: true, code: 'CONNECTION_FAILED' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('读取超过预算后终止连接并提供明确超时错误', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_path, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
              once: true,
            })
          }),
      ),
    )
    const result = autoOpsRequest('/autoops/customer/devices', { label: '设备', timeoutMs: 30 })
    const rejected = expect(result).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      uncertain: false,
    })
    await vi.advanceTimersByTimeAsync(30)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
  it('无效响应不能伪装成成功的空列表', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null')))
    await expect(
      autoOpsRequest('/autoops/skill-library', { label: 'skill库' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', uncertain: false })
  })
  it('禁止请求跳出业务命名空间或带出凭据', () => {
    for (const path of [
      'https://other.test/autoops/a',
      '//other.test',
      '/autoops/../../logout',
      '/api/v1/../auth',
      '/api/v10/projects',
    ]) {
      expect(() => autoOpsApiUrl(path)).toThrow(AutoOpsRequestError)
    }
    expect(autoOpsApiUrl('/autoops/projects/p/workspaces?directory=a%20b')).toBe(
      '/api/agent-demo/t3/autoops/projects/p/workspaces?directory=a%20b',
    )
    expect(autoOpsApiUrl('/api/v1/projects/p/workspace/authoring')).toBe(
      '/api/agent-demo/t3/api/v1/projects/p/workspace/authoring',
    )
  })
})
