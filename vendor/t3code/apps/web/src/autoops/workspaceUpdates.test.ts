import { expect, it, vi } from 'vite-plus/test'
import type { WorkspaceUpdatePlan } from './workspaceUpdates'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
    clear: () => values.clear(),
  }
}
const host = (id = 'update-user') => ({
  principal: { id, displayName: '更新设置协议测试' },
  csrfToken: 'update-csrf',
  gatewayBasePath: '/api/agent-demo/t3',
  fixedModel: { instanceId: 'codex', model: 'fixture-model' },
  runtimeMode: 'approval-required' as const,
  projects: [],
  capabilities: {},
})
const settings = {
  enabled: false,
  intervalMinutes: 60,
  timezone: 'Asia/Shanghai',
  sourceIds: ['repository'],
}
async function setup() {
  vi.stubGlobal('window', {
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    location: { origin: 'https://work.test' },
  })
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(host(), 'https://work.test')
  const api = await import('./workspaceUpdates')
  const pending = () => api.prepareWorkspaceUpdate('project', 'internal', 0, settings)
  const result = (): WorkspaceUpdatePlan => ({
    ...settings,
    projectId: 'project',
    scope: 'internal',
    revision: 1,
    actorId: 'update-user',
    updatedAt: '2026-10-26T00:00:00Z',
    nextRunAt: null,
  })
  return {
    api,
    pending,
    result,
    changeCredentials: () =>
      installAutoOpsHost({ ...host(), csrfToken: 'renewed-csrf' }, 'https://work.test'),
    [Symbol.dispose]() {
      vi.unstubAllGlobals()
      vi.resetModules()
    },
  }
}

it('更新设置使用同源路径及当前CSRF，成功确认后清理本范围待处理记录', async () => {
  using f = await setup()
  const pending = f.pending(),
    fetcher = vi.fn().mockResolvedValue(Response.json(f.result()))
  vi.stubGlobal('fetch', fetcher)
  await expect(f.api.submitWorkspaceUpdate(pending)).resolves.toEqual(f.result())
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    '/api/agent-demo/t3/api/v1/projects/project/workspace/updates/internal',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(pending.input),
      headers: expect.objectContaining({ 'X-Demo-CSRF': 'update-csrf' }),
    }),
  )
  expect(f.api.readPendingWorkspaceUpdate('project', 'internal')).toBeNull()
})

it('断线保留原请求，阻止同范围新提交而内部外部状态互不替换', async () => {
  using f = await setup()
  const pending = f.pending()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('隔离断线')))
  await expect(f.api.submitWorkspaceUpdate(pending)).rejects.toMatchObject({ uncertain: true })
  expect(f.api.readPendingWorkspaceUpdate('project', 'internal')).toEqual(pending)
  expect(() => f.pending()).toThrow('请先核对上一次更新设置')
  const external = f.api.prepareWorkspaceUpdate('project', 'external', 0, settings)
  expect(external.input.requestId).not.toBe(pending.input.requestId)
})

it('未找到原收据只返回missing，明确重试使用同一请求而不自动执行', async () => {
  using f = await setup()
  const pending = f.pending(),
    fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { code: 'WORKSPACE_UPDATE_RECEIPT_NOT_FOUND', error: '尚未接受' },
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(Response.json(f.result()))
  vi.stubGlobal('fetch', fetcher)
  await expect(f.api.recoverWorkspaceUpdate(pending)).resolves.toEqual({ status: 'missing' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(f.api.readPendingWorkspaceUpdate('project', 'internal')).toEqual(pending)
  await f.api.submitWorkspaceUpdate(pending)
  expect(JSON.parse(fetcher.mock.calls[1]![1].body).requestId).toBe(pending.input.requestId)
})

it.each([
  { projectId: 'other-project' },
  { scope: 'external' },
  { actorId: 'other-user' },
  { revision: 2 },
  { intervalMinutes: 15 },
  { sourceIds: ['foreign-source'] },
])('原收据范围或配置不符时保持冻结，不冒认已保存：%j', async (patch) => {
  using f = await setup()
  const pending = f.pending()
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(Response.json({ kind: 'settings', result: { ...f.result(), ...patch } })),
  )
  await expect(f.api.recoverWorkspaceUpdate(pending)).rejects.toMatchObject({
    code: 'WORKSPACE_UPDATE_PENDING_INVALID',
    uncertain: true,
  })
  expect(f.api.readPendingWorkspaceUpdate('project', 'internal')).toEqual(pending)
})

it('恢复时明确撤权清除待处理配置，普通503保持原请求', async () => {
  using f = await setup()
  const pending = f.pending(),
    fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ code: 'OFFLINE', error: '隔离不可用' }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        Response.json({ code: 'FORBIDDEN', error: '维护权限已撤回' }, { status: 403 }),
      )
  vi.stubGlobal('fetch', fetcher)
  await expect(f.api.recoverWorkspaceUpdate(pending)).rejects.toMatchObject({ status: 503 })
  expect(f.api.readPendingWorkspaceUpdate('project', 'internal')).toEqual(pending)
  await expect(f.api.recoverWorkspaceUpdate(pending)).rejects.toMatchObject({ status: 403 })
  expect(f.api.readPendingWorkspaceUpdate('project', 'internal')).toBeNull()
})

it('浏览器记录被篡改不能发请求，也不能借另一个账号恢复原设置', async () => {
  using f = await setup()
  const pending = f.pending(),
    key = window.sessionStorage.key(0)!,
    fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  window.sessionStorage.setItem(
    key,
    JSON.stringify({ ...pending, input: { ...pending.input, actorId: 'forged' } }),
  )
  expect(() => f.api.readPendingWorkspaceUpdate('project', 'internal')).toThrow(
    '原更新设置记录无法核实',
  )
  await expect(
    f.api.submitWorkspaceUpdate({ ...pending, actorId: 'other-user' }),
  ).rejects.toMatchObject({ code: 'WORKSPACE_UPDATE_PENDING_INVALID' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('响应迟到时登录凭据已经改变，不返回旧数据或清理仍待核查的原请求', async () => {
  using f = await setup()
  const pending = f.pending()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      f.changeCredentials()
      return Response.json(f.result())
    }),
  )
  await expect(f.api.submitWorkspaceUpdate(pending)).rejects.toMatchObject({ name: 'AbortError' })
  expect(f.api.readPendingWorkspaceUpdate('project', 'internal')).toEqual(pending)
  expect(window.sessionStorage.length).toBe(1)
})

it('保存后权限失效接受最小确认并保留服务端原收据，不在页面恢复旧授权', async () => {
  using f = await setup()
  const pending = f.pending()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ saved: true, available: false })),
  )
  await expect(f.api.submitWorkspaceUpdate(pending)).resolves.toEqual({
    saved: true,
    available: false,
  })
  expect(f.api.readPendingWorkspaceUpdate('project', 'internal')).toBeNull()
})
