import { decodeContract } from '../../../../../../autoops/contracts/index.ts'
import {
  DirectoryCommand,
  DirectoryId,
} from '../../../../../../autoops/contracts/project-directory.ts'
import {
  SaveAssistantCommand,
  ShareProvidedAssistantCommand,
} from "../../../../../../autoops/contracts/assistants.ts";
import type {
  AssistantDetails,
  AssistantPreset,
  ProvidedAssistantSettings,
  ProvidedAssistantShare,
  ProjectProvidedAssistants,
  ProvidedAssistantReceipt,
} from "../../../../../../autoops/contracts/assistants.ts";
import { randomUUID } from "~/lib/utils";
import { autoOpsRequest, AutoOpsRequestError } from "./apiClient";
import { autoOpsStorageKey, readAutoOpsHost } from "./hostSnapshot";
export type {
  AssistantDetails,
  AssistantPreset,
  ProvidedAssistantSettings,
  ProvidedAssistantShare,
  ProjectProvidedAssistants,
};
export type ProvidedAssistantWriteResult =
  | AssistantPreset
  | { deleted: true; id: string; projectId: string; revision: number }
  | ProvidedAssistantShare
  | { saved: true; available: false };
const base = "/api/v1/assistants/provided";
export const loadProvidedAssistants = (signal?: AbortSignal) =>
  autoOpsRequest<ProvidedAssistantSettings>(base, {
    label: "我提供的助手",
    ...(signal ? { signal } : {}),
  });
export const loadProjectProvidedAssistants = (project: string, signal?: AbortSignal) =>
  autoOpsRequest<ProjectProvidedAssistants>(
    `/api/v1/projects/${encodeURIComponent(project)}/assistants/provided`,
    { label: "项目获共享助手", ...(signal ? { signal } : {}) },
  );
export type PendingProvidedAssistant = { version: 1; actorId: string } & (
  | {
      kind: "save";
      assistantId: string | null;
      sourceProjectId: string;
      input: { requestId: string; expectedRevision: number; value: AssistantDetails };
    }
  | {
      kind: "delete";
      assistantId: string;
      sourceProjectId: string;
      input: { requestId: string; expectedRevision: number };
    }
  | {
      kind: "share";
      assistantId: string;
      projectId: string;
      input: { requestId: string; expectedRevision: number; enabled: boolean };
    }
);
const actor = () => {
  const id = readAutoOpsHost()?.principal.id;
  if (!id) throw new AutoOpsRequestError("登录上下文不可用。", "HOST_UNAVAILABLE", 401);
  return id;
};
const key = () => autoOpsStorageKey("provided-assistants:pending");
const invalid = () =>
  new AutoOpsRequestError(
    "原助手操作尚未确认，请核对原请求。",
    "ASSISTANT_PENDING_INVALID",
    undefined,
    true,
  );
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)),
        )
      : entry,
  );
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function validate(value: unknown): PendingProvidedAssistant {
  const entry = object(value);
  if (entry.version !== 1 || entry.actorId !== actor()) throw invalid();
  if (entry.assistantId !== null) decodeContract(DirectoryId, entry.assistantId);
  const allowed =
    entry.kind === 'save' || entry.kind === 'delete'
      ? ['version', 'actorId', 'kind', 'assistantId', 'sourceProjectId', 'input']
      : ['version', 'actorId', 'kind', 'assistantId', 'projectId', 'input']
  if (Object.keys(entry).some((key) => !allowed.includes(key))) throw invalid()
  if (entry.kind === 'delete' && typeof entry.assistantId === 'string') {
    decodeContract(DirectoryId, entry.sourceProjectId)
    return {
      version: 1,
      actorId: entry.actorId as string,
      kind: "delete",
      assistantId: entry.assistantId,
      sourceProjectId: entry.sourceProjectId as string,
      input: decodeContract(DirectoryCommand, entry.input),
    };
  }
  if (entry.kind === "save") {
    decodeContract(DirectoryId, entry.sourceProjectId);
    const input = decodeContract(SaveAssistantCommand, entry.input);
    if (input.value.configuration.executionBinding.kind !== "customer") throw invalid();
    return {
      version: 1,
      actorId: entry.actorId as string,
      kind: "save",
      assistantId: entry.assistantId as string | null,
      sourceProjectId: entry.sourceProjectId as string,
      input,
    };
  }
  if (entry.kind === "share" && typeof entry.assistantId === "string") {
    decodeContract(DirectoryId, entry.projectId);
    return {
      version: 1,
      actorId: entry.actorId as string,
      kind: "share",
      assistantId: entry.assistantId,
      projectId: entry.projectId as string,
      input: decodeContract(ShareProvidedAssistantCommand, entry.input),
    };
  }
  throw invalid();
}
export function readPendingProvidedAssistant(): PendingProvidedAssistant | null {
  const value = sessionStorage.getItem(key());
  if (value === null) return null;
  try {
    return validate(JSON.parse(value));
  } catch {
    throw invalid();
  }
}
function prepare(value: object): PendingProvidedAssistant {
  if (readPendingProvidedAssistant())
    throw new AutoOpsRequestError("请先核对上一次助手操作。", "ASSISTANT_PENDING", 409);
  let pending: PendingProvidedAssistant;
  try {
    pending = validate({ ...value, version: 1, actorId: actor() });
  } catch {
    throw new AutoOpsRequestError(
      "请核对助手名称、运行来源与模型参数。",
      "ASSISTANT_INPUT_INVALID",
      400,
    );
  }
  sessionStorage.setItem(key(), JSON.stringify(pending));
  return pending;
}
export function prepareProvidedSave(
  assistantId: string | null,
  sourceProjectId: string,
  expectedRevision: number,
  value: AssistantDetails,
) {
  return prepare({
    kind: "save",
    assistantId,
    sourceProjectId,
    input: { requestId: randomUUID(), expectedRevision, value },
  });
}
export function prepareProvidedDelete(preset: AssistantPreset) {
  return prepare({
    kind: 'delete',
    assistantId: preset.id,
    sourceProjectId: preset.projectId,
    input: { requestId: randomUUID(), expectedRevision: preset.revision },
  })
}
export function prepareProvidedShare(
  assistantId: string,
  projectId: string,
  expectedRevision: number,
  enabled: boolean,
) {
  return prepare({
    kind: "share",
    assistantId,
    projectId,
    input: { requestId: randomUUID(), expectedRevision, enabled },
  });
}
export function clearPendingProvidedAssistant(pending: PendingProvidedAssistant) {
  if (actor() !== pending.actorId) throw new DOMException("登录上下文已改变", "AbortError");
  if (readPendingProvidedAssistant()?.input.requestId === pending.input.requestId)
    sessionStorage.removeItem(key());
}
function checked(pending: PendingProvidedAssistant, value: unknown): ProvidedAssistantWriteResult {
  const result = object(value)
  if (result.saved === true && result.available === false) return { saved: true, available: false }
  if (result.revision !== pending.input.expectedRevision + 1) throw invalid()
  if (
    pending.kind === "share" &&
    result.assistantId === pending.assistantId &&
    result.projectId === pending.projectId &&
    result.enabled === pending.input.enabled
  )
    return value as ProvidedAssistantShare;
  if (
    pending.kind === "save" &&
    typeof result.id === "string" &&
    (pending.assistantId === null || result.id === pending.assistantId) &&
    result.projectId === pending.sourceProjectId
  )
    return value as AssistantPreset;
  throw invalid();
}
export async function submitProvidedAssistant(
  pending: PendingProvidedAssistant,
  signal?: AbortSignal,
) {
  const fixed = validate(pending);
  const suffix =
    fixed.kind === "share"
      ? `/${encodeURIComponent(fixed.assistantId)}/shares/${encodeURIComponent(fixed.projectId)}`
      : fixed.assistantId
        ? `/${encodeURIComponent(fixed.assistantId)}`
        : "";
  try {
    const result = checked(
      fixed,
      await autoOpsRequest<unknown>(base + suffix, {
        label: "助手配置",
        body: fixed.input,
        ...(fixed.kind === 'delete' ? { method: 'DELETE' as const } : {}),
        ...(signal ? { signal } : {}),
      }),
    );
    clearPendingProvidedAssistant(fixed);
    return result;
  } catch (cause) {
    if (cause instanceof AutoOpsRequestError && !cause.uncertain)
      clearPendingProvidedAssistant(fixed);
    throw cause;
  }
}
export async function recoverProvidedAssistant(
  pending: PendingProvidedAssistant,
  signal?: AbortSignal,
): Promise<ProvidedAssistantWriteResult | null> {
  const fixed = validate(pending);
  try {
    const receipt = await autoOpsRequest<ProvidedAssistantReceipt>(
      `${base}/receipts/${encodeURIComponent(fixed.input.requestId)}`,
      { label: "助手原请求收据", ...(signal ? { signal } : {}) },
    );
    const operation =
      fixed.kind === 'delete'
        ? `provider.preset.delete:${fixed.assistantId}`
        : fixed.kind === 'share'
          ? `provider.share:${fixed.assistantId}`
          : `provider.preset.save:${fixed.assistantId ?? 'new'}`
    if (
      receipt.requestId !== fixed.input.requestId ||
      receipt.operation !== operation ||
      receipt.projectId !== (fixed.kind === "share" ? fixed.projectId : fixed.sourceProjectId)
    )
      throw invalid();
    let payload: unknown;
    try {
      payload =
        fixed.kind === 'delete'
          ? decodeContract(DirectoryCommand, receipt.payload)
          : fixed.kind === 'share'
            ? decodeContract(ShareProvidedAssistantCommand, receipt.payload)
            : decodeContract(SaveAssistantCommand, receipt.payload)
    } catch {
      throw invalid();
    }
    if (stable(payload) !== stable(fixed.input))
      throw new AutoOpsRequestError(
        "原请求已保存为其他参数，请核对原操作，不能覆盖。",
        "ASSISTANT_REQUEST_CONFLICT",
        409,
        true,
      );
    const result = checked(fixed, receipt.result);
    clearPendingProvidedAssistant(fixed);
    return result;
  } catch (cause) {
    if (
      cause instanceof AutoOpsRequestError &&
      cause.status === 404 &&
      cause.code === "ASSISTANT_PROVIDER_RECEIPT_NOT_FOUND"
    )
      return null;
    if (cause instanceof AutoOpsRequestError && [401, 403, 404].includes(cause.status ?? 0))
      clearPendingProvidedAssistant(fixed);
    throw cause;
  }
}
