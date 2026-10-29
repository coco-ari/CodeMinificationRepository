export type DeploymentNavigation = {
  environmentId?: string | undefined
  serviceId?: string | undefined
  targetId?: string | undefined
  taskId?: string | undefined
  tab?: 'publish' | 'history' | 'config' | undefined
  setupStep?: 1 | 2 | 3 | undefined
  nodeEnvironmentId?: string | undefined
}

/** 路由只恢复标识与视图，引用、配置正文和秘密不进入地址。 */
export function deploymentNavigation(search: Record<string, unknown>): DeploymentNavigation {
  const result: DeploymentNavigation = {}
  for (const key of [
    'environmentId',
    'serviceId',
    'targetId',
    'taskId',
    'nodeEnvironmentId',
  ] as const) {
    if (search[key] !== undefined) {
      if (
        typeof search[key] !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(search[key])
      )
        throw new Error('部署定位参数无效。')
      result[key] = search[key]
    }
  }
  if (search.tab !== undefined) {
    if (!['publish', 'history', 'config'].includes(String(search.tab)))
      throw new Error('部署页签无效。')
    result.tab = search.tab as DeploymentNavigation['tab']
  }
  if (search.setupStep !== undefined) {
    if (![1, 2, 3].includes(Number(search.setupStep))) throw new Error('配置步骤无效。')
    result.setupStep = Number(search.setupStep) as 1 | 2 | 3
  }
  return result
}
export function deploymentHref(projectId: string, state: DeploymentNavigation) {
  const query = new URLSearchParams({ projectId })
  for (const [key, value] of Object.entries(state))
    if (value !== undefined && value !== '')
      query.set(key === 'environmentId' ? 'deploymentEnvironmentId' : key, String(value))
  return `/deployments?${query}`
}
