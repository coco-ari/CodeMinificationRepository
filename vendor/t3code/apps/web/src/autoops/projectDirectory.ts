import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { RepositoryRequestReceipt, ProjectAssistantRequestReceipt, repositoryReceiptIntent, projectAssistantReceiptIntent } from '../../../../../../autoops/contracts/project-management-receipts.ts'
import { randomUUID } from '~/lib/utils';
import { decodeContract } from "../../../../../../autoops/contracts/index.ts";
import { DirectoryRequestReceipt } from "../../../../../../autoops/contracts/project-directory.ts";
import type {
  DirectoryProject,
  ProjectSettings,
} from '../../../../../../autoops/contracts/project-directory.ts'
import { autoOpsRequest, AutoOpsRequestError } from './apiClient'
import {
  autoOpsStorage,
  autoOpsStorageKey,
  installAutoOpsHost,
  readAutoOpsHost,
  type AutoOpsT3Bootstrap,
} from './hostConfig'

export type {
  DirectoryProject,
  DirectoryMember,
  ProjectSettings,
} from '../../../../../../autoops/contracts/project-directory.ts'
export const loadProjectDirectory = (signal?: AbortSignal) =>
  autoOpsRequest<{ items: DirectoryProject[] }>('/api/v1/projects', {
    label: '项目',
    ...(signal ? { signal } : {}),
  })
export const loadProjectSettings = (project: string, signal?: AbortSignal) =>
  autoOpsRequest<ProjectSettings>(`/api/v1/projects/${encodeURIComponent(project)}/settings`, {
    label: '项目设置',
    ...(signal ? { signal } : {}),
  })
export async function refreshProjectHost() {
  const bootstrap = await autoOpsRequest<AutoOpsT3Bootstrap>('/autoops/bootstrap', {
    label: '项目授权',
  })
  installAutoOpsHost(bootstrap, window.location.origin)
}
export type PendingProjectWrite = {
  actorId?: string;
  submitted?: true;
  path: string
  method?: 'DELETE'
  body: { requestId: string; expectedRevision: number } & Record<string, unknown>
}
type ProjectWriteScope = {
  projectId: string | null
  owner?: 'directory' | 'repository' | 'assistant'
}
const pendingBase = 'project-directory:pending'
const pendingKey = (scope?: ProjectWriteScope) =>
  autoOpsStorageKey(
    scope
      ? `${pendingBase}:${encodeURIComponent(scope.projectId ?? '')}:${scope.owner}`
      : pendingBase,
  )
const actor = () => readAutoOpsHost()?.principal.id
const uncertain = (
  message = '保存结果尚待确认，请核对原请求。',
  code = 'PROJECT_REQUEST_UNCONFIRMED',
) => new AutoOpsRequestError(message, code, undefined, true)
function writeScope(pending: PendingProjectWrite): Required<ProjectWriteScope> | null {
  const directory = requestScope(pending)
  if (directory) return { projectId: directory.projectId, owner: 'directory' }
  const configuration = configurationScope(pending)
  return configuration ? { projectId: configuration.projectId, owner: configuration.family } : null
}
function pendingEntries() {
  const currentActor = actor()
  if (!currentActor) return []
  const storage = autoOpsStorage(window.sessionStorage)
  const prefix = autoOpsStorageKey('')
  const keys = Array.from({ length: window.sessionStorage.length }, (_, index) =>
    window.sessionStorage.key(index),
  )
    .filter((key): key is string => key?.startsWith(prefix) === true)
    .map((key) => key.slice(prefix.length))
    .filter((key) => key === pendingBase || key.startsWith(pendingBase + ':'))
  return keys.map((key) => {
    let value: PendingProjectWrite | null = null
    try {
      const candidate = JSON.parse(storage.getItem(key) ?? 'null') as PendingProjectWrite | null
      if (
        candidate &&
        typeof candidate.path === 'string' &&
        candidate.path.startsWith('/api/v1/projects') &&
        candidate.body &&
        typeof candidate.body.requestId === 'string' &&
        Number.isSafeInteger(candidate.body.expectedRevision) &&
        (candidate.method === undefined || candidate.method === 'DELETE') &&
        (candidate.actorId === undefined || candidate.actorId === currentActor) &&
        (candidate.submitted === undefined || candidate.submitted === true)
      ) {
        const scope = writeScope(candidate)
        const expectedKey = scope ? pendingKey(scope) : null
        if (key === pendingBase || expectedKey === autoOpsStorageKey(key)) {
          // 旧记录缺发送标记时只能核对原收据，不能补发。
          value =
            candidate.actorId === undefined
              ? { ...candidate, actorId: currentActor, submitted: true }
              : candidate
        }
      }
    } catch {
      /* 损坏记录保留原字节，并继续阻止覆盖。 */
    }
    return { key, value }
  })
}
export function readPendingProjectWrite(scope?: ProjectWriteScope): PendingProjectWrite | null {
  try {
    if (!actor()) return null
    return (
      pendingEntries().find(({ value }) => {
        if (!value) return false
        const original = writeScope(value)
        return (
          !scope ||
          !original ||
          (original.projectId === scope.projectId &&
            (!scope.owner || original.owner === scope.owner || isDirectoryDeletion(value)))
        )
      })?.value ?? null
    )
  } catch {
    return null
  }
}
function requireOriginal(pending: PendingProjectWrite) {
  const matches = pendingEntries().filter(
    ({ value }) => value?.body.requestId === pending.body.requestId,
  )
  const saved = matches.length === 1 ? matches[0] : null
  if (
    !actor() ||
    pending.actorId !== actor() ||
    !saved ||
    JSON.stringify(saved.value) !== JSON.stringify(pending)
  )
    throw uncertain('登录或原请求已经改变，请返回原账号核对。', 'PROJECT_REQUEST_CONTEXT_CHANGED')
  return saved.key
}
function clear(pending: PendingProjectWrite) {
  const key = requireOriginal(pending)
  autoOpsStorage(window.sessionStorage).removeItem(key)
}
export function prepareProjectWrite(
  path: string,
  expectedRevision: number,
  value: object,
): PendingProjectWrite {
  return prepareProjectMutation(path, expectedRevision, { value })
}
export function prepareProjectMutation(
  path: string,
  expectedRevision: number,
  payload: object,
  method?: 'DELETE',
): PendingProjectWrite {
  const currentActor = actor()
  if (!currentActor) throw new Error('登录上下文不可用')
  const pending = {
    actorId: currentActor,
    path,
    ...(method ? { method } : {}),
    body: { ...payload, requestId: randomUUID(), expectedRevision },
  }
  const scope = writeScope(pending)
  if (
    !scope ||
    pendingEntries().some(({ value }) => {
      const original = value ? writeScope(value) : null
      return (
        !value ||
        !original ||
        (original.projectId === scope.projectId &&
          (original.owner === scope.owner ||
            isDirectoryDeletion(value) ||
            isDirectoryDeletion(pending)))
      )
    })
  )
    throw new Error('请先核对上一次保存结果')
  autoOpsStorage(window.sessionStorage).setItem(pendingKey(scope), JSON.stringify(pending))
  return pending
}
function isDirectoryDeletion(pending: PendingProjectWrite) {
  return pending.method === 'DELETE' && requestScope(pending) !== null
}
function requestScope(pending: PendingProjectWrite) {
  const match =
    /^\/api\/v1\/projects(?:\/([^/]+)(?:\/(settings|environments|members)(?:\/([^/]+))?)?)?$/.exec(
      pending.path,
    );
  if (!match) return null;
  const projectId = match[1] ? decodeURIComponent(match[1]) : null;
  const section = match[2],
    environmentId = section === "environments" && match[3] ? decodeURIComponent(match[3]) : null;
  if (pending.method === "DELETE") {
    if (!projectId || (section !== undefined && (section !== "environments" || !environmentId)))
      return null;
    return {
      projectId,
      environmentId,
      operation: environmentId ? "environment.delete" : "project.delete",
    };
  }
  if (!projectId) return { projectId: null, environmentId: null, operation: "project.create" };
  if (section === "settings" && !match[3])
    return { projectId, environmentId: null, operation: "project.save" };
  if (section === "environments")
    return { projectId, environmentId, operation: `environment.save:${environmentId ?? "new"}` };
  if (
    section === "members" &&
    !match[3] &&
    pending.body.value &&
    typeof pending.body.value === "object" &&
    "userId" in pending.body.value
  )
    return {
      projectId,
      environmentId: null,
      operation: `member.save:${String(pending.body.value.userId)}`,
    };
  return null;
}
function sameIntent(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => sameIntent(actual[index], value))
    );
  if (
    !actual ||
    !expected ||
    typeof actual !== "object" ||
    typeof expected !== "object" ||
    Array.isArray(actual) ||
    Array.isArray(expected)
  )
    return false;
  const left = actual as Record<string, unknown>,
    right = expected as Record<string, unknown>;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(right).every((key) => Object.hasOwn(left, key) && sameIntent(left[key], right[key]))
  );
}
function configurationScope(pending: PendingProjectWrite) {
  if (pending.method) return null
  const repository = /^\/api\/v1\/projects\/([^/]+)\/repositories(?:\/([^/]+)(\/remove)?)?$/.exec(pending.path)
  if (repository) {
    const projectId = decodeURIComponent(repository[1]!), repositoryId = repository[2] ? decodeURIComponent(repository[2]) : null
    if (repository[3] && !repositoryId) return null
    return { family: 'repository' as const, projectId, targetId: repositoryId, operation: repository[3] ? 'remove-repository' as const : 'save-repository' as const }
  }
  const assistant = /^\/api\/v1\/projects\/([^/]+)\/(assistants(?:\/([^/]+))?|assistant-allocations)$/.exec(pending.path)
  if (!assistant) return null
  const projectId = decodeURIComponent(assistant[1]!), targetId = assistant[3] ? decodeURIComponent(assistant[3]) : null
  if (assistant[2] === 'assistant-allocations') {
    const target = pending.body.target
    if (!target || typeof target !== 'object' || !('kind' in target) || !('id' in target)) return null
    return { family: 'assistant' as const, projectId, targetId: null, operation: `allocation.save:${String(target.kind)}:${String(target.id)}` }
  }
  return { family: 'assistant' as const, projectId, targetId, operation: `preset.save:${targetId ?? 'new'}` }
}
async function recoverConfigurationWrite(pending: PendingProjectWrite, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let scope: ReturnType<typeof configurationScope>, digest: string
  try {
    scope = configurationScope(pending)
    if (!scope) throw uncertain('此项配置的原请求查询尚未接入，请保留当前请求。', 'PROJECT_REQUEST_OWNER_UNAVAILABLE')
    const intent = scope.family === 'repository'
      ? repositoryReceiptIntent(pending.actorId!, scope.operation as 'save-repository' | 'remove-repository', scope.targetId, pending.body)
      : projectAssistantReceiptIntent(scope.operation, pending.body)
    // 复用已锁定的浏览器哈希库；普通HTTP也能核原公开参数，不依赖安全上下文的subtle。
    digest = bytesToHex(sha256(new TextEncoder().encode(intent)))
  } catch (cause) {
    if (cause instanceof AutoOpsRequestError) throw cause
    throw uncertain('原配置参数无法核对，请保留原请求。', 'PROJECT_RECEIPT_MISMATCH')
  }
  const raw = await autoOpsRequest<unknown>(`/api/v1/projects/${encodeURIComponent(scope.projectId)}/${scope.family === 'repository' ? 'repositories' : 'assistants'}/receipts/${encodeURIComponent(pending.body.requestId)}`, {
    label: '配置原请求', allowNull: true, ...(signal ? { signal } : {}),
  })
  requireOriginal(pending)
  if (raw === null) throw uncertain()
  let receipt: RepositoryRequestReceipt | ProjectAssistantRequestReceipt
  try { receipt = scope.family === 'repository' ? decodeContract(RepositoryRequestReceipt, raw) : decodeContract(ProjectAssistantRequestReceipt, raw) }
  catch { throw uncertain('原配置收据格式无法确认，请保留原请求。', 'PROJECT_RECEIPT_MISMATCH') }
  if (receipt.actorId !== pending.actorId || receipt.projectId !== scope.projectId || receipt.requestId !== pending.body.requestId || receipt.operation !== scope.operation || receipt.publicIntent.digest !== digest)
    throw uncertain('原配置收据与当前参数不一致，请保留原请求。', 'PROJECT_RECEIPT_MISMATCH')
  if (!receipt.available) { clear(pending); return { saved: true, available: false } }
  if (!receipt.result) throw uncertain('原配置结果无法确认，请保留原请求。', 'PROJECT_RECEIPT_MISMATCH')
  const result: Record<string, unknown> = { ...receipt.result }
  if (scope.family === 'repository') {
    if (result.requestId !== pending.body.requestId) throw uncertain('原仓库请求不一致。', 'PROJECT_RECEIPT_MISMATCH')
    if (scope.operation === 'save-repository') {
      const repository = result.repository
      if (!repository || typeof repository !== 'object' || !('id' in repository) || (scope.targetId !== null && repository.id !== scope.targetId))
        throw uncertain('原仓库对象不一致。', 'PROJECT_RECEIPT_MISMATCH')
    }
  } else if (scope.operation.startsWith('preset.save:')) {
    if (result.projectId !== scope.projectId || typeof result.id !== 'string' || (scope.targetId !== null && result.id !== scope.targetId))
      throw uncertain('原助手对象不一致。', 'PROJECT_RECEIPT_MISMATCH')
  } else if (!sameIntent(result.assistantIds, pending.body.assistantIds) || result.defaultAssistantId !== pending.body.defaultAssistantId)
    throw uncertain('原助手分配与当前参数不一致。', 'PROJECT_RECEIPT_MISMATCH')
  clear(pending)
  return result
}
export async function recoverProjectWrite(
  pending: PendingProjectWrite,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  requireOriginal(pending);
  let scope: ReturnType<typeof requestScope>;
  try { scope = requestScope(pending) }
  catch { throw uncertain("原请求范围无法确认，请保留原请求。", "PROJECT_RECEIPT_MISMATCH") }
  if (!scope) return recoverConfigurationWrite(pending, signal);
  const raw = await autoOpsRequest<unknown>(
    `/api/v1/projects/receipts/${encodeURIComponent(pending.body.requestId)}`,
    {
      label: "项目原请求",
      allowNull: true,
      ...(signal ? { signal } : {}),
    },
  );
  requireOriginal(pending);
  return recoveredDirectoryResult(pending, scope, raw);
}
export class PendingProjectDeletion extends AutoOpsRequestError {
  constructor(readonly canResume: boolean, readonly target: { projectId: string; revision: number }) {
    super(canResume ? '原删除尚未完成，可以继续原删除。' : '原操作仍在处理中，请稍后核对。', 'PROJECT_REQUEST_PENDING', undefined, true);
  }
}
function recoveredDirectoryResult(
  pending: PendingProjectWrite,
  scope: NonNullable<ReturnType<typeof requestScope>>,
  raw: unknown,
): Record<string, unknown> {
  requireOriginal(pending);
  const { requestId: _requestId, ...intent } = pending.body;
  if (raw === null) throw uncertain();
  let receipt: DirectoryRequestReceipt;
  try {
    receipt = decodeContract(DirectoryRequestReceipt, raw);
  } catch {
    throw uncertain("原收据格式无法确认，请保留原请求。", "PROJECT_RECEIPT_MISMATCH");
  }
  if (
    receipt.requestId !== pending.body.requestId ||
    receipt.actorId !== pending.actorId ||
    receipt.saved !== true ||
    typeof receipt.available !== "boolean" ||
    receipt.operation !== scope.operation ||
    receipt.environmentId !== scope.environmentId ||
    (scope.projectId !== null && receipt.projectId !== scope.projectId) ||
    typeof receipt.projectId !== "string" ||
    !receipt.projectId ||
    !sameIntent(receipt.publicIntent, intent)
  )
    throw uncertain("原收据与当前请求不一致，请保留原请求。", "PROJECT_RECEIPT_MISMATCH");
  const synchronizedProject =
    scope.operation === "project.create" || scope.operation === "project.save";
  if (
    synchronizedProject
      ? !["current-verified", "unverified"].includes(receipt.nativeSynchronization)
      : receipt.nativeSynchronization !== "not-required"
  )
    throw uncertain("原收据运行入口状态无法确认。", "PROJECT_RECEIPT_MISMATCH");
  if (receipt.state !== "completed" && pending.method !== "DELETE")
    throw uncertain("原收据状态与操作不一致。", "PROJECT_RECEIPT_MISMATCH");
  if (receipt.canResume === true && (receipt.state !== 'pending' || scope.operation !== 'project.delete'))
    throw uncertain('原收据恢复范围无法确认。', 'PROJECT_RECEIPT_MISMATCH');
  if (receipt.state === "pending")
    throw new PendingProjectDeletion(receipt.canResume === true, { projectId: receipt.projectId, revision: pending.body.expectedRevision });
  if (receipt.state === "blocked") {
    clear(pending);
    throw new AutoOpsRequestError(
      "原删除已确认未执行，请刷新引用后重新确认。",
      "PROJECT_DELETE_BLOCKED",
      409,
    );
  }
  if (receipt.state !== "completed")
    throw uncertain("原收据状态无法确认。", "PROJECT_RECEIPT_MISMATCH");
  if (!receipt.available && pending.method !== "DELETE") {
    clear(pending);
    return { saved: true, available: false };
  }
  if (!receipt.result || typeof receipt.result !== "object" || Array.isArray(receipt.result))
    throw uncertain("原收据结果无法确认。", "PROJECT_RECEIPT_MISMATCH");
  const result: Record<string, unknown> = { ...receipt.result };
  if (pending.method === "DELETE") {
    if (
      result.deleted !== true ||
      result.projectId !== receipt.projectId ||
      (scope.environmentId !== null
        ? result.environmentId !== scope.environmentId
        : result.environmentId !== undefined)
    )
      throw uncertain("原删除范围与当前请求不一致。", "PROJECT_RECEIPT_MISMATCH");
  } else if (scope.operation === "project.create" || scope.operation === "project.save") {
    if (
      result.id !== receipt.projectId ||
      typeof result.name !== "string" ||
      typeof result.description !== "string" ||
      !Array.isArray(result.environments)
    )
      throw uncertain("原项目与当前请求不一致。", "PROJECT_RECEIPT_MISMATCH");
  } else if (
    scope.operation.startsWith("environment.save:") &&
    (typeof result.id !== "string" ||
      !result.id ||
      (scope.environmentId !== null && result.id !== scope.environmentId))
  )
    throw uncertain("原环境与当前请求不一致。", "PROJECT_RECEIPT_MISMATCH");
  if (
    scope.operation.startsWith("member.save:") &&
    result.userId !== (pending.body.value as { userId: string }).userId
  )
    throw uncertain("原成员与当前请求不一致。", "PROJECT_RECEIPT_MISMATCH");
  clear(pending);
  return { ...result, nativeSynchronization: receipt.nativeSynchronization };
}
export async function resumeProjectDeletion(pending: PendingProjectWrite) {
  // 用户明确继续前再读原事实；未知、缺失或失权均不能授权恢复写入。
  try { return await recoverProjectWrite(pending) }
  catch (cause) {
    if (!(cause instanceof PendingProjectDeletion) || !cause.canResume) throw cause;
  }
  requireOriginal(pending);
  const scope = requestScope(pending);
  if (pending.method !== 'DELETE' || scope?.operation !== 'project.delete' || !scope.projectId)
    throw uncertain('原删除范围无法确认。', 'PROJECT_RECEIPT_MISMATCH');
  const { requestId: _requestId, ...publicIntent } = pending.body;
  const raw = await autoOpsRequest<unknown>(`/api/v1/projects/receipts/${encodeURIComponent(pending.body.requestId)}/resume`, {
    label: '继续删除', body: { operation: 'project.delete', projectId: scope.projectId, publicIntent },
  });
  return recoveredDirectoryResult(pending, scope, raw);
}
export async function submitProjectWrite(pending: PendingProjectWrite) {
  const key = requireOriginal(pending);
  // 发送前固定标记；任何旧调用入口再次提交都会转原收据GET，不能重发写请求。
  if (pending.submitted) return recoverProjectWrite(pending);
  pending.submitted = true;
  autoOpsStorage(window.sessionStorage).setItem(key, JSON.stringify(pending));
  try {
    const result = await autoOpsRequest<Record<string, unknown>>(pending.path, {
      label: '配置',
      body: pending.body,
      ...(pending.method ? { method: pending.method } : {}),
    });
    requireOriginal(pending);
    clear(pending)
    return result
  } catch (error) {
    if (error instanceof AutoOpsRequestError && !error.uncertain) clear(pending)
    throw error
  }
}
