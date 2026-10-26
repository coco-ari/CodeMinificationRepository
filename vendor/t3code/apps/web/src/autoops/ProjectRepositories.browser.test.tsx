import { StrictMode } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render, stubGlobal } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { ModuleSidebarProvider, ModuleSidebarOutlet } from './ModuleWorkspace'
import { AutoOpsProjectsPage } from './ProjectsPage'
import { installAutoOpsHost } from './hostConfig'
import type { ProjectRepositoryConnection, ProjectRepositoryDetails } from './projectRepositories'
import '../index.css'

function setup({ manage = true, lost = false, inUse = false, denied = false } = {}) {
  window.sessionStorage.clear()
  let lose = lost,
    revision = 7,
    deny = denied,
    failCheck = true
  const items: ProjectRepositoryConnection[] = [
    {
      id: 'repo-one',
      name: '业务仓库',
      url: 'https://isolated.invalid/project.git',
      credentialId: 'credential-one',
    },
  ]
  const writes: Array<{
    path: string
    body: { requestId: string; expectedRevision: number; value?: ProjectRepositoryDetails }
  }> = []
  const receipts = new Map<string, object>()
  const project = {
    id: 'repo-project',
    name: '仓库验收项目',
    description: '',
    revision: 1,
    createdBy: 'repo-user',
    createdAt: '2026-10-26T00:00:00Z',
    environments: [],
  }
  const bootstrap = () => ({
    principal: { id: 'repo-user', displayName: '仓库管理员' },
    csrfToken: 'csrf',
    gatewayBasePath: '/api/agent-demo/t3',
    fixedModel: { instanceId: 'codex', model: 'test-model' },
    runtimeMode: 'approval-required' as const,
    capabilities: {},
    projects: [
      {
        ...project,
        agents: [],
        capabilities: {
          'project.manage': manage,
          'workspace.read': true,
          'workspace.manage': manage,
          'deployment.read': true,
          'deployment.execute': manage,
        },
      },
    ],
  })
  installAutoOpsHost(bootstrap(), window.location.origin)
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path.endsWith('/autoops/bootstrap')) return Response.json(bootstrap())
    if (path.endsWith('/workspace/authoring'))
      return Response.json({
        projectId: project.id,
        revision: 0,
        sources: [],
        entries: [],
        limits: { maxFileBytes: 8000000, maxBytes: 50000000, maxFiles: 100 },
      })
    if (path.endsWith('/workspace/credentials'))
      return Response.json({
        credentials: [
          {
            id: 'credential-one',
            name: '只读令牌',
            username: 'reader',
            revision: 1,
            revoked: false,
          },
        ],
      })
    if (path.endsWith('/assistants/choices'))
      return Response.json({ agents: [], sources: [], platformSkills: [] })
    if (path.endsWith('/assistants/settings'))
      return Response.json({ presets: [], allocations: [] })
    if (path.endsWith('/settings')) return Response.json({ project, members: [], candidates: [] })
    if (path.includes('/repositories')) {
      if (deny)
        return Response.json(
          { code: 'PROJECT_ACTION_FORBIDDEN', error: '仓库管理权限已撤回' },
          { status: 403 },
        )
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as (typeof writes)[number]['body']
        writes.push({ path, body })
        if (path.endsWith('/remove') && inUse)
          return Response.json(
            { code: 'REPOSITORY_IN_USE', error: '工作区仍使用此仓库，请先移除工作区来源' },
            { status: 409 },
          )
        let result = receipts.get(body.requestId)
        if (!result) {
          if (body.expectedRevision !== revision) throw new Error('测试请求修订错误')
          if (path.endsWith('/remove')) {
            items.splice(0, 1)
            result = { requestId: body.requestId, revision: ++revision }
          } else {
            if (
              !body.value ||
              Object.keys(body.value).some((key) => !['name', 'url', 'credentialId'].includes(key))
            )
              throw new Error('连接混入了业务参数')
            const connection = {
              ...body.value,
              id: path.endsWith('/repositories') ? 'repo-new' : 'repo-one',
            }
            const index = items.findIndex((item) => item.id === connection.id)
            if (index >= 0) items[index] = connection
            else items.push(connection)
            result = { requestId: body.requestId, revision: ++revision, repository: connection }
          }
          receipts.set(body.requestId, result)
        }
        if (lose) {
          lose = false
          throw new TypeError('隔离测试丢失响应')
        }
        return Response.json(result)
      }
      if (path.endsWith('/refs')) {
        if (failCheck) {
          failCheck = false
          return Response.json(
            { code: 'GIT_UNAVAILABLE', error: '远端暂时不可达' },
            { status: 502 },
          )
        }
        return Response.json({
          sourceId: 'repo-one',
          defaultRef: 'main',
          branches: [{ name: 'main', commit: 'a'.repeat(40) }],
          tags: [],
          truncated: false,
        })
      }
      return Response.json({ revision, items })
    }
    return Response.json({ items: [project] })
  })
  return {
    fetch,
    writes,
    items,
    receipts,
    revoke: () => {
      deny = true
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
  )
}

it('窄短窗口创建项目连接仅保存仓库与凭证，关闭后恢复添加入口焦点', async () => {
  await page.viewport(390, 500)
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=repo-project' })
  const add = screen.getByRole('button', { name: '添加仓库', exact: true })
  await expect.element(add).toBeEnabled()
  await add.click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('新增连接')
  await page
    .getByRole('textbox', { name: 'HTTPS 仓库地址', exact: true })
    .fill('https://isolated.invalid/new.git')
  await page.getByRole('combobox', { name: '项目凭证', exact: true }).click()
  await page.getByRole('option', { name: '只读令牌', exact: true }).click()
  await expect
    .element(page.getByRole('combobox', { name: '分支', exact: true }))
    .not.toBeInTheDocument()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect
    .element(screen.getByRole('button', { name: '编辑仓库 新增连接', exact: true }))
    .toBeVisible()
  await expect.element(add).toHaveFocus()
  expect(f.writes[0]?.body).toMatchObject({
    expectedRevision: 7,
    value: {
      name: '新增连接',
      url: 'https://isolated.invalid/new.git',
      credentialId: 'credential-one',
    },
  })
})

it('编辑连接保留凭证引用，丢失响应按原请求核对且不重复创建', async () => {
  const f = setup({ lost: true })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=repo-project' })
  const edit = screen.getByRole('button', { name: '编辑仓库 业务仓库', exact: true })
  await expect.element(edit).toBeEnabled()
  await edit.click()
  await page
    .getByRole('textbox', { name: 'HTTPS 仓库地址', exact: true })
    .fill('https://isolated.invalid/changed.git')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(edit).toHaveFocus()
  expect(f.writes).toHaveLength(2)
  expect(f.writes[0]).toEqual(f.writes[1])
  expect(f.writes[0]?.body.value).toEqual({
    name: '业务仓库',
    url: 'https://isolated.invalid/changed.git',
    credentialId: 'credential-one',
  })
  expect(f.receipts.size).toBe(1)
  expect(f.items).toHaveLength(1)
})

it('连接检查失败后可沿原入口重试，检查不修改任何连接或业务分支', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=repo-project' })
  const check = screen.getByRole('button', { name: '检查连接', exact: true })
  await expect.element(check).toBeEnabled()
  await check.click()
  await expect.element(screen.getByRole('alert')).toHaveTextContent('远端暂时不可达')
  await expect.element(check).toBeEnabled()
  await check.click()
  await expect.element(screen.getByText('连接正常 · 1 个分支', { exact: true })).toBeVisible()
  expect(f.writes).toHaveLength(0)
})

it('使用中的连接拒绝移除并保留恢复入口，Esc 返回原管理菜单按钮', async () => {
  const f = setup({ inUse: true })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=repo-project' })
  const menu = screen.getByRole('button', { name: '管理仓库 业务仓库', exact: true })
  await expect.element(menu).toBeEnabled()
  await menu.click()
  await page.getByRole('menuitem', { name: '移除连接', exact: true }).click()
  await page.getByRole('button', { name: '移除连接', exact: true }).click()
  await expect
    .element(page.getByRole('dialog').getByRole('alert'))
    .toHaveTextContent('工作区仍使用此仓库，请先移除工作区来源')
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(menu).toHaveFocus()
  expect(f.items).toHaveLength(1)
})

it('撤回仓库权限后检查返回拒绝并清除连接，保留读取重试入口', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=repo-project' })
  const check = screen.getByRole('button', { name: '检查连接', exact: true })
  await expect.element(check).toBeEnabled()
  f.revoke()
  await check.click()
  await expect
    .element(screen.getByRole('button', { name: '编辑仓库 业务仓库', exact: true }))
    .not.toBeInTheDocument()
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('仓库管理权限已撤回重试仓库配置')
  await expect
    .element(screen.getByRole('button', { name: '重试仓库配置', exact: true }))
    .toBeVisible()
  expect(f.writes).toHaveLength(0)
})

it('只读成员不展示连接管理，也不请求仓库凭证配置', async () => {
  const f = setup({ manage: false })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=repo-project' })
  await expect
    .element(screen.getByRole('heading', { name: '仓库验收项目', exact: true }))
    .toBeVisible()
  await expect
    .element(screen.getByRole('button', { name: '添加仓库', exact: true }))
    .not.toBeInTheDocument()
  expect(
    f.fetch.mock.calls.some(
      ([url]) => String(url).includes('/repositories') || String(url).includes('/credentials'),
    ),
  ).toBe(false)
})

it('未被使用的连接可移除，结果刷新后焦点返回添加仓库入口', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=repo-project' })
  const menu = screen.getByRole('button', { name: '管理仓库 业务仓库', exact: true })
  await expect.element(menu).toBeEnabled()
  await menu.click()
  await page.getByRole('menuitem', { name: '移除连接', exact: true }).click()
  await page.getByRole('button', { name: '移除连接', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(menu).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '添加仓库', exact: true })).toHaveFocus()
  expect(f.items).toHaveLength(0)
  expect(f.writes[0]?.body).toEqual({ requestId: expect.any(String), expectedRevision: 7 })
})
