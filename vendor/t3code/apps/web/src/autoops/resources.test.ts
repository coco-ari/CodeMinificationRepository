import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
afterEach(() => vi.resetModules())
describe('authorized business resource transport', () => {
  it('maps only same-origin allowed resources and preserves the preview id through reload', async () => {
    const { installAutoOpsHost } = await import('./hostConfig')
    installAutoOpsHost(
      {
        principal: { id: 'test', displayName: 'Test' },
        gatewayBasePath: '/api/agent-demo/t3',
        csrfToken: 'x',
        projects: [],
        capabilities: {},
        fixedModel: { instanceId: 'codex', model: 'configured-model' },
        runtimeMode: 'approval-required',
      },
      'https://work.test',
    )
    const { autoOpsResourceUrl, autoOpsResourceAttachmentId, autoOpsResourceFromAttachmentId } =
      await import('./resources')
    expect(autoOpsResourceUrl('/api/agent-demo/projects/p-autoops/documents/doc-1')).toBe(
      '/api/agent-demo/t3/autoops/projects/p-autoops/documents/doc-1',
    )
    const path = '/api/agent-demo/t3/autoops/files/report-1'
    expect(autoOpsResourceFromAttachmentId(autoOpsResourceAttachmentId(path))).toBe(path)
    for (const invalid of [
      'https://outside.test' + path,
      '/api/agent-demo/t3/autoops/files/../secret',
      '/etc/passwd',
      path + '?redirect=outside',
      path + '/%2e%2e',
    ]) {
      expect(autoOpsResourceUrl(invalid)).toBeNull()
    }
  })
})

it('preserves authorized identities in native mentions and preview URLs without granting filesystem access', async () => {
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(
    {
      principal: { id: 'resource-test', displayName: 'Test' },
      gatewayBasePath: '/api/agent-demo/t3',
      csrfToken: 'x',
      projects: [
        {
          id: 'p-autoops',
          name: 'AutoOps',
          environments: [{ id: 'test', name: 'Test' }],
          agents: [{ id: 'agent', name: 'Agent' }],
        },
      ],
      capabilities: {},
      fixedModel: { instanceId: 'codex', model: 'fixed' },
      runtimeMode: 'approval-required',
    },
    'https://work.test',
  )
  const {
    autoOpsResourceCwd,
    isAutoOpsResourceCwd,
    autoOpsResourceUrl,
    autoOpsResourceRequestUrl,
    autoOpsResourceAttachmentId,
    autoOpsResourceFromAttachmentId,
  } = await import('./resources')
  const cwd = autoOpsResourceCwd('thread-1', 'p-autoops')
  expect(isAutoOpsResourceCwd(cwd)).toBe(true)
  expect(isAutoOpsResourceCwd('/srv/private')).toBe(false)
  const path = 'autoops/p-autoops/documents/doc-1/0123456789abcdef/运行手册.md'
  const url = autoOpsResourceUrl(path)!
  expect(new URL(url, 'https://work.test').searchParams.get('path')).toBe(path)
  expect(autoOpsResourceFromAttachmentId(autoOpsResourceAttachmentId(url))).toBe(url)
  expect(
    new URL(autoOpsResourceRequestUrl(url, 'inline'), 'https://work.test').searchParams.get('path'),
  ).toBe(path)
  expect(autoOpsResourceUrl('autoops/p-autoops/documents/../../secret')).toBeNull()
})
