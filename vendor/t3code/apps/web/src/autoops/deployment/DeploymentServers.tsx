import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  CopyIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Alert, AlertAction, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { randomUUID } from "~/lib/utils";
import { AutoOpsRequestError, isAutoOpsAccessError } from "../apiClient";
import { readAutoOpsHost } from "../hostSnapshot";
import { Choice } from "./DeploymentControls";
import {
  loadDeploymentServers,
  loadDeploymentNodeReceipt,
  loadGlobalDeploymentNodeReceipt,
  loadGlobalDeploymentNodes,
  matchesDeploymentNodeReceipt,
  mutateGlobalDeploymentNode,
  type DeploymentGlobalNodeCatalog,
  mutateDeploymentServer,
  type DeploymentServer,
  type DeploymentServerManagement,
  type DeploymentServerMutation,
  type DeploymentServerRegistration,
} from "./deploymentServersApi";

type Props = (
  { scope?: "project"; projectId: string; environmentId: string } | { scope: "platform" }
) & {
  embedded?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: ComponentProps<typeof DialogPopup>["finalFocus"];
  onAccessDenied: (cause: unknown) => void;
  onChanged: () => void;
};
type View =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "bind" }
  | { kind: "projects"; server: DeploymentServer }
  | {
      kind: "access";
      server: DeploymentServer;
      projectId: string;
      projectName: string;
      allowed: boolean;
      expectedRevision: number;
    }
  | { kind: "details"; server: DeploymentServer }
  | { kind: "unbind"; server: DeploymentServer }
  | { kind: "revoke"; server: DeploymentServer }
  | { kind: "delete"; server: DeploymentServer };

const storageLabels = {
  unsupported: "暂不支持存储管理",
  waiting: "等待节点连接",
  pending: "等待应用",
  applying: "正在应用",
  applied: "已应用",
  failed: "应用失败",
};
const operationLabels = {
  create: "接入节点",
  bind: "绑定节点",
  unbind: "解绑节点",
  revoke: "撤销节点",
  delete: "删除节点",
  storage: "保存存储设置",
  access: "保存项目准入",
};
const time = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("zh-CN")
    : "暂无观测";
const bytes = (value: number | null | undefined) =>
  value == null
    ? "—"
    : `${(value / 1024 ** 3).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} GiB`;
const usage = (value?: { used: number | null; total: number | null } | null) =>
  value ? `${bytes(value.used)} / ${bytes(value.total)}` : "—";
const status = (server: DeploymentServer) =>
  server.projectAllowed === false
    ? "准入已撤回"
    : server.revoked
      ? "已撤销"
      : server.online
        ? "在线"
        : "离线";
const message = (cause: unknown) => (cause instanceof Error ? cause.message : "操作失败，请重试。");
const isRegistration = (value: unknown): value is DeploymentServerRegistration => {
  if (!value || typeof value !== "object") return false;
  return (
    "server" in value &&
    "registrationToken" in value &&
    (value.registrationToken === null || typeof value.registrationToken === "string") &&
    "expiresAt" in value &&
    (value.expiresAt === null || typeof value.expiresAt === "string")
  );
};

function Field({
  label,
  children,
  inline = false,
}: {
  label: string;
  children: (id: string) => ReactNode;
  inline?: boolean;
}) {
  const id = useId();
  if (inline)
    return (
      <SettingsRow
        title={<Label htmlFor={id}>{label}</Label>}
        control={<div className="w-24">{children(id)}</div>}
      />
    );
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
    </div>
  );
}

function NodeImpact({
  catalog,
  serverId,
}: {
  catalog: DeploymentGlobalNodeCatalog;
  serverId: string;
}) {
  const projects = catalog.projects.filter(
    (project) =>
      catalog.projectAccess.some(
        (entry) => entry.projectId === project.id && entry.serverIds.includes(serverId),
      ) ||
      catalog.bindings.some(
        (entry) => entry.projectId === project.id && entry.serverId === serverId,
      ),
  );
  return (
    <SettingsSection title="影响范围">
      {projects.map((project) => {
        const bindings = catalog.bindings.filter(
          (entry) => entry.projectId === project.id && entry.serverId === serverId,
        );
        return (
          <SettingsRow
            key={project.id}
            title={project.name}
            description={
              bindings.length
                ? `已绑定：${bindings
                    .map(
                      (binding) =>
                        project.environments.find(
                          (environment) => environment.id === binding.environmentId,
                        )?.name ?? binding.environmentId,
                    )
                    .join("、")}`
                : "尚未绑定环境"
            }
          />
        );
      })}
      {!projects.length ? <SettingsRow title="未分配项目" /> : null}
    </SettingsSection>
  );
}

function readPending(key: string): DeploymentServerMutation | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? "null",
    ) as DeploymentServerMutation | null;
    return value &&
      Object.hasOwn(operationLabels, value.kind) &&
      typeof value.input?.requestId === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

export function DeploymentServers(props: Props) {
  const identity = readAutoOpsHost()?.principal.id ?? "";
  return (
    <DeploymentServersScope
      key={`${identity}:${props.scope === "platform" ? "platform" : `${props.projectId}:${props.environmentId}`}:${props.open}`}
      {...props}
      identity={identity}
    />
  );
}

function DeploymentServersScope(props: Props & { identity: string }) {
  const { open, onOpenChange, finalFocus, onAccessDenied, onChanged, identity } = props;
  const platform = props.scope === "platform";
  const projectId = props.scope === "platform" ? undefined : props.projectId;
  const environmentId = props.scope === "platform" ? undefined : props.environmentId;
  const pendingKey = `autoops:deployment-servers:${identity}:${platform ? "platform" : `${projectId}:${environmentId}`}`;
  const [data, setData] = useState<DeploymentServerManagement | null>(null);
  const [catalog, setCatalog] = useState<DeploymentGlobalNodeCatalog | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [pending, setPending] = useState(() => readPending(pendingKey));
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registration, setRegistration] = useState<DeploymentServerRegistration | null>(null);
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [retainedVersions, setRetainedVersions] = useState("2");
  const [buildCacheGiB, setBuildCacheGiB] = useState("2");
  const [refresh, setRefresh] = useState(0);
  const active = useRef(true);
  const submitting = useRef(false);
  const mutationController = useRef<AbortController | null>(null);
  const changed = useStableCallback(onChanged);
  const accessDenied = useStableCallback((cause: unknown) => {
    active.current = false;
    setData(null);
    setCatalog(null);
    setView({ kind: "list" });
    setName("");
    setServerId("");
    setRegistration(null);
    setPending(null);
    setError(null);
    mutationController.current?.abort();
    // 原操作仍由原账号/范围保存；恢复授权后只能 GET 核对，不重新提交。
    onAccessDenied(cause);
    onOpenChange(false);
  });

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      mutationController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!open || !active.current) return;
    const controller = new AbortController();
    setLoading(true);
    const load = platform
      ? loadGlobalDeploymentNodes(controller.signal).then((result) => {
          if (!controller.signal.aborted && active.current) {
            setCatalog(result);
            setData({
              servers: result.servers,
              availableServers: [],
              canAdmin: true,
              canBind: false,
            });
          }
        })
      : loadDeploymentServers(projectId!, environmentId!, controller.signal).then((result) => {
          if (!controller.signal.aborted && active.current) setData({ ...result, canAdmin: false });
        });
    void load
      .catch((cause: unknown) => {
        if (controller.signal.aborted || !active.current) return;
        if (isAutoOpsAccessError(cause)) accessDenied(cause);
        else setError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted && active.current) setLoading(false);
      });
    return () => controller.abort();
  }, [platform, projectId, environmentId, open, refresh, accessDenied]);

  function go(next: View) {
    setView(next);
    setError(null);
    setRegistration(null);
    if (next.kind === "details") {
      setRetainedVersions(String(next.server.storagePolicy?.retainedVersions ?? 2));
      setBuildCacheGiB(String(next.server.storagePolicy?.buildCacheGiB ?? 2));
    }
  }

  async function submit(input: DeploymentServerMutation) {
    if (submitting.current || !active.current || pending) return;
    const operation = input;
    try {
      sessionStorage.setItem(pendingKey, JSON.stringify(operation));
    } catch {
      setError("浏览器无法保存操作记录，请允许站点存储后重试。");
      return;
    }
    setPending(operation);
    setError(null);
    setBusy(true);
    submitting.current = true;
    const controller = new AbortController();
    mutationController.current = controller;
    try {
      const result = platform
        ? await mutateGlobalDeploymentNode(operation, controller.signal)
        : await mutateDeploymentServer(projectId!, operation, controller.signal);
      if (!active.current || controller.signal.aborted) return;
      if ("available" in result && result.available === false) {
        accessDenied(
          new AutoOpsRequestError("操作已保存，当前管理权限已撤销。", "ACCESS_DENIED", 403),
        );
        return;
      }
      setPending(null);
      try {
        sessionStorage.removeItem(pendingKey);
      } catch {
        /* 存储清理失败时仍只按原标识读取收据。 */
      }
      setView({ kind: "list" });
      if (operation.kind === "create" && isRegistration(result)) setRegistration(result);
      setRefresh((value) => value + 1);
      changed();
    } catch (cause) {
      if (!active.current || controller.signal.aborted) return;
      if (isAutoOpsAccessError(cause)) {
        if (cause instanceof AutoOpsRequestError && !cause.uncertain) {
          try {
            sessionStorage.removeItem(pendingKey);
          } catch {
            /* 明确拒绝未接受本次操作。 */
          }
        }
        accessDenied(cause);
        return;
      }
      if (cause instanceof AutoOpsRequestError && !cause.uncertain) {
        setPending(null);
        try {
          sessionStorage.removeItem(pendingKey);
        } catch {
          /* 明确拒绝不会生成新业务操作。 */
        }
      }
      setError(
        cause instanceof AutoOpsRequestError && cause.uncertain
          ? "暂时无法确认操作结果，请核对原收据。"
          : message(cause),
      );
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function recover() {
    if (!pending || submitting.current || !active.current) return;
    const operation = pending;
    const controller = new AbortController();
    mutationController.current = controller;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      // 未知请求只读取原收据；目录变化、空收据或网络失败均不构成重新写入的依据。
      const receipt = platform
        ? await loadGlobalDeploymentNodeReceipt(operation.input.requestId, controller.signal)
        : await loadDeploymentNodeReceipt(
            projectId!,
            environmentId!,
            operation.input.requestId,
            controller.signal,
          );
      if (!active.current || controller.signal.aborted) return;
      if (!receipt) {
        setError("尚未找到可核对的原收据，操作仍待确认。请稍后再次核对。");
        return;
      }
      if (!matchesDeploymentNodeReceipt(operation, receipt, { projectId, environmentId })) {
        throw new Error("返回的原收据与当前操作范围不符，操作仍待确认。");
      }
      if (operation.kind === "create") {
        if (!("id" in receipt.result) || typeof receipt.result.name !== "string")
          throw new Error("原节点事实不可核对，操作仍待确认。");
        setRegistration({
          server: receipt.result,
          registrationToken: null,
          expiresAt: null,
          repeated: true,
        });
      }
      setPending(null);
      try {
        sessionStorage.removeItem(pendingKey);
      } catch {
        /* 重开仍只 GET 原收据。 */
      }
      setView({ kind: "list" });
      setRefresh((value) => value + 1);
      changed();
    } catch (cause) {
      if (!active.current || controller.signal.aborted) return;
      if (isAutoOpsAccessError(cause)) accessDenied(cause);
      else setError(message(cause));
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }

  const disabled = busy || !!pending;
  const selected = "server" in view ? view.server : null;
  const available =
    data?.availableServers.filter(
      (server) =>
        !server.revoked &&
        !data.servers.some(
          (bound) => bound.id === server.id && bound.environmentId === environmentId,
        ),
    ) ?? [];
  const policyValid =
    Number.isInteger(Number(retainedVersions)) &&
    Number(retainedVersions) >= 2 &&
    Number(retainedVersions) <= 20 &&
    Number.isInteger(Number(buildCacheGiB)) &&
    Number(buildCacheGiB) >= 1 &&
    Number(buildCacheGiB) <= 20;
  const title = registration
    ? "接入节点"
    : selected
      ? selected.name
      : view.kind === "create"
        ? "接入节点"
        : view.kind === "bind"
          ? "绑定已有节点"
          : platform
            ? "平台节点"
            : "部署节点";
  const back = () => go({ kind: "list" });
  const confirmDisabled =
    disabled ||
    view.kind === "list" ||
    view.kind === "projects" ||
    (view.kind === "create" && !name.trim()) ||
    (view.kind === "bind" && !serverId) ||
    (view.kind === "details" &&
      (!policyValid || !data?.canAdmin || !view.server.storagePolicy || view.server.revoked));
  const confirm = () => {
    if (confirmDisabled) return;
    const requestId = randomUUID();
    if (view.kind === "create")
      void submit({ kind: "create", input: { name: name.trim(), requestId } });
    else if (view.kind === "bind" && environmentId)
      void submit({ kind: "bind", serverId, input: { environmentId, requestId } });
    else if (view.kind === "access")
      void submit({
        kind: "access",
        serverId: view.server.id,
        projectId: view.projectId,
        input: { allowed: view.allowed, expectedRevision: view.expectedRevision, requestId },
      });
    else if (view.kind === "delete")
      void submit({ kind: "delete", serverId: view.server.id, input: { requestId } });
    else if (view.kind === "revoke")
      void submit({
        kind: view.kind,
        serverId: view.server.id,
        input: { requestId },
      });
    else if (view.kind === "unbind" && environmentId)
      void submit({
        kind: "unbind",
        serverId: view.server.id,
        input: { environmentId, requestId },
      });
    else if (view.kind === "details" && view.server.storagePolicy)
      void submit({
        kind: "storage",
        serverId: view.server.id,
        input: {
          expectedRevision: view.server.storagePolicy.revision,
          retainedVersions: Number(retainedVersions),
          buildCacheGiB: Number(buildCacheGiB),
          requestId,
        },
      });
  };

  const Header = props.embedded ? PageHeader : DialogHeader;
  const Title = props.embedded ? PageTitle : DialogTitle;
  const Panel = props.embedded ? PagePanel : DialogPanel;
  const Footer = props.embedded ? PageFooter : DialogFooter;
  const content = (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        confirm();
      }}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
        )
          event.preventDefault();
      }}
    >
      <Header>
        <div className="flex min-w-0 items-center gap-2 pr-6">
          {view.kind !== "list" || registration ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="返回节点列表"
              onClick={back}
              disabled={busy}
            >
              <ArrowLeftIcon />
            </Button>
          ) : null}
          <Title className="min-w-0 break-words">{title}</Title>
        </div>
      </Header>
      <Panel>
        {error || (pending && !busy) ? (
          <Alert variant="error">
            <AlertDescription>
              {error ?? `${operationLabels[pending!.kind]}尚未确认，请核对原收据。`}
            </AlertDescription>
            {pending ? (
              <AlertAction>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void recover()}>
                  {busy ? <Spinner size="sm" /> : null}核对结果
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        ) : null}
        {registration ? (
          <div className="space-y-4">
            <SettingsRow
              title={registration.server.name}
              description={
                registration.repeated
                  ? "节点已创建，口令仅提供一次。若未保存且尚未接入，请返回节点列表，撤销并删除后再接入新节点。"
                  : `在目标服务器执行安装命令，连接后即可部署。口令有效期至 ${time(registration.expiresAt)}。`
              }
            />
            {registration.installCommand ? (
              <>
                <pre
                  className="max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs"
                  aria-label="节点安装命令"
                >
                  {registration.installCommand}
                </pre>
                <Button
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(registration.installCommand!)
                      .catch(() => setError("复制失败，请手动选择安装命令复制。"));
                  }}
                >
                  <CopyIcon />
                  复制安装命令
                </Button>
              </>
            ) : registration.registrationToken ? (
              <Field label="接入口令">
                {(id) => <Input id={id} readOnly value={registration.registrationToken!} />}
              </Field>
            ) : null}
          </div>
        ) : view.kind === "list" ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {platform ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setName("");
                    go({ kind: "create" });
                  }}
                  disabled={disabled || !data}
                >
                  <PlusIcon />
                  接入节点
                </Button>
              ) : null}
              {!platform && data?.canBind ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled || !available.length}
                  onClick={() => {
                    setServerId(available[0]?.id ?? "");
                    go({ kind: "bind" });
                  }}
                >
                  <LinkIcon />
                  绑定已有节点
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto"
                aria-label="刷新节点"
                disabled={loading || busy}
                onClick={() => {
                  setError(null);
                  setRefresh((value) => value + 1);
                }}
              >
                <RefreshCwIcon />
              </Button>
            </div>
            {loading && !data ? (
              <div role="status" className="flex items-center gap-2 py-4 text-muted-foreground">
                <Spinner size="sm" />
                读取节点…
              </div>
            ) : data && !data.servers.length ? (
              <p className="py-6 text-center text-sm text-muted-foreground">暂无部署节点</p>
            ) : null}
            {data?.servers.length ? (
              <SettingsSection title="节点" hideTitle>
                {data.servers.map((server) => (
                  <SettingsRow
                    key={`${server.id}:${server.environmentId}`}
                    title={
                      <span className="flex min-w-0 items-center gap-2">
                        <ServerIcon className="size-4 shrink-0" />
                        <span className="break-all">{server.name}</span>
                      </span>
                    }
                    description={
                      server.projectAllowed === false ? (
                        "准入已撤回"
                      ) : (
                        <span className="block space-y-1">
                          <span className="block">
                            {status(server)} · {time(server.lastSeenAt)}
                          </span>
                          <span className="block">
                            CPU{" "}
                            {server.metrics?.cpuPercent == null
                              ? "—"
                              : `${server.metrics.cpuPercent.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`}{" "}
                            · 内存 {usage(server.metrics?.memory)} · 磁盘{" "}
                            {usage(server.metrics?.disk)} · RTT{" "}
                            {server.metrics?.centerRttMs == null
                              ? "—"
                              : `${server.metrics.centerRttMs} ms`}
                          </span>
                          <span className="block">
                            存储：{storageLabels[server.storageState ?? "unsupported"]}
                          </span>
                        </span>
                      )
                    }
                    control={
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`${server.name}的操作`}
                              disabled={busy}
                            />
                          }
                        >
                          <MoreHorizontalIcon />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem onClick={() => go({ kind: "details", server })}>
                            查看节点
                          </MenuItem>
                          {!platform && data.canBind ? (
                            <MenuItem
                              disabled={disabled}
                              onClick={() => go({ kind: "unbind", server })}
                            >
                              解绑节点
                            </MenuItem>
                          ) : null}
                          {data.canAdmin ? (
                            <>
                              <MenuItem
                                disabled={disabled || server.revoked}
                                onClick={() => go({ kind: "projects", server })}
                              >
                                项目准入
                              </MenuItem>
                              <MenuItem
                                disabled={disabled || server.revoked}
                                onClick={() => go({ kind: "revoke", server })}
                              >
                                撤销节点
                              </MenuItem>
                              <MenuItem
                                variant="destructive"
                                disabled={disabled}
                                onClick={() => go({ kind: "delete", server })}
                              >
                                删除节点
                              </MenuItem>
                            </>
                          ) : null}
                        </MenuPopup>
                      </Menu>
                    }
                  />
                ))}
              </SettingsSection>
            ) : null}
          </>
        ) : view.kind === "create" ? (
          <Field label="节点名称">
            {(id) => (
              <Input
                id={id}
                value={name}
                onValueChange={setName}
                required
                maxLength={80}
                disabled={disabled}
              />
            )}
          </Field>
        ) : view.kind === "bind" ? (
          <Choice
            label="已有节点"
            value={serverId}
            options={available.map((server) => ({
              id: server.id,
              name: `${server.name} · ${status(server)}`,
            }))}
            onChange={setServerId}
            disabled={disabled}
          />
        ) : view.kind === "projects" ? (
          <SettingsSection title="项目准入">
            {catalog?.projects.map((project) => {
              const access = catalog.projectAccess.find((item) => item.projectId === project.id);
              const allowed = access?.serverIds.includes(view.server.id) ?? false;
              return (
                <SettingsRow
                  key={project.id}
                  title={project.name}
                  description={allowed ? "已准入" : "未准入"}
                  control={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disabled}
                      aria-label={`${allowed ? "撤回" : "允许"}${project.name}使用节点`}
                      onClick={() =>
                        go({
                          kind: "access",
                          server: view.server,
                          projectId: project.id,
                          projectName: project.name,
                          allowed: !allowed,
                          expectedRevision: access?.revision ?? 1,
                        })
                      }
                    >
                      {allowed ? "撤回" : "允许"}
                    </Button>
                  }
                />
              );
            })}
            {!catalog?.projects.length ? <SettingsRow title="暂无项目" /> : null}
          </SettingsSection>
        ) : view.kind === "access" ? (
          <p className="break-words text-sm">
            {view.allowed
              ? `允许“${view.projectName}”使用“${view.server.name}”。项目管理员可将其绑定到环境。`
              : `撤回“${view.projectName}”使用“${view.server.name}”的准入。拒绝新部署与排队任务领取，已有任务结果仍按原收据核对。`}
          </p>
        ) : view.kind === "details" ? (
          <>
            <SettingsSection title="节点信息">
              <SettingsRow title="状态" description={status(view.server)} />
              <SettingsRow title="最近观测" description={time(view.server.lastSeenAt)} />
              <SettingsRow title="执行器版本" description={view.server.version ?? "未连接"} />
              <SettingsRow
                title="节点 ID"
                description={
                  <span className="select-text break-all font-mono">{view.server.id}</span>
                }
              />
            </SettingsSection>
            <SettingsSection title="存储设置">
              <SettingsRow
                title="应用状态"
                description={storageLabels[view.server.storageState ?? "unsupported"]}
              />
              {view.server.storagePolicy ? (
                <>
                  <Field label="保留成功版本数" inline>
                    {(id) => (
                      <Input
                        id={id}
                        type="number"
                        min={2}
                        max={20}
                        step={1}
                        value={retainedVersions}
                        onValueChange={setRetainedVersions}
                        disabled={disabled || !data?.canAdmin || view.server.revoked}
                      />
                    )}
                  </Field>
                  <Field label="构建缓存上限（GiB）" inline>
                    {(id) => (
                      <Input
                        id={id}
                        type="number"
                        min={1}
                        max={20}
                        step={1}
                        value={buildCacheGiB}
                        onValueChange={setBuildCacheGiB}
                        disabled={disabled || !data?.canAdmin || view.server.revoked}
                      />
                    )}
                  </Field>
                </>
              ) : null}
              {view.server.storageStatus ? (
                <>
                  <SettingsRow
                    title="最近检查"
                    description={time(view.server.storageStatus.checkedAt)}
                  />
                  <SettingsRow
                    title="构建缓存"
                    description={`${bytes(view.server.storageStatus.cache?.bytes)} / ${bytes(view.server.storageStatus.cache?.limitBytes)}`}
                  />
                </>
              ) : null}
            </SettingsSection>
          </>
        ) : (
          <>
            <p className="break-words text-sm">
              {view.kind === "unbind"
                ? `将“${view.server.name}”从当前项目环境解绑。已有部署目标引用该节点时不能解绑。`
                : view.kind === "revoke"
                  ? `撤销“${view.server.name}”后，该执行器将无法连接，其他项目使用此节点的部署也会受到影响。`
                  : `永久删除“${view.server.name}”的接入记录。关联部署位置、任务、日志和版本记录将一并删除；远端程序和文件不会被卸载。`}
            </p>
            {catalog && (view.kind === "revoke" || view.kind === "delete") ? (
              <NodeImpact catalog={catalog} serverId={view.server.id} />
            ) : null}
          </>
        )}
      </Panel>
      {view.kind !== "list" && !registration ? (
        <Footer>
          <Button variant="outline" disabled={busy} onClick={back}>
            返回
          </Button>
          {(view.kind !== "details" && view.kind !== "projects") ||
          (view.kind === "details" &&
            data?.canAdmin &&
            view.server.storagePolicy &&
            !view.server.revoked) ? (
            <Button type="submit" disabled={!!confirmDisabled}>
              {busy ? <Spinner size="sm" /> : null}
              {view.kind === "details"
                ? "保存存储设置"
                : view.kind === "access"
                  ? view.allowed
                    ? "确认允许"
                    : "确认撤回"
                  : view.kind === "create"
                    ? "生成安装命令"
                    : view.kind === "bind"
                      ? "确认绑定"
                      : view.kind === "unbind"
                        ? "确认解绑"
                        : view.kind === "revoke"
                          ? "确认撤销"
                          : "确认删除"}
            </Button>
          ) : null}
        </Footer>
      ) : null}
    </form>
  );
  if (props.embedded) return content;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setRegistration(null);
        onOpenChange(next);
      }}
    >
      <DialogPopup className="sm:max-w-2xl" finalFocus={finalFocus}>
        {content}
      </DialogPopup>
    </Dialog>
  );
}

function PageHeader({ children }: { children: ReactNode }) {
  return <div className="mb-5">{children}</div>;
}
function PageTitle({ children }: { children: ReactNode }) {
  return <h2 className="min-w-0 break-words text-sm font-medium">{children}</h2>;
}
function PagePanel({ children }: { children: ReactNode }) {
  return <div className="space-y-4">{children}</div>;
}
function PageFooter({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 mt-6 flex justify-end gap-2 border-t bg-background py-3">
      {children}
    </div>
  );
}
