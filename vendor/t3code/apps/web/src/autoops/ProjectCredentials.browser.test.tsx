import { StrictMode } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { render, stubGlobal } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { ModuleSidebarProvider, ModuleSidebarOutlet } from './ModuleWorkspace'
import { AutoOpsProjectsPage } from './ProjectsPage'
import { installAutoOpsHost } from './hostConfig'
import type { WorkspaceCredentialMetadata } from './workspaceAuthoring'
import '../index.css'

function setup({ lost = false, denyWrite = false, readFailure = null }: {
  lost?: boolean
  denyWrite?: boolean
  readFailure?: 'authoring' | 'credentials' | null
} = {}) {
  window.sessionStorage.clear()
  let lose = lost
  let failingRead = readFailure
  const reads: Array<{ kind: 'authoring' | 'credentials'; status: number }> = []
  const read = (kind: 'authoring' | 'credentials', value: unknown) => {
    const failed = failingRead === kind
    reads.push({ kind, status: failed ? 503 : 200 })
    return Response.json(failed ? { code: 'WORKSPACE_UNAVAILABLE', error: '凭证读取暂不可用' } : value, { status: failed ? 503 : 200 })
  }
  const project = {
    id: 'credential-project',
    name: '凭证验收项目',
    description: '',
    revision: 1,
    createdBy: 'credential-user',
    createdAt: '2026-10-26T00:00:00Z',
    environments: [],
  }
  const metadata: WorkspaceCredentialMetadata[] = [
    {
      id: 'credential-one',
      projectId: project.id,
      name: '原凭证',
      revision: 1,
      version: 1,
      revoked: false,
      createdAt: 'now',
      updatedAt: 'now',
    },
  ]
  const writes: Array<{
    action: string
    input: {
      id?: string
      requestId: string
      expectedRevision?: number
      name?: string
      username?: string
      password?: string
    }
  }> = []
  const receipts = new Map<string, WorkspaceCredentialMetadata>()
  const bootstrap = () => ({
    principal: { id: 'credential-user', displayName: '凭证管理员' },
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
          'project.manage': true,
          'workspace.read': true,
          'workspace.manage': true,
          'deployment.read': true,
          'deployment.execute': true,
        },
      },
    ],
  })
  installAutoOpsHost(bootstrap(), window.location.origin)
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname.replace(
      /^\/api\/agent-demo\/t3/,
      '',
    )
    if (path.endsWith('/autoops/bootstrap')) return Response.json(bootstrap())
    if (path.endsWith('/assistants/choices'))
      return Response.json({ agents: [], sources: [], platformSkills: [] })
    if (path.endsWith('/assistants/settings'))
      return Response.json({ presets: [], allocations: [] })
    if (path.endsWith('/repositories')) return Response.json({ revision: 0, items: [] })
    if (path.endsWith('/settings')) return Response.json({ project, members: [], candidates: [] })
    if (path.endsWith('/workspace/authoring'))
      return read('authoring', {
        projectId: project.id,
        revision: 0,
        sources: [],
        entries: [],
        limits: { maxFileBytes: 8000000, maxBytes: 50000000, maxFiles: 100 },
      })
    if (path.includes('/credentials/requests/'))
      return Response.json({ result: receipts.get(path.split('/').at(-1)!) ?? null })
    if (path.endsWith('/workspace/credentials')) {
      if (init?.method !== 'POST') return read('credentials', { credentials: metadata })
      const body = JSON.parse(String(init.body)) as (typeof writes)[number]
      writes.push(body)
      if (denyWrite)
        return Response.json(
          { code: 'PROJECT_ACTION_FORBIDDEN', error: '凭证管理权限已撤回' },
          { status: 403 },
        )
      const previous = metadata.find((item) => item.id === body.input.id)
      const result = {
        ...(previous ?? metadata[0]!),
        id: previous?.id ?? 'credential-new',
        name: body.input.name ?? previous!.name,
        revision: (previous?.revision ?? 0) + 1,
        version: body.action === 'replace' ? previous!.version + 1 : (previous?.version ?? 1),
        revoked: body.action === 'revoke',
      }
      if (previous) Object.assign(previous, result)
      else metadata.push(result)
      receipts.set(body.input.requestId, result)
      if (lose) {
        lose = false
        throw new TypeError('隔离测试丢失凭证响应')
      }
      return Response.json(result)
    }
    if (path === '/api/v1/projects') return Response.json({ items: [project] })
    throw new Error(`未处理测试请求 ${path}`)
  })
  return { fetch, writes, metadata, receipts, project, reads, setReadFailure(value: typeof failingRead) { failingRead = value } }
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
const storageText = () => Object.values(window.sessionStorage).join(' ')

it('集中创建凭证保留字段标签，保存后只展示元数据并恢复入口焦点', async () => {
  await page.viewport(390, 500)
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=credential-project' })
  const add = screen.getByRole('button', { name: '添加凭证', exact: true })
  await expect.element(add).toBeEnabled()
  await add.click()
  await page.getByRole('textbox', { name: '凭证名称', exact: true }).fill('新凭证')
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill('isolated-reader')
  await page.getByLabelText('访问令牌或密码', { exact: true }).fill('fixture-only-secret')
  await page.getByRole('button', { name: '保存凭证', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(screen.getByText('新凭证', { exact: true })).toBeVisible()
  await expect.element(add).toHaveFocus()
  expect(f.writes[0]).toMatchObject({
    action: 'create',
    input: { name: '新凭证', username: 'isolated-reader', password: 'fixture-only-secret' },
  })
  expect(storageText()).not.toContain('fixture-only-secret')
  expect(screen.container.textContent).not.toContain('fixture-only-secret')
})

it('替换凭证不回填旧秘密，提交原凭证修订后显示新版本', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=credential-project' })
  const menu = screen.getByRole('button', { name: '管理凭证 原凭证', exact: true })
  await expect.element(menu).toBeEnabled()
  await menu.click()
  await page.getByRole('menuitem', { name: '替换凭证', exact: true }).click()
  await expect.element(page.getByLabelText('访问令牌或密码', { exact: true })).toHaveValue('')
  await page.getByLabelText('访问令牌或密码', { exact: true }).fill('fixture-replacement-secret')
  await page.getByRole('button', { name: '保存凭证', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(screen.getByText('版本 2 · 可用', { exact: true })).toBeVisible()
  await expect.element(menu).toHaveFocus()
  expect(f.writes[0]).toMatchObject({
    action: 'replace',
    input: { id: 'credential-one', expectedRevision: 1 },
  })
  expect(storageText()).not.toContain('fixture-replacement-secret')
})

it('保存响应丢失后自动核对原收据并关闭秘密表单，不重复创建', async () => {
  const f = setup({ lost: true })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=credential-project' })
  const add = screen.getByRole('button', { name: '添加凭证', exact: true })
  await expect.element(add).toBeEnabled()
  await add.click()
  await page.getByRole('textbox', { name: '凭证名称', exact: true }).fill('断线凭证')
  await page.getByLabelText('访问令牌或密码', { exact: true }).fill('fixture-unknown-secret')
  await page.getByRole('button', { name: '保存凭证', exact: true }).click()
  await expect.element(screen.getByText('断线凭证', { exact: true })).toBeVisible()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(add).toHaveFocus()
  expect(f.writes).toHaveLength(1)
  expect(f.receipts.size).toBe(1)
  expect(storageText()).not.toContain('fixture-unknown-secret')
})

it('凭证管理被撤回时关闭表单并清除列表，不保留秘密或可操作入口', async () => {
  const f = setup({ denyWrite: true })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=credential-project' })
  const add = screen.getByRole('button', { name: '添加凭证', exact: true })
  await expect.element(add).toBeEnabled()
  await add.click()
  await page.getByRole('textbox', { name: '凭证名称', exact: true }).fill('拒绝凭证')
  await page.getByLabelText('访问令牌或密码', { exact: true }).fill('fixture-denied-secret')
  await page.getByRole('button', { name: '保存凭证', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(screen.getByRole('alert')).toHaveTextContent('凭证管理权限已撤回')
  await expect
    .element(screen.getByRole('button', { name: '管理凭证 原凭证', exact: true }))
    .not.toBeInTheDocument()
  await expect.element(add).toBeDisabled()
  expect(storageText()).not.toContain('fixture-denied-secret')
})

it('撤回凭证需确认并保存原修订，返回列表可见撤回状态与原入口焦点', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=credential-project' })
  const menu = screen.getByRole('button', { name: '管理凭证 原凭证', exact: true })
  await expect.element(menu).toBeEnabled()
  await menu.click()
  await page.getByRole('menuitem', { name: '撤回凭证', exact: true }).click()
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(screen.getByText('版本 1 · 已撤回', { exact: true })).toBeVisible()
  await expect.element(menu).toHaveFocus()
  expect(f.writes[0]).toMatchObject({
    action: 'revoke',
    input: { id: 'credential-one', expectedRevision: 1 },
  })
})

it.each(['authoring', 'credentials'] as const)('首次%s读取503后，原按钮重试两GET成功清除旧错误并保留凭据', async (readFailure) => {
  const f = setup({ readFailure })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=credential-project' })
  const heading = screen.getByRole('heading', { name: '项目凭证', exact: true })
  await expect.element(heading).toBeVisible()
  const section = heading.element().closest<HTMLElement>('section')!
  await vi.waitFor(() => expect(section.querySelector('[role="alert"]')?.textContent).toBe('凭证读取暂不可用'))
  const retry = [...section.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '重试凭证配置')!
  expect(retry).toBeDefined()
  const offset = f.reads.length
  f.setReadFailure(null)
  retry.click()
  await vi.waitFor(() => expect(f.reads.slice(offset)).toEqual(expect.arrayContaining([
    { kind: 'authoring', status: 200 },
    { kind: 'credentials', status: 200 },
  ])))
  await vi.waitFor(() => {
    const menu = section.querySelector<HTMLButtonElement>('[aria-label="管理凭证 原凭证"]')
    expect(menu).not.toBeNull()
    expect(menu!.disabled).toBe(false)
  })
  await vi.waitFor(() => expect(section.querySelector('[role="alert"]')).toBeNull())
  expect([...section.querySelectorAll('button')].some(button => button.textContent === '重试凭证配置')).toBe(false)
  expect(f.writes).toHaveLength(0)
})

it('重试时另一GET仍失败必须保留错误，不能用单项成功覆盖', async () => {
  const f = setup({ readFailure: 'credentials' })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<App />, { router: '/projects?projectId=credential-project' })
  const heading = screen.getByRole('heading', { name: '项目凭证', exact: true })
  await expect.element(heading).toBeVisible()
  const section = heading.element().closest<HTMLElement>('section')!
  await vi.waitFor(() => expect(section.querySelector('[role="alert"]')?.textContent).toBe('凭证读取暂不可用'))
  const offset = f.reads.length
  const retry = [...section.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '重试凭证配置')!
  expect(retry).toBeDefined()
  retry.click()
  await vi.waitFor(() => expect(f.reads.slice(offset)).toEqual(expect.arrayContaining([
    { kind: 'authoring', status: 200 },
    { kind: 'credentials', status: 503 },
  ])))
  expect(section.querySelector('[role="alert"]')?.textContent).toBe('凭证读取暂不可用')
  expect([...section.querySelectorAll('button')].some(button => button.textContent === '重试凭证配置')).toBe(true)
  expect(f.writes).toHaveLength(0)
})
