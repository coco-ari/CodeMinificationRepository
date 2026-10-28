import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { ProjectAreaTopbar } from './ProjectAreaNavigation'
import '../index.css'

const mocks = vi.hoisted(() => ({ host: vi.fn(), projectId: 'p-one', select: vi.fn() }))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  useAutoOpsHost: mocks.host,
}))
vi.mock(import('./projectNavigation'), async (original) => ({
  ...(await original()),
  useAutoOpsProjectId: () => mocks.projectId,
  selectAutoOpsProject: mocks.select,
  autoOpsProjectHref: (area: string, id: string) =>
    (area === 'chat' ? '/' : '/' + area) + '?projectId=' + id,
}))
const host = () => ({
  principal: { id: 'owner' },
  projects: [
    {
      id: 'p-one',
      name: '短项目',
      capabilities: { 'workspace.read': true, 'deployment.read': true },
    },
  ],
  capabilities: {},
})
const labels = ['问答', '工作区', '部署', '技能库', '项目管理', '助手', '账号']
const view = (width = 1200) => (
  <div style={{ width, maxWidth: '100%' }}>
    <SidebarProvider>
      <ProjectAreaTopbar />
    </SidebarProvider>
  </div>
)
beforeEach(async () => {
  mocks.host.mockReturnValue(host())
  mocks.projectId = 'p-one'
  vi.clearAllMocks()
  await page.viewport(1440, 600)
  document.documentElement.classList.remove('dark')
})

it('宽容器直接展示全部已授权模块，去掉固定品牌，点击保持项目归属', async () => {
  await using screen = await render(view())
  for (const name of labels)
    await expect.element(screen.getByRole('radio', { name, exact: true })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: '更多功能' })).not.toBeInTheDocument()
  await expect.element(screen.getByText('AutoOps', { exact: true })).not.toBeInTheDocument()
  await screen.getByRole('radio', { name: '助手', exact: true }).click()
  await expect.poll(() => screen.router?.state.location.pathname).toBe('/assistants')
  expect(screen.router?.state.location.search).toEqual({ projectId: 'p-one' })
})

it('相同桌面窗口按容器空间逐步折叠，菜单只列溢出模块，Esc 恢复焦点', async () => {
  await using screen = await render(view(640))
  await expect.element(screen.getByRole('radio', { name: '问答', exact: true })).toBeVisible()
  const trigger = screen.getByRole('button', { name: '更多功能', exact: true })
  await trigger.click()
  await expect.element(page.getByRole('option', { name: '账号', exact: true })).toBeVisible()
  await expect
    .element(page.getByRole('option', { name: '问答', exact: true }))
    .not.toBeInTheDocument()
  await page.getByRole('combobox', { name: '搜索功能', exact: true }).fill('助手')
  await expect.element(page.getByRole('option', { name: '助手', exact: true })).toBeVisible()
  await expect
    .element(page.getByRole('option', { name: '账号', exact: true }))
    .not.toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await expect.element(trigger).toHaveFocus()
  await trigger.click()
  await screen.rerender(view(1200))
  await expect.element(screen.getByRole('radio', { name: '账号', exact: true })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: '更多功能' })).not.toBeInTheDocument()
  await expect.element(page.getByRole('combobox', { name: '搜索功能', exact: true })).not.toBeInTheDocument()
  await expect.element(screen.getByRole('radio', { name: '问答', exact: true })).toHaveFocus()
})

it('390px 深色只保留当前模块选择器，菜单选择和键盘可用且不横向溢出', async () => {
  await page.viewport(390, 600)
  document.documentElement.classList.add('dark')
  await using screen = await render(view(390), { router: '/accounts?projectId=p-one' })
  const trigger = screen.getByRole('button', { name: '切换模块', exact: true })
  await expect.element(trigger).toHaveTextContent('账号')
  await trigger.click()
  for (const name of labels)
    await expect.element(page.getByRole('option', { name, exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: '搜索功能', exact: true }).fill('部署')
  await userEvent.keyboard('{Enter}')
  await expect.poll(() => screen.router?.state.location.pathname).toBe('/deployments')
  await expect.element(trigger).toHaveTextContent('部署')
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
  document.documentElement.classList.remove('dark')
})

it('更换长项目名称不移动功能入口，当前溢出模块有名称，受限权限不泄漏入口', async () => {
  await using screen = await render(view(680), { router: '/accounts?projectId=p-one' })
  const trigger = screen.getByRole('button', { name: '更多功能', exact: true })
  await expect.element(trigger).toHaveTextContent('账号')
  const before = screen
    .getByRole('radio', { name: '问答', exact: true })
    .element()
    .getBoundingClientRect().x
  const value = host()
  value.projects[0]!.name = '项目名称非常长用于验证切换后不会挤动相邻功能入口'.repeat(4)
  mocks.host.mockReturnValue(value)
  await screen.rerender(view(680))
  expect(
    screen.getByRole('radio', { name: '问答', exact: true }).element().getBoundingClientRect().x,
  ).toBe(before)
  value.projects[0]!.capabilities['deployment.read'] = false
  mocks.host.mockReturnValue(structuredClone(value))
  await screen.rerender(view(1200))
  await expect
    .element(screen.getByRole('radio', { name: '部署', exact: true }))
    .not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '切换项目' }).element().getAttribute('title')).toBe(
    value.projects[0]!.name,
  )
})

it('零项目只显示已授权全局模块，功能菜单不存在空占位', async () => {
  mocks.host.mockReturnValue({ ...host(), projects: [] })
  mocks.projectId = ''
  await using screen = await render(view(), { router: '/projects' })
  for (const name of ['技能库', '项目管理', '助手', '账号'])
    await expect.element(screen.getByRole('radio', { name, exact: true })).toBeVisible()
  for (const name of ['问答', '工作区', '部署'])
    await expect.element(screen.getByRole('radio', { name, exact: true })).not.toBeInTheDocument()
})

it('缩窄时把被收起按钮的键盘焦点交给模块菜单，展开恢复当前入口', async () => {
  await using screen = await render(view(), { router: '/accounts?projectId=p-one' })
  await expect.element(screen.getByRole('radio', { name: '账号', exact: true })).toBeVisible()
  screen.getByRole('radio', { name: '账号', exact: true }).element().focus()
  await screen.rerender(view(390))
  await expect.element(screen.getByRole('button', { name: '切换模块', exact: true })).toHaveFocus()
  await screen.rerender(view())
  await expect.element(screen.getByRole('radio', { name: '账号', exact: true })).toHaveFocus()
})

it.each([
  { width: 1440, dark: false },
  { width: 390, dark: true },
])('顶栏 $width px 主题与菜单实际截图', async ({ width, dark }) => {
  await page.viewport(width, 400)
  document.documentElement.classList.toggle('dark', dark)
  await using screen = await render(view(width), { router: '/assistants?projectId=p-one' })
  if (width > 1000)
    await expect.element(screen.getByRole('radio', { name: '助手', exact: true })).toBeVisible()
  else
    await expect
      .element(screen.getByRole('button', { name: '切换模块', exact: true }))
      .toHaveTextContent('助手')
  await page.screenshot({ path: `../../.test-artifacts/adaptive-navigation/topbar-${width}.png` })
  if (width === 390) {
    await screen.getByRole('button', { name: '切换模块', exact: true }).click()
    await expect.element(page.getByRole('option', { name: '项目管理', exact: true })).toBeVisible()
    await page.screenshot({ path: '../../.test-artifacts/adaptive-navigation/menu-390.png' })
    await userEvent.keyboard('{Escape}')
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
  document.documentElement.classList.remove('dark')
})
