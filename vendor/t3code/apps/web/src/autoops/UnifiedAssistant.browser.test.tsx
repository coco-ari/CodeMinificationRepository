import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { EnvironmentId, ProviderInstanceId } from '@t3tools/contracts'
import { render } from '../../test/render'
import { DraftId, useComposerDraftStore } from '~/composerDraftStore'
import { AutoOpsThreadScopeControl } from './ThreadScopeControl'
import { installAutoOpsHost, readAutoOpsThreadScope, type AutoOpsT3Bootstrap } from './hostConfig'
import { questionSendDisabledReason } from './questionConfiguration'
import type { AssistantPreset } from './projectAssistants'
import '../index.css'
const mock = vi.hoisted(() => ({ createThread: vi.fn() }))
vi.mock(import('~/hooks/useHandleNewThread'), () => ({
  useNewThreadHandler: () => mock.createThread,
}))
function setup(adjust: boolean, threadId: string, missingDefault = false) {
  mock.createThread.mockReset()
  const preset: AssistantPreset = {
    id: 'first',
    projectId: 'assistant-project',
    name: '测试排障',
    description: '',
    instructions: '',
    enabled: true,
    revision: 1,
    createdBy: 'admin',
    updatedAt: 'now',
    configuration: {
      agentId: 'a-project',
      executionBinding: { kind: 'platform' },
      environmentId: 'test',
      workspaceType: 'internal',
      visibility: 'private',
      model: { instanceId: 'codex', model: 'first-model', reasoningEffort: 'high' },
      skillIds: [],
    },
  }
  const second: AssistantPreset = {
    ...preset,
    id: 'second',
    name: '外部资料',
    configuration: {
      ...preset.configuration,
      environmentId: null,
      workspaceType: 'external',
      model: { instanceId: 'codex', model: 'second-model', reasoningEffort: 'low' },
    },
  }
  const host: AutoOpsT3Bootstrap = {
    principal: { id: 'assistant-user', displayName: '助手用户' },
    csrfToken: 'csrf',
    gatewayBasePath: '/api/agent-demo/t3',
    fixedModel: { instanceId: 'codex', model: 'wrong-default' },
    runtimeMode: 'approval-required',
    assistantDirectoryEnabled: true,
    capabilities: {},
    projects: [
      {
        id: preset.projectId,
        name: '项目',
        agents: [{ id: 'a-project', name: '项目业务助手' }],
        environments: [{ id: 'test', name: '测试环境' }],
        capabilities: {
          'workspace.read': true,
          'workspace.manage': false,
          'deployment.read': false,
          'deployment.execute': false,
          'chat.configure': adjust,
        },
        membership: {
          workspaceAccess: 'internal',
          role: 'reader',
          environmentIds: ['test'],
          canAdjustChat: adjust,
        },
        assistants: {
          items: [preset, second].map((preset) => ({ preset, available: true })),
          canAdjust: adjust,
          ready: !missingDefault || adjust,
          defaultAssistantId: missingDefault ? null : preset.id,
          ...(missingDefault
            ? { reason: { code: 'DEFAULT_ASSISTANT_REQUIRED', message: '请管理员配置默认助手' } }
            : {}),
        },
      },
    ],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('skill-library'))
        return Response.json({
          revision: 'skills',
          canManage: false,
          skills: [
            {
              id: 'read-logs',
              name: 'read-logs',
              displayName: '日志分析',
              enabled: true,
              versions: [{ id: 'v1', readiness: 'ready' }],
            },
          ],
          assignments: [
            {
              targetType: 'project',
              targetId: preset.projectId,
              skillId: 'read-logs',
              versionId: 'v1',
              workspaceTypes: ['internal'],
              enabled: true,
            },
          ],
          projects: [],
          agents: [],
        })
      throw new Error('未预期的请求')
    }),
  )
  installAutoOpsHost(host, window.location.origin)
  return {
    host,
    ui: (
      <AutoOpsThreadScopeControl
        threadId={threadId}
        projectId={preset.projectId}
        isDraft
        runtimeEnvironmentId={EnvironmentId.make('assistant-runtime')}
        draftTarget={DraftId.make(threadId)}
        submitting={false}
        hasAcceptedMessage={false}
      />
    ),
  }
}

it('受限成员自动载入默认助手，参数可见但没有范围调整入口，仍能切换已分配助手', async () => {
  const id = 'limited-assistant-draft',
    f = setup(false, id)
  await using screen = await render(f.ui)
  await expect.element(screen.getByText('测试环境', { exact: true })).toBeVisible()
  await expect
    .element(screen.getByRole('button', { name: '业务环境', exact: true }))
    .not.toBeInTheDocument()
  await expect
    .element(screen.getByRole('button', { name: '会话可见范围', exact: true }))
    .not.toBeInTheDocument()
  await screen.getByRole('button', { name: '助手', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '外部资料', exact: true }).click()
  await expect.element(screen.getByText('外部当前资料', { exact: true })).toBeVisible()
  const scope = readAutoOpsThreadScope(id, 'assistant-project')!
  expect(scope.question?.assistantId).toBe('second')
  expect(scope.environmentId).toBeNull()
  expect(scope.question?.configuration.model.model).toBe('second-model')
  expect(questionSendDisabledReason(scope)).toBeNull()
  expect(mock.createThread).not.toHaveBeenCalled()
})

it('有调整权者更改范围后，重新选择助手整体重载原预设并替换覆盖值', async () => {
  const id = 'adjustable-assistant-draft',
    f = setup(true, id)
  await using screen = await render(f.ui)
  useComposerDraftStore
    .getState()
    .setModelSelection(
      DraftId.make(id),
      {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'first-model',
        options: [{ id: 'reasoningEffort', value: 'low' }],
      },
      { replaceOptions: true },
    )
  await screen.getByRole('button', { name: '业务环境', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '无环境', exact: true }).click()
  expect(
    readAutoOpsThreadScope(id, 'assistant-project')?.question?.configuration.environmentId,
  ).toBeNull()
  expect(
    useComposerDraftStore.getState().getComposerDraft(DraftId.make(id))?.modelSelectionByProvider?.[
      ProviderInstanceId.make('codex')
    ]?.options,
  ).toEqual([{ id: 'reasoningEffort', value: 'low' }])
  await screen.getByRole('button', { name: '助手', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '测试排障', exact: true }).click()
  await expect
    .element(screen.getByRole('button', { name: '业务环境', exact: true }))
    .toHaveTextContent('测试环境')
  expect(readAutoOpsThreadScope(id, 'assistant-project')?.question?.configuration.model.model).toBe(
    'first-model',
  )
  const saved = useComposerDraftStore.getState().getComposerDraft(DraftId.make(id))
  expect(saved?.modelSelectionByProvider?.[ProviderInstanceId.make('codex')]).toMatchObject({
    model: 'first-model',
    options: [{ id: 'reasoningEffort', value: 'high' }],
  })
})

it('默认缺失展示真实原因及候选，不将首个助手或平台默认当成可发送配置', async () => {
  const id = 'missing-default-draft',
    f = setup(false, id, true)
  await using screen = await render(f.ui)
  await expect.element(screen.getByText('请管理员配置默认助手')).toBeVisible()
  expect(readAutoOpsThreadScope(id, 'assistant-project')?.question).toBeUndefined()
  await screen.getByRole('button', { name: '助手', exact: true }).click()
  await expect
    .element(page.getByRole('menuitemradio', { name: '测试排障', exact: true }))
    .toBeVisible()
  await page.getByRole('menuitemradio', { name: '测试排障', exact: true }).click()
  expect(questionSendDisabledReason(readAutoOpsThreadScope(id, 'assistant-project'))).toBe(
    '请管理员配置默认助手',
  )
})

it('技能选择使用授权目录且保留当前模型，菜单取消与空选不回退', async () => {
  const id = 'assistant-skills-draft',
    f = setup(true, id)
  await using screen = await render(f.ui)
  await screen.getByRole('button', { name: '技能', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: '日志分析', exact: true }).click()
  expect(readAutoOpsThreadScope(id, 'assistant-project')?.question?.configuration.skillIds).toEqual(
    ['read-logs'],
  )
  await screen.getByRole('button', { name: '技能', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: '日志分析', exact: true }).click()
  expect(readAutoOpsThreadScope(id, 'assistant-project')?.question?.configuration.skillIds).toEqual(
    [],
  )
  expect(readAutoOpsThreadScope(id, 'assistant-project')?.question?.configuration.model.model).toBe(
    'first-model',
  )
  await screen.getByRole('button', { name: '技能', exact: true }).click()
  await userEvent.keyboard('{Escape}')
  await expect.element(screen.getByRole('button', { name: '技能', exact: true })).toHaveFocus()
})
