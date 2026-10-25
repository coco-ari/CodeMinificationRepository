import type { DeploymentTarget } from '../deployments'
import type { WorkspaceRelease } from '../workspaces'

export const errorLabel = (error: unknown) =>
  error instanceof Error ? error.message : '操作未完成，请重试。'
export const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN')
export const normalizeDirectory = (value: string | undefined) =>
  !value || value === '.' ? '.' : value.replace(/\/$/, '')
export function packageDirectory(
  release: WorkspaceRelease,
  service: 'frontend' | 'backend' = 'frontend',
) {
  const manifest = release.manifest as {
    services?: Array<{ service: string; context?: { workingDirectory?: string } }>
  }
  return normalizeDirectory(
    manifest.services?.find((item) => item.service === service)?.context?.workingDirectory,
  )
}

/** 只展示服务端时间范围内的观测，不把旧收据或在线心跳当成健康证明。 */
export function deploymentObservationLabel(
  target: Pick<DeploymentTarget, 'id' | 'observation' | 'observationStale'>,
): string {
  const observation = target.observation
  if (!observation || observation.targetId !== target.id) return '尚无运行观测'
  if (target.observationStale !== false) return '观测已过期，当前状态未知'
  if (observation.exists === null) return '当前运行状态未知'
  if (observation.exists === false)
    return observation.status === 'unpublished' ? '尚未发布' : '未发现运行实例'
  if (observation.managed === false) return '运行实例归属不匹配'
  const status: Record<string, string> = {
    running: '运行中',
    published: '已发布',
    created: '已创建',
    restarting: '重启中',
    paused: '已暂停',
    removing: '移除中',
    exited: '已退出',
    dead: '已停止',
    unknown: '运行状态未知',
  }
  const health: Record<string, string> = {
    healthy: '健康检查通过',
    unhealthy: '健康检查失败',
    starting: '健康检查启动中',
    none: '未配置健康检查',
    unknown: '健康状态未知',
  }
  return `${status[observation.status] ?? '运行状态未知'} · ${health[observation.health] ?? '健康状态未知'}`
}
