const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const usage = (value) => value && typeof value === 'object' ? { used: number(value.used), total: number(value.total) } : null
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null

// 共享节点只展示主机用量；容器、任务和清理明细可能属于其他项目。
export function deploymentServerDto(server, environmentId) {
  if (server.projectAllowed === false) return { id: server.id, name: server.name, ...(environmentId === undefined ? {} : { environmentId }), projectAllowed: false }
  const policy = server.storagePolicy, status = server.storageStatus
  return {
    id: server.id,
    name: server.name,
    ...(server.projectAllowed === undefined ? {} : { projectAllowed: server.projectAllowed }),
    ...(environmentId === undefined ? {} : { environmentId }),
    online: server.online === true,
    version: typeof server.version === 'string' ? server.version : null,
    revoked: server.revoked === true,
    capabilities: Array.isArray(server.capabilities) ? server.capabilities.filter((value) => typeof value === 'string') : [],
    lastSeenAt: timestamp(server.lastSeenAt),
    registeredAt: timestamp(server.registeredAt),
    metrics: server.metrics ? { cpuPercent: number(server.metrics.cpuPercent), memory: usage(server.metrics.memory), disk: usage(server.metrics.disk), centerRttMs: number(server.metrics.centerRttMs) } : null,
    storagePolicy: policy ? { revision: policy.revision, retainedVersions: policy.retainedVersions, buildCacheGiB: policy.buildCacheGiB } : null,
    storageState: ['unsupported', 'waiting', 'pending', 'applying', 'applied', 'failed'].includes(server.storageState) ? server.storageState : 'unsupported',
    storageStatus: status && ['applying', 'applied', 'failed'].includes(status.state) ? {
      revision: number(status.revision), state: status.state, startedAt: timestamp(status.startedAt), checkedAt: timestamp(status.checkedAt),
      cache: status.cache ? { bytes: number(status.cache.bytes), limitBytes: number(status.cache.limitBytes), reclaimedBytes: number(status.cache.reclaimedBytes), withinLimit: status.cache.withinLimit === true } : null,
    } : null,
  }
}

export function createDeploymentServers({ deployment }) {
  const projects = deployment.projects
  return {
    availableServers: (projectId) => projects.availableServers(projectId).map((server) => deploymentServerDto(server)),
    server: (projectId, id) => deploymentServerDto(projects.server(projectId, id)),
    async createServer(projectId, input) {
      const result = await projects.recoverServerCommand(projectId, 'create', null, input)
      return { server: deploymentServerDto(result.server, input.environmentId), registrationToken: result.registrationToken, expiresAt: result.expiresAt, ...(result.installCommand ? { installCommand: result.installCommand } : {}), ...(result.repeated ? { repeated: true } : {}) }
    },
    async bindServer(projectId, input) {
      const value = await projects.bindServer(projectId, input)
      return deploymentServerDto({ ...value, projectAllowed: projects.snapshot(projectId).mapping.allowedServerIds.includes(value.id) }, input.environmentId)
    },
    unbindServer: (projectId, input) => projects.unbindServer(projectId, input),
    revokeServer: (projectId, id, input) => projects.recoverServerCommand(projectId, 'revoke', id, input),
    deleteServer: (projectId, id, input) => projects.recoverServerCommand(projectId, 'delete', id, input),
    async saveStoragePolicy(projectId, id, input) { return deploymentServerDto(await projects.recoverServerCommand(projectId, 'storage', id, input)) },
  }
}
