import * as S from 'effect/Schema'
import { AccountKind, CreateUser, ChangePassword, ResetPassword } from './index.ts'
import { DirectoryId } from './project-directory.ts'

export const AccountRevision = S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1))
export const RuntimeAccount = S.Struct({
  id: DirectoryId,
  username: CreateUser.fields.username,
  name: CreateUser.fields.name,
  kind: AccountKind,
  platformAdmin: S.Boolean,
  enabled: S.Boolean,
  revision: AccountRevision,
})
export type RuntimeAccount = typeof RuntimeAccount.Type
export const AccountOperation = S.Literals([
  'create',
  'enable',
  'delete',
  'resetPassword',
  'changePassword',
])
export type AccountOperation = typeof AccountOperation.Type
const command = { requestId: S.String.check(S.isUUID()) }
export const CreateAccountCommand = S.Struct({ ...command, value: CreateUser })
export const EnableAccountCommand = S.Struct({
  ...command,
  expectedRevision: AccountRevision,
  value: S.Struct({ enabled: S.Boolean }),
})
export const DeleteAccountCommand = S.Struct({
  ...command,
  expectedRevision: AccountRevision,
  value: S.Struct({}),
})
export interface AccountDeletionResult {
  deleted: true
  userId: string
  revision: number
}
export const ResetAccountPasswordCommand = S.Struct({
  ...command,
  expectedRevision: AccountRevision,
  value: ResetPassword,
})
export const ChangeAccountPasswordCommand = S.Struct({
  ...command,
  expectedRevision: AccountRevision,
  value: ChangePassword,
})
export interface AccountPasswordResult {
  userId: string
  revision: number
  sessionsRevoked: true
  loginPath: '/'
}
export interface AccountReceipt {
  state: 'completed'
  requestId: string
  operation: AccountOperation
  targetId: string
  result: RuntimeAccount | AccountPasswordResult | AccountDeletionResult
  createdAt: string
}
export interface AccountPage {
  items: RuntimeAccount[]
  nextCursor: string | null
}
export interface AccountSavedUnavailable {
  saved: true
  available: false
}
