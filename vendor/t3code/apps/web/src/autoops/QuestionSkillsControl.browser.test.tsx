import { useState } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { act, fakeTimers, render, stubGlobal } from '../../test/render'
import { QuestionSkillsControl } from './QuestionSkillsControl'
import { installAutoOpsHost, readAutoOpsHost, type AutoOpsThreadScope } from './hostConfig'
import type { CustomerAssistantRuntime } from '../../../../../../autoops/contracts/customer-assistant-runtime.ts'
import { useCustomerRuntime, type CustomerRuntime } from './customerAgents'
import type { SkillLibrary } from './skillLibrary'
import '../index.css'

const target = {
  kind: 'customer' as const,
  deviceId: 'provided-device',
  registeredWorkspaceId: 'provided-directory',
  workspaceBindingRevision: 2,
  runtimeId: 'codex' as const,
}
const profile = {
  id: 'readonly-profile',
  revision: 3,
  digest: 'a'.repeat(64),
  imageDigest: `sha256:${'b'.repeat(64)}`,
  policy: 'linux-docker-readonly-v1' as const,
}
const scope = (projectId = 'recipient-project', selected: string[] = []): AutoOpsThreadScope => ({
  projectId,
  environmentId: null,
  agentId: 'a-project',
  visibility: 'private',
  executionBinding: target,
  question: {
    assistantId: 'provided-assistant',
    presetRevision: 4,
    configuration: {
      agentId: 'a-project',
      executionBinding: target,
      customerProfile: profile,
      environmentId: null,
      workspaceType: null,
      visibility: 'private',
      model: {
        instanceId: 'customer-provided-device-codex',
        model: 'isolated-model',
        reasoningEffort: 'high',
      },
      skillIds: selected,
    },
  },
})
function install(actor = 'recipient', projectId = 'recipient-project', adjust = true) {
  installAutoOpsHost(
    {
      principal: { id: actor, displayName: actor },
      csrfToken: `csrf-${actor}`,
      gatewayBasePath: '/api/agent-demo/t3',
      fixedModel: { instanceId: 'codex', model: 'unused-platform-model' },
      runtimeMode: 'approval-required',
      customerAgentsEnabled: true,
      assistantDirectoryEnabled: true,
      capabilities: {},
      projects: [
        {
          id: projectId,
          name: '获分配项目',
          agents: [],
          environments: [],
          capabilities: {
            'chat.use': true,
            'chat.configure': adjust,
            'project.manage': false,
            'workspace.read': true,
            'workspace.manage': false,
            'deployment.read': false,
            'deployment.execute': false,
          },
        },
      ],
    },
    window.location.origin,
  )
}
function runtime(skill = 'isolated-skill', name = '隔离只读技能'): CustomerAssistantRuntime {
  return {
    target,
    profile: 'linux-docker-readonly-v1',
    available: true,
    device: { id: target.deviceId, label: '项目已分配电脑', status: 'active', online: true },
    workspace: { label: '隔离来源目录', status: 'active' },
    capabilities: {
      ...target,
      protocolVersion: 1,
      revision: 'isolated-catalog',
      updatedAt: '2026-10-26T00:00:00Z',
      assistantConfiguration: true,
      models: [
        {
          id: 'isolated-model',
          supportedReasoningEfforts: ['high'],
          defaultReasoningEffort: 'high',
        },
      ],
      skills: [{ id: skill, name, description: '提供者明确开放的只读技能' }],
    },
  }
}
function Harness({
  value,
  locked = false,
  disabled = false,
  onChange,
  customerRuntime,
}: {
  value: AutoOpsThreadScope
  locked?: boolean
  disabled?: boolean
  onChange: (ids: string[]) => void
  customerRuntime?: CustomerRuntime | undefined
}) {
  const [draft, setDraft] = useState<{
    source: AutoOpsThreadScope
    question: NonNullable<AutoOpsThreadScope['question']>
  } | null>(null)
  const selection = draft?.source === value ? draft.question : value.question!
  const change = (ids: string[]) => {
    onChange(ids)
    setDraft({
      source: value,
      question: { ...selection, configuration: { ...selection.configuration, skillIds: ids } },
    })
  }
  return (
    <QuestionSkillsControl
      scope={{ ...value, question: selection }}
      locked={locked}
      disabled={disabled}
      customerRuntime={customerRuntime}
      onChange={change}
      onReconcileUnavailable={change}
    />
  )
}
function setup(adjust = true) {
  install('recipient', 'recipient-project', adjust)
  const state = { response: runtime(), denied: false }
  const requests: Array<{ path: string; body: unknown; csrf: string | null }> = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname
    requests.push({
      path,
      body: JSON.parse(String(init?.body)),
      csrf: new Headers(init?.headers).get('X-Demo-CSRF'),
    })
    if (path !== '/api/agent-demo/t3/autoops/customer/assistant-runtime')
      throw new Error(`技能不应读取提供者管理接口：${path}`)
    return state.denied
      ? Response.json({ code: 'ASSISTANT_WITHDRAWN', error: '提供者已撤回共享' }, { status: 403 })
      : Response.json(state.response)
  })
  return { state, requests, fetcher }
}
const open = () => page.getByRole('button', { name: '技能', exact: true }).click()

it('调整技能只读取当前获分配助手的真实隔离目录，勾选后参数和焦点留在原入口', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const f = setup(),
    value = scope(),
    changed = vi.fn()
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<Harness value={value} onChange={changed} />)
  await open()
  await expect
    .element(page.getByRole('menuitemcheckbox', { name: '隔离只读技能', exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByRole('menuitemcheckbox', { name: '自用技能', exact: true }))
    .not.toBeInTheDocument()
  expect(f.requests[0]).toEqual({
    path: '/api/agent-demo/t3/autoops/customer/assistant-runtime',
    body: { projectId: value.projectId, question: value.question },
    csrf: 'csrf-recipient',
  })
  await page.getByRole('menuitemcheckbox', { name: '隔离只读技能', exact: true }).click()
  await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
  await expect.element(page.getByRole('button', { name: '技能', exact: true })).toHaveFocus()
  expect(changed).toHaveBeenCalledExactlyOnceWith(['isolated-skill'])
  expect(value.question?.configuration.skillIds).toEqual([])
  await open()
  await expect
    .element(page.getByRole('menuitemcheckbox', { name: '隔离只读技能', exact: true }))
    .toHaveAttribute('aria-checked', 'true')
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('button', { name: '技能', exact: true })).toHaveFocus()
  expect(
    f.requests.every(
      (request) => request.path === '/api/agent-demo/t3/autoops/customer/assistant-runtime',
    ),
  ).toBe(true)
})

it('低权限成员显示实际预设技能及锁定原因，键盘可读且不能打开调整菜单', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  await page.viewport(390, 500)
  const f = setup(false),
    value = scope('recipient-project', ['isolated-skill']),
    changed = vi.fn()
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<Harness value={value} locked onChange={changed} />)
  const control = page.getByLabelText('技能', { exact: true })
  await expect.element(control).toHaveAttribute('aria-description', '隔离只读技能')
  await userEvent.tab()
  await expect.element(control).toHaveFocus()
  await expect
    .element(page.getByRole('tooltip'))
    .toHaveTextContent('隔离只读技能 · 按本次助手配置使用')
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
  expect(changed).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]?.body).toEqual({ projectId: value.projectId, question: value.question })
})

it('共享撤回后保留选择，重试恢复当前合法目录才自动移除草稿失效选项', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const f = setup(),
    changed = vi.fn()
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<Harness value={scope()} onChange={changed} />)
  await open()
  await expect
    .element(page.getByRole('menuitemcheckbox', { name: '隔离只读技能', exact: true }))
    .toBeVisible()
  f.state.denied = true
  await page.getByRole('menuitemcheckbox', { name: '隔离只读技能', exact: true }).click()
  await open()
  await expect
    .element(page.getByRole('menuitem', { name: '提供者已撤回共享', exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByRole('menuitemcheckbox', { name: '隔离只读技能', exact: true }))
    .not.toBeInTheDocument()
  f.state.denied = false
  f.state.response = runtime('current-skill', '恢复后的当前技能')
  await page.getByRole('menuitem', { name: '重试读取技能', exact: true }).click()
  await open()
  await expect
    .element(page.getByRole('menuitemcheckbox', { name: '恢复后的当前技能', exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByRole('menuitemcheckbox', { name: '隔离只读技能', exact: true }))
    .not.toBeInTheDocument()
  await vi.waitFor(() =>
    expect(changed.mock.calls.map(([ids]) => ids)).toEqual([['isolated-skill'], []]),
  )
  await expect
    .element(page.getByRole('menuitem', { name: '移除已不可用技能', exact: true }))
    .not.toBeInTheDocument()
})

it('只读预设的目录撤回显示可访问的重试入口，恢复不修改原技能', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const f = setup(false),
    value = scope('recipient-project', ['isolated-skill']),
    changed = vi.fn()
  f.state.denied = true
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<Harness value={value} locked onChange={changed} />)
  const retry = page.getByRole('button', { name: '技能目录读取失败，重试', exact: true })
  await expect.element(retry).toBeVisible()
  await expect
    .element(page.getByLabelText('技能', { exact: true }))
    .toHaveAttribute('aria-description', '已选技能')
  f.state.denied = false
  await retry.click()
  await expect.element(retry).not.toBeInTheDocument()
  await expect
    .element(page.getByLabelText('技能', { exact: true }))
    .toHaveAttribute('aria-description', '隔离只读技能')
  expect(changed).not.toHaveBeenCalled()
  expect(value.question?.configuration.skillIds).toEqual(['isolated-skill'])
})

it('切换项目后旧请求迟到不能恢复旧技能或调用提供者管理目录', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const f = setup(),
    changed = vi.fn()
  let finish!: (response: Response) => void
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
  )
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using screen = await render(<Harness value={scope()} onChange={changed} />)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const next = scope('next-project')
  next.question = { ...next.question!, assistantId: 'next-assistant' }
  install('recipient', next.projectId)
  f.state.response = runtime('next-skill', '当前调用者技能')
  await screen.rerender(<Harness value={next} onChange={changed} />)
  await open()
  await expect
    .element(page.getByRole('menuitemcheckbox', { name: '当前调用者技能', exact: true }))
    .toBeVisible()
  await act(() => finish(Response.json(runtime('old-skill', '旧调用者私有技能'))))
  await expect
    .element(page.getByRole('menuitemcheckbox', { name: '当前调用者技能', exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByRole('menuitemcheckbox', { name: '旧调用者私有技能', exact: true }))
    .not.toBeInTheDocument()
  expect(changed).not.toHaveBeenCalled()
  expect(f.requests.at(-1)?.body).toEqual({ projectId: next.projectId, question: next.question })
  expect(f.requests.at(-1)?.csrf).toBe('csrf-recipient')
})

it('原页面拒绝直接切换身份，卸载后旧技能请求迟到不能恢复原用户内容', async () => {
  const f = setup(),
    changed = vi.fn()
  let finish!: (response: Response) => void
  let requestSignal: AbortSignal | null | undefined
  f.fetcher.mockImplementationOnce((_input, init) => {
    requestSignal = init?.signal
    return new Promise<Response>((resolve) => {
      finish = resolve
    })
  })
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using screen = await render(<Harness value={scope()} onChange={changed} />)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(() => install('next-recipient')).toThrow(
    'Reload the page before changing the authenticated user.',
  )
  expect(readAutoOpsHost()?.principal.id).toBe('recipient')
  expect(readAutoOpsHost()?.csrfToken).toBe('csrf-recipient')
  await screen.unmount()
  expect(requestSignal?.aborted).toBe(true)
  await act(() => finish(Response.json(runtime('old-skill', '旧调用者私有技能'))))
  await expect
    .element(page.getByRole('menuitemcheckbox', { name: '旧调用者私有技能', exact: true }))
    .not.toBeInTheDocument()
  await expect
    .element(page.getByRole('button', { name: '技能', exact: true }))
    .not.toBeInTheDocument()
  expect(f.fetcher).toHaveBeenCalledTimes(1)
  expect(changed).not.toHaveBeenCalled()
})

function platformScope(selected: string[]): AutoOpsThreadScope {
  const value = scope('recipient-project', selected)
  value.executionBinding = { kind: 'platform' }
  value.workspaceType = 'internal'
  value.question = {
    ...value.question!,
    assistantId: 'platform-assistant',
    configuration: {
      agentId: 'a-project',
      executionBinding: { kind: 'platform' },
      environmentId: null,
      workspaceType: 'internal',
      visibility: 'private',
      model: { instanceId: 'codex', model: 'platform-model', reasoningEffort: 'medium' },
      skillIds: selected,
    },
  }
  return value
}

function setupPlatform() {
  install()
  const library: SkillLibrary = {
    revision: 'platform-library-one',
    canManage: false,
    projects: [],
    agents: [],
    skills: ['platform-read', 'platform-review'].map((id, index) => ({
      id,
      name: id,
      displayName: index === 0 ? '平台资料解读' : '平台结果复核',
      description: '当前项目已分配的只读技能',
      enabled: true,
      latestVersionId: `${id}-version`,
      versions: [
        {
          id: `${id}-version`,
          createdAt: '2026-10-28T00:00:00Z',
          fileCount: 0,
          readiness: 'ready',
          reason: null,
          contentHash: 'c'.repeat(64),
          byteLength: 0,
          source: { type: 'markdown' },
          files: [],
        },
      ],
    })),
    assignments: ['platform-read', 'platform-review'].map((id) => ({
      id: `${id}-assignment`,
      targetType: 'project',
      targetId: 'recipient-project',
      skillId: id,
      versionId: `${id}-version`,
      workspaceTypes: ['internal'],
      enabled: true,
    })),
  }
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new URL(String(input), window.location.origin).pathname).toBe(
      '/api/agent-demo/t3/autoops/skill-library',
    )
    expect(init?.method ?? 'GET').toBe('GET')
    return Response.json(library)
  })
  return { library, fetcher }
}

it.each(['模型', '思考强度', '所选技能'])(
  '平台草稿改变%s时保留同授权目录的真实技能名称，不重复等待目录',
  async (parameter) => {
    const f = setupPlatform(),
      value = platformScope(['platform-read']),
      changed = vi.fn()
    using _fetch = stubGlobal('fetch', f.fetcher)
    await using screen = await render(<Harness value={value} onChange={changed} />)
    const control = page.getByRole('button', { name: '技能', exact: true })
    await expect.element(control).toHaveAttribute('aria-description', '平台资料解读')
    let finish!: (response: Response) => void
    f.fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const configuration = value.question!.configuration
    const next = {
      ...value,
      question: {
        ...value.question!,
        configuration: {
          ...configuration,
          model: {
            ...configuration.model,
            ...(parameter === '模型' ? { model: 'another-platform-model' } : {}),
            ...(parameter === '思考强度' ? { reasoningEffort: 'high' as const } : {}),
          },
          skillIds:
            parameter === '所选技能'
              ? ['platform-read', 'platform-review']
              : configuration.skillIds,
        },
      },
    }
    try {
      await screen.rerender(<Harness value={next} onChange={changed} />)
      expect(control.element().getAttribute('aria-description')).toBe(
        parameter === '所选技能' ? '平台资料解读、平台结果复核' : '平台资料解读',
      )
      expect(f.fetcher).toHaveBeenCalledTimes(1)
      expect(changed).not.toHaveBeenCalled()
    } finally {
      finish?.(Response.json(f.library))
    }
  },
)

it('普通可调平台草稿在目录成功后自动剔除失效技能，保留其余技能继续选择', async () => {
  const f = setupPlatform(),
    value = platformScope(['platform-read', 'removed-skill']),
    changed = vi.fn()
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<Harness value={value} onChange={changed} />)
  await vi.waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(['platform-read']))
  await expect
    .element(page.getByRole('button', { name: '技能', exact: true }))
    .toHaveAttribute('aria-description', '平台资料解读')
  expect(value.question?.configuration.skillIds).toEqual(['platform-read', 'removed-skill'])
})

it('固定历史配置在目录成功后保留原失效技能，不修改既有本轮参数', async () => {
  const f = setupPlatform(),
    value = platformScope(['platform-read', 'removed-skill']),
    changed = vi.fn()
  value.scopeLocked = true
  value.scopeState = 'locked'
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<Harness value={value} locked onChange={changed} />)
  await expect
    .element(page.getByLabelText('技能', { exact: true }))
    .toHaveAttribute('aria-description', '平台资料解读、已选技能')
  expect(changed).not.toHaveBeenCalled()
  expect(value.question?.configuration.skillIds).toEqual(['platform-read', 'removed-skill'])
})

it('普通平台草稿读取中或503不清选择，恢复后整理失效技能并同步目录撤权', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const f = setupPlatform(),
    value = platformScope(['platform-read', 'removed-skill']),
    changed = vi.fn()
  let finish!: (response: Response) => void
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
  )
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<Harness value={value} onChange={changed} />)
  try {
    await userEvent.click(page.getByRole('button', { name: '技能', exact: true }))
    await expect
      .element(page.getByRole('menuitem', { name: '正在读取技能', exact: true }))
      .toBeVisible()
    expect(changed).not.toHaveBeenCalled()
    await act(() =>
      finish(Response.json({ code: 'UNAVAILABLE', error: '隔离目录暂不可用' }, { status: 503 })),
    )
    await expect
      .element(page.getByRole('menuitem', { name: '隔离目录暂不可用', exact: true }))
      .toBeVisible()
    expect(changed).not.toHaveBeenCalled()
    await userEvent.click(page.getByRole('menuitem', { name: '重试读取技能', exact: true }))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(['platform-read']))
    await expect
      .element(page.getByRole('button', { name: '技能', exact: true }))
      .toHaveAttribute('aria-description', '平台资料解读')
    expect(value.question?.configuration.skillIds).toEqual(['platform-read', 'removed-skill'])
    f.fetcher.mockResolvedValueOnce(
      Response.json({ code: 'FORBIDDEN', error: '平台技能授权已撤回' }, { status: 403 }),
    )
    await act(() => window.dispatchEvent(new Event('autoops:skill-library-changed')))
    await expect
      .element(page.getByRole('button', { name: '技能', exact: true }))
      .toHaveAttribute('aria-description', '已选技能')
    await userEvent.click(page.getByRole('button', { name: '技能', exact: true }))
    await expect
      .element(page.getByRole('menuitem', { name: '平台技能授权已撤回', exact: true }))
      .toBeVisible()
    expect(changed).toHaveBeenCalledExactlyOnceWith(['platform-read'])
  } finally {
    finish?.(Response.json(f.library))
  }
})

function RuntimeSkillsHarness({
  value,
  onChange,
  runtimeValue = value,
}: {
  value: AutoOpsThreadScope
  onChange(ids: string[]): void
  runtimeValue?: AutoOpsThreadScope
}) {
  const runtime = useCustomerRuntime(runtimeValue)
  return (
    <>
      <output aria-label="运行器当前技能">
        {runtime.catalog?.skills.map((skill) => skill.name).join('、')}
      </output>
      <p role="status">{runtime.error}</p>
      <button type="button" onClick={runtime.refresh}>
        刷新运行器能力
      </button>
      <Harness value={value} onChange={onChange} customerRuntime={runtime} />
    </>
  )
}

it('客户运行器与技能控件共享当前授权，独立刷新撤权同步清除并恢复真实目录', async () => {
  const f = setup(),
    value = scope('recipient-project', ['isolated-skill']),
    changed = vi.fn()
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using screen = await render(<RuntimeSkillsHarness value={value} onChange={changed} />)
  const control = page.getByRole('button', { name: '技能', exact: true })
  await expect.element(control).toHaveAttribute('aria-description', '隔离只读技能')
  await expect.element(screen.getByLabelText('运行器当前技能')).toHaveTextContent('隔离只读技能')
  f.state.denied = true
  const refresh = screen
    .getByRole('button', { name: '刷新运行器能力', exact: true })
    .element() as HTMLButtonElement
  await act(() => refresh.click())
  await vi.waitFor(() =>
    expect(screen.container.querySelector('p[role="status"]')?.textContent).toBe(
      '提供者已撤回共享',
    ),
  )
  expect(control.element().getAttribute('aria-description')).toBe('已选技能')
  expect(screen.getByLabelText('运行器当前技能').element().textContent).toBe('')
  expect(changed).not.toHaveBeenCalled()
  f.state.denied = false
  f.state.response = runtime('isolated-skill', '恢复后的当前技能')
  await act(() => refresh.click())
  await expect
    .element(screen.getByLabelText('运行器当前技能'))
    .toHaveTextContent('恢复后的当前技能')
  await expect.element(control).toHaveAttribute('aria-description', '恢复后的当前技能')
  expect(f.requests).toHaveLength(3)
  expect(changed).not.toHaveBeenCalled()
})

it('父级运行器仍属原预设时不借用旧目录，等本次完整配置复核后才显示', async () => {
  const f = setup(),
    original = scope('recipient-project', ['isolated-skill']),
    changed = vi.fn()
  const next = { ...original, question: { ...original.question!, presetRevision: 5 } }
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using screen = await render(
    <RuntimeSkillsHarness value={next} runtimeValue={original} onChange={changed} />,
  )
  await expect.element(screen.getByLabelText('运行器当前技能')).toHaveTextContent('隔离只读技能')
  await expect
    .element(page.getByRole('button', { name: '技能', exact: true }))
    .toHaveAttribute('aria-description', '已选技能')
  expect(f.requests).toHaveLength(1)
  expect(changed).not.toHaveBeenCalled()
  f.state.response = runtime('isolated-skill', '当前预设已复核技能')
  await screen.rerender(<RuntimeSkillsHarness value={next} onChange={changed} />)
  await expect
    .element(page.getByRole('button', { name: '技能', exact: true }))
    .toHaveAttribute('aria-description', '当前预设已复核技能')
  expect(f.requests.at(-1)?.body).toEqual({ projectId: next.projectId, question: next.question })
  expect(f.requests).toHaveLength(2)
  expect(changed).not.toHaveBeenCalled()
})
