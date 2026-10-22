import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { contextFor, projects } from '../fixtures.mjs'
import { configuredAutoOpsAccess, AutoOpsAccessError } from './access.mjs'
import { configuredBusinessArtifactStore } from './business-tools.mjs'
import { extractBusinessAttachment } from './business-documents.mjs'
import { resolveAttachmentPathById } from '../../vendor/t3code/apps/server/src/attachmentStore.ts'

const fail = (message) => { throw new AutoOpsAccessError(404, 'RESOURCE_NOT_FOUND', message || '资料不存在或无权访问') }
const nameFor = (name) => name.replace(/[\/\\\u0000-\u001f]/g, '_').slice(0, 160) || 'file'
const version = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
export function createBusinessResourceCatalog({ access, bindingDb, artifactStore, attachmentsDir }) {
  function catalog(project, permitsThread) {
    const entries = []
    const add = (path, resource) => entries.push({ path, ...resource })
    const prefix = `autoops/${project.id}`
    for (const doc of project.documents)
      add(`${prefix}/documents/${doc.id}/${version(doc.content)}/${nameFor(doc.name)}`, { type: 'document', id: doc.id, name: doc.name, mime: doc.mime, content: doc.content, sourceUrl: `/api/agent-demo/t3/autoops/projects/${project.id}/documents/${doc.id}` })
    for (const environment of project.environments)
      add(`${prefix}/environments/${environment.id}/snapshot.json`, { type: 'environment', id: environment.id, name: `${environment.name}.json`, mime: 'application/json', environmentId: environment.id })
    const bindings = bindingDb.prepare('SELECT thread_id FROM t3_thread_bindings WHERE project_id=? AND revoked_at IS NULL').all(project.id)
    for (const row of bindings) {
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
    const match = typeof cwd === 'string' && cwd.match(/^autoops:\/\/projects\/([^/?#]+)\/environments\/([^/?#]+)\/threads\/([^/?#]+)$/)
    if (!match) fail('业务资料目录无效；不接受宿主路径')
    const [, projectId, environmentId, threadId] = match
    const project = access.requireProject(principal, projectId)
    if (!project.environments.some((entry) => entry.id === environmentId)) fail()
    const binding = access.getThreadBinding(threadId)
    if (binding) {
      access.requireThread(principal, threadId)
      if (binding.projectId !== projectId || binding.environmentId !== environmentId) fail()
    }
    return { project, environmentId, threadId, binding }
  }
  function projectAtCwd(principal, cwd) {
    return scopeAtCwd(principal, cwd).project
  }
  function visible(principal, project) {
    return catalog(project, (threadId) => access.canSeeThread(principal, threadId))
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
    const found = visible(principal, project).find((entry) => entry.path === path)
    if (!found) fail()
    return found
  }
  async function bytes(resource) {
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
    }).filter((entry) => entry.environmentId === undefined || entry.environmentId === target.binding.environmentId)
  }
  return {
    projectAtCwd,
    search(principal, input) {
      const scope = scopeAtCwd(principal, input.cwd), { project } = scope
      const needle = input.query.toLocaleLowerCase()
      const files = visible(principal, project).filter((file) => (file.environmentId === undefined || file.environmentId === scope.environmentId) && (!input.imageOnly || file.mime.startsWith('image/')))
      const matches = entriesWithFolders(files).filter((entry) => (!input.kind || entry.kind === input.kind) && entry.path.toLocaleLowerCase().includes(needle))
      return { entries: matches.slice(0, input.limit), truncated: matches.length > input.limit }
    },
    list(principal, input) {
      const { project, environmentId } = scopeAtCwd(principal, input.cwd)
      const directory = input.directoryPath?.replace(/\/$/, '') || ''
      if (directory) assertPath(directory)
      const prefix = directory ? directory + '/' : ''
      const matches = entriesWithFolders(visible(principal, project).filter((entry) => entry.environmentId === undefined || entry.environmentId === environmentId)).filter((entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/'))
      return { entries: matches.slice(0, 500), truncated: matches.length > 500 }
    },
    async read(principal, input) {
      const { project, environmentId } = scopeAtCwd(principal, input.cwd)
      const resource = findVisible(principal, input.relativePath)
      if (resource.path.split('/')[1] !== project.id || (resource.environmentId !== undefined && resource.environmentId !== environmentId)) fail()
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
        const files = visible(principal, project)
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
      if (resource) return { path, name: resource.name, mime: resource.mime, content: await contents(resource), sourceUrl: resource.sourceUrl || `/api/agent-demo/t3/autoops/resources?path=${encodeURIComponent(path)}` }
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
