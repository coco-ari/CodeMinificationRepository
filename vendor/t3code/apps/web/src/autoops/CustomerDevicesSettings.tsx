import { useEffect, useRef, useState } from "react";
import { CopyIcon, DownloadIcon, LaptopIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { toastManager } from "~/components/ui/toast";
import {
  customerRequest,
  loadCustomerWorkspaces,
  type CustomerDevice,
  type CustomerWorkspace,
} from "./customerAgents";
import { readAutoOpsHost } from "./hostConfig";
import { downloadMedia } from "~/components/media/mediaContent";

export function CustomerDevicesSettings() {
  const host = readAutoOpsHost();
  const [devices, setDevices] = useState<CustomerDevice[]>([]);
  const [workspaces, setWorkspaces] = useState<CustomerWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{
    pairingCode: string;
    expiresAt: string;
    previousDeviceIds: string[];
  } | null>(null);
  const [details, setDetails] = useState<CustomerDevice | null>(null);
  const [revoke, setRevoke] = useState<CustomerDevice | null>(null);
  const pairTrigger = useRef<HTMLButtonElement>(null);
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const revokeTrigger = useRef<HTMLButtonElement>(null);
  const revokeDeviceId = useRef<string | null>(null);
  const detailButtons = useRef(new Map<string, HTMLButtonElement>());
  const reload = async () => {
    try {
      const [result, registered] = await Promise.all([
        customerRequest<{ devices: CustomerDevice[] }>("devices"),
        loadCustomerWorkspaces(),
      ]);
      setDevices(result.devices);
      setWorkspaces(registered.workspaces);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取设备");
    }
    setLoading(false);
  };
  useEffect(() => {
    if (host?.customerAgentsEnabled) void reload();
  }, [host]);
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && Date.parse(pairing.expiresAt) > Date.now())
        void reload();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [pairing]);
  if (!host?.customerAgentsEnabled) return null;
  const action = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      await reload();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "设备操作失败";
      setError(message);
      toastManager.add({ type: "error", title: "操作未完成", description: message });
    }
    setBusy(false);
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toastManager.add({ type: "success", title: "已复制" });
    } catch {
      toastManager.add({ type: "error", title: "复制失败，请手动选择文本" });
    }
  };
  return (
    <>
      <SettingsSection
        id="autoops-customer-devices"
        title="我的电脑"
        headerAction={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => void reload()}>
              <RefreshCwIcon className="size-3" />
              刷新
            </Button>
            <Button
              ref={pairTrigger}
              variant="outline"
              size="xs"
              aria-disabled={busy}
              onClick={() => {
                if (busy) return;
                void action(async () => {
                  const issued = await customerRequest<{ pairingCode: string; expiresAt: string }>(
                    "pairings",
                    {},
                  );
                  setPairing({ ...issued, previousDeviceIds: devices.map((device) => device.id) });
                });
              }}
            >
              连接电脑
            </Button>
          </div>
        }
      >
        <SettingsRow
          title="本机工作区"
          description="在自己的电脑连接并登记目录，再从新对话选择。代码与技能留在本机，网页使用同一套对话流程。"
        />
        {loading ? (
          <SettingsRow title="正在读取设备…" />
        ) : devices.length === 0 ? (
          <SettingsRow
            title="还没有连接电脑"
            description="先在本机安装并登录 Codex，再通过一次性配对码连接。"
          />
        ) : null}
        {devices.map((device) => (
          <SettingsRow
            key={device.id}
            title={
              <span className="inline-flex min-w-0 items-center gap-2">
                <LaptopIcon className="size-4 shrink-0" />
                <span className="truncate">{device.label}</span>
              </span>
            }
            description={`${device.status === "revoked" ? "凭据已吊销" : device.status === "disabled" ? "已停用" : device.online ? "在线" : "离线"} · ${workspaces.filter((entry) => entry.deviceId === device.id && entry.status === "active").length} 个工作区`}
            control={
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  ref={(element) => {
                    if (element) detailButtons.current.set(device.id, element);
                    else detailButtons.current.delete(device.id);
                  }}
                  onClick={(event) => {
                    detailsTrigger.current = event.currentTarget;
                    setDetails(device);
                  }}
                >
                  详情
                </Button>
                {device.status !== "revoked" ? (
                  <>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          customerRequest(`devices/${device.id}/status`, {
                            status: device.status === "active" ? "disabled" : "active",
                          }),
                        )
                      }
                    >
                      {device.status === "active" ? "停用" : "启用"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={(event) => {
                        revokeTrigger.current = event.currentTarget;
                        revokeDeviceId.current = device.id;
                        setRevoke(device);
                      }}
                    >
                      断开绑定
                    </Button>
                  </>
                ) : null}
              </div>
            }
          />
        ))}
        {error ? (
          <p className="px-4 py-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </SettingsSection>
      <Dialog
        open={pairing !== null}
        onOpenChange={(open) => {
          if (!open) setPairing(null);
        }}
      >
        <DialogPopup finalFocus={pairTrigger}>
          <DialogHeader>
            <DialogTitle>连接我的电脑</DialogTitle>
            <DialogDescription>
              配对码仅能使用一次，十分钟内有效；请在自己的电脑输入。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium">中心服务地址</p>
              <div className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 break-all text-xs">{window.location.origin}</code>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="复制中心服务地址"
                  onClick={() => void copy(window.location.origin)}
                >
                  <CopyIcon />
                </Button>
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">一次性配对码</p>
              <div className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 select-all break-all text-xs">
                  {pairing?.pairingCode}
                </code>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="复制配对码"
                  onClick={() => {
                    if (pairing) void copy(pairing.pairingCode);
                  }}
                >
                  <CopyIcon />
                </Button>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  try {
                    await downloadMedia(
                      `${host.gatewayBasePath}/autoops/customer/download`,
                      "autoops-customer-agent.zip",
                    );
                  } catch (cause) {
                    throw new Error(
                      cause instanceof Error && cause.message.includes("503")
                        ? "连接程序尚未发布，请联系管理员。"
                        : "下载失败，请检查登录和网络后重试。",
                      { cause },
                    );
                  }
                })
              }
            >
              <DownloadIcon />
              下载连接程序
            </Button>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>
                在已安装 Node.js 24.10+ 且已登录 Codex 的电脑中，先解压下载的
                ZIP，再进入解压目录运行连接程序，按提示输入配对码。
                <code className="mt-2 block break-all text-xs">
                  node autoops-customer-agent.mjs connect --url {window.location.origin}
                </code>
              </li>
              <li>
                在本机选择目录并登记到项目；中心只接收名称与登记身份。
                <code className="mt-2 block break-all text-xs">
                  node autoops-customer-agent.mjs register
                </code>
              </li>
              <li>
                运行连接程序并保持在线，新建对话后选择此设备的工作区。
                <code className="mt-2 block text-xs">node autoops-customer-agent.mjs run</code>
              </li>
            </ol>
            {pairing && devices.some((device) => !pairing.previousDeviceIds.includes(device.id)) ? (
              <p className="text-sm" role="status">
                电脑已连接。请在本机登记工作区并启动连接程序。
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              有效期至 {pairing ? new Date(pairing.expiresAt).toLocaleTimeString("zh-CN") : ""}
              。已连接的设备会自动出现在下方列表。
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => setPairing(null)}>完成</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={details !== null}
        onOpenChange={(open) => {
          if (!open) setDetails(null);
        }}
      >
        <DialogPopup
          finalFocus={() =>
            detailsTrigger.current?.isConnected ? detailsTrigger.current : pairTrigger.current
          }
        >
          <DialogHeader>
            <DialogTitle>{details?.label}</DialogTitle>
            <DialogDescription>
              只显示已在本机登记的工作区；修改目录或权限请回到连接程序。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">系统</dt>
              <dd>{details?.platform ?? "未上报"}</dd>
              <dt className="text-muted-foreground">连接程序</dt>
              <dd>{details?.connectorVersion ?? "未上报"}</dd>
            </dl>
            <div className="divide-y border-t">
              {workspaces
                .filter((entry) => entry.deviceId === details?.id)
                .map((entry) => (
                  <div
                    key={entry.registeredWorkspaceId}
                    className="flex min-w-0 items-center justify-between gap-3 py-3 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate">{entry.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {host.projects.find((project) => project.id === entry.projectId)?.name ??
                          entry.projectId}{" "}
                        · {entry.runtimeId}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {entry.status === "active" ? "已登记" : "已撤销"}
                    </span>
                  </div>
                ))}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetails(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={revoke !== null}
        onOpenChange={(open) => {
          if (!open) setRevoke(null);
        }}
      >
        <DialogPopup
          finalFocus={() => {
            if (revokeTrigger.current?.isConnected && !revokeTrigger.current.disabled)
              return revokeTrigger.current;
            return detailButtons.current.get(revokeDeviceId.current ?? "") ?? pairTrigger.current;
          }}
        >
          <DialogHeader>
            <DialogTitle>断开 {revoke?.label} 的绑定？</DialogTitle>
            <DialogDescription>
              设备凭据将失效，已有对话仍可查看。正在执行的任务请先在本机核实或停止；再次接入需要重新配对。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoke(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  if (revoke) await customerRequest(`devices/${revoke.id}/revoke`, {});
                  setRevoke(null);
                })
              }
            >
              断开绑定
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
