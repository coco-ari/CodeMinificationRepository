import { useState } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render } from '../../test/render'
import { WorkspaceRepositoryReference } from './WorkspaceRepositoryReference'
import type { WorkspaceRepositoryUsageInput } from './workspaceAuthoring'
import '../index.css'

const api = vi.hoisted(() => ({ refs: vi.fn() }))
vi.mock('./projectRepositories', () => ({ checkProjectRepository: api.refs }))
const references = (branches = ['main', 'feature/订单查询'], tags = ['v1.0']) => ({
  sourceId: 'repo',
  defaultRef: 'main',
  branches: branches.map((name) => ({ name, commit: 'a'.repeat(40) })),
  tags: tags.map((name) => ({ name, commit: 'b'.repeat(40) })),
  truncated: false,
})
function Harness({
  repository = 'repo',
  kind = 'branch',
}: {
  repository?: string
  kind?: WorkspaceRepositoryUsageInput['refKind']
}) {
  const [value, setValue] = useState('')
  return (
    <WorkspaceRepositoryReference
      key={repository}
      projectId="project"
      repositoryId={repository}
      refKind={kind}
      value={value}
      disabled={false}
      onChange={setValue}
    />
  )
}

it('自动查询分支，搜索后用键盘选择，刷新保留输入', async () => {
  api.refs.mockReset().mockResolvedValue(references())
  await page.viewport(390, 650)
  await using screen = await render(<Harness />)
  await expect.poll(() => api.refs.mock.calls.length).toBe(1)
  const input = screen.getByRole('combobox', { name: '分支', exact: true })
  await input.fill('订单')
  await expect
    .element(page.getByRole('option', { name: 'feature/订单查询', exact: true }))
    .toBeVisible()
  await userEvent.keyboard('{ArrowDown}{Enter}')
  await expect.element(input).toHaveValue('feature/订单查询')
  api.refs.mockResolvedValue(references(['main', 'feature/新分支']))
  await screen.getByRole('button', { name: '刷新仓库引用', exact: true }).click()
  await expect.poll(() => api.refs.mock.calls.length).toBe(2)
  await expect.element(input).toHaveValue('feature/订单查询')
  await input.fill('新分支')
  await page.getByRole('option', { name: 'feature/新分支', exact: true }).click()
  await expect.element(input).toHaveValue('feature/新分支')
})

it('读取失败保留手填引用，局部重试恢复候选', async () => {
  api.refs
    .mockReset()
    .mockRejectedValueOnce(new Error('凭证暂时不可用'))
    .mockResolvedValue(references())
  await using screen = await render(<Harness />)
  await expect.element(screen.getByRole('alert')).toHaveTextContent('凭证暂时不可用')
  const input = screen.getByRole('combobox', { name: '分支', exact: true })
  await input.fill('manual-branch')
  await userEvent.keyboard('{Escape}')
  await screen.getByRole('button', { name: '重试读取仓库引用', exact: true }).click()
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument()
  await expect.element(input).toHaveValue('manual-branch')
  await input.fill('main')
  await page.getByRole('option', { name: 'main', exact: true }).click()
  await expect.element(input).toHaveValue('main')
})

it('区分空标签与截断结果，并保留手动输入', async () => {
  api.refs.mockReset().mockResolvedValue({ ...references([], []), truncated: true })
  await using screen = await render(<Harness kind="tag" />)
  const input = screen.getByRole('combobox', { name: '标签', exact: true })
  await input.fill('v-next')
  await expect.element(page.getByText('仓库没有返回标签，可手动填写。')).toBeVisible()
  await expect
    .element(screen.getByText('远端仅返回部分引用，未列出的名称可手动填写。'))
    .toBeVisible()
  await expect.element(input).toHaveValue('v-next')
})

it('切换仓库后取消旧查询，迟到结果不能覆盖新候选', async () => {
  let finish!: (value: ReturnType<typeof references>) => void
  api.refs
    .mockReset()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(references(['new-repo-branch']))
  await using screen = await render(<Harness repository="old" />)
  await expect.poll(() => api.refs.mock.calls.length).toBe(1)
  const signal = api.refs.mock.calls[0]![2] as AbortSignal
  await screen.rerender(<Harness repository="new" />)
  await expect.poll(() => signal.aborted).toBe(true)
  const input = screen.getByRole('combobox', { name: '分支', exact: true })
  await input.fill('new-repo')
  await expect
    .element(page.getByRole('option', { name: 'new-repo-branch', exact: true }))
    .toBeVisible()
  finish(references(['old-repo-branch']))
  await input.fill('old-repo')
  await expect
    .element(page.getByRole('option', { name: 'old-repo-branch', exact: true }))
    .not.toBeInTheDocument()
  await input.fill('new-repo')
  await expect
    .element(page.getByRole('option', { name: 'new-repo-branch', exact: true }))
    .toBeVisible()
})

it('默认分支展示远端实际名称，提交 SHA 无需查询', async () => {
  api.refs.mockReset().mockResolvedValue(references())
  await using screen = await render(<Harness kind="default" />)
  await expect.element(screen.getByRole('status')).toHaveTextContent('main')
  await screen.rerender(<Harness kind="commit" />)
  const input = screen.getByRole('textbox', { name: '提交 SHA', exact: true })
  await input.fill('c'.repeat(40))
  await expect.element(input).toHaveValue('c'.repeat(40))
  expect(api.refs).toHaveBeenCalledTimes(1)
})
