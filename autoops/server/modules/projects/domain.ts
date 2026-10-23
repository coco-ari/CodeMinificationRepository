import type { Environment, Project } from '../../../contracts/index.ts'
import type { ProjectDirectory } from '../../platform/ports.ts'
export interface ProjectRepository extends ProjectDirectory {
  insert(project: Project): void
  get(id: string): Project | undefined
  candidates(userId: string, admin: boolean, after: string, limit: number): readonly Project[]
  addMember(projectId: string, userId: string): void
  removeMember(projectId: string, userId: string): void
  members(projectId: string, after: string, limit: number): readonly string[]
  addEnvironment(value: Environment): void
  environments(
    projectId: string,
    scope: 'all' | readonly string[],
    after: string,
    limit: number,
  ): readonly Environment[]
  receipt(
    key: string,
  ): { actorId: string; operation: string; payload: string; result: unknown } | undefined
  saveReceipt(
    key: string,
    actorId: string,
    operation: string,
    payload: string,
    result: unknown,
  ): void
}
export interface MembershipAccess {
  initializeProject(userId: string, projectId: string): void
  removeMemberAccess(actorId: string, projectId: string, userId: string): void
}
