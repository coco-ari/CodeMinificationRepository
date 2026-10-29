import { useEffect, useRef, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { AssistantEditorPage, AssistantEnabledControl } from "./AssistantEditorPage";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "~/components/ui/select";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "~/components/ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { SettingsGroup } from "~/components/settings/SettingsGroup";
import { SettingsSection, SettingsRow } from "~/components/settings/settingsLayout";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { toastManager } from "~/components/ui/toast";
import { useAutoOpsHost } from "./hostConfig";
import { AutoOpsRequestError, isAutoOpsAccessError } from "./apiClient";
import { assistantSourceKey } from "./projectConfiguration";
import { CustomerDevicesContent } from "./CustomerDevicesSettings";
import {
  providedProfileDescriptor,
  providedRuntimeKey,
  providedRuntimeCatalog,
  providedConfigurationIssue,
  type ProvidedRuntimeSelection,
} from "./providedAssistantConfiguration";
import {
  loadProvidedAssistants,
  readPendingProvidedAssistant,
  clearPendingProvidedAssistant,
  prepareProvidedSave,
  prepareProvidedShare,
  submitProvidedAssistant,
  recoverProvidedAssistant,
  type AssistantDetails,
  type AssistantPreset,
  type ProvidedAssistantSettings,
  type PendingProvidedAssistant,
  type ProvidedAssistantWriteResult,
} from "./providedAssistants";

type Draft = {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  source: string;
  runtime: ProvidedRuntimeSelection;
  model: string;
  reasoning: string | null;
  skillIds: string[];
};
type Editor =
  | { kind: "save"; preset: AssistantPreset | null; draft: Draft }
  | { kind: "share"; preset: AssistantPreset; projectId: string; enabled: boolean }
  | null;
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "操作未完成，请重试。";
const blank = (): Draft => ({
  name: "",
  description: "",
  instructions: "",
  enabled: true,
  source: "",
  runtime: null,
  model: "",
  reasoning: null,
  skillIds: [],
});
function Choice({
  label,
  value,
  disabled,
  options,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  options: Array<{ id: string; name: string; disabled?: boolean }>;
  onChange(value: string): void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => typeof next === "string" && onChange(next)}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue>
            {options.find((option) => option.id === value)?.name ?? "请选择"}
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
export function ProviderAssistantPanel() {
  const host = useAutoOpsHost()!,
    actor = host.principal.id;
  const [data, setData] = useState<ProvidedAssistantSettings | null>(null),
    [error, setError] = useState<string | null>(null),
    [attempt, setAttempt] = useState(0);
  const [editor, setEditor] = useState<Editor>(null),
    [pending, setPending] = useState<PendingProvidedAssistant | null>(null),
    [busy, setBusy] = useState(false),
    [fresh, setFresh] = useState(false),
    [invalid, setInvalid] = useState(false);
  const alive = useRef(true),
    write = useRef<AbortController | null>(null),
    trigger = useRef<HTMLButtonElement | null>(null);
  const savedFocus = useRef(false);
  const menuTriggers = useRef(new Map<string, HTMLButtonElement>());
  const disabled = busy || !!pending || invalid || !fresh;
  function denied(cause: unknown) {
    savedFocus.current = false;
    try {
      const original = readPendingProvidedAssistant();
      if (original) clearPendingProvidedAssistant(original);
    } catch {}
    setData(null);
    setFresh(false);
    setEditor(null);
    setPending(null);
    setError(message(cause));
  }
  function completed(result: ProvidedAssistantWriteResult) {
    if ("available" in result && result.available === false) {
      denied(
        new AutoOpsRequestError(
          "操作已保存，当前授权已失效；恢复授权后请刷新核对。",
          "ASSISTANT_SAVED_ACCESS_REVOKED",
          403,
        ),
      );
      return;
    }
    savedFocus.current = true;
    setFresh(false);
    setPending(null);
    setEditor(null);
    setError(null);
    setAttempt((value) => value + 1);
    toastManager.add({ type: "success", title: "助手配置已保存" });
  }
  function failed(cause: unknown) {
    if (isAutoOpsAccessError(cause)) {
      denied(cause);
      return;
    }
    setError(message(cause));
    try {
      const original = readPendingProvidedAssistant();
      setPending(original);
      if (!original && cause instanceof AutoOpsRequestError && cause.status === 409) {
        setEditor(null);
        setAttempt((value) => value + 1);
        setError(`${message(cause)} 请重新打开并确认最新配置。`);
      }
    } catch {
      setInvalid(true);
    }
  }
  async function recover(
    original: PendingProvidedAssistant,
    controller: AbortController,
    retry = false,
  ) {
    const result = await recoverProvidedAssistant(original, controller.signal);
    if (controller.signal.aborted || !alive.current) return;
    if (result) {
      completed(result);
      return;
    }
    if (retry) {
      const result = await submitProvidedAssistant(original, controller.signal);
      if (!controller.signal.aborted && alive.current) completed(result);
    } else {
      setPending(original);
      setError("原请求尚未查到收据，请重试核对；系统会保留同一请求。");
    }
  }
  async function execute(original: PendingProvidedAssistant, recovery = false, retry = false) {
    if (write.current && !write.current.signal.aborted) return;
    const controller = new AbortController();
    write.current = controller;
    setBusy(true);
    setError(null);
    setPending(original);
    try {
      if (recovery) await recover(original, controller, retry);
      else {
        try {
          const result = await submitProvidedAssistant(original, controller.signal);
          if (!controller.signal.aborted && alive.current) completed(result);
        } catch (cause) {
          if (cause instanceof AutoOpsRequestError && cause.uncertain)
            await recover(original, controller);
          else throw cause;
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted && alive.current) failed(cause);
    } finally {
      if (write.current === controller) {
        write.current = null;
        if (alive.current) setBusy(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    try {
      const original = readPendingProvidedAssistant();
      if (original) void execute(original, true);
    } catch (cause) {
      setInvalid(true);
      setError(message(cause));
    }
    return () => {
      alive.current = false;
      write.current?.abort();
    };
  }, [actor]);
  useEffect(() => {
    const controller = new AbortController();
    setFresh(false);
    void loadProvidedAssistants(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setFresh(true);
        }
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (isAutoOpsAccessError(cause)) denied(cause);
        else setError(message(cause));
      });
    return () => controller.abort();
  }, [actor, attempt]);
  useEffect(() => {
    // 保存后目录暂时禁用入口，恢复时归还尚未被用户移走的焦点。
    if (savedFocus.current && editor === null && !disabled) {
      savedFocus.current = false;
      const focused = document.activeElement;
      if (
        (!focused ||
          focused === document.body ||
          focused === trigger.current ||
          !focused.isConnected) &&
        trigger.current?.isConnected
      )
        trigger.current.focus();
    }
  }, [editor, disabled]);
  const sources = data?.sources ?? [];
  const openSave = (preset: AssistantPreset | null, button: HTMLButtonElement) => {
    trigger.current = button;
    setError(null);
    setEditor({
      kind: "save",
      preset,
      draft: preset
        ? {
            name: preset.name,
            description: preset.description,
            instructions: preset.instructions,
            enabled: preset.enabled,
            source: assistantSourceKey(preset.configuration.executionBinding),
            runtime: preset.configuration.customerProfile ?? "self",
            model: preset.configuration.model.model,
            reasoning: preset.configuration.model.reasoningEffort,
            skillIds: [...preset.configuration.skillIds],
          }
        : blank(),
    });
  };
  const update = (patch: Partial<Draft>) =>
    setEditor((current) =>
      current?.kind === "save" ? { ...current, draft: { ...current.draft, ...patch } } : current,
    );
  const source =
    editor?.kind === "save"
      ? sources.find((value) => assistantSourceKey(value.executionBinding) === editor.draft.source)
      : undefined;
  const directory = providedRuntimeCatalog(
    source,
    editor?.kind === "save" ? editor.draft.runtime : null,
  );
  const model =
    editor?.kind === "save"
      ? directory.models.find((value) => value.id === editor.draft.model)
      : undefined;
  const save = () => {
    if (!editor || disabled) return;
    try {
      if (editor.kind === "share") {
        if (!editor.projectId) throw new Error("请选择共享目标项目。");
        const previous = data?.items
          .find((item) => item.preset.id === editor.preset.id)
          ?.shares.find((share) => share.projectId === editor.projectId);
        void execute(
          prepareProvidedShare(
            editor.preset.id,
            editor.projectId,
            previous?.revision ?? 0,
            editor.enabled,
          ),
        );
        return;
      }
      const draft = editor.draft,
        binding = source?.executionBinding ?? editor.preset?.configuration.executionBinding;
      if (binding?.kind !== "customer") throw new Error("请选择本人已登记的运行来源。");
      if (draft.runtime === null) throw new Error("请选择运行目录。");
      if (draft.enabled) {
        const issue = providedConfigurationIssue(source, draft);
        if (issue) throw new Error(issue);
      }
      const configuration: AssistantDetails["configuration"] = {
        agentId: "a-project",
        executionBinding: binding,
        ...(draft.runtime !== "self"
          ? { customerProfile: providedProfileDescriptor(draft.runtime) }
          : {}),
        environmentId: null,
        workspaceType: null,
        visibility: "private",
        model: {
          instanceId: `customer-${binding.deviceId}-codex`,
          model: draft.model,
          reasoningEffort:
            draft.reasoning as AssistantDetails["configuration"]["model"]["reasoningEffort"],
        },
        skillIds: draft.skillIds,
      };
      const value: AssistantDetails = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        instructions: draft.instructions,
        enabled: draft.enabled,
        configuration,
      };
      void execute(
        prepareProvidedSave(
          editor.preset?.id ?? null,
          source?.sourceProjectId ?? editor.preset!.projectId,
          editor.preset?.revision ?? 0,
          value,
        ),
      );
    } catch (cause) {
      setError(message(cause));
    }
  };
  function closeEditor() {
    savedFocus.current = true;
    setEditor(null);
  }
  function toggle(preset: AssistantPreset, enabled: boolean) {
    if (disabled) return;
    try {
      void execute(
        prepareProvidedSave(preset.id, preset.projectId, preset.revision, {
          name: preset.name,
          description: preset.description,
          instructions: preset.instructions,
          configuration: preset.configuration,
          enabled,
        }),
      );
    } catch (cause) {
      setError(message(cause));
    }
  }
  const saveFields =
    editor?.kind === "save" ? (
      <>
        <div className="space-y-2">
          <Label htmlFor="provided-name">名称</Label>
          <Input
            id="provided-name"
            autoFocus
            required
            maxLength={120}
            value={editor.draft.name}
            disabled={disabled}
            onChange={(event) => update({ name: event.target.value })}
          />
        </div>
        <Choice
          label="本人运行来源"
          value={editor.draft.source}
          disabled={disabled || !!editor.preset}
          options={[
            ...sources.map((value) => ({
              id: assistantSourceKey(value.executionBinding),
              name: `${value.deviceName} · ${value.workspaceName}`,
            })),
            ...(!source && editor.draft.source
              ? [{ id: editor.draft.source, name: "原运行来源暂不可用", disabled: true }]
              : []),
          ]}
          onChange={(source) =>
            update({ source, runtime: null, model: "", reasoning: null, skillIds: [] })
          }
        />
        <Choice
          label="运行目录"
          value={providedRuntimeKey(editor.draft.runtime)}
          disabled={disabled || !source}
          options={[
            { id: "self", name: "自用运行器" },
            ...(source?.capabilities?.sharedProfile
              ? [
                  {
                    id: providedRuntimeKey(source.capabilities.sharedProfile),
                    name:
                      source.sharedProfileAvailable === true
                        ? "隔离运行器"
                        : "隔离运行器 · 已不可用",
                    disabled: source.sharedProfileAvailable !== true,
                  },
                ]
              : []),
            ...(editor.draft.runtime !== null &&
            editor.draft.runtime !== "self" &&
            (!source?.capabilities?.sharedProfile ||
              providedRuntimeKey(editor.draft.runtime) !==
                providedRuntimeKey(source.capabilities.sharedProfile))
              ? [
                  {
                    id: providedRuntimeKey(editor.draft.runtime),
                    name: "原隔离运行器 · 已不可用",
                    disabled: true,
                  },
                ]
              : []),
          ]}
          onChange={(value) => {
            const profile = source?.capabilities?.sharedProfile;
            if (value === "self")
              update({ runtime: "self", model: "", reasoning: null, skillIds: [] });
            else if (
              profile &&
              value === providedRuntimeKey(profile) &&
              source?.sharedProfileAvailable === true
            )
              update({
                runtime: providedProfileDescriptor(profile),
                model: "",
                reasoning: null,
                skillIds: [],
              });
          }}
        />
        {editor.draft.runtime !== null && !directory.available ? (
          <p role="status" className="text-sm text-muted-foreground">
            {directory.reason}
          </p>
        ) : null}
        {editor.draft.runtime === null &&
        source?.sharedProfileAvailable !== true &&
        source?.sharedProfileReason ? (
          <p role="status" className="text-sm text-muted-foreground">
            {source.sharedProfileReason.message}
          </p>
        ) : null}
        <Choice
          label="模型"
          value={editor.draft.model}
          disabled={disabled || !directory.available || !directory.models.length}
          options={[
            ...directory.models.map((model) => ({
              id: model.id,
              name: model.name ?? model.id,
            })),
            ...(!model && editor.draft.model
              ? [
                  {
                    id: editor.draft.model,
                    name: `${editor.draft.model} · 已不可用`,
                    disabled: true,
                  },
                ]
              : []),
          ]}
          onChange={(id) => {
            const next = directory.models.find((model) => model.id === id);
            if (next) update({ model: id, reasoning: next.defaultReasoningEffort ?? null });
          }}
        />
        <Choice
          label="思考强度"
          value={editor.draft.reasoning ?? "runtime-default"}
          disabled={disabled || !directory.available || !model}
          options={[
            ...(!model?.supportedReasoningEfforts.length
              ? [{ id: "runtime-default", name: "此模型不提供思考档位" }]
              : []),
            ...(model?.supportedReasoningEfforts.map((id) => ({ id, name: id })) ?? []),
            ...(editor.draft.reasoning &&
            !model?.supportedReasoningEfforts.includes(editor.draft.reasoning)
              ? [
                  {
                    id: editor.draft.reasoning,
                    name: `${editor.draft.reasoning} · 已不可用`,
                    disabled: true,
                  },
                ]
              : []),
          ]}
          onChange={(value) => update({ reasoning: value === "runtime-default" ? null : value })}
        />
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">skill</legend>
          {[
            ...directory.skills,
            ...editor.draft.skillIds
              .filter((id) => !directory.skills.some((skill) => skill.id === id))
              .map((id) => ({ id, name: `${id} · 已不可用` })),
          ].map((skill) => (
            <Label key={skill.id} className="flex items-center gap-2">
              <Checkbox
                aria-label={skill.name}
                checked={editor.draft.skillIds.includes(skill.id)}
                disabled={disabled || !directory.available}
                onCheckedChange={(checked) =>
                  update({
                    skillIds: checked
                      ? [...editor.draft.skillIds, skill.id]
                      : editor.draft.skillIds.filter((id) => id !== skill.id),
                  })
                }
              />
              {skill.name}
            </Label>
          ))}
        </fieldset>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="provided-description">说明（可选）</Label>
          <Textarea
            id="provided-description"
            maxLength={2000}
            disabled={disabled}
            value={editor.draft.description}
            onChange={(event) => update({ description: event.target.value })}
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="provided-instructions">角色指令（可选）</Label>
          <Textarea
            id="provided-instructions"
            maxLength={16000}
            disabled={disabled}
            value={editor.draft.instructions}
            onChange={(event) => update({ instructions: event.target.value })}
          />
        </div>
      </>
    ) : null;
  return (
    <div className="space-y-6" data-provider-assistants>
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {pending ? (
        <Alert variant="info">
          <AlertDescription>
            助手操作结果尚未确认。
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void execute(pending, true, true)}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <div hidden={editor?.kind === "save"} className="space-y-6">
        <SettingsSection
          title="我的助手"
          headerAction={
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
                disabled={disabled || !data}
                onClick={(event) => openSave(null, event.currentTarget)}
              >
                添加个人助手
              </Button>
            </div>
          }
        >
          {!data && !error ? <p role="status">正在读取本人运行来源…</p> : null}
          {!data && error ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null);
                setAttempt((value) => value + 1);
              }}
            >
              重试读取助手
            </Button>
          ) : null}
          <SettingsGroup>
            {data?.items.map(({ preset, shares }) => (
              <SettingsRow
                key={preset.id}
                title={<span className="wrap-anywhere">{preset.name}</span>}
                description={
                  <>
                    <span className="block">{preset.configuration.model.model}</span>
                    <span className="block">
                      {shares
                        .filter((share) => share.enabled)
                        .map(
                          (share) =>
                            host.projects.find((project) => project.id === share.projectId)?.name ??
                            share.projectId,
                        )
                        .join("、") || "仅自己"}
                    </span>
                  </>
                }
                control={
                  <div className="flex items-center gap-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={`编辑个人助手 ${preset.name}`}
                      onClick={(event) => openSave(preset, event.currentTarget)}
                    >
                      编辑
                    </Button>
                    <AssistantEnabledControl
                      name={preset.name}
                      enabled={preset.enabled}
                      busy={busy && pending?.assistantId === preset.id}
                      disabled={disabled}
                      onFocus={(button) => {
                        trigger.current = button;
                      }}
                      onChange={(enabled) => toggle(preset, enabled)}
                    />
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`管理个人助手 ${preset.name}`}
                            ref={(element) => {
                              if (element) menuTriggers.current.set(preset.id, element);
                              else menuTriggers.current.delete(preset.id);
                            }}
                            disabled={disabled}
                            onFocus={(event) => {
                              trigger.current = event.currentTarget;
                            }}
                          />
                        }
                      >
                        <EllipsisIcon />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem
                          onClick={() => {
                            trigger.current = menuTriggers.current.get(preset.id) ?? null;
                            setError(null);
                            setEditor({ kind: "share", preset, projectId: "", enabled: true });
                          }}
                        >
                          共享到项目
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </div>
                }
              />
            ))}
            {data?.items.length === 0 ? (
              <SettingsRow title="尚无个人助手" description="从本人已登记目录和实际能力创建。" />
            ) : null}
          </SettingsGroup>
        </SettingsSection>
        <SettingsSection title="本人运行来源">
          <SettingsGroup>
            {sources.map((value) => (
              <SettingsRow
                key={assistantSourceKey(value.executionBinding)}
                title={`${value.deviceName} · ${value.workspaceName}`}
                description={
                  <>
                    <span className="block">
                      {host.projects.find((project) => project.id === value.sourceProjectId)
                        ?.name ?? value.sourceProjectId}{" "}
                      ·{" "}
                      {value.deviceStatus !== "active" || value.workspaceStatus !== "active"
                        ? "已停用或撤回"
                        : value.online
                          ? "在线"
                          : "离线"}
                    </span>
                    <span className="block">
                      {value.capabilities?.models
                        .map((model) => model.name ?? model.id)
                        .join("、") || "模型能力暂不可用"}
                    </span>
                  </>
                }
              />
            ))}
            {data && sources.length === 0 ? (
              <SettingsRow title="尚无已登记来源" description="连接电脑后在本机登记目录。" />
            ) : null}
          </SettingsGroup>
        </SettingsSection>
        {host.customerAgentsEnabled ? (
          <CustomerDevicesContent embedded />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            电脑接入已暂停，已有助手配置保留。
          </p>
        )}
      </div>
      {editor?.kind === "save" ? (
        <AssistantEditorPage
          title={editor.preset ? "编辑个人助手" : "添加个人助手"}
          value={editor.draft}
          busy={busy}
          pending={!!pending}
          disabled={disabled}
          saveLabel="保存个人助手"
          onSave={save}
          onClose={closeEditor}
        >
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">{saveFields}</div>
        </AssistantEditorPage>
      ) : null}
      <Dialog
        open={editor?.kind === "share"}
        onOpenChange={(open) => {
          if (!open) {
            setEditor(null);
            setError(null);
          }
        }}
      >
        <DialogPopup finalFocus={trigger}>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editor?.kind === "share"
                  ? "项目共享"
                  : editor?.preset
                    ? "编辑个人助手"
                    : "添加个人助手"}
              </DialogTitle>
            </DialogHeader>
            <DialogPanel>
              {error ? (
                <Alert variant="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              {editor?.kind === "share" ? (
                <>
                  <Choice
                    label="共享目标项目"
                    value={editor.projectId}
                    disabled={disabled}
                    options={host.projects.map((project) => ({
                      id: project.id,
                      name: project.name,
                    }))}
                    onChange={(projectId) => {
                      const previous = data?.items
                        .find((item) => item.preset.id === editor.preset.id)
                        ?.shares.find((share) => share.projectId === projectId);
                      setEditor({ ...editor, projectId, enabled: previous?.enabled ?? true });
                    }}
                  />
                  <Label className="flex items-center gap-2">
                    <Checkbox
                      aria-label="共享给此项目"
                      checked={editor.enabled}
                      disabled={disabled}
                      onCheckedChange={(enabled) => setEditor({ ...editor, enabled })}
                    />
                    共享给此项目
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    共享后由该项目管理员分配，使用权不包含设备管理权。
                  </p>
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
              <Button type="submit" disabled={disabled}>
                {editor?.kind === "share" ? "保存共享" : "保存个人助手"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
