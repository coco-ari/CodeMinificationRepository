import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { contextFor } from '../fixtures.mjs'
import { configuredAutoOpsAccess, AutoOpsAccessError } from './access.mjs'
import { configuredBusinessArtifactStore } from './business-tools.mjs'
import { extractBusinessAttachment } from './business-documents.mjs'
import { configuredWorkspaceStore } from './workspaces.mjs'
import { resolveAttachmentPathById } from '../../vendor/t3code/apps/server/src/attachmentStore.ts'

const fail = (message) => { throw new AutoOpsAccessError(404, 'RESOURCE_NOT_FOUND', message || '资料不存在或无权访问') }
const nameFor = (name) => name.replace(/[\/\\\u0000-\u001f]/g, '_').slice(0, 160) || 'file'
const version = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
export function createBusinessResourceCatalog({ access, bindingDb, artifactStore, attachmentsDir, workspaceStore = configuredWorkspaceStore() }) {
  const sameWorkspace = (source, target) => (source.workspaceType || null) === (target?.workspaceType || null) && (source.workspaceVersionId || null) === (target?.workspaceVersionId || null)
  function workspace(binding) {
    if (!binding?.workspaceType && !binding?.workspaceVersionId) return null
    if (!binding.workspaceType || !binding.workspaceVersionId || !workspaceStore) fail('会话固定工作区不可用')
    const version = workspaceStore.getVersion(binding.projectId, binding.workspaceVersionId)
    if (version.type !== binding.workspaceType) fail('工作区不属于当前会话范围')
    return { version, files: workspaceStore.files(binding.projectId, binding.workspaceVersionId) }
  }
  function catalog(project, permitsThread, binding) {
    const entries = []
    const add = (path, resource) => entries.push({ path, ...resource })
    const prefix = `autoops/${project.id}`
    const selected = workspace(binding)
    if (selected) {
      for (const file of selected.files) {
        const path = `${prefix}/workspaces/${binding.workspaceVersionId}/${file.path}`
        add(path, { type: 'workspace', id: file.path, relativePath: file.path, workspaceVersionId: binding.workspaceVersionId, projectId: project.id, name: file.name, mime: file.mime, size: file.size, sourceUrl: `/api/agent-demo/t3/autoops/resources?path=${encodeURIComponent(path)}` })
      }
    } else {
      for (const doc of project.documents)
        add(`${prefix}/documents/${doc.id}/${version(doc.content)}/${nameFor(doc.name)}`, { type: 'document', id: doc.id, name: doc.name, mime: doc.mime, content: doc.content, sourceUrl: `/api/agent-demo/t3/autoops/projects/${project.id}/documents/${doc.id}` })
      for (const environment of project.environments)
        add(`${prefix}/environments/${environment.id}/snapshot.json`, { type: 'environment', id: environment.id, name: `${environment.name}.json`, mime: 'application/json', environmentId: environment.id })
    }
    const bindings = bindingDb.prepare('SELECT thread_id FROM t3_thread_bindings WHERE project_id=? AND revoked_at IS NULL').all(project.id)
    for (const row of bindings) {
      const source = access.getThreadBinding(row.thread_id)
      if (!source || !sameWorkspace(source, binding) || (binding?.environmentId && source.environmentId !== binding.environmentId)) continue
      if (!permitsThread(row.thread_id)) continue
      for (const file of bindingDb.prepare('SELECT attachment_id, metadata_json FROM t3_attachment_access WHERE thread_id=?').all(row.thread_id)) {
        const meta = file.metadata_json ? JSON.parse(file.metadata_json) : {}
        add(`${prefix}/threads/${row.thread_id}/attachments/${file.attachment_id}/${nameFor(meta.name || file.attachment_id)}`, { type: 'attachment', id: file.attachment_id, threadId: row.thread_id, name: meta.name || file.attachment_id, mime: meta.mimeType || 'application/octet-stream', size: meta.sizeBytes || 0, sourceUrl: `/api/agent-demo/t3/autoops/attachments/${file.attachment_id}` })
      }
      for (const file of artifactStore?.list(row.thread_id) || [])
        add(`${prefix}/threads/${row.thread_id}/reports/${file.id}/${nameFor(file.name)}`, { type: 'report', id: file.id, threadId: row.thread_id, name: file.name, mime: file.mime, size: file.size, sourceUrl: `/api/agent-demo/t3/autoops/files/${file.id}` })
    }
    return entries
  }
  function scopeAtCwd(principal, cwd) {
    const match = typeof cwd === 'string' && cwd.match(/^autoops:\/\/projects\/([^/?#]+)\/environments\/([^/?#]+)\/threads\/([^/?#]+)(?:\?([^#]*))?$/)
    if (!match) fail('业务资料目录无效；不接受宿主路径')
    const [, projectId, environmentId, threadId, query] = match
    const project = access.requireProject(principal, projectId)
    if (!project.environments.some((entry) => entry.id === environmentId)) fail()
    let binding = access.getThreadBinding(threadId)
    const parameters = new URLSearchParams(query || '')
    const workspaceType = parameters.get('workspaceType'), workspaceVersionId = parameters.get('workspaceVersionId')
    if (parameters.size && (parameters.size !== 2 || !['internal', 'external'].includes(workspaceType) || !workspaceVersionId)) fail('工作区范围参数无效')
    if (binding) {
      access.requireThread(principal, threadId)
      if (binding.projectId !== projectId || binding.environmentId !== environmentId) fail()
      if (parameters.size && (binding.workspaceType !== workspaceType || binding.workspaceVersionId !== workspaceVersionId)) fail('会话固定工作区不能切换，请新建对话')
    } else if (parameters.size) binding = { projectId, environmentId, workspaceType, workspaceVersionId }
    else throw new AutoOpsAccessError(409, 'WORKSPACE_REQUIRED', '请先选择工作区版本')
    workspace(binding)
    return { project, environmentId, threadId, binding }
  }
  function projectAtCwd(principal, cwd) {
    return scopeAtCwd(principal, cwd).project
  }
  function visible(principal, project, binding) {
    return catalog(project, (threadId) => access.canSeeThread(principal, threadId), binding)
  }
  function assertPath(path) {
    if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.') || path.includes('\0')) fail()
  }
  const entriesWithFolders = (files) => {
    const result = new Map(files.map((file) => [file.path, { path: file.path, kind: 'file' }]))
    for (const file of files) {
      const parts = file.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const path = parts.slice(0, i).join('/')
        result.set(path, { path, kind: 'directory' })
      }
    }
    return [...result.values()].sort((a, b) => a.path.localeCompare(b.path))
  }
  function findVisible(principal, path) {
    assertPath(path)
    const project = access.requireProject(principal, path.split('/')[1])
    const parts = path.split('/')
    const selected = parts[2] === 'workspaces' ? workspaceStore?.getVersion(project.id, parts[3]) : null
    if (parts[2] === 'workspaces' && !selected) fail()
    const binding = selected ? { projectId: project.id, workspaceType: selected.type, workspaceVersionId: selected.id } : parts[2] === 'threads' ? access.getThreadBinding(parts[3]) : undefined
    const found = visible(principal, project, binding).find((entry) => entry.path === path)
    if (!found) fail()
    return found
  }
  async function bytes(resource) {
    if (resource.type === 'workspace') return workspaceStore.readBytes(resource.projectId, resource.workspaceVersionId, resource.relativePath)
    if (resource.type === 'document') return Buffer.from(resource.content)
    if (resource.type === 'environment') {
      const snapshot = contextFor({ projectId: resource.path.split('/')[1], environmentId: resource.environmentId })
      return Buffer.from(JSON.stringify({ source: 'demo_fixture_snapshot', ...snapshot.resourceSnapshot, resources: snapshot.resources }, null, 2))
    }
    if (resource.type === 'report') {
      const file = artifactStore?.read(resource.id)
      if (!file) fail()
      return file.bytes
    }
    const path = resolveAttachmentPathById({ attachmentsDir, attachmentId: resource.id })
    if (!path) fail()
    return readFile(path)
  }
  async function contents(resource) {
    if (resource.type === 'workspace') return workspaceStore.read(resource.projectId, resource.workspaceVersionId, resource.relativePath).contents
    const data = await bytes(resource)
    const extracted = await extractBusinessAttachment({ id: resource.id, name: resource.name, mime: resource.mime, bytes: data })
    if (typeof extracted.content !== 'string') throw new AutoOpsAccessError(415, 'RESOURCE_NOT_TEXT', extracted.extraction?.message || '该资料请通过原始文件预览')
    return extracted.content
  }
  function forThread(threadId) {
    const target = access.requireToolThread(threadId)
    const targetAudience = target.binding.visibility === 'project' ? target.project.memberIds : [target.binding.ownerId]
    return catalog(target.project, (sourceId) => {
      const source = access.getThreadBinding(sourceId)
      if (!source || source.revokedAt) return false
      const sourceAudience = source.visibility === 'project' ? target.project.memberIds : [source.ownerId]
      return targetAudience.every((id) => sourceAudience.includes(id))
    }, target.binding).filter((entry) => entry.environmentId === undefined || entry.environmentId === target.binding.environmentId)
  }
  return {
    projectAtCwd,
    search(principal, input) {
      const scope = scopeAtCwd(principal, input.cwd), { project } = scope
      const needle = input.query.toLocaleLowerCase()
      const files = visible(principal, project, scope.binding).filter((file) => (file.environmentId === undefined || file.environmentId === scope.environmentId) && (!input.imageOnly || file.mime.startsWith('image/')))
      const matches = entriesWithFolders(files).filter((entry) => (!input.kind || entry.kind === input.kind) && entry.path.toLocaleLowerCase().includes(needle))
      return { entries: matches.slice(0, input.limit), truncated: matches.length > input.limit }
    },
    list(principal, input) {
      const { project, environmentId, binding } = scopeAtCwd(principal, input.cwd)
      const directory = input.directoryPath?.replace(/\/$/, '') || ''
      if (directory) assertPath(directory)
      const prefix = directory ? directory + '/' : ''
      const matches = entriesWithFolders(visible(principal, project, binding).filter((entry) => entry.environmentId === undefined || entry.environmentId === environmentId)).filter((entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/'))
      return { entries: matches.slice(0, 500), truncated: matches.length > 500 }
    },
    async read(principal, input) {
      const { project, environmentId, binding } = scopeAtCwd(principal, input.cwd)
      assertPath(input.relativePath)
      const resource = visible(principal, project, binding).find((entry) => entry.path === input.relativePath)
      if (!resource) fail()
      if (resource.path.split('/')[1] !== project.id || (resource.environmentId !== undefined && resource.environmentId !== environmentId)) fail()
      if (resource.type === 'workspace') {
        const file = workspaceStore.read(resource.projectId, resource.workspaceVersionId, resource.relativePath)
        return { relativePath: resource.path, contents: file.contents, byteLength: file.byteLength, truncated: file.truncated, exists: true }
      }
      const text = await contents(resource)
      return { relativePath: resource.path, contents: text, byteLength: Buffer.byteLength(text), truncated: false, exists: true }
    },
    async resource(principal, path) { const resource = findVisible(principal, path); return { ...resource, bytes: await bytes(resource) } },
    async metadata(principal, paths) {
      const entries = []
      for (const path of paths) {
        assertPath(path)
        if (path === 'autoops') { entries.push({kind:'directory'}); continue }
        const project = access.requireProject(principal, path.split('/')[1])
        const parts = path.split('/')
        if (parts.length === 3 && parts[2] === 'workspaces') { entries.push({kind:'directory'}); continue }
        const selected = parts[2] === 'workspaces' ? workspaceStore?.getVersion(project.id, parts[3]) : null
        const binding = selected ? { projectId: project.id, workspaceType: selected.type, workspaceVersionId: selected.id } : parts[2] === 'threads' ? access.getThreadBinding(parts[3]) : undefined
        const files = visible(principal, project, binding)
        const file = files.find((entry) => entry.path === path)
        if (file) entries.push({ kind: 'file', byteLength: file.size ?? (file.content ? Buffer.byteLength(file.content) : 0), mimeType: file.mime })
        else entries.push(entriesWithFolders(files).some((entry) => entry.path === path && entry.kind === 'directory') ? {kind: 'directory'} : null)
      }
      return {entries}
    },
    requireContext(threadId, context) {
      const allowed = entriesWithFolders(forThread(threadId))
      for (const record of context?.records || []) if (record.kind === 'mention') {
        assertPath(record.path)
        if (!allowed.some((entry) => entry.path === record.path)) fail('引用不属于当前环境或授权受众，或其资料版本已改变')
      }
    },
    async readForThread(threadId, path) {
      assertPath(path)
      const resources = forThread(threadId)
      const resource = resources.find((entry) => entry.path === path)
      if (resource) {
        const read = resource.type === 'workspace' ? workspaceStore.read(resource.projectId, resource.workspaceVersionId, resource.relativePath) : null
        return { path, name: resource.name, mime: resource.mime, content: read ? read.contents : await contents(resource), ...(read ? { source: 'workspace_snapshot', workspaceVersionId: resource.workspaceVersionId, byteLength: read.byteLength, truncated: read.truncated } : {}), sourceUrl: resource.sourceUrl || `/api/agent-demo/t3/autoops/resources?path=${encodeURIComponent(path)}` }
      }
      const folder = entriesWithFolders(resources).find((entry) => entry.path === path && entry.kind === 'directory')
      if (!folder) fail()
      return { path, kind: 'directory', entries: resources.filter((entry) => entry.path.startsWith(path + '/')).map(({path,name,mime}) => ({path,name,mime})) }
    },
  }
}
let configured
export function configuredBusinessResourceCatalog() {
  const access = configuredAutoOpsAccess()
  if (!access) return undefined
  if (configured) return configured
  const directory = resolve(process.env.AUTOOPS_T3_DATA_DIR)
  const bindingDb = new DatabaseSync(join(directory, 't3-autoops.sqlite'), { readOnly: true })
  configured = createBusinessResourceCatalog({ access, bindingDb, artifactStore: configuredBusinessArtifactStore(), attachmentsDir: join(process.env.AUTOOPS_T3_BASE_DIR || join(directory, 't3'), 'userdata/attachments') })
  return configured
}
