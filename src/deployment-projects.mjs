import { randomUUID } from 'node:crypto'
import { HttpError, digest, requireText } from './security.mjs'
import { decodeContract } from '../autoops/contracts/index.ts'
import { DeploymentRepositorySelection } from '../autoops/contracts/project-repositories.ts'

const fail = (status, code, message) => { throw Object.assign(new HttpError(status, message), { code }) }
const copy = (value) => structuredClone(value)
const now = () => new Date().toISOString()
const requestId = (value) => { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) fail(400, 'DEPLOYMENT_ID_INVALID', '请求标识无效'); return value }
const sourceRequestFields = input => ({ serviceId: input.serviceId, environmentId: input.environmentId, sources: input.sources, contexts: input.contexts, configKey: input.configKey || null })

export function normalizeDeploymentSourceSelection(input, selected, validateConfig) {
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 32) fail(400, 'DEPLOYMENT_SOURCE_INVALID', '请选择 1 至 32 个源码来源')
  const sources = input.sources.map(entry => {
    let value
    try { value = decodeContract(DeploymentRepositorySelection, entry) } catch { return fail(400, 'DEPLOYMENT_SOURCE_INVALID', '请重新确认部署仓库的版本、挂载与子目录，不接受连接或凭证字段') }
    const { sourceId, refKind, ref } = value
    if (!['default', 'branch', 'tag', 'commit'].includes(refKind) || typeof ref !== 'string' || ref.length > 512 || /[\x00-\x20]/.test(ref) || (refKind !== 'default' && !ref) || (refKind === 'commit' && !/^[a-f0-9]{40}$/.test(ref))) fail(400, 'DEPLOYMENT_SOURCE_INVALID', '源码版本选择无效')
    if (refKind === 'default' && ref !== '') fail(400, 'DEPLOYMENT_SOURCE_INVALID', '默认分支不能指定其他引用')
    const mountPath = validateConfig({}, value.mountPath, selected.kind).module || '.'
    const sourcePath = value.sourcePath === undefined ? undefined : validateConfig({}, value.sourcePath, selected.kind).module || '.'
    if (mountPath === '.' || sourcePath === '.') fail(400, 'DEPLOYMENT_SOURCE_INVALID', '请使用仓库相对目录作为部署挂载；完整仓库不填写子目录')
    return { sourceId, refKind, ref, mountPath, ...(sourcePath === undefined ? {} : { sourcePath }) }
  })
  if (new Set(sources.map(entry => entry.sourceId)).size !== sources.length) fail(400, 'DEPLOYMENT_SOURCE_INVALID', '源码来源不能重复')
  const role = selected.kind === 'static' ? 'frontend' : 'backend'
  if (!Array.isArray(input.contexts) || input.contexts.length !== 1 || input.contexts[0]?.service !== role) fail(400, 'DEPLOYMENT_SOURCE_INVALID', '构建上下文必须与当前服务类型一致')
  const context = input.contexts[0]
  if (typeof context.root !== 'string' || !context.root || typeof context.workingDirectory !== 'string' || !context.workingDirectory) fail(400, 'DEPLOYMENT_SOURCE_INVALID', '构建上下文目录不能为空')
  const root = validateConfig({}, context.root, selected.kind).module || '.'
  const workingDirectory = validateConfig({}, context.workingDirectory, selected.kind).module || '.'
  if (workingDirectory !== (selected.module || '.')) fail(400, 'DEPLOYMENT_SOURCE_INVALID', '构建目录必须与服务模块一致')
  return { sources, contexts: [{ service: role, root, workingDirectory }] }
}

// 项目映射与部署实体同属部署存储，在一个事务内建立归属和幂等记录。
// 业务适配器只调用这些用例，不再持有引擎集合或向存储写入任意回调。
export function createProjectDeployments({ store, validateConfig, saveEntity, configKey, insertServer, publicServer, revokeServer, deleteServer, saveStoragePolicy, authorizeMutation, changed }) {
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
  function service(projectId, id, state = store.state) {
    const map = mapping(projectId, state), selected = state.deployments.services.find(entry => entry.id === id && entry.applicationId === map.applicationId)
    if (!selected) fail(404, 'DEPLOYMENT_SERVICE_NOT_FOUND', '当前项目中不存在此服务')
    return { ...copy(selected), configKey: digest(JSON.stringify([selected.id, selected.name, selected.kind, selected.module])) }
  }
  function server(projectId, id, state = store.state) {
    const map = mapping(projectId, state), selected = state.deployments.servers.find(entry => entry.id === id && map.servers.some(bound => bound.serverId === id))
    if (!selected) fail(404, 'DEPLOYMENT_SERVER_NOT_FOUND', '当前项目中不存在此服务器')
    return publicServer(selected)
  }
  function expected(key, current, message) {
    if (key !== current) fail(409, 'DEPLOYMENT_CONFIG_CHANGED', message)
  }
  function authorize(projectId, action, input, environmentId) {
    if (!authorizeMutation) return
    const result = authorizeMutation({ projectId, action, actor: copy(input.actor), ...(environmentId === undefined ? {} : { environmentId }) })
    if (result?.then) { Promise.resolve(result).catch(() => {}); fail(503, 'DEPLOYMENT_AUTHORIZATION_UNAVAILABLE', '部署写入授权必须同步裁决') }
  }
  function submissionKey(operation, input, fields) {
    const actorId = input.actor === undefined ? null : requireText(input.actor.id, '操作人', 128)
    // 请求摘要只取原输入；对象键顺序和后续服务配置变化不影响已接受收据。
    return digest(JSON.stringify([operation, actorId, fields], (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value))
  }
  function replayReceipt(map, operation, input, fields) {
    const old = map.mutationRequests.find(entry => entry.requestId === requestId(input.requestId))
    if (!old?.submissionFingerprint) return undefined
    if (old.submissionFingerprint !== submissionKey(operation, input, fields)) fail(409, 'DEPLOYMENT_REQUEST_CONFLICT', '同一请求标识不能用于不同操作、参数或操作人')
    return copy(old.result)
  }
  function receipt(map, operation, input, fields, work, submissionFields) {
    const key = requestId(input.requestId), actorId = input.actor === undefined ? null : requireText(input.actor.id, '操作人', 128)
    const fingerprint = digest(JSON.stringify([operation, actorId, fields]))
    const old = map.mutationRequests.find(entry => entry.requestId === key)
    if (old) {
      if (old.fingerprint !== fingerprint) fail(409, 'DEPLOYMENT_REQUEST_CONFLICT', '同一请求标识不能用于不同操作、参数或操作人')
      return copy(old.result)
    }
    const result = work()
    map.mutationRequests.push({ requestId: key, fingerprint, result: copy(result), ...(submissionFields === undefined ? {} : { submissionFingerprint: submissionKey(operation, input, submissionFields) }) })
    return result
  }
  function sourceKey(value) { return digest(JSON.stringify([value.serviceId, value.environmentId, value.sources, value.contexts])) }
  function serviceSource(projectId, serviceId, environmentId, state = store.state) {
    const map = mapping(projectId, state)
    service(projectId, serviceId, state); environment(map, environmentId)
    const value = map.serviceSources.find(entry => entry.serviceId === serviceId && entry.environmentId === environmentId)
    return value ? { ...copy(value), configKey: sourceKey(value) } : null
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
        const bindings = state.autoopsDeploymentBindings
        if (bindings.version !== 1 || !Array.isArray(bindings.projects)) throw new Error('部署项目映射版本无效')
        if (bindings.configurationVersion !== undefined && bindings.configurationVersion !== 1) throw new Error('部署项目配置扩展版本无效')
        for (const map of bindings.projects) {
          // 升级只扩展元数据，既有服务、位置、历史和请求身份保持不变。
          map.mutationRequests ||= []; map.serviceSources ||= []
          if (!Array.isArray(map.mutationRequests) || !Array.isArray(map.serviceSources)) throw new Error('部署项目配置损坏')
        }
        // 保留原身份映射格式供程序回滚；新增可选配置使用独立版本，不降级未知格式。
        bindings.configurationVersion = 1
      })
    },
    async ensureProject(project) {
      await store.change((state) => {
        const data = state.deployments
        let map = maps(state).find((entry) => entry.projectId === project.id)
        if (!map) {
          const applicationId = randomUUID()
          data.applications.push({ id: applicationId, name: project.name, description: '工作台部署验证', createdAt: now() })
          map = { projectId: project.id, applicationId, environments: [], servers: [], targetRequests: [], serverRequests: [], mutationRequests: [], serviceSources: [] }
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
    target, service, server, serviceSource,
    serviceSourceRequest(projectId, input) {
      authorize(projectId, 'configure', input, input.environmentId)
      return replayReceipt(mapping(projectId), 'service-source', input, sourceRequestFields(input))
    },
    availableServers() { return store.state.deployments.servers.map(publicServer) },
    task(projectId, taskId) {
      const map = mapping(projectId), task = store.state.deployments.tasks.find((entry) => entry.id === taskId && entry.applicationId === map.applicationId)
      if (!task) fail(404, 'DEPLOYMENT_TASK_NOT_FOUND', '当前项目中不存在此部署任务')
      target(projectId, task.targetId)
      return copy(task)
    },
    taskForRequest(projectId, id) {
      requestId(id)
      const map = mapping(projectId), task = store.state.deployments.tasks.find(entry => entry.requestId === id && entry.applicationId === map.applicationId)
      return task ? copy(task) : null
    },
    snapshot(projectId) {
      const map = mapping(projectId), data = store.state.deployments
      return {
        mapping: copy(map), services: data.services.filter(entry => entry.applicationId === map.applicationId).map(entry => service(projectId, entry.id)),
        serviceSources: map.serviceSources.map(entry => ({ ...copy(entry), configKey: sourceKey(entry) })), servers: data.servers.filter((entry) => map.servers.some((bound) => bound.serverId === entry.id)).map(publicServer),
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
        authorize(projectId, 'server.create', input, input.environmentId)
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
    async saveService(projectId, input) {
      const fields = { name: input.name, kind: input.kind, module: input.module || '.', id: input.id || null, configKey: input.configKey || null }
      const result = await store.change(state => {
        const map = mapping(projectId, state)
        authorize(projectId, 'service.configure', input)
        return receipt(map, 'save-service', input, fields, () => {
          if (input.id) expected(input.configKey, service(projectId, input.id, state).configKey, '服务配置已变化，请刷新后再保存')
          const saved = saveEntity(state, 'services', { ...fields, applicationId: map.applicationId }, input.id)
          return service(projectId, saved.id, state)
        })
      })
      changed('services', result.id); return result
    },
    async saveServiceSource(projectId, input) {
      const result = await store.change(state => {
        const map = mapping(projectId, state), submitted = sourceRequestFields(input)
        authorize(projectId, 'configure', input, input.environmentId)
        const repeated = replayReceipt(map, 'service-source', input, submitted)
        if (repeated !== undefined) return repeated
        const selected = service(projectId, input.serviceId, state)
        environment(map, input.environmentId)
        const value = { serviceId: selected.id, environmentId: input.environmentId, ...normalizeDeploymentSourceSelection(input, selected, validateConfig) }
        return receipt(map, 'service-source', input, [value, input.configKey || null], () => {
          const current = serviceSource(projectId, selected.id, input.environmentId, state)
          if (current) expected(input.configKey, current.configKey, '服务来源已变化，请刷新后再保存')
          else if (input.configKey) fail(409, 'DEPLOYMENT_CONFIG_CHANGED', '服务来源已变化，请刷新后再保存')
          const old = map.serviceSources.find(entry => entry.serviceId === selected.id && entry.environmentId === input.environmentId)
          if (old) Object.assign(old, value, { updatedAt: now() }); else map.serviceSources.push({ ...value, updatedAt: now() })
          return serviceSource(projectId, selected.id, input.environmentId, state)
        }, submitted)
      })
      changed('service-source', input.serviceId); return result
    },
    async createTarget(projectId, input) {
      const result = await store.change(state => {
        const map = mapping(projectId, state), env = environment(map, input.environmentId), data = state.deployments
        authorize(projectId, 'configure', input, input.environmentId)
        if (!input.serviceId) authorize(projectId, 'service.configure', input)
        const submitted = { serviceId: input.serviceId || null, name: input.name, environmentId: input.environmentId, serverId: input.serverId, config: input.config || {}, networkIdentity: input.networkIdentity }
        const repeated = replayReceipt(map, 'create-target', input, submitted)
        if (repeated !== undefined) return repeated
        const existingService = input.serviceId ? service(projectId, input.serviceId, state) : null
        const module = existingService?.module || input.config?.module || '.'
        const config = validateConfig(input.config || {}, module, existingService?.kind || 'static')
        const name = existingService ? null : requireText(input.name, '服务名称', 80)
        // 保留已接受的旧静态创建收据，升级后原请求仍返回同一个位置。
        const previous = map.targetRequests.find(entry => entry.requestId === input.requestId)
        if (previous) {
          if (input.serviceId || previous.fingerprint !== digest(JSON.stringify([name, input.environmentId, input.serverId, config]))) fail(409, 'DEPLOYMENT_REQUEST_CONFLICT', '同一请求标识不能用于不同部署服务参数')
          return previous.targetId
        }
        return receipt(map, 'create-target', input, [input.serviceId || null, name, input.environmentId, input.serverId, config, input.networkIdentity || null], () => {
          if (!map.servers.some(entry => entry.serverId === input.serverId && entry.environmentId === input.environmentId)) fail(404, 'DEPLOYMENT_SERVER_NOT_FOUND', '当前项目与环境中不存在此服务器')
          const selected = existingService || saveEntity(state, 'services', { applicationId: map.applicationId, name, kind: 'static', module })
          return saveEntity(state, 'targets', { environmentId: env.legacyEnvironmentId, serviceId: selected.id, serverId: input.serverId, config, networkIdentity: input.networkIdentity }).id
        }, submitted)
      })
      changed('targets', result); return result
    },
    async updateTarget(projectId, targetId, input) {
      if (['serverId', 'environmentId', 'serviceId', 'applicationId', 'owner', 'mode'].some(key => input[key] !== undefined)) fail(400, 'DEPLOYMENT_TARGET_SCOPE_IMMUTABLE', '不能修改部署位置归属，请新建部署位置')
      const result = await store.change(state => {
        const map = mapping(projectId, state), data = state.deployments
        const selected = data.targets.find(entry => entry.id === targetId && entry.applicationId === map.applicationId && !entry.retiredAt)
        if (!selected) fail(404, 'DEPLOYMENT_TARGET_NOT_FOUND', '当前项目中不存在此部署位置')
        const env = map.environments.find(entry => entry.legacyEnvironmentId === selected.environmentId)
        if (!env) fail(404, 'DEPLOYMENT_ENVIRONMENT_NOT_FOUND', '部署环境不存在')
        authorize(projectId, 'configure', input, env.environmentId)
        const submitted = { targetId, config: input.config || {}, configKey: input.configKey, networkIdentity: input.networkIdentity }
        const repeated = replayReceipt(map, 'update-target', input, submitted)
        if (repeated !== undefined) return repeated
        const selectedService = service(projectId, selected.serviceId, state)
        const config = validateConfig(input.config || {}, selectedService.module, selectedService.kind)
        return receipt(map, 'update-target', input, [targetId, config, input.configKey, input.networkIdentity], () => {
          expected(input.configKey, configKey(data, targetId), '发布配置已变化，请刷新后再保存')
          return saveEntity(state, 'targets', { environmentId: selected.environmentId, serviceId: selected.serviceId, serverId: selected.serverId, config, networkIdentity: input.networkIdentity }, targetId).id
        }, submitted)
      })
      changed('targets', result); return result
    },
    async bindServer(projectId, input) {
      const result = await store.change(state => {
        const map = mapping(projectId, state), data = state.deployments
        authorize(projectId, 'server.bind', input, input.environmentId)
        environment(map, input.environmentId)
        return receipt(map, 'bind-server', input, [input.serverId, input.environmentId], () => {
          const selected = data.servers.find(entry => entry.id === input.serverId && !entry.revoked && entry.mode === 'managed')
          if (!selected) fail(404, 'DEPLOYMENT_SERVER_NOT_FOUND', '服务器不存在或接入已撤销')
          if (!data.serverBindings.some(entry => entry.serverId === selected.id && entry.applicationId === map.applicationId)) data.serverBindings.push({ serverId: selected.id, applicationId: map.applicationId, createdAt: now() })
          if (!map.servers.some(entry => entry.serverId === selected.id && entry.environmentId === input.environmentId)) map.servers.push({ serverId: selected.id, environmentId: input.environmentId })
          return publicServer(selected)
        })
      })
      changed('server', input.serverId); return result
    },
    async unbindServer(projectId, input) {
      const result = await store.change(state => {
        const map = mapping(projectId, state), env = environment(map, input.environmentId), data = state.deployments
        authorize(projectId, 'server.unbind', input, input.environmentId)
        return receipt(map, 'unbind-server', input, [input.serverId, input.environmentId], () => {
          server(projectId, input.serverId, state)
          if (data.targets.some(entry => entry.applicationId === map.applicationId && entry.environmentId === env.legacyEnvironmentId && entry.serverId === input.serverId)) fail(409, 'DEPLOYMENT_SERVER_IN_USE', '该环境仍有部署位置，不能解绑服务器')
          map.servers = map.servers.filter(entry => !(entry.serverId === input.serverId && entry.environmentId === input.environmentId))
          if (!map.servers.some(entry => entry.serverId === input.serverId)) data.serverBindings = data.serverBindings.filter(entry => !(entry.serverId === input.serverId && entry.applicationId === map.applicationId))
          return { ok: true }
        })
      })
      changed('server', input.serverId); return result
    },
    async revokeServer(projectId, id, input) {
      const result = await store.change(state => {
        authorize(projectId, 'server.admin', input)
        return receipt(mapping(projectId, state), 'revoke-server', input, [id], () => {
        server(projectId, id, state)
        return revokeServer(state, id)
      }) })
      changed('server', id); return result
    },
    async deleteServer(projectId, id, input) {
      // 先核对原收据，再查对象；删除成功后的原请求重试仍返回成功。
      const result = await store.change(state => {
        authorize(projectId, 'server.admin', input)
        return receipt(mapping(projectId, state), 'delete-server', input, [id], () => {
        server(projectId, id, state)
        return deleteServer(state, id)
      }) })
      changed('server', id); return result
    },
    async saveStoragePolicy(projectId, id, input) {
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail(400, 'DEPLOYMENT_POLICY_REVISION_REQUIRED', '缺少有效的存储策略版本，请刷新后重试')
      const result = await store.change(state => {
        authorize(projectId, 'server.admin', input)
        return receipt(mapping(projectId, state), 'server-storage-policy', input, [id, input.expectedRevision, input.retainedVersions, input.buildCacheGiB], () => {
        const selected = server(projectId, id, state)
        if (selected.storagePolicy.revision !== input.expectedRevision) fail(409, 'DEPLOYMENT_POLICY_CHANGED', '存储策略已更新，请刷新后重试')
        return saveStoragePolicy(state, id, input)
      }) })
      changed('server', id); return result
    },
  }
}
