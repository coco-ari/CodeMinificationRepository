import { StrictMode } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render, stubGlobal } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { ModuleSidebarProvider, ModuleSidebarOutlet } from './ModuleWorkspace'
import { AutoOpsProjectsPage } from './ProjectsPage'
import { installAutoOpsHost } from './hostConfig'
import type { AssistantPreset, AssistantChoices } from './projectAssistants'
import '../index.css'

function setup({ lost = false, conflict = false, manage = true, denied = false } = {}) {
  window.sessionStorage.clear()
  let lose = lost, reject = conflict
  const writes: Array<{ path: string; body: Record<string, any> }> = [], receipts = new Map<string, unknown>()
  const project = { id: 'config-project', name: '配置验收项目', description: '', revision: 1, createdBy: 'config-user', createdAt: '2026-10-26T00:00:00Z', environments: [{ id: 'test', name: '测试环境', revision: 1 }, { id: 'production', name: '生产环境', revision: 1 }] }
  const members = [{ userId: 'member', name: '待分配成员', kind: 'internal', role: 'reader', environmentIds: ['test'], environmentRoles: {}, canAdjustChat: false, status: 'active', revision: 1, authorizationPending: true }]
  const presets: AssistantPreset[] = [{ id: 'helper', projectId: project.id, name: '资料分析', description: '', instructions: '使用本项目资料', enabled: true, revision: 1, createdBy: 'config-user', updatedAt: 'now', configuration: { agentId: 'a-project', executionBinding: { kind: 'platform' }, environmentId: null, workspaceType: 'internal', visibility: 'private', model: { instanceId: 'codex', model: 'actual-model', reasoningEffort: 'high' }, skillIds: [] } }]
  const allocations: Array<Record<string, unknown>> = []
  const choices: AssistantChoices = { agents: [{ id: 'a-project', name: '项目开发' }], sources: [{ id: 'platform', name: '平台运行器', executionBinding: { kind: 'platform' }, available: true, models: [{ id: 'first-other-model', name: '其他模型', reasoningLevels: ['low'], defaultReasoning: 'low' }, { id: 'actual-model', name: '实际模型', reasoningLevels: ['low', 'high'], defaultReasoning: 'high' }], skills: [] }], platformSkills: [{ id: 'skill', name: '诊断技能', agentId: 'a-project', workspaceType: 'internal' }] }
  const bootstrap = () => ({ principal: { id: 'config-user', displayName: '配置用户' }, csrfToken: 'csrf', gatewayBasePath: '/api/agent-demo/t3', fixedModel: { instanceId: 'codex', model: 'first-other-model' }, runtimeMode: 'approval-required' as const, capabilities: {}, projects: [{ ...project, agents: [{ id: 'a-project', name: '项目开发' }], capabilities: { 'project.manage': manage, 'workspace.read': true, 'workspace.manage': manage, 'deployment.read': true, 'deployment.execute': manage } }] })
  installAutoOpsHost(bootstrap(), window.location.origin)
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, any>
      writes.push({ path, body })
      if (reject) { reject = false; return Response.json({ code: 'PROJECT_DEFAULT_ASSISTANT_REQUIRED', error: '受限成员需要先分配有效默认助手' }, { status: 409 }) }
      let result = receipts.get(body.requestId)
      if (!result) {
        if (path.endsWith('/assistant-allocations')) { result = { ...body, revision: 1 }; allocations.push(result as Record<string, unknown>) }
        else if (path.endsWith('/members')) { Object.assign(members[0]!, body.value, { revision: 2, authorizationPending: false }); result = members[0] }
        else { const id = path.endsWith('/assistants') ? 'new-helper' : path.split('/').at(-1)!; const existing = presets.find(preset => preset.id === id); const preset = { ...body.value, id, projectId: project.id, revision: (existing?.revision ?? 0) + 1, createdBy: 'config-user', updatedAt: 'now' }; if (existing) Object.assign(existing, preset); else presets.push(preset); result = preset }
        receipts.set(body.requestId, result)
      }
      if (lose) { lose = false; throw new TypeError('隔离测试丢失响应') }
      return Response.json(result)
    }
    if (path.endsWith('/autoops/bootstrap')) return Response.json(bootstrap())
    if (path.endsWith('/assistants/choices')) return denied ? Response.json({ code: 'PROJECT_ACTION_FORBIDDEN', error: '项目管理权限已撤回' }, { status: 403 }) : Response.json(choices)
    if (path.endsWith('/assistants/settings')) return Response.json({ presets, allocations })
    if (path.endsWith('/settings')) return Response.json({ project, members, candidates: [{ id: 'member', name: '待分配成员', kind: 'internal' }, { id: 'external', name: '外部账号', kind: 'external' }] })
    return Response.json({ items: [project] })
  })
  return { fetch, writes, presets, choices, allocations, receipts }
}
function App() { return <StrictMode><SidebarProvider><ModuleSidebarProvider><ModuleSidebarOutlet /><AutoOpsProjectsPage /></ModuleSidebarProvider></SidebarProvider></StrictMode> }
const choose = async (label: string, name: string) => { await page.getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name, exact: true }).click() }

it('短窗口创建助手明确选择实际模型，使用其真实默认强度，保存返回并恢复原入口焦点', async () => {
  await page.viewport(390, 500)
  const f = setup(); using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=config-project' })
  const add = screen.getByRole('button', { name: '添加助手', exact: true })
  await expect.element(add).toBeEnabled(); await add.click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('测试排障助手')
  await expect.element(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await choose('模型', '实际模型')
  await expect.element(page.getByRole('combobox', { name: '思考强度', exact: true })).toHaveTextContent('high')
  await page.getByRole('checkbox', { name: '诊断技能', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(add).toHaveFocus()
  expect(f.writes[0]?.body.value.configuration).toMatchObject({ model: { instanceId: 'codex', model: 'actual-model', reasoningEffort: 'high' }, skillIds: ['skill'], environmentId: null })
  expect(f.presets.find(preset => preset.name === '测试排障助手')).toBeDefined()
})

it('成员环境覆盖角色完整提交，待分配状态不会在只读页面自动启用', async () => {
  const f = setup(); using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=config-project' })
  const edit = screen.getByRole('button', { name: '编辑成员 待分配成员', exact: true })
  await expect.element(edit).toBeEnabled()
  expect(f.writes).toHaveLength(0)
  await edit.click(); await choose('项目角色', '发布运维')
  await page.getByRole('checkbox', { name: '生产环境', exact: true }).click()
  await choose('生产环境角色', '只读成员')
  await page.getByRole('checkbox', { name: '允许调整问答配置', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(edit).toHaveFocus()
  expect(f.writes[0]?.body.value).toMatchObject({ userId: 'member', role: 'release_operator', environmentIds: ['test', 'production'], environmentRoles: { production: 'reader' }, canAdjustChat: true })
})

it('默认助手缺失失败保留成员表单及错误，取消恢复焦点且不扩大环境', async () => {
  const f = setup({ conflict: true }); using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=config-project' })
  const edit = screen.getByRole('button', { name: '编辑成员 待分配成员', exact: true })
  await expect.element(edit).toBeEnabled(); await edit.click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog').getByRole('alert')).toHaveTextContent('受限成员需要先分配有效默认助手')
  await expect.element(page.getByRole('checkbox', { name: '测试环境', exact: true })).toBeChecked()
  await expect.element(page.getByRole('checkbox', { name: '生产环境', exact: true })).not.toBeChecked()
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(edit).toHaveFocus()
})

it('助手分配响应丢失自动核对同一请求，不重复授权，成员默认值完整发送', async () => {
  const f = setup({ lost: true }); using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=config-project' })
  const assign = screen.getByRole('button', { name: '分配助手给 待分配成员', exact: true })
  await expect.element(assign).toBeEnabled(); await assign.click()
  await page.getByRole('checkbox', { name: '资料分析', exact: true }).click()
  await choose('默认助手', '资料分析')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(assign).toHaveFocus()
  expect(f.writes).toHaveLength(2)
  expect(f.writes[0]?.body).toEqual(f.writes[1]?.body)
  expect(f.writes[0]?.body).toMatchObject({ target: { kind: 'member', id: 'member' }, assistantIds: ['helper'], defaultAssistantId: 'helper' })
  expect(f.allocations).toHaveLength(1)
})

it('编辑用户来源保留原目录、实际模型及思考强度，不被平台模型或目录顺序覆盖', async () => {
  const f = setup(), source = { kind: 'customer' as const, deviceId: '11111111-1111-4111-8111-111111111111', registeredWorkspaceId: 'registered-root', workspaceBindingRevision: 2, runtimeId: 'codex' as const }
  f.choices.sources.push({ id: 'own-source', name: '自己的电脑 · 登记目录', executionBinding: source, available: true, models: [{ id: 'customer-model', name: '本机模型', reasoningLevels: ['high'], defaultReasoning: 'high' }], skills: [] })
  Object.assign(f.presets[0]!.configuration, { executionBinding: { runtimeId: 'codex', workspaceBindingRevision: 2, registeredWorkspaceId: source.registeredWorkspaceId, deviceId: source.deviceId, kind: 'customer' }, environmentId: null, workspaceType: null, model: { instanceId: `customer-${source.deviceId}-codex`, model: 'customer-model', reasoningEffort: 'high' } })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=config-project' })
  const edit = screen.getByRole('button', { name: '编辑助手 资料分析', exact: true })
  await expect.element(edit).toBeEnabled(); await edit.click()
  await expect.element(page.getByRole('combobox', { name: '运行来源', exact: true })).toHaveTextContent('自己的电脑 · 登记目录')
  await expect.element(page.getByRole('combobox', { name: '模型', exact: true })).toHaveTextContent('本机模型')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.writes[0]?.body.value.configuration).toMatchObject({ executionBinding: source, model: { model: 'customer-model', reasoningEffort: 'high' }, workspaceType: null })
})


it('管理读取被撤回时移除已显示的配置和成员入口，保留项目页面及恢复入口', async () => {
  const f = setup({ denied: true }); using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=config-project' })
  await expect.element(screen.getByText('项目管理权限已撤回')).toBeVisible()
  await expect.element(screen.getByRole('button', { name: '编辑成员 待分配成员', exact: true })).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '编辑助手 资料分析', exact: true })).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '重试项目配置', exact: true })).toBeVisible()
  expect(f.writes).toHaveLength(0)
})
