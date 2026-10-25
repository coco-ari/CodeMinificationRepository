import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  loadDeployments,
  loadDeploymentReleases,
  isDeploymentAccessError,
  DeploymentRequestError,
  saveDeploymentService,
  updateDeploymentTarget,
  saveDeploymentServiceSource,
  submitDeployment,
} from './deployments'

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
  it('首屏历史显式读取20条，未指定分页的已有调用仍保留原请求', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ releases: [], total: 200, nextOffset: 20 }))),
      )
    vi.stubGlobal('fetch', fetcher)
    await loadDeploymentReleases('p-one', 'target/one')
    await loadDeploymentReleases('p-one', 'target/one', undefined, { offset: 0, limit: 20 })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/agent-demo/t3/autoops/projects/p-one/deployments/targets/target%2Fone/releases',
      '/api/agent-demo/t3/autoops/projects/p-one/deployments/targets/target%2Fone/releases?offset=0&limit=20',
    ])
  })

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

describe('部署写请求公开接口', () => {
  it('服务、目标编辑与默认来源使用各自合同和原始请求标识', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ accepted: true }))))
    vi.stubGlobal('fetch', fetcher)
    await saveDeploymentService('p-one', {
      name: '订单服务',
      kind: 'java',
      module: '.',
      requestId: 'service-request',
    })
    await updateDeploymentTarget('p-one', 'target/one', {
      config: {} as never,
      configKey: 'configuration-key',
      requestId: 'update-request',
    })
    await saveDeploymentServiceSource('p-one', 'service/one', 'env/test', {
      sources: [],
      contexts: [],
      configKey: 'source-key',
      requestId: 'source-request',
    })
    expect(
      fetcher.mock.calls.map(([url, options]) => [
        url,
        options.method,
        JSON.parse(options.body).requestId,
      ]),
    ).toEqual([
      ['/api/agent-demo/t3/autoops/projects/p-one/deployments/services', 'POST', 'service-request'],
      [
        '/api/agent-demo/t3/autoops/projects/p-one/deployments/targets/target%2Fone',
        'PATCH',
        'update-request',
      ],
      [
        '/api/agent-demo/t3/autoops/projects/p-one/deployments/services/service%2Fone/sources/env%2Ftest',
        'PUT',
        'source-request',
      ],
    ])
  })
  it('直接发布只提交一次来源快照，网络断开保留待核对语义', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('offline'))
    vi.stubGlobal('fetch', fetcher)
    const result = await submitDeployment('p-one', {
      targetId: 'target',
      service: 'backend',
      action: 'deploy',
      configKey: 'config',
      requestId: 'original-request',
      sourceSelection: {
        sources: [{ sourceId: 'repo', refKind: 'branch', ref: 'release' }],
        contexts: [{ service: 'backend', root: '.', workingDirectory: '.' }],
      },
    }).catch((error) => error)
    expect(result).toBeInstanceOf(DeploymentRequestError)
    expect(result.uncertain).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({
      requestId: 'original-request',
      sourceSelection: { sources: [{ ref: 'release' }] },
    })
  })
})
