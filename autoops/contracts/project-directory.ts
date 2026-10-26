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
export const ResumeProjectDeletionCommand = S.Struct({
  operation: S.Literal('project.delete'),
  projectId: DirectoryId,
  publicIntent: S.Struct({ expectedRevision: DeleteDirectoryCommand.fields.expectedRevision }),
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

const ReceiptRevision = S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0))
const SavedRevision = S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1))
const EnvironmentResult = S.Struct({ id: DirectoryId, name: Name, revision: SavedRevision })
const ProjectResult = S.Struct({
  id: DirectoryId,
  name: Name,
  description: S.String.check(S.isMaxLength(2000)),
  revision: SavedRevision,
  createdBy: DirectoryId,
  createdAt: S.String.check(S.isMaxLength(100)),
  environments: S.Array(EnvironmentResult),
})
const MemberResult = S.Struct({
  ...MembershipDetails.fields,
  name: Name,
  kind: S.Literals(['internal', 'external']),
  revision: SavedRevision,
  authorizationPending: S.Boolean,
})
const DeletionResult = S.Struct({
  deleted: S.Literal(true),
  projectId: DirectoryId,
  environmentId: S.optionalKey(DirectoryId),
})
export const DirectoryPublicIntent = S.Union([
  S.Struct({ expectedRevision: ReceiptRevision, value: ProjectDetails }),
  S.Struct({ expectedRevision: ReceiptRevision, value: EnvironmentDetails }),
  S.Struct({ expectedRevision: ReceiptRevision, value: MembershipDetails }),
  S.Struct({ expectedRevision: ReceiptRevision }),
])
export const DirectoryRequestReceipt = S.Struct({
  state: S.Literals(['completed', 'pending', 'blocked']),
  requestId: DirectoryId,
  actorId: DirectoryId,
  projectId: DirectoryId,
  environmentId: S.NullOr(DirectoryId),
  operation: S.String.check(
    S.isPattern(
      /^(?:project\.(?:create|save|delete)|environment\.delete|environment\.save:[A-Za-z0-9][A-Za-z0-9_-]{0,127}|member\.save:[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/,
    ),
  ),
  saved: S.Literal(true),
  available: S.Boolean,
  canResume: S.optionalKey(S.Boolean),
  publicIntent: DirectoryPublicIntent,
  createdAt: S.String.check(S.isMaxLength(100)),
  // 这是当前原生投影的匹配证明，不是原同步调用的收据；GET 不执行补写。
  nativeSynchronization: S.Literals(['current-verified', 'unverified', 'not-required']),
  result: S.optionalKey(S.Union([ProjectResult, EnvironmentResult, MemberResult, DeletionResult])),
  blockers: S.optionalKey(
    S.Array(
      S.Struct({
        kind: S.String.check(S.isMaxLength(80)),
        count: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0), S.isLessThanOrEqualTo(9999)),
        message: S.String.check(S.isMaxLength(160)),
      }),
    ).check(S.isMaxLength(24)),
  ),
})
export type DirectoryRequestReceipt = typeof DirectoryRequestReceipt.Type
