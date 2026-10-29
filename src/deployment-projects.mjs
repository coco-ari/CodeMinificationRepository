import { randomUUID } from 'node:crypto'
import { HttpError, digest, requireText } from './security.mjs'
import { decodeContract } from '../autoops/contracts/index.ts'
import { DeploymentRepositorySelection } from '../autoops/contracts/project-repositories.ts'

const fail = (status, code, message) => { throw Object.assign(new HttpError(status, message), { code }) }
const copy = (value) => structuredClone(value)
const now = () => new Date().toISOString()
const requestId = (value) => { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) fail(400, 'DEPLOYMENT_ID_INVALID', '请求标识无效'); return value }
const sourceRequestFields = input => ({ serviceId: input.serviceId, environmentId: input.environmentId, sources: input.sources, contexts: input.contexts, configKey: input.configKey || null })

export function projectDeploymentReferences(state, projectId, environmentId) {
  const bindings = state.autoopsDeploymentBindings
  if (!bindings) return []
  if (bindings.version !== 1 || !Array.isArray(bindings.projects) || (bindings.nodeAccessVersion !== undefined && bindings.nodeAccessVersion !== 1) || (bindings.configurationVersion !== undefined && bindings.configurationVersion !== 1)) fail(503,'PROJECT_DELETE_INSPECTION_UNAVAILABLE','部署项目映射不可读，尚未删除')
  const map = bindings.projects.find(value => value.projectId === projectId)
  if (!map) return []
  const data = state.deployments
  const legacy = environmentId === undefined ? undefined : map.environments.find(value => value.environmentId === environmentId)?.legacyEnvironmentId
  const targets = data.targets.filter(value => value.applicationId === map.applicationId && (environmentId === undefined || value.environmentId === legacy))
  const ids = new Set(targets.map(value => value.id))
  return [
    {kind:'deployment-bindings',count:map.servers.filter(value => environmentId === undefined || value.environmentId === environmentId).length,message:'仍有部署节点绑定'},
    {kind:'deployment-targets',count:targets.length,message:'仍有部署位置'},
    {kind:'deployment-tasks',count:data.tasks.filter(value => value.applicationId === map.applicationId && (environmentId === undefined || ids.has(value.targetId))).length,message:'仍有部署任务或恢复历史'},
    {kind:'deployment-versions',count:data.releases.filter(value => ids.has(value.targetId)).length,message:'仍有部署版本链'},
    {kind:'deployment-sources',count:(map.serviceSources ?? []).filter(value => environmentId === undefined || value.environmentId === environmentId).length,message:'仍有部署默认来源'},
    ...(environmentId === undefined ? [
      {kind:'deployment-services',count:data.services.filter(value => value.applicationId === map.applicationId).length,message:'项目仍有部署服务'},
      {kind:'deployment-node-access',count:(map.allowedServerIds ?? []).length,message:'项目仍有平台节点准入'},
    ] : []),
  ].filter(value => value.count > 0)
}

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
export function createProjectDeployments({
  store,
  validateConfig,
  saveEntity,
  configKey,
  insertServer,
  publicServer,
  revokeServer,
  deleteServer,
  saveStoragePolicy,
  authorizeMutation,
  changed,
  cleanupTasks = async () => {},
}) {
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
    if (selected.deleting) fail(409, 'DEPLOYMENT_DELETE_PENDING', '服务正在删除，请继续原删除')
    return {
      ...copy(selected),
      configKey: digest(
        JSON.stringify([selected.id, selected.name, selected.kind, selected.module]),
      ),
    }
  }
  function server(projectId, id, state = store.state) {
    const map = mapping(projectId, state), selected = state.deployments.servers.find(entry => entry.id === id && map.servers.some(bound => bound.serverId === id))
    if (!selected) fail(404, 'DEPLOYMENT_SERVER_NOT_FOUND', '当前项目中不存在此服务器')
    return { ...publicServer(selected), projectAllowed: map.allowedServerIds.includes(id) }
  }
  function globalServer(id, state = store.state) {
    const selected = state.deployments.servers.find(entry => entry.id === id && entry.mode === 'managed')
    if (!selected) fail(404, 'DEPLOYMENT_SERVER_NOT_FOUND', '全局节点不存在')
    return publicServer(selected)
  }
  const nodeReceipts = state => ({ mutationRequests: state.autoopsDeploymentBindings.nodeMutationRequests })
  function requireServerUse(projectId, serverId, state = store.state) {
    if (!mapping(projectId, state).allowedServerIds.includes(serverId)) fail(403, 'DEPLOYMENT_SERVER_ACCESS_REVOKED', '此项目未获准使用该节点，或准入已撤回')
    const selected = globalServer(serverId, state)
    if (selected.revoked) fail(409, 'DEPLOYMENT_SERVER_REVOKED', '节点接入已撤销')
    if (selected.deleting) fail(409,'DEPLOYMENT_SERVER_DELETING','节点正在删除，请继续原删除')
    return selected
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
  function receipt(map, operation, input, fields, work, submissionFields, nodeProjectId) {
    const key = requestId(input.requestId), actorId = input.actor === undefined ? null : requireText(input.actor.id, '操作人', 128)
    const fingerprint = digest(JSON.stringify([operation, actorId, fields]))
    const old = map.mutationRequests.find(entry => entry.requestId === key)
    if (old) {
      if (old.fingerprint !== fingerprint) fail(409, 'DEPLOYMENT_REQUEST_CONFLICT', '同一请求标识不能用于不同操作、参数或操作人')
      return copy(old.result)
    }
    const result = work()
    const nodeRequest = nodeProjectId === undefined ? undefined : { actorId, operation, projectId: nodeProjectId, fields: copy(fields) }
    map.mutationRequests.push({ requestId: key, fingerprint, result: copy(result), ...(nodeRequest ? { nodeRequest, nodeRequestFingerprint: digest(JSON.stringify([key, fingerprint, nodeRequest])) } : {}), ...(submissionFields === undefined ? {} : { submissionFingerprint: submissionKey(operation, input, submissionFields) }) })
    return result
  }
  function nodeReceipt(map, operation, input, fields, work, projectId = null) {
    return receipt(map, operation, input, fields, work, undefined, projectId)
  }
  function readNodeReceipt(map, id, input, projectId) {
    const saved = map.mutationRequests.find(entry => entry.requestId === requestId(id))
    // 旧收据没有可核对的操作人/范围，不从摘要或当前目录猜测原归属。
    if (!saved?.nodeRequest) return null
    const value = saved.nodeRequest
    if (saved.nodeRequestFingerprint !== digest(JSON.stringify([saved.requestId, saved.fingerprint, value])) ||
      saved.fingerprint !== digest(JSON.stringify([value.operation, value.actorId, value.fields])) ||
      value.projectId !== projectId || !Array.isArray(value.fields))
      fail(503, 'DEPLOYMENT_RECEIPT_INVALID', '节点原收据范围不可核对，操作仍待确认')
    if (typeof input.actor?.id !== 'string' || value.actorId !== input.actor.id) return null
    const globalOperations = { 'create-global-server': 'create', 'global-server-revoke': 'revoke', 'global-server-delete': 'delete', 'global-server-storage': 'storage', 'server-project-access': 'access' }
    const operation = projectId === null ? globalOperations[value.operation] : ({ 'bind-server': 'bind', 'unbind-server': 'unbind' })[value.operation]
    if (!operation) fail(503, 'DEPLOYMENT_RECEIPT_INVALID', '节点原收据操作不可核对，操作仍待确认')
    const environmentId = projectId === null ? null : value.fields[1]
    if (projectId !== null && environmentId !== input.environmentId) return null
    const publicIntent = operation === 'create' ? { name: value.fields[0] }
      : operation === 'access' ? { projectId: value.fields[0], serverId: value.fields[1], allowed: value.fields[2], expectedRevision: value.fields[3] }
      : operation === 'storage' ? { serverId: value.fields[0], expectedRevision: value.fields[1], retainedVersions: value.fields[2], buildCacheGiB: value.fields[3] }
      : operation === 'bind' || operation === 'unbind' ? { serverId: value.fields[0], environmentId }
      : { serverId: value.fields[0] }
    return { state: 'completed', requestId: saved.requestId, operation, projectId, environmentId,
      serverId: operation === 'create' ? saved.result.id : operation === 'access' ? value.fields[1] : value.fields[0],
      ...(operation === 'access' ? { targetProjectId: value.fields[0] } : {}), publicIntent, result: copy(saved.result) }
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
        if (bindings.nodeAccessVersion !== undefined && bindings.nodeAccessVersion !== 1) throw new Error('节点准入版本无效')
        if (bindings.nodeAccessVersion === undefined) {
          if (bindings.nodeMutationRequests !== undefined || bindings.projects.some(map => map.allowedServerIds !== undefined || map.nodeAccessRevision !== undefined)) throw new Error('缺少版本的节点准入数据不能被覆盖')
          for (const map of bindings.projects) { map.allowedServerIds = [...new Set(map.servers.map(entry => entry.serverId))]; map.nodeAccessRevision = 1 }
          bindings.nodeMutationRequests = []
          bindings.nodeAccessVersion = 1
        }
        if (!Array.isArray(bindings.nodeMutationRequests)) throw new Error('节点操作收据损坏')
        for (const map of bindings.projects) {
          // 升级只扩展元数据，既有服务、位置、历史和请求身份保持不变。
          map.mutationRequests ||= []; map.serviceSources ||= []
          if (!Array.isArray(map.mutationRequests) || !Array.isArray(map.serviceSources)) throw new Error('部署项目配置损坏')
          if (!Array.isArray(map.allowedServerIds) || new Set(map.allowedServerIds).size !== map.allowedServerIds.length || map.allowedServerIds.some(id => !state.deployments.servers.some(server => server.id === id))) throw new Error('项目节点准入损坏')
          if (!Number.isSafeInteger(map.nodeAccessRevision) || map.nodeAccessRevision < 1) throw new Error('项目节点准入修订损坏')
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
          map = { projectId: project.id, applicationId, environments: [], servers: [], allowedServerIds: [], nodeAccessRevision: 1, targetRequests: [], serverRequests: [], mutationRequests: [], serviceSources: [] }
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
    scopeTaskIds(projectId, environmentId) {
      const map = maps().find((value) => value.projectId === projectId)
      if (!map) return []
      const env = map.environments.find(
        (value) => value.environmentId === environmentId,
      )?.legacyEnvironmentId
      const targets = new Set(
        store.state.deployments.targets
          .filter(
            (value) =>
              value.applicationId === map.applicationId &&
              (environmentId === undefined || value.environmentId === env),
          )
          .map((value) => value.id),
      )
      return store.state.deployments.tasks
        .filter(
          (value) =>
            value.applicationId === map.applicationId &&
            (environmentId === undefined || targets.has(value.targetId)),
        )
        .map((value) => value.id)
    },
    async purgeScope(projectId, environmentId) {
      await store.change((state) => {
        const map = maps(state).find((value) => value.projectId === projectId)
        if (!map) return
        const data = state.deployments
        const env = map.environments.find(
          (value) => value.environmentId === environmentId,
        )?.legacyEnvironmentId
        const targets = new Set(
          data.targets
            .filter(
              (value) =>
                value.applicationId === map.applicationId &&
                (environmentId === undefined || value.environmentId === env),
            )
            .map((value) => value.id),
        )
        data.tasks = data.tasks.filter(
          (value) =>
            !(
              value.applicationId === map.applicationId &&
              (environmentId === undefined || targets.has(value.targetId))
            ),
        )
        data.releases = data.releases.filter((value) => !targets.has(value.targetId))
        data.targets = data.targets.filter((value) => !targets.has(value.id))
        data.environments = data.environments.filter(
          (value) =>
            !(
              value.applicationId === map.applicationId &&
              (environmentId === undefined || value.id === env)
            ),
        )
        state.events = state.events.filter((value) =>
          environmentId === undefined
            ? value.projectId !== projectId && value.applicationId !== map.applicationId
            : !targets.has(value.targetId),
        )
        if (environmentId === undefined) {
          data.services = data.services.filter((value) => value.applicationId !== map.applicationId)
          data.applications = data.applications.filter((value) => value.id !== map.applicationId)
          state.autoopsDeploymentBindings.projects = maps(state).filter((value) => value !== map)
        } else {
          map.environments = map.environments.filter(
            (value) => value.environmentId !== environmentId,
          )
          map.servers = map.servers.filter((value) => value.environmentId !== environmentId)
          map.serviceSources = (map.serviceSources ?? []).filter(
            (value) => value.environmentId !== environmentId,
          )
          for (const key of ['targetRequests', 'serverRequests', 'mutationRequests'])
            map[key] = (map[key] ?? []).filter(
              (value) =>
                value.environmentId !== environmentId &&
                !targets.has(value.targetId) &&
                value.result?.environmentId !== environmentId &&
                !targets.has(value.result?.id),
            )
        }
      })
    },
    target, service, server, serviceSource,
    deletionReferences(projectId, environmentId) { return projectDeploymentReferences(store.state,projectId,environmentId) },
    serviceSourceRequest(projectId, input) {
      authorize(projectId, 'configure', input, input.environmentId)
      return replayReceipt(mapping(projectId), 'service-source', input, sourceRequestFields(input))
    },
    availableServers(projectId) { return store.state.deployments.servers.filter(server => mapping(projectId).allowedServerIds.includes(server.id) && !server.revoked).map(publicServer) },
    requireServerUse,
    globalNodeCatalog(input) {
      authorize(null, 'server.admin', input)
      return {
        servers: store.state.deployments.servers.map(publicServer),
        projectAccess: maps().map(map => ({ projectId: map.projectId, serverIds: [...map.allowedServerIds], revision: map.nodeAccessRevision })),
        bindings: maps().flatMap(map => map.servers.map(bound => ({ projectId: map.projectId, environmentId: bound.environmentId, serverId: bound.serverId }))),
      }
    },
    globalNodeRequest(id, input) {
      authorize(null, 'server.admin', input)
      return readNodeReceipt(nodeReceipts(store.state), id, input, null)
    },
    projectNodeRequest(projectId, id, input) {
      authorize(projectId, 'server.bind', input, input.environmentId)
      const map = mapping(projectId)
      environment(map, input.environmentId)
      return readNodeReceipt(map, id, input, projectId)
    },
    async createGlobalServer(input) {
      const name = requireText(input.name, '节点名称', 80)
      const result = await store.change(state => {
        authorize(null, 'server.create', input)
        let created
        const saved = nodeReceipt(nodeReceipts(state), 'create-global-server', input, [name], () => {
          created = insertServer(state.deployments, { name })
          return publicServer(created.server)
        })
        // 一次性接入口令只返回首次结果，不能进入持久收据。
        return created ?? { server: saved, registrationToken: null, expiresAt: null, repeated: true }
      })
      changed('server', result.server.id); return result
    },
    async mutateGlobalServer(serverId, operation, input) {
      if (!['revoke', 'delete', 'storage'].includes(operation))
        fail(400, 'DEPLOYMENT_SERVER_OPERATION_INVALID', '全局节点操作无效')
      if (
        operation === 'storage' &&
        (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      )
        fail(400, 'DEPLOYMENT_POLICY_REVISION_REQUIRED', '缺少有效的存储策略版本')
      if (operation === 'delete') {
        authorize(null, 'server.admin', input)
        const server = store.state.deployments.servers.find((row) => row.id === serverId)
        if (server) {
          await store.change((state) => {
            globalServer(serverId, state).deleting = true
          })
          await cleanupTasks(
            store.state.deployments.tasks
              .filter((row) => row.serverId === serverId)
              .map((row) => row.id),
          )
        }
      }
      const result = await store.change(state => {
        authorize(null, 'server.admin', input)
        const fields = operation === 'storage' ? [serverId, input.expectedRevision, input.retainedVersions, input.buildCacheGiB] : [serverId]
        return nodeReceipt(nodeReceipts(state), `global-server-${operation}`, input, fields, () => {
          const selected = globalServer(serverId, state)
          if (operation === 'revoke') return revokeServer(state, serverId)
          if (operation === 'delete') {
            return deleteServer(state, serverId)
          }
          if (selected.storagePolicy.revision !== input.expectedRevision) fail(409, 'DEPLOYMENT_POLICY_CHANGED', '存储策略已变化，请刷新后重试')
          return saveStoragePolicy(state, serverId, input)
        })
      })
      changed('server', serverId)
      return result
    },
    async setServerAccess(projectId, input) {
      if (typeof input.allowed !== 'boolean') fail(400, 'DEPLOYMENT_SERVER_ACCESS_INVALID', '请选择准许或撤回节点准入')
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail(400, 'DEPLOYMENT_SERVER_ACCESS_INVALID', '缺少有效的项目节点准入修订')
      const result = await store.change(state => {
        authorize(null, 'server.admin', input)
        return nodeReceipt(nodeReceipts(state), 'server-project-access', input, [projectId, input.serverId, input.allowed, input.expectedRevision], () => {
          const map = mapping(projectId, state), selected = globalServer(input.serverId, state)
          if (map.nodeAccessRevision !== input.expectedRevision) fail(409, 'DEPLOYMENT_SERVER_ACCESS_CHANGED', '项目节点准入已变化，请刷新后重新确认')
          if (input.allowed && selected.revoked) fail(409, 'DEPLOYMENT_SERVER_REVOKED', '节点接入已撤销')
          map.allowedServerIds = input.allowed ? [...new Set([...map.allowedServerIds, input.serverId])] : map.allowedServerIds.filter(id => id !== input.serverId)
          map.nodeAccessRevision++
          return { projectId, serverId: input.serverId, allowed: input.allowed, revision: map.nodeAccessRevision }
        })
      })
      changed('server-access', input.serverId); return result
    },
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
        serviceSources: map.serviceSources.map(entry => ({ ...copy(entry), configKey: sourceKey(entry) })), servers: data.servers.filter((entry) => map.servers.some((bound) => bound.serverId === entry.id)).map(server => ({ ...publicServer(server), projectAllowed: map.allowedServerIds.includes(server.id) })),
        targets: copy(data.targets.filter((entry) => entry.applicationId === map.applicationId && !entry.retiredAt && entry.mode === 'managed')),
        tasks: copy(data.tasks.filter((entry) => entry.applicationId === map.applicationId)),
      }
    },
    claimScope(task, selectedTarget) {
      const map = maps().find((entry) => entry.applicationId === task.applicationId)
      const env = map?.environments.find((entry) => entry.legacyEnvironmentId === selectedTarget.environmentId)
      if (!task.actor?.id || !env || selectedTarget.applicationId !== task.applicationId || !map.servers.some((entry) => entry.serverId === task.serverId && entry.environmentId === env.environmentId))
        fail(403, 'DEPLOYMENT_TASK_SCOPE_INVALID', '发布任务的操作人或目标归属已失效')
      requireServerUse(map.projectId, task.serverId)
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
        map.allowedServerIds.push(created.server.id)
        map.nodeAccessRevision++
        map.servers.push({ serverId: created.server.id, environmentId: input.environmentId })
        if (key) map.serverRequests.push({ requestId: key, fingerprint, serverId: created.server.id })
        return created
      })
      if (!result.repeated) changed('server', result.server.id)
      return result
    },
    async recoverServerCommand(projectId, operation, id, input) {
      if (!['create', 'revoke', 'delete', 'storage'].includes(operation)) fail(400, 'DEPLOYMENT_SERVER_OPERATION_INVALID', '节点收据操作无效')
      return store.change(state => {
        const map = mapping(projectId, state)
        authorize(projectId, operation === 'create' ? 'server.create' : 'server.admin', input, operation === 'create' ? input.environmentId : undefined)
        const retired = () => fail(410, 'DEPLOYMENT_NODE_ROUTE_RETIRED', '项目节点全局管理入口已停用，请在平台节点管理中重新确认操作')
        if (operation === 'create') {
          const name = requireText(input.name, '节点名称', 80)
          environment(map, input.environmentId)
          const previous = map.serverRequests.find(entry => entry.requestId === requestId(input.requestId))
          if (!previous) return retired()
          if (previous.fingerprint !== digest(JSON.stringify([name, input.environmentId]))) fail(409, 'DEPLOYMENT_REQUEST_CONFLICT', '同一请求标识不能用于不同服务器参数')
          const selected = state.deployments.servers.find(entry => entry.id === previous.serverId)
          if (!selected) fail(409, 'DEPLOYMENT_SERVER_NOT_FOUND', '原登记节点已移除，请核对全局节点记录')
          return { server: publicServer(selected), registrationToken: null, expiresAt: null, repeated: true }
        }
        const name = { revoke: 'revoke-server', delete: 'delete-server', storage: 'server-storage-policy' }[operation]
        const fields = operation === 'storage' ? [id, input.expectedRevision, input.retainedVersions, input.buildCacheGiB] : [id]
        // 仅核对原收据；失败的旧操作也必须在全局入口显式重新确认。
        return receipt(map, name, input, fields, retired)
      })
    },
    async removeConfiguration(projectId, kind, entityId, input) {
      if (!['service', 'target'].includes(kind))
        fail(400, 'DEPLOYMENT_INPUT_INVALID', '删除对象无效')
      const operation = `delete-${kind}`,
        fields = {
          id: entityId,
          configKey: input.configKey,
          environmentId: input.environmentId ?? null,
        }
      const plan = await store.change((state) => {
        const map = mapping(projectId, state),
          data = state.deployments
        authorize(
          projectId,
          kind === 'service' ? 'service.configure' : 'configure',
          input,
          kind === 'target' ? input.environmentId : undefined,
        )
        const repeated = replayReceipt(map, operation, input, fields)
        if (repeated !== undefined) return { result: repeated }
        const selected = data[kind === 'service' ? 'services' : 'targets'].find(
          (row) => row.id === entityId && row.applicationId === map.applicationId,
        )
        if (!selected) fail(404, 'DEPLOYMENT_NOT_FOUND', '删除对象不存在')
        if (
          kind === 'target' &&
          environment(map, input.environmentId).legacyEnvironmentId !== selected.environmentId
        )
          fail(404, 'DEPLOYMENT_TARGET_NOT_FOUND', '该环境中不存在此部署位置')
        const current =
          kind === 'service'
            ? digest(JSON.stringify([selected.id, selected.name, selected.kind, selected.module]))
            : configKey(data, entityId)
        expected(input.configKey, current, '配置已变化，请刷新后重新确认删除')
        selected.deleting = true
        const targets = data.targets.filter((row) =>
          kind === 'target' ? row.id === entityId : row.serviceId === entityId,
        )
        for (const target of targets) target.deleting = true
        const ids = new Set(targets.map((row) => row.id))
        return {
          taskIds: data.tasks.filter((row) => ids.has(row.targetId)).map((row) => row.id),
          targetIds: [...ids],
        }
      })
      if (plan.result) {
        return plan.result
      }
      await cleanupTasks(plan.taskIds)
      const result = await store.change((state) => {
        const map = mapping(projectId, state),
          data = state.deployments,
          ids = new Set(plan.targetIds)
        authorize(
          projectId,
          kind === 'service' ? 'service.configure' : 'configure',
          input,
          kind === 'target' ? input.environmentId : undefined,
        )
        return receipt(
          map,
          operation,
          input,
          fields,
          () => {
            data.tasks = data.tasks.filter((row) => !ids.has(row.targetId))
            data.releases = data.releases.filter((row) => !ids.has(row.targetId))
            data.targets = data.targets.filter((row) => !ids.has(row.id))
            state.events = state.events.filter(
              (row) => !ids.has(row.targetId) && row.serviceId !== entityId,
            )
            map.targetRequests = map.targetRequests.filter((row) => !ids.has(row.targetId))
            map.mutationRequests = map.mutationRequests.filter(
              (row) =>
                !plan.targetIds
                  .concat(entityId)
                  .some((id) => JSON.stringify(row.result).includes(id)),
            )
            if (kind === 'service') {
              data.environmentSources = data.environmentSources.filter(
                (row) => row.serviceId !== entityId,
              )
              data.services = data.services.filter((row) => row.id !== entityId)
              map.serviceSources = map.serviceSources.filter((row) => row.serviceId !== entityId)
            }
            return { deleted: true, id: entityId }
          },
          fields,
        )
      })
      changed(kind === 'service' ? 'services' : 'targets', entityId)
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
          requireServerUse(projectId, input.serverId, state)
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
        if (selected.deleting) fail(409, 'DEPLOYMENT_DELETING', '部署位置正在删除，请继续原删除')
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
        return nodeReceipt(map, 'bind-server', input, [input.serverId, input.environmentId], () => {
          requireServerUse(projectId, input.serverId, state)
          const selected = data.servers.find(entry => entry.id === input.serverId && !entry.revoked && entry.mode === 'managed')
          if (!selected) fail(404, 'DEPLOYMENT_SERVER_NOT_FOUND', '服务器不存在或接入已撤销')
          if (!data.serverBindings.some(entry => entry.serverId === selected.id && entry.applicationId === map.applicationId)) data.serverBindings.push({ serverId: selected.id, applicationId: map.applicationId, createdAt: now() })
          if (!map.servers.some(entry => entry.serverId === selected.id && entry.environmentId === input.environmentId)) map.servers.push({ serverId: selected.id, environmentId: input.environmentId })
          return publicServer(selected)
        }, projectId)
      })
      changed('server', input.serverId); return result
    },
    async unbindServer(projectId, input) {
      const result = await store.change(state => {
        const map = mapping(projectId, state), env = environment(map, input.environmentId), data = state.deployments
        authorize(projectId, 'server.unbind', input, input.environmentId)
        return nodeReceipt(map, 'unbind-server', input, [input.serverId, input.environmentId], () => {
          server(projectId, input.serverId, state)
          if (data.targets.some(entry => entry.applicationId === map.applicationId && entry.environmentId === env.legacyEnvironmentId && entry.serverId === input.serverId)) fail(409, 'DEPLOYMENT_SERVER_IN_USE', '该环境仍有部署位置，不能解绑服务器')
          map.servers = map.servers.filter(entry => !(entry.serverId === input.serverId && entry.environmentId === input.environmentId))
          if (!map.servers.some(entry => entry.serverId === input.serverId)) data.serverBindings = data.serverBindings.filter(entry => !(entry.serverId === input.serverId && entry.applicationId === map.applicationId))
          return { ok: true }
        }, projectId)
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
