import { QuestionSkillsControl } from "./QuestionSkillsControl";
import { questionCanAdjust, questionModelSelection } from "./questionConfiguration";
import { refreshProjectHost } from "./projectDirectory";
import { Button } from "~/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { ScopeReadError } from "./ScopeReadError";
import { BotIcon, EyeIcon, ServerIcon } from "lucide-react";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { ProjectId, ThreadId, ProviderInstanceId, type EnvironmentId } from "@t3tools/contracts";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import { useComposerContextLabelsOverflow } from "~/components/BranchToolbar";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useRightPanelStore } from "~/rightPanelStore";
import { toastManager } from "~/components/ui/toast";
import { ConversationWorkspaceControl } from "./ConversationWorkspaceControl";
import { CustomerExecutionStatus } from "./CustomerExecutionStatus";
import { customerInstanceId, type CustomerRuntime } from "./customerAgents";
import { WorkspaceScopeControl, ScopeComposerChoice } from "./WorkspaceScopeControl";
import { useAutoOpsThreadScope } from "./useThreadScope";
import {
  findAutoOpsThreadScope,
  loadAutoOpsThreadScope,
  readAutoOpsHost,
  readAutoOpsThreadScope,
  reserveAutoOpsThreadScope,
  sameAutoOpsThreadScope,
  setAutoOpsThreadScope,
  type AutoOpsThreadScope,
  scopeFromAssistant,
} from "./hostConfig";

export function AutoOpsThreadScopeControl({
  threadId,
  projectId,
  isDraft,
  runtimeEnvironmentId,
  draftTarget,
  submitting,
  hasAcceptedMessage,
  customerRuntime,
  composerControlsHostRef,
}: {
  threadId: string;
  projectId: string;
  isDraft: boolean;
  runtimeEnvironmentId: EnvironmentId;
  draftTarget: ComposerThreadTarget;
  submitting: boolean;
  hasAcceptedMessage: boolean;
  customerRuntime?: CustomerRuntime | undefined;
  composerControlsHostRef?: (element: HTMLDivElement | null) => void;
}) {
  const host = readAutoOpsHost();
  const scope = useAutoOpsThreadScope(threadId) ?? readAutoOpsThreadScope(threadId, projectId);
  const createThread = useNewThreadHandler();
  const [stripElement, setStripElement] = useState<HTMLDivElement | null>(null);
  const compact = useComposerContextLabelsOverflow(stripElement);
  const [loading, setLoading] = useState(!isDraft);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAttempt, setPendingAttempt] = useState(0);
  const [readAttempt, setReadAttempt] = useState(0);
  const wasSubmitting = useRef(false);
  useEffect(() => {
    if (!isDraft || !scope?.question) return;
    const store = useComposerDraftStore.getState();
    store.setModelSelection(draftTarget, questionModelSelection(scope.question), {
      replaceOptions: true,
    });
    return useComposerDraftStore.subscribe(() => {
      const current = readAutoOpsThreadScope(threadId, projectId);
      if (!current?.question || current.scopeState === "locked" || !questionCanAdjust(current))
        return;
      const saved = useComposerDraftStore.getState().getComposerDraft(draftTarget)
        ?.modelSelectionByProvider?.[
        ProviderInstanceId.make(current.question.configuration.model.instanceId)
      ];
      if (!saved) return;
      const model = {
        instanceId: saved.instanceId,
        model: saved.model,
        reasoningEffort: (saved.options?.find((option) => option.id === "reasoningEffort")?.value ??
          null) as typeof current.question.configuration.model.reasoningEffort,
      };
      if (JSON.stringify(model) !== JSON.stringify(current.question.configuration.model))
        setAutoOpsThreadScope(threadId, {
          ...current,
          question: {
            ...current.question,
            configuration: { ...current.question.configuration, model },
          },
        });
    });
  }, [
    threadId,
    projectId,
    isDraft,
    scope?.question?.assistantId,
    scope?.question?.presetRevision,
    draftTarget,
  ]);
  useEffect(() => {
    if (!host) return;
    if (
      isDraft &&
      !hasAcceptedMessage &&
      scope?.scopeState !== "submitting" &&
      !scope?.scopeLocked
    ) {
      const initial = readAutoOpsThreadScope(threadId, projectId);
      if (initial) setAutoOpsThreadScope(threadId, initial);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void loadAutoOpsThreadScope(threadId, controller.signal)
      .then(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setError(cause instanceof Error ? cause.message : "无法读取对话范围。");
        }
      });
    return () => controller.abort();
  }, [host, threadId, projectId, isDraft, hasAcceptedMessage, readAttempt]);
  useEffect(() => {
    if (submitting) {
      wasSubmitting.current = true;
      return;
    }
    if (!wasSubmitting.current) return;
    wasSubmitting.current = false;
    const controller = new AbortController();
    setLoading(true);
    void findAutoOpsThreadScope(threadId, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const current = readAutoOpsThreadScope(threadId, projectId);
        if (current && !current.scopeLocked)
          setAutoOpsThreadScope(threadId, { ...current, scopeState: "submitting" });
        setLoading(false);
        setError(cause instanceof Error ? cause.message : "正在确认发送结果。");
      });
    return () => controller.abort();
  }, [submitting, threadId, projectId]);
  useEffect(() => {
    if (scope?.scopeState !== "submitting") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void findAutoOpsThreadScope(threadId, controller.signal)
        .then(() => {
          if (controller.signal.aborted) return;
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) {
            setError(cause instanceof Error ? cause.message : "正在确认发送结果。");
            setPendingAttempt((value) => value + 1);
          }
        });
    }, 1200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [threadId, projectId, scope, pendingAttempt]);
  useEffect(() => {
    if (error) toastManager.add({ type: "error", title: "无法更新对话范围", description: error });
  }, [error]);
  if (!host) return null;
  if (!scope)
    return error ? (
      <ComposerSurface.ContextStrip>
        <ScopeReadError
          label="对话范围读取失败"
          error={error}
          busy={loading}
          onRetry={() => setReadAttempt((value) => value + 1)}
        />
      </ComposerSurface.ContextStrip>
    ) : null;
  const project = host.projects.find((entry) => entry.id === projectId);
  if (!project) return null;
  const locked =
    hasAcceptedMessage ||
    scope.scopeLocked === true ||
    scope.scopeState === "locked" ||
    scope.compatibilityReadOnly === true ||
    !!scope.nativeParentThreadId;
  const disabled =
    submitting ||
    loading ||
    changing ||
    scope.scopeState === "submitting" ||
    (!isDraft && error !== null);
  const canAdjust = questionCanAdjust(scope);
  const configLocked = locked || !canAdjust;
  const reconcileUnavailableSkills = (skillIds: string[]) => {
    if (!isDraft || locked || disabled || !canAdjust) return;
    const current = readAutoOpsThreadScope(threadId, projectId);
    if (
      readAutoOpsHost()?.principal.id !== host.principal.id ||
      !current?.question ||
      !sameAutoOpsThreadScope(current, scope) ||
      current.scopeState === "submitting" ||
      current.scopeState === "locked" ||
      current.scopeLocked ||
      current.compatibilityReadOnly ||
      current.nativeParentThreadId ||
      !questionCanAdjust(current)
    )
      return;
    const selected = current.question.configuration.skillIds;
    if (
      skillIds.length >= selected.length ||
      JSON.stringify(selected.filter((id) => skillIds.includes(id))) !== JSON.stringify(skillIds)
    )
      return;
    // 目录整理只移除本草稿的失效选择，不触发用户主动切换所需的新草稿边界。
    setAutoOpsThreadScope(threadId, {
      ...current,
      question: {
        ...current.question,
        configuration: { ...current.question.configuration, skillIds },
      },
    });
  };
  const apply = async (patch: Partial<AutoOpsThreadScope>, loadPresetModel = false) => {
    if (locked || disabled || (!canAdjust && !patch.question)) return;
    const next = { ...scope, ...patch, scopeState: "draft" as const, scopeLocked: false };
    if (next.question)
      next.question = {
        ...next.question,
        configuration: {
          ...next.question.configuration,
          agentId: next.agentId,
          executionBinding: next.executionBinding ?? { kind: "platform" },
          environmentId: next.environmentId,
          workspaceType: next.workspaceType ?? null,
          visibility: next.visibility,
        },
      };
    if (
      next.question &&
      !loadPresetModel &&
      JSON.stringify(next.executionBinding) === JSON.stringify(scope.executionBinding)
    ) {
      const selected = useComposerDraftStore.getState().getComposerDraft(draftTarget)
        ?.modelSelectionByProvider?.[
        ProviderInstanceId.make(next.question.configuration.model.instanceId)
      ];
      if (selected)
        next.question = {
          ...next.question,
          configuration: {
            ...next.question.configuration,
            model: {
              instanceId: selected.instanceId,
              model: selected.model,
              reasoningEffort: (selected.options?.find((option) => option.id === "reasoningEffort")
                ?.value ?? null) as typeof next.question.configuration.model.reasoningEffort,
            },
          },
        };
    }
    const executionChanged =
      JSON.stringify(next.executionBinding ?? { kind: "platform" }) !==
      JSON.stringify(scope.executionBinding ?? { kind: "platform" });
    if (
      patch.question === undefined &&
      !executionChanged &&
      next.workspaceVersionId === scope.workspaceVersionId &&
      next.workspaceType === scope.workspaceType &&
      next.environmentId === scope.environmentId &&
      next.agentId === scope.agentId &&
      next.visibility === scope.visibility &&
      JSON.stringify(next.question) === JSON.stringify(scope.question)
    )
      return;
    const boundaryChanged =
      executionChanged ||
      next.agentId !== scope.agentId ||
      JSON.stringify(next.question?.configuration.skillIds) !==
        JSON.stringify(scope.question?.configuration.skillIds) ||
      next.workspaceVersionId !== scope.workspaceVersionId ||
      next.workspaceType !== scope.workspaceType ||
      next.environmentId !== scope.environmentId;
    setChanging(true);
    setError(null);
    try {
      const store = useComposerDraftStore.getState();
      const updateModel = async (
        target: ComposerThreadTarget,
        targetThreadId: string,
        initialize = false,
      ) => {
        if (!executionChanged && !loadPresetModel && !initialize) return;
        if (next.question) {
          store.setModelSelection(target, questionModelSelection(next.question), {
            replaceOptions: true,
          });
          return;
        }
        if (!executionChanged) return;
        const latest = readAutoOpsThreadScope(targetThreadId, projectId);
        if (!latest || !sameAutoOpsThreadScope(latest, next)) return;
        store.setModelSelection(
          target,
          next.executionBinding?.kind === "customer"
            ? { instanceId: customerInstanceId(next.executionBinding), model: "" }
            : {
                instanceId: ProviderInstanceId.make(host.fixedModel.instanceId),
                model: host.fixedModel.model,
              },
          { replaceOptions: true },
        );
      };
      const threadRef = scopeThreadRef(runtimeEnvironmentId, ThreadId.make(threadId));
      const hasPreview =
        (useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.surfaces.length ??
          0) > 0;
      if (
        boundaryChanged &&
        (composerDraftHasUserContent(store.getComposerDraft(draftTarget)) || hasPreview || !isDraft)
      ) {
        const created = await createThread(
          scopeProjectRef(runtimeEnvironmentId, ProjectId.make(projectId)),
          { envMode: "local", forceNew: true },
        );
        if (created) {
          setAutoOpsThreadScope(created.threadId, {
            ...(next.executionBinding ? { executionBinding: next.executionBinding } : {}),
            ...(next.question ? { question: next.question } : {}),
            projectId: next.projectId,
            environmentId: next.environmentId,
            agentId: next.agentId,
            visibility: next.visibility,
            ...(next.workspaceType ? { workspaceType: next.workspaceType } : {}),
          });
          await updateModel(created.draftId, created.threadId, true);
          toastManager.add({
            type: "info",
            title: "已新建干净草稿",
            description: "原草稿及其资料引用保留在侧栏，可随时返回。",
          });
        }
      } else {
        if (!isDraft) await reserveAutoOpsThreadScope(threadId, next);
        else setAutoOpsThreadScope(threadId, next);
        await updateModel(draftTarget, threadId);
        if (boundaryChanged) useRightPanelStore.getState().closeAllSurfaces(threadRef);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法切换对话范围，请重试。");
    }
    setChanging(false);
  };
  const environment = project.environments.find((entry) => entry.id === scope.environmentId);
  const agent = project.agents.find((entry) => entry.id === scope.agentId);
  return (
    <ComposerSurface.ContextStrip
      className="flex-col items-stretch gap-1"
      data-compact={compact ? "" : undefined}
      data-autoops-thread-scope
      data-scope-state={locked ? "locked" : disabled ? "submitting" : "draft"}
    >
      <div ref={setStripElement} className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 max-w-full flex-initial flex-wrap items-center gap-1">
          {host.assistantDirectoryEnabled ? (
            <ScopeComposerChoice
              label="助手"
              labelWidth={10}
              keepSummaryVisible
              summary={
                project.assistants?.items.find(
                  (item) => item.preset.id === scope.question?.assistantId,
                )?.preset.name ?? (locked ? "既有助手" : "请选择助手")
              }
              icon={BotIcon}
              value={scope.question?.assistantId ?? ""}
              options={
                project.assistants?.items.map((item) => ({
                  value: item.preset.id,
                  label: item.available
                    ? item.preset.name
                    : `${item.preset.name} · ${item.reason?.message ?? "暂不可用"}`,
                  disabled: !item.available,
                })) ?? []
              }
              locked={
                locked ||
                (!canAdjust &&
                  !!scope.question &&
                  (project.assistants?.items.filter((item) => item.available).length ?? 0) <= 1)
              }
              lockReason={!canAdjust && !locked ? "由项目管理员分配" : undefined}
              disabled={disabled}
              onChange={(id) => {
                const preset = project.assistants?.items.find(
                  (item) => item.preset.id === id && item.available,
                )?.preset;
                if (preset) void apply(scopeFromAssistant(preset), true);
              }}
            />
          ) : null}
          {host.assistantDirectoryEnabled && scope.executionBinding?.kind !== "customer" ? (
            <ScopeComposerChoice
              label="资料范围"
              labelWidth={6}
              summary={scope.workspaceType === "external" ? "外部当前资料" : "内部当前资料"}
              icon={EyeIcon}
              value={scope.workspaceType ?? "internal"}
              options={
                project.membership?.workspaceAccess === "external"
                  ? [{ value: "external", label: "外部当前资料" }]
                  : [
                      { value: "internal", label: "内部当前资料" },
                      { value: "external", label: "外部当前资料" },
                    ]
              }
              locked={configLocked}
              lockReason={!canAdjust && !locked ? "由项目管理员设置" : undefined}
              disabled={disabled}
              onChange={(value) =>
                void apply({
                  workspaceType: value as "internal" | "external",
                  workspaceVersionId: undefined,
                })
              }
            />
          ) : host.assistantDirectoryEnabled && scope.executionBinding?.kind === "customer" ? (
            <ScopeComposerChoice
              label="运行位置"
              summary="已登记电脑目录"
              icon={EyeIcon}
              value="customer"
              options={[]}
              locked
              disabled={disabled}
              onChange={() => {}}
            />
          ) : (
            <>
              {host.customerAgentsEnabled || scope.executionBinding?.kind === "customer" ? (
                <ConversationWorkspaceControl
                  projectId={projectId}
                  scope={scope}
                  locked={locked}
                  disabled={disabled}
                  onChange={(patch) => void apply(patch)}
                />
              ) : (
                <WorkspaceScopeControl
                  projectId={projectId}
                  scope={scope}
                  locked={locked}
                  disabled={disabled}
                  onChange={(type) =>
                    void apply({ workspaceType: type, workspaceVersionId: undefined })
                  }
                />
              )}
            </>
          )}
          <ScopeComposerChoice
            label="业务环境"
            summary={scope.environmentId === null ? "无环境" : (environment?.name ?? "环境不可用")}
            icon={ServerIcon}
            value={scope.environmentId ?? "__none__"}
            options={[
              { value: "__none__", label: "无环境" },
              ...project.environments.map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            locked={configLocked || scope.executionBinding?.kind === "customer"}
            lockReason={!canAdjust && !locked ? "由项目管理员设置" : undefined}
            disabled={disabled}
            onChange={(value) => void apply({ environmentId: value === "__none__" ? null : value })}
          />
          <ScopeComposerChoice
            label="会话可见范围"
            labelWidth={3}
            summary={scope.visibility === "private" ? "仅自己" : "项目共享"}
            icon={EyeIcon}
            value={scope.visibility}
            options={
              scope.executionBinding?.kind === "customer"
                ? [{ value: "private", label: "仅自己" }]
                : [
                    { value: "private", label: "仅自己" },
                    { value: "project", label: "项目共享" },
                  ]
            }
            locked={configLocked || scope.executionBinding?.kind === "customer"}
            lockReason={!canAdjust && !locked ? "由项目管理员设置" : undefined}
            disabled={disabled}
            onChange={(value) => {
              if (value === "private" || value === "project") void apply({ visibility: value });
            }}
          />
          {host.assistantDirectoryEnabled ? (
            <QuestionSkillsControl
              scope={scope}
              customerRuntime={customerRuntime}
              locked={configLocked}
              disabled={disabled}
              onReconcileUnavailable={reconcileUnavailableSkills}
              onChange={(skillIds) => {
                if (scope.question)
                  void apply({
                    question: {
                      ...scope.question,
                      configuration: { ...scope.question.configuration, skillIds },
                    },
                  });
              }}
            />
          ) : null}
          {!host.assistantDirectoryEnabled && scope.executionBinding?.kind !== "customer" ? (
            <ScopeComposerChoice
              label="项目助手"
              summary={agent?.name ?? "助手不可用"}
              icon={BotIcon}
              value={scope.agentId}
              options={project.agents.map((entry) => ({ value: entry.id, label: entry.name }))}
              locked={locked}
              disabled={disabled}
              onChange={(value) => void apply({ agentId: value })}
            />
          ) : null}
        </div>
        {locked && scope.executionBinding?.kind === "customer" ? (
          <CustomerExecutionStatus threadId={threadId} />
        ) : null}
        {composerControlsHostRef ? (
          <div
            ref={composerControlsHostRef}
            data-composer-context-control
            data-chat-resting-composer-controls-host="true"
            className="flex min-w-0 flex-1 items-center justify-start overflow-x-clip overflow-y-visible"
          />
        ) : null}
        {error ? (
          <ScopeReadError
            label="对话范围读取失败"
            error={error}
            busy={loading}
            onRetry={() => {
              if (scope.scopeState === "submitting") setPendingAttempt((value) => value + 1);
              else setReadAttempt((value) => value + 1);
            }}
          />
        ) : null}
      </div>
      {host.assistantDirectoryEnabled &&
      (!project.assistants?.ready || !scope.question) &&
      !locked ? (
        <div role="status" className="flex min-w-0 items-center gap-2 px-1 text-xs">
          <span className="min-w-0 flex-1 break-words">
            {project.assistants?.reason?.message ?? "请选择助手"}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void refreshProjectHost().catch((cause) => setError(cause.message))}
          >
            刷新助手
          </Button>
        </div>
      ) : null}
    </ComposerSurface.ContextStrip>
  );
}
