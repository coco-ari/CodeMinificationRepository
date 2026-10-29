// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off -- 当前资料在 Node 边界编排队列、原件和固定源码；收尾故障只记录无敏感内容的固定诊断。
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AutoOpsAccess } from './access.mjs'
import { WorkspaceError, type WorkspaceStore } from './workspaces.mjs'
import type { createWorkspaceAuthoring } from './workspace-authoring/index.ts'
import type { createProjectCredentialService, GitCredential } from './credentials.ts'
import type { createWorkspaceGit } from './workspace-git.ts'
import { extractBusinessAttachment } from './business-documents.mjs'
import type {
  WorkspaceAuthoringCapture,
  WorkspaceAuthoringMutation,
  WorkspaceDeploymentSourceInput,
  WorkspaceDeploymentSourceCapture,
  WorkspaceDeploymentSourceMaintenanceCandidate,
  WorkspaceInputCapture,
  WorkspaceInputRepository,
  WorkspaceMaterialContent,
  WorkspaceCapturedFile,
  WorkspaceRepositorySource,
  WorkspaceSourceSyncRecord,
  WorkspaceInputFileReference,
} from '../../autoops/contracts/workspace-authoring.ts'
import type { WorkspaceTask } from '../../autoops/contracts/workspaces.ts'
import { decodeContract } from '../../autoops/contracts/index.ts'
import { DeploymentRepositorySelection } from '../../autoops/contracts/project-repositories.ts'

type Authoring = ReturnType<typeof createWorkspaceAuthoring>
type Credentials = ReturnType<typeof createProjectCredentialService>
type Git = ReturnType<typeof createWorkspaceGit>
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()
function fail(status: number, code: string, message: string): never {
  throw new WorkspaceError(status, code, message)
}
const unavailableGitCodes = new Set([
  'WORKSPACE_GIT_FAILED',
  'WORKSPACE_GIT_START_FAILED',
  'WORKSPACE_GIT_DNS_FAILED',
  'WORKSPACE_GIT_TIMEOUT',
  'WORKSPACE_GIT_REF_NOT_FOUND',
  'WORKSPACE_GIT_OUTPUT_LIMIT',
])
function sourceFailureCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}
const safePath = (value: string) =>
  typeof value === 'string' &&
  value.length <= 800 &&
  (value === '.' ||
    (!/[\\\x00-\x1f:\x7f]/.test(value) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..')))

export function createCurrentWorkspace({
  access,
  store,
  authoring,
  credentials,
  git,
}: {
  access: AutoOpsAccess
  store: WorkspaceStore
  authoring: Authoring
  credentials: Credentials
  git: Git
}) {
  let stopping = false
  const works = new Map<
    string,
    { fingerprint: string; controller: AbortController; work: Promise<unknown> }
  >()
  const completions = new Set<Promise<unknown>>()
  const externalSettlements = new Set<string>()
  const preparationListeners = new Set<
    (value: { projectId: string; requestId: string; actorId: string }) => void
  >()
  function readPermission(
    project: string,
    actor: string,
    type: 'internal' | 'external' = 'internal',
  ) {
    access.requireWorkspaceInputReader(actor, project, type)
  }
  function ensureAccepting() {
    if (stopping) fail(503, 'WORKSPACE_STOPPING', '工作区正在停止接单')
  }
  function track<T>(
    project: string,
    request: string,
    actor: string,
    fingerprint: string,
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    ensureAccepting()
    const key = JSON.stringify([project, request, actor])
    const previous = works.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原请求已用于其他资料操作')
      return previous.work as Promise<T>
    }
    if (works.size >= 2) fail(429, 'WORKSPACE_PREPARATION_BUSY', '已有资料输入正在准备，请稍后重试')
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const work = Promise.resolve().then(() => {
      combined.throwIfAborted()
      return run(combined)
    })
    works.set(key, { fingerprint, controller, work })
    void work
      .finally(() => {
        works.delete(key)
        for (const listener of preparationListeners)
          try {
            listener({ projectId: project, requestId: request, actorId: actor })
          } catch {
            /* 通知不改变所属任务收据；接收方重新读取真实状态。 */
          }
      })
      .catch(() => {})
    return work
  }
  function syncState(
    project: string,
    captured: WorkspaceAuthoringCapture,
    actor: string,
    status: 'queued' | 'syncing' | 'synced' | 'failed',
    versionId?: string,
    failureCode?: string,
    origin: 'sync' | 'snapshot' = 'sync',
  ) {
    const configured = authoring.overview(project, actor).sources
    const updates: WorkspaceSourceSyncRecord[] = []
    for (const source of captured.sources) {
      if (!configured.some((value) => value.id === source.id && digest(value) === digest(source)))
        continue
      const previous = authoring
        .syncRecords(project, actor)
        .find((value) => value.sourceId === source.id)
      // 较早领取的任务不能把较新的请求状态覆盖回去。
      if (status !== 'queued' && previous?.requestId !== captured.requestId) continue
      const current =
        versionId && status === 'synced'
          ? {
              ...captured.resolvedRepositories!.find((value) => value.sourceId === source.id)!,
              source,
              versionId,
            }
          : previous?.versionId
            ? repositoryForRecord(project, source.id, previous)
            : undefined
      updates.push({
        sourceId: source.id,
        configurationHash: digest(source),
        requestId: captured.requestId,
        status,
        updatedAt: now(),
        ...(current
          ? {
              current,
              versionId: current.versionId,
              commit: current.commit,
              currentOrigin:
                versionId && status === 'synced' ? origin : (previous?.currentOrigin ?? 'sync'),
            }
          : {}),
        ...(status === 'failed'
          ? {
              error: {
                code:
                  failureCode &&
                  (unavailableGitCodes.has(failureCode) ||
                    failureCode === 'WORKSPACE_CURRENT_SOURCE_CONFLICT')
                    ? failureCode
                    : 'WORKSPACE_SYNC_FAILED',
                message:
                  failureCode === 'WORKSPACE_CURRENT_SOURCE_CONFLICT'
                    ? '当前源码实际目录重叠，请核对来源后完整更新工作区'
                    : '同步失败，请重试。',
              },
            }
          : {}),
      })
    }
    const applied = authoring.recordSyncBatch(project, updates, actor)
    for (const value of applied)
      if (value.status === 'synced' && value.versionId)
        store.retainVersion(project, value.versionId, `current:${value.sourceId}`)
  }
  async function resolveCapture(
    project: string,
    captured: WorkspaceAuthoringCapture,
    actor: string,
    signal: AbortSignal,
    updateCurrent: boolean,
  ) {
    // 释放原件保护不改变失败收据；原请求重读仍须返回最初的来源失败。
    if (captured.resolution === 'failed')
      fail(
        422,
        captured.resolutionError?.code ?? 'WORKSPACE_SOURCE_RESOLUTION_FAILED',
        captured.resolutionError?.message ?? '原来源解析失败，请核对原请求',
      )
    if (captured.status !== 'active')
      fail(410, 'WORKSPACE_CAPTURE_RELEASED', '原资料输入已经释放，请核对原请求')
    if (updateCurrent) syncState(project, captured, actor, 'queued')
    try {
      if (captured.resolution === 'pending') {
        const resolved = []
        for (const source of captured.sources) {
          signal.throwIfAborted()
          readPermission(project, actor)
          const reference = source.credentialId
            ? credentials.referenceVersion(actor, project, source.credentialId)
            : undefined
          const resolve = (secret?: GitCredential) =>
            git.resolveRepositoryRef(source, secret, signal)
          const value = reference
            ? await credentials.withCredential(actor, project, reference, resolve)
            : await resolve()
          signal.throwIfAborted()
          resolved.push({ ...value, ...(reference ? { credentialVersion: reference } : {}) })
        }
        captured = authoring.freezeCaptureRepositories(project, captured.id, resolved, actor)
      }
      readPermission(project, actor)
      return captured
    } catch (error) {
      if (updateCurrent) {
        try {
          syncState(project, captured, actor, 'failed', undefined, sourceFailureCode(error))
        } catch {}
      }
      if (captured.resolution === 'pending') {
        try {
          authoring.failCaptureResolution(
            project,
            captured.id,
            {
              code:
                sourceFailureCode(error) && unavailableGitCodes.has(sourceFailureCode(error)!)
                  ? sourceFailureCode(error)!
                  : 'WORKSPACE_SOURCE_RESOLUTION_FAILED',
              message: '源码解析失败',
            },
            actor,
          )
        } catch {}
      }
      throw error
    }
  }
  async function materializeCaptured(
    project: string,
    captured: WorkspaceAuthoringCapture,
    actor: string,
    {
      root,
      signal,
      progress,
      checkBudget,
    }: {
      root: string
      signal: AbortSignal
      progress: (stage: string, message: string) => void
      checkBudget: () => void
    },
  ) {
    for (const source of captured.sources) {
      signal.throwIfAborted()
      readPermission(project, actor)
      const resolved = captured.resolvedRepositories!.find((value) => value.sourceId === source.id)!
      progress('fetching', `正在同步源码：${source.name}`)
      const destination = join(root, source.mountPath)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const fetch = (secret?: GitCredential) =>
        git.fetchRepositoryAt(source, resolved.commit, destination, secret, signal, checkBudget)
      if (resolved.credentialVersion)
        await credentials.withCredential(actor, project, resolved.credentialVersion, fetch)
      else await fetch()
    }
    readPermission(project, actor)
  }
  function sourceTask(
    project: string,
    captured: WorkspaceAuthoringCapture,
    actor: string,
    type: 'sync' | 'input',
    purpose: 'source' | 'deployment' = 'source',
  ) {
    const repositories = captured.sources.map((source) => {
      const resolved = captured.resolvedRepositories!.find((value) => value.sourceId === source.id)!
      return {
        path: source.mountPath,
        commit: resolved.commit,
        sourceId: source.id,
        configurationHash: digest(source),
      }
    })
    const cacheKey = digest({ purpose, repositories })
    const task = store.startSnapshot(
      project,
      {
        requestId: captured.requestId,
        captureId: captured.id,
        taskType: type,
        cacheKey,
        cachePurpose: purpose,
        source: { repositories, captureId: captured.id },
      },
      (context) => materializeCaptured(project, captured, actor, context),
      actor,
    )
    return task
  }
  async function completedTask(
    project: string,
    request: string,
    actor: string,
    type: 'sync' | 'input' | 'snapshot',
    signal?: AbortSignal,
  ) {
    await store.whenIdle()
    signal?.throwIfAborted()
    readPermission(project, actor)
    const task = store.taskForRequest(project, type, request, actor)
    if (!task || task.status !== 'completed' || !task.versionId)
      fail(
        task?.status === 'interrupted' ? 499 : 422,
        task?.status === 'interrupted'
          ? 'WORKSPACE_GIT_ABORTED'
          : (task?.failureCode ?? 'WORKSPACE_SYNC_FAILED'),
        task?.error ?? '源码同步未完成，请核对原任务',
      )
    return task as WorkspaceTask & { versionId: string }
  }
  function repositories(
    captured: WorkspaceAuthoringCapture,
    versionId: string,
  ): WorkspaceInputRepository[] {
    return captured.sources.map((source) => ({
      ...captured.resolvedRepositories!.find((value) => value.sourceId === source.id)!,
      source,
      versionId,
    }))
  }
  function readInput(project: string, inputId: string, actor: string) {
    const value = authoring.readInput(project, inputId, actor)
    readPermission(project, actor, value.workspaceType)
    if (value.status !== 'active')
      fail(410, 'WORKSPACE_INPUT_RELEASED', '原资料已更新或清理，不能改读最新内容')
    return value
  }
  function readInputReference(project: string, inputId: string, owner: string, actor: string, workspaceType: 'internal' | 'external') {
    readPermission(project, actor, workspaceType)
    return authoring.readInputReference(project, inputId, owner, actor, workspaceType)
  }
  function externalFileReferences(project: string, versionId: string): WorkspaceInputFileReference[] | undefined {
    const version = store.getVersion(project, versionId)
    if (version.type !== 'external' || version.status !== 'published' || !version.sourceVersionId) return undefined
    const inputId = version.source.inputId ?? store.getVersion(project, version.sourceVersionId).source.inputId
    if (!inputId) return undefined
    const files = store.files(project, version.id)
    return authoring.publishedInputFileReferences(project, inputId, files.map(file => file.path))
      .map(reference => ({ ...reference, sha256: files.find(file => file.path === reference.path)!.sha256 }))
  }
  function mappedReferencePath(project: string, original: WorkspaceInputCapture, path: string, target: WorkspaceInputCapture) {
    if (original.workspaceType !== target.workspaceType) fail(404, 'WORKSPACE_REFERENCE_FILE_NOT_FOUND', '文件不属于此资料范围')
    if (original.workspaceType === 'external') {
      const reference = original.externalFileReferences?.find(file => file.path === path)
      if (!reference || !target.externalFileReferences) {
        // 旧输入只在两个已知固定版本的 manifest 仍能证明同一来源时读取，不查询最新指针。
        if (original.externalVersionId && target.externalVersionId) {
          let previous, fixed
          try {
            previous = store.getVersion(project, original.externalVersionId)
            fixed = store.getVersion(project, target.externalVersionId)
          } catch (error) { if (sourceFailureCode(error) !== 'WORKSPACE_NOT_FOUND') throw error }
          if (previous?.type === 'external' && fixed?.type === 'external' && previous.status === 'published' && fixed.status === 'published' &&
              (previous.id === fixed.id || (previous.sourceVersionId && previous.sourceVersionId === fixed.sourceVersionId)) &&
              store.files(project, previous.id).some(file => file.path === path) && store.files(project, fixed.id).some(file => file.path === path)) return path
        }
        fail(409, 'WORKSPACE_REFERENCE_IDENTITY_UNKNOWN', '原外部文件来源已无法核验，请从当前外部资料重新打开')
      }
      const selected = target.externalFileReferences.find(file => digest(file.identity) === digest(reference.identity))
      if (!selected) fail(410, target.externalFileReferences.some(file => file.path === path) ? 'WORKSPACE_REFERENCE_FILE_REPLACED' : 'WORKSPACE_REFERENCE_FILE_REMOVED', '原外部文件已删除、改名或替换，请从当前资料重新打开')
      return selected.path
    }
    const uploaded = original.files.find(file => file.path === path)
    if (uploaded) {
      const selected = target.files.find(file => file.id === uploaded.id)
      if (!selected) fail(410, target.files.some(file => file.path === path) ? 'WORKSPACE_REFERENCE_FILE_REPLACED' : 'WORKSPACE_REFERENCE_FILE_REMOVED', '原文件已删除或替换，请从当前资料重新打开')
      return selected.path
    }
    const repository = original.repositories.find(value => value.sourceId === value.source.id && path.startsWith(value.source.mountPath + '/'))
    if (!repository) fail(409, 'WORKSPACE_REFERENCE_IDENTITY_UNKNOWN', '原文件来源无法核验，请从当前资料重新打开')
    const selected = target.repositories.find(value => value.sourceId === repository.sourceId)
    if (!selected) fail(410, 'WORKSPACE_REFERENCE_SOURCE_REMOVED', '原仓库已不在资料输入中')
    if (new URL(selected.source.url).toString() !== new URL(repository.source.url).toString() || (selected.source.sourcePath ?? '') !== (repository.source.sourcePath ?? ''))
      fail(409, 'WORKSPACE_REFERENCE_SOURCE_CHANGED', '仓库来源已替换，不能按同名文件打开')
    return selected.source.mountPath + '/' + path.slice(repository.source.mountPath.length + 1)
  }
  function fixedInputFileReference(project: string, originalInputId: string, originalPath: string, originalOwner: string, inputId: string, inputOwner: string, actor: string, workspaceType: 'internal' | 'external') {
    const original = readInputReference(project, originalInputId, originalOwner, actor, workspaceType)
    const fixed = readInput(project, inputId, inputOwner)
    const path = mappedReferencePath(project, original, originalPath, fixed)
    const file = inputFiles(project, inputId, inputOwner).find(file => file.path === path)
    if (!file) fail(410, 'WORKSPACE_REFERENCE_FILE_REMOVED', '本轮固定输入中没有此文件，可能已删除或改名')
    readPermission(project, actor, workspaceType)
    return { path, file, capturedAt: fixed.createdAt }
  }
  function resolveInputFileReference(project: string, inputId: string, path: string, owner: string, actor = owner, workspaceType?: 'internal' | 'external') {
    ensureAccepting()
    if (!safePath(path) || path === '.') fail(400, 'WORKSPACE_PATH_INVALID', '资料文件路径无效')
    // 仅普通预览使用已释放输入的身份元数据；固定输入读取继续由 readInput 拒绝。
    const input = workspaceType ? readInputReference(project, inputId, owner, actor, workspaceType) : authoring.readInput(project, inputId, owner)
    readPermission(project, actor, input.workspaceType)
    const result = (file: { bytes: Uint8Array; name: string; mime: string; revision: string; sha256: string }, currentPath: string, changed: boolean) => ({
      workspaceType: input.workspaceType, mode: input.status === 'active' ? 'original' as const : 'current' as const,
      currentPath, revision: file.revision, sha256: file.sha256, changed, file,
    })
    if (input.status === 'active') return result(readInputFile(project, inputId, path, owner), path, false)
    if (input.workspaceType === 'external') {
      const current = store.overview(project).externalVersions.filter(value => value.status === 'published')
        .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt))[0]
      if (input.externalFileReferences && current) {
        const references = externalFileReferences(project, current.id)
        if (!references) fail(409, 'WORKSPACE_REFERENCE_IDENTITY_UNKNOWN', '当前外部文件来源已无法核验，请从当前外部资料重新打开')
        const currentPath = mappedReferencePath(project, input, path, { ...input, externalVersionId: current.id, externalFileReferences: references })
        const file = store.versionFile(project, current.id, currentPath)
        const hash = createHash('sha256').update(file.bytes).digest('hex')
        return result({ ...file, revision: current.id, sha256: hash }, currentPath,
          input.externalVersionId !== current.id || input.externalFileReferences.find(reference => reference.path === path)?.sha256 !== hash || currentPath !== path)
      }
      let original
      try { original = input.externalVersionId ? store.getVersion(project, input.externalVersionId) : undefined }
      catch (error) { if (sourceFailureCode(error) !== 'WORKSPACE_NOT_FOUND') throw error }
      if (!original || !current || original.type !== 'external' ||
          (current.id !== original.id && (!original.sourceVersionId || current.sourceVersionId !== original.sourceVersionId)))
        fail(409, 'WORKSPACE_REFERENCE_IDENTITY_UNKNOWN', '原外部文件来源已无法核验，请从当前外部资料重新打开')
      const previous = store.files(project, original.id).find(file => file.path === path)
      if (!previous) fail(404, 'WORKSPACE_REFERENCE_FILE_NOT_FOUND', '原输入中没有此普通文件')
      let file
      try { file = store.versionFile(project, current.id, path) }
      catch (error) { if (error && typeof error === 'object' && 'status' in error && error.status === 404) fail(410, 'WORKSPACE_REFERENCE_FILE_REMOVED', '当前资料已无此文件，可能已删除或改名'); throw error }
      const hash = createHash('sha256').update(file.bytes).digest('hex')
      return result({ ...file, revision: current.id, sha256: hash }, path, current.id !== original.id || previous.sha256 !== hash)
    }
    const uploaded = input.files.find(file => file.path === path)
    if (uploaded) {
      const entries = authoring.overview(project, actor).entries
      const current = entries.find(file => file.id === uploaded.id && file.kind === 'file')
      if (!current) fail(410, entries.some(file => file.path === path) ? 'WORKSPACE_REFERENCE_FILE_REPLACED' : 'WORKSPACE_REFERENCE_FILE_REMOVED', '原文件已删除或替换，请从当前资料重新打开')
      const file = authoring.readFile(project, current.path, actor)
      return result({ ...file, sha256: file.sha256! }, current.path, file.revision !== uploaded.revision || file.sha256 !== uploaded.sha256 || current.path !== path)
    }
    const original = input.repositories.find(repository => path.startsWith(repository.source.mountPath + '/'))
    if (!original || original.sourceId !== original.source.id) fail(409, 'WORKSPACE_REFERENCE_IDENTITY_UNKNOWN', '原文件来源无法核验，请从当前资料重新打开')
    const current = availableRepositories(project, authoring.overview(project, actor).sources, actor).find(repository => repository.sourceId === original.sourceId)
    if (!current) fail(410, 'WORKSPACE_REFERENCE_SOURCE_REMOVED', '原仓库已不在当前资料中，请从工作区重新选择')
    if (new URL(current.source.url).toString() !== new URL(original.source.url).toString() || (current.source.sourcePath ?? '') !== (original.source.sourcePath ?? ''))
      fail(409, 'WORKSPACE_REFERENCE_SOURCE_CHANGED', '仓库来源已替换，不能按同名文件打开')
    const currentPath = current.source.mountPath + '/' + path.slice(original.source.mountPath.length + 1)
    let file
    try { file = store.versionFile(project, current.versionId, currentPath) }
    catch (error) { if (error && typeof error === 'object' && 'status' in error && error.status === 404) fail(410, 'WORKSPACE_REFERENCE_FILE_REMOVED', '当前仓库已无此文件，可能已删除或改名'); throw error }
    return result({ ...file, revision: current.versionId, sha256: createHash('sha256').update(file.bytes).digest('hex') }, currentPath,
      current.versionId !== original.versionId || current.commit !== original.commit || currentPath !== path)
  }
  function repositoryForRecord(
    project: string,
    sourceId: string,
    record: WorkspaceSourceSyncRecord,
  ): WorkspaceInputRepository {
    if (!record.versionId)
      return fail(409, 'WORKSPACE_CURRENT_SOURCE_MISSING', '当前源码尚未取得完整版本')
    const version = store.getVersion(project, record.versionId)
    const fixed = version.source.repositories.find((value) => value.sourceId === sourceId)
    if (version.status !== 'published' || !fixed)
      return fail(409, 'WORKSPACE_CURRENT_SOURCE_MISSING', '当前源码版本或来源身份不可核验')
    const original = record.current
      ? { source: record.current.source, resolved: record.current }
      : version.source.captureId
        ? authoring.capturedRepositoryMetadata(project, version.source.captureId, sourceId)
        : undefined
    if (
      !original ||
      digest(original.source) !== fixed.configurationHash ||
      original.source.mountPath !== fixed.path ||
      original.resolved.commit !== fixed.commit
    )
      return fail(409, 'WORKSPACE_CURRENT_SOURCE_MISSING', '当前源码与原同步身份不一致')
    const { source, resolved } = original
    return {
      sourceId,
      commit: resolved.commit,
      refKind: resolved.refKind,
      ref: resolved.ref,
      defaultRef: resolved.defaultRef,
      ...(resolved.credentialVersion ? { credentialVersion: resolved.credentialVersion } : {}),
      source,
      versionId: version.id,
    }
  }
  function adoptExistingCurrent(project: string) {
    const pending = authoring.currentAdoptionSources(project)
    if (!pending.length) return
    // 严格沿升级前sourceViews的published顺序和身份规则，只在接管时选择一次。
    const published = store
      .overview(project)
      .internalVersions.filter((value) => value.status === 'published')
    const references: Array<{ versionId: string; reference: string }> = []
    const selections = pending.map(({ source, record: stored }) => {
      const configurationHash = digest(source)
      const record = stored?.configurationHash === configurationHash ? stored : undefined
      const legacy = record?.versionId
        ? undefined
        : published.find((version) =>
            version.source.repositories.some(
              (repository) =>
                repository.sourceId === source.id &&
                repository.configurationHash === configurationHash,
            ),
          )
      const fixed = record?.versionId
        ? record
        : legacy
          ? {
              sourceId: source.id,
              configurationHash,
              requestId: `adopt:${legacy.id}`,
              status: 'synced' as const,
              updatedAt: legacy.createdAt,
              versionId: legacy.id,
            }
          : undefined
      const current = fixed ? repositoryForRecord(project, source.id, fixed) : undefined
      if (current) {
        const reference = `adoption:${digest([project, source.id, current.versionId])}`
        store.retainVersion(project, current.versionId, reference)
        references.push({ versionId: current.versionId, reference })
      }
      return { sourceId: source.id, configurationHash, ...(current ? { current } : {}) }
    })
    const adopted = authoring.adoptCurrentSources(project, selections)
    for (const record of adopted)
      if (record.versionId) {
        const current = repositoryForRecord(project, record.sourceId, record)
        store.retainVersion(project, current.versionId, `current:${record.sourceId}`)
      }
    for (const reference of references) store.releaseVersion(project, reference.reference)
  }
  function availableRepositories(
    project: string,
    sources: WorkspaceRepositorySource[],
    actor: string,
  ): WorkspaceInputRepository[] {
    readPermission(project, actor)
    adoptExistingCurrent(project)
    const records = authoring.syncRecords(project, actor)
    return sources.flatMap((source) => {
      const record = records.find((value) => value.sourceId === source.id && value.versionId)
      if (!record?.versionId) return []
      // 待更新配置不替换有效当前指针；本地读取不重新取密或访问远端。
      return [repositoryForRecord(project, source.id, record)]
    })
  }
  function inputFiles(project: string, inputId: string, actor: string): WorkspaceCapturedFile[] {
    const input = readInput(project, inputId, actor)
    const files = new Map(input.files.map((file) => [file.path, file]))
    const versions = new Set(input.repositories.map((value) => value.versionId))
    if (input.externalVersionId) versions.add(input.externalVersionId)
    for (const version of versions)
      for (const file of store.files(project, version)) {
        if (
          !input.externalVersionId &&
          !input.repositories.some(
            (repository) =>
              repository.versionId === version &&
              file.path.startsWith(repository.source.mountPath + '/'),
          )
        )
          continue
        files.set(file.path, {
          path: file.path,
          id: `${version}:${file.path}`,
          revision: version,
          sha256: file.sha256,
          size: file.size,
          mime: file.mime,
          extraction: {
            status: 'pending',
            contentHash: file.sha256,
            parserVersion: 'business-documents-v1',
          },
        })
      }
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
  }
  function readInputFile(project: string, inputId: string, path: string, actor: string) {
    const input = readInput(project, inputId, actor)
    if (input.files.some((file) => file.path === path) && input.captureId)
      return authoring.readCapturedFile(project, input.captureId, path, actor)
    const file = inputFiles(project, inputId, actor).find((file) => file.path === path)
    if (
      !file &&
      input.sourceErrors?.some(
        (source) => path === source.mountPath || path.startsWith(source.mountPath + '/'),
      )
    )
      fail(
        503,
        'WORKSPACE_INPUT_SOURCE_UNAVAILABLE',
        '本轮未取得此仓库源码；上传资料仍可读取，请先在工作区更新',
      )
    if (!file) fail(404, 'WORKSPACE_MATERIAL_NOT_FOUND', '本轮资料输入中没有此文件')
    const result = store.versionFile(project, file.revision, path)
    return { ...result, revision: file.revision, sha256: file.sha256 }
  }
  function preparationReferences(
    value: Pick<WorkspaceInputCapture, 'requestId' | 'repositories' | 'externalVersionId'>,
    actor: string,
  ) {
    return [
      ...value.repositories.map((repository) => ({
        versionId: repository.versionId,
        reference: `preparation:${digest([actor, value.requestId, repository.sourceId, repository.versionId])}`,
      })),
      ...(value.externalVersionId
        ? [
            {
              versionId: value.externalVersionId,
              reference: `preparation:${digest([actor, value.requestId, value.externalVersionId])}`,
            },
          ]
        : []),
    ]
  }
  async function captureAgentInput(
    project: string,
    input: { requestId: string; workspaceType: 'internal' | 'external' },
    actor: string,
    signal?: AbortSignal,
    requireOriginal = false,
  ): Promise<WorkspaceInputCapture> {
    readPermission(project, actor, input.workspaceType)
    const previous = authoring.inputByRequest(project, input.requestId, actor, input.workspaceType)
    if (previous) return readInput(project, previous.id, actor)
    if (
      requireOriginal &&
      !works.has(JSON.stringify([project, input.requestId, actor])) &&
      !authoring.preparedInputByRequest(project, input.requestId, actor, input.workspaceType)
    )
      fail(
        409,
        'WORKSPACE_INPUT_ORIGINAL_UNAVAILABLE',
        '原任务资料选择未能固定，无法恢复原输入；请开始新一轮',
      )
    return track(
      project,
      input.requestId,
      actor,
      digest(input),
      async (currentSignal) => {
        let value = authoring.preparedInputByRequest(
          project,
          input.requestId,
          actor,
          input.workspaceType,
        )
        let candidateReferences: Array<{ versionId: string; reference: string }> = []
        if (!value) {
          if (input.workspaceType === 'external') {
            const version = store
              .overview(project)
              .externalVersions.filter((value) => value.status === 'published')
              .sort((a, b) =>
                (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt),
              )[0]
            if (!version)
              fail(409, 'WORKSPACE_EXTERNAL_UNAVAILABLE', '项目尚未发布可供外部访问的资料')
            candidateReferences = preparationReferences(
              { requestId: input.requestId, repositories: [], externalVersionId: version.id },
              actor,
            )
            for (const reference of candidateReferences)
              store.retainVersion(project, reference.versionId, reference.reference)
            const fileReferences = externalFileReferences(project, version.id)
            value = authoring.prepareInput(project, input.requestId, actor, {
              workspaceType: 'external',
              versionId: version.id,
              ...(fileReferences ? { fileReferences } : {}),
            })
          } else {
            const current = authoring.overview(project, actor)
            const available = availableRepositories(project, current.sources, actor)
            const records = authoring.syncRecords(project, actor)
            const sourceErrors = current.sources
              .filter((source) => !available.some((value) => value.sourceId === source.id))
              .map((source) => ({
                sourceId: source.id,
                name: source.name,
                mountPath: source.mountPath,
                code: 'WORKSPACE_SOURCE_UNSYNCED',
                message: '此仓库尚无完整当前资料，请先在工作区更新；上传资料仍可读取',
              }))
            const sourceWarnings = available.flatMap((repository) => {
              const configured = current.sources.find(
                (source) => source.id === repository.sourceId,
              )!
              const record = records.find((record) => record.sourceId === repository.sourceId)
              if (digest(configured) === digest(repository.source) && record?.status === 'synced')
                return []
              return [
                {
                  sourceId: repository.sourceId,
                  name: repository.source.name,
                  mountPath: repository.source.mountPath,
                  code:
                    digest(configured) !== digest(repository.source)
                      ? 'WORKSPACE_SOURCE_CONFIGURATION_PENDING'
                      : (record?.error?.code ?? 'WORKSPACE_SOURCE_UPDATE_PENDING'),
                  message: '当前读取上次已同步的来源与提交；待更新配置或失败更新尚未替换有效资料',
                },
              ]
            })
            candidateReferences = preparationReferences(
              { requestId: input.requestId, repositories: available },
              actor,
            )
            for (const reference of candidateReferences)
              store.retainVersion(project, reference.versionId, reference.reference)
            value = authoring.prepareInput(project, input.requestId, actor, {
              workspaceType: 'internal',
              revision: current.revision,
              repositories: available,
              sourceErrors,
              sourceWarnings,
            })
          }
        }
        // 准备收据先固定版本，重试不再读取最新指针；丢失原件时明确失败。
        if (value.status !== 'active')
          fail(410, 'WORKSPACE_INPUT_RELEASED', '原资料输入已确认结束，不能改读最新内容')
        currentSignal.throwIfAborted()
        readPermission(project, actor, value.workspaceType)
        if (value.externalVersionId)
          store.retainVersion(project, value.externalVersionId, `input:${value.id}`)
        for (const repository of value.repositories)
          store.retainVersion(
            project,
            repository.versionId,
            `input:${value.id}:${repository.sourceId}`,
          )
        const saved = authoring.saveInput(value, actor)
        for (const reference of [...candidateReferences, ...preparationReferences(value, actor)])
          store.releaseVersion(project, reference.reference)
        return saved
      },
      signal,
    )
  }
  async function sync(
    project: string,
    input: WorkspaceAuthoringMutation,
    actor: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceTask> {
    access.requireWorkspaceActor(actor, project)
    return track(
      project,
      input.requestId,
      actor,
      digest(input),
      async (currentSignal) => {
        let captured = authoring.captureByRequest(project, input.requestId, actor)
        const previous = store.taskForRequest(project, 'sync', input.requestId, actor)
        if (captured && captured.revision !== input.expectedRevision)
          fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原同步请求已经固定其他资料修订')
        if (previous) return previous
        captured ??= authoring.capture(project, input.expectedRevision, actor, input.requestId, {
          sources: authoring.overview(project, actor).sources,
          documents: false,
        })
        try {
          captured = await resolveCapture(project, captured, actor, currentSignal, true)
          currentSignal.throwIfAborted()
        } catch (error) {
          // 只有失败已持久化且原任务确实不存在时才能释放；收据或授权未知时继续保护。
          try {
            const originalTask = store.taskForRequest(project, 'sync', input.requestId, actor)
            const originalCapture = authoring.captureByRequest(project, input.requestId, actor)
            if (
              !originalTask &&
              originalCapture?.status === 'active' &&
              originalCapture.resolution === 'failed'
            )
              authoring.releaseCapture(project, originalCapture.id, actor)
          } catch {
            /* 收尾失败不覆盖原错误；原请求再次核对时继续尝试释放。 */
          }
          throw error
        }
        const task = sourceTask(project, captured, actor, 'sync')
        syncState(project, captured, actor, 'syncing')
        const fixed = captured
        const completion = completedTask(project, input.requestId, actor, 'sync')
          .then((value) => {
            syncState(project, fixed, actor, 'synced', value.versionId)
            store.releaseVersion(project, `task:${value.id}`)
          })
          .catch((error: unknown) => {
            try {
              syncState(project, fixed, actor, 'failed', undefined, sourceFailureCode(error))
            } catch {}
          })
          .finally(() => {
            try {
              authoring.releaseCapture(project, fixed.id, actor)
            } catch {}
            collectUnusedQuietly(project)
          })
        completions.add(completion)
        void completion.finally(() => completions.delete(completion))
        return task
      },
      signal,
    )
  }
  async function captureDeploymentSource(
    project: string,
    input: WorkspaceDeploymentSourceInput,
    actor: string,
    signal?: AbortSignal,
    buildCache?: (captured: WorkspaceAuthoringCapture) => Promise<string>,
  ): Promise<WorkspaceDeploymentSourceCapture> {
    access.requireProjectActionForActor(actor, project, 'source.generate')
    const fingerprint = digest(input)
    const previous = authoring.deploymentInput(project, input.requestId, fingerprint, actor)
    if (previous) return previous
    return track(
      project,
      input.requestId,
      actor,
      fingerprint,
      async (currentSignal) => {
        if (
          !Array.isArray(input.sources) ||
          !input.sources.length ||
          input.sources.length > 32 ||
          input.sources.some(
            (value) => !value || typeof value !== 'object' || Array.isArray(value),
          ) ||
          new Set(input.sources.map((value) => value.sourceId)).size !== input.sources.length
        )
          fail(400, 'WORKSPACE_DEPLOYMENT_SOURCES_INVALID', '请选择唯一的部署仓库来源')
        const current = authoring.repositories(project, actor)
        const sources = input.sources.map((selection) => {
          let usage
          try {
            usage = decodeContract(DeploymentRepositorySelection, selection)
          } catch {
            return fail(
              400,
              'WORKSPACE_DEPLOYMENT_SOURCES_INVALID',
              '请完整选择部署仓库的版本、挂载及子目录，不接受连接或凭证字段',
            )
          }
          const source = current.items.find((value) => value.id === usage.sourceId)
          if (!source) return fail(404, 'WORKSPACE_SOURCE_NOT_FOUND', '部署仓库来源不存在')
          const selected = {
            ...source,
            role: 'other' as const,
            refKind: usage.refKind,
            ref: usage.ref,
            mountPath: usage.mountPath.normalize('NFC'),
            ...(usage.sourcePath ? { sourcePath: usage.sourcePath.normalize('NFC') } : {}),
          }
          git.validateRepositorySource(selected)
          return selected
        })
        if (
          sources.some((source, index) =>
            sources
              .slice(index + 1)
              .some(
                (other) =>
                  source.mountPath === '.' ||
                  other.mountPath === '.' ||
                  source.mountPath === other.mountPath ||
                  source.mountPath.startsWith(other.mountPath + '/') ||
                  other.mountPath.startsWith(source.mountPath + '/'),
              ),
          )
        )
          fail(400, 'WORKSPACE_DEPLOYMENT_SOURCES_INVALID', '部署仓库挂载目录不能重叠')
        if (
          !Array.isArray(input.contexts) ||
          !input.contexts.length ||
          input.contexts.length > 2 ||
          new Set(input.contexts.map((value) => value.service)).size !== input.contexts.length
        )
          fail(400, 'WORKSPACE_BUILD_CONTEXT_INVALID', '每项服务必须指定唯一构建上下文')
        for (const context of input.contexts)
          if (
            !['frontend', 'backend'].includes(context.service) ||
            !safePath(context.root) ||
            !safePath(context.workingDirectory)
          )
            fail(400, 'WORKSPACE_BUILD_CONTEXT_INVALID', '构建上下文必须是所选源码中的相对目录')
        let captured = authoring.captureByRequest(project, input.requestId, actor)
        if (captured && digest(captured.sources) !== digest(sources))
          fail(409, 'WORKSPACE_REQUEST_CONFLICT', '部署原请求已经固定其他仓库选择')
        captured ??= authoring.capture(project, current.revision, actor, input.requestId, {
          sources,
          documents: false,
        })
        captured = await resolveCapture(project, captured, actor, currentSignal, false)
        let versionId: string
        if (buildCache) versionId = await buildCache(captured)
        else {
          sourceTask(project, captured, actor, 'input', 'deployment')
          versionId = (await completedTask(project, input.requestId, actor, 'input', currentSignal))
            .versionId
        }
        const value: WorkspaceDeploymentSourceCapture = {
          id: captured.id,
          projectId: project,
          requestId: input.requestId,
          versionId,
          repositories: repositories(captured, versionId),
          contexts: structuredClone(input.contexts),
        }
        store.retainVersion(project, versionId, `deployment:${value.id}`)
        const result = authoring.saveDeploymentInput(value, fingerprint, actor)
        authoring.releaseCapture(project, captured.id, actor)
        return result
      },
      signal,
    )
  }
  function reconcileFailedDeploymentCapture(
    project: string,
    requestId: string,
    actor: string,
  ): boolean {
    access.requireProjectActionForActor(actor, project, 'source.generate')
    const task = store.taskForRequest(project, 'packages', requestId, actor)
    if (task?.status !== 'failed') return false
    // 同一请求仍被其他资料操作使用时，失败部署不能代替其所有者归还捕获。
    if (
      works.has(JSON.stringify([project, requestId, actor])) ||
      ['external', 'sync', 'snapshot', 'input'].some((type) =>
        store.taskForRequest(project, type, requestId, actor),
      )
    )
      return false
    const captured = authoring.captureByRequest(project, requestId, actor)
    // 仅归还已知失败部署的源码捕获；未知解析、其他资料输入和文档引用继续受保护。
    if (
      !captured ||
      captured.status !== 'active' ||
      captured.resolution === 'pending' ||
      captured.files.length ||
      captured.directories.length ||
      authoring.inputByRequest(project, requestId, actor, 'internal') ||
      authoring.preparedInputByRequest(project, requestId, actor, 'internal')
    )
      return false
    authoring.releaseCapture(project, captured.id, actor)
    return true
  }
  function settleDeploymentCapture(project: string, requestId: string, actor: string) {
    const completion = store
      .whenIdle()
      .then(() => {
        reconcileFailedDeploymentCapture(project, requestId, actor)
      })
      .catch(() => {
        /* 原收据、授权或释放失败时保留保护，等待原请求再次核对。 */
      })
    completions.add(completion)
    void completion.finally(() => completions.delete(completion))
  }
  function startDeploymentPackages(
    project: string,
    input: WorkspaceDeploymentSourceInput,
    actor: string,
  ): WorkspaceTask {
    access.requireProjectActionForActor(actor, project, 'source.generate')
    ensureAccepting()
    const task = store.startSourcePackages(
      project,
      input,
      async ({ signal, progress, materializeCache }) => {
        progress('resolving', '正在固定所选部署仓库和构建上下文')
        const captured = await captureDeploymentSource(
          project,
          input,
          actor,
          signal,
          async (frozen) => {
            const repositoryRefs = frozen.sources.map((source) => ({
              path: source.mountPath,
              sourceId: source.id,
              configurationHash: digest(source),
              commit: frozen.resolvedRepositories!.find((value) => value.sourceId === source.id)!
                .commit,
            }))
            const version = await materializeCache(
              {
                cacheKey: digest({ purpose: 'deployment', repositories: repositoryRefs }),
                source: { repositories: repositoryRefs, documents: [], captureId: frozen.id },
              },
              (context) => materializeCaptured(project, frozen, actor, context),
            )
            return version.id
          },
        )
        return { sourceVersionId: captured.versionId, contexts: captured.contexts }
      },
      actor,
    )
    if (task.status === 'failed') {
      try {
        reconcileFailedDeploymentCapture(project, input.requestId, actor)
      } catch {
        /* 原失败结果仍有效，未知清理结果由下次原请求核对。 */
      }
    } else if (task.status === 'queued' || task.status === 'running') {
      settleDeploymentCapture(project, input.requestId, actor)
    }
    return task
  }
  function releaseObsoletePickerInputs(current: WorkspaceInputCapture, actor: string) {
    for (const record of authoring.obsoletePickerInputs(
      current.projectId,
      actor,
      current.workspaceType,
      current.requestId,
    )) {
      const value = record.value,
        snapshot = access.inputResourceSnapshot(value.projectId, value.id)
      if (
        snapshot.truncated ||
        snapshot.runs.length ||
        snapshot.references.length ||
        snapshot.claims.length ||
        snapshot.origins.length ||
        snapshot.nativeTurns.length
      )
        continue
      access.withInputResourceSnapshot(snapshot, () =>
        releaseInputResources({
          projectId: value.projectId,
          inputId: value.id,
          inputOwnerId: actor,
        }),
      )
    }
  }
  async function captureAvailableInput(
    project: string,
    input: { workspaceType: 'internal' | 'external' },
    actor: string,
  ): Promise<WorkspaceInputCapture> {
    readPermission(project, actor, input.workspaceType)
    if (input.workspaceType === 'external') {
      const version = store
        .overview(project)
        .externalVersions.filter((value) => value.status === 'published')
        .sort((a, b) =>
          (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt),
        )[0]
      if (!version) fail(409, 'WORKSPACE_EXTERNAL_UNAVAILABLE', '项目尚未发布可供外部访问的资料')
      const captured = await captureAgentInput(
        project,
        { workspaceType: 'external', requestId: `picker:${digest([actor, version.id])}` },
        actor,
      )
      releaseObsoletePickerInputs(captured, actor)
      return captured
    }
    const current = authoring.overview(project, actor)
    const available = availableRepositories(project, current.sources, actor)
    const records = authoring.syncRecords(project, actor)
    const requestId = `picker:${digest([actor, current.revision, available.map((value) => [value.sourceId, value.versionId]), records.map((value) => [value.sourceId, value.status, value.error?.code])])}`
    const captured = await captureAgentInput(
      project,
      { workspaceType: 'internal', requestId },
      actor,
    )
    releaseObsoletePickerInputs(captured, actor)
    return captured
  }
  async function generateCurrentExternal(
    project: string,
    input: {
      requestId: string
      rules?: Array<{ find: string; replace: string }>
      expectedRevision?: number
    },
    actor: string,
    signal?: AbortSignal,
  ) {
    access.requireProjectActionForActor(actor, project, 'workspace.external.publish')
    signal?.throwIfAborted()
    const previous = store.taskForRequest(project, 'external', input.requestId, actor)
    if (previous) {
      const prepared = store.taskForRequest(
        project,
        'snapshot',
        `external-source-${digest(input.requestId)}`,
        actor,
      )
      const captured = authoring.inputByRequest(
        project,
        `external-${digest(input.requestId)}`,
        actor,
        'internal',
      )
      if (!prepared?.versionId || !captured)
        fail(409, 'WORKSPACE_EXTERNAL_INPUT_MISSING', '原外部任务的固定输入不可用，请核对原收据')
      if (input.expectedRevision !== undefined && input.expectedRevision !== captured.revision)
        fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原外部请求已经固定其他资料修订')
      signal?.throwIfAborted()
      const task = store.startExternal(
        project,
        {
          requestId: input.requestId,
          sourceVersionId: prepared.versionId,
          ...(input.rules ? { rules: input.rules } : {}),
        },
        actor,
      )
      watchExternalInput(project, input.requestId, actor)
      return task
    }
    if (
      input.expectedRevision !== undefined &&
      authoring.overview(project, actor).revision !== input.expectedRevision
    )
      fail(409, 'WORKSPACE_REVISION_CONFLICT', '当前资料已修改，请重新核对')
    const captured = await captureAgentInput(
      project,
      { requestId: `external-${digest(input.requestId)}`, workspaceType: 'internal' },
      actor,
      signal,
    )
    if (input.expectedRevision !== undefined && input.expectedRevision !== captured.revision)
      fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原外部请求已经固定其他资料修订')
    if (captured.sourceErrors?.length)
      fail(
        503,
        'WORKSPACE_EXTERNAL_SOURCE_UNAVAILABLE',
        '当前源码未能完整同步，不能发布不完整的外部资料',
      )
    const sourceTaskId = `external-source-${digest(input.requestId)}`
    store.startSnapshot(
      project,
      {
        requestId: sourceTaskId,
        captureId: captured.id,
        cacheKey: digest({ purpose: 'external', inputId: captured.id }),
        cachePurpose: 'external-input',
        source: {
          repositories: captured.repositories.map((value) => ({
            path: value.source.mountPath,
            commit: value.commit,
          })),
          captureId: captured.id,
          inputId: captured.id,
          authoringRevision: captured.revision,
        },
      },
      async ({ root, signal, checkBudget }) => {
        for (const file of inputFiles(project, captured.id, actor)) {
          signal.throwIfAborted()
          readPermission(project, actor)
          const original = readInputFile(project, captured.id, file.path, actor)
          await mkdir(dirname(join(root, file.path)), { recursive: true, mode: 0o700 })
          await writeFile(join(root, file.path), original.bytes, { mode: 0o600, flag: 'wx' })
          checkBudget()
        }
      },
      actor,
    )
    const task = await completedTask(project, sourceTaskId, actor, 'snapshot', signal)
    signal?.throwIfAborted()
    const external = store.startExternal(
      project,
      {
        requestId: input.requestId,
        sourceVersionId: task.versionId,
        ...(input.rules ? { rules: input.rules } : {}),
      },
      actor,
    )
    watchExternalInput(project, input.requestId, actor)
    return external
  }
  function watchExternalInput(project: string, requestId: string, actor: string) {
    const key = JSON.stringify([project, requestId, actor])
    if (externalSettlements.has(key)) return
    externalSettlements.add(key)
    const completion = store
      .whenIdle()
      .then(() => settleExternalInput(project, requestId, actor))
      .catch(() => {
        console.warn('外部资料原输入收尾尚未核验，继续保留原件', { projectId: project })
      })
      .finally(() => {
        externalSettlements.delete(key)
      })
    completions.add(completion)
    void completion.finally(() => completions.delete(completion))
  }
  function settleExternalInput(project: string, requestId: string, actor: string): boolean {
    const task = store.taskForMaintenance(project, 'external', requestId, actor)
    const source = store.taskForMaintenance(
      project,
      'snapshot',
      `external-source-${digest(requestId)}`,
      actor,
    )
    const record = authoring.inputForRequestMaintenance(
      project,
      `external-${digest(requestId)}`,
      actor,
      'internal',
    )
    if (
      !task ||
      !source ||
      !record ||
      record.preparing ||
      !['completed', 'failed', 'interrupted'].includes(task.status) ||
      source.status !== 'completed' ||
      !source.versionId ||
      source.captureId !== record.value.id ||
      task.sourceVersionId !== source.versionId
    )
      return false
    if (record.value.status !== 'released') {
      const original = store.getVersion(project, source.versionId)
      if (
        original.cachePurpose !== 'external-input' ||
        original.source.captureId !== record.value.id
      )
        return false
      const snapshot = access.inputResourceSnapshot(project, record.value.id)
      if (
        snapshot.truncated ||
        snapshot.runs.length ||
        snapshot.references.length ||
        snapshot.claims.length ||
        snapshot.origins.length ||
        snapshot.nativeTurns.length
      )
        return false
      return access.withInputResourceSnapshot(snapshot, () =>
        releaseInputResources({
          projectId: project,
          inputId: record.value.id,
          inputOwnerId: actor,
        }),
      )
    }
    store.releaseVersion(project, `task:${source.id}`)
    collectUnusedCurrentVersionsForMaintenance(project)
    return true
  }
  function releaseInputResources(reference: {
    projectId: string
    inputId: string
    inputOwnerId: string
  }): boolean {
    const record = authoring.inputForMaintenance(
      reference.projectId,
      reference.inputId,
      reference.inputOwnerId,
    )
    if (!record) return false
    if (works.has(JSON.stringify([record.value.projectId, record.value.requestId, record.actorId])))
      return false
    const value = authoring.releaseInputForMaintenance(record)
    store.releaseVersion(value.projectId, `input:${value.id}`)
    for (const repository of value.repositories)
      store.releaseVersion(value.projectId, `input:${value.id}:${repository.sourceId}`)
    for (const preparation of preparationReferences(value, record.actorId))
      store.releaseVersion(value.projectId, preparation.reference)
    if (value.requestId.startsWith('external-'))
      for (const task of store.overview(value.projectId).tasks)
        if (
          task.type === 'external' &&
          task.requestId &&
          `external-${digest(task.requestId)}` === value.requestId
        )
          settleExternalInput(value.projectId, task.requestId, record.actorId)
    collectUnusedCurrentVersionsForMaintenance(value.projectId)
    return true
  }
  function protectedCurrentVersions(project: string, actor: string) {
    const overview = store.overview(project)
    const configured = authoring.overview(project, actor).sources
    const versions = [...access.workspaceVersionReferences(project)]
    const external = overview.externalVersions
      .filter((value) => value.status === 'published')
      .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt))[0]
    if (external) versions.push(external.id)
    for (const current of availableRepositories(project, configured, actor))
      versions.push(current.versionId)
    return [...new Set(versions)]
  }
  function collectUnusedCurrentVersionsForMaintenance(project: string) {
    if ([...works.keys()].some((key) => (JSON.parse(key) as string[])[0] === project))
      return { removed: [], pending: [] }
    return authoring.withWorkspaceVersionRetention(project, (retention) =>
      store.collectUnusedWorkspaceVersions(project, {
        current: retention.current,
        versions: [
          ...new Set([...retention.versions, ...access.workspaceVersionReferences(project)]),
        ],
      }),
    )
  }
  function collectUnusedQuietly(project: string) {
    try {
      collectUnusedCurrentVersionsForMaintenance(project)
    } catch {
      console.warn('当前资料回收尚未核验，继续保留原件', { projectId: project })
    }
  }
  for (const project of authoring.currentAdoptionProjects()) {
    try {
      adoptExistingCurrent(project)
    } catch {
      // 单个旧来源不可核验时不替换事实；所属项目读取时明确重试并返回真实错误。
    }
  }
  return {
    recordGeneratedSourceUpdate(
      project: string,
      captured: WorkspaceAuthoringCapture,
      actor: string,
      status: Parameters<typeof syncState>[3],
      versionId?: string,
      failureCode?: string,
    ) {
      const records = authoring.syncRecords(project, actor)
      const selected = captured.sources.filter((source) => {
        const current = records.find((value) => value.sourceId === source.id)
        return !current?.versionId || current.currentOrigin === 'snapshot'
      })
      syncState(
        project,
        { ...captured, sources: selected },
        actor,
        status,
        versionId,
        failureCode,
        'snapshot',
      )
    },
    currentRepositories(project: string, actor: string) {
      return availableRepositories(project, authoring.overview(project, actor).sources, actor)
    },
    captureAgentInput,
    captureCurrentInput: captureAgentInput,
    captureAvailableInput,
    collectUnusedCurrentVersionsForMaintenance,
    subscribeInputPreparationSettled(
      listener: (value: { projectId: string; requestId: string; actorId: string }) => void,
    ) {
      preparationListeners.add(listener)
      return () => {
        preparationListeners.delete(listener)
      }
    },
    captureDeploymentSource,
    startDeploymentPackages,
    reconcileFailedDeploymentCapture,
    generateCurrentExternal,
    sync,
    readInput,
    resolveInputFileReference,
    readInputReference,
    fixedInputFileReference,
    inputFiles,
    readInputFile,
    inputTree(project: string, inputId: string, directory: string, actor: string) {
      if (directory && !safePath(directory)) fail(400, 'WORKSPACE_PATH_INVALID', '目录路径无效')
      const captured = readInput(project, inputId, actor)
      const prefix = directory ? directory + '/' : '',
        entries = new Map<
          string,
          { path: string; name: string; kind: 'file' | 'directory'; size: number }
        >()
      for (const path of captured.directories) {
        if (!path.startsWith(prefix)) continue
        const name = path.slice(prefix.length).split('/')[0]!
        if (name)
          entries.set(prefix + name, { path: prefix + name, name, kind: 'directory', size: 0 })
      }
      for (const file of inputFiles(project, inputId, actor)) {
        if (!file.path.startsWith(prefix)) continue
        const rest = file.path.slice(prefix.length),
          name = rest.split('/')[0]!
        entries.set(prefix + name, {
          path: prefix + name,
          name,
          kind: rest.includes('/') ? 'directory' : 'file',
          size: rest.includes('/') ? 0 : file.size,
        })
      }
      if (
        !entries.size &&
        !captured.repositories.some(
          (repository) =>
            directory === repository.source.mountPath ||
            directory.startsWith(repository.source.mountPath + '/'),
        ) &&
        captured.sourceErrors?.some(
          (source) =>
            directory === source.mountPath || directory.startsWith(source.mountPath + '/'),
        )
      )
        fail(503, 'WORKSPACE_INPUT_SOURCE_UNAVAILABLE', '本轮未取得此仓库源码；上传资料仍可读取')
      return {
        entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, 500),
        truncated: entries.size > 500,
      }
    },
    async readInputContent(
      project: string,
      inputId: string,
      path: string,
      actor: string,
    ): Promise<WorkspaceMaterialContent> {
      ensureAccepting()
      const captured = readInput(project, inputId, actor)
      if (captured.captureId && captured.files.some((file) => file.path === path))
        return authoring.readCapturedContent(project, captured.captureId, path, actor)
      if (completions.size >= 2) fail(429, 'WORKSPACE_PREVIEW_BUSY', '已有资料正在读取，请稍后重试')
      const file = readInputFile(project, inputId, path, actor)
      const work = extractBusinessAttachment({
        id: path,
        name: file.name,
        mime: file.mime,
        bytes: file.bytes,
      })
      completions.add(work)
      try {
        const extracted = await work
        readInput(project, inputId, actor)
        return {
          path,
          revision: file.revision,
          mime: file.mime,
          size: file.bytes.byteLength,
          sha256: file.sha256,
          extraction: {
            status: typeof extracted.content === 'string' ? 'ready' : 'unavailable',
            contentHash: file.sha256,
            parserVersion: 'business-documents-v1',
            ...(extracted.extraction?.code ? { code: extracted.extraction.code } : {}),
            ...(extracted.extraction?.message ? { message: extracted.extraction.message } : {}),
          },
          ...(typeof extracted.content === 'string' ? { contents: extracted.content } : {}),
        }
      } finally {
        completions.delete(work)
      }
    },
    externalPreparationReceipt(project: string, requestId: string, actor: string) {
      access.requireProjectActionForActor(actor, project, 'workspace.external.publish')
      const request = `external-${digest(requestId)}`
      const captured = authoring.captureByRequest(project, request, actor)
      if (!captured) return null
      const input = authoring.inputByRequest(project, request, actor, 'internal')
      const failure = input?.sourceErrors?.[0]
      return {
        id: captured.id,
        resolution: failure ? ('failed' as const) : captured.resolution,
        ...(failure
          ? {
              resolutionError: {
                code: failure.code,
                message: '当前源码未能完整同步，外部资料尚未生成',
              },
            }
          : captured.resolutionError
            ? { resolutionError: captured.resolutionError }
            : {}),
      }
    },
    releaseInput(project: string, inputId: string, actor: string) {
      const value = authoring.releaseInput(project, inputId, actor)
      store.releaseVersion(project, `input:${inputId}`)
      for (const repository of value.repositories)
        store.releaseVersion(project, `input:${inputId}:${repository.sourceId}`)
      return value
    },
    inputForNativeMaintenance(reference: {
      projectId: string
      inputId: string
      inputOwnerId: string
    }) {
      return authoring.inputForMaintenance(
        reference.projectId,
        reference.inputId,
        reference.inputOwnerId,
      )
    },
    inputPreparationForNativeMaintenance(reference: {
      projectId: string
      requestId: string
      actorId: string
      workspaceType: 'internal' | 'external'
    }) {
      return authoring.inputForRequestMaintenance(
        reference.projectId,
        reference.requestId,
        reference.actorId,
        reference.workspaceType,
      )
    },
    retainInputForNativeBinding(reference: {
      projectId: string
      inputId: string
      inputOwnerId: string
      workspaceType: 'internal' | 'external'
    }): WorkspaceInputCapture {
      const record = authoring.inputForMaintenance(
        reference.projectId,
        reference.inputId,
        reference.inputOwnerId,
      )
      if (!record || record.preparing || record.value.workspaceType !== reference.workspaceType)
        fail(409, 'WORKSPACE_INPUT_IDENTITY_CHANGED', '原输入不存在或不属于本轮固定资料范围')
      const value = record.value
      const versions = [
        ...value.repositories.map((repository) => repository.versionId),
        ...(value.externalVersionId ? [value.externalVersionId] : []),
      ]
      if (value.status === 'released')
        for (const versionId of new Set(versions)) {
          try {
            store.verifyInputVersion(reference.projectId, versionId)
          } catch (error) {
            if (
              error &&
              typeof error === 'object' &&
              (('status' in error && error.status === 404) ||
                ('code' in error && error.code === 'ENOENT'))
            )
              fail(410, 'WORKSPACE_INPUT_ORIGINAL_CLEARED', '原资料已更新或清理，无法恢复原输入')
            throw error
          }
        }
      if (value.externalVersionId)
        store.retainVersion(value.projectId, value.externalVersionId, `input:${value.id}`)
      for (const repository of value.repositories)
        store.retainVersion(
          value.projectId,
          repository.versionId,
          `input:${value.id}:${repository.sourceId}`,
        )
      return authoring.retainInputForNativeBinding(record)
    },
    releaseInputAfterNativeTerminal: releaseInputResources,
    releaseDeploymentSource(project: string, inputId: string, actor: string) {
      access.requireProjectActionForActor(actor, project, 'source.generate')
      store.releaseVersion(project, `deployment:${inputId}`)
    },
    releaseDeploymentSourceForMaintenance(
      candidate: WorkspaceDeploymentSourceMaintenanceCandidate,
    ): boolean {
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        ['projectId', 'requestId', 'actorId', 'taskId', 'sourceVersionId'].some(
          (key) =>
            typeof candidate[key as keyof typeof candidate] !== 'string' ||
            !candidate[key as keyof typeof candidate] ||
            candidate[key as keyof typeof candidate].length > 512,
        )
      )
        fail(400, 'WORKSPACE_DEPLOYMENT_MAINTENANCE_INVALID', '部署来源维护身份无效')
      const preparing = () =>
        [...works.keys()].some((key) => JSON.parse(key)[0] === candidate.projectId)
      const eligible = () =>
        store
          .packageCleanupCandidates([])
          .some((value) =>
            ['projectId', 'requestId', 'actorId', 'taskId', 'sourceVersionId'].every(
              (key) =>
                value[key as keyof typeof value] === candidate[key as keyof typeof candidate],
            ),
          )
      if (preparing() || !eligible()) return false
      return authoring.withDeploymentSourceMaintenanceReceipt(candidate, (input, captured) => {
        const tasks = store.overview(candidate.projectId).tasks
        const task = tasks.find((value) => value.id === candidate.taskId)
        if (
          !task ||
          task.type !== 'packages' ||
          task.requestId !== candidate.requestId ||
          !['completed', 'failed', 'interrupted'].includes(task.status) ||
          tasks.some(
            (value) =>
              value.requestId === candidate.requestId &&
              ['queued', 'running'].includes(value.status),
          ) ||
          preparing() ||
          !eligible()
        )
          return false
        const version = store.getVersion(candidate.projectId, candidate.sourceVersionId)
        if (
          version.cachePurpose !== 'deployment' ||
          version.status !== 'published' ||
          version.source.documents?.length ||
          captured.sources.length !== input.repositories.length ||
          version.source.repositories.length !== input.repositories.length
        )
          return false
        for (const repository of input.repositories) {
          const source = captured.sources.find((value) => value.id === repository.sourceId)
          const resolved = captured.resolvedRepositories?.find(
            (value) => value.sourceId === repository.sourceId,
          )
          const fixed = version.source.repositories.find(
            (value) => value.sourceId === repository.sourceId,
          )
          if (
            !source ||
            !resolved ||
            !fixed ||
            repository.versionId !== version.id ||
            digest(source) !== digest(repository.source) ||
            resolved.commit !== repository.commit ||
            fixed.commit !== repository.commit ||
            fixed.path !== source.mountPath ||
            fixed.configurationHash !== digest(source)
          )
            return false
        }
        store.releaseVersion(candidate.projectId, `deployment:${input.id}`)
        return true
      })
    },
    planCleanupVersions(project: string, versionIds: string[], actor: string) {
      access.requireProjectActionForActor(actor, project, 'workspace.cleanup')
      return {
        ...store.planCleanupVersions(
          project,
          versionIds,
          actor,
          protectedCurrentVersions(project, actor),
        ),
        inputProtection: authoring.inputProtectionSummary(project, actor),
      }
    },
    cleanupVersions(project: string, versionIds: string[], actor: string) {
      access.requireProjectActionForActor(actor, project, 'workspace.cleanup')
      return store.pruneVersions(
        project,
        versionIds,
        actor,
        protectedCurrentVersions(project, actor),
      )
    },
    async cancelProjectWork(project: string) {
      const pending = [...works.entries()].filter(([key]) => JSON.parse(key)[0] === project)
      for (const [, job] of pending) job.controller.abort()
      await Promise.allSettled(pending.map(([, job]) => job.work))
    },
    stopAccepting() {
      stopping = true
      for (const value of works.values()) value.controller.abort()
    },
    async drain() {
      await Promise.allSettled([...works.values()].map((value) => value.work))
      await Promise.allSettled([...completions])
    },
  }
}
