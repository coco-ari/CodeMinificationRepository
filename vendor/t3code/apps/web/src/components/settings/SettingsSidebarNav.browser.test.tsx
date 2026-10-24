import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { act, render } from '../../../test/render'
import { SidebarProvider } from '../ui/sidebar'
import { SettingsSidebarNav } from './SettingsSidebarNav'
const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock(import('@tanstack/react-router'), async (original) => ({
  ...(await original()),
  useNavigate: () => mocks.navigate,
}))
vi.mock(import('../sidebar/SidebarChrome'), async () => {
  const { memo } = await import('react')
  return { SidebarUtilityMenu: memo(() => <></>) }
})
vi.mock(import('./useAvailableSettingsSearchItems'), () => ({
  useAvailableSettingsSearchItems: () => [
    { id: 'theme', title: '主题', to: '/settings/appearance' },
  ],
}))
it('输入法组词按键不触发设置导航或清除搜索', async () => {
  mocks.navigate.mockReset()
  await using screen = await render(
    <SidebarProvider>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
  )
  await page.getByRole('combobox', { name: '搜索设置' }).fill('主题')
  const input = screen.container.querySelector('input')!
  for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp']) {
    await act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true }),
      ),
    )
    expect(input.value).toBe('主题')
    expect(mocks.navigate).not.toHaveBeenCalled()
  }
  await act(() =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }),
    ),
  )
  expect(mocks.navigate).not.toHaveBeenCalled()
  await userEvent.keyboard('{Enter}')
  expect(mocks.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ to: '/settings/appearance', hash: 'theme' }),
  )
})
