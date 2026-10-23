import { describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { useState } from 'react'
import { render } from '../../../test/render'
import { DeploymentSourcesDialog } from './DeploymentSourcesDialog'
import type { WorkspaceRepositorySource } from '../workspaceAuthoring'
import '../../index.css'

const sources: WorkspaceRepositorySource[] = [
  {
    id: 'web',
    name: '前端仓库',
    role: 'frontend',
    mountPath: 'apps/web',
    url: 'https://github.com/example/web',
    refKind: 'branch',
    ref: 'develop',
  },
  {
    id: 'shared',
    name: '共享依赖',
    role: 'shared',
    mountPath: 'shared',
    url: 'https://github.com/example/shared',
    refKind: 'default',
    ref: '',
  },
]

describe('部署 Git 来源', () => {
  it('未知结果关闭重开后仍展示原来源和构建目录，不显示默认输入冒充原请求', async () => {
    const onGenerate = vi.fn().mockResolvedValue(false)
    function Harness() {
      const [open, setOpen] = useState(true)
      const [unknown, setUnknown] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>重新打开</button>
          <DeploymentSourcesDialog
            open={open}
            sources={sources}
            disabled={false}
            error={null}
            finalFocus={false}
            submissionNotice={null}
            pendingRequest={unknown}
            canRetryPending={unknown}
            onOpenChange={setOpen}
            onGenerate={async (...args) => {
              await onGenerate(...args)
              setUnknown(true)
              return false
            }}
          />
        </>
      )
    }
    await using screen = await render(<Harness />)
    await page.getByRole('textbox', { name: '前端仓库版本引用' }).fill('release-candidate')
    await page.getByRole('textbox', { name: '包内构建目录', exact: true }).fill('apps/web')
    await page.getByRole('button', { name: '生成部署包', exact: true }).click()
    await expect.element(page.getByRole('textbox', { name: '前端仓库版本引用' })).toBeDisabled()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '重新打开', exact: true }).click()
    await expect
      .element(page.getByRole('textbox', { name: '前端仓库版本引用' }))
      .toHaveValue('release-candidate')
    await expect
      .element(page.getByRole('textbox', { name: '包内构建目录', exact: true }))
      .toHaveValue('apps/web')
    await expect
      .element(page.getByRole('button', { name: '核对并重试原请求', exact: true }))
      .toBeDisabled()
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('直接选择多个仓库引用与构建目录，提交不会改变工作区跟踪配置', async () => {
    const onGenerate = vi.fn().mockResolvedValue(true)
    const onOpenChange = vi.fn()
    await using screen = await render(
      <DeploymentSourcesDialog
        open
        sources={sources}
        disabled={false}
        error={null}
        finalFocus={false}
        submissionNotice={null}
        onOpenChange={onOpenChange}
        onGenerate={onGenerate}
      />,
    )
    await page.getByRole('textbox', { name: '前端仓库版本引用' }).fill('release-candidate')
    await page.getByRole('textbox', { name: '构建上下文', exact: true }).fill('.')
    await page.getByRole('textbox', { name: '包内构建目录', exact: true }).fill('apps/web')
    await page.getByRole('button', { name: '生成部署包', exact: true }).click()
    expect(onGenerate).toHaveBeenCalledExactlyOnceWith(
      [
        { sourceId: 'web', refKind: 'branch', ref: 'release-candidate' },
        { sourceId: 'shared', refKind: 'default', ref: '' },
      ],
      [{ service: 'frontend', root: '.', workingDirectory: 'apps/web' }],
    )
    expect(sources[0]!.ref).toBe('develop')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('来源内部版本')
  })

  it('引用未填写不能提交；失败后保留用户选择供原请求核对', async () => {
    const onGenerate = vi.fn().mockResolvedValue(false)
    const onOpenChange = vi.fn()
    await using screen = await render(
      <DeploymentSourcesDialog
        open
        sources={sources}
        disabled={false}
        error="原请求结果尚未确认"
        finalFocus={false}
        submissionNotice={null}
        onOpenChange={onOpenChange}
        onGenerate={onGenerate}
      />,
    )
    const reference = page.getByRole('textbox', { name: '前端仓库版本引用' })
    await reference.fill('')
    await page.getByRole('button', { name: '生成部署包', exact: true }).click()
    expect(onGenerate).not.toHaveBeenCalled()
    await expect.element(page.getByText('请填写所选分支、标签或完整提交 SHA。')).toBeVisible()
    await reference.fill('release-candidate')
    await page.getByRole('button', { name: '生成部署包', exact: true }).click()
    expect(onOpenChange).not.toHaveBeenCalled()
    await expect.element(reference).toHaveValue('release-candidate')
  })
})
