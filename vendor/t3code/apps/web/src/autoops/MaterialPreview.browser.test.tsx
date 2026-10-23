import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { scopeThreadRef } from '@t3tools/client-runtime/environment'
import { render } from '../../test/render'
import type { FilePreviewPanelProps } from '~/components/files/FilePreviewPanel'
import AutoOpsMaterialPreview from './MaterialPreview'
import type { AutoOpsThreadScope } from './hostConfig'

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  execute: vi.fn(),
  list: vi.fn(),
  search: vi.fn(),
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
vi.mock(import('./useThreadScope'), () => ({ useAutoOpsThreadScope: mocks.scope }))
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
  default: function NativeFileContract({ readOnlySource, cwd }: FilePreviewPanelProps) {
    const [results, setResults] = useState('')
    return (
      <section aria-label="原生预览合同">
        <output>{cwd}</output>
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
beforeEach(() => {
  vi.clearAllMocks()
  mocks.scope.mockReturnValue(scope())
  mocks.list.mockImplementation((input) => input)
  mocks.search.mockImplementation((input) => input)
})
describe('当前对话文件预览的输入和范围边界', () => {
  it('空根先捕获当前输入，后续搜索继续同一身份', async () => {
    mocks.execute.mockResolvedValue(result('input-one'))
    await using screen = await render(<AutoOpsMaterialPreview {...props()} />, { router: false })
    await expect.element(screen.getByRole('region', { name: '原生预览合同' })).toBeVisible()
    expect(mocks.list).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: base + '?workspaceType=internal', directoryPath: '' },
    })
    await screen.getByRole('button', { name: '搜索文件' }).click()
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
    await screen.getByRole('button', { name: '搜索文件' }).click()
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
    await screen.getByRole('button', { name: '搜索文件' }).click()
    await expect.element(screen.getByText('README.md', { exact: true })).toBeVisible()
    expect(mocks.search.mock.calls.at(-1)?.[0].input.cwd).toBe(
      base + '?workspaceType=internal&workspaceVersionId=old-version',
    )
  })
  it('外部对话先验证显式输入，拒绝后不打开原生预览', async () => {
    mocks.scope.mockReturnValue(scope('external'))
    mocks.execute.mockRejectedValue(new Error('此输入不属于外部资料范围'))
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
    expect(mocks.list).toHaveBeenCalledWith({
      environmentId,
      input: {
        cwd: base + '?workspaceType=external&inputId=internal-input',
        directoryPath: 'autoops/p-one/inputs/internal-input',
      },
    })
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
    await screen.getByRole('button', { name: '搜索文件' }).click()
    expect(mocks.search.mock.calls.at(-1)?.[0].input.cwd).toBe(
      base + '?workspaceType=external&inputId=external-input',
    )
    expect(screen.container.textContent).not.toContain('internal-input')
  })
})
