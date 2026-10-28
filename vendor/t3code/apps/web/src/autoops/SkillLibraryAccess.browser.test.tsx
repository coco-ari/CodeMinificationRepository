import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { act, render } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { AutoOpsSkillLibraryPage } from './SkillLibraryPage'
import { AutoOpsRequestError } from './apiClient'
import type { SkillLibrary } from './skillLibrary'
import '../index.css'

const mocks = vi.hoisted(() => ({ load: vi.fn(), change: vi.fn(), search: vi.fn(), host: vi.fn() }))
vi.mock(import('@tanstack/react-router'), async (original) => ({
  ...(await original()),
  useSearch: mocks.search,
}))
vi.mock(import('./projectNavigation'), async (original) => ({
  ...(await original()),
  useAutoOpsProjectId: () => 'p-one',
}))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}))
vi.mock(import('./skillLibrary'), async (original) => ({
  ...(await original()),
  loadSkillLibrary: mocks.load,
  changeSkillLibrary: mocks.change,
}))
const catalog = (): SkillLibrary => ({
  revision: 'revision-one',
  canManage: true,
  projects: [{ id: 'p-one', name: '隔离项目', canManage: true }],
  assistants: [],
  assignments: [],
  skills: [
    {
      id: 'skill-one',
      name: 'isolated-skill',
      displayName: '可撤权skill',
      description: '撤权后应清除的目录内容',
      enabled: true,
      latestVersionId: 'version-one',
      versions: [
        {
          id: 'version-one',
          createdAt: '2026-10-23T00:00:00Z',
          readiness: 'ready',
          reason: null,
          contentHash: 'isolated',
          fileCount: 1,
          byteLength: 20,
          source: { type: 'builtin' },
          files: [
            {
              path: 'SKILL.md',
              size: 20,
              mime: 'text/markdown',
              sha256: 'isolated',
              binary: false,
            },
          ],
        },
      ],
    },
  ],
})
const denied = () => new AutoOpsRequestError('当前账号已无权读取skill库。', 'ACCESS_DENIED', 403)
beforeEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
  mocks.search.mockReturnValue({ skillView: 'library' })
  mocks.host.mockReturnValue({
    principal: { id: 'isolated-owner', displayName: '隔离用户' },
    httpBaseUrl: location.origin,
    wsBaseUrl: 'ws://isolated.invalid',
    gatewayBasePath: '/api/agent-demo/t3',
    csrfToken: 'isolated-token',
    fixedModel: { instanceId: 'codex', model: 'test-model' },
    runtimeMode: 'approval-required',
    capabilities: {},
    projects: [{ id: 'p-one', name: '隔离项目', environments: [], agents: [] }],
  })
  mocks.load.mockResolvedValue(catalog())
})
describe('skill库写入后的撤权处理', () => {
  for (const phase of ['mutation', 'refresh'] as const) {
    it(phase + ' 撤权会清除旧目录与操作入口', async () => {
      await using screen = await render(
        <SidebarProvider>
          <AutoOpsSkillLibraryPage />
        </SidebarProvider>,
        { router: '/skills?projectId=p-one&skillView=library' },
      )
      await expect
        .element(page.getByRole('button', { name: '可撤权skill', exact: true }))
        .toBeVisible()
      mocks.change.mockRejectedValue(
        phase === 'mutation'
          ? denied()
          : new AutoOpsRequestError('版本发生变化，请刷新。', 'CONFLICT', 409),
      )
      if (phase === 'refresh') mocks.load.mockRejectedValue(denied())
      await page.getByRole('button', { name: 'skill操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '停用skill', exact: true }).click()
      await vi.waitFor(() =>
        expect(screen.container.textContent).toContain('当前账号已无权读取skill库。'),
      )
      await expect
        .element(page.getByRole('button', { name: '可撤权skill', exact: true }))
        .not.toBeInTheDocument()
      await expect
        .element(page.getByRole('button', { name: '导入skill', exact: true }))
        .not.toBeInTheDocument()
      expect(screen.container.querySelector('[data-skill-card]')).toBeNull()
      expect(mocks.change).toHaveBeenCalledTimes(1)
      expect(mocks.load).toHaveBeenCalledTimes(phase === 'mutation' ? 1 : 2)
    })
  }
})

describe('skill卡片就地分配', () => {
  for (const targetType of ['assistant', 'project', 'global'] as const) {
    it(`${targetType} 分组可直接分配与取消，状态以服务端返回为准`, async () => {
      const initial = catalog()
      initial.assistants = [
        { id: 'assistant-one', name: '隔离助手', projectId: 'p-one', executionKind: 'platform' },
      ]
      const assigned: SkillLibrary = {
        ...initial,
        revision: 'revision-two',
        assignments: [
          {
            id: 'assignment-one',
            skillId: 'skill-one',
            targetType,
            targetId:
              targetType === 'assistant'
                ? 'assistant-one'
                : targetType === 'global'
                  ? 'all-projects'
                  : 'p-one',
            versionId: 'version-one',
            ...(targetType === 'assistant' ? { projectId: 'p-one' } : {}),
            enabled: true,
          },
        ],
      }
      const accepted = deferred<SkillLibrary>()
      mocks.load.mockResolvedValue(initial)
      mocks.change.mockReturnValueOnce(accepted.promise).mockResolvedValueOnce(initial)
      await using screen = await render(library(), testLocation)
      if (targetType === 'assistant')
        await page.getByRole('button', { name: '指定助手：可撤权skill' }).click()
      const group =
        targetType === 'assistant'
          ? page.getByRole('dialog')
          : page.getByRole('group', { name: 'skill 启用范围', exact: true })
      const name =
        targetType === 'assistant' ? '隔离助手' : targetType === 'global' ? '所有项目' : '当前项目'
      const unassigned = group.getByRole('button', {
        name: `${name}：未启用`,
        exact: true,
      })
      await expect.element(unassigned).toHaveAttribute('aria-pressed', 'false')
      await unassigned.click()
      await expect.element(unassigned).toHaveAttribute('aria-busy', 'true')
      await expect.element(unassigned).toHaveAttribute('aria-pressed', 'false')
      await expect.element(unassigned).toBeDisabled()
      expect(mocks.change).toHaveBeenNthCalledWith(
        1,
        'revision-one',
        {
          action: 'assign',
          skillId: 'skill-one',
          targetType,
          targetId:
            targetType === 'assistant'
              ? 'assistant-one'
              : targetType === 'global'
                ? 'all-projects'
                : 'p-one',
          versionId: 'version-one',
          ...(targetType === 'assistant' ? { projectId: 'p-one' } : {}),
          enabled: true,
        },
        'p-one',
      )
      await act(() => accepted.resolve(assigned))
      const selected = group.getByRole('button', { name: `${name}：已启用`, exact: true })
      await expect.element(selected).toHaveAttribute('aria-pressed', 'true')
      await selected.click()
      await expect.element(unassigned).toHaveAttribute('aria-pressed', 'false')
      expect(mocks.change).toHaveBeenNthCalledWith(
        2,
        'revision-two',
        {
          action: 'unassign',
          assignmentId: 'assignment-one',
        },
        'p-one',
      )
      expect(screen.container.querySelector('[data-skill-card]')).not.toBeNull()
    })
  }

  it('分配失败保留未选状态、错误反馈及直接重试入口', async () => {
    const initial = catalog()
    mocks.load.mockResolvedValue(initial)
    mocks.change.mockRejectedValueOnce(
      new AutoOpsRequestError('网络中断，请重试。', 'NETWORK_ERROR', undefined),
    )
    await using screen = await render(library(), testLocation)
    const target = page
      .getByRole('group', { name: 'skill 启用范围', exact: true })
      .getByRole('button', { name: '当前项目：未启用', exact: true })
    await target.click()
    await vi.waitFor(() => expect(screen.container.textContent).toContain('网络中断，请重试。'))
    await expect.element(target).toHaveAttribute('aria-pressed', 'false')
    await expect.element(target).not.toBeDisabled()
    expect(mocks.change).toHaveBeenCalledTimes(1)
    mocks.change.mockResolvedValueOnce({
      ...initial,
      revision: 'revision-retry',
      assignments: [
        {
          id: 'assignment-retry',
          skillId: 'skill-one',
          targetType: 'project',
          targetId: 'p-one',
          versionId: 'version-one',
          enabled: true,
        },
      ],
    } satisfies SkillLibrary)
    await target.click()
    await expect
      .element(page.getByRole('button', { name: '当前项目：已启用', exact: true }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(mocks.change).toHaveBeenCalledTimes(2)
    expect(screen.container.textContent).not.toContain('网络中断，请重试。')
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function namedCatalog(name: string) {
  const value = catalog()
  value.skills[0]!.displayName = name
  value.revision = name
  return value
}
const library = () => (
  <SidebarProvider>
    <AutoOpsSkillLibraryPage />
  </SidebarProvider>
)
const testLocation = { router: '/skills?projectId=p-one&skillView=library' }

describe('skill目录控制器的跨页面隔离', () => {
  it('刷新会取消旧读取，即使旧请求迟到也不覆盖新目录', async () => {
    const earlier = deferred<SkillLibrary>()
    const current = deferred<SkillLibrary>()
    mocks.load.mockReset().mockReturnValueOnce(earlier.promise).mockReturnValueOnce(current.promise)
    await using screen = await render(library(), testLocation)
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1))
    const previousSignal = mocks.load.mock.calls[0]![0] as AbortSignal
    await act(() => window.dispatchEvent(new Event('autoops:skill-library-changed')))
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2))
    expect(previousSignal.aborted).toBe(true)
    await act(() => current.resolve(namedCatalog('新目录skill')))
    await expect
      .element(page.getByRole('button', { name: '新目录skill', exact: true }))
      .toBeVisible()
    await act(() => earlier.resolve(namedCatalog('过期目录skill')))
    expect(screen.container.textContent).not.toContain('过期目录skill')
    await expect
      .element(page.getByRole('button', { name: '新目录skill', exact: true }))
      .toBeVisible()
  })
  it('旧页面已经接受的写入完成后只刷新当前页，不把旧写入响应作为当前目录', async () => {
    const accepted = deferred<SkillLibrary>()
    mocks.change.mockReturnValue(accepted.promise)
    await using previous = await render(library(), testLocation)
    await expect.element(page.getByRole('button', { name: 'skill操作', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'skill操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '停用skill', exact: true }).click()
    await vi.waitFor(() => expect(mocks.change).toHaveBeenCalledTimes(1))
    const previousSignal = mocks.load.mock.calls[0]![0] as AbortSignal
    await previous.unmount()
    expect(previousSignal.aborted).toBe(true)
    mocks.load.mockResolvedValue(namedCatalog('当前页面skill'))
    await using current = await render(library(), testLocation)
    await expect
      .element(page.getByRole('button', { name: '当前页面skill', exact: true }))
      .toBeVisible()
    await act(() => accepted.resolve(namedCatalog('旧页面写入结果')))
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(3))
    expect(current.container.textContent).not.toContain('旧页面写入结果')
    await expect
      .element(page.getByRole('button', { name: '当前页面skill', exact: true }))
      .toBeVisible()
    expect(mocks.change).toHaveBeenCalledTimes(1)
  })
  it('写入冲突后的核对读取随页面离开取消，保留原写入次数', async () => {
    const checking = deferred<SkillLibrary>()
    mocks.change.mockRejectedValue(
      new AutoOpsRequestError('版本发生变化，请刷新。', 'CONFLICT', 409),
    )
    await using screen = await render(library(), testLocation)
    await expect.element(page.getByRole('button', { name: 'skill操作', exact: true })).toBeVisible()
    mocks.load.mockReturnValue(checking.promise)
    await page.getByRole('button', { name: 'skill操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '停用skill', exact: true }).click()
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2))
    const signal = mocks.load.mock.calls[1]![0] as AbortSignal
    expect(signal.aborted).toBe(false)
    await screen.unmount()
    expect(signal.aborted).toBe(true)
    await act(() => checking.resolve(catalog()))
    expect(mocks.change).toHaveBeenCalledTimes(1)
  })
})

for (const [width, theme] of [
  [1440, 'light'],
  [390, 'dark'],
] as const) {
  it(`${width}px ${theme}：继承状态、当前项目助手筛选与键盘返回`, async () => {
    await page.viewport(width, 560)
    document.documentElement.classList.toggle('dark', theme === 'dark')
    const value = catalog()
    value.assignments = [
      {
        id: 'global',
        skillId: 'skill-one',
        versionId: 'version-one',
        targetType: 'global',
        targetId: 'all-projects',
        enabled: true,
      },
    ]
    value.assistants = [
      {
        id: 'one',
        name: '本项目名称非常长的真实助手',
        projectId: 'p-one',
        executionKind: 'platform',
      },
      { id: 'other', name: '其他项目助手', projectId: 'p-two', executionKind: 'platform' },
    ]
    mocks.load.mockResolvedValue(value)
    try {
      await using screen = await render(library(), testLocation)
      const inherited = page.getByRole('button', {
        name: '当前项目：已继承 · 所有项目',
        exact: true,
      })
      await expect.element(inherited).toBeDisabled()
      await expect.element(inherited).toHaveAttribute('aria-pressed', 'true')
      const trigger = page.getByRole('button', { name: '指定助手：可撤权skill', exact: true })
      await trigger.click()
      await expect
        .element(
          page.getByRole('button', {
            name: '本项目名称非常长的真实助手：已继承 · 所有项目',
            exact: true,
          }),
        )
        .toBeDisabled()
      expect(document.body.textContent).not.toContain('其他项目助手')
      await page.getByRole('searchbox', { name: '搜索指定助手' }).fill('不存在')
      await expect.element(page.getByText('没有匹配的助手')).toBeVisible()
      await userEvent.keyboard('{Escape}')
      await expect.element(trigger).toHaveFocus()
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1)
      expect(
        screen.container.querySelectorAll('[data-skill-target-type] svg.lucide-check').length,
      ).toBe(0)
    } finally {
      document.documentElement.classList.remove('dark')
      await page.viewport(1280, 720)
    }
  })
}
