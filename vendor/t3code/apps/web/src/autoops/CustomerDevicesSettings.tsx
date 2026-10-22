import { useCallback, useEffect, useRef, useState } from "react";
import {
  CopyIcon,
  DownloadIcon,
  LaptopIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
} from "lucide-react";
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
import { SidebarInset } from "~/components/ui/sidebar";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "~/components/ui/empty";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { autoOpsAreaAvailable } from "./projectNavigation.logic";
import { toastManager } from "~/components/ui/toast";
import {
  customerRequest,
  loadCustomerWorkspaces,
  type CustomerDevice,
  type CustomerWorkspace,
} from "./customerAgents";
import { readAutoOpsHost } from "./hostConfig";
import { downloadMedia } from "~/components/media/mediaContent";

/** Owner-global devices use the same shell as skills and workspaces. Project
 * navigation never changes account operations or the device list's scope. */
export function AutoOpsCustomerDevicesPage() {
  const host = readAutoOpsHost();
  return (
    <SidebarInset className="h-dvh min-h-0 min-w-0 overflow-hidden" data-customer-devices>
      <h1 className="sr-only">我的电脑</h1>
      {autoOpsAreaAvailable("devices", host) && host ? (
        <CustomerDevicesContent key={host.principal.id} />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>客户设备接入未启用</EmptyTitle>
            <EmptyDescription>
              当前不能连接电脑或发起客户执行；已有对话仍可按原权限查看。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </SidebarInset>
  );
}

function CustomerDevicesContent() {
  const host = readAutoOpsHost()!;
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
  const revokeTrigger = useRef<HTMLElement>(null);
  const revokeDeviceId = useRef<string | null>(null);
  const detailButtons = useRef(new Map<string, HTMLButtonElement>());
  const deviceActionButtons = useRef(new Map<string, HTMLButtonElement>());
  const reloadRevision = useRef(0);
  const reload = useCallback(async () => {
    const revision = ++reloadRevision.current;
    try {
      const [result, registered] = await Promise.all([
        customerRequest<{ devices: CustomerDevice[] }>("devices"),
        loadCustomerWorkspaces(),
      ]);
      if (revision !== reloadRevision.current) return;
      setDevices(result.devices);
      setWorkspaces(registered.workspaces);
      setError(null);
    } catch (cause) {
      if (revision !== reloadRevision.current) return;
      setError(cause instanceof Error ? cause.message : "无法读取设备");
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    const timer = window.setInterval(refreshVisible, 15_000);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    return () => {
      reloadRevision.current++;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [reload]);
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && Date.parse(pairing.expiresAt) > Date.now())
        void reload();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [pairing, reload]);
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
      <div
        className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2"
        aria-label="电脑管理工具栏"
      >
        <p className="min-w-0 text-xs text-muted-foreground">个人账号 · 所有项目的已登记电脑</p>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reload()}>
            <RefreshCwIcon className="size-3.5" />
            刷新
          </Button>
          <Button
            ref={pairTrigger}
            variant="outline"
            size="sm"
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
      </div>
      {error ? (
        <p
          className="shrink-0 border-b border-border/60 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
        <div className="flex min-h-full min-w-0 flex-col">
          {loading ? (
            <div
              role="status"
              className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
            >
              <Spinner size="sm" />
              正在读取设备…
            </div>
          ) : devices.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{error ? "无法读取设备" : "还没有连接电脑"}</EmptyTitle>
                <EmptyDescription>
                  先在自己的电脑安装并登录
                  Codex，再通过一次性配对码连接并登记目录。代码和技能留在本机。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y divide-border/60" aria-label="我的电脑">
              {devices.map((device) => (
                <li key={device.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                  <LaptopIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm" title={device.label}>
                      {device.label}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {device.status === "revoked"
                        ? "凭据已吊销"
                        : device.status === "disabled"
                          ? "已停用"
                          : device.online
                            ? "在线"
                            : "离线"}{" "}
                      ·{" "}
                      {
                        workspaces.filter(
                          (entry) => entry.deviceId === device.id && entry.status === "active",
                        ).length
                      }{" "}
                      个工作区
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
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
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`管理 ${device.label}`}
                              disabled={busy}
                              ref={(element) => {
                                if (element) deviceActionButtons.current.set(device.id, element);
                                else deviceActionButtons.current.delete(device.id);
                              }}
                            />
                          }
                        >
                          <MoreHorizontalIcon />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem
                            onClick={() =>
                              void action(() =>
                                customerRequest(`devices/${device.id}/status`, {
                                  status: device.status === "active" ? "disabled" : "active",
                                }),
                              )
                            }
                          >
                            {device.status === "active" ? "停用" : "启用"}
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            variant="destructive"
                            onClick={() => {
                              revokeTrigger.current =
                                deviceActionButtons.current.get(device.id) ?? null;
                              revokeDeviceId.current = device.id;
                              setRevoke(device);
                            }}
                          >
                            断开绑定
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>
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
              。已连接的设备会自动出现在电脑列表。
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
            <DialogTitle className="truncate pr-6 leading-6" title={details?.label}>
              {details?.label}
            </DialogTitle>
            <DialogDescription>
              只显示已在本机登记的工作区；修改目录或权限请回到连接程序。
            </DialogDescription>
          </DialogHeader>
          {details ? (
            <CustomerDeviceDetailsPanel
              device={details}
              workspaces={workspaces}
              projects={host.projects}
            />
          ) : null}
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
            if (
              revokeTrigger.current?.isConnected &&
              revokeTrigger.current.getAttribute("aria-disabled") !== "true"
            )
              return revokeTrigger.current;
            return detailButtons.current.get(revokeDeviceId.current ?? "") ?? pairTrigger.current;
          }}
        >
          <DialogHeader>
            <DialogTitle
              className="truncate pr-6 leading-6"
              title={`断开 ${revoke?.label ?? ""} 的绑定？`}
            >
              断开 {revoke?.label} 的绑定？
            </DialogTitle>
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

/** Vertical metadata must use viewport sizing: the native compatibility
 * ScrollArea's implicit table otherwise expands to a truncated child's min-content. */
export function CustomerDeviceDetailsPanel({
  device,
  workspaces,
  projects,
}: {
  device: CustomerDevice;
  workspaces: readonly CustomerWorkspace[];
  projects: readonly { id: string; name: string }[];
}) {
  const registered = workspaces.filter((entry) => entry.deviceId === device.id);
  return (
    <ScrollArea contentSizing="viewport" scrollFade className="min-w-0 max-w-full">
      <div data-slot="dialog-panel" className="w-full min-w-0 max-w-full space-y-3 p-6 pt-1">
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">电脑</dt>
          <dd className="min-w-0 wrap-anywhere select-text">{device.label}</dd>
          <dt className="text-muted-foreground">系统</dt>
          <dd className="min-w-0 wrap-anywhere select-text">{device.platform ?? "未上报"}</dd>
          <dt className="text-muted-foreground">连接程序</dt>
          <dd className="min-w-0 wrap-anywhere select-text">
            {device.connectorVersion ?? "未上报"}
          </dd>
        </dl>
        <div className="w-full min-w-0 max-w-full divide-y border-t" aria-label="已登记工作区">
          {registered.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              尚未登记工作区，请在本机运行连接程序的 register 命令。
            </p>
          ) : null}
          {registered.map((entry) => {
            const projectName =
              projects.find((project) => project.id === entry.projectId)?.name ?? entry.projectId;
            return (
              <div
                key={entry.registeredWorkspaceId}
                className="flex w-full min-w-0 max-w-full items-center justify-between gap-3 py-3 text-sm"
                data-customer-workspace-row
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate" title={entry.label}>
                    {entry.label}
                  </p>
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={`${projectName} · ${entry.runtimeId}`}
                  >
                    {projectName} · {entry.runtimeId}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {entry.status === "active" ? "已登记" : "已撤销"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}
