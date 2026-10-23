import { describe, expect, it, vi } from 'vite-plus/test'
import { act, render } from '../../test/render'
import { WorkspaceCurrentFiles } from './WorkspaceAuthoringPanel'
import { EnvironmentId } from '@t3tools/contracts'

const mocks = vi.hoisted(() => ({ host: vi.fn(), height: 1500, mounted: true }))
vi.mock(import('./hostSnapshot'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}))
vi.mock(import('../state/environments'), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => (mocks.mounted ? EnvironmentId.make('isolated-reading') : null),
}))
vi.mock(import('../components/files/ReadOnlyWorkspaceFiles'), () => ({
  ReadOnlyWorkspaceFiles: () => (
    <div data-slot="scroll-area-viewport" style={{ height: 100, width: 200, overflow: 'auto' }}>
      <div style={{ height: mocks.height, width: 500 }}>原生视口尺寸夹具</div>
    </div>
  ),
}))
function setup() {
  mocks.host.mockReturnValue({ principal: { id: 'isolated-reading-owner' } })
  sessionStorage.clear()
  mocks.height = 1500
  mocks.mounted = true
}
function Files({
  revision = 'content-one',
  renderScope = 'ready-one',
  height = 1500,
  project = 'p-one',
  mounted = true,
}: {
  revision?: string
  renderScope?: string
  height?: number
  project?: string
  mounted?: boolean
}) {
  mocks.height = height
  mocks.mounted = mounted
  return (
    <WorkspaceCurrentFiles
      projectId={project}
      revision={renderScope === 'ready-two' ? 2 : 1}
      readingRevision={revision}
      selected="docs/long.md"
      trail={undefined}
      onDenied={vi.fn()}
      onOpen={vi.fn()}
      onFolder={vi.fn()}
    />
  )
}
const storageKey = (project = 'p-one', revision = 'content-one') =>
  `autoops:workspaces:isolated-reading-owner:${project}:authoring:scroll:${revision}:docs/long.md`
const viewport = (screen: { container: Element }) =>
  screen.container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!

describe('当前资料共用的原生文件阅读恢复', () => {
  it('环境延迟装配与异步排版完成后恢复两轴阅读位置', async () => {
    setup()
    sessionStorage.setItem(storageKey(), JSON.stringify([{ top: 600, left: 80 }]))
    // 这里只验证公开视口恢复合同，不依赖路由状态。
    await using screen = await render(<Files mounted={false} renderScope="connecting" />, {
      router: false,
    })
    await screen.rerender(<Files height={20} />)
    expect(viewport(screen).scrollTop).toBe(0)
    await screen.rerender(<Files height={1500} />)
    await vi.waitFor(() => expect(viewport(screen).scrollTop).toBe(600))
    expect(viewport(screen).scrollLeft).toBe(80)
  })
  it('资料修订和项目分别保存位置，用户新滚动优先于迟到绘制', async () => {
    setup()
    sessionStorage.setItem(storageKey(), JSON.stringify([{ top: 600, left: 80 }]))
    sessionStorage.setItem(
      storageKey('p-one', 'content-two'),
      JSON.stringify([{ top: 200, left: 20 }]),
    )
    // 这里只验证公开视口恢复合同，不依赖路由状态。
    await using screen = await render(<Files />, { router: false })
    await vi.waitFor(() => expect(viewport(screen).scrollTop).toBe(600))
    await screen.rerender(<Files revision="content-two" renderScope="ready-two" />)
    await vi.waitFor(() => expect(viewport(screen).scrollTop).toBe(200))
    await act(async () => {
      viewport(screen).dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
      viewport(screen).scrollTop = 350
      viewport(screen).dispatchEvent(new Event('scroll'))
    })
    await screen.rerender(<Files revision="content-two" renderScope="ready-two" height={1800} />)
    await vi.waitFor(() =>
      expect(JSON.parse(sessionStorage.getItem(storageKey('p-one', 'content-two'))!)[0].top).toBe(
        350,
      ),
    )
    expect(viewport(screen).scrollTop).toBe(350)
    expect(JSON.parse(sessionStorage.getItem(storageKey())!)[0].top).toBe(600)
    await screen.rerender(<Files key="other-project" project="p-two" />)
    expect(viewport(screen).scrollTop).toBe(0)
  })
})
