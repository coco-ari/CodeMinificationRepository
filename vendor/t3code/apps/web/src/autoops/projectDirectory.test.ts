import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
    clear: () => values.clear(),
  }
}
const bootstrap = (csrfToken = 'delete-csrf') => ({
  principal: { id: 'deletion-protocol-user', displayName: '删除协议测试' },
  csrfToken,
  gatewayBasePath: '/api/agent-demo/t3',
  fixedModel: { instanceId: 'codex', model: 'test-model' },
  runtimeMode: 'approval-required' as const,
  projects: [],
  capabilities: {},
})
beforeEach(async () => {
  vi.stubGlobal('window', {
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    location: { origin: 'https://work.test' },
  })
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(bootstrap(), 'https://work.test')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('删除收据保存 method、范围和修订，模块重开仍按原 DELETE 与 CSRF 提交并清理成功收据', async () => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectMutation(
    '/api/v1/projects/p/environments/test',
    4,
    {},
    'DELETE',
  )
  expect(original.body).toMatchObject({ expectedRevision: 4, requestId: expect.any(String) })
  expect(original.body).not.toHaveProperty('value')
  vi.resetModules()
  const reopened = await import('./projectDirectory')
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(bootstrap(), 'https://work.test')
  expect(reopened.readPendingProjectWrite()).toEqual(original)
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ deleted: true, projectId: 'p', environmentId: 'test' }))
  vi.stubGlobal('fetch', fetcher)
  expect(await reopened.submitProjectWrite(original)).toMatchObject({ deleted: true })
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    '/api/agent-demo/t3/api/v1/projects/p/environments/test',
    expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify(original.body),
      headers: expect.objectContaining({ 'X-Demo-CSRF': 'delete-csrf' }),
    }),
  )
  expect(reopened.readPendingProjectWrite()).toBeNull()
})

it('断线保留删除原请求并阻止跨项目新操作，显式核对不更换 requestId 或执行 POST', async () => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectMutation('/api/v1/projects/p', 2, {}, 'DELETE')
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('隔离断线'))
    .mockResolvedValueOnce(Response.json({ deleted: true, projectId: 'p' }))
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(directory.readPendingProjectWrite()).toEqual(original)
  expect(() => directory.prepareProjectMutation('/api/v1/projects/other', 1, {}, 'DELETE')).toThrow(
    '请先核对上一次保存结果',
  )
  await directory.submitProjectWrite(directory.readPendingProjectWrite()!)
  expect(fetcher.mock.calls.map(([, init]) => ({ method: init.method, body: init.body }))).toEqual([
    { method: 'DELETE', body: JSON.stringify(original.body) },
    { method: 'DELETE', body: JSON.stringify(original.body) },
  ])
  expect(directory.readPendingProjectWrite()).toBeNull()
})

it.each([403, 409])('删除收到明确 %s 拒绝时保留业务错误并释放已拒绝收据', async (status) => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectMutation('/api/v1/projects/p', 2, {}, 'DELETE')
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json(
        {
          code: status === 403 ? 'PROJECT_FORBIDDEN' : 'PROJECT_DELETE_BLOCKED',
          error: '真实删除拒绝',
        },
        { status },
      ),
    )
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({
    status,
    uncertain: false,
    message: '真实删除拒绝',
  })
  expect(directory.readPendingProjectWrite()).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('旧配置 POST 原收据继续沿原协议恢复，不被删除新增 method 改写', async () => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectWrite('/api/v1/projects/p/settings', 7, {
    name: '原配置',
  })
  expect(original).not.toHaveProperty('method')
  const fetcher = vi.fn().mockResolvedValue(Response.json({ revision: 8 }))
  vi.stubGlobal('fetch', fetcher)
  await directory.submitProjectWrite(original)
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    body: JSON.stringify(original.body),
  })
})

it('删除等待期间登录上下文变化拒绝迟到结果，不交付删除成功', async () => {
  const directory = await import('./projectDirectory')
  const { installAutoOpsHost } = await import('./hostConfig')
  let resolve!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    ),
  )
  const original = directory.prepareProjectMutation('/api/v1/projects/p', 1, {}, 'DELETE')
  const pending = directory.submitProjectWrite(original)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  installAutoOpsHost(bootstrap('renewed-csrf'), 'https://work.test')
  resolve(Response.json({ deleted: true, projectId: 'p' }))
  await rejected
  expect(directory.readPendingProjectWrite()).toBeNull()
})
