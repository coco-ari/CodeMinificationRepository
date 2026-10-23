// 工作区适配器负责当前授权与固定源码交付，部署实体、队列和原子写入由引擎公开用例负责。
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { RepositoryService } from '../../src/service.mjs'
import { DeploymentService } from '../../src/deployment.mjs'
import { handleAgentRequest } from '../../src/deploy-http.mjs'
import { configuredWorkspaceStore } from './workspaces.mjs'
import { configuredAutoOpsAccess } from './access.mjs'

const fail = (status, code, message) => { throw Object.assign(new Error(message), {status, code}) }
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const copy = (value) => value == null ? value : structuredClone(value)
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, copy(value[key])]))
const uuid = (value, label) => { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) fail(400, 'DEPLOYMENT_ID_INVALID', `${label}无效`); return value }
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

export function createDeploymentStore({dataDir, workspaceStore, access, agentPort, publicOrigin = ''} = {}) {
  if (!dataDir || !workspaceStore) fail(500, 'DEPLOYMENT_NOT_CONFIGURED', '部署验证存储尚未配置')
  if (!access || typeof access.requireDeploymentActor !== 'function') fail(500, 'DEPLOYMENT_AUTHORIZATION_REQUIRED', '部署任务必须配置当前授权检查')
  const directory = join(resolve(dataDir), 'deployment-center')
  const denied = async () => fail(403, 'DEPLOYMENT_GIT_DISABLED', '部署只接受已经固定 Git 提交与构建上下文的源码包')
  const repository = new RepositoryService({directory, builder:{initialize:async () => {}, build:denied, history:denied, branches:denied}})
  const deployment = new DeploymentService(repository, {publicOrigin, authorizeTask({ task, target }) {
    const scope = deployment.projects.claimScope(task, target)
    access.requireDeploymentActor(task.actor.id, scope.projectId, scope.environmentId)
  }})
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
    return {...pick(target, ['id', 'serverId', 'createdAt', 'updatedAt', 'lastDeployedAt', 'observation']), name:service.name, environmentId, kind:'static', service:'frontend', config:copy(target.config), configKey:deployment.configKey(id), currentRelease:safeRelease(target.currentRelease)}
  }
  const taskDto = (projectId, task) => safeTask(task, ownedTarget(projectId, task.targetId).environmentId)

  const store = {
    async initialize() {
      if (closed) fail(503, 'DEPLOYMENT_CLOSED', '部署中心已关闭')
      if (!initializing) initializing = (async () => {
        await repository.initialize()
        await deployment.initialize()
        await deployment.projects.initialize()
        // 仅清理工作区交付时的临时副本，持久化源码恢复由部署引擎负责。
        const root = join(directory, 'workspace-inputs')
        await mkdir(root, {recursive:true, mode:0o700})
        for (const name of await readdir(root)) if (/^package-[A-Za-z0-9]+$/.test(name)) await rm(join(root, name), {recursive:true, force:true})
        if (agentPort !== undefined) {
          if (!Number.isInteger(agentPort) || agentPort < 0 || agentPort > 65535) fail(500, 'DEPLOYMENT_AGENT_PORT_INVALID', '部署 Agent 接入端口无效')
          listener = createServer((req, res) => {
            const operation = (async () => {
              const json = (response, status, body) => { response.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'}); response.end(JSON.stringify(body)) }
              const body = async (request) => { let size = 0; const chunks = []; for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) fail(413, 'BODY_TOO_LARGE', 'Agent 请求过大'); chunks.push(chunk) } try { return JSON.parse(Buffer.concat(chunks).toString()) } catch { fail(400, 'INVALID_JSON', 'Agent 请求格式错误') } }
              if (closed) { json(res,503,{error:'部署服务正在停止，请稍后重试',code:'DEPLOYMENT_STOPPING'}); return }
              try { if (!await handleAgentRequest(req, res, new URL(req.url || '/', 'http://127.0.0.1'), {deployment, body, json})) json(res, 404, {error:'Agent 接口不存在'}) }
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
      const all = deployment.projects.snapshot(project.id), map = all.mapping, allowed = new Set(environmentIds), serverIds = new Set(map.servers.filter((item) => allowed.has(item.environmentId)).map((item) => item.serverId))
      const targets = all.targets.filter((item) => item.applicationId === map.applicationId).map((item) => targetDto(project.id, item.id)).filter((item) => allowed.has(item.environmentId)), ids = new Set(targets.map((item) => item.id))
      const scopedTasks = all.tasks.filter((item) => ids.has(item.targetId))
      const tasks = scopedTasks.filter((item, index) => index >= scopedTasks.length - 200 || !['succeeded', 'failed', 'rolled_back', 'interrupted'].includes(item.status)).reverse().map((item) => taskDto(project.id, item))
      return {enabled:true, environments:project.environments.filter((item) => allowed.has(item.id)).map((item) => ({id:item.id, name:item.name})), servers:all.servers.filter((item) => serverIds.has(item.id)).map((item) => safeServer(item, map.servers.find((bound) => bound.serverId === item.id).environmentId)), targets, tasks}
    },
    async createServer(projectId, input) {
      return accept(async () => {
        return serial(async () => {
          const result = await deployment.projects.createServer(projectId, input)
          return {server:safeServer(result.server, input.environmentId), registrationToken:result.registrationToken, expiresAt:result.expiresAt, ...(result.repeated ? {repeated:true} : {})}
        })
      })
    },
    async createTarget(projectId, input) {
      return accept(async () => {
        const id = await deployment.projects.createTarget(projectId, input)
        return {target:targetDto(projectId, id)}
      })
    },
    targetScope(projectId, targetId) { return {environmentId:ownedTarget(projectId, targetId).environmentId} },
    taskScope(projectId, taskId) { const task = deployment.projects.task(projectId, taskId); return store.targetScope(projectId, task.targetId) },
    async createTask(projectId, input, principal) {
      return accept(async () => {
        const {target, environmentId} = ownedTarget(projectId, input.targetId)
        access.requireDeploymentActor(principal.id, projectId, environmentId)
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
        if (version.type !== 'internal' || version.status !== 'published' || (version.cachePurpose && version.cachePurpose !== 'deployment') || manifest.projectId !== projectId || manifest.releaseId !== packageId || manifest.sourceVersionId !== version.id || manifest.status !== 'packaged' || manifest.source?.contentHash !== version.source.contentHash || JSON.stringify(manifest.source?.repositories) !== JSON.stringify(version.source.repositories)) fail(409, 'DEPLOYMENT_SOURCE_INVALID', '源码包与固定 Git 来源不一致')
        if (version.cachePurpose === 'deployment' && (!version.source.repositories.length || version.source.documents?.length)) fail(409, 'DEPLOYMENT_SOURCE_INVALID', '部署源码输入不能包含上传资料')
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
      })
    },
    async taskDetails(projectId, id, after = 0) {
      store.taskScope(projectId, id)
      const details = await deployment.taskDetails(id, after)
      return {task:taskDto(projectId, details.task), logs:details.logs.map((item) => pick(item, ['seq', 'stage', 'status', 'message', 'stream', 'at', 'receivedAt', 'agentTimestamp', 'timeAdjusted'])), nextSeq:details.nextSeq}
    },
    releases(projectId, targetId) { ownedTarget(projectId, targetId); return {releases:deployment.releases(targetId).map(safeRelease)} },
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
  if (!configured || configured.dataDir !== dataDir) configured = {dataDir, store:createDeploymentStore({dataDir, workspaceStore, access:configuredAutoOpsAccess(), ...(port === undefined ? {} : {agentPort:Number(port)}), publicOrigin:process.env.AUTOOPS_DEPLOYMENT_PUBLIC_ORIGIN || ''})}
  return configured.store
}
