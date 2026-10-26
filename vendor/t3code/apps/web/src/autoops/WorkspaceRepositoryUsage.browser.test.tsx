import { useRef, useState } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { render, stubGlobal } from '../../test/render'
import { installAutoOpsHost } from './hostConfig'
import { useWorkspaceAuthoring } from './useWorkspaceAuthoring'
import { WorkspaceAuthoringFocus, WorkspaceSourceDialog } from './WorkspaceAuthoringDialogs'
import type { WorkspaceRepositorySource } from './workspaceAuthoring'
import '../index.css'

function setup({ failRead = false, denied = false } = {}) {
  window.sessionStorage.clear()
  installAutoOpsHost(
    {
      principal: { id: 'usage-user', displayName: '工作区成员' },
      csrfToken: 'csrf',
      gatewayBasePath: '/api/agent-demo/t3',
      fixedModel: { instanceId: 'codex', model: 'test-model' },
      runtimeMode: 'approval-required',
      capabilities: {},
      projects: [],
    },
    window.location.origin,
  )
  let fail = failRead
  const writes: Array<{ action: string; input: Record<string, unknown> }> = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname
    if (path.endsWith('/workspace/authoring'))
      return Response.json({
        projectId: 'usage-project',
        revision: 4,
        sources: [],
        entries: [],
        limits: { maxFileBytes: 8000000, maxBytes: 50000000, maxFiles: 100 },
      })
    if (path.endsWith('/workspace/credentials')) return Response.json({ credentials: [] })
    if (path.endsWith('/repositories')) {
      if (fail) {
        fail = false
        return Response.json(
          { code: 'REPOSITORIES_UNAVAILABLE', error: '仓库目录读取失败' },
          { status: 503 },
        )
      }
      return Response.json({
        revision: 4,
        items: [
          {
            id: 'repo-usage',
            name: '项目业务仓库',
            url: 'https://isolated.invalid/repo.git',
            credentialId: 'project-credential',
          },
        ],
      })
    }
    if (path.endsWith('/workspace/sources')) {
      const body = JSON.parse(String(init?.body)) as (typeof writes)[number]
      writes.push(body)
      if (denied)
        return Response.json(
          { code: 'REPOSITORY_NOT_FOUND', error: '项目仓库已移除' },
          { status: 404 },
        )
      return Response.json({ requestId: body.input.requestId, revision: 5, source: body.input })
    }
    throw new Error(`未处理工作区测试请求 ${path}`)
  })
  return { fetch, writes }
}
function Harness({ source }: { source?: WorkspaceRepositorySource }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const controller = useWorkspaceAuthoring('usage-project', true, () => setOpen(false))
  return (
    <WorkspaceAuthoringFocus value={() => trigger.current}>
      <button ref={trigger} disabled={!controller.overview} onClick={() => setOpen(true)}>
        配置工作区来源
      </button>
      {open ? (
        <WorkspaceSourceDialog
          projectId="usage-project"
          source={source}
          controller={controller}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </WorkspaceAuthoringFocus>
  )
}
const select = async (label: string, name: string) => {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name, exact: true }).click()
}

it('工作区选择已登记仓库及自己的分支，只提交使用配置并恢复焦点', async () => {
  await page.viewport(390, 500)
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<Harness />)
  const open = screen.getByRole('button', { name: '配置工作区来源', exact: true })
  await expect.element(open).toBeEnabled()
  await open.click()
  await expect.element(page.getByRole('combobox', { name: '项目仓库', exact: true })).toBeEnabled()
  await select('项目仓库', '项目业务仓库')
  await select('版本引用', '分支')
  await page
    .getByRole('textbox', { name: '分支、标签或提交', exact: true })
    .fill('workspace-feature')
  await page.getByRole('textbox', { name: '工作区挂载目录', exact: true }).fill('sources/business')
  await expect
    .element(page.getByRole('textbox', { name: 'HTTPS 仓库地址', exact: true }))
    .not.toBeInTheDocument()
  await expect
    .element(page.getByRole('combobox', { name: '仓库凭证', exact: true }))
    .not.toBeInTheDocument()
  await page.getByRole('button', { name: '保存来源', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(open).toHaveFocus()
  expect(f.writes[0]).toEqual({
    action: 'save',
    input: {
      requestId: expect.any(String),
      expectedRevision: 4,
      id: 'repo-usage',
      role: 'other',
      refKind: 'branch',
      ref: 'workspace-feature',
      mountPath: 'sources/business',
    },
  })
})

it('编辑既有来源只保留使用字段，不能用派生地址或凭证覆盖项目连接', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(
    <Harness
      source={{
        id: 'repo-usage',
        name: '项目业务仓库',
        url: 'https://isolated.invalid/repo.git',
        credentialId: 'project-credential',
        role: 'backend',
        refKind: 'tag',
        ref: 'release-1',
        mountPath: 'services/api',
        sourcePath: 'api',
      }}
    />,
  )
  await screen.getByRole('button', { name: '配置工作区来源', exact: true }).click()
  await expect
    .element(page.getByRole('combobox', { name: '项目仓库', exact: true }))
    .toHaveTextContent('项目业务仓库')
  await expect.element(page.getByRole('combobox', { name: '项目仓库', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: '分支、标签或提交', exact: true }).fill('release-2')
  await page.getByRole('button', { name: '保存来源', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.writes[0]?.input).toMatchObject({
    id: 'repo-usage',
    role: 'backend',
    ref: 'release-2',
    mountPath: 'services/api',
    sourcePath: 'api',
  })
  expect(f.writes[0]?.input).not.toHaveProperty('url')
  expect(f.writes[0]?.input).not.toHaveProperty('name')
  expect(f.writes[0]?.input).not.toHaveProperty('credentialId')
})

it('仓库读取异常明确显示错误，原表单重试成功后才能选择与保存', async () => {
  const f = setup({ failRead: true })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<Harness />)
  await screen.getByRole('button', { name: '配置工作区来源', exact: true }).click()
  await expect.element(page.getByText('仓库目录读取失败', { exact: true })).toBeVisible()
  await expect.element(page.getByRole('button', { name: '保存来源', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '重试项目仓库', exact: true }).click()
  await expect.element(page.getByRole('combobox', { name: '项目仓库', exact: true })).toBeEnabled()
  await select('项目仓库', '项目业务仓库')
  await page.getByRole('textbox', { name: '工作区挂载目录', exact: true }).fill('sources/retry')
  await page.getByRole('button', { name: '保存来源', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.writes).toHaveLength(1)
})

it('提交期间仓库撤回拒绝写入且不自动换仓库或分支', async () => {
  const f = setup({ denied: true })
  using _fetch = stubGlobal('fetch', f.fetch)
  await using screen = await render(<Harness />)
  await screen.getByRole('button', { name: '配置工作区来源', exact: true }).click()
  await expect.element(page.getByRole('combobox', { name: '项目仓库', exact: true })).toBeEnabled()
  await select('项目仓库', '项目业务仓库')
  await page.getByRole('textbox', { name: '工作区挂载目录', exact: true }).fill('sources/kept')
  await page.getByRole('button', { name: '保存来源', exact: true }).click()
  await expect.element(page.getByText('项目仓库已移除', { exact: true })).toBeVisible()
  await expect
    .element(page.getByRole('textbox', { name: '工作区挂载目录', exact: true }))
    .toHaveValue('sources/kept')
  await expect
    .element(page.getByRole('combobox', { name: '项目仓库', exact: true }))
    .toHaveTextContent('项目业务仓库')
  expect(f.writes).toHaveLength(1)
})
