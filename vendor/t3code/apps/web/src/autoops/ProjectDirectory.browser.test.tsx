import { StrictMode } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { fakeTimers, render, stubGlobal } from '../../test/render'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { projectAssistantReceiptIntent } from '../../../../../../autoops/contracts/project-management-receipts.ts'
import { SidebarProvider } from '~/components/ui/sidebar'
import { ModuleSidebarProvider, ModuleSidebarOutlet } from './ModuleWorkspace'
import { AutoOpsProjectsPage } from './ProjectsPage'
import { installAutoOpsHost, readAutoOpsHost } from './hostConfig'
import { prepareProjectMutation, prepareProjectWrite, submitProjectWrite, readPendingProjectWrite } from "./projectDirectory";
import '../index.css'

const mocks = vi.hoisted(() => ({ select: vi.fn() }))
vi.mock(import('./projectNavigation'), async (original) => ({ ...(await original()), selectAutoOpsProject: mocks.select,
}))
function setup({ manage = true, failFirst = false, loseResponse = false } = {}) {
  mocks.select.mockReset()
  window.sessionStorage.clear()
  let fail = failFirst, lost = loseResponse, writes = 0,
    receiptMode: "completed" | "missing" | "unavailable" | "mismatch" = "completed",
    currentManage = manage,
    revokeOnReceipt = false;
  const queries: string[] = [],
    receipts = new Map<string, object>();
  const bodies: object[] = []
  const project = { id: 'directory-project', name: '原项目', description: '', revision: 1, createdBy: 'directory-owner', createdAt: '2026-10-26T00:00:00Z', environments: [{ id: 'test', name: '测试环境', revision: 1 }],
  }
  const bootstrap = () => ({
    principal: { id: 'directory-owner', displayName: '目录用户' }, csrfToken: 'test-csrf', gatewayBasePath: '/api/agent-demo/t3', fixedModel: { instanceId: 'codex', model: 'test-model' }, runtimeMode: 'approval-required' as const, canCreateProject: true, capabilities: {},
    projects: [{ ...project, agents: [], capabilities: { 'project.manage': currentManage, 'workspace.read': true, 'workspace.manage': currentManage, 'deployment.read': true, 'deployment.execute': currentManage,
        },
      },
    ],
  })
  installAutoOpsHost(bootstrap(), window.location.origin)
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/projects/receipts/")) {
      queries.push(url);
      if (receiptMode === "missing") return Response.json(null);
      if (receiptMode === "unavailable")
        return Response.json({ error: "收据服务暂不可用" }, { status: 503 });
      if (revokeOnReceipt) currentManage = false;
      const result = receipts.get(decodeURIComponent(url.split("/").at(-1)!));
      return Response.json(
        !currentManage
          ? { ...result, available: false, result: undefined }
          : receiptMode === "mismatch"
            ? { ...result, publicIntent: { expectedRevision: 99 } }
            : (result ?? null),
      );
    }
    if (url.endsWith('/assistants/choices')) return Response.json({ agents: [], sources: [], platformSkills: [] })
    if (url.endsWith('/assistants/settings')) return Response.json({ presets: [], allocations: [] })
    if (url.endsWith('/autoops/bootstrap')) return Response.json(bootstrap())
    if (url.endsWith('/repositories')) return Response.json({ revision: 0, items: [] })
    if (url.endsWith('/workspace/authoring')) return Response.json({ projectId: project.id, revision: 0, sources: [], entries: [], limits: { maxFileBytes: 8000000, maxBytes: 50000000, maxFiles: 100 },
      })
    if (url.endsWith('/workspace/credentials')) return Response.json({ credentials: [] })
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { requestId: string;
        expectedRevision: number;
        value: { name: string; description: string } }
      bodies.push(body)
      if (fail) { fail = false; return Response.json({ code: 'PROJECT_REVISION_CONFLICT', error: '配置已经修改，请核对' }, { status: 409 },
        ) }
      if (writes === 0) { writes++; project.name = body.value.name; project.revision++ }
      receipts.set(body.requestId, {
        state: "completed",
        requestId: body.requestId,
        actorId: "directory-owner",
        projectId: project.id,
        environmentId: null,
        operation: url.endsWith("/projects") ? "project.create" : "project.save",
        saved: true,
        available: true,
        publicIntent: { expectedRevision: body.expectedRevision, value: body.value },
        createdAt: "2026-10-27T00:00:00Z",
        nativeSynchronization: "current-verified",
        result: { ...project },
      });
      if (lost) { lost = false; throw new TypeError('隔离测试丢失响应') }
      return Response.json(project)
    }
    if (url.endsWith('/settings')) return Response.json({ project, members: [{ userId: 'pending-user', name: '待分配成员', role: 'reader', authorizationPending: true, environmentIds: ['test'], status: 'active', environmentRoles: {}, revision: 1, kind: 'internal', canAdjustChat: true,
          },
        ], candidates: [],
      })
    return Response.json({ items: [project] })
  })
  return { fetch, bodies,
    queries,
    project, writes: () => writes,
    setReceiptMode: (value: typeof receiptMode) => {
      receiptMode = value;
    },
    setManage: (value: boolean) => {
      currentManage = value;
    },
    revokeDuringRecovery: () => {
      revokeOnReceipt = true;
    },
  }
}
function App() {
  return (
    <StrictMode>
      <SidebarProvider>
        <ModuleSidebarProvider>
          <ModuleSidebarOutlet />
          <AutoOpsProjectsPage />
        </ModuleSidebarProvider>
      </SidebarProvider>
    </StrictMode>
  );
}

it('项目A保存未知后切到项目B仍能正常保存，不核对或覆盖A的原请求', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const f = setup()
  f.fetch.mockRejectedValueOnce(new TypeError('隔离项目A响应丢失'))
  using _fetch = stubGlobal('fetch', f.fetch)
  const original = prepareProjectWrite('/api/v1/projects/other/settings', 1, {
    name: '待核对项目A',
    description: '',
  })
  await expect(submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const edit = screen.getByRole('button', { name: '编辑项目', exact: true })
  await expect.element(edit).toBeEnabled()
  await userEvent.click(edit)
  await expect.element(page.getByRole('dialog', { name: '编辑项目', exact: true })).toBeVisible()
  await userEvent.click(page.getByRole('button', { name: '保存', exact: true }))
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(edit).toHaveFocus()
  expect(f.bodies).toHaveLength(1)
  expect(f.queries).toHaveLength(0)
  expect(readPendingProjectWrite({ projectId: 'other' })).toEqual(original)
})

it('核对一项项目配置后仍显示同项目另一项未知结果，不提前解锁删除或丢弃原UUID', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const f = setup()
  let seeding = true
  const queries: string[] = []
  let original: ReturnType<typeof prepareProjectWrite>
  let assistant: ReturnType<typeof prepareProjectMutation>
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (seeding) throw new TypeError('隔离原写回复丢失')
    const url = String(input)
    if (url.endsWith(`/projects/receipts/${original.body.requestId}`)) {
      queries.push(url)
      const { requestId, ...publicIntent } = original.body
      return Response.json({
        state: 'completed',
        actorId: original.actorId,
        requestId,
        projectId: f.project.id,
        environmentId: null,
        operation: 'project.save',
        saved: true,
        available: true,
        publicIntent,
        createdAt: '2026-10-27T00:00:00Z',
        nativeSynchronization: 'current-verified',
        result: f.project,
      })
    }
    if (url.endsWith(`/projects/directory-project/assistants/receipts/${assistant.body.requestId}`)) {
      queries.push(url)
      return Response.json({
        state: 'completed', actorId: assistant.actorId, requestId: assistant.body.requestId,
        projectId: f.project.id, operation: 'allocation.save:member:member', saved: true,
        available: false, createdAt: '2026-10-27T00:00:00Z',
        publicIntent: { algorithm: 'sha256', digest: bytesToHex(sha256(new TextEncoder().encode(projectAssistantReceiptIntent('allocation.save:member:member', assistant.body)))) },
      })
    }
    return f.fetch(input, init)
  })
  using _fetch = stubGlobal('fetch', fetcher)
  original = prepareProjectWrite('/api/v1/projects/directory-project/settings', 1, {
    name: f.project.name,
    description: '',
  })
  await expect(submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  assistant = prepareProjectMutation(
    '/api/v1/projects/directory-project/assistant-allocations',
    0,
    {
      target: { kind: 'member', id: 'member' },
      assistantIds: ['helper'],
      defaultAssistantId: null,
    },
  )
  await expect(submitProjectWrite(assistant)).rejects.toMatchObject({ uncertain: true })
  seeding = false
  const first = readPendingProjectWrite({ projectId: 'directory-project' })!
  const remaining = first.body.requestId === original.body.requestId ? assistant : original
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const retry = screen.getByRole('button', { name: '重试', exact: true })
  await expect.element(retry).toBeEnabled()
  await userEvent.click(retry)
  await vi.waitFor(() => expect(queries).toHaveLength(1))
  await vi.waitFor(() =>
    expect(readPendingProjectWrite({ projectId: 'directory-project' })).toEqual(remaining),
  )
  expect(queries[0]).toContain(`/receipts/${first.body.requestId}`)
  await expect
    .element(screen.getByRole('button', { name: `管理项目 ${f.project.name}`, exact: true }))
    .toBeDisabled()
  await expect.element(screen.getByText('上一次保存结果尚待确认', { exact: true })).toBeVisible()
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
})

it('项目A保存未知后关闭表单继续保存B，返回A只核原收据且不重发', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const f = setup({ loseResponse: true })
  f.setReceiptMode('missing')
  const second = { ...f.project, id: 'other-project', name: '另一项目', environments: [] }
  const host = readAutoOpsHost()!
  const secondWrites: Array<Record<string, unknown>> = []
  const bootstrap = () => ({
    ...host,
    projects: [
      { ...host.projects[0]!, name: f.project.name },
      { ...host.projects[0]!, id: second.id, name: second.name, environments: [] },
    ],
  })
  installAutoOpsHost(bootstrap(), window.location.origin)
  using _fetch = stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname
      if (path.endsWith('/autoops/bootstrap')) return Response.json(bootstrap())
      if (path.endsWith('/api/v1/projects')) {
        const items = [f.project, second]
        expect(new Set(items.map((project) => project.id)).size).toBe(items.length)
        return Response.json({ items })
      }
      if (path.endsWith('/projects/other-project/settings')) {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { value: { name: string } }
          secondWrites.push(body)
          second.name = body.value.name
          second.revision++
          return Response.json(second)
        }
        return Response.json({ project: second, members: [], candidates: [] })
      }
      if (path.endsWith('/projects/other-project/workspace/authoring'))
        return Response.json({
          projectId: second.id,
          revision: 0,
          sources: [],
          entries: [],
          limits: { maxFileBytes: 8000000, maxBytes: 50000000, maxFiles: 100 },
        })
      return f.fetch(input, init)
    }),
  )
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  await expect.element(screen.getByRole('button', { name: '编辑项目', exact: true })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: '编辑项目', exact: true }))
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('待核对的项目A')
  await userEvent.click(page.getByRole('button', { name: '保存', exact: true }))
  const dialog = page.getByRole('dialog', { name: '编辑项目', exact: true })
  await expect.element(dialog).toBeVisible()
  await expect.element(dialog.getByRole('button', { name: '重试', exact: true })).toBeEnabled()
  const original = readPendingProjectWrite({ projectId: 'directory-project' })!
  await expect
    .element(dialog.getByRole('button', { name: '关闭', exact: true }).filter({ hasText: '关闭' }))
    .toBeEnabled()
  await userEvent.keyboard('{Escape}')
  await expect.element(dialog).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '刷新项目', exact: true })).toHaveFocus()
  expect(readPendingProjectWrite({ projectId: 'directory-project' })).toEqual(original)
  await userEvent.click(screen.getByRole('button', { name: '另一项目', exact: true }))
  await vi.waitFor(() =>
    expect(screen.router?.state.location.search).toMatchObject({ projectId: 'other-project' }),
  )
  await expect.element(screen.getByRole('button', { name: '编辑项目', exact: true })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: '编辑项目', exact: true }))
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('已保存的项目B')
  await userEvent.click(page.getByRole('button', { name: '保存', exact: true }))
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(secondWrites).toHaveLength(1)
  expect(readPendingProjectWrite({ projectId: 'directory-project' })).toEqual(original)
  f.setReceiptMode('completed')
  await userEvent.click(screen.getByRole('button', { name: '待核对的项目A', exact: true }))
  await userEvent.click(screen.getByRole('button', { name: '重试', exact: true }))
  await vi.waitFor(() =>
    expect(readPendingProjectWrite({ projectId: 'directory-project' })).toBeNull(),
  )
  expect(f.bodies).toHaveLength(1)
  expect(f.queries).toHaveLength(2)
  expect(f.queries[0]).toBe(f.queries[1])
  expect(f.queries[1]).toContain(original.body.requestId)
})

it('管理员编辑项目到可见保存结果，保留待分配成员，关闭表单恢复入口焦点', async () => {
  await page.viewport(390, 500)
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const edit = screen.getByRole('button', { name: '编辑项目', exact: true })
  await expect.element(edit).toBeVisible()
  await expect.element(screen.getByText('待管理员分配')).toBeVisible()
  await edit.click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('调整后的项目')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(screen.getByText('调整后的项目', { exact: true }).first()).toBeVisible()
  await expect.element(edit).toHaveFocus()
  expect(f.bodies).toHaveLength(1)
  expect(f.writes()).toBe(1)
})

it('修订冲突保留填写内容及真实错误，取消与 Esc 恢复焦点', async () => {
  const f = setup({ failFirst: true })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const edit = screen.getByRole('button', { name: '编辑项目', exact: true })
  await expect.element(edit).toBeVisible(); await edit.click()
  const name = page.getByRole('textbox', { name: '名称', exact: true })
  await name.fill('保留这个输入')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(name).toHaveValue('保留这个输入')
  await expect.element(page.getByRole('dialog').getByRole('alert')).toHaveTextContent('配置已经修改，请核对')
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(edit).toHaveFocus()
  expect(f.writes()).toBe(0)
})

it("保存响应丢失自动GET原收据，不发送第二次POST并恢复焦点", async () => {
  const f = setup({ loseResponse: true })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const edit = screen.getByRole('button', { name: '编辑项目', exact: true })
  await expect.element(edit).toBeVisible(); await edit.click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('断线保存')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.bodies).toHaveLength(1)
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]).toBe(
    `/api/agent-demo/t3/api/v1/projects/receipts/${(f.bodies[0] as { requestId: string }).requestId}`,
  )
  expect(f.writes()).toBe(1)
})

it('只读成员可以查看项目和已分配环境，不请求成员设置或展示管理动作', async () => {
  const f = setup({ manage: false })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  await expect.element(screen.getByText('测试环境', { exact: true })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: '编辑项目', exact: true })).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '添加环境' })).not.toBeInTheDocument()
  expect(f.fetch.mock.calls.some(([url]) => String(url).endsWith('/settings'))).toBe(false)
})

it('从全部项目打开创建表单，提交名称并进入原返回项目，不额外提交环境创建', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects' })
  await screen.getByRole('button', { name: '创建项目', exact: true }).click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('新的空项目')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await vi.waitFor(() => expect(screen.router?.state.location.search).toEqual({ projectId: 'directory-project' }),
  )
  expect(mocks.select).toHaveBeenCalledWith('directory-project')
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(f.bodies[0]).toMatchObject({ expectedRevision: 0, value: { name: '新的空项目', description: '' },
  })
});

it.each(['missing', 'unavailable', 'mismatch'] as const)(
  '原收据%s允许关闭表单但保留原标识，手动核对仅GET同收据后恢复',
  async (mode) => {
    using _timers = fakeTimers({ shouldAdvanceTime: true })
    const f = setup({ loseResponse: true })
    f.setReceiptMode(mode)
    using _fetch = stubGlobal('fetch', f.fetch)
    await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
    const edit = screen.getByRole('button', { name: '编辑项目', exact: true })
    await expect.element(edit).toBeVisible()
    await edit.click()
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('原未知修改')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect.element(dialog.getByRole('button', { name: '重试', exact: true })).toBeEnabled()
    await expect
      .element(
        dialog.getByRole('button', { name: '关闭', exact: true }).filter({ hasText: '关闭' }),
      )
      .toBeEnabled()
    const original = readPendingProjectWrite()
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '刷新项目', exact: true }))
      .toHaveFocus()
    expect(readPendingProjectWrite()).toEqual(original)
    expect(original?.submitted).toBe(true)
    expect(f.bodies).toHaveLength(1)
    expect(f.queries).toHaveLength(1)
    f.setReceiptMode('completed')
    await userEvent.click(screen.getByRole('button', { name: '重试', exact: true }))
    await expect.element(dialog).not.toBeInTheDocument()
    await expect.element(edit).toBeEnabled()
    expect(f.queries).toEqual([f.queries[0], f.queries[0]])
    expect(f.bodies).toHaveLength(1)
    expect(readPendingProjectWrite()).toBeNull()
  },
)

it("原写已保存后撤权只确认最小事实，关闭旧编辑并移除管理入口不再次POST", async () => {
  const f = setup({ loseResponse: true });
  f.revokeDuringRecovery();
  using _fetch = stubGlobal("fetch", f.fetch);
  await using screen = await render(<App />, { router: "/projects?projectId=directory-project" });
  const edit = screen.getByRole("button", { name: "编辑项目", exact: true });
  await expect.element(edit).toBeVisible();
  await edit.click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("已保存但现已撤权");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "编辑项目", exact: true }))
    .not.toBeInTheDocument();
  expect(f.bodies).toHaveLength(1);
  expect(f.queries).toHaveLength(1);
  expect(readPendingProjectWrite()).toBeNull();
});


it('页面重开原项目已退出活动目录时，核原收据后仍能显式继续同一删除', async () => {
  const f = setup()
  const original = prepareProjectMutation('/api/v1/projects/directory-project', 1, {}, 'DELETE')
  let completed = false
  const resumes: unknown[] = [], deletes: unknown[] = [], queries: string[] = [], previews: string[] = []
  const originalReceipt = () => ({ state: completed ? 'completed' : 'pending', actorId: 'directory-owner', projectId: 'directory-project', environmentId: null, requestId: original.body.requestId, operation: 'project.delete', saved: true, available: false, canResume: !completed, publicIntent: { expectedRevision: 1 }, nativeSynchronization: 'not-required', createdAt: '2026-10-27T00:00:00Z', ...(completed ? { result: { deleted: true, projectId: 'directory-project' } } : {}) })
  using _fetch = stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'DELETE') { deletes.push(JSON.parse(String(init.body))); throw new TypeError('原删除已接受但响应丢失') }
    if (url.endsWith('/resume')) { resumes.push(JSON.parse(String(init?.body))); completed = true; return Response.json(originalReceipt()) }
    if (url.includes('/projects/receipts/')) { queries.push(url); return Response.json(originalReceipt()) }
    if (url.endsWith('/deletion-preview')) { previews.push(url); return Response.json({ error: '原项目已不在活动目录' }, { status: 404 }) }
    if (url.endsWith('/projects')) return Response.json({ items: [] })
    return f.fetch(input, init)
  }))
  await expect(submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  await using screen = await render(<App />, { router: '/projects' })
  await expect.element(screen.getByText('没有可见项目', { exact: true })).toBeVisible()
  await screen.getByRole('button', { name: '重试', exact: true }).click()
  await expect.element(page.getByRole('dialog', { name: '删除项目', exact: true })).toBeVisible()
  await expect.element(page.getByRole('button', { name: '继续删除', exact: true })).toBeEnabled()
  expect(resumes).toHaveLength(0)
  expect(previews).toHaveLength(0)
  await page.getByRole('button', { name: '继续删除', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '创建项目', exact: true })).toBeEnabled()
  expect(resumes).toEqual([{ operation: 'project.delete', projectId: 'directory-project', publicIntent: { expectedRevision: 1 } }])
  expect(deletes).toHaveLength(1)
  expect(queries).toHaveLength(2)
  expect(queries[0]).toBe(queries[1])
  expect(readPendingProjectWrite()).toBeNull()
})
