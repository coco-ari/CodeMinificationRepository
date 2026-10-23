import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

const bootstrap = (id = 'alice') => ({
  principal: { id, displayName: id },
  gatewayBasePath: '/api/agent-demo/t3',
  csrfToken: 'test-csrf',
  fixedModel: { instanceId: 'codex', model: 'configured-model' },
  runtimeMode: 'approval-required' as const,
  projects: [
    {
      id: 'p-autoops',
      name: 'AutoOps',
      environments: [{ id: 'test', name: '测试' }],
      agents: [{ id: 'agent', name: '项目 Agent' }],
    },
  ],
  capabilities: {},
})
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    key: (index) => Array.from(data.keys())[index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
    clear: () => data.clear(),
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})
describe('AutoOps host authentication boundary', () => {
  it('keeps T3 model and reasoning choices when a real CPA catalog is available', async () => {
    const host = await import('./hostConfig')
    const { readHostTurnConfiguration } = await import('@t3tools/client-runtime/host-integration')
    host.installAutoOpsHost({ ...bootstrap(), modelSelectionEnabled: true }, 'https://work.test')
    expect(readHostTurnConfiguration()).toEqual({ runtimeMode: 'approval-required' })
  })
  it('uses the authenticated same-origin gateway and rejects cross-origin/path traversal', async () => {
    const host = await import('./hostConfig')
    expect(host.installAutoOpsHost(bootstrap(), 'https://work.test')).toMatchObject({
      httpBaseUrl: 'https://work.test/api/agent-demo/t3',
      wsBaseUrl: 'wss://work.test/api/agent-demo/t3/ws',
    })
    for (const gatewayBasePath of [
      'https://outside.test/api',
      '//outside.test/api',
      '/api/../outside',
      '/',
    ]) {
      expect(() =>
        host.installAutoOpsHost({ ...bootstrap(), gatewayBasePath }, 'https://work.test'),
      ).toThrow()
    }
    expect(() => host.installAutoOpsHost(bootstrap('bob'), 'https://work.test')).toThrow(/Reload/)
  })
  it('isolates drafts/cache keys and scoped clear without reading legacy or another principal', async () => {
    const host = await import('./hostConfig')
    const storage = memoryStorage()
    storage.setItem('drafts', 'legacy-private')
    storage.setItem('autoops:t3:bob:drafts', 'bob-private')
    host.installAutoOpsHost(bootstrap(), 'https://work.test')
    const scoped = host.autoOpsStorage(storage)
    expect(scoped.getItem('drafts')).toBeNull()
    scoped.setItem('drafts', 'alice-private')
    expect(scoped.length).toBe(1)
    expect(scoped.key(0)).toBe('drafts')
    expect(scoped.getItem('drafts')).toBe('alice-private')
    scoped.clear()
    expect(storage.getItem('drafts')).toBe('legacy-private')
    expect(storage.getItem('autoops:t3:bob:drafts')).toBe('bob-private')
  })
  it('awaits the cookie/CSRF scope binding before native launch and propagates rejection', async () => {
    const host = await import('./hostConfig')
    const { prepareHostThreadLaunch, readHostTurnConfiguration } =
      await import('@t3tools/client-runtime/host-integration')
    host.installAutoOpsHost(bootstrap(), 'https://work.test')
    expect(readHostTurnConfiguration()).toEqual({
      modelSelection: { instanceId: 'codex', model: 'configured-model' },
      runtimeMode: 'approval-required',
    })
    const binding = {
      projectId: 'p-autoops',
      environmentId: 'test',
      agentId: 'agent',
      visibility: 'private',
      scopeState: 'draft',
      scopeLocked: false,
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValue({ ok: true, json: async () => ({ binding }) })
    vi.stubGlobal('fetch', fetch)
    await prepareHostThreadLaunch({ threadId: 'thread-a', projectId: 'p-autoops' })
    expect(fetch).toHaveBeenCalledWith(
      '/api/agent-demo/t3/autoops/thread-bindings',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-Demo-CSRF': 'test-csrf' }),
        body: JSON.stringify({
          threadId: 'thread-a',
          projectId: 'p-autoops',
          environmentId: 'test',
          agentId: 'agent',
          visibility: 'private',
        }),
      }),
    )
    fetch
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValue({ ok: false, status: 403, json: async () => ({}) })
    await expect(
      prepareHostThreadLaunch({ threadId: 'thread-b', projectId: 'p-autoops' }),
    ).rejects.toThrow(/无法授权/)
  })
  it('inherits the authoritative source environment and agent with private audience before a plan launch', async () => {
    const host = await import('./hostConfig')
    const { prepareHostThreadLaunch } = await import('@t3tools/client-runtime/host-integration')
    const input = bootstrap()
    input.projects[0]!.environments.push({ id: 'production', name: '生产' })
    input.projects[0]!.agents.push({ id: 'release-agent', name: '发布 Agent' })
    host.installAutoOpsHost(input, 'https://work.test')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          binding: {
            projectId: 'p-autoops',
            environmentId: 'production',
            agentId: 'release-agent',
            visibility: 'project',
            ownerId: 'alice',
          },
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          binding: {
            projectId: 'p-autoops',
            environmentId: 'production',
            agentId: 'release-agent',
            visibility: 'private',
            scopeState: 'draft',
          },
        }),
      })
    vi.stubGlobal('fetch', fetch)
    await host.inheritAutoOpsThreadScope('source', 'derived', 'p-autoops')
    await prepareHostThreadLaunch({ threadId: 'derived', projectId: 'p-autoops' })
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/agent-demo/t3/autoops/thread-bindings/source')
    expect(JSON.parse(fetch.mock.calls[2]?.[1].body)).toEqual({
      threadId: 'derived',
      projectId: 'p-autoops',
      environmentId: 'production',
      agentId: 'release-agent',
      visibility: 'private',
    })
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        binding: {
          projectId: 'other',
          environmentId: 'production',
          agentId: 'release-agent',
          visibility: 'project',
        },
      }),
    })
    await expect(
      host.inheritAutoOpsThreadScope('other-source', 'rejected', 'p-autoops'),
    ).rejects.toThrow(/source/)
  })
  it('uses an external member default without falling back to internal or an unauthorized environment', async () => {
    const host = await import('./hostConfig')
    const input = bootstrap()
    input.projects[0]!.environments.push({ id: 'production', name: '生产' })
    host.installAutoOpsHost(
      {
        ...input,
        projects: input.projects.map((project) => ({
          ...project,
          membership: {
            workspaceAccess: 'external',
            role: 'member',
            environmentIds: ['production'],
          },
        })),
      },
      'https://work.test',
    )
    expect(host.readAutoOpsThreadScope('external', 'p-autoops')).toMatchObject({
      environmentId: 'production',
      workspaceType: 'external',
    })
    expect(host.readAutoOpsThreadScope('external', 'p-autoops')?.workspaceVersionId).toBeUndefined()
    expect(() =>
      host.setAutoOpsThreadScope('external', {
        projectId: 'p-autoops',
        environmentId: 'production',
        agentId: 'agent',
        visibility: 'private',
        workspaceType: 'internal',
        workspaceVersionId: 'raw',
      }),
    ).toThrow(/无权/)
  })
  it('reconciles an uncertain native acceptance before allowing another reservation', async () => {
    const host = await import('./hostConfig')
    host.installAutoOpsHost(bootstrap(), 'https://work.test')
    const original = {
      projectId: 'p-autoops',
      environmentId: 'test',
      agentId: 'agent',
      visibility: 'private' as const,
      workspaceType: 'internal' as const,
      workspaceVersionId: 'raw',
    }
    const fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ binding: { ...original, scopeState: 'locked', scopeLocked: true } }),
      })
    vi.stubGlobal('fetch', fetch)
    await expect(
      host.reserveAutoOpsThreadScope('accepted', { ...original, visibility: 'project' }),
    ).rejects.toThrow(/已被接受/)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(host.readKnownAutoOpsThreadScope('accepted')).toMatchObject({
      visibility: 'private',
      scopeLocked: true,
    })
    expect(() =>
      host.setAutoOpsThreadScope('accepted', {
        ...original,
        workspaceType: 'external',
        workspaceVersionId: 'redacted',
      }),
    ).toThrow(/固定/)
    await expect(host.reserveAutoOpsThreadScope('accepted', original)).resolves.toMatchObject({
      scopeLocked: true,
    })
    expect(fetch.mock.calls.every(([, options]) => options.method !== 'POST')).toBe(true)
  })
  it('keeps submitting reservations frozen and permits edits after a confirmed pre-acceptance failure', async () => {
    const host = await import('./hostConfig')
    host.installAutoOpsHost(bootstrap(), 'https://work.test')
    const original = {
      projectId: 'p-autoops',
      environmentId: 'test',
      agentId: 'agent',
      visibility: 'private' as const,
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          binding: { ...original, scopeState: 'submitting', scopeLocked: false },
        }),
      })
    vi.stubGlobal('fetch', fetch)
    await expect(host.reserveAutoOpsThreadScope('retry', original)).rejects.toThrow(/正在确认/)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(() =>
      host.setAutoOpsThreadScope('retry', { ...original, visibility: 'project' }),
    ).toThrow(/正在确认/)
    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ binding: { ...original, scopeState: 'draft', scopeLocked: false } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          binding: { ...original, visibility: 'project', scopeState: 'draft', scopeLocked: false },
        }),
      })
    await expect(
      host.reserveAutoOpsThreadScope('retry', { ...original, visibility: 'project' }),
    ).resolves.toMatchObject({ visibility: 'project', scopeLocked: false })
    expect(fetch.mock.calls[2]?.[1].method).toBe('POST')
  })
  it('does not write a reservation while the server status is unknown', async () => {
    const host = await import('./hostConfig')
    host.installAutoOpsHost(bootstrap(), 'https://work.test')
    const fetch = vi.fn().mockRejectedValue(new Error('network unavailable'))
    vi.stubGlobal('fetch', fetch)
    await expect(
      host.reserveAutoOpsThreadScope('unknown', {
        projectId: 'p-autoops',
        environmentId: 'test',
        agentId: 'agent',
        visibility: 'private',
      }),
    ).rejects.toThrow(/无法确认/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('unfreezes an uncertain local submission only after a definite missing reservation', async () => {
    const host = await import('./hostConfig')
    host.installAutoOpsHost(bootstrap(), 'https://work.test')
    const original = {
      projectId: 'p-autoops',
      environmentId: 'test',
      agentId: 'agent',
      visibility: 'private' as const,
    }
    host.setAutoOpsThreadScope('uncertain', {
      ...original,
      scopeState: 'submitting',
      scopeLocked: false,
    })
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
    vi.stubGlobal('fetch', fetch)
    await expect(host.findAutoOpsThreadScope('uncertain')).rejects.toThrow(/无法确认/)
    expect(host.readKnownAutoOpsThreadScope('uncertain')?.scopeState).toBe('submitting')
    expect(() =>
      host.setAutoOpsThreadScope('uncertain', { ...original, visibility: 'project' }),
    ).toThrow(/正在确认/)
    await expect(host.findAutoOpsThreadScope('uncertain')).resolves.toBeNull()
    expect(host.readKnownAutoOpsThreadScope('uncertain')).toMatchObject({
      scopeState: 'draft',
      scopeLocked: false,
    })
    expect(() =>
      host.setAutoOpsThreadScope('uncertain', { ...original, visibility: 'project' }),
    ).not.toThrow()
    host.setAutoOpsThreadScope('accepted', { ...original, scopeState: 'locked', scopeLocked: true })
    await expect(host.findAutoOpsThreadScope('accepted')).resolves.toBeNull()
    expect(host.readKnownAutoOpsThreadScope('accepted')).toMatchObject({
      scopeState: 'locked',
      scopeLocked: true,
    })
  })
})

describe('拆分后的会话范围请求生命周期', () => {
  const binding = {
    projectId: 'p-autoops',
    environmentId: 'test',
    agentId: 'agent',
    visibility: 'private' as const,
  }
  it('取消读取后忽略不遵守取消信号的迟到响应', async () => {
    const host = await import('./hostConfig')
    host.installAutoOpsHost(bootstrap(), 'https://work.test')
    let resolve!: (value: Response) => void
    const fetch = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const pending = host.findAutoOpsThreadScope('cancelled', controller.signal)
    controller.abort()
    resolve(Response.json({ binding }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(host.readKnownAutoOpsThreadScope('cancelled')).toBeUndefined()
    expect(fetch.mock.calls).toHaveLength(1)
  })
  it('登录令牌更新后旧响应不写入会话缓存', async () => {
    const host = await import('./hostConfig')
    host.installAutoOpsHost(bootstrap(), 'https://work.test')
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
    const pending = host.findAutoOpsThreadScope('old-login')
    host.installAutoOpsHost({ ...bootstrap(), csrfToken: 'new-session' }, 'https://work.test')
    resolve(Response.json({ binding }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(host.readKnownAutoOpsThreadScope('old-login')).toBeUndefined()
  })
  it('保留撤权状态码和错误码供调用方关闭旧操作入口', async () => {
    const host = await import('./hostConfig')
    host.installAutoOpsHost(bootstrap(), 'https://work.test')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { code: 'SCOPE_REVOKED', message: '会话权限已撤销' } },
          { status: 403 },
        ),
      ),
    )
    await expect(host.findAutoOpsThreadScope('revoked')).rejects.toMatchObject({
      status: 403,
      code: 'SCOPE_REVOKED',
    })
    expect(host.readKnownAutoOpsThreadScope('revoked')).toBeUndefined()
  })
  it('预约写入结果未知时保留未知语义，下次先核对已锁定收据而不重复写入', async () => {
    const host = await import('./hostConfig')
    host.installAutoOpsHost(bootstrap(), 'https://work.test')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(
        Response.json({ binding: { ...binding, scopeState: 'locked', scopeLocked: true } }),
      )
    vi.stubGlobal('fetch', fetch)
    await expect(host.reserveAutoOpsThreadScope('uncertain-post', binding)).rejects.toMatchObject({
      uncertain: true,
      code: 'CONNECTION_FAILED',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    await expect(host.reserveAutoOpsThreadScope('uncertain-post', binding)).resolves.toMatchObject({
      scopeLocked: true,
    })
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
  })
})

it('异常会话收据不能当作缺失预约，异常写入回执保留未知状态', async () => {
  const host = await import('./hostConfig')
  host.installAutoOpsHost(bootstrap(), 'https://work.test')
  const binding = {
    projectId: 'p-autoops',
    environmentId: 'test',
    agentId: 'agent',
    visibility: 'private' as const,
  }
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({}))
  vi.stubGlobal('fetch', fetch)
  await expect(host.reserveAutoOpsThreadScope('malformed-read', binding)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    uncertain: false,
  })
  expect(fetch).toHaveBeenCalledTimes(1)
  fetch
    .mockResolvedValueOnce(Response.json({}, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ binding: {} }))
  await expect(host.reserveAutoOpsThreadScope('malformed-write', binding)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    uncertain: true,
  })
  expect(host.readKnownAutoOpsThreadScope('malformed-write')).toBeUndefined()
})
