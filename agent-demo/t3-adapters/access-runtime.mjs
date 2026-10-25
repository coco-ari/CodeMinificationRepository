import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { users, projects, agents } from '../fixtures.mjs'
import { AutoOpsAccessError, createAccessService, initializeAutoOpsAccessSchema } from './access-service.mjs'
import { configuredWorkspaceStore } from './workspaces.mjs'
import { resolveProductProfile } from './product-profile.mjs'
import { configuredBusinessModels } from './models.mjs'
import { isCustomerAgentsEnabled } from './customer-registry.mjs'

const fail = (status, code, message) => { throw new AutoOpsAccessError(status, code, message) }
const configuration = () => {
  const model = process.env.AUTOOPS_T3_MODEL || process.env.AGENT_DEMO_MODEL || ''
  return { profile: resolveProductProfile(), model, modelSelectionEnabled: Boolean(model) && configuredBusinessModels().discovered, customerAgentsEnabled: isCustomerAgentsEnabled() }
}
export function createAutoOpsAccess({ catalog = { users, projects, agents }, deploymentEnabled = () => process.env.AUTOOPS_DEPLOYMENT_ENABLED === '1', ...options }) {
  return createAccessService({ ...options, catalog, deploymentEnabled, configuration })
}

let configuredAccess, ownedDatabases, stopping = false, closed = false
export function autoOpsAccessEnabled() { return process.env.AUTOOPS_T3_DATA_DIR !== undefined }
export const isAutoOpsEnabled = autoOpsAccessEnabled
export function configuredAutoOpsProjects() { return autoOpsAccessEnabled() ? projects : [] }
export function stopConfiguredAutoOpsAccess() { stopping = true; configuredAccess?.stopAccepting() }
export function closeConfiguredAutoOpsAccess() {
  stopConfiguredAutoOpsAccess()
  closed = true
  const databases = ownedDatabases; ownedDatabases = undefined
  if (databases) { try { databases.bindingDb.close() } finally { databases.sessionDb.close() } }
}
export function configuredAutoOpsAccess() {
  if (closed || (stopping && !configuredAccess)) fail(503, 'AUTOOPS_STOPPING', '业务服务正在停止，请稍后重试')
  if (!autoOpsAccessEnabled()) return undefined
  if (configuredAccess) return configuredAccess
  if (!process.env.AUTOOPS_T3_DATA_DIR?.trim()) fail(500, 'INVALID_DATA_DIR', 'AutoOps 数据目录不能为空')
  const directory = resolve(process.env.AUTOOPS_T3_DATA_DIR)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let sessionDb, bindingDb
  try {
    sessionDb = new DatabaseSync(join(directory, 'demo.sqlite'), { readOnly: true })
    bindingDb = new DatabaseSync(join(directory, 't3-autoops.sqlite'))
    bindingDb.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    initializeAutoOpsAccessSchema(bindingDb)
    const workspaceStore = configuredWorkspaceStore({ authorizeTask({ actorId, projectId, type }) {
      if (!configuredAccess) fail(503, 'WORKSPACE_AUTHORIZATION_REQUIRED', '工作区授权尚未就绪')
      if (type === 'input') return configuredAccess.requireWorkspaceReader(actorId, projectId)
      if (type === 'packages') return configuredAccess.requireProjectActionForActor(actorId, projectId, 'source.generate')
      if (type === 'external') return configuredAccess.requireProjectActionForActor(actorId, projectId, 'workspace.external.publish')
      if (type === 'cleanup') return configuredAccess.requireProjectActionForActor(actorId, projectId, 'workspace.cleanup')
      return configuredAccess.requireWorkspaceActor(actorId, projectId)
    } })
    configuredAccess = createAutoOpsAccess({ sessionDb, bindingDb, workspaceStore })
    ownedDatabases = { sessionDb, bindingDb }
    return configuredAccess
  } catch (error) {
    try { bindingDb?.close() } finally { sessionDb?.close() }
    throw error
  }
}
