import { useState } from 'react'
import { describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { render } from '../../test/render'
import { AutoOpsRequestError } from './apiClient'
import { useWorkspaceTaskSubmission } from './useWorkspaceTaskSubmission'
import {
  ExternalWorkspaceDialog,
  WorkspaceImportDialog,
  WorkspacePackagesDialog,
  WorkspaceSubmissionNotice,
} from './WorkspaceActions'
import type { WorkspaceOverview, WorkspaceTask, WorkspaceVersion } from './workspaces'
import '../index.css'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  send: vi.fn(),
  package: vi.fn(),
  receipt: vi.fn(),
  accepted: vi.fn(),
  host: vi.fn(),
}))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}))
vi.mock(import('./workspaces'), async (original) => ({
  ...(await original()),
  loadWorkspaces: mocks.read,
  importWorkspaceRepository: mocks.send,
  generateExternalWorkspace: mocks.send,
  generateWorkspacePackages: mocks.send,
}))
vi.mock(import('./workspaceAuthoring'), async (original) => ({
  ...(await original()),
  inspectAuthoringRequest: mocks.receipt,
}))
vi.mock(import('./apiClient'), async (original) => ({
  ...(await original()),
  autoOpsRequest: mocks.package,
}))
const version: WorkspaceVersion = {
  id: 'version-one',
  name: '固定内部版本',
  type: 'internal',
  status: 'published',
  createdAt: '2026-10-23T00:00:00Z',
  fileCount: 1,
  byteLength: 1,
  source: { repositories: [], contentHash: 'isolated' },
}
const overview = (tasks: WorkspaceTask[] = [], projectId = 'p-one'): WorkspaceOverview => ({
  projectId,
  internalVersions: [version],
  externalVersions: [],
  releases: [],
  tasks,
  import: { supported: true, hosts: ['isolated.invalid'], maxBytes: 10000, maxFiles: 100 },
})
const unknown = () =>
  new AutoOpsRequestError('提交结果尚未确认，请先核对任务。', 'CONNECTION_FAILED', undefined, true)
const task = (type: WorkspaceTask['type'], requestId: string): WorkspaceTask => ({
  id: 'accepted-task',
  requestId,
  type,
  status: 'queued',
  stage: 'queued',
  message: '已排队',
  createdAt: '2026-10-23T00:00:00Z',
})
function Harness({
  type = 'import',
  projectId = 'p-one',
}: {
  type?: 'import' | 'external' | 'packages'
  projectId?: string
}) {
  const [open, setOpen] = useState(false)
  const submission = useWorkspaceTaskSubmission(projectId, (value) => {
    mocks.accepted(value)
    setOpen(false)
  })
  const notice = (
    <WorkspaceSubmissionNotice
      label={submission.pendingLabel}
      retryAvailable={submission.retryAvailable}
      busy={submission.busy}
      onCheck={submission.check}
      onRetry={submission.retry}
    />
  )
  const common = {
    open,
    onOpenChange: setOpen,
    disabled: submission.busy,
    error: submission.error,
    submissionNotice: notice,
  }
  return (
    <>
      <button onClick={() => setOpen(true)}>打开操作</button>
      {!open ? notice : null}
      {type === 'import' ? (
        <WorkspaceImportDialog
          {...common}
          limits={overview().import}
          onImport={(repositoryUrl, branch) => submission.submit({ type, repositoryUrl, branch })}
        />
      ) : type === 'external' ? (
        <ExternalWorkspaceDialog
          {...common}
          onGenerate={(rules) => submission.submit({ type, rules })}
        />
      ) : (
        <WorkspacePackagesDialog
          {...common}
          internalVersions={[version]}
          onGenerate={(sourceVersionId, services, contexts) =>
            submission.submit({ type, sourceVersionId, services, contexts })
          }
        />
      )}
    </>
  )
}
const submitLabel = { import: '导入并保存版本', external: '更新外部工作区', packages: '生成部署包' }
async function openAndFill(type: WorkspaceTask['type']) {
  await page.getByRole('button', { name: '打开操作', exact: true }).click()
  if (type === 'import')
    await page
      .getByRole('textbox', { name: 'HTTPS 仓库地址' })
      .fill('https://isolated.invalid/private-repository.git')
  if (type === 'external') {
    await page.getByRole('button', { name: '添加替换', exact: true }).click()
    await page.getByRole('textbox', { name: '规则 1 原始文本' }).fill('private-example-value')
  }
}
function setup() {
  vi.resetAllMocks()
  sessionStorage.clear()
  mocks.host.mockReturnValue({ principal: { id: 'owner-one' } })
  mocks.read.mockResolvedValue(overview())
  mocks.send.mockRejectedValue(unknown())
  mocks.receipt.mockResolvedValue(null)
  mocks.package.mockRejectedValue(unknown())
}
describe('工作区任务的未知提交恢复', () => {
  for (const type of ['import', 'external', 'packages'] as const) {
    it(type + ' 重复点击先核对收据，始终发送原输入和原请求键', async () => {
      setup()
      await using screen = await render(<Harness type={type} />)
      await openAndFill(type)
      await page.getByRole('button', { name: submitLabel[type], exact: true }).click()
      await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
      await expect
        .element(page.getByRole('button', { name: '使用原请求重试', exact: true }))
        .toBeEnabled()
      const first = mocks.send.mock.calls[0]!
      const stored = sessionStorage.getItem('autoops:workspace-task:owner-one:p-one')!
      expect(Object.keys(JSON.parse(stored)).sort()).toEqual(['digest', 'requestId', 'type'])
      expect(stored).not.toContain('private-example-value')
      expect(stored).not.toContain('private-repository')
      await page.getByRole('button', { name: '使用原请求重试', exact: true }).click()
      await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
      expect(mocks.read).toHaveBeenCalledTimes(1)
      expect(mocks.send.mock.calls[1]).toEqual(first)
      expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.send.mock.invocationCallOrder[1]!,
      )
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
      expect(sessionStorage.getItem('autoops:workspace-task:owner-one:p-one')).toBe(stored)
      expect(mocks.accepted).not.toHaveBeenCalled()
    })
  }

  it('刷新查到已接受任务后只采纳收据，不再次提交', async () => {
    setup()
    await using screen = await render(<Harness />)
    await openAndFill('import')
    await page.getByRole('button', { name: submitLabel.import }).click()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    const receipt = task('import', mocks.send.mock.calls[0]![3])
    mocks.read.mockResolvedValue(overview([receipt]))
    await page.getByRole('button', { name: '核对任务', exact: true }).click()
    await vi.waitFor(() => expect(mocks.accepted).toHaveBeenCalledWith(receipt))
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('autoops:workspace-task:owner-one:p-one')).toBeNull()
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('核对读取失败不重发，变更输入不能覆盖未确认请求', async () => {
    setup()
    await using screen = await render(<Harness />)
    await openAndFill('import')
    await page.getByRole('button', { name: submitLabel.import }).click()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    mocks.read.mockRejectedValue(new Error('核对暂时无法连接'))
    await page.getByRole('button', { name: '使用原请求重试' }).click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('核对暂时无法连接'))
    expect(mocks.send).toHaveBeenCalledTimes(1)
    await page.getByRole('textbox', { name: '分支', exact: true }).fill('changed-branch')
    await page.getByRole('button', { name: submitLabel.import }).click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('修改输入不会覆盖原请求'))
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it('重新进入页面仅恢复摘要，需原输入匹配才用原键继续', async () => {
    setup()
    await using first = await render(<Harness />)
    await openAndFill('import')
    await page.getByRole('button', { name: submitLabel.import }).click()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    const initial = mocks.send.mock.calls[0]!
    await first.unmount()
    await using second = await render(<Harness />)
    await expect.element(page.getByRole('button', { name: '使用原请求重试' })).toBeDisabled()
    await page.getByRole('button', { name: '核对任务', exact: true }).click()
    expect(mocks.send).toHaveBeenCalledTimes(1)
    await openAndFill('import')
    mocks.send.mockResolvedValue(task('import', initial[3]))
    await page.getByRole('button', { name: submitLabel.import }).click()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
    expect(mocks.send.mock.calls[1]).toEqual(initial)
    await vi.waitFor(() => expect(mocks.accepted).toHaveBeenCalledTimes(1))
  })

  it('切项目后不会把待确认请求改绑到新项目', async () => {
    setup()
    await using first = await render(<Harness />)
    await openAndFill('import')
    await page.getByRole('button', { name: submitLabel.import }).click()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    const initial = mocks.send.mock.calls[0]!
    await first.unmount()
    await using second = await render(<Harness projectId="p-two" />)
    await expect.element(page.getByRole('button', { name: '核对任务' })).not.toBeInTheDocument()
    await openAndFill('import')
    await page.getByRole('button', { name: submitLabel.import }).click()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
    expect(mocks.send.mock.calls[1]![0]).toBe('p-two')
    expect(mocks.send.mock.calls[1]![3]).not.toBe(initial[3])
    expect(sessionStorage.getItem('autoops:workspace-task:owner-one:p-one')).not.toBeNull()
  })
  it('源码包上下文随原请求固定，修改构建目录不会替换未知任务', async () => {
    setup()
    await using screen = await render(<Harness type="packages" />)
    await openAndFill('packages')
    await page.getByRole('textbox', { name: '前端构建上下文', exact: true }).fill('monorepo')
    await page.getByRole('textbox', { name: '包内构建目录', exact: true }).nth(0).fill('apps/web')
    await page.getByRole('button', { name: submitLabel.packages, exact: true }).click()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    const first = mocks.send.mock.calls[0]!
    expect(first[4]).toEqual([
      { service: 'frontend', root: 'monorepo', workingDirectory: 'apps/web' },
      { service: 'backend', root: '.', workingDirectory: '.' },
    ])
    await page.getByRole('textbox', { name: '前端构建上下文', exact: true }).fill('changed-root')
    await page.getByRole('button', { name: submitLabel.packages, exact: true }).click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('修改输入不会覆盖原请求'))
    expect(mocks.send).toHaveBeenCalledTimes(1)
    await page.getByRole('button', { name: '使用原请求重试', exact: true }).click()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
    expect(mocks.send.mock.calls[1]).toEqual(first)
  })
})

function DeploymentInputHarness() {
  const submission = useWorkspaceTaskSubmission('p-one', mocks.accepted)
  return (
    <>
      <button
        disabled={submission.busy}
        onClick={() =>
          void submission.submit({
            type: 'deployment-packages',
            sources: [{ sourceId: 'repo-one', refKind: 'commit', ref: 'a'.repeat(40) }],
            contexts: [{ service: 'frontend', root: 'web', workingDirectory: '.' }],
          })
        }
      >
        生成独立源码包
      </button>
      <WorkspaceSubmissionNotice
        label={submission.pendingLabel}
        retryAvailable={submission.retryAvailable}
        busy={submission.busy}
        onCheck={submission.check}
        onRetry={submission.retry}
      />
      <p>{submission.error}</p>
    </>
  )
}
it('独立 Git 打包丢响应后按原请求核对，不附加资料版本或重复任务', async () => {
  setup()
  await using screen = await render(<DeploymentInputHarness />)
  await screen.getByRole('button', { name: '生成独立源码包' }).click()
  await expect.element(page.getByRole('button', { name: '使用原请求重试' })).toBeEnabled()
  expect(mocks.package).toHaveBeenCalledTimes(1)
  const [path, options] = mocks.package.mock.calls[0]!
  expect(path).toBe('/api/v1/projects/p-one/workspace/deployment-packages')
  expect(options.body).toEqual({
    requestId: expect.any(String),
    sources: [{ sourceId: 'repo-one', refKind: 'commit', ref: 'a'.repeat(40) }],
    contexts: [{ service: 'frontend', root: 'web', workingDirectory: '.' }],
  })
  mocks.receipt.mockResolvedValue({
    requestId: options.body.requestId,
    task: task('packages', options.body.requestId),
  })
  await screen.getByRole('button', { name: '核对任务', exact: true }).click()
  await vi.waitFor(() =>
    expect(mocks.accepted).toHaveBeenCalledWith(task('packages', options.body.requestId)),
  )
  expect(mocks.package).toHaveBeenCalledTimes(1)
  expect(mocks.receipt).toHaveBeenCalledWith('p-one', options.body.requestId, false)
  expect(sessionStorage.getItem('autoops:workspace-task:owner-one:p-one')).toBeNull()
})
