// 工作区适配器负责当前授权与固定源码交付，部署实体、队列和原子写入由引擎公开用例负责。
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { RepositoryService } from '../../src/service.mjs'
import { DeploymentService } from '../../src/deployment.mjs'
import { handleAgentRequest } from '../../src/deploy-http.mjs'
import { configuredWorkspaceStore } from './workspaces.mjs'
import { configuredAutoOpsAccess } from './access.mjs'
import { configuredWorkspaceManagement } from './workspace-management.ts'
import { createDeploymentServers, deploymentServerDto as safeServer } from './deployment-servers.mjs'
import { handleInstallRequest } from '../../src/install-http.mjs'

const fail = (status, code, message) => { throw Object.assign(new Error(message), {status, code}) }
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const copy = (value) => value == null ? value : structuredClone(value)
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, copy(value[key])]))
const uuid = (value, label) => { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) fail(400, 'DEPLOYMENT_ID_INVALID', `${label}无效`); return value }
const normalizedModule = (value) => value === '.' || !value ? '' : value
const safeIdentity = (value) => value && pick(value, ['projectId', 'sourceVersionId', 'packageId', 'service', 'contentHash', 'repositories'])
const safeActor = (value) => value && pick(value, ['id', 'displayName'])
const safeSelection = value => value && ({ sources: value.sources.map(source => pick(source, ['sourceId', 'refKind', 'ref', 'mountPath', 'sourcePath'])), contexts: value.contexts.map(context => pick(context, ['service', 'root', 'workingDirectory'])) })
function safeObservation(value, target) {
  if (!value || typeof value !== 'object' || value.targetId !== target.id) return null
  const statuses = ['created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead', 'missing', 'unknown', 'published', 'unpublished']
  const health = ['none', 'starting', 'healthy', 'unhealthy', 'unknown']
  return { targetId:target.id, kind:target.config.kind,
    exists: typeof value.exists === 'boolean' ? value.exists : null,
    status: statuses.includes(value.status) ? value.status : 'unknown', health:health.includes(value.health) ? value.health : 'unknown', managed:value.managed === true,
    ...(Number.isSafeInteger(value.restartCount) && value.restartCount >= 0 ? {restartCount:value.restartCount} : {}),
    ...(typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)) ? {startedAt:value.startedAt} : {}),
  }
}
function submissionFingerprint(projectId, input, actorId) {
  const selection = input.sourceSelection ? [
    Array.isArray(input.sourceSelection.sources) ? input.sourceSelection.sources.map(source => {
      const original = [source?.sourceId, source?.refKind || 'default', source?.ref || '']
      // 既有收据仍按原已提交字段核对；新增使用配置必须整体固定，不能套用原请求改目录。
      if (source?.mountPath !== undefined || source?.sourcePath !== undefined) original.push(source.mountPath, source.sourcePath ?? null)
      const extra = source && Object.keys(source).filter(key => !['sourceId', 'refKind', 'ref', 'mountPath', 'sourcePath'].includes(key)).sort()
      if (extra?.length) original.push(extra.map(key => [key, source[key]]))
      return original
    }) : input.sourceSelection.sources,
    Array.isArray(input.sourceSelection.contexts) ? input.sourceSelection.contexts.map(context => [context?.service, context?.root, context?.workingDirectory]) : input.sourceSelection.contexts,
  ] : null
  return sha(JSON.stringify([projectId, input.targetId, input.action, input.service, input.configKey, input.packageId || null, input.releaseId || null, selection, actorId]))
}
function safeRelease(value) {
  if (!value) return value
  return {...pick(value, ['id', 'targetId', 'kind', 'action', 'revision', 'commitSubject', 'createdAt', 'available', 'current', 'archiveStatus', 'archiveProtected', 'config', 'restoredFromReleaseId', 'recoveryMethod', 'artifactId', 'artifact', 'sourceClearedAt', 'buildSnapshot']), ...(value.sourceIdentity ? {sourceIdentity:safeIdentity(value.sourceIdentity)} : {}), ...(value.sourceSelection ? {sourceSelection:safeSelection(value.sourceSelection)} : {}), ...(value.actor ? {actor:safeActor(value.actor)} : {})}
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


export function createDeploymentStore({dataDir, workspaceStore, workspaceManagement, access, agentPort, installAssetsRoot, publicOrigin = ''} = {}) {
  if (!dataDir || !workspaceStore) fail(500, 'DEPLOYMENT_NOT_CONFIGURED', '部署验证存储尚未配置')
  if (!access || typeof access.requireDeploymentActor !== 'function' || typeof access.requireDeploymentActionForActor !== 'function') fail(500, 'DEPLOYMENT_AUTHORIZATION_REQUIRED', '部署任务和写入必须配置当前授权检查')
  const directory = join(resolve(dataDir), 'deployment-center')
  const denied = async () => fail(403, 'DEPLOYMENT_GIT_DISABLED', '部署只接受已经固定 Git 提交与构建上下文的源码包')
  const repository = new RepositoryService({directory, builder:{initialize:async () => {}, build:denied, history:denied, branches:denied}})
  const deployment = new DeploymentService(repository, {publicOrigin, resolveWorkspaceSource: async (task) => {
    if (!workspaceManagement) fail(503, 'DEPLOYMENT_SOURCE_UNAVAILABLE', '源码服务暂不可用')
    const projectId = task.workspaceProjectId, actorId = task.actor.id
    const scope = deployment.projects.claimScope(task, deployment.projects.target(projectId, task.targetId).target)
    access.requireDeploymentActor(actorId, projectId, scope.environmentId)
    workspaceManagement.startDeploymentPackages(projectId, {...task.sourceSelection, requestId:task.requestId}, actorId)
    await workspaceStore.whenIdle()
    // 排空阶段仍核对已接受任务的持久收据，不经新写入的接单门禁。
    access.requireDeploymentActor(actorId, projectId, scope.environmentId)
    const receipt = workspaceStore.taskForRequest(projectId, 'packages', task.requestId, actorId)
    if (!receipt || receipt.status !== 'completed' || !receipt.releaseId) fail(409, 'DEPLOYMENT_SOURCE_FAILED', receipt?.error || '源码准备未完成，请查看任务后重新发布')
    return preparePackage(projectId, receipt.releaseId, task.config.kind === 'java' ? 'backend' : 'frontend', task.config.module)
  }, authorizeProjectMutation({projectId, environmentId, action, actor}) {
    if (projectId === null) access.requireDeploymentNodeManagerForActor(actor?.id)
    else access.requireDeploymentActionForActor(actor?.id, projectId, action, environmentId)
  }, authorizeTask({ task, target }) {
    const scope = deployment.projects.claimScope(task, target)
    access.requireDeploymentActor(task.actor.id, scope.projectId, scope.environmentId)
  }})
  const servers = createDeploymentServers({deployment})
  let initializing, pending = Promise.resolve(), listener, listenerClosing, closing, closed = false
  const operations = new Set()
  const accept = (work) => {
    if (closed) return Promise.reject(Object.assign(new Error('部署服务正在停止，请稍后重试'), {status:503, code:'DEPLOYMENT_STOPPING'}))
    const operation = Promise.resolve().then(work)
    operations.add(operation)
    void operation.finally(() => operations.delete(operation)).catch(() => {})
    return operation
  }
  const serial = (work) => { const operation = pending.then(work); pending = operation.catch(() => {}); return operation }
  const ownedTarget = (projectId, targetId) => deployment.projects.target(projectId, targetId)
  const targetDto = (projectId, id) => {
    const {target, service, environmentId} = ownedTarget(projectId, id)
    const observedAt = Date.parse(target.lastObservedAt), observation = safeObservation(target.observation, target)
    return {...pick(target, ['id', 'serviceId', 'serverId', 'createdAt', 'updatedAt', 'lastDeployedAt', 'networkIdentity']), name:service.name, environmentId, kind:service.kind, service:service.kind === 'java' ? 'backend' : 'frontend', config:deployment.effectiveConfig(id), configKey:deployment.configKey(id), currentRelease:safeRelease(target.currentRelease),
      observation, lastObservedAt:Number.isFinite(observedAt) ? target.lastObservedAt : null, observationStale:!observation || !Number.isFinite(observedAt) || Date.now() - observedAt > 60_000 || observedAt > Date.now()}
  }
  const taskDto = (projectId, task) => safeTask(task, ownedTarget(projectId, task.targetId).environmentId)

  function validateSources(projectId, input, actorId) {
    if (!workspaceManagement) fail(503, 'DEPLOYMENT_SOURCE_UNAVAILABLE', '源码服务暂不可用')
    const current = workspaceManagement.authoring.repositories(projectId, actorId)
    if (!Array.isArray(input.sources) || !input.sources.length || input.sources.some(entry => !current.items.some(source => source.id === entry?.sourceId)))
      fail(404, 'DEPLOYMENT_SOURCE_NOT_FOUND', '发布源码不存在或已移除')
  }
  async function preparePackage(projectId, packageId, role, module) {
    uuid(packageId, '源码包标识')
    const overview = workspaceStore.overview(projectId), selected = overview.releases.find((item) => item.id === packageId)
        if (!selected) fail(404, 'DEPLOYMENT_PACKAGE_NOT_FOUND', '当前项目中不存在此源码包')
        const version = workspaceStore.getVersion(projectId, selected.sourceVersionId), manifest = selected.manifest, artifact = manifest?.services?.find((item) => item.service === role)
        if (version.type !== 'internal' || version.status !== 'published' || (version.cachePurpose && version.cachePurpose !== 'deployment') || manifest.projectId !== projectId || manifest.releaseId !== packageId || manifest.sourceVersionId !== version.id || manifest.status !== 'packaged' || manifest.source?.contentHash !== version.source.contentHash || JSON.stringify(manifest.source?.repositories) !== JSON.stringify(version.source.repositories)) fail(409, 'DEPLOYMENT_SOURCE_INVALID', '源码包与固定 Git 来源不一致')
        if (version.cachePurpose === 'deployment' && (!version.source.repositories.length || version.source.documents?.length)) fail(409, 'DEPLOYMENT_SOURCE_INVALID', '部署源码输入不能包含上传资料')
        if (!artifact || artifact.context?.service !== role || typeof artifact.context?.workingDirectory !== 'string' || normalizedModule(artifact.context.workingDirectory) !== normalizedModule(module)) fail(409, 'DEPLOYMENT_CONTEXT_MISMATCH', '源码包构建目录与部署配置不一致，请为此构建上下文配置独立服务')
        const packed = workspaceStore.packageFile(projectId, packageId, role), bytes = Buffer.from(packed.bytes)
        if (bytes.length !== artifact.size || sha(bytes) !== artifact.sha256) fail(409, 'DEPLOYMENT_PACKAGE_CHANGED', '源码包内容与固定清单不一致，已停止发布')
        if (bytes.length > 64 * 1024 * 1024) fail(413, 'DEPLOYMENT_PACKAGE_TOO_LARGE', '部署仅支持不超过 64 MiB 的源码 ZIP')
    const temporary = await mkdtemp(join(directory, 'workspace-inputs', 'package-'))
    const cleanup = () => rm(temporary, {recursive:true, force:true})
    try {
      const file = join(temporary, 'source.zip'); await writeFile(file, bytes, {flag:'wx', mode:0o600})
      const sourceIdentity = {projectId, sourceVersionId:version.id, packageId, service:role, contentHash:version.source.contentHash, repositories:copy(version.source.repositories)}
      const revision = version.source.repositories.length === 1 ? version.source.repositories[0].commit : version.source.contentHash
      return {archive:{file, sha256:artifact.sha256, size:bytes.length, revision}, sourceIdentity, cleanup}
    } catch (error) { await cleanup(); throw error }
  }

  const store = {
    async initialize() {
      if (closed) fail(503, 'DEPLOYMENT_CLOSED', '部署中心已关闭')
      if (!initializing) initializing = (async () => {
        await repository.initialize()
        // 仅清理工作区交付时的临时副本，持久化源码恢复由部署引擎负责。
        const root = join(directory, 'workspace-inputs')
        await mkdir(root, {recursive:true, mode:0o700})
        for (const name of await readdir(root)) if (/^package-[A-Za-z0-9]+$/.test(name)) await rm(join(root, name), {recursive:true, force:true})
        await deployment.initialize()
        await deployment.projects.initialize()
        if (agentPort !== undefined) {
          if (!Number.isInteger(agentPort) || agentPort < 0 || agentPort > 65535) fail(500, 'DEPLOYMENT_AGENT_PORT_INVALID', '部署 Agent 接入端口无效')
          listener = createServer((req, res) => {
            const operation = (async () => {
              const json = (response, status, body) => { response.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'}); response.end(JSON.stringify(body)) }
              const body = async (request) => { let size = 0; const chunks = []; for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) fail(413, 'BODY_TOO_LARGE', 'Agent 请求过大'); chunks.push(chunk) } try { return JSON.parse(Buffer.concat(chunks).toString()) } catch { fail(400, 'INVALID_JSON', 'Agent 请求格式错误') } }
              if (closed) { json(res,503,{error:'部署服务正在停止，请稍后重试',code:'DEPLOYMENT_STOPPING'}); return }
              try { if (!await handleInstallRequest(req, res, new URL(req.url || '/', 'http://127.0.0.1').pathname, {assetsRoot:installAssetsRoot}) && !await handleAgentRequest(req, res, new URL(req.url || '/', 'http://127.0.0.1'), {deployment, body, json})) json(res, 404, {error:'Agent 接口不存在'}) }
              catch (error) { if (!res.headersSent) json(res, Number.isInteger(error.status) ? error.status : 500, {error:error.status ? error.message : '部署 Agent 请求失败'}); else res.destroy() }
            })()
            operations.add(operation)
            void operation.finally(() => operations.delete(operation)).catch(() => {})
          })
          listener.requestTimeout = 30_000; listener.headersTimeout = 15_000
          await new Promise((done, reject) => { listener.once('error', reject); listener.listen(agentPort, '127.0.0.1', done) })
        }
        return store
      })().catch(async (error) => {
        store.stopAccepting()
        try { if (listenerClosing) await listenerClosing; await deployment.close() }
        finally { await repository.store.close() }
        throw error
      })
      return initializing
    },
    async ensureProject(project) {
      return accept(async () => {
        await store.initialize()
        await deployment.projects.ensureProject(project)
      })
    },
    overview(project, environmentIds) {
      const all = deployment.projects.snapshot(project.id), map = all.mapping, allowed = new Set(environmentIds)
      const targets = all.targets.filter((item) => item.applicationId === map.applicationId).map((item) => targetDto(project.id, item.id)).filter((item) => allowed.has(item.environmentId)), ids = new Set(targets.map((item) => item.id))
      const scopedTasks = all.tasks.filter((item) => ids.has(item.targetId))
      const tasks = scopedTasks.filter((item, index) => index >= scopedTasks.length - 200 || !['succeeded', 'failed', 'rolled_back', 'interrupted'].includes(item.status)).reverse().map((item) => taskDto(project.id, item))
      return {enabled:true, environments:project.environments.filter((item) => allowed.has(item.id)).map((item) => ({id:item.id, name:item.name})), servers:map.servers.filter(bound => allowed.has(bound.environmentId)).flatMap(bound => { const server = all.servers.find(item => item.id === bound.serverId); return server ? [safeServer(server, bound.environmentId)] : [] }), services:all.services.map(item => pick(item, ['id', 'name', 'kind', 'module', 'configKey'])), serviceSources:all.serviceSources.filter(item => allowed.has(item.environmentId)), targets, tasks}
    },
    availableServers(projectId) { return servers.availableServers(projectId) },
    globalNodeCatalog(principal) { access.requireDeploymentNodeManager(principal); const value = deployment.projects.globalNodeCatalog({ actor: safeActor(principal) }); return { ...value, servers: value.servers.map(server => safeServer(server)) } },
    createGlobalServer(input, principal) { return accept(async () => { const value = await deployment.projects.createGlobalServer({ ...input, actor: safeActor(principal) }); return { ...value, server: safeServer(value.server) } }) },
    mutateGlobalServer(id, operation, input, principal) { return accept(async () => { const value = await deployment.projects.mutateGlobalServer(id, operation, { ...input, actor: safeActor(principal) }); return operation === 'storage' ? safeServer(value) : value }) },
    setServerAccess(projectId, input, principal) { return accept(() => deployment.projects.setServerAccess(projectId, { ...input, actor: safeActor(principal) })) },
    serverScope(projectId, serverId) { const snapshot = deployment.projects.snapshot(projectId); return snapshot.mapping.servers.filter(bound => bound.serverId === serverId).map(bound => bound.environmentId) },
    server(projectId, serverId) { return servers.server(projectId, serverId) },
    createServer(projectId, input) { return accept(() => serial(() => servers.createServer(projectId, input))) },
    bindServer(projectId, input) { return accept(async () => ({server:await servers.bindServer(projectId, input)})) },
    unbindServer(projectId, input) { return accept(() => servers.unbindServer(projectId, input)) },
    revokeServer(projectId, id, input) { return accept(() => servers.revokeServer(projectId, id, input)) },
    deleteServer(projectId, id, input) { return accept(() => servers.deleteServer(projectId, id, input)) },
    saveStoragePolicy(projectId, id, input) { return accept(async () => ({server:await servers.saveStoragePolicy(projectId, id, input)})) },
    async createTarget(projectId, input) {
      return accept(async () => {
        const id = await deployment.projects.createTarget(projectId, input)
        return {target:targetDto(projectId, id)}
      })
    },
    async saveService(projectId, input) {
      return accept(async () => ({service:pick(await deployment.projects.saveService(projectId, input), ['id', 'name', 'kind', 'module', 'configKey'])}))
    },
    async updateTarget(projectId, targetId, input) {
      return accept(async () => { await deployment.projects.updateTarget(projectId, targetId, input); return {target:targetDto(projectId, targetId)} })
    },
    repositoryRefs(projectId, sourceId, actorId) { return accept(() => workspaceManagement.repositoryRefs(projectId, sourceId, actorId)) },
    repositoryHistory(projectId, sourceId, input, actorId) { return accept(() => workspaceManagement.repositoryHistory(projectId, sourceId, input, actorId)) },
    serviceSource(projectId, serviceId, environmentId) { return {source:deployment.projects.serviceSource(projectId, serviceId, environmentId)} },
    async saveServiceSource(projectId, input, principal) {
      return accept(async () => {
        const submitted = {...input, actor:safeActor(principal)}
        const previous = deployment.projects.serviceSourceRequest(projectId, submitted)
        if (previous !== undefined) return {source:previous}
        validateSources(projectId, input, principal.id)
        return {source:await deployment.projects.saveServiceSource(projectId, submitted)}
      })
    },
    targetScope(projectId, targetId) { return {environmentId:ownedTarget(projectId, targetId).environmentId} },
    taskScope(projectId, taskId) { const task = deployment.projects.task(projectId, taskId); return store.targetScope(projectId, task.targetId) },
    async createTask(projectId, input, principal) {
      return accept(async () => {
        const {target, service, environmentId} = ownedTarget(projectId, input.targetId)
        access.requireDeploymentActor(principal.id, projectId, environmentId)
        uuid(input.requestId, '请求标识')
        const role = service.kind === 'java' ? 'backend' : 'frontend'
        if (!['deploy', 'rollback', 'restart'].includes(input.action) || input.service !== role) fail(400, 'DEPLOYMENT_ACTION_UNSUPPORTED', '发布动作与服务类型不匹配')
        if (typeof input.configKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.configKey)) fail(400, 'DEPLOYMENT_CONFIG_REQUIRED', '请刷新配置并确认发布快照')
        const actor = {id:principal.id, displayName:principal.displayName}
        const fingerprint = submissionFingerprint(projectId, input, principal.id)
        const previous = deployment.projects.taskForRequest(projectId, input.requestId)
        // 收据按原始提交核对；默认来源、现行配置及原工作区包后续变化不改变已接受任务。
        if (previous?.submissionFingerprint) {
          if (previous.submissionFingerprint !== fingerprint) fail(409, 'DEPLOYMENT_REQUEST_CONFLICT', '同一请求标识不能用于不同发布参数或操作人')
          return {task:taskDto(projectId, previous)}
        }
        deployment.projects.requireServerUse(projectId, target.serverId)
        if (input.action !== 'deploy') {
          const task = await deployment.createTask({targetId:target.id, action:input.action, ...(input.action === 'rollback' ? {releaseId:uuid(input.releaseId, '回退版本')} : {}), requestId:input.requestId, configKey:input.configKey, submissionFingerprint:fingerprint, actor})
          return {task:taskDto(projectId, task)}
        }
        if (!input.packageId) {
          const selection = input.sourceSelection || deployment.projects.serviceSource(projectId, service.id, environmentId)
          if (!selection) fail(400, 'DEPLOYMENT_SOURCE_REQUIRED', '请先选择发布源码')
          validateSources(projectId, selection, principal.id)
          const task = await deployment.createTaskFromWorkspaceSource({projectId, sourceSelection:pick(selection, ['sources', 'contexts']), targetId:target.id, requestId:input.requestId, configKey:input.configKey, submissionFingerprint:fingerprint, actor})
          return {task:taskDto(projectId, task)}
        }
        const prepared = await preparePackage(projectId, input.packageId, role, deployment.effectiveConfig(target.id).module)
        try {
          const task = await deployment.createTaskFromArchive({targetId:target.id, requestId:input.requestId, configKey:input.configKey, submissionFingerprint:fingerprint, actor, sourceIdentity:prepared.sourceIdentity}, prepared.archive)
          return {task:taskDto(projectId, task)}
        } finally { await prepared.cleanup() }
      })
    },
    async taskDetails(projectId, id, after = 0) {
      store.taskScope(projectId, id)
      const details = await deployment.taskDetails(id, after)
      return {task:taskDto(projectId, details.task), logs:details.logs.map((item) => pick(item, ['seq', 'stage', 'status', 'message', 'stream', 'at', 'receivedAt', 'agentTimestamp', 'timeAdjusted'])), nextSeq:details.nextSeq}
    },
    releases(projectId, targetId, offset, limit) {
      ownedTarget(projectId, targetId)
      if (offset === undefined && limit === undefined) return {releases:deployment.releases(targetId).map(safeRelease)}
      const page = deployment.releasePage(targetId, offset, limit)
      return {...page, releases:page.releases.map(safeRelease)}
    },
    release(projectId, targetId, releaseId) { ownedTarget(projectId, targetId); return {release:safeRelease(deployment.release(targetId, releaseId))} },
    releaseSource(projectId, targetId, releaseId) {
      return accept(async () => {
        ownedTarget(projectId, targetId)
        const source = await deployment.releaseSource(targetId, releaseId)
        const bytes = await readFile(source.file)
        if (bytes.length !== source.size || sha(bytes) !== source.sha256) fail(409, 'DEPLOYMENT_SOURCE_CHANGED', '源码档案校验失败')
        return {bytes, name:`source-${releaseId}.zip`, mime:'application/zip'}
      })
    },
    clearReleaseSource(projectId, targetId, releaseId, input) { return accept(() => {
      ownedTarget(projectId, targetId)
      return deployment.clearReleaseSource(targetId, releaseId, input)
    }) },
    get agentAddress() { return listener?.address() },
    stopAccepting() {
      closed = true; deployment.beginClose()
      if (listener?.listening) listenerClosing ||= new Promise((done) => listener.close(done))
    },
    close() {
      store.stopAccepting()
      return closing ||= (async () => {
        await initializing?.catch(() => {})
        store.stopAccepting()
        await Promise.allSettled([...operations])
        await pending
        try {
          if (listenerClosing) await listenerClosing
          await deployment.close()
        } finally { await repository.store.close() }
      })()
    },
  }
  return store
}

let configured, configuredStopped = false
export function stopConfiguredDeploymentStore() { configuredStopped = true; configured?.store.stopAccepting() }
export async function closeConfiguredDeploymentStore() { stopConfiguredDeploymentStore(); await configured?.store.close() }
export function configuredDeploymentStore() {
  if (configuredStopped) fail(503, 'DEPLOYMENT_STOPPING', '部署服务正在停止，请稍后重试')
  if (process.env.AUTOOPS_DEPLOYMENT_ENABLED !== '1') return undefined
  const dataDir = process.env.AUTOOPS_T3_DATA_DIR, workspaceStore = configuredWorkspaceStore()
  if (!dataDir || !workspaceStore) fail(500, 'DEPLOYMENT_NOT_CONFIGURED', '部署验证存储尚未配置')
  const port = process.env.AUTOOPS_DEPLOYMENT_AGENT_PORT
  // Worker 打包会移动模块位置，安装资产沿用启动器已固定的业务资源根。
  const installAssetsRoot = process.env.AUTOOPS_BUSINESS_RESOURCES_DIR ? resolve(process.env.AUTOOPS_BUSINESS_RESOURCES_DIR, '../..') : undefined
  if (!configured || configured.dataDir !== dataDir) configured = {dataDir, store:createDeploymentStore({dataDir, workspaceStore, workspaceManagement:configuredWorkspaceManagement(configuredAutoOpsAccess()), access:configuredAutoOpsAccess(), ...(port === undefined ? {} : {agentPort:Number(port)}), ...(installAssetsRoot === undefined ? {} : {installAssetsRoot}), publicOrigin:process.env.AUTOOPS_DEPLOYMENT_PUBLIC_ORIGIN || ''})}
  return configured.store
}
