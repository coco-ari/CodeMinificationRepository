import * as C from '../../../contracts/index.ts'
import type {
  AuditWriter,
  Authorization,
  IdentityReader,
  ProjectDirectory,
  Runtime,
  Transaction,
} from '../../platform/ports.ts'
import { decode, requireCondition as must } from '../../platform/errors.ts'
import { permitted, type GrantRepository } from './domain.ts'

export function createAccessService(
  repo: GrantRepository,
  identity: IdentityReader,
  directory: ProjectDirectory,
  tx: Transaction,
  audit: AuditWriter,
  runtime: Runtime,
) {
  const allows: Authorization['allows'] = (userId, action, resource = {}) => {
    const user = identity.active(userId)
    if (resource.projectId && !directory.exists(resource.projectId)) return false
    if (
      resource.environmentId &&
      directory.environmentProject(resource.environmentId) !== resource.projectId
    )
      return false
    return permitted(
      user,
      action,
      resource,
      resource.projectId ? repo.list(resource.projectId, userId) : [],
      !!resource.projectId && directory.member(resource.projectId, userId),
    )
  }
  const requireAccess: Authorization['require'] = (userId, action, resource = {}) => {
    must(allows(userId, action, resource), 'FORBIDDEN', '无权执行此范围内的操作')
    return identity.active(userId)
  }
  const protectLastAdmin = (projectId: string, removed: readonly C.Grant[]) => {
    const remaining = repo
      .list(projectId)
      .filter((g) => g.role === 'project_admin' && !removed.some((r) => r.id === g.id))
    must(remaining.length > 0, 'CONFLICT', '项目至少保留一个项目管理员')
  }
  return {
    allows,
    require: requireAccess,
    environmentScope(userId: string, projectId: string): 'all' | readonly string[] {
      const user = requireAccess(userId, 'project.read', { projectId }),
        grants = repo.list(projectId, userId)
      if (
        user.platformAdmin ||
        grants.some((g) => g.role === 'project_admin' && g.environmentId === null)
      )
        return 'all'
      return [
        ...new Set(
          grants.flatMap((g) =>
            g.environmentId &&
            allows(userId, 'environment.read', { projectId, environmentId: g.environmentId })
              ? [g.environmentId]
              : [],
          ),
        ),
      ]
    },
    capabilities(userId: string, resource: C.Resource) {
      return C.implementedActions.filter((action) => allows(userId, action, resource))
    },
    initializeProject(userId: string, projectId: string) {
      return tx.run(() => {
        requireAccess(userId, 'project.create')
        must(
          directory.creator(projectId) === userId &&
            directory.member(projectId, userId) &&
            repo.list(projectId).length === 0,
          'FORBIDDEN',
          '不能重复或代替他人初始化项目权限',
        )
        repo.insert({
          id: runtime.id(),
          userId,
          projectId,
          role: 'project_admin',
          environmentId: null,
        })
        audit.append(userId, 'grant.initialize', projectId, projectId)
      })
    },
    list(userId: string, projectId: string, after = '') {
      requireAccess(userId, 'grant.manage', { projectId })
      const items = repo.page(projectId, after ? decode(C.Id, after) : '', 100)
      return { items, nextCursor: items.length === 100 ? items.at(-1)!.id : null }
    },
    assign(userId: string, projectId: string, input: unknown) {
      const value = decode(C.CreateGrant, input)
      return tx.run(() => {
        requireAccess(userId, 'grant.manage', { projectId })
        const target = identity.active(value.userId)
        must(directory.member(projectId, target.id), 'INVALID_INPUT', '授权对象必须是当前项目成员')
        must(
          target.kind === 'external' ? value.role === 'external' : value.role !== 'external',
          'INVALID_INPUT',
          '角色与账号类型不匹配',
        )
        must(
          value.role !== 'project_admin' || value.environmentId === null,
          'INVALID_INPUT',
          '项目管理员使用项目范围',
        )
        if (value.environmentId)
          must(
            directory.environmentProject(value.environmentId) === projectId,
            'INVALID_INPUT',
            '环境不属于当前项目',
          )
        const existing = repo
          .list(projectId, target.id)
          .find((g) => g.role === value.role && g.environmentId === value.environmentId)
        if (existing) return existing
        const grant = { id: runtime.id(), projectId, ...value }
        repo.insert(grant)
        audit.append(userId, 'grant.assign', grant.id, projectId)
        return grant
      })
    },
    revoke(userId: string, projectId: string, grantId: string) {
      tx.run(() => {
        requireAccess(userId, 'grant.manage', { projectId })
        const grant = repo.get(grantId)
        must(grant?.projectId === projectId, 'NOT_FOUND', '授权不存在')
        protectLastAdmin(projectId, [grant])
        repo.remove(grantId)
        audit.append(userId, 'grant.revoke', grantId, projectId)
      })
    },
    removeMemberAccess(userId: string, projectId: string, targetId: string) {
      tx.run(() => {
        requireAccess(userId, 'project.members.manage', { projectId })
        protectLastAdmin(projectId, repo.list(projectId, targetId))
        repo.removeMember(projectId, targetId)
        audit.append(userId, 'grant.member.remove', targetId, projectId)
      })
    },
  }
}
export type AccessService = ReturnType<typeof createAccessService>
