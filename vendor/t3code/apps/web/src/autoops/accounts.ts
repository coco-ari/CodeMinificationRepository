import { decodeContract } from "../../../../../../autoops/contracts/index.ts";
import { randomUUID } from "~/lib/utils";
import {
  RuntimeAccount,
  type AccountOperation,
  type AccountPage,
  type AccountPasswordResult,
  type AccountDeletionResult,
  type AccountReceipt,
  type AccountSavedUnavailable,
} from "../../../../../../autoops/contracts/accounts.ts";
import { AutoOpsRequestError, autoOpsRequest } from "./apiClient";
import { autoOpsStorage, readAutoOpsHost } from "./hostSnapshot";

export type {
  RuntimeAccount,
  AccountPasswordResult,
  AccountDeletionResult,
} from "../../../../../../autoops/contracts/accounts.ts";
export interface PendingAccountWrite {
  actorId: string
  requestId: string
  operation: AccountOperation
  targetId: string | null
  submitted?: true
  expectedRevision?: number
}
export type AccountWriteValue =
  | {
      operation: "create";
      value: {
        username: string;
        name: string;
        password: string;
        kind: "internal" | "external";
        platformAdmin: boolean;
      };
    }
  | { operation: 'delete'; expectedRevision: number; value: Record<string, never> }
  | { operation: 'enable'; expectedRevision: number; value: { enabled: boolean } }
  | { operation: 'resetPassword'; expectedRevision: number; value: { newPassword: string } }
  | {
      operation: 'changePassword'
      expectedRevision: number
      value: { currentPassword: string; newPassword: string }
    }
export type AccountWriteResult =
  RuntimeAccount | AccountPasswordResult | AccountDeletionResult | AccountSavedUnavailable
const key = 'account-write-receipt'
const operations = new Set<AccountOperation>([
  'create',
  'enable',
  'delete',
  'resetPassword',
  'changePassword',
])
const invalid = () =>
  new AutoOpsRequestError(
    "账号操作返回结果无法确认，请核对原结果。",
    "ACCOUNT_RESPONSE_INVALID",
    undefined,
    true,
  );
const actor = () => {
  const id = readAutoOpsHost()?.principal.id;
  if (!id) throw new Error("登录上下文不可用。");
  return id;
};

export function readPendingAccountWrite(): PendingAccountWrite | null {
  try {
    const raw: unknown = JSON.parse(autoOpsStorage(window.sessionStorage).getItem(key) ?? "null");
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<PendingAccountWrite>;
    if (
      value.actorId !== actor() ||
      typeof value.requestId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.requestId) ||
      !operations.has(value.operation!) ||
      !(value.targetId === null || typeof value.targetId === "string") ||
      !(value.submitted === undefined || value.submitted === true)
    )
      return null;
    return {
      actorId: value.actorId,
      requestId: value.requestId,
      operation: value.operation!,
      targetId: value.targetId,
      ...(value.submitted ? { submitted: true } : {}),
      ...(value.operation === 'delete' && Number.isSafeInteger(value.expectedRevision)
        ? { expectedRevision: value.expectedRevision! }
        : {}),
    }
  } catch {
    return null;
  }
}

export function prepareAccountWrite(
  operation: AccountOperation,
  targetId: string | null,
): PendingAccountWrite {
  if (readPendingAccountWrite()) throw new Error("请先核对上一次账号操作结果。");
  if ((operation === "create") !== (targetId === null)) throw new Error("账号操作对象无效。");
  const pending = { actorId: actor(), requestId: randomUUID(), operation, targetId };
  // 密码不进入持久存储；原请求只用于正常重新登录后的收据核对。
  autoOpsStorage(window.sessionStorage).setItem(key, JSON.stringify(pending));
  return pending;
}

function clear(pending: PendingAccountWrite) {
  if (readPendingAccountWrite()?.requestId === pending.requestId)
    autoOpsStorage(window.sessionStorage).removeItem(key);
}
function requireOriginal(pending: PendingAccountWrite) {
  const saved = readPendingAccountWrite();
  if (pending.actorId !== actor() || !saved || JSON.stringify(saved) !== JSON.stringify(pending))
    throw new Error("原账号请求不可用，请刷新核对。");
}
function resultFor(
  pending: PendingAccountWrite,
  raw: unknown,
): RuntimeAccount | AccountPasswordResult | AccountDeletionResult {
  try {
    if (pending.operation === 'delete') {
      const value = raw as AccountDeletionResult
      if (
        !value ||
        value.deleted !== true ||
        value.userId !== pending.targetId ||
        !Number.isSafeInteger(value.revision)
      )
        throw invalid()
      return value
    }
    if (pending.operation === "create" || pending.operation === "enable") {
      const result = decodeContract(RuntimeAccount, raw);
      if (pending.targetId !== null && result.id !== pending.targetId) throw invalid();
      return result;
    }
    if (!raw || typeof raw !== "object") throw invalid();
    const value = raw as Partial<AccountPasswordResult>;
    if (
      value.userId !== pending.targetId ||
      !Number.isSafeInteger(value.revision) ||
      value.revision! < 1 ||
      value.sessionsRevoked !== true ||
      value.loginPath !== "/"
    )
      throw invalid();
    return value as AccountPasswordResult;
  } catch {
    throw invalid();
  }
}

export async function loadOwnAccount(signal?: AbortSignal): Promise<RuntimeAccount> {
  const { account } = await autoOpsRequest<{ account: unknown }>("/api/v1/account", {
    label: "本人账号",
    ...(signal ? { signal } : {}),
  });
  const value = decodeContract(RuntimeAccount, account);
  if (value.id !== actor()) throw new Error("本人账号与登录身份不一致。");
  return value;
}
export async function loadAccounts(after?: string, signal?: AbortSignal): Promise<AccountPage> {
  const value = await autoOpsRequest<AccountPage>(
    `/api/v1/accounts${after ? `?after=${encodeURIComponent(after)}` : ""}`,
    { label: "账号目录", ...(signal ? { signal } : {}) },
  );
  if (
    !Array.isArray(value.items) ||
    !(value.nextCursor === null || typeof value.nextCursor === "string")
  )
    throw new Error("账号目录返回内容无效。");
  return {
    items: value.items.map((item) => decodeContract(RuntimeAccount, item)),
    nextCursor: value.nextCursor,
  };
}

export async function submitAccountWrite(
  pending: PendingAccountWrite,
  input: AccountWriteValue,
): Promise<AccountWriteResult> {
  requireOriginal(pending)
  if (input.operation !== pending.operation) throw new Error('账号操作与原请求不一致。')
  if (pending.submitted) throw new Error('该账号请求已发送，请核对原结果，不能再次提交。')
  pending.submitted = true
  if (input.operation === 'delete') pending.expectedRevision = input.expectedRevision
  autoOpsStorage(window.sessionStorage).setItem(key, JSON.stringify(pending))
  const path =
    input.operation === "create"
      ? "/api/v1/accounts"
      : input.operation === "changePassword"
        ? "/api/v1/account/password"
        : `/api/v1/accounts/${encodeURIComponent(pending.targetId!)}${input.operation === "resetPassword" ? "/password" : ""}`;
  try {
    const raw = await autoOpsRequest<unknown>(path, {
      label: '账号操作',
      method:
        input.operation === 'create' ? 'POST' : input.operation === 'delete' ? 'DELETE' : 'PUT',
      body: {
        requestId: pending.requestId,
        ...("expectedRevision" in input ? { expectedRevision: input.expectedRevision } : {}),
        value: input.value,
      },
    });
    if (
      raw &&
      typeof raw === "object" &&
      "saved" in raw &&
      raw.saved === true &&
      "available" in raw &&
      raw.available === false
    )
      return { saved: true, available: false };
    const result = resultFor(pending, raw);
    clear(pending);
    return result;
  } catch (cause) {
    if (cause instanceof AutoOpsRequestError && !cause.uncertain) clear(pending);
    throw cause;
  }
}

export async function recoverAccountWrite(
  pending: PendingAccountWrite,
  signal?: AbortSignal,
): Promise<AccountWriteResult | null> {
  requireOriginal(pending);
  const receipt = await autoOpsRequest<AccountReceipt | null>(
    `/api/v1/accounts/receipts/${encodeURIComponent(pending.requestId)}`,
    { label: "账号原请求", ...(signal ? { signal } : {}), allowNull: true },
  );
  if (receipt === null) return null;
  if (
    receipt.state !== "completed" ||
    receipt.requestId !== pending.requestId ||
    receipt.operation !== pending.operation ||
    typeof receipt.targetId !== "string" ||
    !receipt.targetId ||
    (pending.targetId !== null && receipt.targetId !== pending.targetId)
  )
    throw invalid();
  const result = resultFor(pending, receipt.result);
  if ("id" in result && result.id !== receipt.targetId) throw invalid();
  clear(pending);
  return result;
}

export async function resumeAccountDeletion(
  pending: PendingAccountWrite,
): Promise<AccountWriteResult> {
  const result = await recoverAccountWrite(pending)
  if (result) return result
  requireOriginal(pending)
  if (pending.operation !== 'delete' || !pending.expectedRevision)
    throw new Error('删除参数不可用，请刷新账号目录后重新确认')
  const raw = await autoOpsRequest<unknown>(
    `/api/v1/accounts/${encodeURIComponent(pending.targetId!)}`,
    {
      label: '继续删除账号',
      method: 'DELETE',
      body: { requestId: pending.requestId, expectedRevision: pending.expectedRevision, value: {} },
    },
  )
  const deleted = resultFor(pending, raw)
  clear(pending)
  return deleted
}

export function accountResultRequiresLogin(result: AccountWriteResult, actorId: string): boolean {
  if ('saved' in result) return false
  if ('deleted' in result) return result.userId === actorId
  return 'sessionsRevoked' in result
    ? result.userId === actorId
    : result.id === actorId && !result.enabled;
}
export function returnToAccountLogin() {
  window.location.replace("/");
}
