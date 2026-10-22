// Project authorization and immutable workspace delivery bridge. Execution,
// archives, events, recovery and Agent protocol remain owned by the old engine.
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { RepositoryService } from '../../src/service.mjs'
import { DeploymentService, validateConfig } from '../../src/deployment.mjs'
import { handleAgentRequest } from '../../src/deploy-http.mjs'
import { configuredWorkspaceStore } from './workspaces.mjs'

const fail = (status, code, message) => { throw Object.assign(new Error(message), {status, code}) }
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const copy = (value) => value == null ? value : structuredClone(value)
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, copy(value[key])]))
const uuid = (value, label) => { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) fail(400, 'DEPLOYMENT_ID_INVALID', `${label}无效`); return value }
const text = (value, label, max = 80) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) fail(400, 'DEPLOYMENT_INPUT_INVALID', `${label}无效`); return value.trim() }
const normalizedModule = (value) => value === '.' || !value ? '' : value
const safeIdentity = (value) => value && pick(value, ['projectId', 'sourceVersionId', 'packageId', 'service', 'contentHash', 'repositories'])
const safeActor = (value) => value && pick(value, ['id', 'displayName'])
function safeRelease(value) {
  if (!value) return value
  return {...pick(value, ['id', 'targetId', 'kind', 'action', 'revision', 'commitSubject', 'createdAt', 'available', 'current', 'archiveStatus', 'archiveProtected', 'config', 'restoredFromReleaseId', 'recoveryMethod', 'artifactId', 'artifact', 'sourceClearedAt', 'buildSnapshot']), ...(value.sourceIdentity ? {sourceIdentity:safeIdentity(value.sourceIdentity)} : {}), ...(value.actor ? {actor:safeActor(value.actor)} : {})}
}
function safeResult(value) {
  if (!value || typeof value !== 'object') return undefined
  const result = Object.fromEntries(['error', 'cleanupError', 'recoveryMethod'].filter((key) => typeof value[key] === 'string').map((key) => [key, value[key]]))
  if (value.release) result.release = safeRelease(value.release)
  if (value.rollback && typeof value.rollback === 'object') result.rollback = {
    ...(['succeeded', 'failed', 'unavailable'].includes(value.rollback.status) ? {status:value.rollback.status} : {}),
    ...(typeof value.rollback.error === 'string' ? {error:value.rollback.error} : {}),
    ...(value.rollback.release ? {release:safeRelease(value.rollback.release)} : {}),
  }
  return result
}
function safeTask(value, environmentId) {
  return {...pick(value, ['id', 'targetId', 'serverId', 'action', 'status', 'stage', 'stageHistory', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'error', 'revision', 'commitSubject', 'config', 'lastSeq', 'requestId', 'detailedAgentStages', 'recoveryAllowed', 'recoveryMethod']), environmentId,
    ...(value.sourceIdentity ? {sourceIdentity:safeIdentity(value.sourceIdentity)} : {}), ...(value.actor ? {actor:safeActor(value.actor)} : {}), ...(value.result ? {result:safeResult(value.result)} : {}), ...(value.release ? {release:safeRelease(value.release)} : {}), ...(value.previousRelease ? {previousRelease:safeRelease(value.previousRelease)} : {})}
}
function safeServer(value, environmentId) {
  return {...pick(value, ['id', 'name', 'online', 'registeredAt', 'lastSeenAt', 'version', 'revoked', 'capabilities']), environmentId}
}

export function createDeploymentStore({dataDir, workspaceStore, agentPort, publicOrigin = ''} = {}) {
  if (!dataDir || !workspaceStore) fail(500, 'DEPLOYMENT_NOT_CONFIGURED', '部署验证存储尚未配置')
  const directory = join(resolve(dataDir), 'deployment-center')
  const denied = async () => fail(403, 'DEPLOYMENT_GIT_DISABLED', '部署只接受已发布内部工作区生成的固定源码包')
  const repository = new RepositoryService({directory, builder:{initialize:async () => {}, build:denied, history:denied, branches:denied}})
  const deployment = new DeploymentService(repository, {publicOrigin})
  let initializing, pending = Promise.resolve(), listener, closed = false
  const serial = (work) => { const operation = pending.then(work); pending = operation.catch(() => {}); return operation }
  const bindings = () => repository.store.state.autoopsDeploymentBindings
  const mapping = (projectId) => {
    const entry = bindings().projects.find((item) => item.projectId === projectId)
    if (!entry) fail(404, 'DEPLOYMENT_PROJECT_NOT_FOUND', '部署项目尚未初始化')
    return entry
  }
  const environment = (map, environmentId) => {
    const item = map.environments.find((entry) => entry.environmentId === environmentId)
    if (!item) fail(404, 'DEPLOYMENT_ENVIRONMENT_NOT_FOUND', '部署环境不存在')
    return item
  }
  const ownedTarget = (projectId, targetId) => {
    const map = mapping(projectId), target = deployment.data.targets.find((item) => item.id === targetId && item.applicationId === map.applicationId && !item.retiredAt)
    const env = target && map.environments.find((item) => item.legacyEnvironmentId === target.environmentId)
    const server = target && map.servers.find((item) => item.serverId === target.serverId && item.environmentId === env?.environmentId)
    if (!target || !env || !server) fail(404, 'DEPLOYMENT_TARGET_NOT_FOUND', '当前项目与环境中不存在此部署服务')
    return {map, target, environmentId:env.environmentId}
  }
  const targetDto = (projectId, id) => {
    const {target, environmentId} = ownedTarget(projectId, id), service = deployment.data.services.find((item) => item.id === target.serviceId)
    return {...pick(target, ['id', 'serverId', 'createdAt', 'updatedAt', 'lastDeployedAt', 'observation']), name:service.name, environmentId, kind:'static', service:'frontend', config:copy(target.config), configKey:deployment.configKey(id), currentRelease:safeRelease(target.currentRelease)}
  }
  const taskDto = (projectId, task) => safeTask(task, ownedTarget(projectId, task.targetId).environmentId)

  const store = {
    async initialize() {
      if (closed) fail(503, 'DEPLOYMENT_CLOSED', '部署中心已关闭')
      if (!initializing) initializing = (async () => {
        await repository.initialize()
        await deployment.initialize()
        await repository.store.change((state) => {
          state.autoopsDeploymentBindings ||= {version:1, projects:[]}
          if (state.autoopsDeploymentBindings.version !== 1 || !Array.isArray(state.autoopsDeploymentBindings.projects)) throw new Error('部署项目映射版本无效')
        })
        // Only task-local, adapter-owned staging copies are disposable. The
        // persistent archive engine has already recovered preparing tasks.
        const root = join(directory, 'workspace-inputs')
        await mkdir(root, {recursive:true, mode:0o700})
        for (const name of await readdir(root)) if (/^package-[A-Za-z0-9]+$/.test(name)) await rm(join(root, name), {recursive:true, force:true})
        if (agentPort !== undefined) {
          if (!Number.isInteger(agentPort) || agentPort < 0 || agentPort > 65535) fail(500, 'DEPLOYMENT_AGENT_PORT_INVALID', '部署 Agent 接入端口无效')
          listener = createServer(async (req, res) => {
            const json = (response, status, body) => { response.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'}); response.end(JSON.stringify(body)) }
            const body = async (request) => { let size = 0; const chunks = []; for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) fail(413, 'BODY_TOO_LARGE', 'Agent 请求过大'); chunks.push(chunk) } try { return JSON.parse(Buffer.concat(chunks).toString()) } catch { fail(400, 'INVALID_JSON', 'Agent 请求格式错误') } }
            try { if (!await handleAgentRequest(req, res, new URL(req.url || '/', 'http://127.0.0.1'), {deployment, body, json})) json(res, 404, {error:'Agent 接口不存在'}) }
            catch (error) { if (!res.headersSent) json(res, Number.isInteger(error.status) ? error.status : 500, {error:error.status ? error.message : '部署 Agent 请求失败'}); else res.destroy() }
          })
          await new Promise((done, reject) => { listener.once('error', reject); listener.listen(agentPort, '127.0.0.1', done) })
        }
        return store
      })()
      return initializing
    },
    async ensureProject(project) {
      await store.initialize()
      await repository.store.change((state) => {
        const maps = state.autoopsDeploymentBindings.projects, data = state.deployments
        let map = maps.find((entry) => entry.projectId === project.id)
        if (!map) {
          // Identity provisioning and mapping are one transaction. Do not call
          // legacy WorkspaceService.create(), which adds unrelated defaults.
          const applicationId = randomUUID()
          data.applications.push({id:applicationId, name:project.name, description:'工作台部署验证', createdAt:new Date().toISOString()})
          map = {projectId:project.id, applicationId, environments:[], servers:[], targetRequests:[], serverRequests:[]}; maps.push(map)
        }
        const app = data.applications.find((item) => item.id === map.applicationId)
        if (!app) throw new Error('部署项目身份映射损坏')
        app.name = project.name
        for (const env of project.environments) {
          let selected = map.environments.find((item) => item.environmentId === env.id)
          if (!selected) { selected = {environmentId:env.id, legacyEnvironmentId:randomUUID()}; map.environments.push(selected); data.environments.push({id:selected.legacyEnvironmentId, applicationId:map.applicationId, name:env.name, createdAt:new Date().toISOString()}) }
          const legacy = data.environments.find((item) => item.id === selected.legacyEnvironmentId && item.applicationId === map.applicationId)
          if (!legacy) throw new Error('部署环境身份映射损坏')
          legacy.name = env.name
        }
      })
    },
    overview(project, environmentIds) {
      const map = mapping(project.id), allowed = new Set(environmentIds), all = deployment.overview(), serverIds = new Set(map.servers.filter((item) => allowed.has(item.environmentId)).map((item) => item.serverId))
      const targets = all.targets.filter((item) => item.applicationId === map.applicationId).map((item) => targetDto(project.id, item.id)).filter((item) => allowed.has(item.environmentId)), ids = new Set(targets.map((item) => item.id))
      const scopedTasks = deployment.data.tasks.filter((item) => item.applicationId === map.applicationId && ids.has(item.targetId))
      const tasks = scopedTasks.filter((item, index) => index >= scopedTasks.length - 200 || !['succeeded', 'failed', 'rolled_back', 'interrupted'].includes(item.status)).reverse().map((item) => taskDto(project.id, item))
      return {enabled:true, environments:project.environments.filter((item) => allowed.has(item.id)).map((item) => ({id:item.id, name:item.name})), servers:all.servers.filter((item) => serverIds.has(item.id)).map((item) => safeServer(item, map.servers.find((bound) => bound.serverId === item.id).environmentId)), targets, tasks}
    },
    async createServer(projectId, input) {
      return serial(async () => {
        const map = mapping(projectId); environment(map, input.environmentId)
        const name = text(input.name, '服务器名称'), requestId = input.requestId && uuid(input.requestId, '请求标识'), fingerprint = sha(JSON.stringify([name, input.environmentId]))
        const repeated = requestId && map.serverRequests.find((item) => item.requestId === requestId)
        if (repeated) { if (repeated.fingerprint !== fingerprint) fail(409, 'DEPLOYMENT_REQUEST_CONFLICT', '同一请求标识不能用于不同服务器参数'); const current = deployment.overview().servers.find((item) => item.id === repeated.serverId); return {server:safeServer(current, input.environmentId), registrationToken:null, expiresAt:null, repeated:true} }
        const result = await deployment.createServer({name, applicationId:map.applicationId})
        await repository.store.change((state) => { const selected = state.autoopsDeploymentBindings.projects.find((item) => item.projectId === projectId); selected.servers.push({serverId:result.server.id, environmentId:input.environmentId}); if (requestId) selected.serverRequests.push({requestId, fingerprint, serverId:result.server.id}) })
        return {server:safeServer(result.server, input.environmentId), registrationToken:result.registrationToken, expiresAt:result.expiresAt}
      })
    },
    async createTarget(projectId, input) {
      const name = text(input.name, '服务名称'), requestId = uuid(input.requestId, '请求标识'), module = input.config?.module || '.', config = validateConfig(input.config || {}, module, 'static')
      const fingerprint = sha(JSON.stringify([name, input.environmentId, input.serverId, config]))
      const targetId = await repository.store.change((state) => {
        const map = state.autoopsDeploymentBindings.projects.find((item) => item.projectId === projectId), env = environment(map, input.environmentId), data = state.deployments
        const repeated = map.targetRequests.find((item) => item.requestId === requestId)
        if (repeated) { if (repeated.fingerprint !== fingerprint) fail(409, 'DEPLOYMENT_REQUEST_CONFLICT', '同一请求标识不能用于不同部署服务参数'); return repeated.targetId }
        if (!map.servers.some((item) => item.serverId === input.serverId && item.environmentId === input.environmentId) || !data.serverBindings.some((item) => item.serverId === input.serverId && item.applicationId === map.applicationId)) fail(404, 'DEPLOYMENT_SERVER_NOT_FOUND', '当前项目与环境中不存在此服务器')
        const server = data.servers.find((item) => item.id === input.serverId && !item.revoked && item.mode === 'managed')
        if (!server) fail(409, 'DEPLOYMENT_SERVER_REVOKED', '目标服务器已撤销或不可用')
        if (data.services.length >= 2000 || data.targets.length >= 2000) fail(400, 'DEPLOYMENT_TARGET_LIMIT', '部署服务数量已达到上限')
        const serviceId = randomUUID(), id = randomUUID(), at = new Date().toISOString()
        data.services.push({id:serviceId, applicationId:map.applicationId, name, kind:'static', module, createdAt:at, updatedAt:at})
        data.targets.push({id, applicationId:map.applicationId, environmentId:env.legacyEnvironmentId, serviceId, serverId:server.id, mode:'managed', containerName:null, config, networkIdentity:null, owner:'platform', createdAt:at, updatedAt:at})
        map.targetRequests.push({requestId, fingerprint, targetId:id}); return id
      })
      deployment.changed('targets', targetId)
      return {target:targetDto(projectId, targetId)}
    },
    targetScope(projectId, targetId) { return {environmentId:ownedTarget(projectId, targetId).environmentId} },
    taskScope(projectId, taskId) { const task = deployment.data.tasks.find((item) => item.id === taskId && item.applicationId === mapping(projectId).applicationId); if (!task) fail(404, 'DEPLOYMENT_TASK_NOT_FOUND', '当前项目中不存在此部署任务'); return store.targetScope(projectId, task.targetId) },
    async createTask(projectId, input, principal) {
      const {target} = ownedTarget(projectId, input.targetId)
      uuid(input.requestId, '请求标识')
      if (!['deploy', 'rollback'].includes(input.action) || input.service !== 'frontend') fail(400, 'DEPLOYMENT_ACTION_UNSUPPORTED', '首轮仅支持前端静态站点发布与回退')
      if (typeof input.configKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.configKey)) fail(400, 'DEPLOYMENT_CONFIG_REQUIRED', '请刷新配置并确认发布快照')
      const actor = {id:principal.id, displayName:principal.displayName}
      if (input.action === 'rollback') {
        const task = await deployment.createTask({targetId:target.id, action:'rollback', releaseId:uuid(input.releaseId, '回退版本'), requestId:input.requestId, configKey:input.configKey, actor})
        return {task:taskDto(projectId, task)}
      }
      const packageId = uuid(input.packageId, '源码包标识'), overview = workspaceStore.overview(projectId), selected = overview.releases.find((item) => item.id === packageId)
      if (!selected) fail(404, 'DEPLOYMENT_PACKAGE_NOT_FOUND', '当前项目中不存在此源码包')
      const version = workspaceStore.getVersion(projectId, selected.sourceVersionId), manifest = selected.manifest, artifact = manifest?.services?.find((item) => item.service === 'frontend')
      if (version.type !== 'internal' || version.status !== 'published' || manifest.projectId !== projectId || manifest.releaseId !== packageId || manifest.sourceVersionId !== version.id || manifest.status !== 'packaged' || manifest.source?.contentHash !== version.source.contentHash || JSON.stringify(manifest.source?.repositories) !== JSON.stringify(version.source.repositories)) fail(409, 'DEPLOYMENT_SOURCE_INVALID', '只能发布来自已发布内部固定版本的源码包')
      if (!artifact || artifact.context?.service !== 'frontend' || typeof artifact.context?.workingDirectory !== 'string' || normalizedModule(artifact.context.workingDirectory) !== normalizedModule(target.config.module)) fail(409, 'DEPLOYMENT_CONTEXT_MISMATCH', '源码包构建目录与部署配置不一致，请为此构建上下文配置独立服务')
      const packed = workspaceStore.packageFile(projectId, packageId, 'frontend'), bytes = Buffer.from(packed.bytes)
      if (bytes.length !== artifact.size || sha(bytes) !== artifact.sha256) fail(409, 'DEPLOYMENT_PACKAGE_CHANGED', '源码包内容与固定清单不一致，已停止发布')
      if (bytes.length > 64 * 1024 * 1024) fail(413, 'DEPLOYMENT_PACKAGE_TOO_LARGE', '部署验证首轮只接受不超过 64 MiB 的源码 ZIP')
      const temporary = await mkdtemp(join(directory, 'workspace-inputs', 'package-'))
      try {
        const file = join(temporary, 'source.zip'); await writeFile(file, bytes, {flag:'wx', mode:0o600})
        const sourceIdentity = {projectId, sourceVersionId:version.id, packageId, service:'frontend', contentHash:version.source.contentHash, repositories:copy(version.source.repositories)}
        const revision = version.source.repositories.length === 1 ? version.source.repositories[0].commit : version.source.contentHash
        const task = await deployment.createTaskFromArchive({targetId:target.id, requestId:input.requestId, configKey:input.configKey, actor, sourceIdentity}, {file, sha256:artifact.sha256, size:bytes.length, revision})
        return {task:taskDto(projectId, task)}
      } finally { await rm(temporary, {recursive:true, force:true}) }
    },
    async taskDetails(projectId, id, after = 0) {
      store.taskScope(projectId, id)
      const details = await deployment.taskDetails(id, after)
      return {task:taskDto(projectId, details.task), logs:details.logs.map((item) => pick(item, ['seq', 'stage', 'status', 'message', 'stream', 'at', 'receivedAt', 'agentTimestamp', 'timeAdjusted'])), nextSeq:details.nextSeq}
    },
    releases(projectId, targetId) { ownedTarget(projectId, targetId); return {releases:deployment.releases(targetId).map(safeRelease)} },
    get agentAddress() { return listener?.address() },
    async close() { closed = true; await pending; await initializing?.catch(() => {}); if (listener) { listener.closeAllConnections(); await new Promise((done) => listener.close(done)) }; await deployment.close(); await repository.store.close() },
  }
  return store
}

let configured
export function configuredDeploymentStore() {
  if (process.env.AUTOOPS_DEPLOYMENT_ENABLED !== '1') return undefined
  const dataDir = process.env.AUTOOPS_T3_DATA_DIR, workspaceStore = configuredWorkspaceStore()
  if (!dataDir || !workspaceStore) fail(500, 'DEPLOYMENT_NOT_CONFIGURED', '部署验证存储尚未配置')
  const port = process.env.AUTOOPS_DEPLOYMENT_AGENT_PORT
  if (!configured || configured.dataDir !== dataDir) configured = {dataDir, store:createDeploymentStore({dataDir, workspaceStore, ...(port === undefined ? {} : {agentPort:Number(port)}), publicOrigin:process.env.AUTOOPS_DEPLOYMENT_PUBLIC_ORIGIN || ''})}
  return configured.store
}
