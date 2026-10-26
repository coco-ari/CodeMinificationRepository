import { useState } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { act, render, stubGlobal } from '../../test/render'
import { QuestionSkillsControl } from './QuestionSkillsControl'
import { installAutoOpsHost, type AutoOpsThreadScope } from './hostConfig'
import type { CustomerAssistantRuntime } from '../../../../../../autoops/contracts/customer-assistant-runtime.ts'
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
}: {
  value: AutoOpsThreadScope
  locked?: boolean
  disabled?: boolean
  onChange: (ids: string[]) => void
}) {
  const [draft, setDraft] = useState<{
    source: AutoOpsThreadScope
    question: NonNullable<AutoOpsThreadScope['question']>
  } | null>(null)
  const selection = draft?.source === value ? draft.question : value.question!
  return (
    <QuestionSkillsControl
      scope={{ ...value, question: selection }}
      locked={locked}
      disabled={disabled}
      onChange={(ids) => {
        onChange(ids)
        setDraft({
          source: value,
          question: { ...selection, configuration: { ...selection.configuration, skillIds: ids } },
        })
      }}
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

it('共享撤回后清除旧候选，重试只恢复当前合法目录且显式移除失效选项', async () => {
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
  expect(changed).toHaveBeenCalledExactlyOnceWith(['isolated-skill'])
  await page.getByRole('menuitem', { name: '移除已不可用技能', exact: true }).click()
  expect(changed.mock.calls.map(([ids]) => ids)).toEqual([['isolated-skill'], []])
})

it('只读预设的目录撤回显示可访问的重试入口，恢复不修改原技能', async () => {
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

it.each(['project', 'actor'] as const)(
  '切换%s后旧请求迟到不能恢复旧技能或调用提供者管理目录',
  async (kind) => {
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
    const next = scope(kind === 'project' ? 'next-project' : 'recipient-project')
    if (kind === 'project') next.question = { ...next.question!, assistantId: 'next-assistant' }
    install(kind === 'actor' ? 'next-recipient' : 'recipient', next.projectId)
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
    expect(f.requests.at(-1)?.csrf).toBe(
      kind === 'actor' ? 'csrf-next-recipient' : 'csrf-recipient',
    )
  },
)
