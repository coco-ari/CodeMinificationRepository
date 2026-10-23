import * as C from '../../../contracts/index.ts'
import { decode, requireCondition as must } from '../../platform/errors.ts'
import type {
  AuditWriter,
  Authorization,
  IdentityReader,
  Runtime,
  Transaction,
} from '../../platform/ports.ts'
import type { MembershipAccess, ProjectRepository } from './domain.ts'

export function createProjectService(
  repo: ProjectRepository,
  auth: Authorization,
  membershipAccess: MembershipAccess,
  identity: IdentityReader,
  tx: Transaction,
  audit: AuditWriter,
  runtime: Runtime,
) {
  const cursor = (after: string) => (after ? decode(C.Id, after) : '')
  return {
    create(userId: string, input: unknown, commandId: string) {
      const value = decode(C.CreateProject, input),
        key = decode(C.Id, commandId),
        payload = JSON.stringify([value.name, value.description])
      return tx.run(() => {
        auth.require(userId, 'project.create')
        const receipt = repo.receipt(key)
        if (receipt) {
          must(
            receipt.actorId === userId &&
              receipt.operation === 'project.create' &&
              receipt.payload === payload,
            'CONFLICT',
            '幂等标识已经用于其他操作或参数',
          )
          const project = decode(C.Project, receipt.result)
          auth.require(userId, 'project.read', { projectId: project.id })
          return project
        }
        const project = { id: runtime.id(), ...value, createdBy: userId, createdAt: runtime.now() }
        repo.insert(project)
        repo.addMember(project.id, userId)
        membershipAccess.initializeProject(userId, project.id)
        audit.append(userId, 'project.create', project.id, project.id)
        repo.saveReceipt(key, userId, 'project.create', payload, project)
        return project
      })
    },
    get(userId: string, projectId: string) {
      auth.require(userId, 'project.read', { projectId })
      return repo.get(projectId)!
    },
    list(userId: string, after = '') {
      const user = identity.active(userId),
        rows = repo.candidates(userId, user.platformAdmin, cursor(after), 100)
      // 先限制扫描批次再逐项授权，游标允许跳过当前账号不可见的资源。
      return {
        items: rows.filter((p) => auth.allows(userId, 'project.read', { projectId: p.id })),
        nextCursor: rows.length === 100 ? rows.at(-1)!.id : null,
      }
    },
    addEnvironment(userId: string, projectId: string, input: unknown, commandId: string) {
      const value = decode(C.CreateEnvironment, input),
        key = decode(C.Id, commandId),
        payload = JSON.stringify([projectId, value.name])
      return tx.run(() => {
        auth.require(userId, 'environment.manage', { projectId })
        const receipt = repo.receipt(key)
        if (receipt) {
          must(
            receipt.actorId === userId &&
              receipt.operation === 'environment.create' &&
              receipt.payload === payload,
            'CONFLICT',
            '幂等标识已经用于其他操作或参数',
          )
          return decode(C.Environment, receipt.result)
        }
        const environment = { id: runtime.id(), projectId, ...value, createdAt: runtime.now() }
        repo.addEnvironment(environment)
        audit.append(userId, 'environment.create', environment.id, projectId)
        repo.saveReceipt(key, userId, 'environment.create', payload, environment)
        return environment
      })
    },
    environments(userId: string, projectId: string, after = '') {
      auth.require(userId, 'project.read', { projectId })
      const rows = repo.environments(
        projectId,
        auth.environmentScope(userId, projectId),
        cursor(after),
        100,
      )
      return {
        items: rows.filter((e) =>
          auth.allows(userId, 'environment.read', { projectId, environmentId: e.id }),
        ),
        nextCursor: rows.length === 100 ? rows.at(-1)!.id : null,
      }
    },
    addMember(userId: string, projectId: string, input: unknown) {
      const value = decode(C.AddMember, input)
      tx.run(() => {
        auth.require(userId, 'project.members.manage', { projectId })
        identity.active(value.userId)
        repo.addMember(projectId, value.userId)
        audit.append(userId, 'project.member.add', value.userId, projectId)
      })
    },
    removeMember(userId: string, projectId: string, targetId: string) {
      tx.run(() => {
        auth.require(userId, 'project.members.manage', { projectId })
        must(repo.member(projectId, targetId), 'NOT_FOUND', '成员不存在')
        membershipAccess.removeMemberAccess(userId, projectId, targetId)
        repo.removeMember(projectId, targetId)
        audit.append(userId, 'project.member.remove', targetId, projectId)
      })
    },
    members(userId: string, projectId: string, after = '') {
      auth.require(userId, 'project.members.manage', { projectId })
      const ids = repo.members(projectId, cursor(after), 100)
      return { items: ids, nextCursor: ids.length === 100 ? ids.at(-1)! : null }
    },
  }
}
