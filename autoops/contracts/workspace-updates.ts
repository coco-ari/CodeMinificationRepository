import * as S from 'effect/Schema'
import { DirectoryCommand, DirectoryId } from './project-directory.ts'
import type { WorkspaceTask } from './workspaces.ts'

export const WorkspaceUpdateScope = S.Literals(['internal', 'external'])
export type WorkspaceUpdateScope = typeof WorkspaceUpdateScope.Type
export const WorkspaceRedactionRules = S.Array(
  S.Struct({
    find: S.String.check(S.isMinLength(1), S.isMaxLength(1000)),
    replace: S.String.check(S.isMaxLength(1000)),
  }),
).check(S.isMaxLength(100))
export const WorkspaceUpdateSettings = S.Struct({
  enabled: S.Boolean,
  rules: S.optionalKey(WorkspaceRedactionRules),
  intervalMinutes: S.Number.check(
    S.isInt(),
    S.isGreaterThanOrEqualTo(5),
    S.isLessThanOrEqualTo(43_200),
  ),
  timezone: S.String.check(S.isMinLength(1), S.isMaxLength(80)),
  sourceIds: S.Array(DirectoryId).check(S.isMaxLength(32)),
})
export type WorkspaceUpdateSettings = typeof WorkspaceUpdateSettings.Type
export const SaveWorkspaceUpdate = S.Struct({
  ...DirectoryCommand.fields,
  value: WorkspaceUpdateSettings,
})
export type SaveWorkspaceUpdate = typeof SaveWorkspaceUpdate.Type
export const RunWorkspaceUpdate = S.Struct({
  requestId: S.String.check(
    S.isMinLength(1),
    S.isMaxLength(160),
    S.isPattern(/^[^\x00-\x1f\x7f]+$/),
  ),
  expectedRevision: S.optionalKey(S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0))),
  rules: S.optionalKey(WorkspaceRedactionRules),
})
export type RunWorkspaceUpdate = typeof RunWorkspaceUpdate.Type

export interface WorkspaceUpdateRun {
  requestId: string
  actorId: string
  kind: 'manual' | 'scheduled'
  acceptedAt: string
  finishedAt?: string
  outcome?: 'completed' | 'pending_review' | 'failed' | 'rejected'
  error?: { code: string; message: string }
  task?: WorkspaceTask
}

export interface WorkspaceUpdatePlan extends WorkspaceUpdateSettings {
  projectId: string
  scope: WorkspaceUpdateScope
  revision: number
  actorId: string
  updatedAt: string
  nextRunAt: string | null
  pausedReason?: { code: string; message: string }
  currentRun?: WorkspaceUpdateRun
  lastRun?: WorkspaceUpdateRun
}

export interface WorkspaceUpdateOverview {
  internal: WorkspaceUpdatePlan | null
  external: WorkspaceUpdatePlan | null
  sources: Array<{ id: string; name: string }>
}
