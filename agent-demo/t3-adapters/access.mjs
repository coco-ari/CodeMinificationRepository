// 对外只暴露业务授权合同；身份、投影和宿主资源在内部按职责装配。
export { AutoOpsAccessError, initializeAutoOpsAccessSchema } from './access-service.mjs'
export { createAutoOpsAccess, autoOpsAccessEnabled, isAutoOpsEnabled, configuredAutoOpsProjects, configuredAutoOpsAccess, stopConfiguredAutoOpsAccess, closeConfiguredAutoOpsAccess } from './access-runtime.mjs'
import { AutoOpsAccessError } from './access-service.mjs'
import { configuredAutoOpsAccess } from './access-runtime.mjs'

export function getThreadBinding(threadId) { return configuredAutoOpsAccess()?.getThreadBinding(threadId) }
export function requireToolThread(threadId) {
  const access = configuredAutoOpsAccess()
  if (!access) throw new AutoOpsAccessError(503, 'AUTOOPS_NOT_CONFIGURED', 'AutoOps 业务授权尚未配置')
  return access.requireToolThread(threadId)
}
