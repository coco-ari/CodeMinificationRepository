import { deploymentActions, environmentRoleAllows, isEnvironmentRole, isProjectRole, projectActions, projectRoleAllows } from '../../autoops/contracts/project-access.ts'

// 项目角色决定项目动作；环境显式角色替代默认值，不拼接其他环境的权限。
export function createProjectAccess({ catalog, fail, deploymentEnabled }) {
  const userFor = (userId) => catalog.users.find(entry => entry.id === userId && (entry.status === undefined || entry.status === 'active'))
  const platformAdmin = user => user?.role === 'admin' && user.kind !== 'external'
  function membershipForUser(userId, projectId) {
    const project = catalog.projects.find(entry => entry.id === projectId), user = userFor(userId)
    if (!project || !user) fail(404, 'PROJECT_NOT_FOUND', '项目不存在或无权访问')
    if (platformAdmin(user)) return { userId, workspaceAccess: 'internal', role: 'project_admin', environmentIds: project.environments.map(entry => entry.id), environmentRoles: {}, canAdjustChat: true, status: 'active', authorizationPending: false }
    const member = project.memberships?.find(entry => entry.userId === userId)
    if (!member || member.status !== 'active' || !isProjectRole(member.role) ||
        (user.kind === 'external' && member.role !== 'external') ||
        !Array.isArray(member.environmentIds) || member.environmentIds.some(id => !project.environments.some(environment => environment.id === id)) ||
        (member.role === 'external' && member.environmentIds.length) ||
        (member.environmentRoles !== undefined && (!member.environmentRoles || typeof member.environmentRoles !== 'object' || Array.isArray(member.environmentRoles) || Object.entries(member.environmentRoles).some(([id, role]) => !member.environmentIds.includes(id) || !isEnvironmentRole(role)))))
      fail(404, 'PROJECT_NOT_FOUND', '项目不存在或无权访问')
    return { userId, role: member.role, workspaceAccess: member.role === 'external' ? 'external' : 'internal', environmentIds: member.role === 'project_admin' ? project.environments.map(entry => entry.id) : [...new Set(member.environmentIds)], environmentRoles: { ...member.environmentRoles }, canAdjustChat: member.role === 'project_admin' || member.canAdjustChat === true, status: 'active', authorizationPending: member.authorizationPending === true }
  }
  function requireProjectActionForUser(userId, projectId, action) {
    const member = membershipForUser(userId, projectId)
    if (member.authorizationPending && projectActions.includes(action) && !['project.read', 'workspace.read', 'chat.use', 'chat.configure', 'credential.use'].includes(action))
      fail(403, 'AUTHORIZATION_PENDING', '此操作授权尚待管理员分配')
    const sourceAllowed = action === 'source.generate' && member.environmentIds.some(id => environmentRoleAllows(member.environmentRoles[id] ?? member.role, 'publish'))
    if (!projectActions.includes(action) || !(action === 'chat.configure' ? member.canAdjustChat : sourceAllowed || projectRoleAllows(member.role, action)))
      fail(403, 'PROJECT_ACTION_FORBIDDEN', '无权执行此项目操作')
    return member
  }
  function requireWorkspaceManagerForUser(userId, projectId) {
    const member = membershipForUser(userId, projectId)
    if (member.workspaceAccess !== 'internal') fail(403, 'WORKSPACE_FORBIDDEN', '无权访问内部原始资料')
    if (member.authorizationPending || !projectRoleAllows(member.role, 'workspace.manage')) fail(403, 'WORKSPACE_MANAGEMENT_FORBIDDEN', '无权维护项目工作区')
    return member
  }
  function environmentRole(member, environmentId) {
    if (!member.environmentIds.includes(environmentId)) fail(403, 'ENVIRONMENT_FORBIDDEN', '无权访问此项目环境')
    return member.role === 'project_admin' ? member.role : member.environmentRoles[environmentId] ?? member.role
  }
  function requireEnvironmentQueryForUser(userId, projectId, environmentId) {
    const member = requireProjectActionForUser(userId, projectId, 'chat.use')
    environmentRole(member, environmentId)
    if (member.authorizationPending) fail(403, 'AUTHORIZATION_PENDING', '环境查询授权尚待管理员分配')
    return member
  }
  function requireDeploymentAction(userId, projectId, action, environmentId) {
    const member = membershipForUser(userId, projectId)
    if (!deploymentActions.includes(action)) fail(403, 'DEPLOYMENT_ACTION_FORBIDDEN', '部署操作未授权')
    if (member.authorizationPending) fail(403, 'AUTHORIZATION_PENDING', '部署授权尚待管理员分配')
    const role = environmentId === undefined ? member.role : environmentRole(member, environmentId)
    if ((environmentId === undefined && action !== 'read' && role !== 'project_admin') || !environmentRoleAllows(role, action))
      fail(403, 'DEPLOYMENT_ACTION_FORBIDDEN', '此环境角色无权执行部署操作')
    if (!['read', 'source.download'].includes(action) && !deploymentEnabled()) fail(503, 'DEPLOYMENT_DISABLED', '部署尚未启用')
    if (['server.bind', 'server.admin'].includes(action) && !platformAdmin(userFor(userId)))
      fail(403, 'DEPLOYMENT_SERVER_ADMIN_REQUIRED', '共享服务器操作仅限平台管理员')
    return member
  }
  const requireDeploymentActor = (userId, projectId, environmentId) => requireDeploymentAction(userId, projectId, 'publish', environmentId)
  function requireCredentialActor(userId, projectId, action) {
    if (!['credential.use', 'credential.manage'].includes(action)) fail(403, 'CREDENTIAL_ACTION_FORBIDDEN', '凭证操作未授权')
    const member = membershipForUser(userId, projectId)
    if (member.workspaceAccess !== 'internal') fail(403, 'CREDENTIAL_USE_FORBIDDEN', '外部成员不能使用内部源码凭证')
    return requireProjectActionForUser(userId, projectId, action)
  }
  function projectCapabilities(userId, projectId) {
    const member = membershipForUser(userId, projectId)
    const allows = action => {
      try { requireProjectActionForUser(userId, projectId, action); return true }
      catch (error) { if (error.status === 403) return false; throw error }
    }
    const deploys = (action, environmentId) => {
      try { requireDeploymentAction(userId, projectId, action, environmentId); return true }
      catch (error) { if (error.status === 403 || error.code === 'DEPLOYMENT_DISABLED') return false; throw error }
    }
    const deploymentRead = deploys('read')
    const execute = deploymentRead && member.environmentIds.some(id => deploys('publish', id))
    return { 'workspace.read': allows('workspace.read'), 'workspace.manage': allows('workspace.manage'), 'workspace.external.publish': allows('workspace.external.publish'), 'credential.use': allows('credential.use'), 'credential.manage': allows('credential.manage'), 'deployment.read': deploymentRead, 'deployment.execute': execute, 'project.manage': allows('project.manage'), 'chat.use': allows('chat.use'), 'chat.configure': allows('chat.configure') }
  }
  return { membershipForUser, requireProjectActionForUser, requireEnvironmentQueryForUser, requireWorkspaceManagerForUser, requireCredentialActor, requireDeploymentActor, requireDeploymentAction, projectCapabilities }
}
