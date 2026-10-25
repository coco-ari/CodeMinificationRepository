import { FolderIcon } from 'lucide-react'
import { expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { render } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { ModuleSidebarItem } from './ModuleWorkspace'
import '../index.css'

it('资源导航区分单行和详情行，窄屏可点击并保留完整名称', async () => {
  await page.viewport(390, 600)
  const onClick = vi.fn()
  const title = '用于检查超长资源名称省略和完整可访问名称的服务'
  await using screen = await render(
    <SidebarProvider>
      <div style={{ width: 240 }}>
        <ModuleSidebarItem label="当前资料" icon={FolderIcon} selected onClick={onClick} />
        <ModuleSidebarItem
          label={title}
          description="测试环境 · 离线"
          icon={FolderIcon}
          onClick={onClick}
        />
      </div>
    </SidebarProvider>,
  )
  const normal = screen.getByRole('button', { name: '当前资料', exact: true })
  const detail = screen.getByRole('button', { name: title + ' 测试环境 · 离线', exact: true })
  expect(normal.element().getBoundingClientRect().height).toBe(
    matchMedia('(pointer: coarse)').matches ? 44 : 32,
  )
  expect(detail.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(48)
  expect(detail.element().getBoundingClientRect().width).toBeLessThanOrEqual(240)
  await expect.element(normal).toHaveAttribute('aria-pressed', 'true')
  await expect.element(detail).toHaveAttribute('title', title)
  await detail.click()
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth)
})
