import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render } from '../../../test/render'
import { ComposerCommandMenu } from './ComposerCommandMenu'
import '../../index.css'
it('文件读取失败明确展示错误并允许重试', async () => {
  const retry = vi.fn()
  await using screen = await render(
    <ComposerCommandMenu
      listId="test-files"
      items={[]}
      resolvedTheme="light"
      isLoading={false}
      triggerKind="path"
      error="当前文件无权访问"
      onRetry={retry}
      activeItemId={null}
      onHighlightedItemChange={() => {}}
      onSelect={() => {}}
    />,
  )
  await expect.element(page.getByRole('alert')).toHaveTextContent('当前文件无权访问重试读取文件')
  expect(screen.container.textContent).not.toContain('没有匹配')
  await userEvent.tab()
  await expect.element(page.getByRole('button', { name: '重试读取文件' })).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  expect(retry).toHaveBeenCalledTimes(1)
  await page.getByRole('button', { name: '重试读取文件' }).click()
  expect(retry).toHaveBeenCalledTimes(2)
})
