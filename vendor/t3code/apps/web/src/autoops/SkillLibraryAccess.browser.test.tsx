import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { render } from '../../test/render'
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
