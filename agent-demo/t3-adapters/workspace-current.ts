// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- 当前资料编排复用工作区队列，原件和固定源码仍由各自存储所有者管理。
import { createHash, randomUUID } from 'node:crypto'
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
  WorkspaceInputCapture,
  WorkspaceInputRepository,
  WorkspaceMaterialContent,
  WorkspaceCapturedFile,
  WorkspaceRepositorySource,
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
    void work.finally(() => works.delete(key)).catch(() => {})
    return work
  }
  function syncState(
    project: string,
    captured: WorkspaceAuthoringCapture,
    actor: string,
    status: 'queued' | 'syncing' | 'synced' | 'failed',
    versionId?: string,
    failureCode?: string,
  ) {
    const configured = authoring.overview(project, actor).sources
    for (const source of captured.sources) {
      if (!configured.some((value) => value.id === source.id && digest(value) === digest(source)))
        continue
      const previous = authoring
        .syncRecords(project, actor)
        .find((value) => value.sourceId === source.id)
      // 较早领取的任务不能把较新的请求状态覆盖回去。
      if (status !== 'queued' && previous?.requestId !== captured.requestId) continue
      const commit = captured.resolvedRepositories?.find(
        (value) => value.sourceId === source.id,
      )?.commit
      const sameConfiguration = previous?.configurationHash === digest(source)
      const retainedVersion = versionId ?? (sameConfiguration ? previous?.versionId : undefined)
      const retainedCommit = versionId ? commit : sameConfiguration ? previous?.commit : undefined
      authoring.recordSync(
        project,
        {
          sourceId: source.id,
          configurationHash: digest(source),
          requestId: captured.requestId,
          status,
          updatedAt: now(),
          ...(retainedVersion ? { versionId: retainedVersion } : {}),
          ...(retainedCommit ? { commit: retainedCommit } : {}),
          ...(status === 'failed'
            ? {
                error: {
                  code:
                    failureCode && unavailableGitCodes.has(failureCode)
                      ? failureCode
                      : 'WORKSPACE_SYNC_FAILED',
                  message: '同步失败，请重试。',
                },
              }
            : {}),
        },
        actor,
      )
      if (versionId && status === 'synced')
        store.retainVersion(project, versionId, `current:${source.id}`)
    }
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
    if (value.status !== 'active') fail(410, 'WORKSPACE_INPUT_RELEASED', '本轮资料输入已释放')
    return value
  }
  function availableRepositories(
    project: string,
    sources: WorkspaceRepositorySource[],
    actor: string,
  ): WorkspaceInputRepository[] {
    readPermission(project, actor)
    const current = authoring.overview(project, actor)
    const records = authoring.syncRecords(project, actor)
    return sources.flatMap((source) => {
      const configurationHash = digest(source)
      if (
        !current.sources.some(
          (value) => value.id === source.id && digest(value) === configurationHash,
        )
      )
        return []
      const record = records.find(
        (value) =>
          value.sourceId === source.id &&
          value.configurationHash === configurationHash &&
          value.versionId,
      )
      if (!record?.versionId) return []
      const fixed = store
        .getVersion(project, record.versionId)
        .source.repositories.find(
          (value) =>
            value.sourceId === source.id &&
            value.configurationHash === configurationHash &&
            value.path === source.mountPath,
        )
      if (!fixed) return []
      // 只沿用当前配置下已同步的完整源码；凭证与资料权限仍按当前授权核对。
      const credentialVersion = source.credentialId
        ? credentials.referenceVersion(actor, project, source.credentialId)
        : undefined
      return [
        {
          sourceId: source.id,
          commit: fixed.commit,
          refKind: source.refKind,
          ref: source.ref,
          defaultRef: null,
          ...(credentialVersion ? { credentialVersion } : {}),
          source,
          versionId: record.versionId,
        },
      ]
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
    if (
      input.sourceErrors?.some(
        (source) => path === source.mountPath || path.startsWith(source.mountPath + '/'),
      )
    )
      fail(
        503,
        'WORKSPACE_INPUT_SOURCE_UNAVAILABLE',
        '本轮未取得此仓库源码；上传资料仍可读取，下一新轮将重新同步',
      )
    const file = inputFiles(project, inputId, actor).find((file) => file.path === path)
    if (!file) fail(404, 'WORKSPACE_MATERIAL_NOT_FOUND', '本轮资料输入中没有此文件')
    const result = store.versionFile(project, file.revision, path)
    return { ...result, revision: file.revision, sha256: file.sha256 }
  }
  async function captureAgentInput(
    project: string,
    input: { requestId: string; workspaceType: 'internal' | 'external' },
    actor: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceInputCapture> {
    readPermission(project, actor, input.workspaceType)
    const previous = authoring.inputByRequest(project, input.requestId, actor, input.workspaceType)
    if (previous) return readInput(project, previous.id, actor)
    return track(
      project,
      input.requestId,
      actor,
      digest(input),
      async (currentSignal) => {
        if (input.workspaceType === 'external') {
          const version = store
            .overview(project)
            .externalVersions.filter((value) => value.status === 'published')
            .sort((a, b) =>
              (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt),
            )[0]
          if (!version)
            fail(409, 'WORKSPACE_EXTERNAL_UNAVAILABLE', '项目尚未发布可供外部访问的资料')
          const value: WorkspaceInputCapture = {
            id: randomUUID(),
            projectId: project,
            requestId: input.requestId,
            workspaceType: 'external',
            revision: 0,
            createdAt: now(),
            status: 'active',
            repositories: [],
            files: [],
            directories: [],
            externalVersionId: version.id,
          }
          store.retainVersion(project, version.id, `input:${value.id}`)
          return authoring.saveInput(value, actor)
        }
        let captured = authoring.capture(project, undefined, actor, input.requestId)
        let versionId: string | undefined
        let sourceErrors: WorkspaceInputCapture['sourceErrors']
        let sourceWarnings: WorkspaceInputCapture['sourceWarnings']
        let retainedRepositories: WorkspaceInputRepository[] = []
        try {
          captured = await resolveCapture(project, captured, actor, currentSignal, true)
          if (captured.sources.length) {
            const task = sourceTask(project, captured, actor, 'input')
            const cancel = () => {
              try {
                store.cancelTask(project, task.id)
              } catch {}
            }
            currentSignal.addEventListener('abort', cancel, { once: true })
            if (currentSignal.aborted) cancel()
            syncState(project, captured, actor, 'syncing')
            try {
              versionId = (
                await completedTask(project, captured.requestId, actor, 'input', currentSignal)
              ).versionId
            } finally {
              currentSignal.removeEventListener('abort', cancel)
            }
            syncState(project, captured, actor, 'synced', versionId)
          }
        } catch (error) {
          currentSignal.throwIfAborted()
          readPermission(project, actor)
          const code = sourceFailureCode(error)
          if (!code || !unavailableGitCodes.has(code)) throw error
          syncState(project, captured, actor, 'failed', undefined, code)
          retainedRepositories = availableRepositories(project, captured.sources, actor)
          const issues = captured.sources.map((source) => ({
            sourceId: source.id,
            name: source.name,
            mountPath: source.mountPath,
            code,
          }))
          const available = new Set(retainedRepositories.map((repository) => repository.sourceId))
          sourceErrors = issues
            .filter((issue) => !available.has(issue.sourceId))
            .map((issue) => ({
              ...issue,
              message: '源码更新失败，此仓库尚无可读取的同步内容；上传资料仍可读取',
            }))
          sourceWarnings = issues
            .filter((issue) => available.has(issue.sourceId))
            .map((issue) => ({
              ...issue,
              message: '源码更新失败，继续使用工作区已同步的内容；远端最新提交尚未确认',
            }))
        }
        readPermission(project, actor)
        const value: WorkspaceInputCapture = {
          id: captured.id,
          projectId: project,
          requestId: input.requestId,
          workspaceType: 'internal',
          revision: captured.revision,
          createdAt: captured.createdAt,
          status: 'active',
          repositories: versionId ? repositories(captured, versionId) : retainedRepositories,
          files: captured.files,
          directories: captured.directories,
          captureId: captured.id,
          ...(sourceErrors?.length ? { sourceErrors } : {}),
          ...(sourceWarnings?.length ? { sourceWarnings } : {}),
        }
        for (const repository of value.repositories)
          store.retainVersion(
            project,
            repository.versionId,
            `input:${value.id}:${repository.sourceId}`,
          )
        const saved = authoring.saveInput(value, actor)
        const completed = store.taskForRequest(project, 'input', input.requestId, actor)
        if (completed) store.releaseVersion(project, `task:${completed.id}`)
        return saved
      },
      signal,
    )
  }
  async function sync(
    project: string,
    input: WorkspaceAuthoringMutation,
    actor: string,
  ): Promise<WorkspaceTask> {
    access.requireWorkspaceActor(actor, project)
    return track(project, input.requestId, actor, digest(input), async (signal) => {
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
        captured = await resolveCapture(project, captured, actor, signal, true)
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
        })
      completions.add(completion)
      void completion.finally(() => completions.delete(completion))
      return task
    })
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
      authoring.inputByRequest(project, requestId, actor, 'internal')
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
      return captureAgentInput(
        project,
        { workspaceType: 'external', requestId: `picker:${digest([actor, version.id])}` },
        actor,
      )
    }
    const current = authoring.overview(project, actor)
    const available = availableRepositories(project, current.sources, actor)
    const requestId = `picker:${digest([actor, current.revision, available.map((value) => [value.source.id, value.versionId])])}`
    const previous = authoring.inputByRequest(project, requestId, actor, 'internal')
    if (previous) return readInput(project, previous.id, actor)
    let captured = authoring.capture(project, current.revision, actor, requestId, {
      sources: available.map((value) => value.source),
      documents: true,
    })
    const resolved = available.map(
      ({ source: _source, versionId: _versionId, ...resolved }) => resolved,
    )
    if (captured.resolution === 'pending')
      captured = authoring.freezeCaptureRepositories(project, captured.id, resolved, actor)
    const value: WorkspaceInputCapture = {
      id: captured.id,
      projectId: project,
      requestId,
      workspaceType: 'internal',
      revision: captured.revision,
      createdAt: captured.createdAt,
      status: 'active',
      repositories: available,
      files: captured.files,
      directories: captured.directories,
      captureId: captured.id,
      sourceErrors: current.sources
        .filter((source) => !available.some((value) => value.source.id === source.id))
        .map((source) => ({
          sourceId: source.id,
          name: source.name,
          mountPath: source.mountPath,
          code: 'WORKSPACE_SOURCE_UNSYNCED',
          message: '此仓库当前没有可读取的同步内容',
        })),
    }
    for (const repository of value.repositories)
      store.retainVersion(project, repository.versionId, `input:${value.id}:${repository.sourceId}`)
    return authoring.saveInput(value, actor)
  }
  async function generateCurrentExternal(
    project: string,
    input: {
      requestId: string
      rules?: Array<{ find: string; replace: string }>
      expectedRevision?: number
    },
    actor: string,
  ) {
    access.requireProjectActionForActor(actor, project, 'workspace.external.publish')
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
      return store.startExternal(
        project,
        {
          requestId: input.requestId,
          sourceVersionId: prepared.versionId,
          ...(input.rules ? { rules: input.rules } : {}),
        },
        actor,
      )
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
    )
    if (input.expectedRevision !== undefined && input.expectedRevision !== captured.revision)
      fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原外部请求已经固定其他资料修订')
    if (captured.sourceErrors?.length || captured.sourceWarnings?.length)
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
    const task = await completedTask(project, sourceTaskId, actor, 'snapshot')
    return store.startExternal(
      project,
      {
        requestId: input.requestId,
        sourceVersionId: task.versionId,
        ...(input.rules ? { rules: input.rules } : {}),
      },
      actor,
    )
  }
  function protectedCurrentVersions(project: string, actor: string) {
    const overview = store.overview(project)
    const configured = authoring.overview(project, actor).sources
    const syncs = authoring.syncRecords(project, actor)
    const versions = [...access.workspaceVersionReferences(project)]
    const external = overview.externalVersions
      .filter((value) => value.status === 'published')
      .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt))[0]
    if (external) versions.push(external.id)
    for (const source of configured) {
      const synced = syncs.find(
        (value) => value.sourceId === source.id && value.configurationHash === digest(source),
      )
      const version =
        synced?.versionId ??
        overview.internalVersions.find(
          (value) =>
            value.status === 'published' &&
            value.source.repositories.some(
              (repository) =>
                repository.sourceId === source.id &&
                repository.configurationHash === digest(source),
            ),
        )?.id
      if (version) versions.push(version)
    }
    return [...new Set(versions)]
  }
  return {
    captureAgentInput,
    captureCurrentInput: captureAgentInput,
    captureAvailableInput,
    captureDeploymentSource,
    startDeploymentPackages,
    reconcileFailedDeploymentCapture,
    generateCurrentExternal,
    sync,
    readInput,
    inputFiles,
    readInputFile,
    inputTree(project: string, inputId: string, directory: string, actor: string) {
      if (directory && !safePath(directory)) fail(400, 'WORKSPACE_PATH_INVALID', '目录路径无效')
      const captured = readInput(project, inputId, actor)
      if (
        captured.sourceErrors?.some(
          (source) =>
            directory === source.mountPath || directory.startsWith(source.mountPath + '/'),
        )
      )
        fail(503, 'WORKSPACE_INPUT_SOURCE_UNAVAILABLE', '本轮未取得此仓库源码；上传资料仍可读取')
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
      const failure = input?.sourceErrors?.[0] ?? input?.sourceWarnings?.[0]
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
    releaseDeploymentSource(project: string, inputId: string, actor: string) {
      access.requireProjectActionForActor(actor, project, 'source.generate')
      store.releaseVersion(project, `deployment:${inputId}`)
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
