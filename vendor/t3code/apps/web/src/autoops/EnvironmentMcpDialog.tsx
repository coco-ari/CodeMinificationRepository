import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ArrowLeftIcon, EllipsisIcon } from "lucide-react";
import { SettingsGroup } from "~/components/settings/SettingsGroup";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Alert, AlertDescription } from "~/components/ui/alert";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { Spinner } from "~/components/ui/spinner";
import { AutoOpsRequestError, isAutoOpsAccessError } from "./apiClient";
import { readAutoOpsHost, subscribeAutoOpsHost } from "./hostSnapshot";
import { loadAuthoringCredentials, type WorkspaceCredentialMetadata } from "./workspaceAuthoring";
import {
  loadEnvironmentMcp,
  prepareEnvironmentMcpMutation,
  readPendingEnvironmentMcp,
  recoverEnvironmentMcp,
  submitEnvironmentMcp,
  clearPendingEnvironmentMcp,
  type EnvironmentMcpConfiguration,
  type EnvironmentMcpConnection,
  type EnvironmentMcpMutation,
  type EnvironmentMcpWriteResult,
  type PendingEnvironmentMcp,
} from "./environmentMcpApi";

export interface EnvironmentMcpDialogProps {
  projectId: string;
  environmentId: string;
  environmentName: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  finalFocus: ComponentProps<typeof DialogPopup>["finalFocus"];
  onChanged(): void;
  onAccessDenied(cause: unknown): void;
}
type Draft = {
  type: EnvironmentMcpConfiguration["type"];
  name: string;
  host: string;
  port: string;
  credentialId: string;
  database: string;
  tls: "disabled" | "required";
  hostKeySha256: string;
  readPaths: string;
  serviceUnits: string;
  keyPatterns: string;
};
type View =
  | { kind: "list" }
  | { kind: "edit"; connection?: EnvironmentMcpConnection }
  | { kind: "enabled"; connection: EnvironmentMcpConnection; enabled: boolean }
  | { kind: "remove"; connection: EnvironmentMcpConnection };
const typeNames = { server: "服务器", mysql: "MySQL", redis: "Redis" };
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "操作未完成，请重试。";
const time = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("zh-CN")
    : "暂无测试";
const emptyDraft = (): Draft => ({
  type: "mysql",
  name: "",
  host: "",
  port: "3306",
  credentialId: "",
  database: "",
  tls: "required",
  hostKeySha256: "",
  readPaths: "",
  serviceUnits: "",
  keyPatterns: "",
});
function draftOf(connection?: EnvironmentMcpConnection): Draft {
  if (!connection) return emptyDraft();
  const value = connection.configuration;
  return {
    ...emptyDraft(),
    type: value.type,
    name: value.name,
    host: value.host,
    port: String(value.port),
    credentialId: value.credentialId ?? "",
    database: value.type === "server" ? "" : String(value.database),
    ...(value.type === "server"
      ? {
          hostKeySha256: value.hostKeySha256,
          readPaths: value.readPaths.join("\n"),
          serviceUnits: value.serviceUnits.join("\n"),
        }
      : { tls: value.tls }),
    ...(value.type === "redis" ? { keyPatterns: value.keyPatterns.join("\n") } : {}),
  };
}
const lines = (text: string) =>
  text
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
function configuration(draft: Draft): EnvironmentMcpConfiguration {
  const common = { name: draft.name.trim(), host: draft.host.trim(), port: Number(draft.port) };
  if (draft.type !== "redis" && !draft.credentialId) throw new Error("请选择可用的项目凭证。");
  if (draft.type === "server")
    return {
      ...common,
      type: "server",
      credentialId: draft.credentialId,
      hostKeySha256: draft.hostKeySha256.trim(),
      readPaths: lines(draft.readPaths),
      serviceUnits: lines(draft.serviceUnits),
    };
  if (draft.type === "mysql")
    return {
      ...common,
      type: "mysql",
      credentialId: draft.credentialId,
      database: draft.database.trim(),
      tls: draft.tls,
    };
  return {
    ...common,
    type: "redis",
    database: Number(draft.database),
    tls: draft.tls,
    keyPatterns: lines(draft.keyPatterns),
    ...(draft.credentialId ? { credentialId: draft.credentialId } : {}),
  };
}
function Field({ label, children }: { label: string; children(id: string): ReactNode }) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
    </div>
  );
}
function Choice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ id: string; name: string; disabled?: boolean }>;
  disabled: boolean;
  onChange(value: string): void;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label>{label}</Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => typeof next === "string" && onChange(next)}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue>
            {options.find((option) => option.id === value)?.name ??
              (value ? "原选项已不可用" : "请选择")}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id} disabled={option.disabled ?? false}>
              {option.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
function ScopeSummary({ configuration: value }: { configuration: EnvironmentMcpConfiguration }) {
  return (
    <SettingsGroup variant="plain">
      <SettingsRow title="类型" description={typeNames[value.type]} />
      {value.type === "server" ? (
        <>
          <SettingsRow
            title="可读目录"
            description={value.readPaths.join("、") || "未开放文件读取"}
          />
          <SettingsRow
            title="服务单元"
            description={value.serviceUnits.join("、") || "未开放服务查询"}
          />
        </>
      ) : (
        <SettingsRow title="数据库" description={String(value.database)} />
      )}
      {value.type === "redis" ? (
        <SettingsRow title="Key 范围" description={value.keyPatterns.join("、")} />
      ) : null}
    </SettingsGroup>
  );
}

export function EnvironmentMcpDialog(props: EnvironmentMcpDialogProps) {
  const host = useSyncExternalStore(subscribeAutoOpsHost, readAutoOpsHost);
  return (
    <EnvironmentMcpScope
      key={`${host?.principal.id}:${props.projectId}:${props.environmentId}:${props.open}`}
      {...props}
      identity={host?.principal.id ?? ""}
      allowed={
        host?.projects.find((project) => project.id === props.projectId)?.capabilities?.[
          "project.manage"
        ] !== false
      }
    />
  );
}
function EnvironmentMcpScope({
  identity,
  allowed,
  ...props
}: EnvironmentMcpDialogProps & { identity: string; allowed: boolean }) {
  const { projectId, environmentId, environmentName, open, finalFocus } = props;
  const [items, setItems] = useState<EnvironmentMcpConnection[] | null>(null);
  const [credentials, setCredentials] = useState<WorkspaceCredentialMetadata[] | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingEnvironmentMcp | null>(null);
  const [receiptState, setReceiptState] = useState<"pending" | "missing" | null>(null);
  const [storageInvalid, setStorageInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const active = useRef(true),
    writing = useRef<AbortController | null>(null);
  const requests = useRef(new Set<AbortController>());
  const callbacks = useRef(props);
  callbacks.current = props;
  const add = useRef<HTMLButtonElement | null>(null),
    firstField = useRef<HTMLInputElement | null>(null);
  const rowButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const returnFocus = useRef<string | null>(null);
  const valid = (controller: AbortController) =>
    active.current && !controller.signal.aborted && readAutoOpsHost()?.principal.id === identity;
  const controller = () => {
    const value = new AbortController();
    requests.current.add(value);
    return value;
  };
  function deny(cause: unknown) {
    for (const request of requests.current) request.abort();
    try {
      const original = readPendingEnvironmentMcp(projectId, environmentId);
      if (original) clearPendingEnvironmentMcp(original);
    } catch {
      /* 无法验证的存储记录不参与后续提交。 */
    }
    setItems(null);
    setCredentials(null);
    setDraft(emptyDraft());
    setPending(null);
    setView({ kind: "list" });
    setError(message(cause));
    setNotice(null);
    callbacks.current.onAccessDenied(cause);
    callbacks.current.onOpenChange(false);
  }
  function complete(operation: PendingEnvironmentMcp, result: EnvironmentMcpWriteResult) {
    setPending(null);
    setReceiptState(null);
    if ("available" in result && result.available === false) {
      deny(
        new AutoOpsRequestError(
          "操作已保存，当前环境管理权限已变化。",
          "ENVIRONMENT_MCP_ACCESS_CHANGED",
          403,
        ),
      );
      return;
    }
    setError(null);
    setView({ kind: "list" });
    setDraft(emptyDraft());
    returnFocus.current =
      (operation.mutation.kind === "save" && !operation.mutation.connectionId) ||
      operation.mutation.kind === "remove"
        ? "add"
        : (operation.mutation.connectionId ?? "add");
    const mutation = operation.mutation;
    setNotice(
      mutation.kind === "test"
        ? "连接测试通过。"
        : mutation.kind === "save"
          ? "连接配置已保存，请测试当前配置。"
          : mutation.kind === "enabled"
            ? mutation.input.enabled
              ? "连接已启用。"
              : "连接已停用。"
            : "连接已移除。",
    );
    setRefresh((value) => value + 1);
    callbacks.current.onChanged();
  }
  async function repair(operation: PendingEnvironmentMcp, request: AbortController) {
    const receipt = await recoverEnvironmentMcp(operation, request.signal);
    if (!valid(request)) return;
    if (receipt.status === "completed") complete(operation, receipt.result);
    else {
      setPending(operation);
      setReceiptState(receipt.status);
      setError(null);
    }
  }
  function failure(cause: unknown, operation?: PendingEnvironmentMcp) {
    if (isAutoOpsAccessError(cause)) {
      deny(cause);
      return;
    }
    setError(message(cause));
    setNotice(null);
    let unresolved: PendingEnvironmentMcp | null = null;
    try {
      unresolved = readPendingEnvironmentMcp(projectId, environmentId);
    } catch {
      setStorageInvalid(true);
    }
    if (unresolved) {
      setPending(unresolved);
      setReceiptState(null);
      return;
    }
    if (cause instanceof AutoOpsRequestError && !cause.uncertain) {
      setPending(null);
      setReceiptState(null);
      setRefresh((value) => value + 1);
      if (cause.status === 409 && operation?.mutation.kind !== "test") {
        setView({ kind: "list" });
        setDraft(emptyDraft());
        returnFocus.current = operation?.mutation.connectionId ?? "add";
        setError(`${message(cause)} 请重新打开连接并确认最新配置。`);
      }
    }
  }
  async function submit(
    mutation: Omit<EnvironmentMcpMutation, "input"> & { input: object },
    original?: PendingEnvironmentMcp,
  ) {
    if ((writing.current && !writing.current.signal.aborted) || storageInvalid) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const request = controller();
    writing.current = request;
    let operation = original;
    try {
      operation ??= prepareEnvironmentMcpMutation(projectId, environmentId, mutation);
      setPending(operation);
      const result = await submitEnvironmentMcp(operation, request.signal);
      if (valid(request)) complete(operation, result);
    } catch (cause) {
      if (!valid(request)) return;
      if (operation && cause instanceof AutoOpsRequestError && cause.uncertain) {
        try {
          await repair(operation, request);
        } catch (recovery) {
          if (valid(request)) failure(recovery, operation);
        }
      } else failure(cause, operation);
    } finally {
      requests.current.delete(request);
      if (writing.current === request) {
        writing.current = null;
        if (active.current) setBusy(false);
      }
    }
  }
  async function inspect(operation: PendingEnvironmentMcp) {
    if (writing.current && !writing.current.signal.aborted) return;
    setBusy(true);
    setError(null);
    const request = controller();
    writing.current = request;
    try {
      await repair(operation, request);
    } catch (cause) {
      if (valid(request)) failure(cause, operation);
    } finally {
      requests.current.delete(request);
      if (writing.current === request) {
        writing.current = null;
        if (active.current) setBusy(false);
      }
    }
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const request of requests.current) request.abort();
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    if (!allowed) {
      deny(new AutoOpsRequestError("当前环境管理权限已撤回。", "ENVIRONMENT_MCP_FORBIDDEN", 403));
      return;
    }
    try {
      const original = readPendingEnvironmentMcp(projectId, environmentId);
      if (original) {
        setPending(original);
        void inspect(original);
      }
    } catch (cause) {
      setStorageInvalid(true);
      setError(message(cause));
    }
  }, [open, allowed, projectId, environmentId]);
  useEffect(() => {
    if (!open || !allowed) return;
    const request = controller();
    setLoadError(null);
    setCredentialError(null);
    void Promise.allSettled([
      loadEnvironmentMcp(projectId, environmentId, request.signal),
      loadAuthoringCredentials(projectId, request.signal),
    ])
      .then((results) => {
        if (!valid(request)) return;
        const [connections, secrets] = results;
        const rejected = results.find(
          (result) => result.status === "rejected" && isAutoOpsAccessError(result.reason),
        );
        if (rejected?.status === "rejected") {
          deny(rejected.reason);
          return;
        }
        if (connections.status === "fulfilled") setItems(connections.value.items);
        else {
          setItems(null);
          setLoadError(message(connections.reason));
        }
        if (secrets.status === "fulfilled") setCredentials(secrets.value.credentials);
        else {
          setCredentials(null);
          setCredentialError(message(secrets.reason));
        }
      })
      .finally(() => requests.current.delete(request));
    return () => request.abort();
  }, [open, allowed, projectId, environmentId, refresh]);
  useEffect(() => {
    if (view.kind === "edit") firstField.current?.focus();
    else if (view.kind === "list" && returnFocus.current) {
      (rowButtons.current[returnFocus.current] ?? add.current)?.focus();
      returnFocus.current = null;
    }
  }, [view.kind, items]);
  const locked = busy || !!pending || storageInvalid || !allowed;
  const go = (next: View, connectionId = "add") => {
    returnFocus.current = connectionId;
    setError(null);
    setNotice(null);
    if (next.kind === "edit") setDraft(draftOf(next.connection));
    setView(next);
  };
  const update = (patch: Partial<Draft>) => setDraft((value) => ({ ...value, ...patch }));
  const title =
    view.kind === "list"
      ? `${environmentName} · 环境连接`
      : view.kind === "edit"
        ? view.connection
          ? "编辑环境连接"
          : "添加环境连接"
        : `${view.kind === "remove" ? "移除" : view.enabled ? "启用" : "停用"}「${view.connection.configuration.name}」`;
  const confirm = () => {
    if (locked) return;
    if (view.kind === "edit") {
      try {
        void submit({
          kind: "save",
          ...(view.connection ? { connectionId: view.connection.id } : {}),
          input: { expectedRevision: view.connection?.revision ?? 0, value: configuration(draft) },
        });
      } catch (cause) {
        setError(message(cause));
      }
    } else if (view.kind !== "list")
      void submit({
        kind: view.kind,
        connectionId: view.connection.id,
        input: {
          expectedRevision: view.connection.revision,
          ...(view.kind === "enabled" ? { enabled: view.enabled } : {}),
        },
      });
  };
  return (
    <Dialog open={open} onOpenChange={(next) => callbacks.current.onOpenChange(next)}>
      <DialogPopup
        finalFocus={finalFocus}
        initialFocus={() => (add.current?.disabled ? undefined : (add.current ?? undefined))}
        className="sm:max-w-2xl"
      >
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
          <DialogHeader>
            <div className="flex min-w-0 items-center gap-2 pr-6">
              {view.kind !== "list" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="返回环境连接列表"
                  disabled={busy}
                  onClick={() => go({ kind: "list" }, returnFocus.current ?? "add")}
                >
                  <ArrowLeftIcon />
                </Button>
              ) : null}
              <DialogTitle>{title}</DialogTitle>
            </div>
          </DialogHeader>
          <DialogPanel>
            {error || loadError ? (
              <Alert variant="error">
                <AlertDescription>{error ?? loadError}</AlertDescription>
              </Alert>
            ) : null}
            {notice ? (
              <p role="status" className="text-sm">
                {notice}
              </p>
            ) : null}
            {pending ? (
              <Alert variant="info">
                <AlertDescription>
                  {busy
                    ? pending.mutation.kind === "test"
                      ? "正在测试连接并核对结果。"
                      : "正在提交或核对原请求结果。"
                    : receiptState === "missing"
                      ? "尚未查到原请求收据，可按原参数重试。"
                      : receiptState === "pending"
                        ? "原请求仍在执行，请核对结果。"
                        : "操作结果尚未确认，请核对原请求。"}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void inspect(pending)}
                    >
                      核对原请求
                    </Button>
                    {receiptState === "missing" ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => void submit(pending.mutation, pending)}
                      >
                        重试原请求
                      </Button>
                    ) : null}
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
            {view.kind === "list" ? (
              <>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    刷新连接
                  </Button>
                  <Button
                    ref={add}
                    type="button"
                    size="sm"
                    disabled={locked || !items}
                    onClick={() => go({ kind: "edit" })}
                  >
                    添加连接
                  </Button>
                </div>
                {!items && !loadError ? <p role="status">正在读取环境连接</p> : null}
                {loadError ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    重试读取连接
                  </Button>
                ) : null}
                <SettingsGroup>
                  {items?.map((connection) => (
                    <SettingsRow
                      key={connection.id}
                      title={connection.configuration.name}
                      description={
                        <span className="block min-w-0 space-y-1 break-words">
                          <span className="block">
                            {typeNames[connection.configuration.type]} ·{" "}
                            {connection.enabled ? "已启用" : "未启用"}
                          </span>
                          <span className="block">
                            上次测试：
                            {connection.lastTest
                              ? `${connection.lastTest.status === "passed" ? "通过" : "失败"} · ${time(connection.lastTest.testedAt)}`
                              : "暂无测试"}
                          </span>
                          {connection.lastTest?.error ? (
                            <span role="alert" className="block">
                              {connection.lastTest.error.message}
                            </span>
                          ) : null}
                        </span>
                      }
                      control={
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={locked}
                            aria-label={`测试连接 ${connection.configuration.name}`}
                            onClick={() =>
                              void submit({
                                kind: "test",
                                connectionId: connection.id,
                                input: { expectedRevision: connection.revision },
                              })
                            }
                          >
                            测试连接
                          </Button>
                          <Menu>
                            <MenuTrigger
                              ref={(element) => {
                                rowButtons.current[connection.id] =
                                  element instanceof HTMLButtonElement ? element : null;
                              }}
                              render={
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  disabled={locked}
                                  aria-label={`管理连接 ${connection.configuration.name}`}
                                />
                              }
                            >
                              <EllipsisIcon />
                            </MenuTrigger>
                            <MenuPopup align="end">
                              <MenuItem
                                onClick={() => go({ kind: "edit", connection }, connection.id)}
                              >
                                编辑连接
                              </MenuItem>
                              <MenuItem
                                onClick={() =>
                                  go(
                                    { kind: "enabled", connection, enabled: !connection.enabled },
                                    connection.id,
                                  )
                                }
                              >
                                {connection.enabled ? "停用连接" : "启用连接"}
                              </MenuItem>
                              <MenuItem
                                variant="destructive"
                                onClick={() => go({ kind: "remove", connection }, connection.id)}
                              >
                                移除连接
                              </MenuItem>
                            </MenuPopup>
                          </Menu>
                        </div>
                      }
                    />
                  ))}
                  {items?.length === 0 ? <SettingsRow title="暂无环境连接" /> : null}
                </SettingsGroup>
              </>
            ) : view.kind === "edit" ? (
              <>
                <Field label="连接名称">
                  {(id) => (
                    <Input
                      ref={firstField}
                      id={id}
                      value={draft.name}
                      required
                      maxLength={120}
                      disabled={locked}
                      onChange={(event) => update({ name: event.target.value })}
                    />
                  )}
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Choice
                    label="连接类型"
                    value={draft.type}
                    disabled={locked || !!view.connection}
                    options={Object.entries(typeNames).map(([id, name]) => ({ id, name }))}
                    onChange={(type) =>
                      update({
                        type: type as Draft["type"],
                        port: type === "server" ? "22" : type === "mysql" ? "3306" : "6379",
                        database: type === "redis" ? "0" : "",
                        readPaths: "",
                        serviceUnits: "",
                        keyPatterns: "",
                        hostKeySha256: "",
                      })
                    }
                  />
                  <Field label="端口">
                    {(id) => (
                      <Input
                        id={id}
                        type="number"
                        min={1}
                        max={65535}
                        required
                        value={draft.port}
                        disabled={locked}
                        onChange={(event) => update({ port: event.target.value })}
                      />
                    )}
                  </Field>
                </div>
                <Field label="主机">
                  {(id) => (
                    <Input
                      id={id}
                      value={draft.host}
                      required
                      maxLength={255}
                      disabled={locked}
                      onChange={(event) => update({ host: event.target.value })}
                    />
                  )}
                </Field>
                <Choice
                  label="项目凭证"
                  value={draft.credentialId || "none"}
                  disabled={locked || !credentials}
                  options={[
                    {
                      id: "none",
                      name: draft.type === "redis" ? "不使用凭证" : "请选择项目凭证",
                      disabled: draft.type !== "redis",
                    },
                    ...(credentials ?? []).map((value) => ({
                      id: value.id,
                      name: value.name + (value.revoked ? " · 已撤回" : ""),
                      disabled: value.revoked,
                    })),
                  ]}
                  onChange={(credentialId) =>
                    update({ credentialId: credentialId === "none" ? "" : credentialId })
                  }
                />
                {credentialError ? (
                  <Alert variant="error">
                    <AlertDescription>
                      {credentialError}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setRefresh((value) => value + 1)}
                      >
                        重试凭证列表
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {credentials?.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    项目尚无可用凭证，请返回项目配置添加。
                  </p>
                ) : null}
                {draft.type === "server" ? (
                  <Field label="SSH 主机指纹">
                    {(id) => (
                      <Input
                        id={id}
                        value={draft.hostKeySha256}
                        required
                        placeholder="SHA256:…"
                        disabled={locked}
                        onChange={(event) => update({ hostKeySha256: event.target.value })}
                      />
                    )}
                  </Field>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={draft.type === "mysql" ? "数据库" : "逻辑数据库"}>
                      {(id) => (
                        <Input
                          id={id}
                          type={draft.type === "redis" ? "number" : "text"}
                          {...(draft.type === "redis" ? { min: 0, max: 15 } : { maxLength: 128 })}
                          required
                          value={draft.database}
                          disabled={locked}
                          onChange={(event) => update({ database: event.target.value })}
                        />
                      )}
                    </Field>
                    <Choice
                      label="TLS"
                      value={draft.tls}
                      disabled={locked}
                      options={[
                        { id: "required", name: "验证证书" },
                        { id: "disabled", name: "关闭" },
                      ]}
                      onChange={(tls) => update({ tls: tls as Draft["tls"] })}
                    />
                  </div>
                )}
                {draft.type !== "mysql" ? (
                  <SettingsSection title="读取范围">
                    {draft.type === "server" ? (
                      <>
                        <Field label="可读目录（每行一个）">
                          {(id) => (
                            <Textarea
                              id={id}
                              rows={3}
                              value={draft.readPaths}
                              disabled={locked}
                              placeholder="/srv/project/logs"
                              onChange={(event) => update({ readPaths: event.target.value })}
                            />
                          )}
                        </Field>
                        <Field label="服务单元（每行一个）">
                          {(id) => (
                            <Textarea
                              id={id}
                              rows={2}
                              value={draft.serviceUnits}
                              disabled={locked}
                              placeholder="project.service"
                              onChange={(event) => update({ serviceUnits: event.target.value })}
                            />
                          )}
                        </Field>
                      </>
                    ) : (
                      <Field label="Key 范围（每行一个）">
                        {(id) => (
                          <Textarea
                            id={id}
                            rows={3}
                            required
                            value={draft.keyPatterns}
                            disabled={locked}
                            placeholder="project:*"
                            onChange={(event) => update({ keyPatterns: event.target.value })}
                          />
                        )}
                      </Field>
                    )}
                  </SettingsSection>
                ) : null}
              </>
            ) : (
              <>
                <ScopeSummary configuration={view.connection.configuration} />
                <p className="text-sm">
                  {view.kind === "remove"
                    ? "移除后拒绝此连接的后续读取，已确认结果保留。"
                    : view.enabled
                      ? "本环境内可使用问答的成员可以读取以上范围。启用前需通过当前配置与凭证版本的只读测试。"
                      : "停用后拒绝后续读取；已发出的请求按实际结果收尾。"}
                </p>
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            {view.kind === "list" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => callbacks.current.onOpenChange(false)}
              >
                关闭
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => go({ kind: "list" }, returnFocus.current ?? "add")}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={
                    locked || (view.kind === "edit" && draft.type !== "redis" && !credentials)
                  }
                >
                  {busy ? <Spinner /> : null}
                  {view.kind === "edit"
                    ? "保存连接"
                    : view.kind === "remove"
                      ? "确认移除"
                      : view.enabled
                        ? "确认启用"
                        : "确认停用"}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
