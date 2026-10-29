const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const usage = (value) => value && typeof value === 'object' ? { used: number(value.used), total: number(value.total) } : null
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null

export function deploymentInstallationInfo(origin, caPath = '', caSha256 = '') {
  if (!caPath && !caSha256) return { origin, ca: null }
  if (!origin || !/^\/[a-zA-Z0-9/_.-]{1,255}$/.test(caPath) || caPath.startsWith('//') || caPath.split('/').includes('..') || !/^(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2}$/.test(caSha256))
    throw new Error('节点接入 CA 配置无效，请同时配置公开证书路径和 SHA256 指纹')
  return { origin, ca: { url: caPath, sha256: caSha256.toUpperCase() } }
}

function storageErrors(errors) {
  // 原报告可能包含其他项目名、路径及命令参数，仅公开可操作的错误分类。
  return [...new Set((Array.isArray(errors) ? errors : []).filter(value => typeof value === 'string').slice(0, 20).map(value =>
    /no space|ENOSPC|空间不足/i.test(value) ? '磁盘空间不足，请检查节点可用空间。'
      : /certificate|TLS|x509|证书/i.test(value) ? '证书校验失败，请检查节点信任配置。'
      : /timeout|timed out|ECONN|network|fetch|resolve|超时|连接/i.test(value) ? '网络或镜像仓库连接失败，请检查节点网络。'
      : /permission|EACCES|denied|权限/i.test(value) ? '执行权限不足，请检查 Agent 和 Docker 权限。'
      : '节点存储维护失败，请由平台管理员检查 Agent 日志。'))].slice(0, 4)
}

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
    registrationState: ['pending', 'expired', 'registered', 'revoked'].includes(server.registrationState) ? server.registrationState : server.revoked ? 'revoked' : server.registeredAt ? 'registered' : 'pending',
    registrationExpiresAt: timestamp(server.registrationExpiresAt),
    metrics: server.metrics ? { cpuPercent: number(server.metrics.cpuPercent), memory: usage(server.metrics.memory), disk: usage(server.metrics.disk), centerRttMs: number(server.metrics.centerRttMs) } : null,
    storagePolicy: policy ? { revision: policy.revision, retainedVersions: policy.retainedVersions, buildCacheGiB: policy.buildCacheGiB } : null,
    storageState: ['unsupported', 'waiting', 'pending', 'applying', 'applied', 'failed'].includes(server.storageState) ? server.storageState : 'unsupported',
    storageWaitingReason: ['offline', 'busy'].includes(server.storageWaitingReason) ? server.storageWaitingReason : null,
    storageStatus: status && ['applying', 'applied', 'failed'].includes(status.state) ? {
      revision: number(status.revision), state: status.state, startedAt: timestamp(status.startedAt), checkedAt: timestamp(status.checkedAt),
      errors: storageErrors(status.errors),
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
