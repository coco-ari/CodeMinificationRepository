// 启动数据只投影已经裁决的范围，不读取会话表或打开宿主资源。
export function projectAccessBootstrap({ current, catalog, membershipForUser, projectCapabilities, configuration, assistantCatalog, canManageDeploymentNodes = false }) {
  const { profile, model, modelSelectionEnabled, customerAgentsEnabled } = configuration
  const visibleProjects = catalog.projects.filter((entry) => { try { membershipForUser(current.id, entry.id); return true } catch { return false } })
  return {
    principal: { id: current.id, displayName: current.displayName, role: current.role },
    csrfToken: current.csrf,
    canCreateProject: catalog.users.find(user => user.id === current.id)?.kind !== 'external',
    canManageDeploymentNodes,
    gatewayBasePath: '/api/agent-demo/t3',
    fixedModel: { instanceId: 'codex', model },
    modelSelectionEnabled,
    runtimeMode: 'approval-required',
    customerAgentsEnabled,
    ...(assistantCatalog ? { assistantDirectoryEnabled: true } : {}),
    projects: visibleProjects.map(({ id, name, environments }) => ({
      ...(assistantCatalog ? { assistants: assistantCatalog(current.id, id) } : {}),
      id, name, capabilities: projectCapabilities(current.id, id), environments: environments.filter((entry) => membershipForUser(current.id, id).environmentIds.includes(entry.id)), membership: membershipForUser(current.id, id),
      agents: catalog.agents.filter((agent) => agent.projectIds.includes(id)).map(({ id, name }) => ({ id, name })),
    })),
    agents: catalog.agents.filter((entry) => entry.projectIds.some((id) => visibleProjects.some((project) => project.id === id))),
    productProfile: { id: profile.id },
    capabilities: profile.capabilities,
    clientSettingsOverrides: profile.clientSettingsOverrides,
  }
}
