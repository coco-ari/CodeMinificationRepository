import '../index.css';
import { describe, expect, it } from 'vite-plus/test';
import { act, render } from '../../test/render';
import { CustomerDeviceDetailsPanel } from './CustomerDevicesSettings';
import type { CustomerDevice, CustomerWorkspace } from './customerAgents';

const device: CustomerDevice = {
  id: 'device-one', ownerId: 'owner-one', label: 'LongDeviceName'.repeat(11),
  platform: 'P'.repeat(80), connectorVersion: 'V'.repeat(80), status: 'active',
  online: false, connectionEpoch: 0, createdAt: '2026-10-23T00:00:00Z',
};
const workspaces: CustomerWorkspace[] = Array.from({ length: 30 }, (_, i) => ({
  registeredWorkspaceId: `workspace-${i}`, deviceId: device.id, ownerId: device.ownerId,
  projectId: 'project-one', label: `目录${i}－` + '需求文档原型及前后端代码'.repeat(10),
  workspaceBindingRevision: 1, runtimeId: 'codex', status: i === 29 ? 'revoked' : 'active',
  createdAt: device.createdAt, updatedAt: device.createdAt,
}));

describe('客户电脑目录的原生滚动与隔离', () => {
  it('长目录和状态完整保留，窄面板内实际滚动到最后一项且不撑宽页面', async () => {
    await using screen = await render(
      <div style={{ width: 390, height: 360 }}>
        <CustomerDeviceDetailsPanel device={device} workspaces={workspaces}
          projects={[{ id: 'project-one', name: 'VeryLongProjectName'.repeat(10) }]} />
      </div>,
    );
    const viewport = screen.container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    const rows = [...screen.container.querySelectorAll<HTMLElement>('[data-customer-workspace-row]')];
    expect(rows).toHaveLength(30);
    expect(rows.filter(row => row.textContent?.includes('已登记'))).toHaveLength(29);
    expect(rows.filter(row => row.textContent?.includes('已撤销'))).toHaveLength(1);
    await expect.poll(() => viewport.scrollHeight - viewport.clientHeight).toBeGreaterThan(100);
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
    for(const row of rows) expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(viewport.getBoundingClientRect().right + 1);
    await act(() => { viewport.scrollTop = viewport.scrollHeight; });
    await expect.element(screen.getByText(workspaces[29]!.label, { exact: true })).toBeVisible();
    expect(screen.getByText(workspaces[0]!.label, { exact: true }).element().getAttribute('title')).toBe(workspaces[0]!.label);
    for(const value of [device.label, device.platform, device.connectorVersion])
      expect(screen.container.textContent).toContain(value);
  });

  it('详情刷新后清理原目录，不展示另一台电脑的目录', async () => {
    await using screen = await render(<div style={{ width: 390, height: 360 }}><CustomerDeviceDetailsPanel device={device} workspaces={workspaces} projects={[]} /></div>);
    expect(screen.container.querySelectorAll('[data-customer-workspace-row]')).toHaveLength(30);
    await screen.rerender(<div style={{ width: 390, height: 360 }}><CustomerDeviceDetailsPanel device={device}
      workspaces={[{ ...workspaces[0]!, deviceId: 'other-device', label: '另一台电脑的目录' }]} projects={[]} /></div>);
    expect(screen.container.querySelectorAll('[data-customer-workspace-row]')).toHaveLength(0);
    await expect.element(screen.getByText('另一台电脑的目录')).not.toBeInTheDocument();
    await expect.element(screen.getByText('尚未登记工作区，请在本机运行连接程序的 register 命令。')).toBeVisible();
  });
});
