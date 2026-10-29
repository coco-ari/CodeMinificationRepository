import { decodeContract } from "../../../../../../autoops/contracts/index.ts";
import { DirectoryId } from "../../../../../../autoops/contracts/project-directory.ts";
import {
  EnvironmentMcpCommand,
  EnvironmentMcpConfiguration as ConfigurationContract,
  SaveEnvironmentMcp,
  SetEnvironmentMcpEnabled,
} from "../../../../../../autoops/contracts/environment-mcp.ts";
import type {
  EnvironmentMcpConfiguration,
  EnvironmentMcpConnection,
  EnvironmentMcpReceipt,
  EnvironmentMcpDeletion,
  EnvironmentMcpTestResult,
} from "../../../../../../autoops/contracts/environment-mcp.ts";
import { randomUUID } from "~/lib/utils";
import { autoOpsRequest, AutoOpsRequestError } from "./apiClient";
import { autoOpsStorageKey, readAutoOpsHost } from "./hostSnapshot";

export type { EnvironmentMcpConfiguration, EnvironmentMcpConnection, EnvironmentMcpTestResult };
export type EnvironmentMcpMutation =
  | {
      kind: "save";
      connectionId?: string;
      input: { requestId: string; expectedRevision: number; value: EnvironmentMcpConfiguration };
    }
  | {
      kind: "test" | "remove";
      connectionId: string;
      input: { requestId: string; expectedRevision: number };
    }
  | {
      kind: "enabled";
      connectionId: string;
      input: { requestId: string; expectedRevision: number; enabled: boolean };
    };
export interface PendingEnvironmentMcp {
  version: 1;
  actorId: string;
  projectId: string;
  environmentId: string;
  mutation: EnvironmentMcpMutation;
}
export type EnvironmentMcpWriteResult =
  | EnvironmentMcpConnection
  | EnvironmentMcpTestResult
  | EnvironmentMcpDeletion
  | { saved: true; available: false };
export const environmentMcpPath = (project: string, environment: string) =>
  `/api/v1/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(environment)}/mcp`;
const pendingKey = (project: string, environment: string) =>
  autoOpsStorageKey(
    `environment-mcp:pending:${encodeURIComponent(project)}:${encodeURIComponent(environment)}`,
  );
const invalidPending = () =>
  new AutoOpsRequestError(
    "原连接操作记录无效，请先核对原请求，不能重新提交新操作。",
    "ENVIRONMENT_MCP_PENDING_INVALID",
    undefined,
    true,
  );
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidPending();
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw invalidPending();
}
function validatedMutation(value: unknown): EnvironmentMcpMutation {
  const entry = record(value);
  only(entry, ["kind", "connectionId", "input"]);
  try {
    if (entry.connectionId !== undefined) decodeContract(DirectoryId, entry.connectionId);
    if (entry.kind === "save")
      return {
        kind: "save",
        ...(entry.connectionId ? { connectionId: entry.connectionId as string } : {}),
        input: decodeContract(SaveEnvironmentMcp, entry.input),
      };
    if (typeof entry.connectionId !== "string") throw invalidPending();
    if (entry.kind === "enabled")
      return {
        kind: "enabled",
        connectionId: entry.connectionId,
        input: decodeContract(SetEnvironmentMcpEnabled, entry.input),
      };
    if (entry.kind === "test" || entry.kind === "remove")
      return {
        kind: entry.kind,
        connectionId: entry.connectionId,
        input: decodeContract(EnvironmentMcpCommand, entry.input),
      };
  } catch {
    throw invalidPending();
  }
  throw invalidPending();
}
function actor() {
  const id = readAutoOpsHost()?.principal.id;
  if (!id) throw new AutoOpsRequestError("登录上下文不可用，请重新登录。", "HOST_UNAVAILABLE", 401);
  return id;
}
function validatePending(
  value: unknown,
  project: string,
  environment: string,
): PendingEnvironmentMcp {
  const entry = record(value);
  only(entry, ["version", "actorId", "projectId", "environmentId", "mutation"]);
  if (
    entry.version !== 1 ||
    entry.actorId !== actor() ||
    entry.projectId !== project ||
    entry.environmentId !== environment
  )
    throw invalidPending();
  return {
    version: 1,
    actorId: entry.actorId as string,
    projectId: project,
    environmentId: environment,
    mutation: validatedMutation(entry.mutation),
  };
}
export function readPendingEnvironmentMcp(
  project: string,
  environment: string,
): PendingEnvironmentMcp | null {
  const text = window.sessionStorage.getItem(pendingKey(project, environment));
  if (text === null) return null;
  try {
    return validatePending(JSON.parse(text), project, environment);
  } catch {
    throw invalidPending();
  }
}
export function prepareEnvironmentMcpMutation(
  project: string,
  environment: string,
  mutation: Omit<EnvironmentMcpMutation, "input"> & { input: object },
): PendingEnvironmentMcp {
  if (readPendingEnvironmentMcp(project, environment))
    throw new AutoOpsRequestError("请先核对上一次连接操作结果。", "ENVIRONMENT_MCP_PENDING", 409);
  let command: EnvironmentMcpMutation;
  try {
    command = validatedMutation({
      ...mutation,
      input: { ...mutation.input, requestId: randomUUID() },
    });
  } catch {
    throw new AutoOpsRequestError(
      "请核对连接字段及读取范围。",
      "ENVIRONMENT_MCP_INPUT_INVALID",
      400,
    );
  }
  const pending = {
    version: 1 as const,
    actorId: actor(),
    projectId: project,
    environmentId: environment,
    mutation: command,
  };
  window.sessionStorage.setItem(pendingKey(project, environment), JSON.stringify(pending));
  return pending;
}
export function clearPendingEnvironmentMcp(pending: PendingEnvironmentMcp) {
  if (actor() !== pending.actorId) throw new DOMException("登录上下文已经改变", "AbortError");
  const current = readPendingEnvironmentMcp(pending.projectId, pending.environmentId);
  if (current?.mutation.input.requestId === pending.mutation.input.requestId)
    window.sessionStorage.removeItem(pendingKey(pending.projectId, pending.environmentId));
}
export const loadEnvironmentMcp = (project: string, environment: string, signal?: AbortSignal) =>
  autoOpsRequest<{ items: EnvironmentMcpConnection[] }>(environmentMcpPath(project, environment), {
    label: "环境连接",
    ...(signal ? { signal } : {}),
  });
function checkedResult(pending: PendingEnvironmentMcp, value: unknown): EnvironmentMcpWriteResult {
  const result = record(value);
  if (result.saved === true && result.available === false) return { saved: true, available: false };
  const test = pending.mutation.kind === "test";
  let matches = false;
  try {
    matches = !!(
      (test &&
        result.connectionId === pending.mutation.connectionId &&
        result.revision === pending.mutation.input.expectedRevision &&
        result.status === "passed" &&
        typeof result.testedAt === "string" &&
        Array.isArray(result.actions)) ||
      (!test &&
        typeof result.id === "string" &&
        result.projectId === pending.projectId &&
        result.environmentId === pending.environmentId &&
        ((pending.mutation.kind === "save" && !pending.mutation.connectionId) ||
          result.id === pending.mutation.connectionId) &&
        result.revision === pending.mutation.input.expectedRevision + 1 &&
        (pending.mutation.kind === 'remove'
          ? result.removed === true
          : typeof result.enabled === 'boolean' &&
            typeof result.removed === 'boolean' &&
            decodeContract(ConfigurationContract, result.configuration)))
    )
  } catch {
    /* 异常响应只给稳定错误，不回显未知字段。 */
  }
  if (matches)
    return value as EnvironmentMcpConnection | EnvironmentMcpTestResult | EnvironmentMcpDeletion
  throw new AutoOpsRequestError(
    "连接操作响应无法确认，请核对原请求。",
    "ENVIRONMENT_MCP_RESPONSE_INVALID",
    undefined,
    true,
  );
}
export async function submitEnvironmentMcp(
  pending: PendingEnvironmentMcp,
  signal?: AbortSignal,
): Promise<EnvironmentMcpWriteResult> {
  const fixed = validatePending(pending, pending.projectId, pending.environmentId),
    mutation = fixed.mutation;
  const suffix = mutation.connectionId
    ? `/${encodeURIComponent(mutation.connectionId)}${mutation.kind === "test" ? "/test" : mutation.kind === "enabled" ? "/enabled" : ""}`
    : "";
  try {
    const value = await autoOpsRequest<unknown>(
      environmentMcpPath(fixed.projectId, fixed.environmentId) + suffix,
      {
        label: mutation.kind === "test" ? "连接测试" : "环境连接",
        method: mutation.kind === "remove" ? "DELETE" : "POST",
        body: mutation.input,
        ...(signal ? { signal } : {}),
      },
    );
    const result = checkedResult(fixed, value);
    clearPendingEnvironmentMcp(fixed);
    return result;
  } catch (cause) {
    if (cause instanceof AutoOpsRequestError && !cause.uncertain) clearPendingEnvironmentMcp(fixed);
    throw cause;
  }
}
export async function recoverEnvironmentMcp(
  pending: PendingEnvironmentMcp,
  signal?: AbortSignal,
): Promise<
  { status: "pending" | "missing" } | { status: "completed"; result: EnvironmentMcpWriteResult }
> {
  const fixed = validatePending(pending, pending.projectId, pending.environmentId);
  try {
    const { receipt } = await autoOpsRequest<{ receipt: EnvironmentMcpReceipt | null }>(
      `${environmentMcpPath(fixed.projectId, fixed.environmentId)}/receipts/${encodeURIComponent(fixed.mutation.input.requestId)}`,
      { label: "连接操作收据", ...(signal ? { signal } : {}) },
    );
    if (receipt === null) return { status: "missing" };
    if (receipt.status === "pending") return { status: "pending" };
    if (receipt.status === "failed") {
      clearPendingEnvironmentMcp(fixed);
      throw new AutoOpsRequestError(
        receipt.error?.message ?? "连接测试未完成，请重新测试。",
        receipt.error?.code ?? "ENVIRONMENT_MCP_FAILED",
        409,
      );
    }
    if (receipt.status !== "completed") throw invalidPending();
    const result = checkedResult(fixed, receipt.result);
    clearPendingEnvironmentMcp(fixed);
    return { status: "completed", result };
  } catch (cause) {
    if (cause instanceof AutoOpsRequestError && [401, 403, 404].includes(cause.status ?? 0))
      clearPendingEnvironmentMcp(fixed);
    throw cause;
  }
}
