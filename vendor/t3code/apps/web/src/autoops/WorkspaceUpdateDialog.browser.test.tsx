import { StrictMode, useRef, useState } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { render, stubGlobal } from '../../test/render'
import { Button } from '~/components/ui/button'
import { WorkspaceUpdateDialog } from './WorkspaceUpdateDialog'
import { installAutoOpsHost } from './hostConfig'
import type { WorkspaceUpdatePlan, WorkspaceUpdateScope } from './workspaceUpdates'
import '../index.css'

function setup() {
  window.sessionStorage.clear()
  const capabilities = {
    'workspace.read': true,
    'workspace.manage': true,
    'workspace.external.publish': true,
    'deployment.read': false,
    'deployment.execute': false,
  }
  const bootstrap = () => ({
    principal: { id: 'updates-ui-user', displayName: '资料管理者' },
    csrfToken: 'updates-csrf',
    gatewayBasePath: '/api/agent-demo/t3',
    fixedModel: { instanceId: 'codex', model: 'fixture-model' },
    runtimeMode: 'approval-required' as const,
    capabilities: {},
    projects: [
      {
        id: 'project',
        name: '隔离更新项目',
        agents: [],
        environments: [],
        capabilities: { ...capabilities },
      },
    ],
  })
  installAutoOpsHost(bootstrap(), window.location.origin)
  const plans: Record<WorkspaceUpdateScope, WorkspaceUpdatePlan | null> = {
    internal: null,
    external: null,
  }
  const receipts = new Map<string, WorkspaceUpdatePlan>()
  const writes: Array<{
    scope: string
    input: { requestId: string; expectedRevision: number; value: Record<string, unknown> }
  }> = []
  const options = {
    read503: 0,
    receipt503: 0,
    denied: false,
    lost: '' as '' | 'before' | 'after',
    conflict: false,
    holdReads: false,
  }
  const held: Array<() => void> = []
  const sources = [{ id: 'repository', name: '项目仓库' }]
  const callbacks = { changed: vi.fn(), denied: vi.fn() }
  const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(request), window.location.origin).pathname.replace(
      /^\/api\/agent-demo\/t3/,
      '',
    )
    if (options.denied)
      return Response.json({ code: 'FORBIDDEN', error: '工作区维护权限已撤回' }, { status: 403 })
    if (path.includes('/requests/')) {
      if (options.receipt503-- > 0)
        return Response.json({ code: 'OFFLINE', error: '收据暂不可用' }, { status: 503 })
      const result = receipts.get(path.split('/').at(-1)!)
      return result
        ? Response.json({ kind: 'settings', result })
        : Response.json(
            { code: 'WORKSPACE_UPDATE_RECEIPT_NOT_FOUND', error: '尚未找到原收据' },
            { status: 404 },
          )
    }
    if (!init?.method || init.method === 'GET') {
      if (options.read503-- > 0)
        return Response.json({ code: 'OFFLINE', error: '设置暂不可用' }, { status: 503 })
      const snapshot = structuredClone({ ...plans, sources })
      if (options.holdReads)
        return await new Promise<Response>((resolve) => {
          held.push(() => resolve(Response.json(snapshot)))
        })
      return Response.json(snapshot)
    }
    const scope = path.split('/').at(-1)! as WorkspaceUpdateScope
    const input = JSON.parse(String(init.body)) as (typeof writes)[number]['input']
    writes.push({ scope, input })
    if (options.lost === 'before') {
      options.lost = ''
      throw new TypeError('隔离请求未到达')
    }
    if (receipts.has(input.requestId)) return Response.json(receipts.get(input.requestId))
    if (options.conflict) {
      options.conflict = false
      plans[scope] = {
        projectId: 'project',
        scope,
        actorId: 'other-manager',
        revision: input.expectedRevision + 1,
        enabled: true,
        intervalMinutes: 120,
        timezone: 'UTC',
        sourceIds: ['repository'],
        updatedAt: '2026-10-26T01:00:00Z',
        nextRunAt: '2026-10-26T03:00:00Z',
      }
      return Response.json(
        { code: 'WORKSPACE_UPDATE_REVISION_CONFLICT', error: '其他管理员已修改设置' },
        { status: 409 },
      )
    }
    const result = {
      ...input.value,
      projectId: 'project',
      scope,
      actorId: 'updates-ui-user',
      revision: input.expectedRevision + 1,
      updatedAt: '2026-10-26T00:00:00Z',
      nextRunAt: input.value.enabled ? '2026-10-26T01:00:00Z' : null,
    } as WorkspaceUpdatePlan
    plans[scope] = result
    receipts.set(input.requestId, result)
    if (options.lost === 'after') {
      options.lost = ''
      throw new TypeError('隔离响应丢失')
    }
    return Response.json(result)
  })
  return {
    plans,
    receipts,
    writes,
    options,
    held,
    sources,
    callbacks,
    fetcher,
    revoke() {
      capabilities['workspace.manage'] = false
      capabilities['workspace.external.publish'] = false
      installAutoOpsHost(bootstrap(), window.location.origin)
    },
  }
}
function App({
  fixture,
  scope = 'internal',
}: {
  fixture: ReturnType<typeof setup>
  scope?: WorkspaceUpdateScope
}) {
  const [open, setOpen] = useState(false),
    trigger = useRef<HTMLButtonElement | null>(null)
  return (
    <StrictMode>
      <Button ref={trigger} onClick={() => setOpen(true)}>
        更新设置
      </Button>
      <WorkspaceUpdateDialog
        projectId="project"
        scope={scope}
        open={open}
        onOpenChange={setOpen}
        finalFocus={trigger}
        onChanged={fixture.callbacks.changed}
        onAccessDenied={fixture.callbacks.denied}
      />
    </StrictMode>
  )
}
async function open() {
  await page.getByRole('button', { name: '更新设置', exact: true }).click()
  await expect.element(page.getByRole('textbox', { name: '时区', exact: true })).toBeEnabled()
}
async function enable() {
  await page.getByRole('checkbox', { name: '启用定期更新', exact: true }).click()
  await page.getByRole('checkbox', { name: '确认使用当前全部来源', exact: true }).click()
}

it('默认关闭，显式周期时区和来源确认后保存；重新打开可停用并恢复入口焦点', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using screen = await render(<App fixture={f} />)
  await open()
  await expect.element(page.getByRole('checkbox', { name: '启用定期更新' })).not.toBeChecked()
  await enable()
  await page.getByRole('spinbutton', { name: '更新间隔（分钟）' }).fill('30')
  await page.getByRole('textbox', { name: '时区' }).fill('UTC')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '更新设置', exact: true })).toHaveFocus()
  expect(f.writes[0]).toMatchObject({
    scope: 'internal',
    input: {
      expectedRevision: 0,
      value: { enabled: true, intervalMinutes: 30, timezone: 'UTC', sourceIds: ['repository'] },
    },
  })
  await open()
  await page.getByRole('checkbox', { name: '启用定期更新' }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.plans.internal?.enabled).toBe(false)
  expect(f.writes[1]?.input.expectedRevision).toBe(1)
})

it('外部设置只作用于外部范围，清楚保留待复核步骤且不发确认发布请求', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<App fixture={f} scope="external" />)
  await open()
  await expect
    .element(page.getByText('从当前内部资料按内置规则生成；待复核文件仍须人工确认。'))
    .toBeVisible()
  await enable()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.writes.map((value) => value.scope)).toEqual(['external'])
  expect(f.plans.internal).toBeNull()
  expect(f.fetcher.mock.calls.every(([request]) => !String(request).includes('/publish'))).toBe(
    true,
  )
})

it('设置读取失败有独立重试；非法时区在发送前显示错误并保留草稿', async () => {
  const f = setup()
  f.options.read503 = 2
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<App fixture={f} />)
  await page.getByRole('button', { name: '更新设置', exact: true }).click()
  await expect.element(page.getByText('设置暂不可用')).toBeVisible()
  f.options.read503 = 0
  await page.getByRole('button', { name: '重试读取' }).click()
  await expect.element(page.getByRole('textbox', { name: '时区' })).toBeEnabled()
  await page.getByRole('textbox', { name: '时区' }).fill('Invalid/Timezone')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByText('请选择有效的 IANA 时区。')).toBeVisible()
  await expect.element(page.getByRole('textbox', { name: '时区' })).toHaveValue('Invalid/Timezone')
  expect(f.writes).toHaveLength(0)
})

it('响应丢失保留原请求并冻结字段，核对已保存收据后只有一次写入', async () => {
  const f = setup()
  f.options.lost = 'after'
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<App fixture={f} />)
  await open()
  await enable()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('button', { name: '核对原请求' })).toBeEnabled()
  await expect.element(page.getByRole('textbox', { name: '时区' })).toBeDisabled()
  await page.getByRole('button', { name: '核对原请求' }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.writes).toHaveLength(1)
  expect(f.callbacks.changed).toHaveBeenCalledOnce()
})

it('原收据缺失时显式按原请求重试，关闭再开不会生成另一个请求', async () => {
  const f = setup()
  f.options.lost = 'before'
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<App fixture={f} />)
  await open()
  await enable()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('button', { name: '核对原请求' })).toBeEnabled()
  const first = structuredClone(f.writes[0])
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '更新设置', exact: true }).click()
  await expect.element(page.getByRole('button', { name: '按原请求重试' })).toBeEnabled()
  expect(f.writes).toHaveLength(1)
  await page.getByRole('button', { name: '按原请求重试' }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.writes).toEqual([first, first])
})

it('修订冲突刷新实际设置，必须重新确认来源后才生成新请求', async () => {
  const f = setup()
  f.options.conflict = true
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<App fixture={f} />)
  await open()
  await enable()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('spinbutton', { name: '更新间隔（分钟）' })).toHaveValue(120)
  await expect.element(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await page.getByRole('checkbox', { name: '确认使用当前全部来源' }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.writes[1]?.input.expectedRevision).toBe(1)
  expect(f.writes[1]?.input.requestId).not.toBe(f.writes[0]?.input.requestId)
})

it('服务端撤权清除表单且保留真实错误，前端授权更新也不能继续配置', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetcher)
  await using _screen = await render(<App fixture={f} />)
  await open()
  f.options.denied = true
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByText('工作区维护权限已撤回')).toBeVisible()
  await expect.element(page.getByRole('textbox', { name: '时区' })).not.toBeInTheDocument()
  await expect.element(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  f.revoke()
  await expect.element(page.getByText('当前账号无权配置此范围的资料更新。')).toBeVisible()
})

it('切换范围隔离原内部未知设置，外部计划可以独立配置', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetcher)
  f.options.lost = 'before'
  await using screen = await render(<App fixture={f} />)
  await open()
  await enable()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('button', { name: '核对原请求' })).toBeEnabled()
  const original = f.writes[0]!.input.requestId
  await screen.rerender(<App fixture={f} scope="external" />)
  await expect.element(page.getByRole('heading', { name: '外部更新设置' })).toBeVisible()
  await expect.element(page.getByRole('textbox', { name: '时区' })).toBeEnabled()
  await enable()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(f.writes.map((value) => value.scope)).toEqual(['internal', 'external'])
  await screen.rerender(<App fixture={f} />)
  await page.getByRole('button', { name: '更新设置', exact: true }).click()
  await expect.element(page.getByRole('button', { name: '按原请求重试' })).toBeEnabled()
  await expect.element(page.getByText(`正在保留原请求：${original}`)).toBeVisible()
})

it('内部读取迟到时已切到外部，不覆盖新范围的实际周期和表单', async () => {
  const f = setup()
  using _fetch = stubGlobal('fetch', f.fetcher)
  const plan = (scope: WorkspaceUpdateScope, intervalMinutes: number): WorkspaceUpdatePlan => ({
    projectId: 'project',
    scope,
    actorId: 'updates-ui-user',
    revision: 1,
    enabled: true,
    intervalMinutes,
    timezone: 'UTC',
    sourceIds: ['repository'],
    updatedAt: '2026-10-26T00:00:00Z',
    nextRunAt: '2026-10-26T01:00:00Z',
  })
  f.plans.internal = plan('internal', 360)
  f.plans.external = plan('external', 15)
  f.options.holdReads = true
  await using screen = await render(<App fixture={f} />)
  await page.getByRole('button', { name: '更新设置', exact: true }).click()
  await expect.poll(() => f.held.length).toBeGreaterThan(0)
  f.options.holdReads = false
  await screen.rerender(<App fixture={f} scope="external" />)
  await expect.element(page.getByRole('spinbutton', { name: '更新间隔（分钟）' })).toHaveValue(15)
  for (const release of f.held.splice(0)) release()
  await expect.element(page.getByRole('heading', { name: '外部更新设置' })).toBeVisible()
  await expect.element(page.getByRole('spinbutton', { name: '更新间隔（分钟）' })).toHaveValue(15)
  expect(f.writes).toHaveLength(0)
})

it.each(['light', 'dark'])(
  '%s 390×500 短窗可滚动提交，长来源不溢出且Esc归还入口焦点',
  async (theme) => {
    const f = setup()
    f.sources[0]!.name = '这是工作区很长的来源名称'.repeat(20)
    const previous = {
      dark: document.documentElement.classList.contains('dark'),
      width: window.innerWidth,
      height: window.innerHeight,
    }
    await using _appearance = {
      async [Symbol.asyncDispose]() {
        document.documentElement.classList.toggle('dark', previous.dark)
        await page.viewport(previous.width, previous.height)
      },
    }
    document.documentElement.classList.toggle('dark', theme === 'dark')
    await page.viewport(390, 500)
    using _fetch = stubGlobal('fetch', f.fetcher)
    await using screen = await render(<App fixture={f} />)
    await open()
    await enable()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    await open()
    const bounds = document.querySelector('[role="dialog"]')!.getBoundingClientRect()
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth)
    expect(bounds.height).toBeLessThanOrEqual(window.innerHeight)
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '更新设置', exact: true }))
      .toHaveFocus()
  },
)
