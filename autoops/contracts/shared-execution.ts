import * as S from 'effect/Schema'
import * as Exit from 'effect/Exit'
import { DirectoryId } from './project-directory.ts'
import { AssistantModel } from './assistants.ts'
import { CustomerAssistantSource, RunnerReferenceId } from './customer-source.ts'
import { SharedProfileDescriptor } from './shared-profile.ts'
export { SharedProfileDescriptor, SharedProfileCapability } from './shared-profile.ts'

const Identity = S.String.check(
  S.isMinLength(1),
  S.isMaxLength(512),
  S.isPattern(/^[^\x00-\x1f\x7f]+$/),
)
const Revision = S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1))
/** 只由中心持久授权事实生成；浏览器参数及模型输入不能提供或改写此范围。 */
export const SharedExecutionScope = S.Struct({
  grantId: Identity,
  actorId: DirectoryId,
  providerId: DirectoryId,
  projectId: DirectoryId,
  sourceProjectId: DirectoryId,
  threadId: Identity,
  runId: Identity,
  assistantId: DirectoryId,
  presetRevision: Revision,
  shareRevision: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  allocation: S.Struct({
    kind: S.Literals(['role', 'member', 'self']),
    id: DirectoryId,
    revision: Revision,
  }),
  capabilityRevision: Identity,
  profile: SharedProfileDescriptor,
  target: CustomerAssistantSource,
  model: AssistantModel,
  skillIds: S.Array(RunnerReferenceId).check(S.isMaxLength(32)),
})
export type SharedExecutionScope = typeof SharedExecutionScope.Type

const decodeSharedExecutionScope = S.decodeUnknownExit(SharedExecutionScope, {
  onExcessProperty: 'error',
})
/** 不向其他依赖实例传递内部 schema，由合同所属实例完整校验隔离范围。 */
export function isSharedExecutionScope(input: unknown): input is SharedExecutionScope {
  return Exit.isSuccess(decodeSharedExecutionScope(input))
}

/** 同一原生会话可开始下一轮，但其调用者、资料来源及隔离边界不可更换。 */
export function sharedSessionIdentity(scope?: SharedExecutionScope): string | undefined {
  if (!scope) return undefined
  return JSON.stringify([
    scope.actorId,
    scope.providerId,
    scope.projectId,
    scope.sourceProjectId,
    scope.threadId,
    scope.assistantId,
    scope.presetRevision,
    scope.target.deviceId,
    scope.target.registeredWorkspaceId,
    scope.target.workspaceBindingRevision,
    scope.target.runtimeId,
    scope.profile.id,
    scope.profile.revision,
    scope.profile.digest,
    scope.profile.imageDigest,
    scope.profile.policy,
  ])
}

export const SharedProfileApproval = S.Struct({
  providerId: DirectoryId,
  sourceProjectId: DirectoryId,
  target: CustomerAssistantSource,
  profile: SharedProfileDescriptor,
  validationId: Identity,
  verifiedAt: S.String.check(S.isMinLength(1), S.isMaxLength(80)),
})
export type SharedProfileApproval = typeof SharedProfileApproval.Type
