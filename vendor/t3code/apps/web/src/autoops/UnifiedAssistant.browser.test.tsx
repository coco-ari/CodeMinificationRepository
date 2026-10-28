import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { EnvironmentId, ProviderInstanceId, ThreadId } from '@t3tools/contracts'
import { scopedThreadKey, scopeThreadRef } from '@t3tools/client-runtime/environment'
import { act, fakeTimers, render, stubGlobal } from '../../test/render'
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
  await screen.getByRole('button', { name: '助手', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '外部资料', exact: true }).click()
  await page.viewport(390, 500)
  await expect.element(screen.getByRole('button', { name: '助手', exact: true })).toHaveFocus()
  await userEvent.tab()
  await expect.element(screen.getByLabelText('资料范围', { exact: true })).toHaveFocus()
  await expect
    .element(page.getByRole('tooltip'))
    .toHaveTextContent('外部当前资料 · 由项目管理员设置')
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

it('默认缺失不常驻提示，保留候选且不会把首个助手当成可发送配置', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const id = 'missing-default-draft',
    f = setup(false, id, true)
  await using screen = await render(f.ui)
  await expect.element(screen.getByText('请管理员配置默认助手')).not.toBeInTheDocument()
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
  using _timers = fakeTimers({ shouldAdvanceTime: true })
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

it.each([
  ['普通草稿', true],
  ['非草稿会话', false],
] as const)('技能目录整理保留已有正文附件和预览：%s不跳新空草稿', async (_label, isDraft) => {
  const id = isDraft ? 'reconcile-owned-draft' : 'reconcile-owned-thread'
  const f = setup(true, id, false, isDraft)
  const preset = f.host.projects[0]!.assistants!.items[0]!.preset
  const original = {
    ...scopeFromAssistant(preset),
    scopeState: 'draft' as const,
    scopeLocked: false,
    question: {
      assistantId: preset.id,
      presetRevision: preset.revision,
      configuration: { ...preset.configuration, skillIds: ['read-logs', 'removed-skill'] },
    },
  }
  setAutoOpsThreadScope(id, original)
  const draftId = DraftId.make(id),
    store = useComposerDraftStore.getState()
  const ref = scopeThreadRef(EnvironmentId.make('assistant-runtime'), ThreadId.make(id))
  const file = new File(['本次草稿附件原文'], 'existing-draft.txt', {
    type: 'text/plain',
    lastModified: 1,
  })
  store.setPrompt(draftId, '保留这段原有问题及技能 $read-logs')
  store.addFiles(draftId, [
    {
      type: 'file',
      id: `${id}-file`,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
    },
  ])
  useRightPanelStore.getState().openFile(ref, 'source/original.txt')
  const normalFetch = globalThis.fetch
  let deliverLibrary: (() => void) | undefined,
    releaseCreate: ((value: undefined) => void) | undefined
  mock.createThread.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseCreate = resolve
      }),
  )
  using _fetch = stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname
      expect(init?.method ?? 'GET').toBe('GET')
      if (path === `/api/agent-demo/t3/autoops/thread-bindings/${id}`)
        return Response.json({ binding: original })
      const response = await normalFetch(input, init)
      return new Promise<Response>((resolve) => {
        deliverLibrary = () => resolve(response)
      })
    }),
  )
  await using screen = await render(f.ui)
  try {
    await vi.waitFor(() => expect(deliverLibrary).toBeTypeOf('function'))
    await vi.waitFor(() =>
      expect(
        screen.container
          .querySelector('[data-autoops-thread-scope]')
          ?.getAttribute('data-scope-state'),
      ).toBe('draft'),
    )
    expect(readAutoOpsThreadScope(id, 'assistant-project')?.question).toEqual(original.question)
    expect(mock.createThread).not.toHaveBeenCalled()
    const beforeDraft = store.getComposerDraft(draftId)
    const beforePreview = structuredClone(
      useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)],
    )
    await act(() => deliverLibrary!())
    const skills = screen.getByRole('button', { name: '技能', exact: true })
    await vi.waitFor(
      () => expect(skills.element().textContent?.startsWith('日志分析')).toBe(true),
      { timeout: 1000 },
    )
    await vi.waitFor(() => {
      expect({
        newDraftRequests: mock.createThread.mock.calls.length,
        originalSkills: readAutoOpsThreadScope(id, 'assistant-project')?.question?.configuration
          .skillIds,
      }).toEqual({
        newDraftRequests: 0,
        originalSkills: isDraft ? ['read-logs'] : original.question.configuration.skillIds,
      })
    })
    await expect
      .element(skills)
      .toHaveAttribute('aria-description', isDraft ? '日志分析' : '日志分析、已选技能')
    expect(store.getComposerDraft(draftId)).toEqual(beforeDraft)
    expect(store.getComposerDraft(draftId)?.files[0]?.file).toBe(file)
    expect(await file.text()).toBe('本次草稿附件原文')
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]).toEqual(beforePreview)
    expect(readAutoOpsThreadScope(id, 'assistant-project')?.question?.configuration.model).toEqual(
      original.question.configuration.model,
    )
  } finally {
    await screen.unmount()
    deliverLibrary?.()
    releaseCreate?.(undefined)
    store.clearDraftThread(draftId)
    useRightPanelStore.getState().closeAllSurfaces(ref)
  }
})

it('已有正文和预览时主动选择技能仍请求新干净草稿，原草稿保持不变', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const id = 'explicit-skills-owned-draft',
    f = setup(true, id),
    preset = f.host.projects[0]!.assistants!.items[0]!.preset
  const original = {
    ...scopeFromAssistant(preset),
    scopeState: 'draft' as const,
    scopeLocked: false,
  }
  setAutoOpsThreadScope(id, original)
  const draftId = DraftId.make(id),
    store = useComposerDraftStore.getState(),
    ref = scopeThreadRef(EnvironmentId.make('assistant-runtime'), ThreadId.make(id))
  store.setPrompt(draftId, '已有正文不能随主动切换丢失')
  useRightPanelStore.getState().openFile(ref, 'source/original.txt')
  let releaseCreate: ((value: undefined) => void) | undefined
  mock.createThread.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseCreate = resolve
      }),
  )
  await using screen = await render(f.ui)
  try {
    await vi.waitFor(() =>
      expect(
        screen.container
          .querySelector('[data-autoops-thread-scope]')
          ?.getAttribute('data-scope-state'),
      ).toBe('draft'),
    )
    expect(mock.createThread).not.toHaveBeenCalled()
    const beforeDraft = store.getComposerDraft(draftId),
      beforePreview = structuredClone(
        useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)],
      )
    await screen.getByRole('button', { name: '技能', exact: true }).click()
    await page.getByRole('menuitemcheckbox', { name: '日志分析', exact: true }).click()
    await vi.waitFor(() =>
      expect(mock.createThread).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        envMode: 'local',
        forceNew: true,
      }),
    )
    expect(readAutoOpsThreadScope(id, 'assistant-project')).toEqual(original)
    expect(store.getComposerDraft(draftId)).toEqual(beforeDraft)
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]).toEqual(beforePreview)
  } finally {
    await screen.unmount()
    releaseCreate?.(undefined)
    store.clearDraftThread(draftId)
    useRightPanelStore.getState().closeAllSurfaces(ref)
  }
})
