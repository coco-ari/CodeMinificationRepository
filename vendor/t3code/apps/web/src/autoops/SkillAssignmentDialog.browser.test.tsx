import { expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { render } from '../../test/render'
import { SkillAssignmentDialog } from './SkillLibraryDialogs'
import type { SkillLibrary } from './skillLibrary'
import '../index.css'
const catalog: SkillLibrary = {
  revision: 'one',
  canManage: true,
  projects: [
    { id: 'p-one', name: '项目一', canManage: true },
    { id: 'p-two', name: '项目二', canManage: true },
  ],
  assistants: [
    { id: 'assistant-one', name: '真实助手', projectId: 'p-one', executionKind: 'platform' },
  ],
  assignments: [],
  skills: [
    {
      id: 'skill',
      name: 'test',
      displayName: '验收skill',
      description: '',
      enabled: true,
      latestVersionId: 'version',
      versions: [
        {
          id: 'version',
          createdAt: '2026-10-24T00:00:00Z',
          readiness: 'ready',
          reason: null,
          contentHash: 'test',
          fileCount: 1,
          byteLength: 1,
          source: { type: 'builtin' },
          files: [],
        },
      ],
    },
  ],
}
it('当前项目启用固定版本不再要求选择工作区', async () => {
  const mutate = vi.fn().mockResolvedValue(true)
  await using _screen = await render(
    <SkillAssignmentDialog
      catalog={catalog}
      projectId="p-one"
      initialSkillId="skill"
      initialTargetType="project"
      initialTargetId="p-one"
      busy={false}
      error={null}
      onClose={() => {}}
      finalFocus={() => null}
      mutate={mutate}
    />,
  )
  await page.getByRole('button', { name: '保存范围' }).click()
  expect(mutate).toHaveBeenCalledWith(
    {
      action: 'assign',
      skillId: 'skill',
      versionId: 'version',
      targetType: 'project',
      targetId: 'p-one',
      enabled: true,
    },
    expect.any(String),
  )
})
it('再次调整停用分配时，不会无意重新启用', async () => {
  const mutate = vi.fn().mockResolvedValue(true)
  await using _screen = await render(
    <SkillAssignmentDialog
      catalog={catalog}
      projectId="p-one"
      assignment={{
        id: 'assignment',
        skillId: 'skill',
        versionId: 'version',
        targetType: 'project',
        targetId: 'p-one',
        enabled: false,
      }}
      busy={false}
      error={null}
      onClose={() => {}}
      finalFocus={() => null}
      mutate={mutate}
    />,
  )
  await page.getByRole('button', { name: '保存范围' }).click()
  expect(mutate.mock.calls[0]?.[0]).toMatchObject({ targetId: 'p-one', enabled: false })
})

it('所有项目开启后项目显示继承，不能用下层关闭覆盖上层', async () => {
  const mutate = vi.fn()
  await using _screen = await render(
    <SkillAssignmentDialog
      catalog={{
        ...catalog,
        assignments: [
          {
            id: 'global',
            skillId: 'skill',
            versionId: 'version',
            targetType: 'global',
            targetId: 'all-projects',
            enabled: true,
          },
        ],
      }}
      projectId="p-one"
      initialSkillId="skill"
      initialTargetType="project"
      busy={false}
      error={null}
      onClose={() => {}}
      finalFocus={() => null}
      mutate={mutate}
    />,
  )
  expect(page.getByRole('status').element().textContent).toContain('已继承“所有项目”')
  await expect.element(page.getByRole('button', { name: '保存范围' })).toBeDisabled()
  expect(mutate).not.toHaveBeenCalled()
})
