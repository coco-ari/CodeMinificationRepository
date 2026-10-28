import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { act, render, stubGlobal } from '../../test/render'
import { installAutoOpsHost, useAutoOpsHost, type AutoOpsT3Bootstrap } from './hostConfig'
import { ProjectQuestionEntry } from './ProjectQuestionEntry'
import '../index.css'

type Project = AutoOpsT3Bootstrap['projects'][number]

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'first-project',
    name: '首次使用项目',
    environments: [],
    agents: [],
    capabilities: {
      'project.manage': false,
      'workspace.read': false,
      'workspace.manage': false,
      'deployment.read': false,
      'deployment.execute': false,
    },
    assistants: {
      ready: false,
      canAdjust: false,
      defaultAssistantId: null,
      reason: { code: 'DEFAULT_ASSISTANT_REQUIRED', message: '请管理员配置默认助手' },
      items: [
        {
          available: true,
          preset: {
            id: 'helper',
            projectId: 'first-project',
            name: '项目问答助手',
            description: '',
            instructions: '',
            enabled: true,
            revision: 1,
            createdBy: 'admin',
            updatedAt: '2026-10-28T00:00:00Z',
            configuration: {
              agentId: 'agent',
              executionBinding: { kind: 'platform' },
              environmentId: null,
              workspaceType: null,
              visibility: 'private',
              model: { instanceId: 'codex', model: 'test-model', reasoningEffort: 'high' },
              skillIds: [],
            },
          },
        },
      ],
    },
    ...overrides,
  }
}

function readyProject(candidate = project()): Project {
  const { reason: _reason, ...directory } = candidate.assistants!
  return { ...candidate, assistants: { ...directory, ready: true, defaultAssistantId: 'helper' } }
}

function bootstrap(projects: readonly Project[]): AutoOpsT3Bootstrap {
  return {
    principal: { id: 'question-entry-member', displayName: '首次使用成员' },
    csrfToken: 'isolated-csrf',
    gatewayBasePath: '/api/agent-demo/t3',
    fixedModel: { instanceId: 'codex', model: 'test-model' },
    runtimeMode: 'approval-required',
    assistantDirectoryEnabled: true,
    capabilities: {},
    projects,
  }
}

function setup(value = project()) {
  const host = bootstrap([value])
  installAutoOpsHost(host, window.location.origin)
  return { project: value, host }
}

function CurrentProjectEntry({ projectId }: { projectId: string }) {
  const host = useAutoOpsHost()
  const current = host?.projects.find((candidate) => candidate.id === projectId)
  return current ? <ProjectQuestionEntry project={current} /> : <p>当前项目已不可访问</p>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

it('问答已准入时，无仓库和环境也能直接开始并带入当前项目', async () => {
  await page.viewport(1440, 600)
  const candidate = project()
  const f = setup(readyProject(candidate))
  await using screen = await render(<ProjectQuestionEntry project={f.project} />, {
    router: '/projects?projectId=first-project',
  })
  await expect.element(screen.getByText('项目问答助手', { exact: false })).toBeVisible()
  await screen.getByRole('link', { name: '开始问答', exact: true }).click()
  expect(screen.router?.state.location.pathname).toBe('/')
  expect(screen.router?.state.location.search).toMatchObject({ projectId: 'first-project' })
})

it('缺少默认助手的受限成员即使已有可用助手也不能绕过服务端准入', async () => {
  const f = setup()
  await using screen = await render(<ProjectQuestionEntry project={f.project} />)
  await expect.element(screen.getByText('请管理员配置默认助手', { exact: true })).toBeVisible()
  await expect.element(screen.getByRole('link', { name: '开始问答' })).not.toBeInTheDocument()
  await expect.element(screen.getByRole('link', { name: '配置助手' })).not.toBeInTheDocument()
  await expect
    .element(screen.getByText('请联系项目管理员完成助手分配。', { exact: true }))
    .toBeVisible()
  await expect.element(screen.getByRole('button', { name: '刷新状态', exact: true })).toBeEnabled()
})

it('已分配的默认助手电脑离线时展示实际原因，不让成员重新申请分配', async () => {
  const candidate = project()
  const original = candidate.assistants!.items[0]!
  const offlineReason = '客户设备离线，草稿已保留；连接恢复后再发送'
  const f = setup({
    ...candidate,
    assistants: {
      ...candidate.assistants!,
      defaultAssistantId: original.preset.id,
      items: [
        {
          available: false,
          reason: { code: 'CUSTOMER_DEVICE_OFFLINE', message: offlineReason },
          preset: {
            ...original.preset,
            configuration: {
              ...original.preset.configuration,
              executionBinding: {
                kind: 'customer',
                deviceId: 'provided-device',
                registeredWorkspaceId: 'provided-workspace',
                workspaceBindingRevision: 1,
                runtimeId: 'codex',
              },
            },
          },
        },
      ],
    },
  })
  await using screen = await render(<ProjectQuestionEntry project={f.project} />)
  await expect.element(screen.getByText(offlineReason, { exact: true })).toBeVisible()
  await expect
    .element(screen.getByText('请管理员配置默认助手', { exact: true }))
    .not.toBeInTheDocument()
  await expect
    .element(screen.getByText('请联系项目管理员完成助手分配。', { exact: true }))
    .not.toBeInTheDocument()
  await expect.element(screen.getByRole('link', { name: '开始问答' })).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '刷新状态', exact: true })).toBeEnabled()
})

it('服务端允许调整配置的成员无需默认助手即可进入问答', async () => {
  const candidate = readyProject()
  const f = setup({
    ...candidate,
    assistants: { ...candidate.assistants!, canAdjust: true, defaultAssistantId: null },
  })
  await using screen = await render(<ProjectQuestionEntry project={f.project} />)
  await expect.element(screen.getByText('可在问答中调整配置。', { exact: false })).toBeVisible()
  await screen.getByRole('link', { name: '开始问答', exact: true }).click()
  expect(screen.router?.state.location.search).toMatchObject({ projectId: f.project.id })
})

it('项目管理员可从问答缺口直达本项目助手配置并保留返回来源', async () => {
  const candidate = project()
  const f = setup({
    ...candidate,
    capabilities: { ...candidate.capabilities!, 'project.manage': true },
  })
  await using screen = await render(<ProjectQuestionEntry project={f.project} />)
  await screen.getByRole('link', { name: '配置助手', exact: true }).click()
  expect(screen.router?.state.location.pathname).toBe('/assistants')
  expect(screen.router?.state.location.search).toMatchObject({
    projectId: f.project.id,
    from: 'projects',
  })
})

it('目录尚未提供时不推测问答已可用，保存期间不允许离开当前配置', async () => {
  const candidate = project()
  const { assistants: _assistants, ...withoutDirectory } = candidate
  const f = setup(withoutDirectory)
  await using screen = await render(<ProjectQuestionEntry project={f.project} />)
  await expect
    .element(screen.getByText('问答状态尚未提供，请刷新后重试。', { exact: true }))
    .toBeVisible()
  await expect.element(screen.getByRole('link', { name: '开始问答' })).not.toBeInTheDocument()
  await screen.rerender(
    <ProjectQuestionEntry
      project={{ ...candidate, assistants: { ...candidate.assistants!, ready: true } }}
      disabled
    />,
  )
  await expect.element(screen.getByRole('button', { name: '开始问答', exact: true })).toBeDisabled()
  await expect.element(screen.getByRole('link', { name: '开始问答' })).not.toBeInTheDocument()
  await screen.rerender(
    <ProjectQuestionEntry
      project={{
        ...candidate,
        capabilities: { ...candidate.capabilities!, 'project.manage': true },
      }}
      disabled
    />,
  )
  await expect.element(screen.getByRole('button', { name: '配置助手', exact: true })).toBeDisabled()
  await expect.element(screen.getByRole('link', { name: '配置助手' })).not.toBeInTheDocument()
})

it('刷新失败留在本分组，重试期间禁止重复请求，新授权到达后直接开始问答', async () => {
  const f = setup()
  const response = deferred<Response>()
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 'TEMPORARY', message: '暂时无法读取项目授权' } },
        { status: 503 },
      ),
    )
    .mockReturnValueOnce(response.promise)
  using _fetch = stubGlobal('fetch', fetch)
  await using screen = await render(<CurrentProjectEntry projectId={f.project.id} />)
  await screen.getByRole('button', { name: '刷新状态', exact: true }).click()
  await expect.element(screen.getByRole('alert')).toHaveTextContent('暂时无法读取项目授权')
  await screen.getByRole('button', { name: '刷新状态', exact: true }).click()
  await expect.element(screen.getByRole('button', { name: '刷新状态', exact: true })).toBeDisabled()
  ;(
    screen.getByRole('button', { name: '刷新状态', exact: true }).element() as HTMLButtonElement
  ).click()
  expect(fetch).toHaveBeenCalledTimes(2)
  const ready = readyProject(f.project)
  await act(() => response.resolve(Response.json(bootstrap([ready]))))
  await expect.element(screen.getByRole('link', { name: '开始问答', exact: true })).toBeVisible()
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument()
  for (const [, options] of fetch.mock.calls) {
    expect(options?.method).toBe('GET')
    expect(options?.body).toBeUndefined()
  }
  await screen.getByRole('link', { name: '开始问答', exact: true }).click()
  expect(screen.router?.state.location.search).toMatchObject({ projectId: f.project.id })
})

it('切换项目后迟到的刷新错误不留在新项目，撤销准入后立即移除问答入口', async () => {
  const first = project()
  const second = readyProject(project({ id: 'second-project' }))
  const f = setup(first)
  const response = deferred<Response>()
  using _fetch = stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockReturnValue(response.promise),
  )
  await using screen = await render(<ProjectQuestionEntry project={f.project} />)
  await screen.getByRole('button', { name: '刷新状态', exact: true }).click()
  await screen.rerender(<ProjectQuestionEntry project={second} />)
  await act(() =>
    response.resolve(Response.json({ error: { message: '旧项目读取失败' } }, { status: 503 })),
  )
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument()
  await expect
    .element(screen.getByRole('link', { name: '开始问答', exact: true }))
    .toHaveAttribute('href', '/?projectId=second-project')
  await screen.rerender(
    <ProjectQuestionEntry
      project={{
        ...second,
        assistants: {
          ...second.assistants!,
          ready: false,
          reason: { code: 'REVOKED', message: '当前助手授权已撤回' },
        },
      }}
    />,
  )
  await expect.element(screen.getByText('当前助手授权已撤回', { exact: true })).toBeVisible()
  await expect.element(screen.getByRole('link', { name: '开始问答' })).not.toBeInTheDocument()
})

it('刷新中撤回助手授权后，迟到的旧成功响应不能恢复问答入口', async () => {
  const f = setup()
  const response = deferred<Response>()
  const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(response.promise)
  using _fetch = stubGlobal('fetch', fetch)
  await using screen = await render(<CurrentProjectEntry projectId={f.project.id} />)
  await screen.getByRole('button', { name: '刷新状态', exact: true }).click()
  const revoked = {
    ...f.project,
    assistants: {
      ...f.project.assistants!,
      items: [],
      reason: { code: 'REVOKED', message: '当前助手授权已撤回' },
    },
  }
  await act(() => installAutoOpsHost(bootstrap([revoked]), window.location.origin))
  await expect.element(screen.getByText('当前助手授权已撤回', { exact: true })).toBeVisible()
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  await act(async () => {
    response.resolve(Response.json(bootstrap([readyProject(f.project)])))
    await response.promise
  })
  await expect.element(screen.getByText('当前助手授权已撤回', { exact: true })).toBeVisible()
  await expect.element(screen.getByRole('link', { name: '开始问答' })).not.toBeInTheDocument()
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument()
})

it('刷新中切换已更新的项目目录，旧成功响应不能覆盖新项目入口', async () => {
  const f = setup()
  const response = deferred<Response>()
  const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(response.promise)
  using _fetch = stubGlobal('fetch', fetch)
  await using screen = await render(<CurrentProjectEntry projectId={f.project.id} />)
  await screen.getByRole('button', { name: '刷新状态', exact: true }).click()
  const second = readyProject(project({ id: 'second-project' }))
  await act(() => installAutoOpsHost(bootstrap([second]), window.location.origin))
  await screen.rerender(<CurrentProjectEntry projectId={second.id} />)
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  await act(async () => {
    response.resolve(Response.json(bootstrap([readyProject(f.project)])))
    await response.promise
  })
  await expect
    .element(screen.getByRole('link', { name: '开始问答', exact: true }))
    .toHaveAttribute('href', '/?projectId=second-project')
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument()
})

for (const [width, theme] of [
  [1440, 'light'],
  [390, 'dark'],
] as const) {
  it(`${width}px ${theme} 下长助手名称完整换行且键盘能进入问答`, async () => {
    await page.viewport(width, 500)
    const candidate = project()
    const name = '这是一个能够回答跨地域项目资料问题的默认助手'.repeat(4)
    const f = setup(
      readyProject({
        ...candidate,
        assistants: {
          ...candidate.assistants!,
          items: [
            {
              ...candidate.assistants!.items[0]!,
              preset: { ...candidate.assistants!.items[0]!.preset, name },
            },
          ],
        },
      }),
    )
    await using screen = await render(
      <div className={`${theme} bg-background p-4`}>
        <ProjectQuestionEntry project={f.project} />
      </div>,
    )
    await expect.element(screen.getByText(name, { exact: false })).toBeVisible()
    const section = screen.container.querySelector('section')!
    expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth + 1)
    await userEvent.tab()
    await expect.element(screen.getByRole('link', { name: '开始问答', exact: true })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(screen.router?.state.location.search).toMatchObject({ projectId: f.project.id })
  })
}
