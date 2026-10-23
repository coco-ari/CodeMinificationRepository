import { useState, type ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { EnvironmentId } from '@t3tools/contracts'
import { act, render } from '../../test/render'
import { WorkspaceFileBrowser } from './WorkspaceFileBrowser'
import type { WorkspaceVersion } from './workspaces'
import type { ReadOnlyWorkspaceFiles } from '~/components/files/ReadOnlyWorkspaceFiles'

const mocks = vi.hoisted(() => ({
  tree: vi.fn(),
  metadata: vi.fn(),
  search: vi.fn(),
  download: vi.fn(),
  environment: vi.fn(),
  host: vi.fn(),
  codeViewport: false,
  contentHeight: 1500,
  contentWidth: 600,
}))
vi.mock(import('./hostSnapshot'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}))
vi.mock(import('../state/environments'), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: mocks.environment,
}))
vi.mock(import('./workspaces'), async (original) => ({
  ...(await original()),
  loadWorkspaceTree: mocks.tree,
  loadWorkspaceFileMetadata: mocks.metadata,
  searchWorkspaceFiles: mocks.search,
  workspaceFileDownloadUrl: mocks.download,
}))
vi.mock(import('../components/files/ReadOnlyWorkspaceFiles'), () => ({
  ReadOnlyWorkspaceFiles: function NativeFiles({
    source,
    relativePath,
    folderTrail,
    onOpenFile,
    onNavigateFolder,
  }: ComponentProps<typeof ReadOnlyWorkspaceFiles>) {
    const [metadata, setMetadata] = useState('')
    const [height, setHeight] = useState(mocks.contentHeight)
    const [width, setWidth] = useState(mocks.contentWidth)
    return (
      <div>
        <output aria-label="选中文件">{relativePath ?? '根目录'}</output>
        <output aria-label="目录轨迹">{folderTrail ?? ''}</output>
        <button onClick={() => onNavigateFolder?.('src', 'src/components', false)}>打开目录</button>
        <button onClick={() => onOpenFile('src/index.ts')}>打开源码</button>
        <button
          onClick={() => {
            void source?.metadata('src').then((value) => setMetadata(value.kind))
          }}
        >
          读取目录信息
        </button>
        <button
          onClick={() => {
            void source
              ?.metadata('src/index.ts')
              .then((value) => setMetadata(JSON.stringify(value)))
          }}
        >
          读取源码信息
        </button>
        <button
          onClick={() => {
            void source?.search('index', 20)
          }}
        >
          搜索源码
        </button>
        <output aria-label="文件信息">{metadata}</output>
        <button
          onClick={() => {
            setHeight(1500)
            setWidth(600)
          }}
        >
          完成内容排版
        </button>
        <div
          {...(mocks.codeViewport
            ? { className: 'file-preview-virtualizer' }
            : { 'data-slot': 'scroll-area-viewport' })}
          style={{ height: 100, width: 200, overflow: 'auto' }}
        >
          <div style={{ height, width }}>原生文件内容区域</div>
        </div>
      </div>
    )
  },
}))
const version: WorkspaceVersion = {
  id: 'v-one',
  name: '内部版本一',
  type: 'internal',
  status: 'published',
  createdAt: '2026-10-23T00:00:00Z',
  fileCount: 2,
  byteLength: 64,
  source: { repositories: [], contentHash: 'test-content' },
}
const stateKey = (key: string) => 'autoops:workspaces:files-owner:' + key
beforeEach(() => {
  vi.resetAllMocks()
  mocks.codeViewport = false
  mocks.contentHeight = 1500
  mocks.contentWidth = 600
  sessionStorage.clear()
  mocks.host.mockReturnValue({ principal: { id: 'files-owner' } })
  mocks.environment.mockReturnValue(EnvironmentId.make('files-test'))
  mocks.tree.mockResolvedValue({
    entries: [
      { path: 'src', name: 'src', kind: 'directory', size: 0 },
      { path: 'src/index.ts', name: 'index.ts', kind: 'file', size: 64 },
    ],
    truncated: false,
  })
  mocks.metadata.mockResolvedValue({ name: 'index.ts', mime: 'text/plain', size: 64 })
  mocks.download.mockReturnValue('/isolated/index.ts')
  mocks.search.mockResolvedValue({ entries: [], truncated: false })
})

describe('工作区文件浏览职责边界', () => {
  it('横向内容尚未排版完成时不提前消费恢复位置', async () => {
    mocks.codeViewport = true
    mocks.contentWidth = 220
    sessionStorage.setItem(
      stateKey('p-one:files:v-one'),
      JSON.stringify({ selected: 'src/index.ts' }),
    )
    sessionStorage.setItem(
      stateKey('p-one:scroll:v-one:src/index.ts'),
      JSON.stringify([{ top: 600, left: 80 }]),
    )
    // 这里只检验文件视口合同，不依赖路由。
    await using screen = await render(
      <WorkspaceFileBrowser projectId="p-one" version={version} />,
      { router: false },
    )
    const viewport = screen.container.querySelector<HTMLElement>('.file-preview-virtualizer')!
    expect(viewport.scrollLeft).toBe(0)
    await act(() => {
      screen.container.querySelector<HTMLButtonElement>('button:last-of-type')!.click()
    })
    await vi.waitFor(() => expect(viewport.scrollLeft).toBe(80))
    expect(viewport.scrollTop).toBe(600)
  })
  it.each([false, true])('异步排版后恢复阅读位置，代码视口=%s', async (codeViewport) => {
    mocks.codeViewport = codeViewport
    mocks.contentHeight = 140
    sessionStorage.setItem(
      stateKey('p-one:files:v-one'),
      JSON.stringify({ selected: 'src/index.ts' }),
    )
    sessionStorage.setItem(
      stateKey('p-one:scroll:v-one:src/index.ts'),
      JSON.stringify([{ top: 600, left: 40 }]),
    )
    // 这里只检验文件视口合同，不依赖路由。
    await using screen = await render(
      <WorkspaceFileBrowser projectId="p-one" version={version} />,
      {
        router: false,
      },
    )
    const viewport = screen.container.querySelector<HTMLElement>(
      '.file-preview-virtualizer, [data-slot="scroll-area-viewport"]',
    )!
    expect(viewport.scrollTop).toBe(0)
    await act(() => {
      screen.container.querySelector<HTMLButtonElement>('button:last-of-type')!.click()
    })
    await vi.waitFor(() => expect(viewport.scrollTop).toBe(600))
    expect(viewport.scrollLeft).toBe(40)
  })
  it('用户已开始滚动时，迟到排版不覆盖新的阅读位置', async () => {
    mocks.codeViewport = true
    mocks.contentHeight = 300
    sessionStorage.setItem(
      stateKey('p-one:files:v-one'),
      JSON.stringify({ selected: 'src/index.ts' }),
    )
    sessionStorage.setItem(
      stateKey('p-one:scroll:v-one:src/index.ts'),
      JSON.stringify([{ top: 600, left: 0 }]),
    )
    // 这里只检验文件视口合同，不依赖路由。
    await using screen = await render(
      <WorkspaceFileBrowser projectId="p-one" version={version} />,
      {
        router: false,
      },
    )
    const viewport = screen.container.querySelector<HTMLElement>('.file-preview-virtualizer')!
    await act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }))
      viewport.scrollTop = 100
      viewport.dispatchEvent(new Event('scroll'))
      screen.container.querySelector<HTMLButtonElement>('button:last-of-type')!.click()
    })
    await vi.waitFor(() => expect(viewport.scrollHeight).toBe(1500))
    expect(viewport.scrollTop).toBe(100)
    expect(
      JSON.parse(sessionStorage.getItem(stateKey('p-one:scroll:v-one:src/index.ts'))!),
    ).toEqual([{ top: 100, left: 0 }])
  })
  it('保留用户和版本的选中项、目录轨迹及重新进入后的滚动位置', async () => {
    sessionStorage.setItem(
      stateKey('p-one:files:v-one'),
      JSON.stringify({ selected: 'src', trail: 'src/components' }),
    )
    await using first = await render(<WorkspaceFileBrowser projectId="p-one" version={version} />, {
      router: false,
    })
    await expect.element(page.getByRole('status', { name: '选中文件' })).toHaveTextContent('src')
    await expect
      .element(page.getByRole('status', { name: '目录轨迹' }))
      .toHaveTextContent('src/components')
    await page.getByRole('button', { name: '打开源码' }).click()
    const viewport = first.container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )!
    await act(() => {
      viewport.dispatchEvent(new Event('wheel', { bubbles: true }))
      viewport.scrollTop = 300
      viewport.scrollLeft = 40
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(JSON.parse(sessionStorage.getItem(stateKey('p-one:files:v-one'))!)).toEqual({
      selected: 'src/index.ts',
    })
    await first.unmount()
    await using restored = await render(
      <WorkspaceFileBrowser projectId="p-one" version={version} />,
      { router: false },
    )
    await expect
      .element(page.getByRole('status', { name: '选中文件' }))
      .toHaveTextContent('src/index.ts')
    const restoredViewport = restored.container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )!
    expect(restoredViewport.scrollTop).toBe(300)
    expect(restoredViewport.scrollLeft).toBe(40)
  })
  it('切换版本使用独立阅读状态，并把列表、搜索和元数据绑定到固定版本', async () => {
    sessionStorage.setItem(
      stateKey('p-one:files:v-one'),
      JSON.stringify({ selected: 'src/index.ts' }),
    )
    await using screen = await render(
      <WorkspaceFileBrowser key="v-two" projectId="p-two" version={{ ...version, id: 'v-two' }} />,
      { router: false },
    )
    await expect.element(page.getByRole('status', { name: '选中文件' })).toHaveTextContent('根目录')
    await page.getByRole('button', { name: '读取目录信息' }).click()
    await expect
      .element(page.getByRole('status', { name: '文件信息' }))
      .toHaveTextContent('directory')
    expect(mocks.tree).toHaveBeenLastCalledWith('p-two', 'v-two', '')
    expect(mocks.metadata).not.toHaveBeenCalled()
    await page.getByRole('button', { name: '读取源码信息' }).click()
    await vi.waitFor(() => expect(screen.container.textContent).toContain('/isolated/index.ts'))
    expect(mocks.metadata).toHaveBeenCalledWith('p-two', 'v-two', 'src/index.ts')
    expect(mocks.download).toHaveBeenCalledWith('p-two', 'v-two', 'src/index.ts')
    await page.getByRole('button', { name: '搜索源码' }).click()
    expect(mocks.search).toHaveBeenCalledWith('p-two', 'v-two', 'index', 20)
    expect(JSON.parse(sessionStorage.getItem(stateKey('p-one:files:v-one'))!)).toEqual({
      selected: 'src/index.ts',
    })
  })
  it('缺少文件连接时局部提示，不读取文件或影响其他页面', async () => {
    mocks.environment.mockReturnValue(undefined)
    await using screen = await render(
      <WorkspaceFileBrowser projectId="p-one" version={version} />,
      { router: false },
    )
    expect(screen.container.textContent).toContain('文件连接不可用')
    expect(mocks.tree).not.toHaveBeenCalled()
    expect(mocks.metadata).not.toHaveBeenCalled()
  })
})
