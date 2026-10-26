import { StrictMode } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render, stubGlobal } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { ModuleSidebarProvider, ModuleSidebarOutlet } from './ModuleWorkspace'
import { AutoOpsProjectsPage } from './ProjectsPage'
import { installAutoOpsHost } from './hostConfig'
import '../index.css'

function setup({ platform = false, manage = true, empty = false } = {}) {
  window.sessionStorage.clear()
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  const project = { id: 'node-project', name: '节点验收项目', description: '', revision: 1, createdBy: 'node-owner', createdAt: '2026-10-26T00:00:00Z', environments: [{ id: 'test', name: '测试环境', revision: 1 }] }
  const bootstrap = () => ({
    principal: { id: 'node-owner', displayName: '节点验收用户' }, csrfToken: 'test-csrf', gatewayBasePath: '/api/agent-demo/t3', fixedModel: { instanceId: 'codex', model: 'test-model' }, runtimeMode: 'approval-required' as const, canManageDeploymentNodes: platform, capabilities: {},
    projects: empty ? [] : [{ ...project, agents: [], capabilities: { 'project.manage': manage, 'workspace.read': true, 'workspace.manage': manage, 'deployment.read': true, 'deployment.execute': manage } }],
  })
  installAutoOpsHost(bootstrap(), window.location.origin)
  const server = { id: 'node-one', name: '隔离的项目准入节点', online: true }
  let bound = false
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      writes.push({ path, body })
      if (path.endsWith('/autoops/deployment-servers')) return Response.json({ server, registrationToken: 'isolated-token', expiresAt: '2026-10-26T09:00:00Z', installCommand: 'echo isolated-node-install' })
      if (path.endsWith('/node-one/bind')) { bound = true; return Response.json({ ok: true }) }
      return Response.json({ error: '隔离夹具未提供此写入' }, { status: 400 })
    }
    if (path.endsWith('/autoops/bootstrap')) return Response.json(bootstrap())
    if (path.endsWith('/autoops/deployment-servers')) return Response.json({ servers: [server], projects: empty ? [] : [{ ...project }], projectAccess: [], bindings: [] })
    if (path.endsWith('/deployments/servers')) return Response.json({ canAdmin: false, canBind: manage, availableServers: [server], servers: bound ? [{ ...server, environmentId: 'test', projectAllowed: true }] : [] })
    if (path.endsWith('/assistants/choices')) return Response.json({ agents: [], sources: [], platformSkills: [] })
    if (path.endsWith('/assistants/settings')) return Response.json({ presets: [], allocations: [] })
    if (path.endsWith('/repositories')) return Response.json({ revision: 0, items: [] })
    if (path.endsWith('/workspace/authoring')) return Response.json({ projectId: project.id, revision: 0, sources: [], entries: [], limits: { maxFileBytes: 8000000, maxBytes: 50000000, maxFiles: 100 } })
    if (path.endsWith('/workspace/credentials')) return Response.json({ credentials: [] })
    if (path.endsWith('/settings')) return Response.json({ project, members: [], candidates: [] })
    return Response.json({ items: empty ? [] : [project] })
  })
  return { fetch, writes, project }
}
function App() {
  return <StrictMode><SidebarProvider><ModuleSidebarProvider><ModuleSidebarOutlet /><AutoOpsProjectsPage /></ModuleSidebarProvider></SidebarProvider></StrictMode>
}

it('平台在没有项目与环境时直接接入节点，关闭后恢复平台入口焦点', async () => {
  await page.viewport(1440, 600)
  const f = setup({ platform: true, empty: true })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects' })
  const trigger = screen.getByRole('button', { name: '平台节点', exact: true })
  await expect.element(trigger).toBeEnabled()
  await trigger.click()
  await expect.element(page.getByRole('dialog', { name: '平台节点', exact: true })).toBeVisible()
  await expect.element(page.getByRole('button', { name: '接入节点', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '接入节点', exact: true }).click()
  await page.getByRole('textbox', { name: '节点名称', exact: true }).fill('平台独立节点')
  await page.getByRole('button', { name: '生成安装命令', exact: true }).click()
  await expect.element(page.getByText('echo isolated-node-install', { exact: true })).toBeVisible()
  expect(f.writes).toEqual([{ path: '/api/agent-demo/t3/autoops/deployment-servers', body: { name: '平台独立节点', requestId: expect.any(String) } }])
  expect(f.fetch.mock.calls.some(([url]) => String(url).includes('/projects/') && String(url).includes('/deployments/servers'))).toBe(false)
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(trigger).toHaveFocus()
  expect(JSON.stringify(sessionStorage)).not.toContain('isolated-token')
})

it('项目管理员在环境配置只绑定已准入节点，关闭后恢复环境入口焦点', async () => {
  await page.viewport(390, 500)
  const originalTheme = document.documentElement.className
  document.documentElement.classList.add('dark')
  try {
    const f = setup()
    using _fetch = stubGlobal('fetch', f.fetch)
    await using screen = await render(<App />, { router: '/projects?projectId=node-project' })
    const trigger = screen.getByRole('button', { name: '管理测试环境节点', exact: true })
    await expect.element(trigger).toBeEnabled()
    await expect.element(screen.getByRole('button', { name: '平台节点', exact: true })).not.toBeInTheDocument()
    await trigger.click()
    await expect.element(page.getByRole('button', { name: '接入节点', exact: true })).not.toBeInTheDocument()
    await page.getByRole('button', { name: '绑定已有节点', exact: true }).click()
    await expect.element(page.getByRole('combobox', { name: '已有节点', exact: true })).toHaveTextContent('隔离的项目准入节点 · 在线')
    await page.getByRole('button', { name: '确认绑定', exact: true }).click()
    await expect.element(page.getByText('隔离的项目准入节点', { exact: true })).toBeVisible()
    expect(f.writes).toEqual([{ path: '/api/agent-demo/t3/autoops/projects/node-project/deployments/servers/node-one/bind', body: { environmentId: 'test', requestId: expect.any(String) } }])
    expect(f.fetch.mock.calls.some(([url]) => new URL(String(url), window.location.origin).pathname.endsWith('/autoops/deployment-servers'))).toBe(false)
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    await expect.element(trigger).toHaveFocus()
  } finally {
    document.documentElement.className = originalTheme
  }
})

it('只读成员查看环境时没有平台管理和环境绑定入口，不读取节点管理目录', async () => {
  const f = setup({ manage: false })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=node-project' })
  await expect.element(screen.getByText('测试环境', { exact: true })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: '平台节点', exact: true })).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '管理测试环境节点', exact: true })).not.toBeInTheDocument()
  expect(f.fetch.mock.calls.some(([url]) => String(url).includes('deployment-servers') || String(url).includes('/deployments/servers'))).toBe(false)
  expect(f.writes).toHaveLength(0)
})
