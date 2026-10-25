import { useRef, useState, type PropsWithChildren } from 'react'
import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render } from '../../test/render'
import { ComposerHandleContext } from '~/composerHandleContext'
import type { ChatComposerHandle } from '~/components/chat/ChatComposer'
import type { FilePreviewPanelProps } from '~/components/files/FilePreviewPanel'
import { RightPanelSheet } from '~/components/RightPanelSheet'
import { useMediaQuery } from '~/hooks/useMediaQuery'
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from '~/rightPanelLayout'
import { useRightPanelStore, selectThreadRightPanelState } from '~/rightPanelStore'
import { autoOpsRequest } from './apiClient'
import { useCustomerFileSearch } from './customerFiles'
import { CustomerFileAttachMenu, CustomerFileLink, CustomerFilePanel } from './CustomerFilePanel'
import type { AutoOpsThreadScope } from './hostConfig'
import '../index.css'

vi.mock(import('./apiClient'), async (original) => ({
  ...(await original()),
  autoOpsRequest: vi.fn(),
}))
vi.mock('~/components/DiffWorkerPoolProvider', () => ({
  DiffWorkerPoolProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}))
const environmentId = EnvironmentId.make('customer-files-test')
const threadRef = { environmentId, threadId: ThreadId.make('customer-panel-test') }
const canonical = (path: string) => `autoops-customer/device/workspace/1/${path}`
function setup() {
  const scope: AutoOpsThreadScope = {
    projectId: 'project',
    environmentId: 'test',
    agentId: 'agent',
    visibility: 'private',
    executionBinding: {
      kind: 'customer',
      deviceId: 'device',
      registeredWorkspaceId: 'workspace',
      workspaceBindingRevision: 1,
      runtimeId: 'codex',
    },
  }
  return { scope }
}
function requests() {
  return vi
    .mocked(autoOpsRequest)
    .mock.calls.map(([path]) =>
      JSON.parse(new URL(path, 'http://localhost').searchParams.get('input')!),
    )
}
function serveFiles() {
  vi.mocked(autoOpsRequest).mockImplementation((path) => {
    const input = JSON.parse(new URL(path, 'http://localhost').searchParams.get('input')!)
    return Promise.resolve(
      input.operation === 'preview'
        ? {
            entries: [],
            truncated: true,
            preview: {
              path: input.path,
              size: 120_000,
              binary: input.path.endsWith('.bin'),
              contents: "export const marker = 'PREVIEW-7813';",
            },
          }
        : {
            entries:
              input.path === 'src'
                ? [{ path: 'src/client.ts', kind: 'file' }]
                : [{ path: 'src', kind: 'directory' }],
            truncated: false,
          },
    )
  })
}
function panelProps(relativePath: string | null): FilePreviewPanelProps {
  return {
    environmentId,
    threadRef,
    composerDraftTarget: threadRef,
    cwd: 'customer',
    projectName: '测试',
    relativePath,
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
function Workbench({ scope }: { scope: AutoOpsThreadScope }) {
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const handle = useRef({
    insertTextAtEnd: (text: string) => {
      setDraft((value) => value + text)
      return true
    },
    focusAtEnd: () => input.current?.focus(),
  } as ChatComposerHandle)
  const state = useRightPanelStore((value) =>
    selectThreadRightPanelState(value.byThreadKey, threadRef),
  )
  const surface = state.surfaces.find((item) => item.id === state.activeSurfaceId)
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY)
  const content =
    surface && (surface.kind === 'files' || surface.kind === 'file') ? (
      <CustomerFilePanel
        {...panelProps(surface.kind === 'file' ? surface.relativePath : null)}
        scope={scope}
        folderTrail={surface.folderTrail}
        onOpenFile={(path) => useRightPanelStore.getState().openFile(threadRef, path)}
        onNavigateFolder={(path, trail, keep) =>
          useRightPanelStore.getState().navigateFolder(threadRef, surface.id, path, trail, keep)
        }
      />
    ) : null
  return (
    <ComposerHandleContext value={handle}>
      <div style={{ display: 'flex', height: 420 }}>
        <main>
          <input
            aria-label="测试消息"
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <CustomerFileAttachMenu
            onUpload={() => {}}
            onBrowse={() => useRightPanelStore.getState().open(threadRef, 'files')}
          />
          <CustomerFileLink
            scope={scope}
            threadRef={threadRef}
            path={canonical('src/client.ts')}
            copyMarkdown=""
          />
        </main>
        {sheet && surface ? (
          <RightPanelSheet
            animationDurationMs={0}
            keepMounted={false}
            finalFocus={() => input.current}
            open={state.isOpen}
            onClose={() => {
              useRightPanelStore.getState().close(threadRef)
            }}
          >
            {content}
          </RightPanelSheet>
        ) : state.isOpen ? (
          <aside aria-label="电脑文件面板" style={{ display: 'flex', flex: 1, minWidth: 0 }}>
            {content}
          </aside>
        ) : null}
      </div>
    </ComposerHandleContext>
  )
}
function Search(props: { scope: AutoOpsThreadScope; query: string }) {
  const result = useCustomerFileSearch(props.scope, 'draft', environmentId, props.query)
  return (
    <>
      <div role="status">{result.isPending ? '加载中' : '已完成'}</div>
      <div role="alert">{result.error}</div>
      <ul>
        {result.entries.map((entry) => (
          <li key={entry.path}>{entry.path}</li>
        ))}
      </ul>
    </>
  )
}
beforeEach(async () => {
  vi.mocked(autoOpsRequest).mockReset()
  useRightPanelStore.setState({ byThreadKey: {} })
  localStorage.setItem('t3code.fileExplorerOpen', 'true')
  await page.viewport(1440, 700)
  serveFiles()
})
afterEach(async () => {
  document.documentElement.classList.remove('dark')
  await page.viewport(1440, 700)
})

describe('客户文件的原生选择与范围隔离', () => {
  it('历史文件在原生侧栏打开，不用居中弹窗遮挡对话', async () => {
    const { scope } = setup()
    await using screen = await render(<Workbench scope={scope} />)
    await page.getByRole('button', { name: '预览 client.ts', exact: true }).click()
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    await expect.element(screen.getByText(/PREVIEW-7813/u)).toBeVisible()
    await screen.getByRole('textbox', { name: '测试消息', exact: true }).fill('边看文件边提问')
    await expect.element(screen.getByRole('textbox')).toHaveValue('边看文件边提问')
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([expect.objectContaining({ kind: 'file', relativePath: canonical('src/client.ts') })])
  })
  it('附件菜单选择文件后直接添加引用，目录和预览仍在同一侧栏', async () => {
    const { scope } = setup()
    await using screen = await render(<Workbench scope={scope} />)
    await screen.getByRole('button', { name: '添加文件', exact: true }).click()
    await page.getByRole('menuitem', { name: '引用电脑文件', exact: true }).click()
    await screen.getByRole('treeitem', { name: 'src', exact: true }).click()
    await screen.getByRole('treeitem', { name: 'client.ts', exact: true }).click()
    await expect.element(screen.getByText(/PREVIEW-7813/u)).toBeVisible()
    await expect.element(screen.getByText('仅预览文件开头，Agent 会读取本机原文件。')).toBeVisible()
    await screen.getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect
      .element(screen.getByRole('textbox'))
      .toHaveValue(expect.stringContaining(canonical('src/client.ts')))
    await expect.element(screen.getByRole('textbox')).toHaveFocus()
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).isOpen,
    ).toBe(true)
    expect(requests().filter((value) => value.operation === 'preview')).toHaveLength(1)
    expect(
      requests()
        .filter((value) => value.operation === 'list')
        .map((value) => value.path)
        .sort(),
    ).toEqual(['', 'src'])
  })
  it('390px 深色短窗口沿用文件侧面板，返回目录和添加引用后回到输入框', async () => {
    await page.viewport(390, 500)
    document.documentElement.classList.add('dark')
    const { scope } = setup()
    await using screen = await render(<Workbench scope={scope} />)
    await page.getByRole('button', { name: '预览 client.ts', exact: true }).click()
    await expect.element(page.getByText(/PREVIEW-7813/u)).toBeVisible()
    await page.getByRole('button', { name: '返回文件目录', exact: true }).click()
    await expect.element(page.getByRole('searchbox')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect
      .poll(
        () =>
          selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).isOpen,
      )
      .toBe(false)
    await expect.element(page.getByRole('textbox', { name: '测试消息', exact: true })).toHaveFocus()
    await page.getByRole('button', { name: '预览 client.ts', exact: true }).click()
    await page.getByRole('button', { name: '添加到对话', exact: true }).click()
    await expect.element(page.getByRole('textbox')).toHaveFocus()
    await expect
      .element(page.getByRole('textbox'))
      .toHaveValue(expect.stringContaining(canonical('src/client.ts')))
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).isOpen,
    ).toBe(false)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
  })
  it('旧搜索取消后迟到结果不能覆盖新目录，新范围不复用旧结果', async () => {
    const { scope } = setup()
    let finishOld!: (value: unknown) => void
    let oldSignal: AbortSignal | undefined
    vi.mocked(autoOpsRequest).mockImplementation((path, options) => {
      const query = new URL(path, 'http://localhost').searchParams
      const input = JSON.parse(query.get('input')!)
      if (input.query === 'old') {
        oldSignal = options.signal
        return new Promise((resolve) => {
          finishOld = resolve
        })
      }
      return Promise.resolve({ entries: [{ path: 'new.ts', kind: 'file' }], truncated: false })
    })
    await using screen = await render(<Search scope={scope} query="old" />)
    await expect.poll(() => !!finishOld).toBe(true)
    await screen.rerender(<Search scope={scope} query="new" />)
    await expect.poll(() => oldSignal?.aborted).toBe(true)
    await expect.element(screen.getByText(/new\.ts/u)).toBeVisible()
    finishOld({ entries: [{ path: 'old.ts', kind: 'file' }], truncated: false })
    await expect.element(screen.getByText(/old\.ts/u)).not.toBeInTheDocument()
    const other = {
      ...scope,
      executionBinding: { ...scope.executionBinding!, registeredWorkspaceId: 'other' },
    } as AutoOpsThreadScope
    await screen.rerender(<Search scope={other} query="new" />)
    await expect
      .element(screen.getByText(/autoops-customer\/device\/other\/1\/new\.ts/u))
      .toBeVisible()
  })

  it('预览失败保留错误和重试，成功前不能引用，恢复后可以继续', async () => {
    const { scope } = setup()
    vi.mocked(autoOpsRequest).mockImplementation((path) => {
      const input = JSON.parse(new URL(path, 'http://localhost').searchParams.get('input')!)
      return input.operation === 'preview'
        ? Promise.reject(new Error('电脑已离线，请等待重新连接'))
        : Promise.resolve({ entries: [], truncated: false })
    })
    await using screen = await render(<Workbench scope={scope} />)
    await page.getByRole('button', { name: '预览 client.ts', exact: true }).click()
    await expect.element(screen.getByText('电脑已离线，请等待重新连接')).toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '添加到对话', exact: true }))
      .not.toBeInTheDocument()
    serveFiles()
    await screen.getByRole('button', { name: '重试', exact: true }).click()
    await expect.element(screen.getByText(/PREVIEW-7813/u)).toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '添加到对话', exact: true }))
      .toBeEnabled()
  })
  it('切换电脑范围中止旧预览，迟到正文不能覆盖新范围或沿旧路径读取', async () => {
    const { scope } = setup()
    let complete!: (value: unknown) => void
    let signal: AbortSignal | undefined
    vi.mocked(autoOpsRequest).mockImplementation((path, options) => {
      const input = JSON.parse(new URL(path, 'http://localhost').searchParams.get('input')!)
      if (input.operation !== 'preview') return Promise.resolve({ entries: [], truncated: false })
      signal = options.signal
      return new Promise((resolve) => {
        complete = resolve
      })
    })
    await using screen = await render(
      <CustomerFilePanel {...panelProps(canonical('src/client.ts'))} scope={scope} />,
    )
    await expect.poll(() => !!complete).toBe(true)
    const other = {
      ...scope,
      executionBinding: { ...scope.executionBinding!, registeredWorkspaceId: 'other' },
    } as AutoOpsThreadScope
    await screen.rerender(
      <CustomerFilePanel {...panelProps(canonical('src/client.ts'))} scope={other} />,
    )
    await expect.poll(() => signal?.aborted).toBe(true)
    complete({
      entries: [],
      truncated: false,
      preview: { path: 'src/client.ts', size: 3, binary: false, contents: '过期正文' },
    })
    await expect.element(screen.getByText('此文件不属于当前电脑工作区。')).toBeVisible()
    await expect.element(screen.getByText('过期正文')).not.toBeInTheDocument()
    expect(requests().filter((value) => value.operation === 'preview')).toHaveLength(1)
  })
  it('目录面包屑不发起正文读取，二进制仍可引用且不伪造下载', async () => {
    const { scope } = setup()
    await using screen = await render(
      <CustomerFilePanel
        {...panelProps(canonical('src'))}
        folderTrail={canonical('src/client.ts')}
        scope={scope}
      />,
    )
    await expect.element(screen.getByRole('searchbox')).toBeVisible()
    expect(requests().some((value) => value.operation === 'preview')).toBe(false)
    await screen.rerender(
      <CustomerFilePanel {...panelProps(canonical('archive.bin'))} scope={scope} />,
    )
    await expect.element(screen.getByText('此文件不支持文字预览，可以直接引用。')).toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '添加到对话', exact: true }))
      .toBeEnabled()
    await expect.element(screen.getByRole('link', { name: /下载/ })).not.toBeInTheDocument()
  })
})
