import type { Action, Grant, Resource, Role, User } from '../../../contracts/index.ts'

const roleActions: Record<Role, readonly Action[]> = {
  project_admin: [
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
  ],
  developer: ['project.read', 'environment.read', 'workspace.read', 'conversation.read'],
  release_operator: [
    'project.read',
    'environment.read',
    'workspace.read',
    'deployment.execute',
    'deployment.rollback',
    'credential.use',
    'conversation.read',
  ],
  reader: ['project.read', 'environment.read', 'workspace.read', 'conversation.read'],
  external: ['project.read', 'environment.read', 'workspace.read', 'conversation.read'],
}
export function permitted(
  user: User,
  action: Action,
  resource: Resource,
  grants: readonly Grant[],
  member: boolean,
): boolean {
  if (!user.enabled) return false
  if (resource.visibility === 'private' && resource.ownerId !== user.id) return false
  if (action === 'device.execute') return resource.ownerId === user.id
  if (action === 'cabinet.operate') return user.kind === 'internal'
  if (action === 'account.manage' || action === 'cabinet.reset-config')
    return user.platformAdmin && user.kind === 'internal'
  if (action === 'project.create') return user.kind === 'internal'
  if (!resource.projectId) return false
  if (
    user.kind === 'external' &&
    (resource.audience === 'internal' ||
      (action === 'workspace.read' && resource.audience !== 'external'))
  )
    return false
  if (user.platformAdmin && user.kind === 'internal') return true
  if (!member) return false
  return grants.some((grant) => {
    if (
      grant.userId !== user.id ||
      grant.projectId !== resource.projectId ||
      !roleActions[grant.role].includes(action)
    )
      return false
    if (user.kind === 'external' && grant.role !== 'external') return false
    // 动作和范围始终在同一条授权内匹配，不合并不同环境的权限集合。
    return resource.environmentId
      ? grant.environmentId === resource.environmentId ||
          (grant.role === 'project_admin' && grant.environmentId === null)
      : grant.environmentId === null || action === 'project.read'
  })
}
export interface GrantRepository {
  page(projectId: string, after: string, limit: number): readonly Grant[]
  list(projectId: string, userId?: string): readonly Grant[]
  get(id: string): Grant | undefined
  insert(grant: Grant): void
  remove(id: string): void
  removeMember(projectId: string, userId: string): void
}
