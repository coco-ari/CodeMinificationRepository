const completed = new Set([
  'succeeded',
  'success',
  'failed',
  'rolled_back',
  'cancelled',
  'interrupted',
])
const failed = new Set(['failed', 'rolled_back', 'interrupted'])

const observationPredatesRelease = (target) =>
  Date.parse(target.lastObservedAt) < Date.parse(target.lastDeployedAt)

export function targetHealth(target, servers) {
  const server = servers.find((item) => item.id === target.serverId)
  if (!server?.online || server.revoked) return '失联待确认'
  if (observationPredatesRelease(target)) return '状态待上报'
  const state = target.observation?.state || target.observation?.status
  const health = target.observation?.health || target.observation?.healthStatus
  if (health === 'unhealthy') return '健康异常'
  if (['exited', 'stopped', 'unpublished', 'missing'].includes(state)) return '未运行'
  if (['running', 'published'].includes(state)) return health === 'healthy' ? '健康' : '健康待确认'
  return '状态待上报'
}

export function serviceHealth(targets, servers) {
  const states = targets.map((target) => targetHealth(target, servers))
  const healthy = states.filter((state) => state === '健康').length
  const attention = states.filter((state) =>
    ['健康异常', '未运行', '失联待确认'].includes(state),
  ).length
  return {
    healthy,
    attention,
    label: !states.length
      ? '待配置'
      : healthy === states.length
        ? '健康'
        : states.length === 1
          ? states[0]
          : attention
            ? `${attention}/${states.length} 待处理`
            : `${healthy}/${states.length} 健康`,
    value: attention ? 'unhealthy' : healthy && healthy === states.length ? 'healthy' : 'disabled',
    description:
      targets
        .map(
          (target, index) =>
            `${servers.find((server) => server.id === target.serverId)?.name || '服务器不存在'}：${states[index]}`,
        )
        .join('；') || '尚未配置部署目标',
  }
}

export function targetVersion(target) {
  const release = target.currentRelease
  const observed = target.observation?.revision
  if (
    observed &&
    release?.revision &&
    observed !== release.revision &&
    !observationPredatesRelease(target)
  )
    return { kind: 'drift', revision: observed, label: '运行版本与发布记录不一致' }
  if (release)
    return {
      kind: 'released',
      revision: release.revision || observed,
      branch: release.sourceSnapshot?.branch,
      repositoryId: release.sourceSnapshot?.id,
      repositoryName: release.sourceSnapshot?.name,
      subject: release.commitSubject,
      label: release.sourceSnapshot?.branch || '分支未知',
    }
  return observed
    ? { kind: 'observed', revision: observed, label: '运行版本已发现 · 无发布记录' }
    : { kind: 'unknown', label: '版本待识别' }
}

export function serviceVersion(targets) {
  const versions = targets.map(targetVersion)
  const keys = new Set(
    versions.map(({ kind, revision, branch, repositoryId }) =>
      JSON.stringify([kind, revision, branch, repositoryId]),
    ),
  )
  return keys.size > 1
    ? { kind: 'mixed', label: '各部署位置版本不同' }
    : versions[0] || { kind: 'unconfigured', label: '待配置' }
}

export function homeServices(db, environmentId) {
  return db.services.map((service, index) => {
    const targets = db.targets.filter(
      (target) => target.environmentId === environmentId && target.serviceId === service.id,
    )
    const activeTasks = db.tasks.filter(
      (task) =>
        !completed.has(task.status) && targets.some((target) => target.id === task.targetId),
    )
    const failedTask = targets
      .map((target) => target.latestTask)
      .filter((task) => task && failed.has(task.status))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0]
    const health = serviceHealth(targets, db.servers)
    const source = db.environmentSources.find(
      (item) => item.environmentId === environmentId && item.serviceId === service.id,
    )
    const repository = db.repositories.find((item) => item.id === source?.sourceProjectId)
    const version = serviceVersion(targets)
    const needsAttention =
      health.attention > 0 ||
      targets.some(
        (target) => failed.has(target.latestTask?.status) || targetVersion(target).kind === 'drift',
      )
    const lastDeployedAt = targets
      .map((target) => target.lastDeployedAt || target.currentRelease?.createdAt)
      .filter(Boolean)
      .sort()
      .at(-1)
    return {
      ...service,
      index,
      targets,
      activeTasks,
      failedTask,
      health,
      repository,
      source,
      version,
      needsAttention,
      lastDeployedAt,
    }
  })
}

export function hostMetrics(server) {
  const metrics = server?.metrics || {},
    memory = metrics.memory || {},
    disk = metrics.disk || {}
  const ratio = (used, total) =>
    Number.isFinite(used) && Number.isFinite(total) && total > 0 ? (used / total) * 100 : null
  return [
    {
      label: 'CPU',
      value: metrics.cpuPercent ?? metrics.cpu?.percent,
      warning: 85,
      critical: 95,
      warningText: '负载偏高',
      criticalText: '负载过高',
    },
    {
      label: '内存',
      value: ratio(memory.used ?? metrics.memoryUsed, memory.total ?? metrics.memoryTotal),
      warning: 80,
      critical: 90,
      warningText: '用量偏高',
      criticalText: '用量过高',
    },
    {
      label: '磁盘',
      value: ratio(disk.used, disk.total),
      warning: 80,
      critical: 90,
      warningText: '空间偏紧',
      criticalText: '空间紧张',
      remaining:
        Number.isFinite(disk.total) && Number.isFinite(disk.used) && disk.total > 0
          ? Math.max(0, disk.total - disk.used)
          : null,
    },
  ].map((metric) => {
    const known = !!(server?.online && !server.revoked && Number.isFinite(metric.value))
    const level = !known
      ? 'unknown'
      : metric.value >= metric.critical
        ? 'critical'
        : metric.value >= metric.warning
          ? 'warning'
          : 'normal'
    return {
      ...metric,
      known,
      level,
      message:
        level === 'critical' ? metric.criticalText : level === 'warning' ? metric.warningText : '',
    }
  })
}
