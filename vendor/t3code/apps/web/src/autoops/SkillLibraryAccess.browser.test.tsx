import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { EnvironmentId } from '@t3tools/contracts'
import { useLayoutEffect } from 'react'
import { act, render, stubGlobal } from '../../test/render'
import { AppSidebarLayout } from '~/components/AppSidebarLayout'
import { readAppearanceModePreference, readThemePreference, useTheme } from '~/hooks/useTheme'
import { SidebarProvider } from '~/components/ui/sidebar'
import { AutoOpsSkillLibraryPage } from './SkillLibraryPage'
import { AutoOpsRequestError } from './apiClient'
import { autoOpsStorage, installAutoOpsHost } from './hostConfig'
import type { SkillLibrary } from './skillLibrary'
import '../index.css'
import './theme.css'

const mocks = vi.hoisted(() => ({ load: vi.fn(), change: vi.fn(), search: vi.fn(), host: vi.fn() }))
vi.mock(import('../localEnvironment'), () => ({ isLocalEnvironmentDisabled: () => true }))
vi.mock(import('../state/environments'), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make('isolated-skills'),
}))
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
  projects: [{ id: 'p-one', name: '隔离项目' }],
  agents: [],
  assignments: [],
  skills: [
    {
      id: 'skill-one',
      name: 'isolated-skill',
      displayName: '可撤权技能',
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
const denied = () => new AutoOpsRequestError('当前账号已无权读取技能库。', 'ACCESS_DENIED', 403)
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
describe('技能库写入后的撤权处理', () => {
  for (const phase of ['mutation', 'refresh'] as const) {
    it(phase + ' 撤权会清除旧目录与操作入口', async () => {
      await using screen = await render(
        <SidebarProvider>
          <AutoOpsSkillLibraryPage />
        </SidebarProvider>,
        { router: '/skills?projectId=p-one&skillView=library' },
      )
      await expect
        .element(page.getByRole('button', { name: '可撤权技能', exact: true }))
        .toBeVisible()
      mocks.change.mockRejectedValue(
        phase === 'mutation'
          ? denied()
          : new AutoOpsRequestError('版本发生变化，请刷新。', 'CONFLICT', 409),
      )
      if (phase === 'refresh') mocks.load.mockRejectedValue(denied())
      await page.getByRole('button', { name: '技能操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '停用技能', exact: true }).click()
      await vi.waitFor(() =>
        expect(screen.container.textContent).toContain('当前账号已无权读取技能库。'),
      )
      await expect
        .element(page.getByRole('button', { name: '可撤权技能', exact: true }))
        .not.toBeInTheDocument()
      await expect
        .element(page.getByRole('button', { name: '导入技能', exact: true }))
        .not.toBeInTheDocument()
      expect(screen.container.querySelector('[data-skill-card]')).toBeNull()
      expect(mocks.change).toHaveBeenCalledTimes(1)
      expect(mocks.load).toHaveBeenCalledTimes(phase === 'mutation' ? 1 : 2)
    })
  }
})

describe('技能卡片就地分配', () => {
  for (const targetType of ['agent', 'project'] as const) {
    it(`${targetType} 分组可直接分配与取消，状态以服务端返回为准`, async () => {
      const initial = catalog()
      initial.agents = [{ id: 'agent-one', name: '隔离助手', projectIds: ['p-one'] }]
      const assigned: SkillLibrary = {
        ...initial,
        revision: 'revision-two',
        assignments: [
          {
            id: 'assignment-one',
            skillId: 'skill-one',
            targetType,
            targetId: targetType === 'agent' ? 'agent-one' : 'p-one',
            versionId: 'version-one',
            workspaceTypes: ['internal'],
            enabled: true,
          },
        ],
      }
      const accepted = deferred<SkillLibrary>()
      mocks.load.mockResolvedValue(initial)
      mocks.change.mockReturnValueOnce(accepted.promise).mockResolvedValueOnce(initial)
      await using screen = await render(library(), testLocation)
      const group = page.getByRole('group', {
        name: targetType === 'agent' ? '助手分配' : '项目分配摘要',
        exact: true,
      })
      const name = targetType === 'agent' ? '隔离助手' : '隔离项目'
      const unassigned = group.getByRole('button', {
        name: `${name}：${targetType === 'agent' ? '尚未分配' : '沿用助手设置'}`,
        exact: true,
      })
      await expect.element(unassigned).toHaveAttribute('aria-pressed', 'false')
      await unassigned.click()
      await expect.element(unassigned).toHaveAttribute('aria-busy', 'true')
      await expect.element(unassigned).toHaveAttribute('aria-pressed', 'false')
      await expect.element(unassigned).toBeDisabled()
      expect(mocks.change).toHaveBeenNthCalledWith(1, 'revision-one', {
        action: 'assign',
        skillId: 'skill-one',
        targetType,
        targetId: targetType === 'agent' ? 'agent-one' : 'p-one',
        versionId: 'version-one',
        workspaceTypes: ['internal'],
        enabled: true,
      })
      await act(() => accepted.resolve(assigned))
      const selected = group.getByRole('button', { name: `${name}：内部 · version-`, exact: true })
      await expect.element(selected).toHaveAttribute('aria-pressed', 'true')
      await selected.click()
      await expect.element(unassigned).toHaveAttribute('aria-pressed', 'false')
      expect(mocks.change).toHaveBeenNthCalledWith(2, 'revision-two', {
        action: 'unassign',
        assignmentId: 'assignment-one',
      })
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
      .getByRole('group', { name: '项目分配摘要', exact: true })
      .getByRole('button', { name: '隔离项目：沿用助手设置', exact: true })
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
          workspaceTypes: ['internal'],
          enabled: true,
        },
      ],
    } satisfies SkillLibrary)
    await target.click()
    await expect
      .element(page.getByRole('button', { name: '隔离项目：内部 · version-', exact: true }))
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

function LibraryShell({ dark }: { dark: boolean }) {
  const { setAppearanceMode } = useTheme()
  useLayoutEffect(() => {
    const previous = readAppearanceModePreference(readThemePreference())
    setAppearanceMode(dark ? 'dark' : 'light')
    return () => {
      setAppearanceMode(previous)
    }
  }, [dark, setAppearanceMode])
  return (
    <AppSidebarLayout>
      <AutoOpsSkillLibraryPage />
    </AppSidebarLayout>
  )
}

describe('技能库连续查找', () => {
  it.each([
    { width: 1440, dark: false },
    { width: 390, dark: true },
  ])('$width px 关闭侧栏仍能搜索、清空、浏览返回并就地分配', async ({ width, dark }) => {
    const previousViewport = { width: window.innerWidth, height: window.innerHeight }
    mocks.host.mockReturnValue(installAutoOpsHost(mocks.host(), window.location.origin))
    const storage = autoOpsStorage(localStorage)
    const previousSidebar = storage.getItem('autoops.workspace-sidebar-open')
    await page.viewport(width, 600)
    storage.setItem('autoops.workspace-sidebar-open', 'false')
    try {
      const initial = catalog()
      initial.skills = Array.from({ length: 18 }, (_, index) => ({
        ...initial.skills[0]!,
        id: `skill-${index}`,
        name: `skill-${index}`,
        displayName: `项目部署与数据库排障技能 ${index + 1} · 面向测试环境的完整操作指南`,
      }))
      mocks.load.mockResolvedValue(initial)
      await using screen = await render(<LibraryShell dark={dark} />, testLocation)
      const title = screen.getByRole('button', {
        name: initial.skills[0]!.displayName,
        exact: true,
      })
      await expect.element(title).toBeVisible()
      await page.screenshot({
        path: `../../.test-artifacts/ui-skills-deployment/skills-${width}.png`,
      })
      const search = screen.getByRole('searchbox', { name: '搜索技能', exact: true })
      await expect.element(search).toBeInViewport()
      await search.fill('技能 18')
      await expect.element(title).not.toBeInTheDocument()
      await expect
        .element(screen.getByRole('button', { name: initial.skills[17]!.displayName, exact: true }))
        .toBeVisible()
      expect(mocks.load).toHaveBeenCalledTimes(1)
      expect(mocks.change).not.toHaveBeenCalled()
      await search.fill('没有这个技能')
      await expect.element(screen.getByText('没有匹配的技能', { exact: true })).toBeVisible()
      await screen.getByRole('button', { name: '清空技能搜索', exact: true }).click()
      await expect.element(search).toHaveValue('')
      await expect.element(search).toHaveFocus()
      await expect.element(title).toBeVisible()
      const viewport = screen.container.querySelector(
        '[aria-label="技能列表"] [data-slot="scroll-area-viewport"]',
      )!
      await act(() => {
        viewport.scrollTop = viewport.scrollHeight
      })
      await expect.element(search).toBeVisible()
      expect(search.element().getBoundingClientRect().bottom).toBeLessThan(600)
      expect(screen.container.scrollWidth).toBeLessThanOrEqual(width)
      expect(mocks.load).toHaveBeenCalledTimes(1)
      expect(mocks.change).not.toHaveBeenCalled()

      await search.fill('技能 1')
      const last = screen.getByRole('button', {
        name: initial.skills[17]!.displayName,
        exact: true,
      })
      using content = stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input), window.location.origin)
          if (url.pathname.endsWith('/skill-17/versions/version-one/content')) {
            return new Response('# 隔离技能正文\n\n核对测试环境后读取部署日志。', {
              headers: { 'Content-Type': 'text/markdown' },
            })
          }
          throw new Error(`未预期的测试请求：${url.pathname}`)
        }),
      )
      await act(() => {
        last.element().focus()
      })
      const scrollTop = viewport.scrollTop
      await userEvent.keyboard('{Enter}')
      await vi.waitFor(() => expect(screen.container.textContent).toContain('隔离技能正文'))
      await screen.getByRole('button', { name: '返回技能库', exact: true }).click()
      await expect.element(last).toHaveFocus()
      await expect.element(search).toHaveValue('技能 1')
      await vi.waitFor(() =>
        expect(Math.abs(viewport.scrollTop - scrollTop)).toBeLessThanOrEqual(1),
      )
      mocks.change.mockResolvedValueOnce({
        ...initial,
        revision: 'revision-assigned',
        assignments: [
          {
            id: 'assignment-17',
            skillId: 'skill-17',
            targetType: 'project',
            targetId: 'p-one',
            versionId: 'version-one',
            workspaceTypes: ['internal'],
            enabled: true,
          },
        ],
      } satisfies SkillLibrary)
      const card = page.elementLocator(
        screen.container.querySelector('[data-skill-card="skill-17"]')!,
      )
      await card.getByRole('button', { name: '隔离项目：沿用助手设置', exact: true }).click()
      await expect
        .element(card.getByRole('button', { name: '隔离项目：内部 · version-', exact: true }))
        .toHaveAttribute('aria-pressed', 'true')
      expect(mocks.change).toHaveBeenCalledTimes(1)
      expect(mocks.load).toHaveBeenCalledTimes(1)
      await expect.element(search).toHaveValue('技能 1')
    } finally {
      if (previousSidebar === null) storage.removeItem('autoops.workspace-sidebar-open')
      else storage.setItem('autoops.workspace-sidebar-open', previousSidebar)
      await page.viewport(previousViewport.width, previousViewport.height)
    }
  })
})
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

describe('技能目录控制器的跨页面隔离', () => {
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
    await act(() => current.resolve(namedCatalog('新目录技能')))
    await expect
      .element(page.getByRole('button', { name: '新目录技能', exact: true }))
      .toBeVisible()
    await act(() => earlier.resolve(namedCatalog('过期目录技能')))
    expect(screen.container.textContent).not.toContain('过期目录技能')
    await expect
      .element(page.getByRole('button', { name: '新目录技能', exact: true }))
      .toBeVisible()
  })
  it('旧页面已经接受的写入完成后只刷新当前页，不把旧写入响应作为当前目录', async () => {
    const accepted = deferred<SkillLibrary>()
    mocks.change.mockReturnValue(accepted.promise)
    await using previous = await render(library(), testLocation)
    await expect.element(page.getByRole('button', { name: '技能操作', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '技能操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '停用技能', exact: true }).click()
    await vi.waitFor(() => expect(mocks.change).toHaveBeenCalledTimes(1))
    const previousSignal = mocks.load.mock.calls[0]![0] as AbortSignal
    await previous.unmount()
    expect(previousSignal.aborted).toBe(true)
    mocks.load.mockResolvedValue(namedCatalog('当前页面技能'))
    await using current = await render(library(), testLocation)
    await expect
      .element(page.getByRole('button', { name: '当前页面技能', exact: true }))
      .toBeVisible()
    await act(() => accepted.resolve(namedCatalog('旧页面写入结果')))
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(3))
    expect(current.container.textContent).not.toContain('旧页面写入结果')
    await expect
      .element(page.getByRole('button', { name: '当前页面技能', exact: true }))
      .toBeVisible()
    expect(mocks.change).toHaveBeenCalledTimes(1)
  })
  it('写入冲突后的核对读取随页面离开取消，保留原写入次数', async () => {
    const checking = deferred<SkillLibrary>()
    mocks.change.mockRejectedValue(
      new AutoOpsRequestError('版本发生变化，请刷新。', 'CONFLICT', 409),
    )
    await using screen = await render(library(), testLocation)
    await expect.element(page.getByRole('button', { name: '技能操作', exact: true })).toBeVisible()
    mocks.load.mockReturnValue(checking.promise)
    await page.getByRole('button', { name: '技能操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '停用技能', exact: true }).click()
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2))
    const signal = mocks.load.mock.calls[1]![0] as AbortSignal
    expect(signal.aborted).toBe(false)
    await screen.unmount()
    expect(signal.aborted).toBe(true)
    await act(() => checking.resolve(catalog()))
    expect(mocks.change).toHaveBeenCalledTimes(1)
  })
})
