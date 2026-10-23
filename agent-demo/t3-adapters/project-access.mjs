// 项目成员事实和动作判断只在此处维护；会话身份由调用方先校验。
export function createProjectAccess({ catalog, fail, deploymentEnabled }) {
  function membershipForUser(userId, projectId) {
    const project = catalog.projects.find((entry) => entry.id === projectId)
    const user = catalog.users.find((entry) => entry.id === userId)
    const configured = project?.memberships?.find((entry) => entry.userId === userId)
    const membership = configured || (project?.memberIds.includes(userId) ? { userId, workspaceAccess: 'internal', role: user?.role === 'admin' ? 'manager' : 'member', environmentIds: project.environments.map((entry) => entry.id), status: 'active' } : undefined)
    if (!project || !user || (user.status !== undefined && user.status !== 'active') || !membership || membership.status !== 'active' ||
        !['internal', 'external'].includes(membership.workspaceAccess) || !['manager', 'member'].includes(membership.role) ||
        !Array.isArray(membership.environmentIds) || membership.environmentIds.some((id) => !project.environments.some((environment) => environment.id === id)))
      fail(404, 'PROJECT_NOT_FOUND', '项目不存在或无权访问')
    return { userId, workspaceAccess: membership.workspaceAccess, role: membership.role, environmentIds: [...new Set(membership.environmentIds)], status: 'active' }
  }
  const canManageWorkspace = (membership) => membership.workspaceAccess === 'internal' && membership.role === 'manager'
  function requireWorkspaceManagerForUser(userId, projectId) {
    const membership = membershipForUser(userId, projectId)
    if (membership.workspaceAccess !== 'internal') fail(403, 'WORKSPACE_FORBIDDEN', '无权访问内部原始资料')
    if (!canManageWorkspace(membership)) fail(403, 'WORKSPACE_MANAGEMENT_FORBIDDEN', '只有项目内部管理者可以管理工作区')
    return membership
  }
  function requireDeploymentActor(userId, projectId, environmentId) {
    const membership = requireWorkspaceManagerForUser(userId, projectId)
    if (!membership.environmentIds.includes(environmentId)) fail(403, 'ENVIRONMENT_FORBIDDEN', '无权访问此项目环境')
    if (!deploymentEnabled()) fail(503, 'DEPLOYMENT_DISABLED', '部署验证尚未启用')
    return membership
  }
  function requireCredentialActor(userId, projectId, action) {
    if (!['credential.use', 'credential.manage'].includes(action)) fail(403, 'CREDENTIAL_ACTION_FORBIDDEN', '凭证操作未授权')
    return requireWorkspaceManagerForUser(userId, projectId)
  }
  function projectCapabilities(userId, projectId) {
    const membership = membershipForUser(userId, projectId)
    const manage = canManageWorkspace(membership)
    const deployment = manage && membership.environmentIds.length > 0 && deploymentEnabled()
    return { 'workspace.read': true, 'workspace.manage': manage, 'credential.use': manage, 'credential.manage': manage, 'deployment.read': manage, 'deployment.execute': deployment }
  }
  return { membershipForUser, requireWorkspaceManagerForUser, requireCredentialActor, requireDeploymentActor, projectCapabilities }
}
