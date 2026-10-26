import * as S from 'effect/Schema'
import { Name } from './index.ts'
import { EnvironmentRole, ProjectRole } from './project-access.ts'

export const DirectoryId = S.String.check(S.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/))
export const ProjectDetails = S.Struct({
  name: Name,
  description: S.String.check(S.isMaxLength(2000)),
})
export const EnvironmentDetails = S.Struct({ name: Name })
export const MembershipDetails = S.Struct({
  userId: DirectoryId,
  role: ProjectRole,
  environmentIds: S.Array(DirectoryId),
  environmentRoles: S.Record(DirectoryId, EnvironmentRole),
  canAdjustChat: S.Boolean,
  status: S.Literals(['active', 'disabled']),
})
export type MembershipDetails = typeof MembershipDetails.Type
export interface DirectoryProject {
  id: string
  name: string
  description: string
  revision: number
  createdBy: string
  createdAt: string
  environments: Array<{ id: string; name: string; revision: number }>
}
export interface DirectoryMember extends MembershipDetails {
  name: string
  kind: 'internal' | 'external'
  revision: number
  authorizationPending: boolean
}
export interface ProjectSettings {
  project: DirectoryProject
  members: DirectoryMember[]
  candidates: Array<{ id: string; name: string; kind: 'internal' | 'external' }>
}
export const DirectoryCommand = S.Struct({
  requestId: DirectoryId,
  expectedRevision: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
})
export const CreateProjectCommand = S.Struct({ ...DirectoryCommand.fields, value: ProjectDetails })
export const SaveEnvironmentCommand = S.Struct({
  ...DirectoryCommand.fields,
  value: EnvironmentDetails,
})
export const SaveMemberCommand = S.Struct({ ...DirectoryCommand.fields, value: MembershipDetails })
export const DeleteDirectoryCommand = S.Struct({
  requestId: DirectoryId,
  expectedRevision: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1)),
})
export interface DeletionBlocker {
  kind: string
  count: number
  message: string
}
export interface DeletionPreview {
  revision: number
  canDelete: boolean
  blockers: DeletionBlocker[]
  truncated: boolean
}
export interface DirectoryDeletionResult {
  deleted: true
  projectId: string
  environmentId?: string
}
export interface ProjectDeletionReceipt {
  state: 'pending' | 'deleted' | 'blocked'
  projectId: string
  requestId: string
  blockers: DeletionBlocker[]
}

export interface ProjectWriteUnavailable {
  saved: true
  available: false
}
