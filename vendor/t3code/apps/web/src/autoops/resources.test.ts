import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
afterEach(() => vi.resetModules())

it('completes only directories inside the selected fixed workspace version', async () => {
  const { autoOpsWorkspaceDirectoryCompletion } = await import('./resources')
  const scope = {
    projectId: 'p-autoops',
    workspaceType: 'internal' as const,
    workspaceVersionId: 'version-1',
  }
  const prefix = 'autoops/p-autoops/workspaces/version-1/'
  expect(autoOpsWorkspaceDirectoryCompletion(prefix + 'frontend/src', scope)).toBe('@frontend/src/')
  expect(autoOpsWorkspaceDirectoryCompletion(prefix + '需求 文档', scope)).toBe('@"需求 文档/')
  expect(autoOpsWorkspaceDirectoryCompletion(prefix + '文档/含"引号', scope)).toBe(
    '@"文档/含\\"引号/',
  )
  for (const path of [
    'frontend',
    'autoops/p-autoops/workspaces/version-10/frontend',
    'autoops/other-project/workspaces/version-1/frontend',
    'autoops/p-autoops/documents/doc-1',
    'autoops/p-autoops/threads/thread-1/reports',
    prefix,
    prefix + '../frontend',
    prefix + 'frontend//src',
    prefix + 'frontend/./src',
    prefix + 'front\\end',
    ...['\n', '\r', '\t', '\0', '\u007f', '\u0085', '\u2028', '\u2029'].map(
      (control) => prefix + '目录' + control + '资料',
    ),
  ])
    expect(autoOpsWorkspaceDirectoryCompletion(path, scope)).toBeNull()
  expect(autoOpsWorkspaceDirectoryCompletion(prefix + 'frontend', undefined)).toBeNull()
  expect(
    autoOpsWorkspaceDirectoryCompletion(prefix + 'frontend', { projectId: scope.projectId }),
  ).toBeNull()
  expect(
    autoOpsWorkspaceDirectoryCompletion(prefix + 'frontend', {
      ...scope,
      workspaceType: 'external',
    }),
  ).toBe('@frontend/')
})

it('shows workspace-relative candidate directories without changing resource identities', async () => {
  const { autoOpsResourcePathDescription } = await import('./resources')
  const scope = { projectId: 'p-autoops', workspaceVersionId: 'version-1' }
  const canonicalPath = 'autoops/p-autoops/workspaces/version-1/frontend/src/App.tsx'
  expect(autoOpsResourcePathDescription(canonicalPath, scope)).toBe('frontend/src')
  expect(canonicalPath).toBe('autoops/p-autoops/workspaces/version-1/frontend/src/App.tsx')
  expect(
    autoOpsResourcePathDescription('autoops/p-autoops/workspaces/version-1/README.md', scope),
  ).toBe('')
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
  installAutoOpsHost(
    {
      principal: { id: 'fixed-cwd-test', displayName: 'Test' },
      gatewayBasePath: '/api/agent-demo/t3',
      csrfToken: 'x',
      projects: [],
      capabilities: {},
      fixedModel: { instanceId: 'codex', model: 'test' },
      runtimeMode: 'approval-required',
    },
    'https://work.test',
  )
  const { isAutoOpsWorkspaceResourceCwd } = await import('./resources')
  const base = 'autoops://projects/p-autoops/environments/env-test/threads/thread-1'
  expect(
    isAutoOpsWorkspaceResourceCwd(base + '?workspaceType=internal&workspaceVersionId=version-1'),
  ).toBe(true)
  expect(
    isAutoOpsWorkspaceResourceCwd(base + '?workspaceType=external&workspaceVersionId=version-2'),
  ).toBe(true)
  expect(isAutoOpsWorkspaceResourceCwd(base + '?workspaceType=internal')).toBe(true)
  expect(isAutoOpsWorkspaceResourceCwd(base + '?workspaceType=external&inputId=input-1')).toBe(true)
  for (const cwd of [
    base,
    null,
    '/repo',
    base + '?workspaceType=internal&inputId=bad/id',
    base + '?workspaceVersionId=version-1',
    base + '?workspaceType=internal&workspaceVersionId=version-1&extra=x',
  ]) {
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

it('日常目录使用当前范围，显式历史引用才使用原绑定版本', async () => {
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(
    {
      principal: { id: 'cwd-scope-test', displayName: 'Test' },
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
  const { autoOpsResourceCwd } = await import('./resources')
  const initialCwd = autoOpsResourceCwd('thread-1', 'p-autoops')!
  expect(new URL(initialCwd).searchParams.get('workspaceType')).toBe('internal')
  expect(new URL(initialCwd).searchParams.has('workspaceVersionId')).toBe(false)
  const scope = {
    projectId: 'p-autoops',
    environmentId: 'test',
    agentId: 'agent',
    visibility: 'private' as const,
    workspaceType: 'external' as const,
    workspaceVersionId: 'version-1',
  }
  const updatedCwd = new URL(autoOpsResourceCwd('thread-1', 'p-autoops', scope)!)
  expect(updatedCwd.searchParams.get('workspaceType')).toBe('external')
  expect(updatedCwd.searchParams.has('workspaceVersionId')).toBe(false)
  const historyCwd = new URL(autoOpsResourceCwd('thread-1', 'p-autoops', scope, 'version-1')!)
  expect(historyCwd.searchParams.get('workspaceVersionId')).toBe('version-1')
  expect(autoOpsResourceCwd('thread-1', 'p-autoops', scope, 'version-2')).toBeNull()
  // 切换到客户执行目标后，旧的平台资料选择不能继续开放访问。
  expect(
    autoOpsResourceCwd('thread-1', 'p-autoops', {
      ...scope,
      executionBinding: {
        kind: 'customer',
        deviceId: 'device-one',
        registeredWorkspaceId: 'workspace-one',
        workspaceBindingRevision: 1,
        runtimeId: 'codex',
      },
    }),
  ).toBeNull()
})

it('uses only scoped skill package URLs and preserves reference resource identities', async () => {
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(
    {
      principal: { id: 'skill-url', displayName: 'Test' },
      gatewayBasePath: '/api/agent-demo/t3',
      csrfToken: 'x',
      projects: [],
      capabilities: {},
      fixedModel: { instanceId: 'codex', model: 'test' },
      runtimeMode: 'approval-required',
    },
    'https://work.test',
  )
  const { autoOpsResourceUrl, autoOpsResourceRequestUrl } = await import('./resources')
  const path =
    '/api/agent-demo/t3/autoops/skill-library/contexts/' + 'a'.repeat(64) + '/files/autoops-sample'
  expect(autoOpsResourceUrl(path + '?path=references%2Fcheck.md')).toBe(
    path + '?path=references%2Fcheck.md',
  )
  expect(autoOpsResourceRequestUrl(path + '?path=SKILL.md', 'metadata')).toBe(
    path + '?path=SKILL.md&metadata=1',
  )
  for (const invalid of [
    path,
    path + '?path=../secret',
    path + '?path=%2Fetc%2Fpasswd',
    path + '?path=references%5Ccheck.md',
    path + '?path=SKILL.md&path=other',
    path + '?path=SKILL.md&other=x',
    '/api/agent-demo/t3/autoops/skills/autoops-sample',
  ])
    expect(autoOpsResourceUrl(invalid)).toBeNull()
})

it('resolves draft skill preview references within the same snapshot and package', async () => {
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(
    {
      principal: { id: 'skill-links', displayName: 'Test' },
      gatewayBasePath: '/api/agent-demo/t3',
      csrfToken: 'x',
      projects: [],
      capabilities: {},
      fixedModel: { instanceId: 'codex', model: 'test' },
      runtimeMode: 'approval-required',
    },
    'https://work.test',
  )
  const { autoOpsSkillResourceLink, autoOpsResourceAttachmentId, autoOpsResourceFromAttachmentId } =
    await import('./resources')
  const packageUrl =
    '/api/agent-demo/t3/autoops/skill-library/contexts/' + 'b'.repeat(64) + '/files/autoops-example'
  const source = packageUrl + '?path=SKILL.md'
  const restored = autoOpsResourceFromAttachmentId(autoOpsResourceAttachmentId(source))
  expect(
    autoOpsSkillResourceLink(restored, 'references/%E8%B5%84%E6%96%99%20%E6%96%87%E4%BB%B6.md'),
  ).toEqual({
    url: packageUrl + '?path=references%2F%E8%B5%84%E6%96%99%20%E6%96%87%E4%BB%B6.md',
    path: 'references/资料 文件.md',
  })
  expect(
    autoOpsSkillResourceLink(
      packageUrl + '?path=references%2Fnested%2Fdetail.md',
      '../../SKILL.md#header',
    ),
  ).toEqual({ url: source, path: 'SKILL.md' })
  expect(
    autoOpsSkillResourceLink(
      packageUrl + '?path=references%2Fnested%2Fdetail.md',
      '../other.md?download=1',
    ),
  ).toEqual({ url: packageUrl + '?path=references%2Fother.md', path: 'references/other.md' })
  for (const href of [
    '../SKILL.md',
    '%2E%2E/secret.md',
    '/autoops/other/secret.md',
    'references/%00hidden.md',
    'references/%not-valid',
    'references\\secret.md',
    'references/../../outside.md',
  ]) {
    expect(autoOpsSkillResourceLink(source, href)).toHaveProperty('error')
  }
  // Complete authorized-resource identities continue through ChatMarkdown and
  // its server-checked native opener, rather than being treated as relative paths.
  for (const href of [
    source,
    packageUrl + '?path=references%2Fcheck.md',
    packageUrl.replace('b'.repeat(64), 'c'.repeat(64)) + '?path=SKILL.md',
    '/api/agent-demo/t3/autoops/files/report-1',
  ]) {
    expect(autoOpsSkillResourceLink(source, href)).toBeNull()
  }
  for (const href of ['#section', 'https://example.com/reference', '//example.com/reference', ''])
    expect(autoOpsSkillResourceLink(source, href)).toBeNull()
  for (const ordinary of [
    '/api/agent-demo/t3/autoops/attachments/file-1',
    '/api/agent-demo/t3/autoops/files/report-1',
    null,
  ]) {
    expect(autoOpsSkillResourceLink(ordinary, 'references/check.md')).toBeNull()
  }
})
