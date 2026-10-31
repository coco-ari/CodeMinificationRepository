import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { UserIcon, UsersIcon } from "lucide-react";
import { SidebarInset } from "~/components/ui/sidebar";
import { ScrollArea } from "~/components/ui/scroll-area";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { SettingsSection, SettingsRow } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "~/components/ui/select";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { toastManager } from "~/components/ui/toast";
import { ModuleErrorBoundary } from "./ModuleErrorBoundary";
import { ModuleHeader, ModuleSidebar, ModuleSidebarItem } from "./ModuleWorkspace";
import { useAutoOpsHost } from "./hostConfig";
import { AutoOpsRequestError, isAutoOpsAccessError } from "./apiClient";
import {
  loadOwnAccount,
  loadAccounts,
  prepareAccountWrite,
  submitAccountWrite,
  readPendingAccountWrite,
  recoverAccountWrite,
  resumeAccountDeletion,
  accountResultRequiresLogin,
  returnToAccountLogin,
  type RuntimeAccount,
  type PendingAccountWrite,
  type AccountWriteValue,
  type AccountWriteResult,
} from "./accounts";

type Editor = {
  operation: AccountWriteValue['operation']
  target: RuntimeAccount | null
  username: string
  name: string
  kind: 'internal' | 'external'
  platformAdmin: boolean
  currentPassword: string
  newPassword: string
  confirmPassword: string
}
const titleFor = (operation: Editor['operation'], target?: RuntimeAccount | null) =>
  operation === 'delete'
    ? '删除账号'
    : operation === 'create'
      ? '创建账号'
      : operation === 'changePassword'
        ? '修改本人密码'
        : operation === 'resetPassword'
          ? '重置账号密码'
          : target?.enabled
            ? '停用账号'
            : '启用账号'
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "账号操作未完成，请重试。";

export function AccountManagementPage() {
  const host = useAutoOpsHost(),
    location = useLocation(),
    navigate = useNavigate();
  const manage = host?.canManageAccounts === true;
  const requested = (location.search as { accountView?: string }).accountView;
  const view = requested === "self" ? "self" : requested === "manage" || manage ? "manage" : "self";
  return (
    <ModuleErrorBoundary label="账号" resetKey={`${host?.principal.id}:${view}`}>
      <SidebarInset className="h-dvh min-h-0 min-w-0 overflow-hidden" data-account-management>
        <ModuleHeader title="账号" />
        <ModuleSidebar label="账号设置">
          <ModuleSidebarItem
            label="本人账号"
            icon={UserIcon}
            selected={view === "self"}
            onClick={() => void navigate({ href: "/accounts?accountView=self" })}
          />
          {manage ? (
            <ModuleSidebarItem
              label="平台账号"
              icon={UsersIcon}
              selected={view === "manage"}
              onClick={() => void navigate({ href: "/accounts?accountView=manage" })}
            />
          ) : null}
        </ModuleSidebar>
        <ScrollArea radius="none" className="min-h-0 flex-1">
          <WorkspacePageContainer>
            {host ? (
              <AccountPanel key={host.principal.id} view={view} />
            ) : (
              <p role="alert">登录上下文不可用。</p>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </SidebarInset>
    </ModuleErrorBoundary>
  );
}

function AccountPanel({ view }: { view: "self" | "manage" }) {
  const host = useAutoOpsHost()!,
    manage = host.canManageAccounts === true;
  const [own, setOwn] = useState<RuntimeAccount | null>(null);
  const [items, setItems] = useState<RuntimeAccount[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false),
    [fresh, setFresh] = useState(false),
    [attempt, setAttempt] = useState(0),
    [loadedAttempt, setLoadedAttempt] = useState(-1);
  const [editor, setEditor] = useState<Editor | null>(null),
    [pending, setPending] = useState<PendingAccountWrite | null>(readPendingAccountWrite);
  const [busy, setBusy] = useState(false),
    [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null),
    alive = useRef(true),
    writing = useRef(false);
  const restoreFocus = useRef(false);
  const pageRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pageRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- 外部授权或页面范围改变时立即清除原目录和表单秘密。
    setEditor(null);
    setError(null);
    setQuery("");
    setOwn(null);
    setItems([]);
    setCursor(null);
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- 两项外部范围变化均须清除旧数据。
  }, [view, manage]);
  useEffect(() => {
    const controller = new AbortController();
    pageRequest.current?.abort();
    pageRequest.current = controller;
    // eslint-disable-next-line react/set-state-in-effect -- 接收外部请求状态期间禁用旧修订的修改入口。
    setEditor(null);
    setError(null);
    setFresh(false);
    if (view === "manage" && !manage) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    void (
      view === "self"
        ? loadOwnAccount(controller.signal)
        : loadAccounts(undefined, controller.signal)
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        if ("items" in value) {
          setItems(value.items);
          setCursor(value.nextCursor);
        } else setOwn(value);
        setFresh(true);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (isAutoOpsAccessError(cause)) {
          setOwn(null);
          setItems([]);
          setCursor(null);
        }
        setError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setLoadedAttempt(attempt);
        }
      });
    return () => controller.abort();
  }, [view, manage, attempt]);
  useEffect(() => {
    if (loading || busy || loadedAttempt !== attempt || !restoreFocus.current) return;
    restoreFocus.current = false;
    const active = document.activeElement;
    if (
      trigger.current?.isConnected &&
      (active === document.body || active === trigger.current || !active?.isConnected)
    )
      trigger.current.focus();
  }, [loading, busy, loadedAttempt, attempt]);

  async function more() {
    if (!cursor || loading || !manage || view !== "manage") return;
    const controller = new AbortController();
    pageRequest.current = controller;
    setLoading(true);
    setError(null);
    try {
      const value = await loadAccounts(cursor, controller.signal);
      if (controller.signal.aborted) return;
      setItems((previous) => [
        ...previous,
        ...value.items.filter((item) => !previous.some((old) => old.id === item.id)),
      ]);
      setCursor(value.nextCursor);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (isAutoOpsAccessError(cause)) {
        setItems([]);
        setFresh(false);
        setEditor(null);
      }
      setError(message(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  function open(
    operation: Editor["operation"],
    target: RuntimeAccount | null,
    button: HTMLButtonElement,
  ) {
    if (!fresh || busy || pending || (operation !== "changePassword" && !manage)) return;
    trigger.current = button;
    setError(null);
    setNotice(null);
    setEditor({
      operation,
      target,
      username: "",
      name: "",
      kind: "internal",
      platformAdmin: false,
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    });
  }
  function completed(result: AccountWriteResult) {
    setEditor(null);
    setNotice(null);
    if ("saved" in result) {
      setPending(readPendingAccountWrite());
      setItems([]);
      setOwn(null);
      setFresh(false);
      setNotice("已保存，但当前登录无权继续查看。请重新登录后核对原结果。");
      return;
    }
    setPending(null);
    if (accountResultRequiresLogin(result, host.principal.id)) {
      returnToAccountLogin();
      return;
    }
    setAttempt((value) => value + 1);
    toastManager.add({ type: "success", title: "账号操作已完成" });
  }
  async function submit() {
    if (
      !editor ||
      writing.current ||
      pending ||
      !fresh ||
      (editor.operation !== "changePassword" && !manage)
    )
      return
    if (
      !['enable', 'delete'].includes(editor.operation) &&
      editor.newPassword !== editor.confirmPassword
    ) {
      setError('两次输入的新密码不一致。')
      return
    }
    const input: AccountWriteValue =
      editor.operation === "delete"
        ? { operation: "delete", expectedRevision: editor.target!.revision, value: {} }
        : editor.operation === "create"
        ? {
            operation: "create",
            value: {
              username: editor.username,
              name: editor.name,
              password: editor.newPassword,
              kind: editor.kind,
              platformAdmin: editor.kind === "internal" && editor.platformAdmin,
            },
          }
        : editor.operation === "enable"
          ? {
              operation: "enable",
              expectedRevision: editor.target!.revision,
              value: { enabled: !editor.target!.enabled },
            }
          : editor.operation === "resetPassword"
            ? {
                operation: "resetPassword",
                expectedRevision: editor.target!.revision,
                value: { newPassword: editor.newPassword },
              }
            : {
                operation: "changePassword",
                expectedRevision: editor.target!.revision,
                value: { currentPassword: editor.currentPassword, newPassword: editor.newPassword },
              };
    let original: PendingAccountWrite;
    try {
      original = prepareAccountWrite(editor.operation, editor.target?.id ?? null);
    } catch (cause) {
      setError(message(cause));
      return;
    }
    writing.current = true;
    setBusy(true);
    setPending(original);
    setError(null);
    // 提交后立即销毁表单秘密；未知结果只能查询原收据，不能再次发送密码。
    restoreFocus.current = true;
    setEditor(null);
    try {
      const result = await submitAccountWrite(original, input);
      if (alive.current) completed(result);
    } catch (cause) {
      if (!alive.current) return;
      setPending(readPendingAccountWrite());
      setError(message(cause));
      if (isAutoOpsAccessError(cause)) {
        setItems([]);
        setOwn(null);
        setFresh(false);
      }
      if (cause instanceof AutoOpsRequestError && cause.status === 409) {
        setAttempt((value) => value + 1);
        setNotice(`${message(cause)} 请重新打开并确认最新账号。`);
      }
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function recover() {
    if (!pending || writing.current) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await (pending.operation === 'delete'
        ? resumeAccountDeletion(pending)
        : recoverAccountWrite(pending))
      if (!alive.current) return
      if (result) completed(result)
      else setNotice('尚未找到原请求收据。请稍后核对；不要重新提交。')
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const editable = fresh && !busy && !pending;
  const visible = items.filter((item) =>
    `${item.name} ${item.username}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const description = (item: RuntimeAccount) => (
    <>
      <span className="wrap-anywhere">{item.username}</span>
      {` · ${item.kind === "internal" ? "内部成员" : "外部成员"}${item.platformAdmin ? " · 平台管理员" : ""} · ${item.enabled ? "已启用" : "已停用"}`}
    </>
  );
  return (
    <div className="space-y-6">
      {error && !editor ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant="info">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {pending ? (
        <Alert variant="info">
          <AlertDescription>
            账号操作结果尚未确认。重新登录后仍可核对原结果。
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void recover()}>
                {pending.operation === 'delete' ? '继续删除' : '核对原结果'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={returnToAccountLogin}>
                前往登录
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {view === "manage" && !manage ? (
        <p role="alert">无权管理平台账号。请在侧栏进入本人账号。</p>
      ) : (
        <SettingsSection
          title={view === "self" ? "本人账号" : "平台账号"}
          headerAction={
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || loading}
                onClick={() => setAttempt((value) => value + 1)}
              >
                刷新账号
              </Button>
              {view === "manage" ? (
                <Button
                  size="sm"
                  disabled={!editable}
                  onClick={(event) => open("create", null, event.currentTarget)}
                >
                  创建账号
                </Button>
              ) : null}
            </div>
          }
        >
          {loading && !fresh ? (
            <SettingsRow title={<span role="status">正在读取账号…</span>} />
          ) : null}
          {view === "self" && own ? (
            <SettingsRow
              title={own.name}
              description={description(own)}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!editable}
                  onClick={(event) => open("changePassword", own, event.currentTarget)}
                >
                  修改密码
                </Button>
              }
            />
          ) : null}
          {view === "manage" ? (
            <>
              <div className="px-3 py-2 sm:px-4">
                <Input
                  type="search"
                  aria-label="搜索已加载账号"
                  placeholder="搜索已加载账号…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              {visible.map((item) => (
                <SettingsRow
                  key={item.id}
                  title={item.name}
                  description={description(item)}
                  control={
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!editable}
                        aria-label={`重置密码 ${item.username}`}
                        onClick={(event) => open("resetPassword", item, event.currentTarget)}
                      >
                        重置密码
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!editable}
                        aria-label={`${item.enabled ? "停用" : "启用"}账号 ${item.username}`}
                        onClick={(event) => open("enable", item, event.currentTarget)}
                      >
                        {item.enabled ? "停用" : "启用"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!editable}
                        aria-label={`删除账号 ${item.username}`}
                        onClick={(event) => open('delete', item, event.currentTarget)}
                      >
                        删除
                      </Button>
                    </div>
                  }
                />
              ))}
              {fresh && !visible.length ? (
                <SettingsRow title={items.length ? "没有匹配的账号" : "暂无账号"} />
              ) : null}
              {cursor ? (
                <SettingsRow
                  title="更多账号"
                  control={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={loading || busy}
                      onClick={() => void more()}
                    >
                      加载更多
                    </Button>
                  }
                />
              ) : null}
            </>
          ) : null}
        </SettingsSection>
      )}
      <Dialog
        open={editor !== null}
        onOpenChange={(value) => {
          if (!value && !busy) setEditor(null);
        }}
      >
        <DialogPopup finalFocus={trigger}>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editor ? titleFor(editor.operation, editor.target) : "账号操作"}
              </DialogTitle>
              <DialogDescription>
                {editor?.operation === 'delete'
                  ? `将永久删除 ${editor.target?.name} 的账号、会话、成果、提供的助手、电脑接入记录及项目成员关系。项目和其他账号的独立资源不受影响。此操作无法撤销。`
                  : editor?.operation === 'create'
                    ? '新账号的项目和环境权限需另行分配。'
                    : editor?.operation === 'enable'
                      ? `${editor.target?.name}（${editor.target?.username}）${editor.target?.enabled ? '停用后将撤销登录会话。' : '将恢复登录能力。'}`
                      : `${editor?.target?.name}（${editor?.target?.username}）修改后将退出该账号的全部登录会话。`}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              {error ? (
                <Alert variant="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              {editor ? (
                <div className="space-y-4">
                  {editor.operation === "create" ? (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="account-username">用户名</Label>
                        <Input
                          id="account-username"
                          autoComplete="off"
                          required
                          pattern="[a-z][a-z0-9._-]{2,63}"
                          maxLength={64}
                          value={editor.username}
                          onChange={(event) =>
                            setEditor({ ...editor, username: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="account-name">姓名</Label>
                        <Input
                          id="account-name"
                          autoComplete="off"
                          required
                          maxLength={120}
                          value={editor.name}
                          onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>账号类型</Label>
                        <Select
                          value={editor.kind}
                          items={[{ value: "internal", label: "内部成员" }, { value: "external", label: "外部成员" }]}
                          onValueChange={(value) => {
                            if (value === "internal" || value === "external")
                              setEditor({ ...editor, kind: value, platformAdmin: false });
                          }}
                        >
                          <SelectTrigger aria-label="账号类型">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup>
                            <SelectItem value="internal">内部成员</SelectItem>
                            <SelectItem value="external">外部成员</SelectItem>
                          </SelectPopup>
                        </Select>
                      </div>
                      {editor.kind === "internal" ? (
                        <Label>
                          <Checkbox
                            checked={editor.platformAdmin}
                            onCheckedChange={(value) =>
                              setEditor({ ...editor, platformAdmin: value === true })
                            }
                          />
                          平台管理员
                        </Label>
                      ) : null}
                    </>
                  ) : null}
                  {editor.operation === "changePassword" ? (
                    <div className="space-y-2">
                      <Label htmlFor="account-current-password">当前密码</Label>
                      <Input
                        id="account-current-password"
                        type="password"
                        autoComplete="current-password"
                        required
                        maxLength={128}
                        value={editor.currentPassword}
                        onChange={(event) =>
                          setEditor({ ...editor, currentPassword: event.target.value })
                        }
                      />
                    </div>
                  ) : null}
                  {!['enable', 'delete'].includes(editor.operation) ? (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="account-new-password">新密码</Label>
                        <Input
                          id="account-new-password"
                          type="password"
                          autoComplete="new-password"
                          aria-describedby="account-password-help"
                          required
                          minLength={12}
                          maxLength={128}
                          value={editor.newPassword}
                          onChange={(event) =>
                            setEditor({ ...editor, newPassword: event.target.value })
                          }
                        />
                        <p id="account-password-help" className="text-xs text-muted-foreground">
                          12–128 个字符
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="account-confirm-password">确认新密码</Label>
                        <Input
                          id="account-confirm-password"
                          type="password"
                          autoComplete="new-password"
                          required
                          minLength={12}
                          maxLength={128}
                          value={editor.confirmPassword}
                          onChange={(event) =>
                            setEditor({ ...editor, confirmPassword: event.target.value })
                          }
                        />
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditor(null)}>
                取消
              </Button>
              <Button type="submit">
                {editor?.operation === 'delete'
                  ? '确认删除'
                  : editor?.operation === 'enable'
                    ? '确认'
                    : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
