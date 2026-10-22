import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
afterEach(() => vi.resetModules())

it('completes only directories inside the selected fixed workspace version', async () => {
  const { autoOpsWorkspaceDirectoryCompletion } = await import('./resources')
  const scope = { projectId: 'p-autoops', workspaceType: 'internal' as const, workspaceVersionId: 'version-1' }
  const prefix = 'autoops/p-autoops/workspaces/version-1/'
  expect(autoOpsWorkspaceDirectoryCompletion(prefix + 'frontend/src', scope)).toBe('@frontend/src/')
  expect(autoOpsWorkspaceDirectoryCompletion(prefix + '需求 文档', scope)).toBe('@"需求 文档/')
  expect(autoOpsWorkspaceDirectoryCompletion(prefix + '文档/含"引号', scope)).toBe('@"文档/含\\"引号/')
  for (const path of [
    'frontend',
    'autoops/p-autoops/workspaces/version-10/frontend',
    'autoops/other-project/workspaces/version-1/frontend',
    'autoops/p-autoops/documents/doc-1',
    'autoops/p-autoops/threads/thread-1/reports',
    prefix, prefix + '../frontend', prefix + 'frontend//src', prefix + 'frontend/./src', prefix + 'front\\end',
    ...['\n', '\r', '\t', '\0', '\u007f', '\u0085', '\u2028', '\u2029'].map((control) => prefix + '目录' + control + '资料'),
  ]) expect(autoOpsWorkspaceDirectoryCompletion(path, scope)).toBeNull()
  expect(autoOpsWorkspaceDirectoryCompletion(prefix + 'frontend', undefined)).toBeNull()
  expect(autoOpsWorkspaceDirectoryCompletion(prefix + 'frontend', { projectId: scope.projectId })).toBeNull()
  expect(autoOpsWorkspaceDirectoryCompletion(prefix + 'frontend', { ...scope, workspaceType: 'external' })).toBe('@frontend/')
})

it('shows workspace-relative candidate directories without changing resource identities', async () => {
  const { autoOpsResourcePathDescription } = await import('./resources')
  const scope = { projectId: 'p-autoops', workspaceVersionId: 'version-1' }
  const canonicalPath = 'autoops/p-autoops/workspaces/version-1/frontend/src/App.tsx'
  expect(autoOpsResourcePathDescription(canonicalPath, scope)).toBe('frontend/src')
  expect(canonicalPath).toBe('autoops/p-autoops/workspaces/version-1/frontend/src/App.tsx')
  expect(autoOpsResourcePathDescription('autoops/p-autoops/workspaces/version-1/README.md', scope)).toBe('')
  for (const path of [
    'autoops/other-project/workspaces/version-1/frontend/App.tsx',
    'autoops/p-autoops/workspaces/version-10/frontend/App.tsx',
    'autoops/p-autoops/documents/doc-1/README.md',
    'frontend/src/App.tsx',
  ]) {
    expect(autoOpsResourcePathDescription(path, scope)).toBe(path.slice(0, path.lastIndexOf('/')))
  }
  expect(autoOpsResourcePathDescription(canonicalPath, undefined)).toBe(
    'autoops/p-autoops/workspaces/version-1/frontend/src',
  )
})

it('recognizes fixed workspace browsing independently of legacy business resource paths', async () => {
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost({
    principal: { id: 'fixed-cwd-test', displayName: 'Test' }, gatewayBasePath: '/api/agent-demo/t3', csrfToken: 'x',
    projects: [], capabilities: {}, fixedModel: { instanceId: 'codex', model: 'test' }, runtimeMode: 'approval-required',
  }, 'https://work.test')
  const { isAutoOpsWorkspaceResourceCwd } = await import('./resources')
  const base = 'autoops://projects/p-autoops/environments/env-test/threads/thread-1'
  expect(isAutoOpsWorkspaceResourceCwd(base + '?workspaceType=internal&workspaceVersionId=version-1')).toBe(true)
  expect(isAutoOpsWorkspaceResourceCwd(base + '?workspaceType=external&workspaceVersionId=version-2')).toBe(true)
  for (const cwd of [base, null, '/repo', base + '?workspaceType=internal', base + '?workspaceVersionId=version-1', base + '?workspaceType=internal&workspaceVersionId=version-1&extra=x']) {
    expect(isAutoOpsWorkspaceResourceCwd(cwd)).toBe(false)
  }
})
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

it('uses the explicit subscribed scope when a workspace version arrives after the initial cwd', async () => {
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(
    {
      principal: { id: 'cwd-scope-test', displayName: 'Test' },
      gatewayBasePath: '/api/agent-demo/t3',
      csrfToken: 'x',
      projects: [{
        id: 'p-autoops', name: 'AutoOps',
        environments: [{ id: 'test', name: 'Test' }],
        agents: [{ id: 'agent', name: 'Agent' }],
      }],
      capabilities: {},
      fixedModel: { instanceId: 'codex', model: 'fixed' },
      runtimeMode: 'approval-required',
    },
    'https://work.test',
  )
  const { autoOpsResourceCwd } = await import('./resources')
  const initialCwd = autoOpsResourceCwd('thread-1', 'p-autoops')!
  expect(new URL(initialCwd).search).toBe('')
  const scope = {
    projectId: 'p-autoops', environmentId: 'test', agentId: 'agent', visibility: 'private' as const,
    workspaceType: 'external' as const, workspaceVersionId: 'version-1',
  }
  const updatedCwd = new URL(autoOpsResourceCwd('thread-1', 'p-autoops', scope)!)
  expect(updatedCwd.searchParams.get('workspaceType')).toBe('external')
  expect(updatedCwd.searchParams.get('workspaceVersionId')).toBe('version-1')
  const nextCwd = new URL(autoOpsResourceCwd('thread-1', 'p-autoops', {
    ...scope, workspaceVersionId: 'version-2',
  })!)
  expect(nextCwd.searchParams.get('workspaceVersionId')).toBe('version-2')
})
