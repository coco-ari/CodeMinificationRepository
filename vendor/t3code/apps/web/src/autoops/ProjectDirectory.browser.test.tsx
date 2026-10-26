import { StrictMode } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render, stubGlobal } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { ModuleSidebarProvider, ModuleSidebarOutlet } from './ModuleWorkspace'
import { AutoOpsProjectsPage } from './ProjectsPage'
import { installAutoOpsHost } from './hostConfig'
import '../index.css'

const mocks = vi.hoisted(() => ({ select: vi.fn() }))
vi.mock(import('./projectNavigation'), async original => ({ ...await original(), selectAutoOpsProject: mocks.select }))
function setup({ manage = true, failFirst = false, loseResponse = false } = {}) {
  mocks.select.mockReset()
  window.sessionStorage.clear()
  let fail = failFirst, lost = loseResponse, writes = 0
  const bodies: object[] = []
  const project = { id: 'directory-project', name: '原项目', description: '', revision: 1, createdBy: 'directory-owner', createdAt: '2026-10-26T00:00:00Z', environments: [{ id: 'test', name: '测试环境', revision: 1 }] }
  const bootstrap = () => ({
    principal: { id: 'directory-owner', displayName: '目录用户' }, csrfToken: 'test-csrf', gatewayBasePath: '/api/agent-demo/t3', fixedModel: { instanceId: 'codex', model: 'test-model' }, runtimeMode: 'approval-required' as const, canCreateProject: true, capabilities: {},
    projects: [{ ...project, agents: [], capabilities: { 'project.manage': manage, 'workspace.read': true, 'workspace.manage': manage, 'deployment.read': true, 'deployment.execute': manage } }],
  })
  installAutoOpsHost(bootstrap(), window.location.origin)
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/autoops/bootstrap')) return Response.json(bootstrap())
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { requestId: string; value: { name: string } }
      bodies.push(body)
      if (fail) { fail = false; return Response.json({ code: 'PROJECT_REVISION_CONFLICT', error: '配置已经修改，请核对' }, { status: 409 }) }
      if (writes === 0) { writes++; project.name = body.value.name; project.revision++ }
      if (lost) { lost = false; throw new TypeError('隔离测试丢失响应') }
      return Response.json(project)
    }
    if (url.endsWith('/settings')) return Response.json({ project, members: [{ userId: 'pending-user', name: '待分配成员', role: 'reader', authorizationPending: true, environmentIds: ['test'], status: 'active', environmentRoles: {}, revision: 1, kind: 'internal', canAdjustChat: true }], candidates: [] })
    return Response.json({ items: [project] })
  })
  return { fetch, bodies, project, writes: () => writes }
}
function App() {
  return <StrictMode><SidebarProvider><ModuleSidebarProvider><ModuleSidebarOutlet /><AutoOpsProjectsPage /></ModuleSidebarProvider></SidebarProvider></StrictMode>
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

it('保存响应丢失自动沿原请求核对，不生成第二次写入', async () => {
  const f = setup({ loseResponse: true })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=directory-project' })
  const edit = screen.getByRole('button', { name: '编辑项目', exact: true })
  await expect.element(edit).toBeVisible(); await edit.click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('断线保存')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.bodies).toHaveLength(2)
  expect(f.bodies[1]).toEqual(f.bodies[0])
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
  await vi.waitFor(() => expect(screen.router?.state.location.search).toEqual({ projectId: 'directory-project' }))
  expect(mocks.select).toHaveBeenCalledWith('directory-project')
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(f.bodies[0]).toMatchObject({ expectedRevision: 0, value: { name: '新的空项目', description: '' } })
})
