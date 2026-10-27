import { StrictMode, useRef, useState } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { fakeTimers, render, stubGlobal } from '../../test/render'
import {
  ProjectRemovalAction,
  ProjectRemovalDialog,
  type ProjectRemovalTarget,
} from './ProjectRemovalDialog'
import { installAutoOpsHost } from './hostConfig'
import { prepareProjectMutation, readPendingProjectWrite } from './projectDirectory'
import '../index.css'

const target: ProjectRemovalTarget = {
  projectId: 'removal-project',
  name: '隔离空项目',
  revision: 3,
}
const bootstrap = () => ({
  principal: { id: 'removal-owner', displayName: '删除管理员' },
  csrfToken: 'test-csrf',
  gatewayBasePath: '/api/agent-demo/t3',
  fixedModel: { instanceId: 'codex', model: 'test-model' },
  runtimeMode: 'approval-required' as const,
  capabilities: {},
  projects: [],
})
type Preview = {
  revision: number
  canDelete: boolean
  blockers: Array<{ kind: string; count: number; message: string }>
  truncated: boolean
}
const clearPreview = (): Preview => ({
  revision: 3,
  canDelete: true,
  blockers: [],
  truncated: false,
})
function setup() {
  window.sessionStorage.clear()
  installAutoOpsHost(bootstrap(), window.location.origin)
  let preview = clearPreview(),
    deleteStatus = 200,
    lost = 0,
    refreshFailures = 0,
    pendingDeletion = false,
    resumeAllowed = true,
    resumeLost = false
  const resumeRequests: Array<{ path: string; body: unknown }> = []
  const receiptQueries: string[] = [],
    receipts = new Map<string, object>();
  const requests: Array<{ path: string; body: Record<string, unknown>; method: string }> = []
  const removed = vi.fn(),
    denied = vi.fn()
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/resume') && init?.method === 'POST') {
      resumeRequests.push({ path, body: JSON.parse(String(init.body)) })
      const id = decodeURIComponent(path.split('/').at(-2)!)
      const prior = receipts.get(id) as Record<string, unknown>
      receipts.set(id, { ...prior, state: 'completed', canResume: false, available: true, result: { deleted: true, projectId: target.projectId } })
      if (resumeLost) { resumeLost = false; throw new TypeError('继续删除响应丢失') }
      return Response.json(receipts.get(id))
    }
    if (path.includes("/projects/receipts/")) {
      receiptQueries.push(path);
      if (lost > 0) {
        lost--;
        return Response.json(null);
      }
      const value = receipts.get(decodeURIComponent(path.split("/").at(-1)!)) as Record<string, unknown> | undefined
      return Response.json(value?.state === 'pending' ? { ...value, canResume: resumeAllowed } : value ?? null);
    }
    if (path.endsWith('/deletion-preview')) return Response.json(preview)
    if (path.endsWith('/autoops/bootstrap')) {
      if (refreshFailures-- > 0)
        return Response.json({ error: '目录读取暂不可用' }, { status: 503 })
      return Response.json(bootstrap())
    }
    if (init?.method === 'DELETE') {
      requests.push({
        path,
        method: init.method,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      const body = requests.at(-1)!.body;
      const environment = /\/environments\/([^/]+)$/.exec(path)?.[1] ?? null;
      receipts.set(String(body.requestId), {
        state: pendingDeletion ? 'pending' : 'completed',
        ...(pendingDeletion ? { canResume: true } : {}),
        requestId: body.requestId,
        actorId: "removal-owner",
        projectId: target.projectId,
        environmentId: environment,
        operation: environment ? "environment.delete" : "project.delete",
        saved: true,
        available: !pendingDeletion,
        publicIntent: { expectedRevision: body.expectedRevision },
        nativeSynchronization: "not-required",
        createdAt: "2026-10-27T00:00:00Z",
        ...(pendingDeletion ? {} : { result: {
          deleted: true,
          projectId: target.projectId,
          ...(environment ? { environmentId: environment } : {}),
        } }),
      });
      if (lost-- > 0) throw new TypeError('隔离删除丢失响应')
      if (deleteStatus !== 200)
        return Response.json(
          {
            code: deleteStatus === 403 ? 'PROJECT_FORBIDDEN' : 'PROJECT_DELETE_BLOCKED',
            error: '真实引用或权限已变化',
          },
          { status: deleteStatus },
        )
      return Response.json({ deleted: true, projectId: target.projectId })
    }
    throw new Error(`未预期请求：${path}`)
  })
  return {
    fetcher,
    requests,
    receiptQueries,
    resumeRequests,
    removed,
    denied,
    setPreview: (value: Preview) => {
      preview = value
    },
    reject: (status: number) => {
      deleteStatus = status
    },
    lose: (count: number) => {
      lost = count
    },
    failRefresh: () => {
      refreshFailures = 1
    },
    pendingDeletion: () => { pendingDeletion = true; lost = 1 },
    loseResume: () => { resumeLost = true },
    revokeResume: () => { resumeAllowed = false },
  }
}
type Fixture = ReturnType<typeof setup>
function App({
  f,
  value = target,
  disabled = false,
}: {
  f: Fixture
  value?: ProjectRemovalTarget
  disabled?: boolean
}) {
  const [selected, setSelected] = useState<ProjectRemovalTarget | null>(null)
  const [locked, setLocked] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  return (
    <>
      <ProjectRemovalAction
        target={value}
        disabled={disabled || locked}
        onSelect={(next, button) => {
          trigger.current = button
          setSelected(next)
        }}
      />
      {selected ? (
        <ProjectRemovalDialog
          key={`${selected.projectId}:${selected.environmentId ?? ''}`}
          target={selected}
          finalFocus={trigger}
          onClose={() => setSelected(null)}
          onRemoved={() => {
            f.removed()
            setSelected(null)
          }}
          onLockChange={setLocked}
          onAccessDenied={f.denied}
        />
      ) : null}
    </>
  )
}
async function open(name = target.name, environment = false) {
  await page
    .getByRole('button', { name: `管理${environment ? '环境' : '项目'} ${name}`, exact: true })
    .click()
  await page
    .getByRole('menuitem', { name: environment ? '删除环境' : '删除项目', exact: true })
    .click()
  await expect.element(page.getByRole('dialog')).toBeVisible()
}

it('菜单两步加确认一步删除空项目，提交 DELETE 后刷新目录并恢复真实入口焦点', async () => {
  await page.viewport(390, 500)
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using screen = await render(
    <StrictMode>
      <App f={f} />
    </StrictMode>,
  )
  const trigger = screen.getByRole('button', { name: `管理项目 ${target.name}` })
  await open()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(trigger).toHaveFocus()
  expect(f.removed).toHaveBeenCalledOnce()
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toMatchObject({
    method: 'DELETE',
    path: `/api/agent-demo/t3/api/v1/projects/${target.projectId}`,
    body: { expectedRevision: 3, requestId: expect.any(String) },
  })
  expect(f.requests[0]!.body).not.toHaveProperty('value')
})

it('引用阻止及修订变化都不能发送删除，刷新解除引用后取消与 Esc 恢复入口焦点', async () => {
  const f = setup()
  f.setPreview({
    ...clearPreview(),
    canDelete: false,
    blockers: [{ kind: 'native-threads', count: 2, message: '仍有私有或归档会话' }],
  })
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using screen = await render(<App f={f} />)
  const trigger = screen.getByRole('button', { name: `管理项目 ${target.name}` })
  await open()
  await expect.element(page.getByText('仍有私有或归档会话')).toBeVisible()
  await expect.element(page.getByRole('button', { name: '确认删除', exact: true })).toBeDisabled()
  f.setPreview({ ...clearPreview(), revision: 4 })
  await page.getByRole('button', { name: '刷新引用' }).click()
  await expect.element(page.getByRole('alert')).toHaveTextContent('配置已更新，请取消并刷新后重新确认。')
  await expect.element(page.getByRole('button', { name: '确认删除', exact: true })).toBeDisabled()
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(trigger).toHaveFocus()
  expect(f.requests).toHaveLength(0)
})

it('预检通过后真实 409 拒绝保留错误与刷新恢复入口，不显示成功', async () => {
  const f = setup()
  f.reject(409)
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<App f={f} />)
  await open()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect
    .element(page.getByRole('dialog').getByRole('alert'))
    .toHaveTextContent('真实引用或权限已变化')
  await expect.element(page.getByRole('button', { name: '刷新引用' })).toBeVisible()
  expect(readPendingProjectWrite()).toBeNull()
  expect(f.removed).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(1)
})

it('删除时撤权 403 关闭旧对象并通知授权刷新，不继续提交或调用删除成功', async () => {
  const f = setup()
  f.reject(403)
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using screen = await render(<App f={f} />)
  const trigger = screen.getByRole('button', { name: `管理项目 ${target.name}` })
  await open()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(trigger).toHaveFocus()
  expect(f.denied).toHaveBeenCalledOnce()
  expect(f.removed).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(1)
})

it("删除响应丢失后原收据null锁定关闭，再核对只GET同一requestId", async () => {
  const f = setup()
  f.lose(2)
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<App f={f} />)
  await open()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.element(page.getByRole('button', { name: '核对原请求', exact: true })).toBeEnabled()
  await expect.element(page.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('dialog')).toBeVisible()
  const original = readPendingProjectWrite()
  expect(original?.method).toBe('DELETE')
  expect(f.requests).toHaveLength(1);
  expect(f.receiptQueries).toHaveLength(1)
  await page.getByRole('button', { name: '核对原请求', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]!.body).toEqual(original!.body);
  expect(f.receiptQueries).toEqual([
    `/api/agent-demo/t3/api/v1/projects/receipts/${original!.body.requestId}`,
    `/api/agent-demo/t3/api/v1/projects/receipts/${original!.body.requestId}`,
  ])
  expect(readPendingProjectWrite()).toBeNull()
})

it('另一项目待核对收据不阻塞当前环境删除，也不会被当前删除覆盖或发送', async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true })
  const f = setup()
  const original = prepareProjectMutation('/api/v1/projects/other', 9, {}, 'DELETE')
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(
    <App f={f} value={{ ...target, environmentId: 'test', name: '测试环境' }} />,
  )
  await open('测试环境', true)
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]!.body.requestId).not.toBe(original.body.requestId)
  expect(f.receiptQueries).toHaveLength(0)
  expect(readPendingProjectWrite()).toEqual(original)
})

it('删除成功后目录刷新失败仍确认已删除，重试刷新不会再提交删除', async () => {
  const f = setup()
  f.failRefresh()
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<App f={f} />)
  await open()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.element(page.getByRole('button', { name: '重试刷新目录' })).toBeEnabled()
  await expect.element(page.getByRole('button', { name: '确认删除', exact: true })).toBeDisabled()
  await expect.element(page.getByRole('button', { name: '关闭', exact: true }).nth(0)).toBeEnabled()
  await expect.element(page.getByRole('button', { name: '关闭', exact: true }).nth(1)).toBeEnabled()
  expect(readPendingProjectWrite()).toBeNull()
  await page.getByRole('button', { name: '重试刷新目录' }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.requests).toHaveLength(1)
  expect(f.removed).toHaveBeenCalledOnce()
})

it('预检晚到响应在取消后不复活旧弹窗，禁用管理入口不能打开删除', async () => {
  const f = setup()
  let deliver!: (response: Response) => void
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        deliver = resolve
      }),
  )
  using _fetch = stubGlobal('fetch', fetcher)
  await using screen = await render(<App f={f} />)
  await open()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  deliver(Response.json(clearPreview()))
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect
    .element(screen.getByRole('button', { name: `管理项目 ${target.name}` }))
    .toHaveFocus()
  await screen.rerender(<App f={f} disabled />)
  await expect
    .element(screen.getByRole('button', { name: `管理项目 ${target.name}` }))
    .toBeDisabled()
  expect(f.requests).toHaveLength(0)
});


it('原删除确认为待继续后显式恢复，恢复断线仅GET核对并恢复入口焦点', async () => {
  const f = setup()
  f.pendingDeletion()
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using screen = await render(<App f={f} />)
  const trigger = screen.getByRole('button', { name: `管理项目 ${target.name}` })
  await open()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.element(page.getByRole('button', { name: '继续删除', exact: true })).toBeEnabled()
  expect(f.requests).toHaveLength(1)
  expect(f.resumeRequests).toHaveLength(0)
  expect(f.receiptQueries).toHaveLength(1)
  f.loseResume()
  await page.getByRole('button', { name: '继续删除', exact: true }).click()
  await expect.element(page.getByRole('button', { name: '核对原请求', exact: true })).toBeEnabled()
  expect(f.requests).toHaveLength(1)
  expect(f.resumeRequests).toHaveLength(1)
  const original = f.requests[0]!.body
  expect(f.resumeRequests[0]).toEqual({ path: `/api/agent-demo/t3/api/v1/projects/receipts/${original.requestId}/resume`, body: { operation: 'project.delete', projectId: target.projectId, publicIntent: { expectedRevision: original.expectedRevision } } })
  expect(readPendingProjectWrite()?.body.requestId).toBe(original.requestId)
  await page.getByRole('button', { name: '核对原请求', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(trigger).toHaveFocus()
  expect(f.receiptQueries).toHaveLength(3)
  expect(f.resumeRequests).toHaveLength(1)
  expect(f.requests).toHaveLength(1)
  expect(f.removed).toHaveBeenCalledOnce()
})

it('已显示继续删除后当前授权撤回，点击前GET复核拒绝恢复写入并保留原请求', async () => {
  const f = setup()
  f.pendingDeletion()
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<App f={f} />)
  await open()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect.element(page.getByRole('button', { name: '继续删除', exact: true })).toBeEnabled()
  f.revokeResume()
  await page.getByRole('button', { name: '继续删除', exact: true }).click()
  await expect.element(page.getByRole('button', { name: '核对原请求', exact: true })).toBeEnabled()
  expect(f.resumeRequests).toHaveLength(0)
  expect(f.requests).toHaveLength(1)
  expect(f.receiptQueries).toHaveLength(2)
  expect(readPendingProjectWrite()?.body.requestId).toBe(f.requests[0]!.body.requestId)
  expect(f.removed).not.toHaveBeenCalled()
})
