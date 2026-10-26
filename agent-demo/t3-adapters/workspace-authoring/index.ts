// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- 资料模块在独立 Node 边界管理事务和文件，T3 仅调用公开接口。
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  existsSync,
  lstatSync,
  realpathSync,
  statfsSync,
} from 'node:fs'
import { resolve, join, dirname, extname } from 'node:path'
import type { SQLOutputValue } from 'node:sqlite'
import type {
  ProjectRepositoryCommand,
  ProjectRepositoryConnection,
  WorkspaceRepositoryUsage,
  WorkspaceInputCapture,
  WorkspaceInputRepository,
  WorkspaceInputSelection,
  WorkspaceSourceSyncRecord,
  WorkspaceDeploymentSourceCapture,
  WorkspaceDeploymentSourceMaintenanceCandidate,
  WorkspaceAuthoringCapture,
  WorkspaceAuthoringMutation,
  WorkspaceAuthoringOverview,
  WorkspaceAuthoringResult,
  WorkspaceCapturedFile,
  WorkspaceDeleteInput,
  WorkspaceExtraction,
  WorkspaceExtractionRetryInput,
  WorkspaceMaterialContent,
  WorkspaceMaterialEntry,
  WorkspaceMoveInput,
  WorkspaceRepositorySource,
  WorkspaceResolvedRepository,
  WorkspaceTextSaveInput,
  WorkspaceUploadInput,
} from '../../../autoops/contracts/workspace-authoring.ts'
import { BUSINESS_DOCUMENT_LIMITS, extractBusinessAttachment } from '../business-documents.mjs'
import { openAuthoringDatabase } from './storage.ts'
import {
  WorkspaceAuthoringError,
  editable,
  fail,
  fileName,
  hash,
  id,
  limits,
  mimeFor,
  normalizeSource,
  normalizeRepository,
  overlaps,
  parserVersion,
  path,
  plainText,
  revision,
  requestIdentifier,
} from './rules.ts'

export { WorkspaceAuthoringError } from './rules.ts'
export type WorkspaceAuthoringAction =
  'read' | 'external-read' | 'manage' | 'source-manage' | 'source-generate' | 'repository-read'
export interface WorkspaceAuthoringOptions {
  dataDir: string
  validateRepository?: (
    actorId: string,
    projectId: string,
    value: ProjectRepositoryConnection,
  ) => unknown
  authorize: (actorId: string, projectId: string, action: WorkspaceAuthoringAction) => unknown
}
type Row = Record<string, SQLOutputValue>
const now = () => new Date().toISOString()
const text = (row: Row, key: string) => String(row[key])
const sourceFrom = (row: Row): WorkspaceRepositorySource => ({
  id: text(row, row.source_id === undefined ? 'id' : 'source_id'),
  name: text(row, 'name'),
  role: text(row, 'role') as WorkspaceRepositorySource['role'],
  url: text(row, 'url'),
  refKind: text(row, 'ref_kind') as WorkspaceRepositorySource['refKind'],
  ref: text(row, 'ref'),
  mountPath: text(row, 'mount_path'),
  ...(row.source_path === null ? {} : { sourcePath: text(row, 'source_path') }),
  ...(row.credential_id === null ? {} : { credentialId: text(row, 'credential_id') }),
})

export function createWorkspaceAuthoring(options: WorkspaceAuthoringOptions) {
  if (
    !options ||
    typeof options.dataDir !== 'string' ||
    !options.dataDir ||
    typeof options.authorize !== 'function'
  )
    throw new TypeError('工作区资料服务需要数据目录和授权端口')
  const directory = resolve(options.dataDir, 'workspace-authoring')
  const blobDirectory = join(directory, 'originals')
  mkdirSync(blobDirectory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink() || lstatSync(blobDirectory).isSymbolicLink())
    fail(503, 'WORKSPACE_STORAGE_INVALID', '资料存储不能使用符号链接')
  const blobRoot = realpathSync(blobDirectory)
  const database = openAuthoringDatabase(join(directory, 'state.sqlite'))
  const { db, transaction } = database
  let stopped = false,
    closed = false
  let closePromise: Promise<void> | undefined
  const processing = new Map<string, Promise<void>>()
  // 原件与收据已保存的解析在重启后明确显示中断，由显式重试重新处理。
  db.prepare(
    "UPDATE authoring_extractions SET status='unavailable',code='DOCUMENT_INTERRUPTED',message='服务重启中断了正文提取，原件仍可下载，请重新处理' WHERE status='pending'",
  ).run()

  // 同步没有后台自治重放；重启后保留最近成功源码，并把未完成请求明确标为失败。
  for (const row of db
    .prepare('SELECT project_id,source_id,value FROM authoring_source_sync')
    .all()) {
    const value = JSON.parse(text(row, 'value')) as WorkspaceSourceSyncRecord
    if (value.status === 'queued' || value.status === 'syncing')
      db.prepare('UPDATE authoring_source_sync SET value=? WHERE project_id=? AND source_id=?').run(
        JSON.stringify({
          ...value,
          status: 'failed',
          error: {
            code: 'WORKSPACE_SYNC_INTERRUPTED',
            message: '服务重启中断了源码同步，请核对原任务',
          },
        }),
        row.project_id!,
        row.source_id!,
      )
  }

  function authorize(
    projectId: string,
    actorId: string,
    action: WorkspaceAuthoringAction,
    writing = false,
  ) {
    if (closed || (writing && stopped))
      fail(503, 'WORKSPACE_AUTHORING_STOPPING', '工作区资料服务正在停止，请稍后重试')
    id(projectId)
    id(actorId)
    const decision = options.authorize(actorId, projectId, action)
    if (decision === false) fail(403, 'WORKSPACE_AUTHORING_FORBIDDEN', '无权操作项目资料')
    if (decision && typeof decision === 'object' && 'then' in decision) {
      void Promise.resolve(decision).catch(() => {})
      fail(503, 'WORKSPACE_AUTHORIZATION_INVALID', '工作区资料授权必须同步返回当前裁决')
    }
  }
  function projectRevision(projectId: string) {
    return Number(
      db.prepare('SELECT revision FROM authoring_projects WHERE project_id=?').get(projectId)
        ?.revision ?? 0,
    )
  }
  function ensureProject(projectId: string) {
    db.prepare('INSERT OR IGNORE INTO authoring_projects(project_id) VALUES(?)').run(projectId)
  }
  function checkRevision(projectId: string, expected: number) {
    if (projectRevision(projectId) !== revision(expected))
      fail(409, 'WORKSPACE_REVISION_CONFLICT', '当前资料已被修改，请刷新后重新确认')
  }
  function advance(projectId: string) {
    db.prepare('UPDATE authoring_projects SET revision=revision+1 WHERE project_id=?').run(
      projectId,
    )
    return projectRevision(projectId)
  }
  const sources = (projectId: string) =>
    db
      .prepare(
        'SELECT s.*,r.name,r.url,r.credential_id FROM authoring_sources s JOIN authoring_repositories r ON r.project_id=s.project_id AND r.id=s.id WHERE s.project_id=? ORDER BY s.id',
      )
      .all(projectId)
      .map(sourceFrom)
  function extraction(contentHash: string, mime: string): WorkspaceExtraction {
    const row = db
      .prepare('SELECT * FROM authoring_extractions WHERE hash=? AND mime=?')
      .get(contentHash, mime)
    return {
      status: row ? (text(row, 'status') as WorkspaceExtraction['status']) : 'unavailable',
      contentHash,
      parserVersion: row ? text(row, 'parser_version') : parserVersion,
      ...(row?.code ? { code: text(row, 'code') } : {}),
      ...(row?.message ? { message: text(row, 'message') } : {}),
    }
  }
  function entryFrom(row: Row): WorkspaceMaterialEntry {
    const entryPath = text(row, 'path'),
      mime = text(row, 'mime'),
      contentHash = row.hash === null ? null : text(row, 'hash')
    return {
      id: text(row, 'id'),
      path: entryPath,
      name: fileName(entryPath),
      kind: text(row, 'kind') as WorkspaceMaterialEntry['kind'],
      revision: text(row, 'revision'),
      updatedAt: text(row, 'updated_at'),
      size: Number(row.size ?? 0),
      mime,
      editable: row.kind === 'file' && editable(entryPath, mime),
      ...(contentHash === null
        ? {}
        : { sha256: contentHash, extraction: extraction(contentHash, mime) }),
    }
  }
  const rows = (projectId: string) =>
    db
      .prepare(
        'SELECT e.*,b.size FROM authoring_entries e LEFT JOIN authoring_blobs b ON b.hash=e.hash WHERE project_id=? ORDER BY path',
      )
      .all(projectId)
  function entryRow(projectId: string, entryPath: string): Row {
    const row = db
      .prepare(
        'SELECT e.*,b.size FROM authoring_entries e LEFT JOIN authoring_blobs b ON b.hash=e.hash WHERE project_id=? AND path=?',
      )
      .get(projectId, entryPath)
    if (!row) fail(404, 'WORKSPACE_MATERIAL_NOT_FOUND', '资料不存在或已删除')
    return row
  }
  function assertWritable(projectId: string, entryPath: string) {
    const configured = sources(projectId)
    const current = db
      .prepare('SELECT value FROM authoring_source_sync WHERE project_id=?')
      .all(projectId)
      .map((row) => JSON.parse(text(row, 'value')) as WorkspaceSourceSyncRecord)
      .flatMap((record) =>
        record.versionId &&
        record.current &&
        configured.some((source) => source.id === record.sourceId)
          ? [record.current.source]
          : [],
      )
    if ([...configured, ...current].some((source) => overlaps(source.mountPath, entryPath)))
      fail(409, 'WORKSPACE_GIT_READ_ONLY', 'Git 挂载内容只读，请选择项目资料目录')
  }
  function ensureParents(projectId: string, entryPath: string) {
    const parts = entryPath.split('/')
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/')
      const existing = db
        .prepare('SELECT kind FROM authoring_entries WHERE project_id=? AND path=?')
        .get(projectId, parent)
      if (existing?.kind === 'file') fail(409, 'WORKSPACE_PATH_CONFLICT', '目标父路径已经是文件')
      if (!existing)
        db.prepare(
          "INSERT INTO authoring_entries VALUES(?,?,?,'directory',?,?,NULL,'inode/directory')",
        ).run(projectId, parent, randomUUID(), randomUUID(), now())
    }
  }
  function currentEntry(projectId: string, entryPath: string, expected: string) {
    if (typeof expected !== 'string' || !expected)
      fail(400, 'WORKSPACE_CONTENT_REVISION_REQUIRED', '需要原文件的内容修订条件')
    const row = entryRow(projectId, entryPath)
    if (row.revision !== expected)
      fail(409, 'WORKSPACE_CONTENT_CONFLICT', '资料内容已经变化，请重新加载后保存')
    return row
  }
  function assertBudget(projectId: string) {
    const count = Number(
      db
        .prepare('SELECT count(*) AS value FROM authoring_entries WHERE project_id=?')
        .get(projectId)?.value ?? 0,
    )
    const size = Number(
      db
        .prepare(
          'SELECT coalesce(sum(b.size),0) AS value FROM authoring_entries e JOIN authoring_blobs b ON b.hash=e.hash WHERE e.project_id=?',
        )
        .get(projectId)?.value ?? 0,
    )
    if (count > limits.maxFiles || size > limits.maxBytes)
      fail(413, 'WORKSPACE_MATERIAL_LIMIT', '当前资料超过文件数量或总大小上限')
  }
  function original(contentHash: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(contentHash)) fail(409, 'WORKSPACE_CONTENT_CHANGED', '原件身份无效')
    const target = join(blobRoot, contentHash)
    try {
      if (
        lstatSync(target).isSymbolicLink() ||
        !lstatSync(target).isFile() ||
        dirname(realpathSync(target)) !== blobRoot
      )
        fail(409, 'WORKSPACE_CONTENT_CHANGED', '原件路径校验失败')
      const bytes = readFileSync(target)
      if (hash(bytes) !== contentHash) fail(409, 'WORKSPACE_CONTENT_CHANGED', '原件校验失败')
      return bytes
    } catch (error) {
      if (error instanceof WorkspaceAuthoringError) throw error
      return fail(409, 'WORKSPACE_CONTENT_UNAVAILABLE', '原件不可读取，请检查资料存储')
    }
  }
  function putOriginal(contentHash: string, bytes: Uint8Array) {
    const stats = statfsSync(blobRoot)
    if (Number(stats.bavail) * Number(stats.bsize) < bytes.byteLength + 32 * 1024 * 1024)
      fail(507, 'WORKSPACE_STORAGE_LOW', '可用存储不足，原有资料未修改')
    const target = join(blobRoot, contentHash)
    if (existsSync(target)) {
      original(contentHash)
      return
    }
    const temporary = join(blobRoot, randomUUID() + '.part')
    try {
      writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, target)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  function collectUnusedOriginals() {
    if (closed) return { removed: 0 }
    const inUse = new Set([...processing.keys()].map((key) => key.slice(0, 64)))
    transaction.run(() => {
      // 当前资料、活动捕获和正在解析的原件都属于有效引用，跨项目统一核对。
      const unused = db
        .prepare(
          "SELECT hash FROM authoring_blobs b WHERE NOT EXISTS(SELECT 1 FROM authoring_entries e WHERE e.hash=b.hash) AND NOT EXISTS(SELECT 1 FROM authoring_capture_files f JOIN authoring_captures c ON c.id=f.capture_id WHERE f.hash=b.hash AND c.status='active')",
        )
        .all()
      for (const blob of unused) {
        const contentHash = text(blob, 'hash')
        if (!inUse.has(contentHash))
          db.prepare('DELETE FROM authoring_blobs WHERE hash=?').run(contentHash)
      }
    })
    let removed = 0
    // 先提交无引用元数据的删除，再删字节；文件删除失败留下的孤立原件可在下一次操作或重启时重试。
    for (const contentHash of readdirSync(blobRoot)) {
      if (!/^[a-f0-9]{64}$/.test(contentHash) || inUse.has(contentHash)) continue
      if (db.prepare('SELECT 1 FROM authoring_blobs WHERE hash=?').get(contentHash)) continue
      if (
        db
          .prepare(
            "SELECT 1 FROM authoring_entries WHERE hash=? UNION ALL SELECT 1 FROM authoring_capture_files f JOIN authoring_captures c ON c.id=f.capture_id WHERE f.hash=? AND c.status='active' LIMIT 1",
          )
          .get(contentHash, contentHash)
      )
        continue
      rmSync(join(blobRoot, contentHash), { force: true })
      removed++
    }
    return { removed }
  }
  function collectUnusedQuietly() {
    try {
      collectUnusedOriginals()
    } catch {
      // 清理不能把已持久成功的写入误报为失败，残留原件由下一次维护机会重试。
    }
  }
  function mutation(
    projectId: string,
    actorId: string,
    operation: string,
    input: WorkspaceAuthoringMutation,
    payload: unknown,
    work: () => Omit<WorkspaceAuthoringResult, 'requestId'>,
  ): WorkspaceAuthoringResult {
    authorize(
      projectId,
      actorId,
      ['save-repository', 'remove-repository'].includes(operation) ? 'source-manage' : 'manage',
      true,
    )
    const requestId = id(input.requestId),
      expectedRevision = revision(input.expectedRevision)
    const fingerprint = hash(JSON.stringify({ actorId, operation, expectedRevision, payload }))
    const result = transaction.run(() => {
      if (
        db
          .prepare(
            'SELECT 1 FROM authoring_captures WHERE project_id=? AND request_id=? UNION ALL SELECT 1 FROM authoring_input_preparations WHERE project_id=? AND request_id=? LIMIT 1',
          )
          .get(projectId, requestId, projectId, requestId)
      )
        fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原请求标识已用于生成固定版本，请核对原任务')
      const previous = db
        .prepare('SELECT * FROM authoring_receipts WHERE project_id=? AND request_id=?')
        .get(projectId, requestId)
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原请求标识已用于其他操作或参数')
        return JSON.parse(text(previous, 'result')) as WorkspaceAuthoringResult
      }
      ensureProject(projectId)
      checkRevision(projectId, expectedRevision)
      const result: WorkspaceAuthoringResult = { requestId, ...work() }
      assertBudget(projectId)
      db.prepare('INSERT INTO authoring_receipts VALUES(?,?,?,?,?,?,?)').run(
        projectId,
        requestId,
        actorId,
        operation,
        fingerprint,
        JSON.stringify(result),
        now(),
      )
      return result
    })
    collectUnusedQuietly()
    return result
  }
  function queueExtraction(
    projectId: string,
    actorId: string,
    entry: WorkspaceMaterialEntry,
  ): Promise<void> {
    const contentHash = entry.sha256!
    const key = contentHash + ':' + entry.mime
    const existing = processing.get(key)
    if (existing) return existing
    if (extraction(contentHash, entry.mime).status !== 'pending') return Promise.resolve()
    if (processing.size >= 2) {
      db.prepare(
        "UPDATE authoring_extractions SET status='unavailable',code='DOCUMENT_CAPACITY',message='正文处理繁忙，原件已保存，请稍后重新处理' WHERE hash=? AND mime=? AND status='pending'",
      ).run(contentHash, entry.mime)
      return Promise.resolve()
    }
    const job = (async () => {
      try {
        authorize(projectId, actorId, 'read')
        const result = await extractBusinessAttachment({
          id: contentHash,
          name: entry.name,
          mime: entry.mime,
          bytes: original(contentHash),
        })
        authorize(projectId, actorId, 'read')
        db.prepare(
          'UPDATE authoring_extractions SET status=?,content=?,code=?,message=? WHERE hash=? AND mime=?',
        ).run(
          typeof result.content === 'string' ? 'ready' : 'unavailable',
          result.content ?? null,
          typeof result.extraction.code === 'string' ? result.extraction.code : null,
          typeof result.extraction.message === 'string'
            ? result.extraction.message
            : typeof result.content === 'string'
              ? null
              : '此原件没有可提取的文字，请查看或下载原件',
          contentHash,
          entry.mime,
        )
      } catch {
        if (!closed)
          db.prepare(
            "UPDATE authoring_extractions SET status='unavailable',content=NULL,code='DOCUMENT_PROCESSING_FAILED',message='正文处理未完成或读取权限已失效，原件已保存' WHERE hash=? AND mime=?",
          ).run(contentHash, entry.mime)
      }
    })()
    processing.set(key, job)
    void job
      .finally(() => {
        processing.delete(key)
        collectUnusedQuietly()
      })
      .catch(() => {})
    return job
  }
  function storeBytes(
    projectId: string,
    actorId: string,
    operation: string,
    input: WorkspaceUploadInput,
    bytes: Uint8Array,
    contentRevision?: string,
  ): WorkspaceAuthoringResult {
    authorize(projectId, actorId, 'manage', true)
    const target = path(input.path)
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > limits.maxFileBytes ||
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      input.size !== bytes.byteLength
    )
      fail(413, 'WORKSPACE_UPLOAD_SIZE', '上传大小不符或超过 8 MiB 上限')
    const contentHash = hash(bytes)
    if (typeof input.sha256 !== 'string' || contentHash !== input.sha256)
      fail(400, 'WORKSPACE_UPLOAD_CHECKSUM', '上传内容与声明的 SHA-256 不一致')
    if (!['replace', 'keep-both', 'skip'].includes(input.conflict))
      fail(400, 'WORKSPACE_UPLOAD_CONFLICT_POLICY', '请选择同名文件处理方式')
    const mime = mimeFor(target, bytes)
    try {
      return mutation(
        projectId,
        actorId,
        operation,
        input,
        {
          path: target,
          size: input.size,
          sha256: contentHash,
          conflict: input.conflict,
          ...(contentRevision ? { contentRevision } : {}),
        },
        () => {
          assertWritable(projectId, target)
          let entryPath = target
          let previous = db
            .prepare('SELECT * FROM authoring_entries WHERE project_id=? AND path=?')
            .get(projectId, target)
          if (contentRevision) currentEntry(projectId, target, contentRevision)
          if (previous?.kind === 'directory')
            fail(409, 'WORKSPACE_PATH_CONFLICT', '目标路径是目录，不能替换为文件')
          if (previous && input.conflict === 'skip')
            return {
              revision: projectRevision(projectId),
              entry: entryFrom(entryRow(projectId, target)),
              skipped: true,
            }
          if (previous && input.conflict === 'keep-both') {
            const extension = extname(target),
              stem = target.slice(0, target.length - extension.length)
            let suffix = 2
            while (
              db
                .prepare('SELECT 1 FROM authoring_entries WHERE project_id=? AND path=?')
                .get(projectId, entryPath)
            )
              entryPath = path(`${stem} (${suffix++})${extension}`)
            previous = undefined
          }
          ensureParents(projectId, entryPath)
          putOriginal(contentHash, bytes)
          db.prepare('INSERT OR IGNORE INTO authoring_blobs VALUES(?,?)').run(
            contentHash,
            bytes.byteLength,
          )
          const decoded = plainText(bytes)
          const textFormat =
            mime.startsWith('text/') ||
            ['application/json', 'application/xml', 'image/svg+xml'].includes(mime)
          const textReady =
            textFormat &&
            decoded !== null &&
            decoded.length <= BUSINESS_DOCUMENT_LIMITS.maxTextCharacters
          const textExceeded =
            textFormat &&
            decoded !== null &&
            decoded.length > BUSINESS_DOCUMENT_LIMITS.maxTextCharacters
          db.prepare('INSERT OR IGNORE INTO authoring_extractions VALUES(?,?,?,?,?,?,?)').run(
            contentHash,
            mime,
            parserVersion,
            textReady ? 'ready' : textExceeded ? 'unavailable' : 'pending',
            textReady ? decoded : null,
            textExceeded ? 'TEXT_CHARACTER_LIMIT' : null,
            textExceeded ? '正文超过提取字数上限，原件仍可下载' : null,
          )
          db.prepare(
            "INSERT INTO authoring_entries VALUES(?,?,?,'file',?,?,?,?) ON CONFLICT(project_id,path) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,hash=excluded.hash,mime=excluded.mime",
          ).run(
            projectId,
            entryPath,
            previous?.id ?? randomUUID(),
            randomUUID(),
            now(),
            contentHash,
            mime,
          )
          return { revision: advance(projectId), entry: entryFrom(entryRow(projectId, entryPath)) }
        },
      )
    } catch (error) {
      if (!db.prepare('SELECT 1 FROM authoring_blobs WHERE hash=?').get(contentHash))
        rmSync(join(blobRoot, contentHash), { force: true })
      throw error
    }
  }
  function captureRow(projectId: string, captureId: string) {
    const row = db
      .prepare('SELECT * FROM authoring_captures WHERE project_id=? AND id=?')
      .get(projectId, id(captureId))
    if (!row) fail(404, 'WORKSPACE_CAPTURE_NOT_FOUND', '固定输入收据不存在')
    return row
  }
  function captureFrom(row: Row): WorkspaceAuthoringCapture {
    const captureId = text(row, 'id')
    return {
      id: captureId,
      projectId: text(row, 'project_id'),
      requestId: text(row, 'request_id'),
      revision: Number(row.revision),
      createdAt: text(row, 'created_at'),
      status: text(row, 'status') as WorkspaceAuthoringCapture['status'],
      resolution: text(row, 'resolution') as WorkspaceAuthoringCapture['resolution'],
      sources: db
        .prepare('SELECT * FROM authoring_capture_sources WHERE capture_id=? ORDER BY source_id')
        .all(captureId)
        .map(sourceFrom),
      files: db
        .prepare('SELECT * FROM authoring_capture_files WHERE capture_id=? ORDER BY path')
        .all(captureId)
        .map((file): WorkspaceCapturedFile => ({
          path: text(file, 'path'),
          id: text(file, 'id'),
          revision: text(file, 'revision'),
          sha256: text(file, 'hash'),
          size: Number(file.size),
          mime: text(file, 'mime'),
          extraction: extraction(text(file, 'hash'), text(file, 'mime')),
        })),
      directories: db
        .prepare('SELECT path FROM authoring_capture_directories WHERE capture_id=? ORDER BY path')
        .all(captureId)
        .map((file) => text(file, 'path')),
      ...(row.resolution_error
        ? {
            resolutionError: JSON.parse(text(row, 'resolution_error')) as {
              code: string
              message: string
            },
          }
        : {}),
      ...(row.resolved_repositories
        ? {
            resolvedRepositories: JSON.parse(
              text(row, 'resolved_repositories'),
            ) as WorkspaceResolvedRepository[],
          }
        : {}),
    }
  }
  const repositoryRows = (projectId: string): ProjectRepositoryConnection[] =>
    db
      .prepare('SELECT * FROM authoring_repositories WHERE project_id=? ORDER BY id')
      .all(projectId)
      .map((row) => ({
        id: text(row, 'id'),
        name: text(row, 'name'),
        url: text(row, 'url'),
        ...(row.credential_id ? { credentialId: text(row, 'credential_id') } : {}),
      }))
  const repository = (projectId: string, repositoryId: string) =>
    repositoryRows(projectId).find((value) => value.id === repositoryId) ??
    fail(404, 'REPOSITORY_NOT_FOUND', '项目仓库连接不存在')
  const persistRepository = (projectId: string, value: ProjectRepositoryConnection) =>
    db
      .prepare(
        'INSERT INTO authoring_repositories VALUES(?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET name=excluded.name,url=excluded.url,credential_id=excluded.credential_id',
      )
      .run(projectId, value.id, value.name, value.url, value.credentialId ?? null)
  function persistSource(projectId: string, value: WorkspaceRepositorySource) {
    const current = sources(projectId)
    if (!current.some((source) => source.id === value.id)) {
      // 新接入或重新添加不是旧current接管，显式移除的旧档案不能复活。
      db.prepare('INSERT OR IGNORE INTO authoring_current_adoptions VALUES(?,?,?)').run(
        projectId,
        value.id,
        now(),
      )
      db.prepare('DELETE FROM authoring_source_sync WHERE project_id=? AND source_id=?').run(
        projectId,
        value.id,
      )
    }
    if (!current.some((source) => source.id === value.id) && current.length >= 32)
      fail(413, 'WORKSPACE_SOURCE_LIMIT', '最多配置 32 个工作区仓库')
    if (
      current.some(
        (source) => source.id !== value.id && overlaps(source.mountPath, value.mountPath),
      ) ||
      rows(projectId).some((entry) => overlaps(text(entry, 'path'), value.mountPath))
    )
      fail(409, 'WORKSPACE_MOUNT_CONFLICT', '仓库挂载与其他来源或资料目录重叠')
    db.prepare(
      'INSERT INTO authoring_sources VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET role=excluded.role,ref_kind=excluded.ref_kind,ref=excluded.ref,mount_path=excluded.mount_path,source_path=excluded.source_path',
    ).run(
      projectId,
      value.id,
      value.role,
      value.refKind,
      value.ref,
      value.mountPath,
      value.sourcePath ?? null,
    )
    return { revision: advance(projectId), source: value }
  }
  const api = {
    // 仅由组合根在升级时接管已有效事实，不向HTTP、模型或普通业务请求开放。
    currentAdoptionProjects(): string[] {
      if (closed) fail(503, 'WORKSPACE_AUTHORING_STOPPING', '工作区资料服务已关闭')
      return db
        .prepare(
          'SELECT DISTINCT s.project_id FROM authoring_sources s WHERE NOT EXISTS(SELECT 1 FROM authoring_current_adoptions a WHERE a.project_id=s.project_id AND a.source_id=s.id)',
        )
        .all()
        .map((row) => text(row, 'project_id'))
    },
    currentAdoptionSources(
      projectId: string,
    ): Array<{ source: WorkspaceRepositorySource; record?: WorkspaceSourceSyncRecord }> {
      if (closed) fail(503, 'WORKSPACE_AUTHORING_STOPPING', '工作区资料服务已关闭')
      return sources(id(projectId))
        .filter(
          (source) =>
            !db
              .prepare(
                'SELECT 1 FROM authoring_current_adoptions WHERE project_id=? AND source_id=?',
              )
              .get(projectId, source.id),
        )
        .map((source) => {
          const row = db
            .prepare('SELECT value FROM authoring_source_sync WHERE project_id=? AND source_id=?')
            .get(projectId, source.id)
          return {
            source,
            ...(row ? { record: JSON.parse(text(row, 'value')) as WorkspaceSourceSyncRecord } : {}),
          }
        })
    },
    adoptCurrentSources(
      projectId: string,
      selections: Array<{
        sourceId: string
        configurationHash: string
        current?: WorkspaceInputRepository
      }>,
    ) {
      if (closed || stopped) fail(503, 'WORKSPACE_AUTHORING_STOPPING', '工作区资料服务正在停止')
      return transaction.run(() => {
        const configured = sources(id(projectId))
        for (const selected of selections) {
          if (
            db
              .prepare(
                'SELECT 1 FROM authoring_current_adoptions WHERE project_id=? AND source_id=?',
              )
              .get(projectId, id(selected.sourceId))
          )
            continue
          const source = configured.find((value) => value.id === selected.sourceId)
          if (!source || hash(JSON.stringify(source)) !== selected.configurationHash)
            fail(409, 'WORKSPACE_CURRENT_ADOPTION_CONFLICT', '接管期间来源配置已改变，请重新核对')
          const row = db
            .prepare('SELECT value FROM authoring_source_sync WHERE project_id=? AND source_id=?')
            .get(projectId, source.id)
          const stored = row
            ? (JSON.parse(text(row, 'value')) as WorkspaceSourceSyncRecord)
            : undefined
          const previous =
            stored?.configurationHash === selected.configurationHash ? stored : undefined
          if (
            selected.current &&
            (!previous?.versionId || previous.versionId === selected.current.versionId)
          ) {
            if (
              selected.current.sourceId !== source.id ||
              hash(JSON.stringify(selected.current.source)) !== selected.configurationHash
            )
              fail(409, 'WORKSPACE_CURRENT_ADOPTION_CONFLICT', '接管的原来源身份不一致')
            const value: WorkspaceSourceSyncRecord = {
              ...(previous ?? {
                sourceId: source.id,
                configurationHash: selected.configurationHash,
                requestId: `adopt:${selected.current.versionId}`,
                status: 'synced',
                updatedAt: now(),
              }),
              current: selected.current,
              currentOrigin: previous?.versionId ? (previous.currentOrigin ?? 'sync') : 'snapshot',
              versionId: selected.current.versionId,
              commit: selected.current.commit,
            }
            db.prepare(
              'INSERT INTO authoring_source_sync VALUES(?,?,?) ON CONFLICT(project_id,source_id) DO UPDATE SET value=excluded.value',
            ).run(projectId, source.id, JSON.stringify(value))
          } else if (previous?.versionId && !previous.current) {
            fail(409, 'WORKSPACE_CURRENT_ADOPTION_CONFLICT', '接管期间当前版本已改变，请重新核对')
          } else if (stored && !previous) {
            // 升级前该配置没有有效当前版本，不能把另一配置的旧行变成新当前事实。
            db.prepare('DELETE FROM authoring_source_sync WHERE project_id=? AND source_id=?').run(
              projectId,
              source.id,
            )
          }
          db.prepare('INSERT INTO authoring_current_adoptions VALUES(?,?,?)').run(
            projectId,
            source.id,
            now(),
          )
        }
        return selections.flatMap((selected) => {
          const row = db
            .prepare('SELECT value FROM authoring_source_sync WHERE project_id=? AND source_id=?')
            .get(projectId, selected.sourceId)
          return row ? [JSON.parse(text(row, 'value')) as WorkspaceSourceSyncRecord] : []
        })
      })
    },
    repositories(projectId: string, actorId: string) {
      authorize(projectId, actorId, 'repository-read')
      return { revision: projectRevision(projectId), items: repositoryRows(projectId) }
    },
    saveRepository(
      projectId: string,
      repositoryId: string | null,
      input: ProjectRepositoryCommand,
      actorId: string,
    ) {
      const value = normalizeRepository(input.value)
      if (repositoryId !== null) id(repositoryId)
      return mutation(projectId, actorId, 'save-repository', input, { repositoryId, value }, () => {
        if (repositoryId !== null) repository(projectId, repositoryId)
        else if (repositoryRows(projectId).length >= 32)
          fail(413, 'REPOSITORY_LIMIT', '每个项目最多配置 32 个仓库连接')
        const saved = { ...value, id: repositoryId ?? randomUUID() }
        options.validateRepository?.(actorId, projectId, saved)
        persistRepository(projectId, saved)
        return { revision: advance(projectId), repository: saved }
      })
    },
    removeRepository(
      projectId: string,
      repositoryId: string,
      input: WorkspaceAuthoringMutation,
      actorId: string,
    ) {
      id(repositoryId)
      return mutation(projectId, actorId, 'remove-repository', input, { repositoryId }, () => {
        repository(projectId, repositoryId)
        if (sources(projectId).some((value) => value.id === repositoryId))
          fail(
            409,
            'REPOSITORY_IN_USE',
            '请先移除工作区使用配置，再删除仓库连接；已固定任务仍保留原来源',
          )
        db.prepare('DELETE FROM authoring_repositories WHERE project_id=? AND id=?').run(
          projectId,
          repositoryId,
        )
        return { revision: advance(projectId) }
      })
    },
    configureSource(projectId: string, input: WorkspaceRepositoryUsage, actorId: string) {
      authorize(projectId, actorId, 'manage', true)
      if (
        !input ||
        Object.keys(input).some(
          (key) =>
            ![
              'requestId',
              'expectedRevision',
              'id',
              'role',
              'refKind',
              'ref',
              'mountPath',
              'sourcePath',
            ].includes(key),
        )
      )
        fail(400, 'REPOSITORY_USAGE_INVALID', '工作区只选择已配置仓库及自己的分支和目录')
      id(input.id)
      return mutation(projectId, actorId, 'configure-source', input, input, () => {
        const selected = repository(projectId, input.id)
        return persistSource(projectId, normalizeSource({ ...input, ...selected }, input.id))
      })
    },
    overview(projectId: string, actorId: string): WorkspaceAuthoringOverview {
      authorize(projectId, actorId, 'read')
      return {
        projectId,
        revision: projectRevision(projectId),
        sources: sources(projectId),
        entries: rows(projectId).map(entryFrom),
        limits: { ...limits },
      }
    },
    deletionReferences(projectId: string, environmentId?: string) {
      if (environmentId !== undefined) return []
      const count = (query: string) => Number(db.prepare(query).get(projectId)?.n ?? 0)
      return [
        {
          kind: 'workspace-current',
          count: count('SELECT COUNT(*) AS n FROM authoring_entries WHERE project_id=?'),
          message: '工作区仍有当前资料',
        },
        {
          kind: 'project-repositories',
          count: count('SELECT COUNT(*) AS n FROM authoring_repositories WHERE project_id=?'),
          message: '项目仍有仓库连接',
        },
        {
          kind: 'workspace-inputs',
          count: count(
            "SELECT COUNT(*) AS n FROM authoring_captures WHERE project_id=? AND status='active'",
          ),
          message: '资料仍有活动或未知输入',
        },
        {
          kind: 'workspace-fixed-inputs',
          count: count(
            "SELECT COUNT(*) AS n FROM authoring_inputs WHERE project_id=? AND json_extract(value,'$.status')='active'",
          ),
          message: '仍有活动或未知固定输入',
        },
        {
          kind: 'workspace-preparing-inputs',
          count: count('SELECT COUNT(*) AS n FROM authoring_input_preparations WHERE project_id=?'),
          message: '仍有尚未交接的固定资料选择',
        },
      ].filter((value) => value.count > 0)
    },
    removeSource(
      projectId: string,
      sourceId: string,
      input: WorkspaceAuthoringMutation,
      actorId: string,
    ) {
      id(sourceId)
      return mutation(projectId, actorId, 'remove-source', input, { sourceId }, () => {
        if (!sources(projectId).some((source) => source.id === sourceId))
          fail(404, 'WORKSPACE_SOURCE_NOT_FOUND', '仓库来源不存在')
        // 已接受输入保留独立来源定义和提交，移除当前配置不改变任何历史输入。
        db.prepare('DELETE FROM authoring_sources WHERE project_id=? AND id=?').run(
          projectId,
          sourceId,
        )
        db.prepare('INSERT OR IGNORE INTO authoring_current_adoptions VALUES(?,?,?)').run(
          projectId,
          sourceId,
          now(),
        )
        db.prepare('DELETE FROM authoring_source_sync WHERE project_id=? AND source_id=?').run(
          projectId,
          sourceId,
        )
        return { revision: advance(projectId) }
      })
    },
    createDirectory(
      projectId: string,
      input: WorkspaceAuthoringMutation & { path: string },
      actorId: string,
    ) {
      const target = path(input.path)
      return mutation(projectId, actorId, 'create-directory', input, { path: target }, () => {
        assertWritable(projectId, target)
        if (
          db
            .prepare('SELECT 1 FROM authoring_entries WHERE project_id=? AND path=?')
            .get(projectId, target)
        )
          fail(409, 'WORKSPACE_PATH_CONFLICT', '目标路径已存在')
        ensureParents(projectId, target)
        db.prepare(
          "INSERT INTO authoring_entries VALUES(?,?,?,'directory',?,?,NULL,'inode/directory')",
        ).run(projectId, target, randomUUID(), randomUUID(), now())
        return { revision: advance(projectId), entry: entryFrom(entryRow(projectId, target)) }
      })
    },
    async upload(
      projectId: string,
      input: WorkspaceUploadInput,
      bytes: Uint8Array,
      actorId: string,
    ) {
      const result = storeBytes(projectId, actorId, 'upload', input, bytes)
      if (result.entry?.sha256 && !result.skipped)
        await queueExtraction(projectId, actorId, result.entry)
      return result
    },
    saveText(projectId: string, input: WorkspaceTextSaveInput, actorId: string) {
      authorize(projectId, actorId, 'manage', true)
      const target = path(input.path)
      if (typeof input.contents !== 'string' || !/\.(?:md|txt)$/i.test(target))
        fail(400, 'WORKSPACE_EDIT_UNSUPPORTED', '仅 Markdown 和纯文本资料支持在线编辑')
      if (typeof input.expectedContentRevision !== 'string' || !input.expectedContentRevision)
        fail(400, 'WORKSPACE_CONTENT_REVISION_REQUIRED', '保存文本需要原文件的内容修订条件')
      const bytes = Buffer.from(input.contents)
      if (plainText(bytes) === null) fail(400, 'WORKSPACE_TEXT_INVALID', '文本不能包含二进制内容')
      return storeBytes(
        projectId,
        actorId,
        'save-text',
        { ...input, size: bytes.length, sha256: hash(bytes), conflict: 'replace' },
        bytes,
        input.expectedContentRevision,
      )
    },
    move(projectId: string, input: WorkspaceMoveInput, actorId: string) {
      const from = path(input.path),
        destination = path(input.destination)
      return mutation(
        projectId,
        actorId,
        'move',
        input,
        { path: from, destination, expectedContentRevision: input.expectedContentRevision },
        () => {
          assertWritable(projectId, from)
          assertWritable(projectId, destination)
          const current = currentEntry(projectId, from, input.expectedContentRevision)
          if (overlaps(from, destination))
            fail(409, 'WORKSPACE_PATH_CONFLICT', '不能移动到自身或父子重叠目录')
          const moving = rows(projectId).filter(
            (entry) => entry.path === from || text(entry, 'path').startsWith(from + '/'),
          )
          for (const entry of moving) {
            const next = path(destination + text(entry, 'path').slice(from.length))
            if (
              db
                .prepare('SELECT 1 FROM authoring_entries WHERE project_id=? AND path=?')
                .get(projectId, next)
            )
              fail(409, 'WORKSPACE_PATH_CONFLICT', '目标已有同名资料，请先处理冲突')
          }
          ensureParents(projectId, destination)
          for (const entry of moving)
            db.prepare(
              'UPDATE authoring_entries SET path=?,revision=?,updated_at=? WHERE project_id=? AND path=?',
            ).run(
              destination + text(entry, 'path').slice(from.length),
              randomUUID(),
              now(),
              projectId,
              text(entry, 'path'),
            )
          if (
            current.kind === 'file' &&
            extname(from).toLowerCase() !== extname(destination).toLowerCase()
          )
            fail(400, 'WORKSPACE_RENAME_EXTENSION', '改名请保留文件格式扩展名')
          return {
            revision: advance(projectId),
            entry: entryFrom(entryRow(projectId, destination)),
          }
        },
      )
    },
    remove(projectId: string, input: WorkspaceDeleteInput, actorId: string) {
      const target = path(input.path)
      return mutation(
        projectId,
        actorId,
        'remove',
        input,
        { path: target, expectedContentRevision: input.expectedContentRevision },
        () => {
          assertWritable(projectId, target)
          currentEntry(projectId, target, input.expectedContentRevision)
          for (const entry of rows(projectId).filter(
            (entry) => entry.path === target || text(entry, 'path').startsWith(target + '/'),
          ))
            db.prepare('DELETE FROM authoring_entries WHERE project_id=? AND path=?').run(
              projectId,
              text(entry, 'path'),
            )
          return { revision: advance(projectId) }
        },
      )
    },
    receipt(
      projectId: string,
      requestId: string,
      actorId: string,
    ): WorkspaceAuthoringResult | null {
      authorize(projectId, actorId, 'manage')
      const row = db
        .prepare(
          'SELECT result FROM authoring_receipts WHERE project_id=? AND request_id=? AND actor_id=?',
        )
        .get(projectId, requestIdentifier(requestId), actorId)
      return row ? (JSON.parse(text(row, 'result')) as WorkspaceAuthoringResult) : null
    },
    tree(projectId: string, directoryPath: string, actorId: string) {
      authorize(projectId, actorId, 'read')
      const selected = path(directoryPath, true),
        prefix = selected ? selected + '/' : ''
      if (selected && entryRow(projectId, selected).kind !== 'directory')
        fail(400, 'WORKSPACE_NOT_DIRECTORY', '请选择资料目录')
      const entries = rows(projectId)
        .map(entryFrom)
        .filter(
          (entry) =>
            entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/'),
        )
      return { entries: entries.slice(0, 500), truncated: entries.length > 500 }
    },
    search(projectId: string, query: string, actorId: string, maximum = 200) {
      authorize(projectId, actorId, 'read')
      if (
        typeof query !== 'string' ||
        query.length > 256 ||
        !Number.isSafeInteger(maximum) ||
        maximum < 1 ||
        maximum > 500
      )
        fail(400, 'WORKSPACE_SEARCH_INVALID', '搜索文字或条数无效')
      const entries = rows(projectId)
        .map(entryFrom)
        .filter((entry) => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      return { entries: entries.slice(0, maximum), truncated: entries.length > maximum }
    },
    readFile(projectId: string, filePath: string, actorId: string) {
      authorize(projectId, actorId, 'read')
      const row = entryRow(projectId, path(filePath))
      if (row.kind !== 'file') fail(400, 'WORKSPACE_NOT_FILE', '请选择资料文件')
      return { ...entryFrom(row), bytes: original(text(row, 'hash')) }
    },
    readContent(projectId: string, filePath: string, actorId: string): WorkspaceMaterialContent {
      const file = api.readFile(projectId, filePath, actorId)
      const extracted = db
        .prepare('SELECT content FROM authoring_extractions WHERE hash=? AND mime=?')
        .get(file.sha256!, file.mime)
      return {
        path: file.path,
        revision: file.revision,
        mime: file.mime,
        size: file.size,
        sha256: file.sha256!,
        extraction: extraction(file.sha256!, file.mime),
        ...(typeof extracted?.content === 'string' ? { contents: extracted.content } : {}),
      }
    },
    async retryExtraction(
      projectId: string,
      input: WorkspaceExtractionRetryInput,
      actorId: string,
    ): Promise<WorkspaceAuthoringResult> {
      const filePath = path(input.path)
      let accepted = false
      const result = mutation(
        projectId,
        actorId,
        'retry-extraction',
        input,
        { path: filePath, expectedContentRevision: input.expectedContentRevision },
        () => {
          const row = currentEntry(projectId, filePath, input.expectedContentRevision)
          if (row.kind !== 'file') fail(400, 'WORKSPACE_NOT_FILE', '请选择资料文件')
          if (extraction(text(row, 'hash'), text(row, 'mime')).status !== 'unavailable')
            fail(409, 'WORKSPACE_EXTRACTION_STATE', '此资料已经可读或正在提取，请刷新后查看原结果')
          db.prepare(
            "UPDATE authoring_extractions SET status='pending',content=NULL,code=NULL,message=NULL WHERE hash=? AND mime=?",
          ).run(text(row, 'hash'), text(row, 'mime'))
          accepted = true
          return { revision: projectRevision(projectId), entry: entryFrom(row) }
        },
      )
      if (accepted && result.entry) await queueExtraction(projectId, actorId, result.entry)
      return result
    },
    capture(
      projectId: string,
      expectedRevision: number | undefined,
      actorId: string,
      requestId: string,
      selection?: { sources: WorkspaceRepositorySource[]; documents: boolean },
    ): WorkspaceAuthoringCapture {
      authorize(projectId, actorId, 'read', true)
      if (expectedRevision !== undefined) revision(expectedRevision)
      requestIdentifier(requestId)
      return transaction.run(() => {
        if (
          db
            .prepare('SELECT 1 FROM authoring_receipts WHERE project_id=? AND request_id=?')
            .get(projectId, requestId)
        )
          fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原请求标识已用于修改资料或来源，请核对原结果')
        const previous = db
          .prepare('SELECT * FROM authoring_captures WHERE project_id=? AND request_id=?')
          .get(projectId, requestId)
        if (previous) {
          if (
            previous.actor_id !== actorId ||
            (expectedRevision !== undefined && previous.revision !== expectedRevision)
          )
            fail(409, 'WORKSPACE_REQUEST_CONFLICT', '固定输入请求已用于其他修订或操作人')
          return captureFrom(previous)
        }
        ensureProject(projectId)
        const capturedRevision = expectedRevision ?? projectRevision(projectId)
        checkRevision(projectId, capturedRevision)
        const captureId = randomUUID(),
          configured = selection?.sources ?? sources(projectId)
        db.prepare('INSERT INTO authoring_captures VALUES(?,?,?,?,?,?,?, ?,NULL,?)').run(
          captureId,
          projectId,
          actorId,
          requestId,
          capturedRevision,
          now(),
          'active',
          configured.length ? 'pending' : 'resolved',
          configured.length ? null : '[]',
        )
        for (const source of configured)
          db.prepare('INSERT INTO authoring_capture_sources VALUES(?,?,?,?,?,?,?,?,?,?)').run(
            captureId,
            source.id,
            source.name,
            source.role,
            source.url,
            source.refKind,
            source.ref,
            source.mountPath,
            source.sourcePath ?? null,
            source.credentialId ?? null,
          )
        for (const entry of selection?.documents === false ? [] : rows(projectId)) {
          if (entry.kind === 'directory')
            db.prepare('INSERT INTO authoring_capture_directories VALUES(?,?)').run(
              captureId,
              text(entry, 'path'),
            )
          else {
            original(text(entry, 'hash'))
            db.prepare('INSERT INTO authoring_capture_files VALUES(?,?,?,?,?,?,?)').run(
              captureId,
              text(entry, 'path'),
              text(entry, 'id'),
              text(entry, 'revision'),
              text(entry, 'hash'),
              Number(entry.size),
              text(entry, 'mime'),
            )
          }
        }
        return captureFrom(captureRow(projectId, captureId))
      })
    },
    readCaptured(projectId: string, captureId: string, actorId: string) {
      authorize(projectId, actorId, 'read')
      const owned = captureRow(projectId, captureId)
      if (owned.actor_id !== actorId)
        fail(404, 'WORKSPACE_CAPTURE_NOT_FOUND', '固定输入不存在或无权访问')
      return captureFrom(owned)
    },
    capturedRepositoryMetadata(projectId: string, captureId: string, sourceId: string) {
      if (closed) fail(503, 'WORKSPACE_AUTHORING_STOPPING', '工作区资料服务已关闭')
      const captured = captureFrom(captureRow(projectId, captureId))
      const source = captured.sources.find((value) => value.id === sourceId)
      const resolved = captured.resolvedRepositories?.find((value) => value.sourceId === sourceId)
      if (!source || !resolved)
        fail(409, 'WORKSPACE_CURRENT_SOURCE_MISSING', '已同步源码的原来源身份不可核验')
      // 只返回项目已同步源码的非秘密来源；不开放其他调用者的文档捕获。
      return { source, resolved }
    },
    captureByRequest(
      projectId: string,
      requestId: string,
      actorId: string,
    ): WorkspaceAuthoringCapture | null {
      authorize(projectId, actorId, 'read')
      const row = db
        .prepare(
          'SELECT * FROM authoring_captures WHERE project_id=? AND request_id=? AND actor_id=?',
        )
        .get(projectId, requestIdentifier(requestId), actorId)
      return row ? captureFrom(row) : null
    },
    readCapturedFile(projectId: string, captureId: string, filePath: string, actorId: string) {
      authorize(projectId, actorId, 'read')
      const captured = captureRow(projectId, captureId)
      if (captured.actor_id !== actorId)
        fail(404, 'WORKSPACE_CAPTURE_NOT_FOUND', '固定输入不存在或无权访问')
      if (captured.status !== 'active')
        fail(410, 'WORKSPACE_CAPTURE_RELEASED', '固定输入已交接或释放，请读取对应任务版本')
      const file = db
        .prepare('SELECT * FROM authoring_capture_files WHERE capture_id=? AND path=?')
        .get(captureId, path(filePath))
      if (!file) fail(404, 'WORKSPACE_MATERIAL_NOT_FOUND', '固定输入中没有此资料')
      return {
        bytes: original(text(file, 'hash')),
        name: fileName(filePath),
        mime: text(file, 'mime'),
        revision: text(file, 'revision'),
        sha256: text(file, 'hash'),
      }
    },
    readCapturedContent(
      projectId: string,
      captureId: string,
      filePath: string,
      actorId: string,
    ): WorkspaceMaterialContent {
      const file = api.readCapturedFile(projectId, captureId, filePath, actorId)
      const extracted = db
        .prepare('SELECT content FROM authoring_extractions WHERE hash=? AND mime=?')
        .get(file.sha256, file.mime)
      return {
        path: filePath,
        revision: file.revision,
        mime: file.mime,
        size: file.bytes.byteLength,
        sha256: file.sha256,
        extraction: extraction(file.sha256, file.mime),
        ...(typeof extracted?.content === 'string' ? { contents: extracted.content } : {}),
      }
    },
    freezeCaptureRepositories(
      projectId: string,
      captureId: string,
      resolved: WorkspaceResolvedRepository[],
      actorId: string,
    ) {
      authorize(projectId, actorId, 'read', true)
      return transaction.run(() => {
        const owned = captureRow(projectId, captureId)
        if (owned.actor_id !== actorId)
          fail(404, 'WORKSPACE_CAPTURE_NOT_FOUND', '固定输入不存在或无权访问')
        const captured = captureFrom(owned)
        if (captured.status !== 'active' || captured.resolution === 'failed')
          fail(409, 'WORKSPACE_CAPTURE_STATE', '固定输入已经结束或来源解析失败')
        if (!Array.isArray(resolved) || resolved.length !== captured.sources.length)
          fail(400, 'WORKSPACE_CAPTURE_RESOLUTION', '必须一次固定全部仓库提交')
        const values = resolved
          .map((item) => {
            if (!item || typeof item !== 'object')
              fail(400, 'WORKSPACE_CAPTURE_RESOLUTION', '固定来源格式无效')
            const source = captured.sources.find((source) => source.id === item.sourceId)
            if (
              !source ||
              !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.commit) ||
              item.refKind !== source.refKind ||
              typeof item.ref !== 'string' ||
              !(typeof item.defaultRef === 'string' || item.defaultRef === null)
            )
              fail(400, 'WORKSPACE_CAPTURE_RESOLUTION', '固定来源与原配置不一致')
            if (
              (source.refKind !== 'default' && item.ref !== source.ref) ||
              (source.refKind === 'commit' && item.commit !== source.ref)
            )
              fail(
                400,
                'WORKSPACE_CAPTURE_RESOLUTION',
                '解析结果不能替换用户选择的分支、标签或提交',
              )
            if (
              (source.credentialId &&
                (!item.credentialVersion ||
                  item.credentialVersion.projectId !== projectId ||
                  item.credentialVersion.credentialId !== source.credentialId ||
                  !Number.isSafeInteger(item.credentialVersion.version) ||
                  item.credentialVersion.version < 1)) ||
              (!source.credentialId && item.credentialVersion)
            )
              fail(400, 'WORKSPACE_CAPTURE_CREDENTIAL', '固定凭证引用与来源不一致')
            return {
              sourceId: item.sourceId,
              commit: item.commit,
              refKind: item.refKind,
              ref: item.ref,
              defaultRef: item.defaultRef,
              ...(item.credentialVersion
                ? {
                    credentialVersion: {
                      projectId,
                      credentialId: item.credentialVersion.credentialId,
                      version: item.credentialVersion.version,
                    },
                  }
                : {}),
            }
          })
          .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
        if (new Set(values.map((item) => item.sourceId)).size !== values.length)
          fail(400, 'WORKSPACE_CAPTURE_RESOLUTION', '固定来源不能重复')
        if (captured.resolution === 'resolved') {
          if (JSON.stringify(values) !== JSON.stringify(captured.resolvedRepositories))
            fail(409, 'WORKSPACE_REQUEST_CONFLICT', '此输入已固定其他提交，不能重新解析分支')
          return captured
        }
        db.prepare(
          "UPDATE authoring_captures SET resolution='resolved',resolved_repositories=? WHERE id=?",
        ).run(JSON.stringify(values), captureId)
        return captureFrom(captureRow(projectId, captureId))
      })
    },
    failCaptureResolution(
      projectId: string,
      captureId: string,
      error: { code: string; message: string },
      actorId: string,
    ) {
      authorize(projectId, actorId, 'read', true)
      const captured = captureRow(projectId, captureId)
      if (captured.actor_id !== actorId)
        fail(404, 'WORKSPACE_CAPTURE_NOT_FOUND', '固定输入不存在或无权访问')
      if (captured.resolution === 'resolved')
        fail(409, 'WORKSPACE_CAPTURE_STATE', '来源已经固定，不能改写解析结果')
      if (typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code))
        fail(400, 'WORKSPACE_CAPTURE_RESOLUTION', '解析错误标识无效')
      // 外部错误原文可能包含凭据，收据只保留稳定原因与受控提示。
      const safeError = {
        code: error.code,
        message: '仓库来源解析未完成，请核对配置后发起新的生成请求',
      }
      if (captured.resolution !== 'failed')
        db.prepare(
          "UPDATE authoring_captures SET resolution='failed',resolution_error=? WHERE id=?",
        ).run(JSON.stringify(safeError), captureId)
      return captureFrom(captureRow(projectId, captureId))
    },
    releaseCapture(projectId: string, captureId: string, actorId: string) {
      authorize(projectId, actorId, 'read', true)
      if (captureRow(projectId, captureId).actor_id !== actorId)
        fail(404, 'WORKSPACE_CAPTURE_NOT_FOUND', '固定输入不存在或无权访问')
      db.prepare("UPDATE authoring_captures SET status='released' WHERE id=? AND project_id=?").run(
        captureId,
        projectId,
      )
      const owned = captureRow(projectId, captureId)
      if (owned.actor_id !== actorId)
        fail(404, 'WORKSPACE_CAPTURE_NOT_FOUND', '固定输入不存在或无权访问')
      const captured = captureFrom(owned)
      collectUnusedQuietly()
      return captured
    },
    inputByRequest(
      projectId: string,
      requestId: string,
      actorId: string,
      workspaceType: 'internal' | 'external',
    ): WorkspaceInputCapture | null {
      authorize(projectId, actorId, workspaceType === 'internal' ? 'read' : 'external-read')
      const row = db
        .prepare('SELECT * FROM authoring_inputs WHERE project_id=? AND request_id=?')
        .get(projectId, requestIdentifier(requestId))
      if (!row) return null
      if (row.actor_id !== actorId || row.workspace_type !== workspaceType)
        fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原请求已固定其他操作人或资料范围')
      return JSON.parse(text(row, 'value')) as WorkspaceInputCapture
    },
    preparedInputByRequest(
      projectId: string,
      requestId: string,
      actorId: string,
      workspaceType: 'internal' | 'external',
    ): WorkspaceInputCapture | null {
      authorize(projectId, actorId, workspaceType === 'internal' ? 'read' : 'external-read')
      const row = db
        .prepare('SELECT * FROM authoring_input_preparations WHERE project_id=? AND request_id=?')
        .get(projectId, requestIdentifier(requestId))
      if (!row) return null
      if (row.actor_id !== actorId || row.workspace_type !== workspaceType)
        fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原请求已固定其他操作人或资料范围')
      return JSON.parse(text(row, 'value')) as WorkspaceInputCapture
    },
    prepareInput(
      projectId: string,
      requestId: string,
      actorId: string,
      selection: WorkspaceInputSelection,
    ): WorkspaceInputCapture {
      authorize(
        projectId,
        actorId,
        selection.workspaceType === 'internal' ? 'read' : 'external-read',
        true,
      )
      requestIdentifier(requestId)
      return transaction.run(() => {
        const previous =
          api.inputByRequest(projectId, requestId, actorId, selection.workspaceType) ??
          api.preparedInputByRequest(projectId, requestId, actorId, selection.workspaceType)
        if (previous) return previous
        if (
          db
            .prepare('SELECT 1 FROM authoring_receipts WHERE project_id=? AND request_id=?')
            .get(projectId, requestId)
        )
          fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原请求已用于其他资料操作')
        ensureProject(projectId)
        let value: WorkspaceInputCapture
        if (selection.workspaceType === 'external') {
          if (
            db
              .prepare('SELECT 1 FROM authoring_captures WHERE project_id=? AND request_id=?')
              .get(projectId, requestId)
          )
            fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原请求已经固定内部资料')
          value = {
            id: randomUUID(),
            projectId,
            requestId,
            workspaceType: 'external',
            revision: 0,
            createdAt: now(),
            status: 'active',
            repositories: [],
            files: [],
            directories: [],
            externalVersionId: id(selection.versionId),
          }
        } else {
          let captured = api.capture(projectId, selection.revision, actorId, requestId, {
            sources: selection.repositories.map((value) => value.source),
            documents: true,
          })
          if (captured.status !== 'active')
            fail(410, 'WORKSPACE_CAPTURE_RELEASED', '原资料捕获已经释放')
          if (captured.resolution === 'pending')
            captured = api.freezeCaptureRepositories(
              projectId,
              captured.id,
              selection.repositories.map(
                ({ source: _source, versionId: _versionId, ...resolved }) => resolved,
              ),
              actorId,
            )
          value = {
            id: captured.id,
            projectId,
            requestId,
            workspaceType: 'internal',
            revision: captured.revision,
            createdAt: captured.createdAt,
            status: 'active',
            repositories: selection.repositories,
            files: captured.files,
            directories: captured.directories,
            captureId: captured.id,
            ...(selection.sourceErrors?.length ? { sourceErrors: selection.sourceErrors } : {}),
            ...(selection.sourceWarnings?.length
              ? { sourceWarnings: selection.sourceWarnings }
              : {}),
          }
        }
        db.prepare('INSERT INTO authoring_input_preparations VALUES(?,?,?,?,?)').run(
          projectId,
          requestId,
          actorId,
          selection.workspaceType,
          JSON.stringify(value),
        )
        return structuredClone(value)
      })
    },
    saveInput(value: WorkspaceInputCapture, actorId: string): WorkspaceInputCapture {
      authorize(
        value.projectId,
        actorId,
        value.workspaceType === 'internal' ? 'read' : 'external-read',
        true,
      )
      return transaction.run(() => {
        const previous = api.inputByRequest(
          value.projectId,
          value.requestId,
          actorId,
          value.workspaceType,
        )
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(value))
            fail(409, 'WORKSPACE_REQUEST_CONFLICT', '本轮资料输入已经固定')
          return previous
        }
        const prepared = api.preparedInputByRequest(
          value.projectId,
          value.requestId,
          actorId,
          value.workspaceType,
        )
        if (prepared && JSON.stringify(prepared) !== JSON.stringify(value))
          fail(409, 'WORKSPACE_REQUEST_CONFLICT', '原请求已经固定另一份资料选择')
        db.prepare('INSERT INTO authoring_inputs VALUES(?,?,?,?,?,?)').run(
          id(value.id),
          value.projectId,
          actorId,
          requestIdentifier(value.requestId),
          value.workspaceType,
          JSON.stringify(value),
        )
        db.prepare(
          'DELETE FROM authoring_input_preparations WHERE project_id=? AND request_id=?',
        ).run(value.projectId, value.requestId)
        return structuredClone(value)
      })
    },
    readInput(projectId: string, inputId: string, actorId: string): WorkspaceInputCapture {
      const row = db
        .prepare('SELECT * FROM authoring_inputs WHERE project_id=? AND id=?')
        .get(id(projectId), id(inputId))
      if (!row || row.actor_id !== actorId)
        fail(404, 'WORKSPACE_INPUT_NOT_FOUND', '本轮资料输入不存在或无权访问')
      const value = JSON.parse(text(row, 'value')) as WorkspaceInputCapture
      authorize(projectId, actorId, value.workspaceType === 'internal' ? 'read' : 'external-read')
      return value
    },
    releaseInput(projectId: string, inputId: string, actorId: string): WorkspaceInputCapture {
      const value = api.readInput(projectId, inputId, actorId)
      authorize(
        projectId,
        actorId,
        value.workspaceType === 'internal' ? 'read' : 'external-read',
        true,
      )
      if (value.status === 'released') return value
      const released = { ...value, status: 'released' as const }
      db.prepare('UPDATE authoring_inputs SET value=? WHERE project_id=? AND id=?').run(
        JSON.stringify(released),
        projectId,
        inputId,
      )
      if (value.captureId) api.releaseCapture(projectId, value.captureId, actorId)
      return released
    },
    syncRecords(projectId: string, actorId: string): WorkspaceSourceSyncRecord[] {
      authorize(projectId, actorId, 'read')
      return db
        .prepare('SELECT value FROM authoring_source_sync WHERE project_id=?')
        .all(projectId)
        .map((row) => JSON.parse(text(row, 'value')) as WorkspaceSourceSyncRecord)
    },
    recordSyncBatch(
      projectId: string,
      values: WorkspaceSourceSyncRecord[],
      actorId: string,
    ): WorkspaceSourceSyncRecord[] {
      authorize(projectId, actorId, 'manage', true)
      return transaction.run(() => {
        const configured = sources(projectId)
        const applied = values.filter((value) => {
          id(value.sourceId)
          const source = configured.find((source) => source.id === value.sourceId)
          if (!source || hash(JSON.stringify(source)) !== value.configurationHash) return false
          const previous = db
            .prepare('SELECT value FROM authoring_source_sync WHERE project_id=? AND source_id=?')
            .get(projectId, value.sourceId)
          return (
            value.status === 'queued' ||
            (previous &&
              (JSON.parse(text(previous, 'value')) as WorkspaceSourceSyncRecord).requestId ===
                value.requestId)
          )
        })
        const effective = new Map(
          db
            .prepare('SELECT source_id,value FROM authoring_source_sync WHERE project_id=?')
            .all(projectId)
            .filter((row) => configured.some((source) => source.id === row.source_id))
            .map((row) => [
              text(row, 'source_id'),
              JSON.parse(text(row, 'value')) as WorkspaceSourceSyncRecord,
            ]),
        )
        for (const value of applied) effective.set(value.sourceId, value)
        const mounts: string[] = []
        for (const value of effective.values()) {
          if (!value.versionId) continue
          if (
            !value.current ||
            value.current.versionId !== value.versionId ||
            value.current.source.id !== value.sourceId
          )
            fail(
              409,
              'WORKSPACE_CURRENT_SOURCE_MISSING',
              '当前源码身份未能固定，请先核对原同步版本',
            )
          const mount = value.current.source.mountPath
          if (mounts.some((previous) => overlaps(previous, mount)))
            fail(
              409,
              'WORKSPACE_CURRENT_SOURCE_CONFLICT',
              '当前源码实际目录重叠，请核对来源后完整更新工作区',
            )
          mounts.push(mount)
        }
        // 完整候选一次发布；任一来源写入失败时回滚全部current指针。
        for (const value of applied)
          db.prepare(
            'INSERT INTO authoring_source_sync VALUES(?,?,?) ON CONFLICT(project_id,source_id) DO UPDATE SET value=excluded.value',
          ).run(projectId, value.sourceId, JSON.stringify(value))
        return applied
      })
    },
    deploymentInput(
      projectId: string,
      requestId: string,
      fingerprint: string,
      actorId: string,
    ): WorkspaceDeploymentSourceCapture | null {
      authorize(projectId, actorId, 'source-generate')
      const row = db
        .prepare('SELECT * FROM authoring_deployment_inputs WHERE project_id=? AND request_id=?')
        .get(projectId, requestIdentifier(requestId))
      if (!row) return null
      if (row.actor_id !== actorId || row.fingerprint !== fingerprint)
        fail(409, 'WORKSPACE_REQUEST_CONFLICT', '部署请求已经固定其他来源或构建上下文')
      return JSON.parse(text(row, 'value')) as WorkspaceDeploymentSourceCapture
    },
    // 仅供来源所有者核对已确认终态的维护操作；不借当前成员授权，也不向传输层公开。
    withDeploymentSourceMaintenanceReceipt(
      candidate: WorkspaceDeploymentSourceMaintenanceCandidate,
      release: (
        input: WorkspaceDeploymentSourceCapture,
        capture: WorkspaceAuthoringCapture,
      ) => boolean,
    ): boolean {
      if (closed) fail(503, 'WORKSPACE_AUTHORING_STOPPING', '工作区资料服务已关闭')
      id(candidate.projectId)
      id(candidate.actorId)
      requestIdentifier(candidate.requestId)
      return transaction.run(() => {
        const row = db
          .prepare('SELECT * FROM authoring_deployment_inputs WHERE project_id=? AND request_id=?')
          .get(candidate.projectId, candidate.requestId)
        if (!row || row.actor_id !== candidate.actorId) return false
        const input = JSON.parse(text(row, 'value')) as WorkspaceDeploymentSourceCapture
        if (
          input.projectId !== candidate.projectId ||
          input.requestId !== candidate.requestId ||
          input.versionId !== candidate.sourceVersionId
        )
          return false
        const owned = captureRow(candidate.projectId, input.id)
        if (owned.actor_id !== candidate.actorId) return false
        const captured = captureFrom(owned)
        if (
          captured.resolution !== 'resolved' ||
          captured.files.length ||
          captured.directories.length
        )
          return false
        const used = db
          .prepare(
            `
          SELECT 1 FROM authoring_inputs i WHERE project_id=? AND coalesce(json_extract(i.value,'$.status'),'unknown')<>'released' AND
            (id=? OR request_id=? OR json_extract(i.value,'$.captureId')=? OR EXISTS(SELECT 1 FROM json_each(i.value,'$.repositories') r WHERE json_extract(r.value,'$.versionId')=?))
          UNION ALL
          SELECT 1 FROM authoring_input_preparations p WHERE project_id=? AND
            (json_extract(p.value,'$.id')=? OR request_id=? OR json_extract(p.value,'$.captureId')=? OR EXISTS(SELECT 1 FROM json_each(p.value,'$.repositories') r WHERE json_extract(r.value,'$.versionId')=?))
          LIMIT 1
        `,
          )
          .get(
            candidate.projectId,
            input.id,
            candidate.requestId,
            input.id,
            input.versionId,
            candidate.projectId,
            input.id,
            candidate.requestId,
            input.id,
            input.versionId,
          )
        if (used || !release(input, captured)) return false
        db.prepare(
          "UPDATE authoring_captures SET status='released' WHERE project_id=? AND id=?",
        ).run(candidate.projectId, input.id)
        return true
      })
    },
    saveDeploymentInput(
      value: WorkspaceDeploymentSourceCapture,
      fingerprint: string,
      actorId: string,
    ) {
      authorize(value.projectId, actorId, 'source-generate', true)
      const previous = api.deploymentInput(value.projectId, value.requestId, fingerprint, actorId)
      if (previous) return previous
      db.prepare('INSERT INTO authoring_deployment_inputs VALUES(?,?,?,?,?)').run(
        value.projectId,
        value.requestId,
        actorId,
        fingerprint,
        JSON.stringify(value),
      )
      return value
    },
    inputProtectionSummary(projectId: string, actorId: string) {
      authorize(projectId, actorId, 'manage')
      const inputs = db
        .prepare(
          "SELECT id,request_id,value,0 AS preparing FROM authoring_inputs WHERE project_id=? AND json_extract(value,'$.status')='active' UNION ALL SELECT json_extract(value,'$.id') AS id,request_id,value,1 AS preparing FROM authoring_input_preparations WHERE project_id=? ORDER BY id LIMIT 501",
        )
        .all(projectId, projectId)
      const captures = db
        .prepare(
          "SELECT c.id,c.request_id,COUNT(f.path) AS file_count FROM authoring_captures c LEFT JOIN authoring_capture_files f ON f.capture_id=c.id WHERE c.project_id=? AND c.status='active' AND NOT EXISTS(SELECT 1 FROM authoring_inputs i WHERE i.id=c.id) AND NOT EXISTS(SELECT 1 FROM authoring_input_preparations p WHERE json_extract(p.value,'$.id')=c.id) GROUP BY c.id ORDER BY c.id LIMIT 501",
        )
        .all(projectId)
      return {
        inputs: inputs.slice(0, 500).map((row) => {
          const value = JSON.parse(text(row, 'value')) as WorkspaceInputCapture
          return {
            inputId: value.id,
            requestId: value.requestId,
            kind: row.preparing
              ? 'preparing-input'
              : value.requestId.startsWith('picker:')
                ? 'picker'
                : 'accepted-input',
            fileCount: value.files.length,
            versionIds: [
              ...new Set([
                ...value.repositories.map((item) => item.versionId),
                ...(value.externalVersionId ? [value.externalVersionId] : []),
              ]),
            ],
          }
        }),
        pendingCaptures: captures.slice(0, 500).map((row) => ({
          captureId: text(row, 'id'),
          requestId: text(row, 'request_id'),
          fileCount: Number(row.file_count),
          reason: '原请求尚未交接，保留未知结果与原件',
        })),
        truncated: inputs.length > 500 || captures.length > 500,
      }
    },
    collectUnused(projectId: string, actorId: string) {
      authorize(projectId, actorId, 'manage', true)
      if (processing.size)
        fail(409, 'WORKSPACE_DOCUMENT_PROCESSING', '正文处理尚未完成，请稍后清理未引用原件')
      return collectUnusedOriginals()
    },
    stopAccepting() {
      stopped = true
    },
    async drain() {
      await Promise.all([...processing.values()])
    },
    close(): Promise<void> {
      stopped = true
      closePromise ??= api.drain().then(() => {
        if (!closed) {
          collectUnusedQuietly()
          closed = true
          database.close()
        }
      })
      return closePromise
    },
  }
  collectUnusedQuietly()
  return api
}
export type WorkspaceAuthoring = ReturnType<typeof createWorkspaceAuthoring>
