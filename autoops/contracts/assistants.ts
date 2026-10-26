import * as S from 'effect/Schema'
import { DirectoryCommand, DirectoryId } from './project-directory.ts'
import { Name } from './index.ts'
import { ProjectRole } from './project-access.ts'

export const RunnerReferenceId = S.String.check(S.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/))
export const AssistantSource = S.Union([
  S.Struct({ kind: S.Literal('platform') }),
  S.Struct({
    kind: S.Literal('customer'),
    deviceId: DirectoryId,
    registeredWorkspaceId: RunnerReferenceId,
    workspaceBindingRevision: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1)),
    runtimeId: S.Literal('codex'),
  }),
])
export const AssistantModel = S.Struct({
  instanceId: S.String.check(S.isMinLength(1), S.isMaxLength(160)),
  model: S.String.check(S.isMinLength(1), S.isMaxLength(128)),
  reasoningEffort: S.NullOr(
    S.Literals(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  ),
})
/** 草稿、预设、绑定及后续执行使用同一最终参数，不在执行前重新套默认值。 */
export const QuestionConfiguration = S.Struct({
  agentId: DirectoryId,
  executionBinding: AssistantSource,
  environmentId: S.NullOr(DirectoryId),
  workspaceType: S.NullOr(S.Literals(['internal', 'external'])),
  visibility: S.Literals(['private', 'project']),
  model: AssistantModel,
  skillIds: S.Array(RunnerReferenceId).check(S.isMaxLength(32)),
})
export type QuestionConfiguration = typeof QuestionConfiguration.Type
export const AssistantDetails = S.Struct({
  name: Name,
  description: S.String.check(S.isMaxLength(2000)),
  instructions: S.String.check(S.isMaxLength(16000)),
  enabled: S.Boolean,
  configuration: QuestionConfiguration,
})
export type AssistantDetails = typeof AssistantDetails.Type
export const SaveAssistantCommand = S.Struct({
  ...DirectoryCommand.fields,
  value: AssistantDetails,
})
export const AssistantTarget = S.Union([
  S.Struct({ kind: S.Literal('member'), id: DirectoryId }),
  S.Struct({ kind: S.Literal('role'), id: ProjectRole }),
])
export const AssignAssistantCommand = S.Struct({
  ...DirectoryCommand.fields,
  target: AssistantTarget,
  assistantIds: S.Array(DirectoryId).check(S.isMaxLength(64)),
  defaultAssistantId: S.NullOr(DirectoryId),
})
export type AssistantTarget = typeof AssistantTarget.Type
export interface AssistantPreset extends AssistantDetails {
  id: string
  projectId: string
  revision: number
  createdBy: string
  updatedAt: string
}
export interface AssistantSelection {
  assistantId: string
  presetRevision: number
  configuration: QuestionConfiguration
}
export const AssistantSelection = S.Struct({
  assistantId: DirectoryId,
  presetRevision: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1)),
  configuration: QuestionConfiguration,
})
export interface AssistantAvailability {
  preset: AssistantPreset
  available: boolean
  reason?: { code: string; message: string }
}
export interface AssistantDirectory {
  items: AssistantAvailability[]
  defaultAssistantId: string | null
  canAdjust: boolean
  ready: boolean
  reason?: { code: string; message: string }
}
