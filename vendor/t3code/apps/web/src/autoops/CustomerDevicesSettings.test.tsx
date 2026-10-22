import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { CustomerDeviceDetailsPanel } from "./CustomerDevicesSettings";
import type { CustomerDevice, CustomerWorkspace } from "./customerAgents";

const device: CustomerDevice = {
  id: "device-one",
  ownerId: "owner-one",
  label: "LongDeviceName".repeat(11),
  platform: "P".repeat(80),
  connectorVersion: "V".repeat(80),
  status: "active",
  online: false,
  connectionEpoch: 0,
  createdAt: "2026-10-23T00:00:00Z",
};
const workspaces: CustomerWorkspace[] = Array.from({ length: 30 }, (_, i) => ({
  registeredWorkspaceId: `workspace-${i}`,
  deviceId: device.id,
  ownerId: device.ownerId,
  projectId: "project-one",
  label: `目录${i}－` + "需求文档原型及前后端代码".repeat(10),
  workspaceBindingRevision: 1,
  runtimeId: "codex",
  status: i === 29 ? "revoked" : "active",
  createdAt: device.createdAt,
  updatedAt: device.createdAt,
}));

describe("customer device detail overflow boundary", () => {
  it("uses native viewport-sized scroll content instead of a min-content table, preserving all long rows and statuses", () => {
    const html = renderToStaticMarkup(
      <CustomerDeviceDetailsPanel
        device={device}
        workspaces={workspaces}
        projects={[{ id: "project-one", name: "VeryLongProjectName".repeat(10) }]}
      />,
    );
    expect(html).not.toContain("display:table");
    expect(html).toContain('data-slot="scroll-area-content"');
    const contentStyle = html.match(/data-slot="scroll-area-content"[^>]*style="([^"]+)"/)?.[1];
    expect(new Set(contentStyle?.split(";"))).toEqual(
      new Set(["display:block", "width:100%", "min-width:0"]),
    );
    expect(html.match(/data-customer-workspace-row/g)).toHaveLength(30);
    expect(html.match(/已登记<\/span>/g)).toHaveLength(29);
    expect(html.match(/已撤销<\/span>/g)).toHaveLength(1);
    expect(html).toContain(`title="${workspaces[0]!.label}"`);
    expect(html).toContain(device.platform);
    expect(html).toContain(device.connectorVersion);
    expect(html).toContain(device.label);
  });
  it("does not include another device's workspace when detail content is refreshed", () => {
    const html = renderToStaticMarkup(
      <CustomerDeviceDetailsPanel
        device={device}
        workspaces={[{ ...workspaces[0]!, deviceId: "other-device", label: "另一台电脑的目录" }]}
        projects={[]}
      />,
    );
    expect(html).not.toContain("另一台电脑的目录");
    expect(html).toContain("尚未登记工作区");
  });
});
