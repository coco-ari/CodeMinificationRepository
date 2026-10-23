import * as S from 'effect/Schema'

export const Id = S.String.check(S.isUUID())
export const Name = S.String.check(
  S.isBetweenLength(1, 120),
  S.isPattern(/^\S(?:[^\x00-\x1f\x7f]*\S)?$/),
)
export const Password = S.String.check(S.isBetweenLength(12, 128))
export const Username = S.String.check(S.isPattern(/^[a-z][a-z0-9._-]{2,63}$/))
export const AccountKind = S.Literals(['internal', 'external'])
export const Role = S.Literals([
  'project_admin',
  'developer',
  'release_operator',
  'reader',
  'external',
])
export type Role = typeof Role.Type
export const User = S.Struct({
  id: Id,
  username: Username,
  name: Name,
  kind: AccountKind,
  platformAdmin: S.Boolean,
  enabled: S.Boolean,
})
export type User = typeof User.Type
export const CreateUser = S.Struct({
  username: Username,
  name: Name,
  password: Password,
  kind: AccountKind,
  platformAdmin: S.Boolean,
})
export const Login = S.Struct({
  username: Username,
  password: S.String.check(S.isBetweenLength(1, 128)),
})
export const UpdateAccount = S.Struct({ enabled: S.Boolean })
export const ChangePassword = S.Struct({
  currentPassword: S.String.check(S.isBetweenLength(1, 128)),
  newPassword: Password,
})
export const ResetPassword = S.Struct({ newPassword: Password })
export const CreateProject = S.Struct({
  name: Name,
  description: S.String.check(S.isMaxLength(2000)),
})
export const Project = S.Struct({
  id: Id,
  name: Name,
  description: S.String,
  createdBy: Id,
  createdAt: S.Number,
})
export type Project = typeof Project.Type
export const CreateEnvironment = S.Struct({ name: Name })
export const Environment = S.Struct({ id: Id, projectId: Id, name: Name, createdAt: S.Number })
export type Environment = typeof Environment.Type
export const AddMember = S.Struct({ userId: Id })
export const CreateGrant = S.Struct({ userId: Id, role: Role, environmentId: S.NullOr(Id) })
export const Grant = S.Struct({
  id: Id,
  projectId: Id,
  userId: Id,
  role: Role,
  environmentId: S.NullOr(Id),
})
export type Grant = typeof Grant.Type

export const actions = [
  'account.manage',
  'project.create',
  'project.read',
  'project.members.manage',
  'environment.read',
  'environment.manage',
  'grant.manage',
  'audit.read',
  'workspace.read',
  'deployment.execute',
  'deployment.rollback',
  'credential.use',
  'credential.manage',
  'conversation.read',
  'device.execute',
  'cabinet.operate',
  'cabinet.reset-config',
] as const
export type Action = (typeof actions)[number]
// 仅投影第一波已闭环能力，未来动作不因此出现在菜单或可调用入口。
export const implementedActions: readonly Action[] = [
  'account.manage',
  'project.create',
  'project.read',
  'project.members.manage',
  'environment.read',
  'environment.manage',
  'grant.manage',
  'audit.read',
]
export interface Resource {
  readonly projectId?: string
  readonly environmentId?: string
  readonly ownerId?: string
  readonly visibility?: 'private' | 'project'
  readonly audience?: 'internal' | 'external'
}
export const errorStatuses = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const
export type ErrorCode = keyof typeof errorStatuses
export const ApiError = S.Struct({
  error: S.Struct({
    code: S.Literals(Object.keys(errorStatuses) as ErrorCode[]),
    message: S.String,
    requestId: S.String,
  }),
})
export const LoginResult = S.Struct({ user: User, csrfToken: S.String, expiresAt: S.Number })
