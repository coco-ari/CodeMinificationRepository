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
    { id: 'p-one', name: '项目一' },
    { id: 'p-two', name: '项目二' },
  ],
  agents: [],
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
it('可以仅在所选项目停用skill并保留固定版本和范围', async () => {
  const mutate = vi.fn().mockResolvedValue(true)
  await using _screen = await render(
    <SkillAssignmentDialog
      catalog={catalog}
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
  await page.getByRole('combobox', { name: '项目skill使用方式' }).click()
  await page.getByRole('option', { name: '在此项目停用，阻止助手继承' }).click()
  await page.getByRole('button', { name: '保存分配' }).click()
  expect(mutate).toHaveBeenCalledWith(
    {
      action: 'assign',
      skillId: 'skill',
      versionId: 'version',
      targetType: 'project',
      targetId: 'p-one',
      workspaceTypes: ['internal'],
      enabled: false,
    },
    expect.any(String),
  )
})
it('再次调整停用分配时，不会无意重新启用', async () => {
  const mutate = vi.fn().mockResolvedValue(true)
  await using _screen = await render(
    <SkillAssignmentDialog
      catalog={catalog}
      assignment={{
        id: 'assignment',
        skillId: 'skill',
        versionId: 'version',
        targetType: 'project',
        targetId: 'p-one',
        workspaceTypes: ['internal'],
        enabled: false,
      }}
      busy={false}
      error={null}
      onClose={() => {}}
      finalFocus={() => null}
      mutate={mutate}
    />,
  )
  await page.getByRole('button', { name: '保存分配' }).click()
  expect(mutate.mock.calls[0]?.[0]).toMatchObject({ targetId: 'p-one', enabled: false })
})
