import type { ComponentProps, PropsWithChildren } from 'react'
import { EnvironmentId } from '@t3tools/contracts'
import { describe, expect, it, vi } from 'vite-plus/test'
import { act, render } from '../../test/render'
import { WorkspaceFileBrowser } from './WorkspaceFileBrowser'
import ReadOnlySourcePreview from '~/components/files/ReadOnlySourcePreview'
import { fileScrollViewports } from '~/components/files/fileSurfaceChrome'
import type { ReadOnlyWorkspaceFiles } from '~/components/files/ReadOnlyWorkspaceFiles'
import type { WorkspaceVersion } from './workspaces'
import type { AutoOpsHost } from './hostSnapshot'
import '../index.css'

vi.mock(import('./hostSnapshot'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: (): AutoOpsHost => ({
    principal: { id: 'code-reader', displayName: '源码阅读验收' },
    httpBaseUrl: 'http://localhost',
    wsBaseUrl: 'ws://localhost',
    gatewayBasePath: '/api/agent-demo/t3',
    csrfToken: 'isolated-code-reading',
    fixedModel: { instanceId: 'codex', model: 'test-model' },
    runtimeMode: 'approval-required',
    projects: [],
    capabilities: {},
  }),
}))
vi.mock(import('../state/environments'), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make('code-reader'),
}))
// 阅读恢复不依赖语法高亮 Worker；保留实际 Pierre File 与 Virtualizer 的布局和滚动。
vi.mock(import('../components/DiffWorkerPoolProvider'), () => ({
  DiffWorkerPoolProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}))
vi.mock(import('../components/files/ReadOnlyWorkspaceFiles'), () => ({
  ReadOnlyWorkspaceFiles: ({ relativePath }: ComponentProps<typeof ReadOnlyWorkspaceFiles>) => (
    <div style={{ display: 'flex', flexDirection: 'column', height: 260, width: 420 }}>
      <ReadOnlySourcePreview
        name={relativePath ?? 'source.ts'}
        text={Array.from({ length: 300 }, (_, index) => `const line${index} = ${index}`).join('\n')}
      />
    </div>
  ),
}))

const version: WorkspaceVersion = {
  id: 'code-version',
  name: '源码阅读验收',
  type: 'internal',
  status: 'published',
  createdAt: '2026-10-23T00:00:00Z',
  fileCount: 1,
  byteLength: 8000,
  source: { repositories: [], contentHash: 'code-reading-test' },
}

const selectedPath = '源码目录/'.repeat(12) + '需要保留阅读位置的长文件名.ts'
const storagePrefix = 'autoops:workspaces:code-reader:code-project:'

describe('真实原生代码预览的阅读恢复', () => {
  it('虚拟代码内容异步绘制后恢复原文件位置，切版本不串用', async () => {
    sessionStorage.clear()
    sessionStorage.setItem(
      storagePrefix + 'files:code-version',
      JSON.stringify({ selected: selectedPath }),
    )
    // 渲染实际 Pierre 代码视口，避免用 ScrollArea 替身掩盖视口合同遗漏。
    await using first = await render(
      <WorkspaceFileBrowser projectId="code-project" version={version} />,
      { router: false },
    )
    let viewport: HTMLElement | null = null
    await vi.waitFor(() => {
      viewport = fileScrollViewports(first.container)[0] ?? null
      expect(viewport).not.toBeNull()
      expect(viewport!.scrollHeight - viewport!.clientHeight).toBeGreaterThan(1600)
    })
    await act(() => {
      viewport!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1200 }))
      viewport!.scrollTop = 1200
      viewport!.dispatchEvent(new Event('scroll'))
    })
    expect(
      JSON.parse(sessionStorage.getItem(storagePrefix + 'scroll:code-version:' + selectedPath)!),
    ).toEqual([{ top: 1200, left: 0 }])
    await first.unmount()
    await using reopened = await render(
      <WorkspaceFileBrowser projectId="code-project" version={version} />,
      { router: false },
    )
    await vi.waitFor(() => {
      const restored = fileScrollViewports(reopened.container)[0]
      expect(restored?.scrollTop).toBe(1200)
    })
    await reopened.rerender(
      <WorkspaceFileBrowser
        key="another-version"
        projectId="code-project"
        version={{ ...version, id: 'another-version' }}
      />,
    )
    await vi.waitFor(() => {
      const other = fileScrollViewports(reopened.container)[0]
      expect(other).not.toBeNull()
      expect(other?.scrollTop).toBe(0)
    })
  })
})
