import * as S from 'effect/Schema'
import { Role } from './index.ts'

export const ProjectRole = Role
export type ProjectRole = typeof Role.Type
export const EnvironmentRole = S.Literals(['developer', 'release_operator', 'reader'])
export type EnvironmentRole = typeof EnvironmentRole.Type
export const isProjectRole = S.is(ProjectRole)
export const isEnvironmentRole = S.is(EnvironmentRole)
export const projectActions = [
  'project.read',
  'project.manage',
  'project.members.manage',
  'workspace.read',
  'workspace.manage',
  'workspace.external.publish',
  'workspace.cleanup',
  'repository.manage',
  'repository.read',
  'source.generate',
  'credential.use',
  'credential.manage',
  'chat.use',
  'chat.configure',
] as const
export type ProjectAction = (typeof projectActions)[number]
export const deploymentActions = [
  'read',
  'configure',
  'service.configure',
  'publish',
  'restart',
  'rollback',
  'source.download',
  'source.clear',
  'server.create',
  'server.bind',
  'server.unbind',
  'server.admin',
] as const
export type DeploymentAction = (typeof deploymentActions)[number]
export const roleProjectActions: Readonly<Record<ProjectRole, readonly ProjectAction[]>> = {
  project_admin: projectActions,
  developer: [
    'project.read',
    'workspace.read',
    'workspace.manage',
    'repository.read',
    'source.generate',
    'credential.use',
    'chat.use',
  ],
  release_operator: [
    'project.read',
    'workspace.read',
    'repository.read',
    'credential.use',
    'chat.use',
  ],
  reader: ['project.read', 'workspace.read', 'repository.read', 'credential.use', 'chat.use'],
  external: ['project.read', 'workspace.read', 'chat.use'],
}
export function projectRoleAllows(role: ProjectRole, action: ProjectAction): boolean {
  return roleProjectActions[role].includes(action)
}
export function environmentRoleAllows(role: ProjectRole, action: DeploymentAction): boolean {
  if (role === 'project_admin') return true
  if (
    role === 'external' ||
    [
      'service.configure',
      'source.clear',
      'server.create',
      'server.bind',
      'server.unbind',
      'server.admin',
    ].includes(action)
  )
    return false
  if (action === 'read' || action === 'source.download') return true
  return role === 'release_operator'
}
