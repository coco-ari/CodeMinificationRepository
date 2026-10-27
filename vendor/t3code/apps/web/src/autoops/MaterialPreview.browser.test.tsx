import { useRef, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { scopeThreadRef } from '@t3tools/client-runtime/environment'
import { render } from '../../test/render'
import type { FilePreviewPanelProps } from '~/components/files/FilePreviewPanel'
import AutoOpsMaterialPreview from './MaterialPreview'
import type { AutoOpsThreadScope } from './hostConfig'
import { ComposerHandleContext } from '~/composerHandleContext'
import type { ChatComposerHandle } from '~/components/chat/ChatComposer'
import { ReadOnlyWorkspaceFiles } from '~/components/files/ReadOnlyWorkspaceFiles'
import ChatMarkdown from '~/components/ChatMarkdown'
import { selectThreadRightPanelState, useRightPanelStore } from '~/rightPanelStore'
import '../index.css'

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  execute: vi.fn(),
  list: vi.fn(),
  search: vi.fn(),
  realFiles: false,
}))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: () => ({
    principal: { id: 'preview-user', displayName: '预览测试' },
    httpBaseUrl: 'http://preview.test',
    wsBaseUrl: 'ws://preview.test',
    gatewayBasePath: '/gateway',
    projects: [],
    capabilities: {},
    fixedModel: { instanceId: 'test', model: 'test' },
    runtimeMode: 'approval-required' as const,
    csrfToken: 'test',
  }),
  readAutoOpsThreadScope: mocks.scope,
}))
vi.mock(import('./hostSnapshot'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: () => ({
    principal: { id: 'preview-user', displayName: '预览测试' },
    httpBaseUrl: 'http://preview.test',
    wsBaseUrl: 'ws://preview.test',
    gatewayBasePath: '/gateway',
    csrfToken: 'test',
    projects: [],
    capabilities: {},
    fixedModel: { instanceId: 'test', model: 'test' },
    runtimeMode: 'approval-required' as const,
  }),
}))
vi.mock(import('./useThreadScope'), () => ({ useAutoOpsThreadScope: mocks.scope }))
vi.mock(import('./CustomerFilePanel'), () => ({
  CustomerFilePanel: ({ relativePath }: FilePreviewPanelProps) => (
    <section aria-label="客户文件合同">{relativePath ?? '电脑目录'}</section>
  ),
  // 当前用例只验证平台引用，不挂载客户文件来源或读取客户目录。
  CustomerFileLink: () => <></>,
}))
vi.mock(import('@t3tools/client-runtime/state/runtime'), async (original) => ({
  ...(await original()),
  executeAtomQuery: mocks.execute,
}))
vi.mock(import('../state/projects'), async (original) => {
  const value = await original()
  return {
    ...value,
    projectEnvironment: {
      ...value.projectEnvironment,
      listEntries: mocks.list,
      searchEntries: mocks.search,
    },
  }
})
vi.mock(import('../components/files/FilePreviewPanel'), () => ({
  default: function NativeFileContract(props: FilePreviewPanelProps) {
    const { readOnlySource, cwd, relativePath, attachment } = props
    const [results, setResults] = useState('')
    if (mocks.realFiles && readOnlySource)
      return <ReadOnlyWorkspaceFiles {...props} source={readOnlySource} />
    return (
      <section aria-label="原生预览合同">
        <output>{cwd}</output>
        <p>{attachment?.name ?? relativePath}</p>
        <button
          onClick={() =>
            void readOnlySource
              ?.search('read', 20)
              .then((value) => setResults(value.entries.map((entry) => entry.path).join(',')))
          }
        >
          搜索文件
        </button>
        <p>{results}</p>
      </section>
    )
  },
}))
const environmentId = EnvironmentId.make('preview-environment')
const threadRef = scopeThreadRef(environmentId, ThreadId.make('preview-thread'))
const base = 'autoops://projects/p-one/environments/env-test/threads/preview-thread'
function scope(type: 'internal' | 'external' = 'internal'): AutoOpsThreadScope {
  return {
    projectId: 'p-one',
    environmentId: 'env-test',
    agentId: 'agent',
    visibility: 'private',
    workspaceType: type,
  }
}
function props(path: string | null = null): FilePreviewPanelProps {
  return {
    environmentId,
    threadRef,
    composerDraftTarget: threadRef,
    cwd: base + '?workspaceType=internal',
    projectName: '测试',
    relativePath: path,
    folderTrail: undefined,
    keybindings: {} as FilePreviewPanelProps['keybindings'],
    availableEditors: [],
    openInShortcutEnabled: false,
    revealLine: null,
    revealRequestId: 0,
    onOpenFile: vi.fn(),
    onNavigateFolder: vi.fn(),
    onPendingChange: vi.fn(),
    selectedFilePending: false,
    workspaceMutationId: null,
  }
}
const result = (inputId: string) => ({
  _tag: 'Success',
  value: {
    entries: [
      { path: `autoops/p-one/inputs/${inputId}/README.md`, name: 'README.md', kind: 'file' },
    ],
    truncated: false,
  },
})
function currentReference(
  inputId = 'old-input',
  workspaceType: 'internal' | 'external' = 'internal',
) {
  return {
    projectId: 'p-one',
    threadId: 'preview-thread',
    viewerThreadId: 'preview-thread',
    workspaceType,
    originalInputId: inputId,
    originalPath: 'README.md',
    currentPath: 'README.md',
    mode: 'current' as const,
    resourcePath: `autoops/p-one/current-input-files/preview-thread/${inputId}/current-revision/README.md`,
    revision: 'current-revision',
    sha256: 'b'.repeat(64),
    changed: true,
  }
}
function clickButton(element: Element) {
  if (!(element instanceof HTMLButtonElement)) throw new Error('此动作必须由真实按钮提供')
  element.click()
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.realFiles = false
  mocks.scope.mockReturnValue(scope())
  mocks.list.mockImplementation((input) => input)
  mocks.search.mockImplementation((input) => input)
})
describe('当前对话文件预览的输入和范围边界', () => {
  it('回收后的当前文件仍能用原生动作添加到待发问题并保留正文', async () => {
    mocks.realFiles = true
    const originalPath = 'autoops/p-one/inputs/old-input/README.md'
    const currentPath =
      'autoops/p-one/current-input-files/preview-thread/old-input/current-revision/README.md'
    const currentText = 'CURRENT-MATERIAL-705'
    const originalPanels = useRightPanelStore.getState().byThreadKey
    using _panels = {
      [Symbol.dispose]: () => useRightPanelStore.setState({ byThreadKey: originalPanels }),
    }
    useRightPanelStore.setState({ byThreadKey: {} })
    mocks.execute.mockResolvedValue(result('picker-current'))
    using fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname === '/gateway/api/v1/projects/p-one/workspace/file-reference')
        return Response.json({
          projectId: 'p-one',
          threadId: 'preview-thread',
          viewerThreadId: 'preview-thread',
          workspaceType: 'internal',
          originalInputId: 'old-input',
          originalPath: 'README.md',
          currentPath: 'README.md',
          mode: 'current',
          resourcePath: currentPath,
          revision: 'current-revision',
          sha256: 'b'.repeat(64),
          changed: true,
        })
      if (
        url.pathname === '/gateway/autoops/resources' &&
        url.searchParams.get('path') === currentPath
      ) {
        if (url.searchParams.get('metadata') === '1')
          return Response.json({ name: 'README.md', mime: 'text/plain', size: currentText.length })
        if (url.searchParams.get('inline') === '1')
          return new Response(currentText, { headers: { 'content-type': 'text/plain' } })
      }
      throw new Error('此测试不允许其他请求')
    })
    function Draft() {
      const [text, setText] = useState('请读取 ')
      const panel = useRightPanelStore((state) =>
        selectThreadRightPanelState(state.byThreadKey, threadRef),
      )
      const surface = panel.surfaces.find((value) => value.id === panel.activeSurfaceId)
      const path = surface?.kind === 'file' ? surface.relativePath : originalPath
      const handle = useRef({
        insertTextAtEnd: (value: string) => {
          setText((previous) => previous + value)
          return true
        },
      } as ChatComposerHandle)
      return (
        <ComposerHandleContext value={handle}>
          <textarea
            aria-label="待发问题"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <section aria-label="已添加的文件标签">
            <ChatMarkdown cwd={undefined} text={text} threadRef={threadRef} />
          </section>
          <div style={{ display: 'flex', width: 900, height: 480 }}>
            <AutoOpsMaterialPreview {...props(path)} />
          </div>
        </ComposerHandleContext>
      )
    }
    // 保留真实文件工具栏和输入动作；本用例不依赖应用路由。
    await using screen = await render(<Draft />, { router: false })
    await expect.element(screen.getByText('当前文件已更新', { exact: true })).toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '添加到对话', exact: true }))
      .toBeVisible()
    clickButton(screen.getByRole('button', { name: '添加到对话', exact: true }).element())
    await expect
      .element(screen.getByRole('textbox', { name: '待发问题' }))
      .toHaveValue(expect.stringContaining(currentPath))
    await vi.waitFor(() => {
      const renderedText =
        screen.container.textContent +
        [...screen.container.querySelectorAll('diffs-container')]
          .map((element) => element.shadowRoot?.textContent ?? '')
          .join('')
      expect(renderedText).toContain(currentText)
    })
    expect(
      fetcher.mock.calls.some(
        ([input]) => new URL(String(input), location.origin).searchParams.get('inline') === '1',
      ),
    ).toBe(true)
    const labels = screen.getByRole('region', { name: '已添加的文件标签' })
    const link = labels.getByRole('link', { name: 'README.md', exact: true }).element()
    expect(labels.element().textContent).not.toContain('current-input-files')
    expect(labels.element().textContent).not.toContain('current-revision')
    if (!(link instanceof HTMLAnchorElement)) throw new Error('文件标签必须沿原生链接打开')
    link.click()
    await vi.waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([input]) =>
          new URL(String(input), location.origin).pathname.endsWith('/workspace/file-reference'),
        ),
      ).toHaveLength(2),
    )
    await expect
      .element(screen.getByRole('button', { name: '添加到对话', exact: true }))
      .toBeVisible()
    await expect.element(screen.getByRole('alert')).not.toBeInTheDocument()
  })
  it('重开当前别名时保留来源线程并传入实际查看者，不泄露内部目录', async () => {
    const reference = {
      ...currentReference(),
      threadId: 'source-thread',
      resourcePath:
        'autoops/p-one/current-input-files/source-thread/old-input/current-revision/README.md',
    }
    mocks.execute.mockResolvedValue(result('picker-current'))
    using fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname.endsWith('/workspace/file-reference')) return Response.json(reference)
      if (url.pathname === '/gateway/autoops/resources')
        return Response.json({ name: 'README.md', mime: 'text/plain', size: 12 })
      throw new Error('此测试不允许其他请求')
    })
    // 原别名属于来源线程，当前面板仍使用实际查看者的范围。
    await using screen = await render(
      <AutoOpsMaterialPreview {...props(reference.resourcePath)} />,
      { router: false },
    )
    await expect.element(screen.getByRole('region', { name: '原生预览合同' })).toBeVisible()
    const request = new URL(String(fetcher.mock.calls[0]![0]), location.origin)
    expect(request.searchParams.get('threadId')).toBe('source-thread')
    expect(request.searchParams.get('viewerThreadId')).toBe('preview-thread')
    expect(screen.container.textContent).not.toContain('current-input-files')
  })
  it('更新并回收后重开原文件标签，自动预览当前文件并提示实际更新', async () => {
    const originalPath = 'autoops/p-one/inputs/old-input/README.md'
    const currentPath =
      'autoops/p-one/current-input-files/preview-thread/old-input/current-revision/README.md'
    let released = false
    mocks.execute.mockImplementation(async (_registry, query) => {
      if (released && query.input.cwd.includes('inputId=old-input'))
        throw new Error('原资料已更新或清理，不能改读最新内容')
      return result(released ? 'picker-current' : 'old-input')
    })
    using fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname === '/gateway/api/v1/projects/p-one/workspace/file-reference') {
        return Response.json({
          projectId: 'p-one',
          threadId: 'preview-thread',
          viewerThreadId: 'preview-thread',
          workspaceType: 'internal',
          originalInputId: 'old-input',
          originalPath: 'README.md',
          currentPath: 'README.md',
          mode: released ? 'current' : 'original',
          resourcePath: released ? currentPath : originalPath,
          revision: released ? 'current-revision' : 'old-revision',
          sha256: (released ? 'b' : 'a').repeat(64),
          changed: released,
        })
      }
      if (
        url.pathname === '/gateway/autoops/resources' &&
        url.searchParams.get('path') === currentPath &&
        url.searchParams.get('metadata') === '1'
      )
        return Response.json({ name: 'README.md', mime: 'text/plain', size: 12 })
      throw new Error('此测试不允许其他请求')
    })
    // 原生预览合同不依赖路由状态，连续重开保留同一原消息路径。
    await using screen = await render(<AutoOpsMaterialPreview {...props(originalPath)} />, {
      router: false,
    })
    await expect.element(screen.getByRole('region', { name: '原生预览合同' })).toBeVisible()
    expect(screen.container.textContent).toContain('&inputId=old-input')
    await screen.rerender(<span>预览已关闭</span>)
    released = true
    await screen.rerender(<AutoOpsMaterialPreview {...props(originalPath)} />)
    await expect.element(screen.getByText('当前文件已更新', { exact: true })).toBeVisible()
    await expect.element(screen.getByRole('region', { name: '原生预览合同' })).toBeVisible()
    await expect.element(screen.getByText('README.md', { exact: true })).toBeVisible()
    expect(
      fetcher.mock.calls.some(
        ([input]) =>
          new URL(String(input), location.origin).searchParams.get('path') === currentPath,
      ),
    ).toBe(true)
  })
  it('回收但版本未变时标明当前文件，不虚报已更新', async () => {
    const reference = { ...currentReference(), changed: false }
    mocks.execute.mockResolvedValue(result('picker-current'))
    using _fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname.endsWith('/workspace/file-reference')) return Response.json(reference)
      if (
        url.pathname === '/gateway/autoops/resources' &&
        url.searchParams.get('path') === reference.resourcePath
      )
        return Response.json({ name: 'README.md', mime: 'text/plain', size: 12 })
      throw new Error('此测试不允许其他请求')
    })
    // 本用例只验证原生预览的数据与状态，不依赖应用路由。
    await using screen = await render(
      <AutoOpsMaterialPreview {...props('autoops/p-one/inputs/old-input/README.md')} />,
      { router: false },
    )
    await expect.element(screen.getByText('当前文件', { exact: true })).toBeVisible()
    await expect.element(screen.getByRole('region', { name: '原生预览合同' })).toBeVisible()
    expect(screen.container.textContent).not.toContain('当前文件已更新')
  })
  it('稳定文件改名后按服务端当前路径打开，不把旧名称当作原件', async () => {
    const reference = { ...currentReference(), currentPath: '说明.md' }
    mocks.execute.mockResolvedValue(result('picker-current'))
    using _fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname.endsWith('/workspace/file-reference')) return Response.json(reference)
      if (
        url.pathname === '/gateway/autoops/resources' &&
        url.searchParams.get('path') === reference.resourcePath
      )
        return Response.json({ name: '说明.md', mime: 'text/plain', size: 12 })
      throw new Error('此测试不允许其他请求')
    })
    // 原标签路径不变，只展示所有者核实后的当前路径。
    await using screen = await render(
      <AutoOpsMaterialPreview {...props('autoops/p-one/inputs/old-input/README.md')} />,
      { router: false },
    )
    await expect.element(screen.getByText('当前文件已更新', { exact: true })).toBeVisible()
    await expect.element(screen.getByText('说明.md', { exact: true })).toBeVisible()
  })
  it.each([
    [410, 'WORKSPACE_REFERENCE_FILE_REMOVED', '当前资料已无此文件，可能已删除或改名'],
    [409, 'WORKSPACE_REFERENCE_SOURCE_CHANGED', '仓库来源已替换，不能按同名文件打开'],
    [
      409,
      'WORKSPACE_REFERENCE_IDENTITY_UNKNOWN',
      '原外部文件来源已无法核验，请从当前外部资料重新打开',
    ],
  ] as const)('所有者拒绝%s/%s时保留准确原因且不回退读取', async (status, code, message) => {
    using fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname === '/gateway/api/v1/projects/p-one/workspace/file-reference')
        return Response.json({ code, error: message }, { status })
      throw new Error('此测试不允许其他请求')
    })
    // 错误只留在文件面板，不能由同名路径读取掩盖来源缺失。
    await using screen = await render(
      <AutoOpsMaterialPreview {...props('autoops/p-one/inputs/old-input/README.md')} />,
      { router: false },
    )
    await expect
      .element(screen.getByRole('alert').getByText(message, { exact: true }))
      .toBeVisible()
    await expect.element(screen.getByRole('button', { name: '重试', exact: true })).toBeVisible()
    await expect
      .element(screen.getByRole('region', { name: '原生预览合同' }))
      .not.toBeInTheDocument()
    expect(
      fetcher.mock.calls.filter(
        ([input]) =>
          new URL(String(input), location.origin).pathname ===
          '/gateway/api/v1/projects/p-one/workspace/file-reference',
      ),
    ).toHaveLength(1)
    expect(mocks.list).not.toHaveBeenCalled()
  })
  it('定位暂时失败只在预览区报错，原重试恢复当前文件', async () => {
    let unavailable = true
    const reference = currentReference()
    mocks.execute.mockResolvedValue(result('picker-current'))
    using fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname.endsWith('/workspace/file-reference'))
        return unavailable
          ? Response.json(
              { code: 'WORKSPACE_STOPPING', error: '资料服务暂时不可用' },
              { status: 503 },
            )
          : Response.json(reference)
      if (
        url.pathname === '/gateway/autoops/resources' &&
        url.searchParams.get('path') === reference.resourcePath
      )
        return Response.json({ name: 'README.md', mime: 'text/plain', size: 12 })
      throw new Error('此测试不允许其他请求')
    })
    // 局部重试沿原面板，不能重建整个路由或改写消息路径。
    await using screen = await render(
      <AutoOpsMaterialPreview {...props('autoops/p-one/inputs/old-input/README.md')} />,
      { router: false },
    )
    await expect
      .element(screen.getByRole('alert').getByText('资料服务暂时不可用', { exact: true }))
      .toBeVisible()
    expect(mocks.list).not.toHaveBeenCalled()
    unavailable = false
    clickButton(screen.getByRole('button', { name: '重试', exact: true }).element())
    await expect.element(screen.getByRole('region', { name: '原生预览合同' })).toBeVisible()
    await expect.element(screen.getByRole('alert')).not.toBeInTheDocument()
    expect(
      fetcher.mock.calls.filter(([input]) =>
        new URL(String(input), location.origin).pathname.endsWith('/workspace/file-reference'),
      ),
    ).toHaveLength(2)
  })
  it('定位后撤权仍拒绝元数据，不沿旧输入或缓存继续预览', async () => {
    const reference = currentReference()
    mocks.execute.mockResolvedValue(result('picker-current'))
    using _fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname.endsWith('/workspace/file-reference')) return Response.json(reference)
      if (url.pathname === '/gateway/autoops/resources')
        return Response.json(
          { code: 'WORKSPACE_FORBIDDEN', error: '当前资料访问权限已撤回' },
          { status: 403 },
        )
      throw new Error('此测试不允许其他请求')
    })
    // 元数据读取独立复核权限；测试不依赖应用路由。
    await using screen = await render(
      <AutoOpsMaterialPreview {...props('autoops/p-one/inputs/old-input/README.md')} />,
      { router: false },
    )
    await expect
      .element(screen.getByRole('alert').getByText('当前资料访问权限已撤回', { exact: true }))
      .toBeVisible()
    await expect
      .element(screen.getByRole('region', { name: '原生预览合同' }))
      .not.toBeInTheDocument()
    expect(mocks.list).not.toHaveBeenCalled()
  })
  it('切到外部范围后迟到的内部定位不会恢复原正文', async () => {
    let resolveInternal!: (response: Response) => void
    const internal = currentReference(),
      external = currentReference('external-input', 'external')
    mocks.execute.mockResolvedValue(result('picker-external'))
    using fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname.endsWith('/workspace/file-reference')) {
        if (url.searchParams.get('workspaceType') === 'internal')
          return new Promise((resolve) => {
            resolveInternal = resolve
          })
        return Response.json(external)
      }
      if (
        url.pathname === '/gateway/autoops/resources' &&
        url.searchParams.get('path') === external.resourcePath
      )
        return Response.json({ name: '公开文件.md', mime: 'text/plain', size: 12 })
      throw new Error('此测试不允许其他请求')
    })
    // 复用同一预览组件跨范围更新，观察迟到请求是否被丢弃。
    await using screen = await render(
      <AutoOpsMaterialPreview {...props('autoops/p-one/inputs/old-input/README.md')} />,
      { router: false },
    )
    await vi.waitFor(() => expect(resolveInternal).toBeTypeOf('function'))
    mocks.scope.mockReturnValue(scope('external'))
    await screen.rerender(
      <AutoOpsMaterialPreview {...props('autoops/p-one/inputs/external-input/README.md')} />,
    )
    await expect.element(screen.getByRole('region', { name: '原生预览合同' })).toBeVisible()
    resolveInternal(Response.json(internal))
    await vi.waitFor(() => expect(screen.container.textContent).toContain('workspaceType=external'))
    expect(
      fetcher.mock.calls.some(
        ([input]) =>
          new URL(String(input), location.origin).searchParams.get('path') ===
          internal.resourcePath,
      ),
    ).toBe(false)
    expect(screen.container.textContent).not.toContain('workspaceType=internal')
  })
  it('客户会话使用客户文件面板，不走平台目录和元数据接口', async () => {
    mocks.scope.mockReturnValue({
      ...scope(),
      executionBinding: {
        kind: 'customer',
        deviceId: 'device',
        registeredWorkspaceId: 'workspace',
        workspaceBindingRevision: 1,
        runtimeId: 'codex',
      },
    })
    await using screen = await render(
      <AutoOpsMaterialPreview {...props('autoops-customer/device/workspace/1/src/client.ts')} />,
      { router: false },
    )
    await expect.element(screen.getByRole('region', { name: '客户文件合同' })).toBeVisible()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
    await screen.rerender(<AutoOpsMaterialPreview {...props()} />)
    await expect.element(screen.getByText('电脑目录')).toBeVisible()
  })
  it('客户范围丢失后保留错误，不将旧文件或目录解释成平台路径', async () => {
    mocks.scope.mockReturnValue(undefined)
    await using screen = await render(
      <AutoOpsMaterialPreview {...props('autoops-customer/device/workspace/1/src/client.ts')} />,
      { router: false },
    )
    await expect.element(screen.getByText('此文件不属于当前电脑工作区。')).toBeVisible()
    await screen.rerender(
      <AutoOpsMaterialPreview {...props()} cwd="autoops-customer://old-scope" />,
    )
    await expect.element(screen.getByText('此文件不属于当前电脑工作区。')).toBeVisible()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
  })
  it('空根先捕获当前输入，后续搜索继续同一身份', async () => {
    mocks.execute.mockResolvedValue(result('input-one'))
    await using screen = await render(<AutoOpsMaterialPreview {...props()} />, { router: false })
    await expect.element(screen.getByRole('region', { name: '原生预览合同' })).toBeVisible()
    expect(mocks.list).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: base + '?workspaceType=internal', directoryPath: '' },
    })
    clickButton(screen.getByRole('button', { name: '搜索文件' }).element())
    await expect.element(screen.getByText('README.md', { exact: true })).toBeVisible()
    expect(mocks.search).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: base + '?workspaceType=internal&inputId=input-one', query: 'read', limit: 20 },
    })
  })
  it('旧会话的目录入口使用当前输入，不沿用历史版本绑定', async () => {
    mocks.scope.mockReturnValue({
      ...scope(),
      workspaceVersionId: 'old-version',
      scopeLocked: true,
    })
    mocks.execute.mockResolvedValue(result('current-input'))
    // 原生预览合同不依赖路由状态。
    await using screen = await render(<AutoOpsMaterialPreview {...props()} />, { router: false })
    await expect.element(screen.getByRole('region', { name: '原生预览合同' })).toBeVisible()
    expect(mocks.list).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: base + '?workspaceType=internal', directoryPath: '' },
    })
    clickButton(screen.getByRole('button', { name: '搜索文件' }).element())
    await expect.element(screen.getByText('README.md', { exact: true })).toBeVisible()
    expect(mocks.search.mock.calls.at(-1)?.[0].input.cwd).toBe(
      base + '?workspaceType=internal&inputId=current-input',
    )
    expect(screen.container.textContent).not.toContain('old-version')
  })
  it('显式历史引用继续读取原版本，不自动改成当前内容', async () => {
    mocks.scope.mockReturnValue({
      ...scope(),
      workspaceVersionId: 'old-version',
      scopeLocked: true,
    })
    const historicalPath = 'autoops/p-one/workspaces/old-version/README.md'
    mocks.execute.mockResolvedValue({
      _tag: 'Success',
      value: {
        entries: [{ path: historicalPath, name: 'README.md', kind: 'file' }],
        truncated: false,
      },
    })
    // 原生预览合同不依赖路由状态。
    await using screen = await render(<AutoOpsMaterialPreview {...props(historicalPath)} />, {
      router: false,
    })
    await expect.element(screen.getByRole('region', { name: '原生预览合同' })).toBeVisible()
    expect(mocks.list).not.toHaveBeenCalled()
    clickButton(screen.getByRole('button', { name: '搜索文件' }).element())
    await expect.element(screen.getByText('README.md', { exact: true })).toBeVisible()
    expect(mocks.search.mock.calls.at(-1)?.[0].input.cwd).toBe(
      base + '?workspaceType=internal&workspaceVersionId=old-version',
    )
  })
  it('外部对话先验证显式输入，拒绝后不打开原生预览', async () => {
    mocks.scope.mockReturnValue(scope('external'))
    using fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname !== '/gateway/api/v1/projects/p-one/workspace/file-reference')
        throw new Error('此测试不允许其他请求')
      return Response.json(
        {
          code: 'WORKSPACE_FORBIDDEN',
          error: '此输入不属于外部资料范围',
        },
        { status: 403 },
      )
    })
    await using screen = await render(
      <AutoOpsMaterialPreview {...props('autoops/p-one/inputs/internal-input/README.md')} />,
      { router: false },
    )
    await expect
      .element(screen.getByText('此输入不属于外部资料范围', { exact: true }))
      .toBeVisible()
    await expect
      .element(screen.getByRole('region', { name: '原生预览合同' }))
      .not.toBeInTheDocument()
    expect(mocks.list).not.toHaveBeenCalled()
    const requests = fetcher.mock.calls.filter(
      ([input]) =>
        new URL(String(input), location.origin).pathname ===
        '/gateway/api/v1/projects/p-one/workspace/file-reference',
    )
    expect(requests).toHaveLength(1)
    const request = new URL(String(requests[0]![0]), location.origin)
    expect(request.searchParams.get('workspaceType')).toBe('external')
    expect(request.searchParams.get('inputId')).toBe('internal-input')
  })
  it('切范围后迟到的内部输入不能恢复旧预览', async () => {
    let resolveOld!: (value: ReturnType<typeof result>) => void
    mocks.execute
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockResolvedValue(result('external-input'))
    await using screen = await render(<AutoOpsMaterialPreview {...props()} />, { router: false })
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1))
    mocks.scope.mockReturnValue(scope('external'))
    await screen.rerender(<AutoOpsMaterialPreview {...props()} />)
    await expect.element(screen.getByRole('region', { name: '原生预览合同' })).toBeVisible()
    resolveOld(result('internal-input'))
    clickButton(screen.getByRole('button', { name: '搜索文件' }).element())
    expect(mocks.search.mock.calls.at(-1)?.[0].input.cwd).toBe(
      base + '?workspaceType=external&inputId=external-input',
    )
    expect(screen.container.textContent).not.toContain('internal-input')
  })
})
