import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { extractBusinessAttachment } from './business-documents.mjs'
import { contextFor } from '../fixtures.mjs'
import { configuredWorkspaceStore } from './workspaces.mjs'

const TEXT_REPORT_MIMES = new Set(['text/markdown', 'text/plain', 'text/csv', 'application/json'])
export class AutoOpsToolError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const fail = (code, message) => { throw new AutoOpsToolError(code, message) }
const bounded = (value, field, max = 1024 * 1024) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max)
    fail('INVALID_TOOL_INPUT', `${field}无效或超过长度限制`)
  return value
}

/** Only business files live here. Runs/events/provider history remain owned by T3. */
export function createBusinessArtifactStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dataDir, 't3-business.sqlite'))
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS business_artifacts (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
      project_id TEXT NOT NULL, owner_id TEXT NOT NULL, published INTEGER NOT NULL,
      name TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS business_artifacts_thread ON business_artifacts(thread_id);`)
  return {
    create({ binding, runId, name, mime, bytes }) {
      // Identical retries in one run reuse the same artifact; different bytes or
      // a later run never overwrite an already delivered file.
      const digest = createHash('sha256').update(JSON.stringify([binding.threadId, runId, name, mime])).update(bytes).digest('hex')
      const id = `report-${digest}`
      db.prepare('INSERT OR IGNORE INTO business_artifacts VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, binding.threadId, runId, binding.projectId, binding.ownerId, Number(binding.visibility === 'project'), name, mime, bytes, new Date().toISOString())
      return { id, name, mime, size: bytes.byteLength, sourceUrl: `/api/agent-demo/t3/autoops/files/${encodeURIComponent(id)}` }
    },
    read(id) {
      const row = db.prepare('SELECT * FROM business_artifacts WHERE id=?').get(id)
      return row ? { id: row.id, threadId: row.thread_id, runId: row.run_id, projectId: row.project_id, ownerId: row.owner_id, published: Boolean(row.published), name: row.name, mime: row.mime, bytes: row.data, createdAt: row.created_at } : null
    },
    list(threadId) {
      return db.prepare('SELECT id,name,mime,length(data) AS size,created_at FROM business_artifacts WHERE thread_id=? ORDER BY created_at,id').all(threadId)
    },
    close() { db.close() },
  }
}

let configuredArtifacts
export function configuredBusinessArtifactStore() {
  if (!process.env.AUTOOPS_T3_DATA_DIR) return undefined
  return configuredArtifacts ||= createBusinessArtifactStore(process.env.AUTOOPS_T3_DATA_DIR)
}

/**
 * Called from T3's authenticated MCP invocation. The thread identity is supplied
 * by its registry, never a model argument. All resource callbacks must already
 * enforce the current canonical history/attachment boundary.
 */
export function createAutoOpsBusinessTools({ authorizeThread, loadAttachments, loadAttachmentBytes, storeArtifact, renderPdf, workspaceStore = configuredWorkspaceStore() }) {
  const authorize = async (threadId) => {
    const authorized = await authorizeThread(threadId)
    if (!authorized?.binding || !authorized.project || !authorized.agent) fail('THREAD_FORBIDDEN', '会话授权已失效')
    return authorized
  }
  const workspace = (binding) => {
    if (!binding.workspaceVersionId && !binding.workspaceType) return null
    if (!binding.workspaceVersionId || !binding.workspaceType || !workspaceStore) fail('WORKSPACE_UNAVAILABLE', '会话固定工作区不可用')
    const version = workspaceStore.getVersion(binding.projectId, binding.workspaceVersionId)
    if (version.type !== binding.workspaceType) fail('WORKSPACE_FORBIDDEN', '工作区不属于当前会话范围')
    return { version, files: workspaceStore.files(binding.projectId, binding.workspaceVersionId) }
  }
  const workspacePath = (binding, relativePath) => `autoops/${binding.projectId}/workspaces/${binding.workspaceVersionId}/${relativePath}`
  const workspaceSource = (binding, path) => `/api/agent-demo/t3/autoops/resources?path=${encodeURIComponent(workspacePath(binding, path))}`
  const workspaceIdentity = ({ version }, binding) => ({ id: version.id, type: version.type, root: `autoops/${binding.projectId}/workspaces/${version.id}`, source: { contentHash: version.source?.contentHash, repositories: version.source?.repositories?.map(({ path, commit }) => ({ path, commit })) } })
  return {
    async listMaterials(threadId) {
      const { project, binding } = await authorize(threadId)
      const attachments = await loadAttachments(binding)
      const selected = workspace(binding)
      return {
        project: { id: project.id, name: project.name },
        environmentId: binding.environmentId,
        ...(selected ? { source: 'workspace_snapshot', workspace: workspaceIdentity(selected, binding), documentCount: selected.files.length, truncated: selected.files.length > 250 } : {}),
        documents: selected ? selected.files.slice(0, 250).map(({ path, name, mime, size }) => ({ id: path, name, path: workspacePath(binding, path), mime, size })) : project.documents.map(({ id, name, mime }) => ({ id, name, mime })),
        attachments: attachments.map(({ id, name, mime, readable }) => ({ id, name, mime, ...(readable === undefined ? {} : { readable }) })),
      }
    },
    async readDocument(threadId, id) {
      const { project, binding } = await authorize(threadId)
      const selected = workspace(binding)
      if (selected) {
        const file = selected.files.find((entry) => entry.path === id || workspacePath(binding, entry.path) === id)
        if (!file) fail('DOCUMENT_FORBIDDEN', '资料不属于会话固定工作区版本')
        const read = workspaceStore.read(binding.projectId, binding.workspaceVersionId, file.path)
        return { id: file.path, name: file.name, mime: file.mime, content: read.contents, byteLength: read.byteLength, truncated: read.truncated, source: 'workspace_snapshot', workspaceType: binding.workspaceType, workspaceVersionId: binding.workspaceVersionId, sourceUrl: workspaceSource(binding, file.path) }
      }
      const document = project.documents.find((entry) => entry.id === id)
      if (!document) fail('DOCUMENT_FORBIDDEN', '资料不存在或不属于当前项目')
      return { ...document, sourceUrl: `/api/agent-demo/t3/autoops/projects/${encodeURIComponent(project.id)}/documents/${encodeURIComponent(document.id)}` }
    },
    async readAttachment(threadId, id) {
      const { binding } = await authorize(threadId)
      const file = (await loadAttachments(binding)).find((entry) => entry.id === id)
      if (!file) fail('ATTACHMENT_FORBIDDEN', '附件不属于当前会话历史范围')
      const sourceUrl = file.sourceUrl
      if (file.mime?.startsWith('image/')) return { id, name: file.name, mime: file.mime, sourceUrl, notice: '图片通过原生附件输入提供给视觉模型；这里不伪造提取文本。' }
      const bytes = typeof file.content === 'string' ? undefined : file.bytes || await loadAttachmentBytes?.(binding, file.id)
      if (typeof file.content !== 'string' && !bytes) fail('ATTACHMENT_UNAVAILABLE', '附件内容不可用')
      const extracted = typeof file.content === 'string' ? file : await extractBusinessAttachment({ id, name: file.name, mime: file.mime, bytes })
      if (typeof extracted.content !== 'string') fail('UNSUPPORTED_ATTACHMENT', extracted.extraction?.message || '此文件暂不能提取为文本')
      return { id, name: file.name, mime: file.mime, content: extracted.content, extraction: extracted.extraction, sourceUrl }
    },
    async queryEnvironment(threadId, environmentId) {
      const { binding, project } = await authorize(threadId)
      if (binding.environmentId !== environmentId) fail('ENVIRONMENT_FORBIDDEN', '只能查询会话固定环境')
      const selected = workspace(binding)
      if (selected) return { environmentId, environmentName: project.environments.find((environment) => environment.id === environmentId)?.name, source: 'workspace_snapshot', workspace: workspaceIdentity(selected, binding), notice: '当前会话读取固定工作区文件快照；未接入服务器实时观测，不能据此判断部署或运行状态。' }
      const context = contextFor(binding)
      return { environmentId, environmentName: project.environments.find((environment) => environment.id === environmentId)?.name, source: 'demo_fixture_snapshot', observedAt: context.resourceSnapshot.collectedAt, resources: context.resources, resourceSnapshot: context.resourceSnapshot, notice: '这是测试主服务提供的演示夹具，不是生产环境实时观测。' }
    },
    async createReport(threadId, runId, input) {
      const { binding } = await authorize(threadId)
      const name = bounded(input.name, '报告名称', 160)
      if (/[\\/\r\n\u0000]/.test(name) || name === '.' || name === '..') fail('INVALID_TOOL_INPUT', '报告名称不能包含路径')
      const content = bounded(input.content, '报告正文')
      if (!TEXT_REPORT_MIMES.has(input.mime) && input.mime !== 'application/pdf') fail('INVALID_TOOL_INPUT', '报告类型不支持')
      if (input.mime === 'application/pdf' && !renderPdf) fail('PDF_UNAVAILABLE', 'PDF 生成尚未就绪，可生成 Markdown 或 CSV')
      const bytes = input.mime === 'application/pdf' ? await renderPdf(content) : Buffer.from(content, 'utf8')
      return { ...await storeArtifact({ binding, runId, name, mime: input.mime, bytes }), status: 'saved', published: binding.visibility === 'project' }
    },
  }
}
