import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { users, projects, agents } from '../fixtures.mjs'
import { AutoOpsAccessError, createAccessService, initializeAutoOpsAccessSchema } from './access-service.mjs'
import { configuredWorkspaceStore } from './workspaces.mjs'
import { resolveProductProfile } from './product-profile.mjs'
import { configuredBusinessModels } from './models.mjs'
import { isCustomerAgentsEnabled } from './customer-registry.mjs'
import { createProjectDirectory } from './project-directory/index.ts'
import { createAssistantDirectory, questionConfigurationPolicy } from './assistants/index.ts'
import { resolveSkillLibrary } from './skill-library.mjs'
import { isProjectRole } from '../../autoops/contracts/project-access.ts'

const fail = (status, code, message) => { throw new AutoOpsAccessError(status, code, message) }
const configuration = () => {
  const model = process.env.AUTOOPS_T3_MODEL || process.env.AGENT_DEMO_MODEL || ''
  return { profile: resolveProductProfile(), model, modelSelectionEnabled: Boolean(model) && configuredBusinessModels().discovered, customerAgentsEnabled: isCustomerAgentsEnabled() }
}
export function createAutoOpsAccess({ catalog = { users, projects, agents }, deploymentEnabled = () => process.env.AUTOOPS_DEPLOYMENT_ENABLED === '1', ...options }) {
  return createAccessService({ ...options, catalog, deploymentEnabled, configuration })
}

let configuredAccess, configuredDirectory, configuredAssistants, ownedDatabases, stopping = false, closed = false
export function autoOpsAccessEnabled() { return process.env.AUTOOPS_T3_DATA_DIR !== undefined }
export const isAutoOpsEnabled = autoOpsAccessEnabled
export function configuredAutoOpsProjects() { return autoOpsAccessEnabled() ? configuredAutoOpsProjectDirectory().catalog.projects : [] }
export function configuredAutoOpsProjectDirectory() {
  if (closed || stopping) fail(503, 'AUTOOPS_STOPPING', '项目目录正在停止')
  if (!process.env.AUTOOPS_T3_DATA_DIR?.trim()) fail(500, 'INVALID_DATA_DIR', 'AutoOps 数据目录不能为空')
  return configuredDirectory ||= createProjectDirectory({ dataDir: resolve(process.env.AUTOOPS_T3_DATA_DIR), seed: { users, projects, agents }, validateMember: (project, actor, member) => configuredAutoOpsAssistantDirectory().validateMember(project, actor, member), authorize(actor, project, action) {
    if (!configuredAccess) fail(503, 'PROJECT_AUTHORIZATION_REQUIRED', '项目授权尚未就绪')
    return configuredAccess.requireProjectActionForActor(actor, project, action)
  } })
}
export function configuredAutoOpsAssistantDirectory() {
  if (closed || stopping) fail(503, 'AUTOOPS_STOPPING', '助手目录正在停止')
  const access = configuredAutoOpsAccess()
  if (!access) fail(503, 'AUTOOPS_NOT_CONFIGURED', '助手业务授权尚未就绪')
  const directory = configuredAutoOpsProjectDirectory()
  return configuredAssistants ||= createAssistantDirectory({
    dataDir: resolve(process.env.AUTOOPS_T3_DATA_DIR),
    membership: (actor, project) => access.requireProjectActionForActor(actor, project, 'chat.use'),
    manage: (actor, project) => access.requireProjectActionForActor(actor, project, 'project.manage'),
    validate: questionConfigurationPolicy({
      projects: () => directory.catalog.projects, agents: () => directory.catalog.agents,
      models: configuredBusinessModels,
      skills: (projectId, agentId, workspaceType) => resolveSkillLibrary(process.env.AUTOOPS_T3_DATA_DIR, { projectId, agentId, workspaceType }),
      customers: () => access.customerRegistry,
    }),
    validateTarget(project, target) {
      if (!directory.catalog.projects.some(item => item.id === project) || (target.kind === 'role' ? !isProjectRole(target.id) : !directory.catalog.users.some(user => user.id === target.id && (user.status === undefined || user.status === 'active')))) fail(400, 'ASSISTANT_TARGET_INVALID', '分配对象不属于当前可用账号或固定角色')
    },
  })
}
export function stopConfiguredAutoOpsAccess() { stopping = true; configuredAccess?.stopAccepting() }
export function closeConfiguredAutoOpsAccess() {
  stopConfiguredAutoOpsAccess()
  closed = true
  const databases = ownedDatabases; ownedDatabases = undefined
  try { if (databases) { try { databases.bindingDb.close() } finally { databases.sessionDb.close() } } } finally { try { configuredAssistants?.close() } finally { configuredDirectory?.close() } }
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
    configuredAccess = createAutoOpsAccess({ sessionDb, bindingDb, workspaceStore, catalog: configuredAutoOpsProjectDirectory().catalog })
    ownedDatabases = { sessionDb, bindingDb }
    return configuredAccess
  } catch (error) {
    try { bindingDb?.close() } finally { sessionDb?.close() }
    throw error
  }
}
