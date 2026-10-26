// @effect-diagnostics nodeBuiltinImport:off -- 组合根复用当前身份、凭证所有者及有界只读驱动。
import { resolve } from 'node:path'
import { AutoOpsAccessError, type AutoOpsAccess } from './access.mjs'
import { configuredWorkspaceManagement } from './workspace-management.ts'
import { createEnvironmentMcp, type EnvironmentMcp } from './environment-mcp/index.ts'
import { createMysqlReadonlyDriver, createRedisReadonlyDriver, createServerReadonlyDriver } from './environment-mcp/drivers/index.ts'

let configured: { dataDir: string; service: EnvironmentMcp } | undefined
let stopping = false
export function configuredEnvironmentMcp(access: AutoOpsAccess): EnvironmentMcp {
  if (stopping) throw new AutoOpsAccessError(503, 'ENVIRONMENT_MCP_STOPPING', '环境连接服务正在停止接单')
  const dataDir = process.env.AUTOOPS_T3_DATA_DIR && resolve(process.env.AUTOOPS_T3_DATA_DIR)
  if (!dataDir) throw new AutoOpsAccessError(503, 'ENVIRONMENT_MCP_UNAVAILABLE', '环境连接存储尚未配置')
  if (configured) {
    if (configured.dataDir !== dataDir) throw new AutoOpsAccessError(503, 'ENVIRONMENT_MCP_CONFIGURATION_CHANGED', '数据目录已改变，请重启服务后重试')
    return configured.service
  }
  const service = createEnvironmentMcp({
    dataDir,
    credentials: configuredWorkspaceManagement(access).credentials,
    authorizeManage(actor, project, environment) {
      const member = access.requireProjectActionForActor(actor, project, 'project.manage')
      if (!member.environmentIds.includes(environment)) throw new AutoOpsAccessError(404, 'ENVIRONMENT_NOT_FOUND', '环境不存在或不属于当前项目')
    },
    authorizeQuery(actor, project, environment) {
      if (environment === null) access.requireProjectActionForActor(actor, project, 'chat.use')
      else access.requireEnvironmentQueryForActor(actor, project, environment)
    },
    drivers: {server: createServerReadonlyDriver(), mysql: createMysqlReadonlyDriver(), redis: createRedisReadonlyDriver()},
  })
  configured = {dataDir, service}
  return service
}
export function stopConfiguredEnvironmentMcp() { stopping = true; configured?.service.stopAccepting() }
export async function closeConfiguredEnvironmentMcp() { stopConfiguredEnvironmentMcp(); await configured?.service.close() }
