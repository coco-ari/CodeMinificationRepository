import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'
import { act, render } from '../../test/render'
import { SidebarProvider } from '~/components/ui/sidebar'
import { AutoOpsCustomerDevicesPage } from './CustomerDevicesSettings'
import { AutoOpsRequestError } from './apiClient'
import type { CustomerDevice, CustomerWorkspace } from './customerAgents'
import '../index.css'

const mocks = vi.hoisted(() => ({
  host: vi.fn(),
  devices: vi.fn(),
  workspaces: vi.fn(),
  pairing: vi.fn(),
}))
vi.mock(import('./hostConfig'), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
}))
vi.mock(import('./projectNavigation'), async (original) => ({
  ...(await original()),
  useAutoOpsProjectId: () => 'p-one',
}))
vi.mock(import('./customerAgents'), async (original) => ({
  ...(await original()),
  loadCustomerWorkspaces: mocks.workspaces,
  customerRequest: async <T,>(path: string, body?: object, signal?: AbortSignal): Promise<T> =>
    path === 'devices' ? mocks.devices(signal) : mocks.pairing(path, body, signal),
}))
const device: CustomerDevice = {
  id: 'device-one',
  ownerId: 'owner-one',
  label: '隔离测试电脑',
  status: 'active',
  online: true,
  connectionEpoch: 1,
  createdAt: '2026-10-23T00:00:00Z',
}
const workspace: CustomerWorkspace = {
  registeredWorkspaceId: 'workspace-one',
  deviceId: device.id,
  ownerId: device.ownerId,
  projectId: 'p-one',
  label: '已登记的私有目录',
  workspaceBindingRevision: 1,
  runtimeId: 'codex',
  status: 'active',
  createdAt: device.createdAt,
  updatedAt: device.createdAt,
}
const host = (ownerId = 'owner-one') => ({
  principal: { id: ownerId, displayName: '隔离用户' },
  customerAgentsEnabled: true,
  httpBaseUrl: location.origin,
  wsBaseUrl: 'ws://isolated.invalid',
  gatewayBasePath: '/api/agent-demo/t3',
  csrfToken: 'isolated-token',
  fixedModel: { instanceId: 'codex', model: 'test-model' },
  runtimeMode: 'approval-required',
  capabilities: {},
  projects: [{ id: 'p-one', name: '隔离项目', environments: [], agents: [] }],
})
const view = () => (
  <SidebarProvider>
    <AutoOpsCustomerDevicesPage />
  </SidebarProvider>
)
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((deliver) => {
    resolve = deliver
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.host.mockReturnValue(host())
  mocks.devices.mockResolvedValue({ devices: [device] })
  mocks.workspaces.mockResolvedValue({ workspaces: [workspace] })
  mocks.pairing.mockResolvedValue({
    pairingCode: 'isolated-pairing',
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  })
})
afterEach(() => vi.useRealTimers())

describe('客户设备读取的故障隔离', () => {
  it('工作区仍在读取时，已到达的设备可以立即查看', async () => {
    const pending = deferred<{ workspaces: CustomerWorkspace[] }>()
    mocks.workspaces.mockReturnValueOnce(pending.promise)
    await using screen = await render(view())
    await expect.element(page.getByRole('button', { name: '详情', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '详情', exact: true }).click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('正在读取已登记工作区…'))
    await act(() => pending.resolve({ workspaces: [workspace] }))
    await vi.waitFor(() => expect(document.body.textContent).toContain(workspace.label))
  })

  it('工作区读取失败不抹掉成功设备，也不把未知数量显示成零', async () => {
    mocks.workspaces.mockRejectedValue(new Error('登记目录暂时不可用'))
    await using screen = await render(view())
    await expect.element(page.getByRole('button', { name: '详情', exact: true })).toBeVisible()
    await vi.waitFor(() => expect(screen.container.textContent).toContain('工作区状态暂不可用'))
    expect(screen.container.textContent).not.toContain('0 个工作区')
    await page.getByRole('button', { name: '详情', exact: true }).click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('登记目录暂时不可用'))
    expect(document.body.textContent).not.toContain('尚未登记工作区')
  })

  for (const status of [401, 403, 404]) {
    it('工作区读取 ' + status + ' 清除目录，同时保留有权查看的设备', async () => {
      await using screen = await render(view())
      await page.getByRole('button', { name: '详情', exact: true }).click()
      await vi.waitFor(() => expect(document.body.textContent).toContain(workspace.label))
      mocks.workspaces.mockRejectedValue(
        new AutoOpsRequestError('工作区访问已失效', 'ACCESS_DENIED', status),
      )
      await act(() => window.dispatchEvent(new Event('focus')))
      await vi.waitFor(() => expect(document.body.textContent).toContain('工作区访问已失效'))
      expect(document.body.textContent).not.toContain(workspace.label)
      await expect
        .element(page.getByRole('dialog', { name: device.label, exact: true }))
        .toBeVisible()
      expect(screen.container.textContent).toContain(device.label)
    })

    it('设备读取 ' + status + ' 清除设备并关闭旧详情', async () => {
      await using screen = await render(view())
      await page.getByRole('button', { name: '详情', exact: true }).click()
      await expect
        .element(page.getByRole('dialog', { name: device.label, exact: true }))
        .toBeVisible()
      mocks.devices.mockRejectedValue(
        new AutoOpsRequestError('设备访问已失效', 'ACCESS_DENIED', status),
      )
      await act(() => window.dispatchEvent(new Event('focus')))
      await vi.waitFor(() => expect(screen.container.textContent).toContain('设备访问已失效'))
      await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
      expect(document.body.textContent).not.toContain(device.label)
      expect(document.body.textContent).not.toContain(workspace.label)
    })
  }

  it('焦点与轮询只合并为下一轮，慢请求期间不重叠读取', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const devices = deferred<{ devices: CustomerDevice[] }>()
    const workspaces = deferred<{ workspaces: CustomerWorkspace[] }>()
    mocks.devices.mockReturnValueOnce(devices.promise)
    mocks.workspaces.mockReturnValueOnce(workspaces.promise)
    await using screen = await render(view())
    await act(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await vi.advanceTimersByTimeAsync(30000)
    expect(mocks.devices).toHaveBeenCalledTimes(1)
    expect(mocks.workspaces).toHaveBeenCalledTimes(1)
    await act(() => {
      devices.resolve({ devices: [device] })
      workspaces.resolve({ workspaces: [workspace] })
    })
    await vi.waitFor(() => expect(mocks.devices).toHaveBeenCalledTimes(2))
    expect(mocks.workspaces).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(14000)
    expect(mocks.devices).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.devices).toHaveBeenCalledTimes(3)
    const signal = mocks.devices.mock.calls[0]![0] as AbortSignal
    const workspaceSignal = mocks.workspaces.mock.calls[0]![1] as AbortSignal
    await screen.unmount()
    expect(signal.aborted).toBe(true)
    expect(workspaceSignal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60000)
    expect(mocks.devices).toHaveBeenCalledTimes(3)
  })

  it('切换账号取消旧读取，忽略不服从取消的迟到结果', async () => {
    const devices = deferred<{ devices: CustomerDevice[] }>()
    const workspaces = deferred<{ workspaces: CustomerWorkspace[] }>()
    mocks.devices.mockReturnValueOnce(devices.promise)
    mocks.workspaces.mockReturnValueOnce(workspaces.promise)
    await using screen = await render(view())
    const signal = mocks.devices.mock.calls[0]![0] as AbortSignal
    mocks.host.mockReturnValue(host('owner-two'))
    mocks.devices.mockResolvedValue({
      devices: [{ ...device, id: 'device-two', ownerId: 'owner-two', label: '另一个账号的电脑' }],
    })
    mocks.workspaces.mockResolvedValue({ workspaces: [] })
    await screen.rerender(
      <SidebarProvider key="owner-two">
        <AutoOpsCustomerDevicesPage />
      </SidebarProvider>,
    )
    await vi.waitFor(() => expect(screen.container.textContent).toContain('另一个账号的电脑'))
    expect(signal.aborted).toBe(true)
    await act(() => {
      devices.resolve({ devices: [device] })
      workspaces.resolve({ workspaces: [workspace] })
    })
    expect(screen.container.textContent).not.toContain(device.label)
    expect(screen.container.textContent).toContain('另一个账号的电脑')
  })

  it('配对期间采用同一个串行轮询，关闭后恢复正常间隔', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await using screen = await render(view())
    await vi.waitFor(() => expect(screen.container.textContent).toContain(device.label))
    const connect = [...screen.container.querySelectorAll('button')].find(
      (button) => button.textContent === '连接电脑',
    )!
    await act(() => connect.click())
    await vi.waitFor(() => expect(mocks.pairing).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mocks.devices).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.devices).toHaveBeenCalledTimes(3)
    const done = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '完成',
    )!
    await act(() => done.click())
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.devices).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.devices).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(12000)
    expect(mocks.devices).toHaveBeenCalledTimes(5)
  })
})
