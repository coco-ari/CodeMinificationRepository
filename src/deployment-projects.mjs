import { randomUUID } from 'node:crypto'
import { HttpError, digest, requireText } from './security.mjs'

const fail = (status, code, message) => { throw Object.assign(new HttpError(status, message), { code }) }
const copy = (value) => structuredClone(value)
const now = () => new Date().toISOString()
const requestId = (value) => { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) fail(400, 'DEPLOYMENT_ID_INVALID', '请求标识无效'); return value }

// 项目映射与部署实体同属部署存储，在一个事务内建立归属和幂等记录。
// 业务适配器只调用这些用例，不再持有引擎集合或向存储写入任意回调。
export function createProjectDeployments({ store, validateConfig, insertServer, publicServer, changed }) {
  const maps = (state = store.state) => state.autoopsDeploymentBindings.projects
  function mapping(projectId, state = store.state) {
    const map = maps(state).find((entry) => entry.projectId === projectId)
    if (!map) fail(404, 'DEPLOYMENT_PROJECT_NOT_FOUND', '部署项目尚未初始化')
    return map
  }
  function environment(map, environmentId) {
    const env = map.environments.find((entry) => entry.environmentId === environmentId)
    if (!env) fail(404, 'DEPLOYMENT_ENVIRONMENT_NOT_FOUND', '部署环境不存在')
    return env
  }
  function target(projectId, targetId) {
    const map = mapping(projectId), data = store.state.deployments
    const selected = data.targets.find((entry) => entry.id === targetId && entry.applicationId === map.applicationId && !entry.retiredAt)
    const env = selected && map.environments.find((entry) => entry.legacyEnvironmentId === selected.environmentId)
    const server = selected && map.servers.find((entry) => entry.serverId === selected.serverId && entry.environmentId === env?.environmentId)
    if (!selected || !env || !server) fail(404, 'DEPLOYMENT_TARGET_NOT_FOUND', '当前项目与环境中不存在此部署服务')
    return { target: copy(selected), service: copy(data.services.find((entry) => entry.id === selected.serviceId)), environmentId: env.environmentId }
  }
  return {
    async initialize() {
      await store.change((state) => {
        state.autoopsDeploymentBindings ||= { version: 1, projects: [] }
        if (state.autoopsDeploymentBindings.version !== 1 || !Array.isArray(state.autoopsDeploymentBindings.projects)) throw new Error('部署项目映射版本无效')
      })
    },
    async ensureProject(project) {
      await store.change((state) => {
        const data = state.deployments
        let map = maps(state).find((entry) => entry.projectId === project.id)
        if (!map) {
          const applicationId = randomUUID()
          data.applications.push({ id: applicationId, name: project.name, description: '工作台部署验证', createdAt: now() })
          map = { projectId: project.id, applicationId, environments: [], servers: [], targetRequests: [], serverRequests: [] }
          maps(state).push(map)
        }
        const application = data.applications.find((entry) => entry.id === map.applicationId)
        if (!application) throw new Error('部署项目身份映射损坏')
        application.name = project.name
        for (const env of project.environments) {
          let selected = map.environments.find((entry) => entry.environmentId === env.id)
          if (!selected) {
            selected = { environmentId: env.id, legacyEnvironmentId: randomUUID() }
            map.environments.push(selected)
            data.environments.push({ id: selected.legacyEnvironmentId, applicationId: map.applicationId, name: env.name, createdAt: now() })
          }
          const existing = data.environments.find((entry) => entry.id === selected.legacyEnvironmentId && entry.applicationId === map.applicationId)
          if (!existing) throw new Error('部署环境身份映射损坏')
          existing.name = env.name
        }
      })
    },
    target,
    task(projectId, taskId) {
      const map = mapping(projectId), task = store.state.deployments.tasks.find((entry) => entry.id === taskId && entry.applicationId === map.applicationId)
      if (!task) fail(404, 'DEPLOYMENT_TASK_NOT_FOUND', '当前项目中不存在此部署任务')
      target(projectId, task.targetId)
      return copy(task)
    },
    snapshot(projectId) {
      const map = mapping(projectId), data = store.state.deployments
      return {
        mapping: copy(map), servers: data.servers.filter((entry) => map.servers.some((bound) => bound.serverId === entry.id)).map(publicServer),
        targets: copy(data.targets.filter((entry) => entry.applicationId === map.applicationId && !entry.retiredAt && entry.mode === 'managed')),
        tasks: copy(data.tasks.filter((entry) => entry.applicationId === map.applicationId)),
      }
    },
    claimScope(task, selectedTarget) {
      const map = maps().find((entry) => entry.applicationId === task.applicationId)
      const env = map?.environments.find((entry) => entry.legacyEnvironmentId === selectedTarget.environmentId)
      if (!task.actor?.id || !env || selectedTarget.applicationId !== task.applicationId || !map.servers.some((entry) => entry.serverId === task.serverId && entry.environmentId === env.environmentId))
        fail(403, 'DEPLOYMENT_TASK_SCOPE_INVALID', '发布任务的操作人或目标归属已失效')
      return { projectId: map.projectId, environmentId: env.environmentId }
    },
    async createServer(projectId, input) {
      const name = requireText(input.name, '服务器名称', 80), key = input.requestId && requestId(input.requestId)
      const fingerprint = digest(JSON.stringify([name, input.environmentId]))
      const result = await store.change((state) => {
        const map = mapping(projectId, state), data = state.deployments
        environment(map, input.environmentId)
        const repeated = key && map.serverRequests.find((entry) => entry.requestId === key)
        if (repeated) {
          if (repeated.fingerprint !== fingerprint) fail(409, 'DEPLOYMENT_REQUEST_CONFLICT', '同一请求标识不能用于不同服务器参数')
          const server = data.servers.find((entry) => entry.id === repeated.serverId)
          if (!server) fail(409, 'DEPLOYMENT_SERVER_NOT_FOUND', '服务器身份映射已失效')
          return { server: publicServer(server), registrationToken: null, expiresAt: null, repeated: true }
        }
        const created = insertServer(data, { name, applicationId: map.applicationId })
        map.servers.push({ serverId: created.server.id, environmentId: input.environmentId })
        if (key) map.serverRequests.push({ requestId: key, fingerprint, serverId: created.server.id })
        return created
      })
      if (!result.repeated) changed('server', result.server.id)
      return result
    },
    async createTarget(projectId, input) {
      const name = requireText(input.name, '服务名称', 80), key = requestId(input.requestId), module = input.config?.module || '.'
      const config = validateConfig(input.config || {}, module, 'static'), fingerprint = digest(JSON.stringify([name, input.environmentId, input.serverId, config]))
      const id = await store.change((state) => {
        const map = mapping(projectId, state), env = environment(map, input.environmentId), data = state.deployments
        const repeated = map.targetRequests.find((entry) => entry.requestId === key)
        if (repeated) { if (repeated.fingerprint !== fingerprint) fail(409, 'DEPLOYMENT_REQUEST_CONFLICT', '同一请求标识不能用于不同部署服务参数'); return repeated.targetId }
        if (!map.servers.some((entry) => entry.serverId === input.serverId && entry.environmentId === input.environmentId) || !data.serverBindings.some((entry) => entry.serverId === input.serverId && entry.applicationId === map.applicationId)) fail(404, 'DEPLOYMENT_SERVER_NOT_FOUND', '当前项目与环境中不存在此服务器')
        const server = data.servers.find((entry) => entry.id === input.serverId && !entry.revoked && entry.mode === 'managed')
        if (!server) fail(409, 'DEPLOYMENT_SERVER_REVOKED', '目标服务器已撤销或不可用')
        if (data.services.length >= 2000 || data.targets.length >= 2000) fail(400, 'DEPLOYMENT_TARGET_LIMIT', '部署服务数量已达到上限')
        const serviceId = randomUUID(), targetId = randomUUID(), at = now()
        data.services.push({ id: serviceId, applicationId: map.applicationId, name, kind: 'static', module, createdAt: at, updatedAt: at })
        data.targets.push({ id: targetId, applicationId: map.applicationId, environmentId: env.legacyEnvironmentId, serviceId, serverId: server.id, mode: 'managed', containerName: null, config, networkIdentity: null, owner: 'platform', createdAt: at, updatedAt: at })
        map.targetRequests.push({ requestId: key, fingerprint, targetId })
        return targetId
      })
      changed('targets', id)
      return id
    },
  }
}
