import * as S from 'effect/Schema'
import { DirectoryCommand, DirectoryId } from './project-directory.ts'
import { AssistantDetails, AssignAssistantCommand, SaveAssistantCommand } from './assistants.ts'
import {
  ConfigureRepositoryWorkspace,
  RepositoryDetails,
  SaveRepository,
} from './project-repositories.ts'

const Revision = S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1))
const DateText = S.String.check(S.isMinLength(1), S.isMaxLength(80))
const PublicIntent = S.Struct({
  algorithm: S.Literal('sha256'),
  digest: S.String.check(S.isPattern(/^[a-f0-9]{64}$/)),
})
const ReceiptFields = {
  state: S.Literal('completed'),
  requestId: DirectoryId,
  actorId: DirectoryId,
  projectId: DirectoryId,
  saved: S.Literal(true),
  available: S.Boolean,
  publicIntent: PublicIntent,
  createdAt: DateText,
}
const RepositoryConnection = S.Struct({ ...RepositoryDetails.fields, id: DirectoryId })
const RepositorySource = S.Struct({
  ...RepositoryConnection.fields,
  role: ConfigureRepositoryWorkspace.fields.role,
  refKind: ConfigureRepositoryWorkspace.fields.refKind,
  ref: ConfigureRepositoryWorkspace.fields.ref,
  mountPath: ConfigureRepositoryWorkspace.fields.mountPath,
  sourcePath: ConfigureRepositoryWorkspace.fields.sourcePath,
})
export const RepositoryReceiptResult = S.Struct({
  requestId: DirectoryId,
  revision: Revision,
  repository: S.optionalKey(RepositoryConnection),
  source: S.optionalKey(RepositorySource),
})
export const RepositoryRequestReceipt = S.Struct({
  ...ReceiptFields,
  operation: S.Literals(['save-repository', 'remove-repository', 'configure-source']),
  result: S.optionalKey(RepositoryReceiptResult),
})
export type RepositoryRequestReceipt = typeof RepositoryRequestReceipt.Type

export const ProjectAssistantPreset = S.Struct({
  ...AssistantDetails.fields,
  id: DirectoryId,
  projectId: DirectoryId,
  revision: Revision,
  createdBy: DirectoryId,
  updatedAt: DateText,
  providedBy: S.optionalKey(
    S.Struct({ id: DirectoryId, name: S.String, sourceProjectId: DirectoryId }),
  ),
})
export const ProjectAssistantAllocation = S.Struct({
  assistantIds: AssignAssistantCommand.fields.assistantIds,
  defaultAssistantId: AssignAssistantCommand.fields.defaultAssistantId,
  revision: Revision,
})
export const ProjectAssistantRequestReceipt = S.Struct({
  ...ReceiptFields,
  operation: S.String.check(
    S.isPattern(
      /^(?:preset\.save:[A-Za-z0-9][A-Za-z0-9_-]{0,127}|allocation\.save:(?:member|role):[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/,
    ),
  ),
  result: S.optionalKey(S.Union([ProjectAssistantPreset, ProjectAssistantAllocation])),
})
export type ProjectAssistantRequestReceipt = typeof ProjectAssistantRequestReceipt.Type

/** 复用资料 owner 已持久化的指纹编码；仅编码公开管理参数，不保存凭证明文。 */
export function repositoryReceiptIntent(
  actorId: string,
  operation: RepositoryRequestReceipt['operation'],
  repositoryId: string | null,
  input: unknown,
): string {
  let payload: unknown
  let expectedRevision: number
  if (operation === 'save-repository') {
    const command = S.decodeUnknownSync(SaveRepository, { onExcessProperty: 'error' })(input)
    expectedRevision = command.expectedRevision
    const value = command.value
    payload = {
      repositoryId,
      value: {
        name: value.name.trim(),
        url: new URL(value.url).toString(),
        ...(value.credentialId ? { credentialId: value.credentialId } : {}),
      },
    }
  } else if (operation === 'remove-repository') {
    const command = S.decodeUnknownSync(DirectoryCommand, { onExcessProperty: 'error' })(input)
    expectedRevision = command.expectedRevision
    payload = { repositoryId }
  } else {
    const command = S.decodeUnknownSync(ConfigureRepositoryWorkspace, {
      onExcessProperty: 'error',
    })(input)
    expectedRevision = command.expectedRevision
    payload = command
  }
  return JSON.stringify({ actorId, operation, expectedRevision, payload })
}

/** 助手 owner 的原始命令已按键排序持久化，读取仅公开其摘要。 */
export function projectAssistantReceiptIntent(operation: string, input: unknown): string {
  const value = operation.startsWith('preset.save:')
    ? S.decodeUnknownSync(SaveAssistantCommand, { onExcessProperty: 'error' })(input)
    : S.decodeUnknownSync(AssignAssistantCommand, { onExcessProperty: 'error' })(input)
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  )
}
