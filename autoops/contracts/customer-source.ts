import * as S from 'effect/Schema'
import { DirectoryId } from './project-directory.ts'

export const RunnerReferenceId = S.String.check(S.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/))
export const CustomerAssistantSource = S.Struct({
  kind: S.Literal('customer'),
  deviceId: DirectoryId,
  registeredWorkspaceId: RunnerReferenceId,
  workspaceBindingRevision: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1)),
  runtimeId: S.Literal('codex'),
})
