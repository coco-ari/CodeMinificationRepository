import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { loadDeployments, isDeploymentAccessError, DeploymentRequestError } from './deployments'

vi.mock('./hostSnapshot', () => ({
  readAutoOpsHost: () => ({
    httpBaseUrl: 'https://isolated.invalid/',
    gatewayBasePath: '/api/agent-demo/t3',
    principal: { id: 'isolated' },
    csrfToken: 'isolated-token',
  }),
}))
afterEach(() => vi.unstubAllGlobals())
describe('部署请求拒绝合同', () => {
  it.each([401, 403, 404])('保留 HTTP %s 与服务端错误代码以支持清除授权数据', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { code: 'ACCESS_DENIED', message: '访问已拒绝' } }),
            { status },
          ),
        ),
    )
    const result = await loadDeployments('p-one').catch((error) => error)
    expect(result).toBeInstanceOf(DeploymentRequestError)
    expect(result).toMatchObject({ status, code: 'ACCESS_DENIED', uncertain: false })
    expect(isDeploymentAccessError(result)).toBe(true)
  })
  it('临时服务异常不等同于撤权', () => {
    expect(isDeploymentAccessError(new DeploymentRequestError('暂时无法连接', false, 503))).toBe(
      false,
    )
  })
})
