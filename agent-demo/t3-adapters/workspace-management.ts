// @effect-diagnostics nodeBuiltinImport:off -- 工作区组合根协调独立 Node 模块，统一管理接单和资源排空。
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AutoOpsAccess } from './access.mjs'
import { configuredWorkspaceStore, WorkspaceError, type WorkspaceStore } from './workspaces.mjs'
import { createWorkspaceAuthoring } from './workspace-authoring/index.ts'
import { createCurrentWorkspace } from './workspace-current.ts'
import { createProjectCredentialService, type GitCredential } from './credentials.ts'
import { createWorkspaceGit } from './workspace-git.ts'
import { extractBusinessAttachment } from './business-documents.mjs'
import type { WorkspaceAuthoringMutation, WorkspaceAuthoringOverview, WorkspaceMaterialContent, WorkspaceRepositorySource, WorkspaceRepositoryRefKind, WorkspaceResolvedRepository } from '../../autoops/contracts/workspace-authoring.ts'
import type { WorkspaceTask } from '../../autoops/contracts/workspaces.ts'

type Authoring = ReturnType<typeof createWorkspaceAuthoring>
type Credentials = ReturnType<typeof createProjectCredentialService>
type Git = ReturnType<typeof createWorkspaceGit>
function fail(status: number, code: string, message: string): never { throw new WorkspaceError(status, code, message) }
const configurationHash = (source: WorkspaceRepositorySource) => createHash('sha256').update(JSON.stringify(source)).digest('hex')
const active = (task: WorkspaceTask) => task.status === 'queued' || task.status === 'running'

export function createWorkspaceManagement({ access, store, authoring, credentials, git, extractAttachment = extractBusinessAttachment }: {
  access: AutoOpsAccess; store: WorkspaceStore; authoring: Authoring; credentials: Credentials; git: Git
  extractAttachment?: typeof extractBusinessAttachment
}) {
  const currentWorkspace = createCurrentWorkspace({ access, store, authoring, credentials, git })
  let accepting = true
  let closing: Promise<void> | undefined
  const preparations = new Map<string, { revision: number; work: Promise<WorkspaceTask>; controller: AbortController }>()
  const previews = new Set<ReturnType<typeof extractBusinessAttachment>>()
  const captureReleases = new Set<Promise<void>>()
  const repositoryQueries = new Set<{ controller: AbortController; work: Promise<unknown> }>()
  const permitRead = (projectId: string, actorId: string) => access.requireWorkspaceReader(actorId, projectId)
  const permitWrite = (projectId: string, actorId: string) => {
    if (!accepting) fail(503, 'WORKSPACE_STOPPING', '工作区正在停止接单，请稍后重试')
    return access.requireWorkspaceActor(actorId, projectId)
  }
  const published = (projectId: string) => store.overview(projectId).internalVersions.filter(version => version.status === 'published')
  async function repositoryQuery<T>(projectId: string, sourceId: string, actorId: string, operation: (source: WorkspaceRepositorySource, secret: GitCredential | undefined, signal: AbortSignal, check: () => void) => Promise<T>): Promise<T> {
    if (!accepting) fail(503, 'WORKSPACE_STOPPING', '工作区正在停止接单，请稍后重试')
    access.requireProjectActionForActor(actorId, projectId, 'repository.read')
    if (repositoryQueries.size + preparations.size >= 2) fail(429, 'WORKSPACE_GIT_QUERY_BUSY', '已有源码正在查询，请稍后重试')
    const source = authoring.overview(projectId, actorId).sources.find(entry => entry.id === sourceId)
    if (!source) fail(404, 'WORKSPACE_SOURCE_NOT_FOUND', '当前项目中不存在此源码来源')
    const hash = configurationHash(source), reference = source.credentialId ? credentials.referenceVersion(actorId, projectId, source.credentialId) : undefined
    const controller = new AbortController()
    const check = () => {
      access.requireProjectActionForActor(actorId, projectId, 'repository.read')
      const current = authoring.overview(projectId, actorId).sources.find(entry => entry.id === sourceId)
      if (!current || configurationHash(current) !== hash) fail(409, 'WORKSPACE_SOURCE_CHANGED', '源码来源已经修改，请刷新后重新选择')
      if (reference) {
        const currentCredential = credentials.referenceVersion(actorId, projectId, reference.credentialId)
        if (currentCredential.version !== reference.version) fail(409, 'CREDENTIAL_REVISION_CONFLICT', '源码凭证已经更新，请重新查询')
      }
    }
    const work = Promise.resolve().then(async () => {
      check()
      const run = (secret?: GitCredential) => operation(source, secret, controller.signal, check)
      const result = reference ? await credentials.withCredential(actorId, projectId, reference, run) : await run()
      check()
      return result
    })
    const query = { controller, work }; repositoryQueries.add(query)
    try { return await work } finally { repositoryQueries.delete(query) }
  }
  function repositoryRefs(projectId: string, sourceId: string, actorId: string) {
    return repositoryQuery(projectId, sourceId, actorId, (source, secret, signal, check) => git.repositoryRefs(source, secret, signal, check))
  }
  function repositoryHistory(projectId: string, sourceId: string, selection: { refKind: WorkspaceRepositoryRefKind; ref: string }, actorId: string) {
    return repositoryQuery(projectId, sourceId, actorId, (source, secret, signal, check) => git.repositoryHistory(git.validateRepositorySource({ ...source, refKind: selection.refKind, ref: selection.ref }), secret, signal, check))
  }
  function sourceViews(projectId: string, sources: WorkspaceRepositorySource[], currentActor: string) {
    const versions = published(projectId)
    return sources.map(source => {
      const hash = configurationHash(source)
      const synced = authoring.syncRecords?.(projectId, currentActor)?.find(record => record.sourceId === source.id && record.configurationHash === hash)
      const version = synced?.versionId ? store.getVersion(projectId, synced.versionId) : versions.find(version => version.source.repositories.some(repository => repository.sourceId === source.id && repository.configurationHash === hash))
      const repository = version?.source.repositories.find(repository => repository.sourceId === source.id && repository.configurationHash === hash)
      return { source, version, repository }
    })
  }
  function overview(projectId: string, actorId: string): WorkspaceAuthoringOverview {
    permitRead(projectId, actorId)
    const current = authoring.overview(projectId, actorId)
    const records = authoring.syncRecords?.(projectId, actorId) ?? []
    const latest = published(projectId).find(version => version.source.authoringRevision !== undefined)
    return { ...current, ...(latest ? { publishedRevision: latest.source.authoringRevision! } : {}), hasUnpublishedChanges: latest?.source.authoringRevision !== current.revision, sourceStatus: sourceViews(projectId, current.sources, actorId).map(({ source, version, repository }) => {
      const record = records.find(value => value.sourceId === source.id && value.configurationHash === configurationHash(source))
      return { sourceId: source.id, status: record?.status ?? (version && repository ? 'synced' : 'unsynced'),
        ...(version && repository ? { versionId: version.id, commit: repository.commit, createdAt: version.createdAt } : {}),
        ...(record ? { updatedAt: record.updatedAt, requestId: record.requestId, ...(record.error ? { error: record.error } : {}) } : {}) }
    }) }

  }
  function currentEntries(projectId: string, actorId: string) {
    const current = overview(projectId, actorId)
    const entries = new Map(current.entries.map(entry => [entry.path, { path: entry.path, name: entry.name, kind: entry.kind, size: entry.size }]))
    const addParents = (path: string) => {
      const parts = path.split('/')
      for (let index = 1; index < parts.length; index++) {
        const directory = parts.slice(0, index).join('/')
        entries.set(directory, { path: directory, name: parts[index - 1]!, kind: 'directory', size: 0 })
      }
    }
    for (const { source, version } of sourceViews(projectId, current.sources, actorId)) {
      if (!version) continue
      for (const file of store.files(projectId, version.id)) {
        if (!file.path.startsWith(source.mountPath + '/')) continue
        entries.set(file.path, { path: file.path, name: file.name, kind: 'file', size: file.size })
        addParents(file.path)
      }
    }
    return [...entries.values()].sort((a, b) => a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'directory' ? -1 : 1)
  }
  function sourceFile(projectId: string, path: string, actorId: string) {
    const current = overview(projectId, actorId)
    const source = current.sources.find(source => path.startsWith(source.mountPath + '/'))
    if (!source) return undefined
    const match = sourceViews(projectId, [source], actorId)[0]
    if (!match?.version) fail(404, 'WORKSPACE_SOURCE_UNSYNCED', '此源码来源尚未生成匹配当前配置的版本')
    const file = store.versionFile(projectId, match.version.id, path)
    const sha256 = createHash('sha256').update(file.bytes).digest('hex')
    return { ...file, path, revision: match.version.id, size: file.bytes.byteLength, sha256 }
  }
  function currentFile(projectId: string, path: string, actorId: string, revision?: string) {
    permitRead(projectId, actorId)
    const file = sourceFile(projectId, path, actorId) ?? authoring.readFile(projectId, path, actorId)
    if (revision && file.revision !== revision) fail(409, 'WORKSPACE_CONTENT_CONFLICT', '资料已经更新，请重新打开预览')
    return file
  }
  async function currentContent(projectId: string, path: string, actorId: string, revision?: string): Promise<WorkspaceMaterialContent> {
    permitRead(projectId, actorId)
    const file = sourceFile(projectId, path, actorId)
    if (!file) {
      const content = authoring.readContent(projectId, path, actorId)
      if (revision && content.revision !== revision) fail(409, 'WORKSPACE_CONTENT_CONFLICT', '资料已经更新，请重新打开预览')
      return content
    }
    if (revision && file.revision !== revision) fail(409, 'WORKSPACE_CONTENT_CONFLICT', '来源版本已经改变，请重新打开预览')
    if (!accepting) fail(503, 'WORKSPACE_STOPPING', '工作区正在停止接单，请稍后重试')
    if (previews.size >= 2) fail(429, 'WORKSPACE_PREVIEW_BUSY', '已有文件正在提取正文，请稍后重试；原件仍可下载')
    const extraction = Promise.resolve().then(() => {
      permitRead(projectId, actorId)
      return extractAttachment({ id: path, name: file.name, mime: file.mime, bytes: file.bytes })
    })
    previews.add(extraction)
    let extracted: Awaited<ReturnType<typeof extractBusinessAttachment>>
    try { extracted = await extraction } finally { previews.delete(extraction) }
    permitRead(projectId, actorId)
    return { path, revision: file.revision, mime: file.mime, size: file.size, sha256: file.sha256,
      extraction: { status: typeof extracted.content === 'string' ? 'ready' : 'unavailable', contentHash: file.sha256, parserVersion: 'business-documents-v1',
        ...(extracted.extraction?.code ? { code: extracted.extraction.code } : {}), ...(extracted.extraction?.message ? { message: extracted.extraction.message } : {}) },
      ...(typeof extracted.content === 'string' ? { contents: extracted.content } : {}) }
  }
  function receipt(projectId: string, requestId: string, actorId: string) {
    permitWrite(projectId, actorId)
    const task = ['packages', 'external', 'sync', 'snapshot', 'input'].map(type => store.taskForRequest(projectId, type, requestId, actorId)).find(Boolean)
    if (task?.type === 'packages' && task.status === 'failed') {
      try { currentWorkspace.reconcileFailedDeploymentCapture(projectId, requestId, actorId) }
      catch { /* 清理未知不改写原失败收据，捕获继续保留供后续核对。 */ }
    }
    let capture = authoring.captureByRequest(projectId, requestId, actorId)
    if (task?.type === 'snapshot' && !active(task) && capture?.status === 'active') capture = authoring.releaseCapture(projectId, capture.id, actorId)
    const externalPreparation = capture ? undefined : currentWorkspace.externalPreparationReceipt(projectId, requestId, actorId)
    return { result: authoring.receipt(projectId, requestId, actorId), ...(task ? { task } : {}),
      ...(capture ? { capture: { id: capture.id, resolution: capture.resolution, ...(capture.resolutionError ? { resolutionError: capture.resolutionError } : {}) } } : externalPreparation ? { capture: externalPreparation } : {}) }
  }
  function releaseAfterTask(projectId: string, captureId: string, requestId: string, actorId: string) {
    // 物化结束后仍须校验和持久化版本；只在原任务收据确认为终态后释放原件。
    const release = store.whenIdle().then(() => {
      const task = store.taskForRequest(projectId, 'snapshot', requestId, actorId)
      if (task && !active(task)) authoring.releaseCapture(projectId, captureId, actorId)
    }).catch(() => { /* 授权、持久化或清理失败时保留原件保护，由原请求核对后释放。 */ })
    captureReleases.add(release)
    void release.finally(() => captureReleases.delete(release))
  }
  async function prepare(projectId: string, input: WorkspaceAuthoringMutation, actorId: string, signal: AbortSignal) {
    let captured = authoring.capture(projectId, input.expectedRevision, actorId, input.requestId)
    const previous = store.taskForRequest(projectId, 'snapshot', input.requestId, actorId)
    if (previous) { releaseAfterTask(projectId, captured.id, input.requestId, actorId); return previous }
    if (captured.resolution === 'failed') fail(422, captured.resolutionError?.code ?? 'WORKSPACE_SOURCE_RESOLUTION_FAILED', captured.resolutionError?.message ?? '来源解析失败，请修改后重新生成')
    if (captured.status !== 'active') fail(409, 'WORKSPACE_CAPTURE_RELEASED', '此固定输入已经结束，请核对原任务')
    if (captured.resolution === 'pending') {
      try {
        const resolved: WorkspaceResolvedRepository[] = []
        for (const source of captured.sources) {
          permitWrite(projectId, actorId)
          const reference = source.credentialId ? credentials.referenceVersion(actorId, projectId, source.credentialId) : undefined
          const resolveRef = (secret?: GitCredential) => git.resolveRepositoryRef(source, secret, signal)
          const value = reference ? await credentials.withCredential(actorId, projectId, reference, resolveRef) : await resolveRef()
          resolved.push({ ...value, ...(reference ? { credentialVersion: reference } : {}) })
        }
        captured = authoring.freezeCaptureRepositories(projectId, captured.id, resolved, actorId)
      } catch (cause) {
        const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(cause.code) ? cause.code : 'WORKSPACE_SOURCE_RESOLUTION_FAILED'
        try { authoring.failCaptureResolution(projectId, captured.id, { code, message: '来源解析失败' }, actorId); authoring.releaseCapture(projectId, captured.id, actorId) } catch { /* 撤权或关闭后保留原始输入保护，供之后核对。 */ }
        throw cause
      }
    }
    permitWrite(projectId, actorId)
    const frozen = captured
    const repositories = frozen.sources.map(source => {
      const resolved = frozen.resolvedRepositories?.find(entry => entry.sourceId === source.id)
      if (!resolved) return fail(409, 'WORKSPACE_SOURCE_RESOLUTION_MISSING', '来源提交未固定')
      return { path: source.mountPath, commit: resolved.commit, sourceId: source.id, configurationHash: configurationHash(source) }
    })
    const task = store.startSnapshot(projectId, { requestId: input.requestId, captureId: frozen.id, source: {
      repositories, authoringRevision: frozen.revision, captureId: frozen.id,
      documents: frozen.files.map(file => ({ path: file.path, sha256: file.sha256, revision: file.revision })),
    } }, async ({ root, signal: taskSignal, progress, checkBudget }) => {
      for (const directory of frozen.directories) await mkdir(join(root, directory), { recursive: true, mode: 0o700 })
      for (const file of frozen.files) {
        taskSignal.throwIfAborted()
        const original = authoring.readCapturedFile(projectId, frozen.id, file.path, actorId)
        await mkdir(dirname(join(root, file.path)), { recursive: true, mode: 0o700 })
        await writeFile(join(root, file.path), original.bytes, { mode: 0o600, flag: 'wx' })
        checkBudget()
      }
      for (const source of frozen.sources) {
        taskSignal.throwIfAborted()
        access.requireWorkspaceActor(actorId, projectId)
        const resolved = frozen.resolvedRepositories!.find(entry => entry.sourceId === source.id)!
        progress('fetching', `正在获取源码：${source.name}`)
        const target = join(root, source.mountPath)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        const fetch = (secret?: GitCredential) => git.fetchRepositoryAt(source, resolved.commit, target, secret, taskSignal, checkBudget)
        if (resolved.credentialVersion) await credentials.withCredential(actorId, projectId, resolved.credentialVersion, fetch)
        else await fetch()
      }
      access.requireWorkspaceActor(actorId, projectId)
    }, actorId)
    releaseAfterTask(projectId, frozen.id, input.requestId, actorId)
    return task
  }
  function generate(projectId: string, input: WorkspaceAuthoringMutation, actorId: string): Promise<WorkspaceTask> {
    permitWrite(projectId, actorId)
    const key = JSON.stringify([projectId, actorId, input.requestId])
    const existing = preparations.get(key)
    if (existing) {
      if (existing.revision !== input.expectedRevision) fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原请求已经用于另一项资料修订')
      return existing.work
    }
    if (preparations.size + repositoryQueries.size >= 2) fail(429, 'WORKSPACE_PREPARATION_BUSY', '已有来源正在核对，请稍后重试')
    const controller = new AbortController()
    const work = prepare(projectId, input, actorId, controller.signal)
    preparations.set(key, { revision: input.expectedRevision, work, controller })
    void work.finally(() => preparations.delete(key)).catch(() => {})
    return work
  }
  return {
    ...currentWorkspace, authoring, credentials, overview, currentFile, currentContent, receipt, generate, repositoryRefs, repositoryHistory,
    validateSource(source: WorkspaceRepositorySource) { return git.validateRepositorySource(source) },
    tree(projectId: string, directory: string, actorId: string) {
      const prefix = directory ? directory + '/' : ''
      const entries = currentEntries(projectId, actorId).filter(entry => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/'))
      return { entries: entries.slice(0, 500), truncated: entries.length > 500 }
    },
    search(projectId: string, query: string, actorId: string, limit = 200) {
      if (query.length > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail(400, 'WORKSPACE_SEARCH_INVALID', '搜索条件无效')
      const entries = currentEntries(projectId, actorId).filter(entry => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      return { entries: entries.slice(0, limit), truncated: entries.length > limit }
    },
    stopAccepting() { accepting = false; currentWorkspace.stopAccepting(); for (const preparation of preparations.values()) preparation.controller.abort(); for (const query of repositoryQueries) query.controller.abort() },
    close(): Promise<void> {
      this.stopAccepting()
      closing ??= (async () => {
        await Promise.allSettled([...preparations.values()].map(entry => entry.work))
        await Promise.allSettled([...repositoryQueries].map(entry => entry.work))
        await currentWorkspace.drain()
        const results = await Promise.allSettled([store.whenIdle(), ...previews])
        await Promise.allSettled([...captureReleases])
        credentials.stopAccepting()
        // 各所有者独立释放；一个解析或存储失败不能跳过其他模块的关闭。
        results.push(...await Promise.allSettled([
          Promise.resolve().then(() => authoring.close()),
          (async () => { try { await credentials.drain() } finally { credentials.close() } })(),
        ]))
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
        if (errors.length) throw new AggregateError(errors, '工作区资料资源关闭失败')
      })()
      return closing
    },
  }
}
export type WorkspaceManagement = ReturnType<typeof createWorkspaceManagement>

let configured: { dataDir: string; service: WorkspaceManagement } | undefined
let stopping = false
export function configuredWorkspaceManagement(access: AutoOpsAccess): WorkspaceManagement {
  if (stopping) fail(503, 'WORKSPACE_STOPPING', '工作区正在停止接单')
  const dataDir = process.env.AUTOOPS_T3_DATA_DIR && resolve(process.env.AUTOOPS_T3_DATA_DIR)
  if (!dataDir) fail(503, 'WORKSPACE_UNAVAILABLE', '工作区资料存储尚未配置')
  if (configured) {
    if (configured.dataDir !== dataDir) fail(503, 'WORKSPACE_CONFIGURATION_CHANGED', '数据目录变更需要重启服务')
    return configured.service
  }
  const store = configuredWorkspaceStore()
  if (!store) fail(503, 'WORKSPACE_UNAVAILABLE', '工作区版本存储尚未配置')
  const credentialDirectory = join(dataDir, 'project-credentials')
  mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 })
  const credentials = createProjectCredentialService({ databasePath: join(credentialDirectory, 'state.sqlite'),
    keyPath: process.env.AUTOOPS_WORKSPACE_CREDENTIAL_KEY_FILE ?? join(credentialDirectory, 'master.key'), initializeKeyIfNew: !process.env.AUTOOPS_WORKSPACE_CREDENTIAL_KEY_FILE,
    authorize: (actor, project, action) => { access.requireCredentialActor(actor, project, action) },
  })
  try {
    const git = createWorkspaceGit({ allowedOrigins: (process.env.AUTOOPS_WORKSPACE_GIT_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean) })
    const authoring = createWorkspaceAuthoring({ dataDir, authorize: (actor, project, action) => action === 'read' ? access.requireWorkspaceReader(actor, project) : action === 'external-read' ? access.requireWorkspaceInputReader(actor, project, 'external') : action === 'source-manage' ? access.requireProjectActionForActor(actor, project, 'repository.manage') : action === 'source-generate' ? access.requireProjectActionForActor(actor, project, 'source.generate') : access.requireWorkspaceActor(actor, project) })
    configured = { dataDir, service: createWorkspaceManagement({ access, store, authoring, credentials, git }) }
    return configured.service
  } catch (error) { credentials.close(); throw error }
}
export function stopConfiguredWorkspaceManagement() { stopping = true; configured?.service.stopAccepting() }
export async function closeConfiguredWorkspaceManagement() { stopConfiguredWorkspaceManagement(); await configured?.service.close() }
