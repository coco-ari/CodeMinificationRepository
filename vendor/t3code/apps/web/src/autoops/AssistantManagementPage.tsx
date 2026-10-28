import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ProjectId } from "@t3tools/contracts";
import { ArrowLeftIcon, BotIcon, UserIcon } from "lucide-react";
import { SidebarInset } from "~/components/ui/sidebar";
import { ScrollArea } from "~/components/ui/scroll-area";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { SettingsGroup } from "~/components/settings/SettingsGroup";
import { SettingsSection, SettingsRow } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent } from "~/components/ui/empty";
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
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { toastManager } from "~/components/ui/toast";
import { ModuleErrorBoundary } from "./ModuleErrorBoundary";
import { ModuleHeader, ModuleSidebar, ModuleSidebarItem } from "./ModuleWorkspace";
import { useAutoOpsHost } from "./hostConfig";
import { useAutoOpsProjectId } from "./projectNavigation";
import { ProviderAssistantPanel } from "./ProviderAssistantPanel";
import { isAutoOpsAccessError, AutoOpsRequestError } from "./apiClient";
import {
  prepareProjectMutation,
  readPendingProjectWrite,
  recoverProjectWrite,
  submitProjectWrite,
  refreshProjectHost,
  type PendingProjectWrite,
} from "./projectDirectory";
import { loadAssistantManagement, type AssistantPreset } from "./projectAssistants";
import { ProjectConfigurationFields } from "./ProjectConfigurationFields";
import {
  configurationMutation,
  emptyConfig,
  projectRoleNames,
  type ProjectConfigurationEditor,
} from "./projectConfiguration";
type Editor = Extract<ProjectConfigurationEditor, { kind: "assistant" | "allocation" }>;
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "助手读取失败，请重试。";

export function AssistantManagementPage() {
  const host = useAutoOpsHost(),
    projectId = useAutoOpsProjectId(),
    location = useLocation(),
    navigate = useNavigate();
  const provided = (location.search as { assistantView?: string }).assistantView === "provided";
  const selectedQuery = Object.hasOwn(location.search, "projectId")
    ? String((location.search as { projectId?: unknown }).projectId ?? "")
    : projectId;
  const projectQuery =
    Object.hasOwn(location.search, "projectId") || selectedQuery
      ? `?projectId=${encodeURIComponent(selectedQuery)}&`
      : "?";
  const fromProject = (location.search as { from?: string }).from === "projects";
  const returnContext = location.search as { returnSection?: string; returnFrom?: string };
  const scopeQuery = [
    projectQuery,
    fromProject ? "from=projects&" : "",
    fromProject && returnContext.returnSection === "git" ? "returnSection=git&" : "",
    fromProject && returnContext.returnFrom === "deployments" ? "returnFrom=deployments&" : "",
  ].join("");
  return (
    <ModuleErrorBoundary label="助手" resetKey={`${host?.principal.id}:${projectId}:${provided}`}>
      <SidebarInset className="h-dvh min-h-0 min-w-0 overflow-hidden" data-assistant-management>
        <ModuleHeader title="助手" />
        <ModuleSidebar label="助手管理">
          <ModuleSidebarItem
            label="当前项目"
            icon={BotIcon}
            selected={!provided}
            onClick={() =>
              void navigate({
                href: `/assistants${scopeQuery}assistantView=project`,
              })
            }
          />
          <ModuleSidebarItem
            label="我提供的"
            icon={UserIcon}
            selected={provided}
            onClick={() =>
              void navigate({
                href: `/assistants${scopeQuery}assistantView=provided`,
              })
            }
          />
        </ModuleSidebar>
        <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
          <WorkspacePageContainer>
            {host ? (
              provided ? (
                <ProviderAssistantPanel key={host.principal.id} />
              ) : !host.projects.length && !Object.hasOwn(location.search, "projectId") ? (
                <Empty size="compact">
                  <EmptyHeader>
                    <EmptyTitle role="heading" aria-level={2}>先选择一个项目</EmptyTitle>
                    <EmptyDescription>
                      {host.canCreateProject
                        ? "在项目管理中创建项目，或联系管理员加入已有项目，再配置可使用的助手。"
                        : "请联系项目管理员分配项目和助手，再到项目管理刷新。"}
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button render={<Link to="/projects" />}>前往项目管理</Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <ProjectAssistantPanel
                  key={`${host.principal.id}:${projectId}`}
                  projectId={projectId}
                />
              )
            ) : (
              <p role="alert">登录上下文不可用。</p>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </SidebarInset>
    </ModuleErrorBoundary>
  );
}
function ProjectAssistantPanel({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const search = useLocation({ select: (location) => location.search }) as {
    from?: string;
    returnSection?: string;
    returnFrom?: string;
  };
  const fromProject = search.from === "projects";
  const host = useAutoOpsHost()!,
    project = host.projects.find((project) => project.id === projectId),
    manage = project?.capabilities?.["project.manage"] === true;
  const [context, setContext] = useState<Awaited<
      ReturnType<typeof loadAssistantManagement>
    > | null>(null),
    [error, setError] = useState<string | null>(null),
    [attempt, setAttempt] = useState(0);
  const [fresh, setFresh] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null),
    [pending, setPending] = useState<PendingProjectWrite | null>(null),
    [otherPending, setOtherPending] = useState<"delete" | "unknown" | null>(null),
    [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null),
    alive = useRef(true),
    writing = useRef(false),
    savedFocus = useRef(false);
  const scoped = (value: PendingProjectWrite) =>
    value.path.startsWith(`/api/v1/projects/${encodeURIComponent(projectId)}/assistants`) ||
    value.path === `/api/v1/projects/${encodeURIComponent(projectId)}/assistant-allocations`;
  const readPending = () => readPendingProjectWrite({ projectId, owner: 'assistant' });
  useEffect(() => {
    alive.current = true;
    const value = readPendingProjectWrite({ projectId, owner: 'assistant' });
    if (value && scoped(value)) setPending(value);
    const projectPath = `/api/v1/projects/${encodeURIComponent(projectId)}`;
    const environmentPath = `${projectPath}/environments/`;
    const deleting =
      value?.method === "DELETE" &&
      (value.path === projectPath ||
        (value.path.startsWith(environmentPath) &&
          /^[^/]+$/.test(value.path.slice(environmentPath.length))));
    // 旧记录范围无法核实时继续保留阻写，不把它冒称为当前项目删除。
    setOtherPending(value && !scoped(value) ? (deleting ? "delete" : "unknown") : null);
    return () => {
      alive.current = false;
    };
  }, [projectId]);
  useEffect(() => {
    if (!manage || !projectId) {
      setContext(null);
      setEditor(null);
      setFresh(false);
      return;
    }
    const controller = new AbortController();
    setFresh(false);
    void loadAssistantManagement(projectId, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setFresh(true);
        setContext(value);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (isAutoOpsAccessError(cause)) {
          setContext(null);
          setEditor(null);
        }
        setError(message(cause));
      });
    return () => controller.abort();
  }, [projectId, manage, attempt]);
  useEffect(() => {
    // 保存后目录会短暂禁用入口；恢复可用时只归还尚未被用户移走的焦点。
    if (savedFocus.current && editor === null && fresh && !busy && !pending && !otherPending) {
      savedFocus.current = false
      const focused = document.activeElement
      if (
        (!focused ||
          focused === document.body ||
          focused === trigger.current ||
          !focused.isConnected) &&
        trigger.current?.isConnected &&
        !trigger.current.disabled
      )
        trigger.current.focus()
    }
  }, [editor, fresh, busy, pending, otherPending])
  async function submit(original: PendingProjectWrite) {
    if (writing.current) return;
    const checking = original.submitted === true;
    writing.current = true;
    setBusy(true);
    setPending(original);
    setError(null);
    try {
      try {
        await submitProjectWrite(original);
      } catch (cause) {
        // 首次提交未知只自动查一次原结果；后续显式核对也不重复写入。
        if (checking || !(cause instanceof AutoOpsRequestError) || !cause.uncertain) throw cause;
        await recoverProjectWrite(original);
      }
      if (!alive.current) return;
      savedFocus.current = true;
      setFresh(false);
      setPending(null);
      setEditor(null);
      setAttempt((value) => value + 1);
      void refreshProjectHost().catch((cause) => {
        if (alive.current) setError(message(cause));
      });
      toastManager.add({ type: "success", title: "项目助手已保存" });
    } catch (cause) {
      if (!alive.current) return;
      const targetScopeError =
        original.path.endsWith("/assistant-allocations") &&
        cause instanceof AutoOpsRequestError &&
        [
          "ASSISTANT_ENVIRONMENT_FORBIDDEN",
          "ASSISTANT_WORKSPACE_FORBIDDEN",
          "ASSISTANT_MODEL_FORBIDDEN",
          "ASSISTANT_REASONING_FORBIDDEN",
          "ASSISTANT_SKILL_FORBIDDEN",
          "ASSISTANT_PROVIDER_SHARE_REQUIRED",
          "CUSTOMER_SHARED_EXTERNAL_UNSUPPORTED",
          "CUSTOMER_CONTEXT_UNSUPPORTED",
          "CUSTOMER_MODEL_UNAVAILABLE",
          "CUSTOMER_REASONING_UNAVAILABLE",
          "CUSTOMER_SKILL_UNAVAILABLE",
          "CUSTOMER_SHARED_ISOLATION_UNVERIFIED",
          "CUSTOMER_SHARED_PROFILE_REQUIRED",
        ].includes(cause.code ?? "");
      if (isAutoOpsAccessError(cause) && !targetScopeError) {
        setContext(null);
        setEditor(null);
      }
      setError(message(cause));
      const saved = readPending();
      setPending(saved && scoped(saved) ? saved : null);
      if (cause instanceof AutoOpsRequestError && cause.status === 409 && !saved) {
        setEditor(null);
        setAttempt((value) => value + 1);
        setError(`${message(cause)} 请重新打开并确认最新配置。`);
      }
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function save() {
    if (!editor || busy || pending || otherPending) return;
    try {
      const mutation = configurationMutation(projectId, editor);
      void submit(prepareProjectMutation(mutation.path, editor.revision, mutation.payload));
    } catch (cause) {
      setError(message(cause));
    }
  }
  const availableDefault = (preset: AssistantPreset) =>
    preset.enabled &&
    (!preset.providedBy ||
      context?.provided.items.find((item) => item.preset.id === preset.id)?.assignable === true);
  const allocate = (button: HTMLButtonElement) => {
    if (!context) return;
    trigger.current = button;
    setError(null);
    const target = { kind: "role" as const, id: "reader" as const },
      previous = context.assistants.allocations.find(
        (item) => item.target.kind === target.kind && item.target.id === target.id,
      );
    setEditor({
      kind: "allocation",
      name: "分配助手",
      description: "",
      revision: previous?.revision ?? 0,
      target,
      assistantIds: previous?.assistantIds ?? [],
      defaultAssistantId: previous?.defaultAssistantId ?? null,
      context,
    });
  };
  const edit = (preset: AssistantPreset | null, button: HTMLButtonElement) => {
    if (!context) return;
    trigger.current = button;
    setError(null);
    setEditor({
      kind: "assistant",
      ...(preset ? { id: preset.id } : {}),
      name: preset?.name ?? "",
      description: preset?.description ?? "",
      revision: preset?.revision ?? 0,
      value: preset
        ? {
            name: preset.name,
            description: preset.description,
            instructions: preset.instructions,
            enabled: preset.enabled,
            configuration: preset.configuration,
          }
        : {
            name: "",
            description: "",
            instructions: "",
            enabled: true,
            configuration: emptyConfig(),
          },
      context: {
        ...context,
        choices: {
          ...context.choices,
          sources: context.choices.sources.filter(
            (source) => source.executionBinding.kind === "platform",
          ),
        },
      },
    });
  };
  if (!project) return <p role="alert">当前项目不可用或无权访问，请从顶部选择授权项目。</p>;
  const readonlyItems = project.assistants?.items ?? [];
  return (
    <div className="space-y-6">
      {fromProject ? (
        busy || pending || otherPending || editor ? (
          <Button variant="ghost" size="sm" disabled><ArrowLeftIcon />返回项目配置</Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            render={
              <Link
                to="/projects"
                search={{
                  projectId: ProjectId.make(projectId),
                  ...(search.returnSection === "git" ? { section: "git" } : {}),
                  ...(search.returnFrom === "deployments" ? { from: "deployments" } : {}),
                }}
              />
            }
          >
            <ArrowLeftIcon />返回项目配置
          </Button>
        )
      ) : null}
      {otherPending ? (
        <Alert variant="info">
          <AlertDescription>
            {otherPending === "delete"
              ? "当前项目的删除结果尚待确认。"
              : "有配置操作的范围暂时无法确认，原请求已保留。"}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigate({
                  href:
                    otherPending === "delete"
                      ? `/projects?projectId=${encodeURIComponent(projectId)}`
                      : "/projects",
                })
              }
            >
              前往项目管理核对
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {pending ? (
        <Alert variant="info">
          <AlertDescription>
            项目助手操作结果尚未确认。
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !manage}
              onClick={() => void submit(pending)}
            >
              检查保存结果
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <SettingsSection
        title="当前项目"
        headerAction={
          manage ? (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setAttempt((value) => value + 1);
                }}
              >
                刷新助手
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !!pending || !!otherPending || !context || !fresh}
                onClick={(event) => allocate(event.currentTarget)}
              >
                分配助手
              </Button>
              <Button
                size="sm"
                disabled={busy || !!pending || !!otherPending || !context || !fresh}
                onClick={(event) => edit(null, event.currentTarget)}
              >
                添加项目助手
              </Button>
            </div>
          ) : undefined
        }
      >
        {manage && !context && !error ? <p role="status">正在读取项目助手…</p> : null}
        {manage && error ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError(null);
              setAttempt((value) => value + 1);
            }}
          >
            重试项目助手
          </Button>
        ) : null}
        <SettingsGroup>
          {(manage
            ? (context?.assistants.presets ?? [])
            : readonlyItems.map((item) => item.preset)
          ).map((preset) => {
            const provided = context?.provided.items.find((item) => item.preset.id === preset.id),
              availability = readonlyItems.find((item) => item.preset.id === preset.id);
            return (
              <SettingsRow
                key={preset.id}
                title={preset.name}
                description={
                  <>
                    <span className="block">
                      {preset.configuration.model.model} ·{" "}
                      {preset.configuration.model.reasoningEffort ?? "运行器默认"}
                    </span>
                    <span className="block">
                      {preset.providedBy
                        ? `提供者 · ${preset.providedBy.name}`
                        : preset.enabled
                          ? "项目预设"
                          : "已停用"}
                      {provided?.share?.enabled ? " · 已共享" : ""}
                    </span>
                    {provided?.reason || availability?.reason ? (
                      <span role="status" className="block">
                        {provided?.reason?.message ?? availability?.reason?.message}
                      </span>
                    ) : null}
                  </>
                }
                control={
                  manage && !preset.providedBy ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !!pending || !!otherPending || !fresh}
                      aria-label={`编辑项目助手 ${preset.name}`}
                      onClick={(event) => edit(preset, event.currentTarget)}
                    >
                      编辑
                    </Button>
                  ) : undefined
                }
              />
            );
          })}
          {(!manage || context) &&
          (manage ? context?.assistants.presets.length === 0 : readonlyItems.length === 0) ? (
            <SettingsRow
              title="当前没有已分配助手"
              description={project.assistants?.reason?.message}
            />
          ) : null}
        </SettingsGroup>
      </SettingsSection>
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setEditor(null);
        }}
      >
        <DialogPopup finalFocus={trigger} className="sm:max-w-2xl">
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editor?.kind === "allocation"
                  ? "分配项目助手"
                  : editor?.id
                    ? "编辑项目助手"
                    : "添加项目助手"}
              </DialogTitle>
            </DialogHeader>
            <DialogPanel>
              {error ? (
                <Alert variant="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              {editor?.kind === "assistant" ? (
                <ProjectConfigurationFields
                  editor={editor}
                  disabled={busy || !!pending}
                  onChange={(next) => {
                    if (next.kind === "assistant") setEditor(next);
                  }}
                />
              ) : editor?.kind === "allocation" ? (
                <>
                  <div className="space-y-2">
                    <Label>分配对象</Label>
                    <Select
                      value={`${editor.target.kind}:${editor.target.id}`}
                      disabled={busy || !!pending}
                      onValueChange={(value) => {
                        if (typeof value !== "string") return;
                        const [kind, id] = value.split(":") as ["member" | "role", string],
                          previous = editor.context.assistants.allocations.find(
                            (item) => item.target.kind === kind && item.target.id === id,
                          );
                        setEditor({
                          ...editor,
                          target: { kind, id } as typeof editor.target,
                          revision: previous?.revision ?? 0,
                          assistantIds: previous?.assistantIds ?? [],
                          defaultAssistantId: previous?.defaultAssistantId ?? null,
                        });
                      }}
                    >
                      <SelectTrigger aria-label="分配对象">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {Object.entries(projectRoleNames).map(([id, name]) => (
                          <SelectItem key={id} value={`role:${id}`}>
                            角色 · {name}
                          </SelectItem>
                        ))}
                        {editor.context.project.candidates.map((user) => (
                          <SelectItem key={user.id} value={`member:${user.id}`}>
                            成员 · {user.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  <fieldset className="space-y-2">
                    <legend className="mb-2 text-sm font-medium">可用助手</legend>
                    {editor.context.assistants.presets.map((preset) => (
                      <Label key={preset.id} className="flex items-center gap-2">
                        <Checkbox
                          aria-label={preset.name}
                          checked={editor.assistantIds.includes(preset.id)}
                          disabled={busy || !!pending}
                          onCheckedChange={(checked) =>
                            setEditor({
                              ...editor,
                              assistantIds: checked
                                ? [...editor.assistantIds, preset.id]
                                : editor.assistantIds.filter((id) => id !== preset.id),
                              defaultAssistantId:
                                !checked && editor.defaultAssistantId === preset.id
                                  ? null
                                  : editor.defaultAssistantId,
                            })
                          }
                        />
                        {preset.name}
                        {!availableDefault(preset) ? (
                          <span className="text-xs text-muted-foreground">不可作为有效默认</span>
                        ) : null}
                      </Label>
                    ))}
                  </fieldset>
                  <div className="space-y-2">
                    <Label>默认助手</Label>
                    <Select
                      value={editor.defaultAssistantId ?? "none"}
                      disabled={busy || !!pending}
                      onValueChange={(value) =>
                        typeof value === "string" &&
                        setEditor({
                          ...editor,
                          defaultAssistantId: value === "none" ? null : value,
                        })
                      }
                    >
                      <SelectTrigger aria-label="默认助手">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="none">
                          {editor.target.kind === "member" ? "跟随角色默认" : "不设置默认"}
                        </SelectItem>
                        {editor.context.assistants.presets
                          .filter((preset) => editor.assistantIds.includes(preset.id))
                          .map((preset) => (
                            <SelectItem
                              key={preset.id}
                              value={preset.id}
                              disabled={!availableDefault(preset)}
                            >
                              {preset.name}
                            </SelectItem>
                          ))}
                      </SelectPopup>
                    </Select>
                  </div>
                </>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy || !!pending}>
                保存助手配置
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
