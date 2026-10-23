import type { Action, Resource, User } from '../../contracts/index.ts'

export interface Transaction {
  run<T>(operation: () => T): T
}
export interface Runtime {
  now(): number
  id(): string
}
export interface IdentityReader {
  active(userId: string): User
}
export interface Authorization {
  require(userId: string, action: Action, resource?: Resource): User
  allows(userId: string, action: Action, resource?: Resource): boolean
  environmentScope(userId: string, projectId: string): 'all' | readonly string[]
}
export interface ProjectDirectory {
  exists(projectId: string): boolean
  creator(projectId: string): string | undefined
  member(projectId: string, userId: string): boolean
  environmentProject(environmentId: string): string | undefined
}
export interface AuditWriter {
  append(actorId: string, action: string, targetId: string, projectId?: string): void
}
