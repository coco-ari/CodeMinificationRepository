import { useEffect, useRef, useState } from "react";
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
import { customerInstanceId, loadCustomerCapabilities } from "./customerAgents";
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
} from "./hostConfig";

export function AutoOpsThreadScopeControl({
  threadId,
  projectId,
  isDraft,
  runtimeEnvironmentId,
  draftTarget,
  submitting,
  hasAcceptedMessage,
  composerControlsHostRef,
}: {
  threadId: string;
  projectId: string;
  isDraft: boolean;
  runtimeEnvironmentId: EnvironmentId;
  draftTarget: ComposerThreadTarget;
  submitting: boolean;
  hasAcceptedMessage: boolean;
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
  const wasSubmitting = useRef(false);
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
    void loadAutoOpsThreadScope(threadId, controller.signal)
      .then(() => {
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
  }, [host, threadId, projectId, isDraft, hasAcceptedMessage]);
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
  if (!host || !scope) return null;
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
  const apply = async (patch: Partial<AutoOpsThreadScope>) => {
    if (locked || disabled) return;
    const next = { ...scope, ...patch, scopeState: "draft" as const, scopeLocked: false };
    const executionChanged =
      JSON.stringify(next.executionBinding ?? { kind: "platform" }) !==
      JSON.stringify(scope.executionBinding ?? { kind: "platform" });
    if (
      !executionChanged &&
      next.workspaceVersionId === scope.workspaceVersionId &&
      next.workspaceType === scope.workspaceType &&
      next.environmentId === scope.environmentId &&
      next.agentId === scope.agentId &&
      next.visibility === scope.visibility
    )
      return;
    const boundaryChanged =
      executionChanged ||
      next.workspaceVersionId !== scope.workspaceVersionId ||
      next.workspaceType !== scope.workspaceType ||
      next.environmentId !== scope.environmentId;
    setChanging(true);
    setError(null);
    try {
      const store = useComposerDraftStore.getState();
      const updateModel = async (target: ComposerThreadTarget, targetThreadId: string) => {
        if (!executionChanged) return;
        if (next.executionBinding?.kind === "customer") {
          const catalog = await loadCustomerCapabilities(next.executionBinding);
          const latest = readAutoOpsThreadScope(targetThreadId, projectId);
          if (!latest || !sameAutoOpsThreadScope(latest, next)) return;
          if (catalog?.models[0])
            store.setModelSelection(
              target,
              {
                instanceId: customerInstanceId(next.executionBinding),
                model: catalog.models[0].id,
              },
              { replaceOptions: true },
            );
        } else
          store.setModelSelection(
            target,
            {
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
            projectId: next.projectId,
            environmentId: next.environmentId,
            agentId: next.agentId,
            visibility: next.visibility,
            ...(next.workspaceType ? { workspaceType: next.workspaceType } : {}),
          });
          await updateModel(created.draftId, created.threadId);
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
      ref={setStripElement}
      data-compact={compact ? "" : undefined}
      data-autoops-thread-scope
      data-scope-state={locked ? "locked" : disabled ? "submitting" : "draft"}
    >
      <div className="flex min-w-0 flex-initial items-center gap-1">
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
            onChange={(type) => void apply({ workspaceType: type, workspaceVersionId: undefined })}
          />
        )}
        <ScopeComposerChoice
          label="业务环境"
          summary={environment?.name ?? "环境不可用"}
          icon={ServerIcon}
          value={scope.environmentId}
          options={project.environments.map((entry) => ({ value: entry.id, label: entry.name }))}
          locked={locked}
          disabled={disabled}
          onChange={(value) => void apply({ environmentId: value })}
        />
        <ScopeComposerChoice
          label="会话可见范围"
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
          locked={locked}
          disabled={disabled}
          onChange={(value) => {
            if (value === "private" || value === "project") void apply({ visibility: value });
          }}
        />
        {scope.executionBinding?.kind !== "customer" ? (
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
        <span role="alert" className="sr-only">
          {error}
        </span>
      ) : null}
    </ComposerSurface.ContextStrip>
  );
}
