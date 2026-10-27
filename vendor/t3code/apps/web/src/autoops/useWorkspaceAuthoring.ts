import { useEffect, useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { AutoOpsRequestError, isAutoOpsAccessError } from "./apiClient";
import { readAutoOpsHost } from "./hostConfig";
import { useWorkspaceRequestRecovery } from "./useWorkspaceRequestRecovery";
import {
  authoringDigest,
  inspectAuthoringRequest,
  loadAuthoring,
  loadAuthoringCredentials,
  submitAuthoring,
  uploadAuthoringFile,
  type AuthoringCommand,
  type AuthoringReceipt,
  type AuthoringSubmission,
  type WorkspaceAuthoringOverview,
  type WorkspaceCredentialMetadata,
} from "./workspaceAuthoring";

type Pending = {
  requestId: string;
  expectedRevision: number;
  digest: string | null;
  digestVersion: 2;
  hasSecretInput: boolean;
  kind: AuthoringCommand["kind"];
  label: string;
};
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : "操作未完成，请重试。";
const labels = {
  source: "保存源码来源",
  credential: "保存仓库凭证",
  document: "修改资料",
  upload: "上传资料",
  version: "更新固定版本",
  sync: "同步源码",
};
const credentialRecoveryNotice = "请重新填写刚才的凭证后重试。";
export function readAuthoringPending(key: string): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as Pending | null;
    if (!(
      value &&
      typeof value.requestId === "string" &&
      value.requestId.length <= 160 &&
      Number.isSafeInteger(value.expectedRevision) &&
      ((typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest)) ||
        (value.kind === "credential" && value.digestVersion === 2 && value.digest === null)) &&
      Object.hasOwn(labels, value.kind)
    ))
      return null;
    const result: Pending = {
      requestId: value.requestId,
      expectedRevision: value.expectedRevision,
      digest: value.kind === "credential" && value.digestVersion !== 2 ? null : value.digest,
      digestVersion: 2,
      hasSecretInput:
        value.kind === "credential" && (value.digestVersion !== 2 || value.hasSecretInput === true),
      kind: value.kind,
      label: labels[value.kind],
    };
    // 旧凭证摘要可能包含秘密，迁移时只保留原收据标识，不能保留该摘要作比较。
    if (value.kind === "credential" && value.digestVersion !== 2)
      sessionStorage.setItem(key, JSON.stringify(result));
    return result;
  } catch {
    return null;
  }
}

/** 收据按账号和项目隔离；完整输入及文件只在本次页面内存中保留。 */
export function useWorkspaceAuthoring(
  projectId: string,
  canManage: boolean,
  onTask: (receipt: AuthoringReceipt) => void,
  refreshKey = "",
) {
  const principal = readAutoOpsHost()?.principal.id ?? "";
  const storageKey = `autoops:workspace-authoring:${principal}:${projectId}`;
  const [overview, setOverview] = useState<WorkspaceAuthoringOverview | null>(null);
  const overviewRef = useRef(overview);
  const [credentials, setCredentials] = useState<WorkspaceCredentialMetadata[]>([]);
  const [pending, setPending] = useState(() => readAuthoringPending(storageKey));
  const [error, setError] = useState<string | null>(
    pending?.hasSecretInput ? credentialRecoveryNotice : null,
  );
  const [busy, setBusy] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const pendingRef = useRef(pending);
  const retryInput = useRef<{
    submission: AuthoringSubmission;
    file?: File;
    originalSecretKnown: boolean;
  } | null>(
    pending?.kind === "sync"
      ? {
          submission: {
            requestId: pending.requestId,
            expectedRevision: pending.expectedRevision,
            command: { kind: "sync" },
          },
          originalSecretKnown: true,
        }
      : null,
  );
  const [progress, setProgress] = useState<number | null>(null);
  const [lastOutcome, setLastOutcome] = useState<{
    digest: string | null;
    result: AuthoringReceipt;
  } | null>(null);
  const [generation, setGeneration] = useState(0);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const reader = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const accepted = useRef(onTask);
  accepted.current = onTask;
  const currentScope = () => mounted.current && readAutoOpsHost()?.principal.id === principal;
  const refresh = () => {
    setError(null);
    setGeneration((value) => value + 1);
  };
  const clearData = () => {
    setAccessDenied(true);
    reader.current?.abort();
    setOverview(null);
    overviewRef.current = null;
    setCredentials([]);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    reader.current = abort;
    void loadAuthoring(projectId, abort.signal)
      .then((result) => {
        if (abort.signal.aborted || !currentScope()) return;
        if (result.projectId !== projectId) throw new Error("资料返回了其他项目，已停止显示。");
        if (overviewRef.current && result.revision < overviewRef.current.revision) return;
        overviewRef.current = result;
        setAccessDenied(false);
        setOverview(result);
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted || !currentScope()) return;
        if (isAutoOpsAccessError(cause)) clearData();
        setError(errorText(cause));
      });
    if (canManage)
      void loadAuthoringCredentials(projectId, abort.signal)
        .then((result) => {
          if (!abort.signal.aborted && currentScope()) setCredentials(result.credentials);
        })
        .catch((cause: unknown) => {
          if (!abort.signal.aborted && currentScope()) {
            if (isAutoOpsAccessError(cause)) clearData();
            setCredentials([]);
            setError(errorText(cause));
          }
        });
    return () => abort.abort();
  }, [projectId, principal, generation, canManage, refreshKey]);

  const remember = (value: Pending) => {
    sessionStorage.setItem(storageKey, JSON.stringify(value));
    pendingRef.current = value;
    setPending(value);
  };
  const clear = () => {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* 原标识仍可安全重复核对。 */
    }
    pendingRef.current = null;
    retryInput.current = null;
    setPending(null);
  };
  const confirm = (receipt: AuthoringReceipt, requestId: string) => {
    if (receipt.requestId !== requestId) throw new Error("收据与原请求不一致，请继续核对。");
    if ("revision" in receipt && overviewRef.current) {
      overviewRef.current = { ...overviewRef.current, revision: receipt.revision };
    }
    if (pendingRef.current) setLastOutcome({ digest: pendingRef.current.digest, result: receipt });
    clear();
    setError(null);
    refresh();
    accepted.current(receipt);
    return receipt;
  };
  const perform = async (
    command?: AuthoringCommand,
    file?: File,
    checkOnly = false,
  ): Promise<AuthoringReceipt | null> => {
    if (locked.current || !currentScope()) return null;
    if (!canManage && !checkOnly) {
      setError("当前账号只可阅读资料。");
      return null;
    }
    locked.current = true;
    setBusy(true);
    setError(null);
    const abort = new AbortController();
    controller.current = abort;
    let sending = false;
    try {
      let active = pendingRef.current;
      if (active) {
        const previous = retryInput.current?.submission.command;
        if (
          command &&
          (active.kind !== command.kind ||
            (active.digest !== null && active.digest !== authoringDigest(command)))
        )
          throw new Error("上次操作还在确认中，请稍后再修改。");
        if (
          command?.kind === "credential" &&
          command.action === "save" &&
          previous?.kind === "credential" &&
          previous.action === "save" &&
          command.secret !== previous.secret
        )
          throw new Error("上次凭证还在确认中，请暂时保留刚才填写的内容。");
        const restoredCredential =
          active.hasSecretInput && !retryInput.current?.originalSecretKnown;
        const receipt = await inspectAuthoringRequest(
          projectId,
          active.requestId,
          active.kind === "credential",
          abort.signal,
        );
        if (!currentScope()) return null;
        if (receipt) {
          const confirmed = confirm(receipt, active.requestId);
          if (restoredCredential) {
            setError("上次凭证已保存。如需更换，请再次保存。");
            return null;
          }
          return confirmed;
        }
        if (checkOnly) {
          return null;
        }
        if (command) {
          retryInput.current = {
            submission: {
              requestId: active.requestId,
              expectedRevision: active.expectedRevision,
              command: { ...command },
            },
            originalSecretKnown: !restoredCredential,
            ...(file ? { file } : {}),
          };
        }
      } else {
        if (!command || checkOnly) return null;
        const revision = overviewRef.current?.revision;
        if (revision === undefined) throw new Error("资料尚未加载，请刷新后重试。");
        active = {
          requestId: randomUUID(),
          expectedRevision: revision,
          digest: authoringDigest(command),
          digestVersion: 2,
          hasSecretInput: command.kind === "credential" && command.action === "save",
          kind: command.kind,
          label: labels[command.kind],
        };
        try {
          remember(active);
        } catch {
          throw new Error("无法保存操作收据，请允许浏览器存储后重试。");
        }
        retryInput.current = {
          submission: {
            requestId: active.requestId,
            expectedRevision: revision,
            command: { ...command },
          },
          originalSecretKnown: true,
          ...(file ? { file } : {}),
        };
      }
      const retry = retryInput.current;
      if (!retry) throw new Error("请重新选择刚才的文件或填写刚才的内容后重试。");
      sending = true;
      const receipt =
        retry.submission.command.kind === "upload"
          ? await uploadAuthoringFile(
              projectId,
              retry.submission,
              retry.file!,
              (value) => {
                if (currentScope()) setProgress(value);
              },
              abort.signal,
            )
          : await submitAuthoring(projectId, retry.submission, abort.signal);
      if (!currentScope()) return null;
      return confirm(receipt, active.requestId);
    } catch (cause) {
      if (!currentScope()) return null;
      if (isAutoOpsAccessError(cause)) clearData();
      if (
        cause instanceof AutoOpsRequestError &&
        !cause.uncertain &&
        cause.code !== "CREDENTIAL_REQUEST_CONFLICT" &&
        (sending || cause.code === "CAPTURE_FAILED")
      )
        clear();
      setError(cause instanceof AutoOpsRequestError && cause.uncertain ? null : errorText(cause));
      return null;
    } finally {
      locked.current = false;
      if (currentScope()) {
        setBusy(false);
        setProgress(null);
      }
      controller.current = null;
    }
  };
  const recoveryPaused = useWorkspaceRequestRecovery(pending?.requestId, busy, () =>
    perform(undefined, undefined, true),
  );
  return {
    overview,
    accessDenied,
    credentials,
    error,
    recoveryPaused,
    busy,
    pending,
    progress,
    retryAvailable: !!retryInput.current,
    lastOutcome,
    hasPending: () => pendingRef.current !== null,
    refresh,
    clearError: () => setError(null),
    denyRead: (cause: unknown) => {
      if (currentScope()) {
        clearData();
        setError(errorText(cause));
      }
    },
    submit: (command: AuthoringCommand, file?: File) => perform(command, file),
    check: () => perform(undefined, undefined, true),
    retry: () => perform(),
    cancelTransfer: () => controller.current?.abort(),
  };
}
export type WorkspaceAuthoringController = ReturnType<typeof useWorkspaceAuthoring>;
