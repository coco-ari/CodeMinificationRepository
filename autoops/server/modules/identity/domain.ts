import type { User } from '../../../contracts/index.ts'

export interface StoredAccount {
  readonly user: User
  readonly passwordHash: string
}
export interface Session {
  readonly userId: string
  readonly csrfHash: string
  readonly expiresAt: number
}
export interface IdentityRepository {
  count(): number
  list(after: string, limit: number): readonly User[]
  byId(id: string): StoredAccount | undefined
  byUsername(username: string): StoredAccount | undefined
  insert(account: StoredAccount): void
  setEnabled(id: string, enabled: boolean): void
  enabledAdmins(): number
  setPassword(id: string, passwordHash: string): void
  saveSession(tokenHash: string, session: Session): void
  session(tokenHash: string): Session | undefined
  deleteSession(tokenHash: string): void
  revokeSessions(userId: string): void
  deleteExpiredSessions(now: number): void
}
export interface Secrets {
  password(value: string): Promise<string>
  verify(value: string, encoded: string): Promise<boolean>
  token(): string
  digest(value: string): string
  equal(a: string, b: string): boolean
}
