import { StrictMode } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render, stubGlobal } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { ModuleSidebarProvider, ModuleSidebarOutlet } from './ModuleWorkspace'
import { AutoOpsProjectsPage } from './ProjectsPage'
import { installAutoOpsHost } from './hostConfig'
import { prepareProjectMutation, submitProjectWrite, readPendingProjectWrite } from "./projectDirectory";
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

it.each(["missing", "unavailable", "mismatch"] as const)(
  "原收据%s保留表单和原标识，手动重试仅GET同收据后恢复",
  async (mode) => {
    const f = setup({ loseResponse: true });
    f.setReceiptMode(mode);
    using _fetch = stubGlobal("fetch", f.fetch);
    await using screen = await render(<App />, { router: "/projects?projectId=directory-project" });
    const edit = screen.getByRole("button", { name: "编辑项目", exact: true });
    await expect.element(edit).toBeVisible();
    await edit.click();
    await page.getByRole("textbox", { name: "名称", exact: true }).fill("原未知修改");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByRole("button", { name: "重试", exact: true })).toBeEnabled();
    await expect.element(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).toBeVisible();
    const original = readPendingProjectWrite();
    expect(original?.submitted).toBe(true);
    expect(f.bodies).toHaveLength(1);
    expect(f.queries).toHaveLength(1);
    f.setReceiptMode("completed");
    await dialog.getByRole("button", { name: "重试", exact: true }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(edit).toHaveFocus();
    expect(f.queries).toEqual([f.queries[0], f.queries[0]]);
    expect(f.bodies).toHaveLength(1);
    expect(readPendingProjectWrite()).toBeNull();
  },
);

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
