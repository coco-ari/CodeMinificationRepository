import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { EnvironmentId, ProviderInstanceId, ThreadId } from '@t3tools/contracts'
import { scopedThreadKey, scopeThreadRef } from '@t3tools/client-runtime/environment'
import { fakeTimers, render, stubGlobal } from '../../test/render'
import { DraftId, useComposerDraftStore } from '~/composerDraftStore'
import { useRightPanelStore } from '~/rightPanelStore'
import { AutoOpsThreadScopeControl } from './ThreadScopeControl'
import {
  installAutoOpsHost,
  readAutoOpsThreadScope,
  scopeFromAssistant,
  setAutoOpsThreadScope,
  type AutoOpsT3Bootstrap,
} from './hostConfig'
import { questionSendDisabledReason } from './questionConfiguration'
import type { AssistantPreset } from './projectAssistants'
import '../index.css'
const mock = vi.hoisted(() => ({ createThread: vi.fn() }))
vi.mock(import('~/hooks/useHandleNewThread'), () => ({
  useNewThreadHandler: () => mock.createThread,
}))
function setup(adjust: boolean, threadId: string, missingDefault = false, isDraft = true) {
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
        isDraft={isDraft}
        runtimeEnvironmentId={EnvironmentId.make('assistant-runtime')}
        draftTarget={DraftId.make(threadId)}
        submitting={false}
        hasAcceptedMessage={false}
      />
    ),
  }
}

it('受限成员自动载入默认助手，参数可见但没有范围调整入口，仍能切换已分配助手', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  await page.viewport(1280, 800)
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
  await screen.getByRole('button', { name: '助手预设', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '外部资料', exact: true }).click()
  await page.viewport(390, 500)
  await expect.element(screen.getByRole('button', { name: '助手预设', exact: true })).toHaveFocus()
  await userEvent.tab({ shift: true })
  await expect.element(screen.getByLabelText('资料范围', { exact: true })).toHaveFocus()
  await expect
    .element(page.getByRole('tooltip'))
    .toHaveTextContent('外部资料 · 由项目管理员设置')
  const scope = readAutoOpsThreadScope(id, 'assistant-project')!
  expect(scope.question?.assistantId).toBe('second')
  expect(scope.environmentId).toBeNull()
  expect(scope.question?.configuration.model.model).toBe('second-model')
  expect(questionSendDisabledReason(scope)).toBeNull()
  expect(mock.createThread).not.toHaveBeenCalled()
})

it('有调整权者更改范围后，重新选择助手整体重载原预设并替换覆盖值', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const id = 'adjustable-assistant-draft',
    f = setup(true, id)
  await using screen = await render(f.ui)
  useComposerDraftStore.getState().setModelSelection(
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
  await screen.getByRole('button', { name: '助手预设', exact: true }).click()
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

it('默认缺失不常驻提示，保留候选且不会把首个助手当成可发送配置', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const id = 'missing-default-draft',
    f = setup(false, id, true)
  await using screen = await render(f.ui)
  await expect.element(screen.getByText('请管理员配置默认助手')).not.toBeInTheDocument()
  expect(readAutoOpsThreadScope(id, 'assistant-project')?.question).toBeUndefined()
  await screen.getByRole('button', { name: '助手预设', exact: true }).click()
  await expect
    .element(page.getByRole('menuitemradio', { name: '测试排障', exact: true }))
    .toBeVisible()
  await page.getByRole('menuitemradio', { name: '测试排障', exact: true }).click()
  expect(questionSendDisabledReason(readAutoOpsThreadScope(id, 'assistant-project'))).toBe(
    '请管理员配置默认助手',
  )
})

it('直接配置可载入预设并返回，保留合法范围和模型，清除助手来源与专属skill', async () => {
  const id = 'direct-preset-roundtrip', f = setup(true, id, true)
  await using screen = await render(f.ui)
  const assistant = screen.getByRole('button', { name: '助手预设', exact: true })
  await expect.element(assistant).toHaveTextContent('助手预设')
  expect(readAutoOpsThreadScope(id, 'assistant-project')?.question?.assistantId).toBeNull()
  await assistant.click()
  await page.getByRole('menuitemradio', { name: '测试排障', exact: true }).click()
  expect(readAutoOpsThreadScope(id, 'assistant-project')?.question?.assistantId).toBe('first')
  await assistant.click()
  await page.getByRole('menuitem', { name: '取消使用预设', exact: true }).click()
  expect(readAutoOpsThreadScope(id, 'assistant-project')).toMatchObject({ environmentId: 'test', workspaceType: 'internal',
    question: { assistantId: null, presetRevision: null, configuration: { model: { model: 'first-model', reasoningEffort: 'high' }, skillIds: [] } } })
  expect(questionSendDisabledReason(readAutoOpsThreadScope(id, 'assistant-project'))).toBeNull()
  expect(mock.createThread).not.toHaveBeenCalled()
})

it.each([true, false])('移除重复skill控件后保留配置、正文与预览，草稿=%s', async (isDraft) => {
  const id = `inline-only-${isDraft}`, f = setup(true, id, false, isDraft)
  const preset = f.host.projects[0]!.assistants!.items[0]!.preset
  const original = {...scopeFromAssistant(preset), scopeState: 'draft' as const, scopeLocked: false,
    question: {assistantId: preset.id, presetRevision: preset.revision,
      configuration: {...preset.configuration, skillIds: ['read-logs']}}}
  setAutoOpsThreadScope(id, original)
  const draftId = DraftId.make(id), store = useComposerDraftStore.getState()
  const ref = scopeThreadRef(EnvironmentId.make('assistant-runtime'), ThreadId.make(id))
  store.setPrompt(draftId, '保留 $read-logs 与正文')
  useRightPanelStore.getState().openFile(ref, 'original.txt')
  const draft = store.getComposerDraft(draftId)
  const preview = structuredClone(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)])
  using _fetch = stubGlobal('fetch', vi.fn(async () => Response.json({binding: original})))
  await using screen = await render(f.ui)
  await expect.element(screen.getByRole('button', {name: '助手预设', exact: true})).toBeVisible()
  await expect.element(screen.getByRole('button', {name: 'skill', exact: true})).not.toBeInTheDocument()
  expect(readAutoOpsThreadScope(id, preset.projectId)?.question).toEqual(original.question)
  expect(store.getComposerDraft(draftId)).toMatchObject({prompt: draft?.prompt, files: draft?.files, images: draft?.images})
  expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]).toEqual(preview)
  expect(mock.createThread).not.toHaveBeenCalled()
  store.clearDraftThread(draftId)
  useRightPanelStore.getState().closeAllSurfaces(ref)
})

it('已接受消息后显示实际助手，禁止选择和刷新，三个控件宽度一致', async () => {
  await page.viewport(1280, 800)
  const id = 'accepted-assistant', f = setup(true, id, false, false)
  const preset = f.host.projects[0]!.assistants!.items[0]!.preset
  const original = {...scopeFromAssistant(preset), scopeState: 'locked' as const, scopeLocked: true}
  setAutoOpsThreadScope(id, original)
  using _fetch = stubGlobal('fetch', vi.fn(async () => Response.json({binding: original})))
  await using screen = await render(f.ui)
  await expect.element(screen.getByLabelText('助手预设', {exact:true})).toBeVisible()
  await expect.element(screen.getByLabelText('助手预设', {exact:true})).toHaveTextContent('测试排障')
  await screen.getByLabelText('助手预设', {exact:true}).click()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByRole('menuitem', {name: '刷新助手'})).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', {name: '助手预设', exact:true})).not.toBeInTheDocument()
  const widths = ['助手预设','资料范围','业务环境'].map(name => screen.getByLabelText(name,{exact:true}).element().getBoundingClientRect().width)
  expect(Math.max(...widths)-Math.min(...widths)).toBeLessThanOrEqual(1)
  expect(readAutoOpsThreadScope(id, preset.projectId)?.question).toEqual(original.question)
})
