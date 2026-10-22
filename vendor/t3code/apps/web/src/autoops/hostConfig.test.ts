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
    const fetch = vi.fn().mockResolvedValue({ ok: true })
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
    fetch.mockResolvedValue({ ok: false, status: 403 })
    await expect(
      prepareHostThreadLaunch({ threadId: 'thread-b', projectId: 'p-autoops' }),
    ).rejects.toThrow(/authorized/)
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
      .mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetch)
    await host.inheritAutoOpsThreadScope('source', 'derived', 'p-autoops')
    await prepareHostThreadLaunch({ threadId: 'derived', projectId: 'p-autoops' })
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/agent-demo/t3/autoops/thread-bindings/source')
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual({
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
})
