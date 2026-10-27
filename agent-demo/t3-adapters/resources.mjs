import { createHash } from 'node:crypto'
import { contextFor } from '../fixtures.mjs'
import { configuredAutoOpsAccess, AutoOpsAccessError } from './access.mjs'
import { configuredBusinessArtifactStore } from './business-tools.mjs'
import { extractBusinessAttachment } from './business-documents.mjs'
import { configuredWorkspaceStore } from './workspaces.mjs'
import { configuredWorkspaceManagement } from './workspace-management.ts'
import { readScopedSkillResourceForThread } from './scoped-skills.mjs'
import { decodeContract } from '../../autoops/contracts/index.ts'
import { WorkspaceFileReferenceRequest, WorkspaceFileReference } from '../../autoops/contracts/workspace-file-reference.ts'

const fail = (message) => { throw new AutoOpsAccessError(404, 'RESOURCE_NOT_FOUND', message || '资料不存在或无权访问') }
const nameFor = (name) => name.replace(/[\/\\\u0000-\u001f]/g, '_').slice(0, 160) || 'file'
const version = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
export function createBusinessResourceCatalog({ access, artifactStore, readAttachment, workspaceStore = configuredWorkspaceStore(), workspaceInputs }) {
  const sameWorkspace = (source, target) => (source.workspaceType || null) === (target?.workspaceType || null) && (source.workspaceVersionId || null) === (target?.workspaceVersionId || null)
  function workspace(binding) {
    if (!binding?.workspaceVersionId) return null
    if (!binding.workspaceType || !binding.workspaceVersionId || !workspaceStore) fail('会话固定工作区不可用')
    const version = workspaceStore.getVersion(binding.projectId, binding.workspaceVersionId)
    if (version.type !== binding.workspaceType) fail('工作区不属于当前会话范围')
    return { version, files: workspaceStore.files(binding.projectId, binding.workspaceVersionId) }
  }
  function catalog(project, resourceThreads, binding, currentInput = false) {
    const entries = []
    const add = (path, resource) => entries.push({ path, ...resource })
    const prefix = `autoops/${project.id}`
    const selected = currentInput ? null : workspace(binding)
    if (selected) {
      for (const file of selected.files) {
        const path = `${prefix}/workspaces/${binding.workspaceVersionId}/${file.path}`
        add(path, { type: 'workspace', id: file.path, relativePath: file.path, workspaceVersionId: binding.workspaceVersionId, projectId: project.id, name: file.name, mime: file.mime, size: file.size, sourceUrl: `/api/agent-demo/t3/autoops/resources?path=${encodeURIComponent(path)}` })
      }
    } else if (!binding?.workspaceType && !currentInput) {
      for (const doc of project.documents)
        add(`${prefix}/documents/${doc.id}/${version(doc.content)}/${nameFor(doc.name)}`, { type: 'document', id: doc.id, name: doc.name, mime: doc.mime, content: doc.content, sourceUrl: `/api/agent-demo/t3/autoops/projects/${project.id}/documents/${doc.id}` })
      for (const environment of project.environments)
        add(`${prefix}/environments/${environment.id}/snapshot.json`, { type: 'environment', id: environment.id, name: `${environment.name}.json`, mime: 'application/json', environmentId: environment.id })
    }
    for (const { binding: source, attachments } of resourceThreads) {
      if (!sameWorkspace(source, binding) || (binding?.environmentId && source.environmentId !== binding.environmentId)) continue
      for (const file of attachments) {
        add(`${prefix}/threads/${source.threadId}/attachments/${file.id}/${nameFor(file.name || file.id)}`, { type: 'attachment', id: file.id, threadId: source.threadId, createdAt: file.createdAt, name: file.name || file.id, mime: file.mimeType || 'application/octet-stream', size: file.sizeBytes || 0, sourceUrl: `/api/agent-demo/t3/autoops/attachments/${file.id}` })
      }
      for (const file of artifactStore?.list(source.threadId) || [])
        add(`${prefix}/threads/${source.threadId}/reports/${file.id}/${nameFor(file.name)}`, { type: 'report', id: file.id, threadId: source.threadId, createdAt: file.created_at, name: file.name, mime: file.mime, size: file.size, sourceUrl: `/api/agent-demo/t3/autoops/files/${file.id}` })
    }
    return entries
  }
  function scopeAtCwd(principal, cwd) {
    const match = typeof cwd === 'string' && cwd.match(/^autoops:\/\/projects\/([^/?#]+)\/environments\/([^/?#]+)\/threads\/([^/?#]+)(?:\?([^#]*))?$/)
    if (!match) fail('业务资料目录无效；不接受宿主路径')
    const [, projectId, environmentPath, threadId, query] = match
    const environmentId = environmentPath === '~' ? null : environmentPath
    const project = access.requireProject(principal, projectId)
    if (environmentId !== null) access.requireEnvironment(principal, projectId, environmentId)
    let binding = access.getThreadBinding(threadId)
    const parameters = new URLSearchParams(query || '')
    const workspaceType = parameters.get('workspaceType'), workspaceVersionId = parameters.get('workspaceVersionId') ?? undefined, inputId = parameters.get('inputId')
    if ([...parameters.keys()].some(key => !['workspaceType', 'workspaceVersionId', 'inputId'].includes(key)) || parameters.size !== new Set(parameters.keys()).size || (parameters.size && !['internal', 'external'].includes(workspaceType)) || (workspaceVersionId && inputId)) fail('工作区范围参数无效')
    if (binding) {
      access.requireThread(principal, threadId)
      if (binding.projectId !== projectId || binding.environmentId !== environmentId) fail()
      if (parameters.size && (binding.workspaceType !== workspaceType || (workspaceVersionId && binding.workspaceVersionId !== workspaceVersionId))) fail('会话资料范围不能切换，请新建对话')
      if (parameters.size && !workspaceVersionId) binding = { ...binding, workspaceVersionId: undefined }
    } else if (parameters.size) binding = { projectId, environmentId, workspaceType, workspaceVersionId }
    else throw new AutoOpsAccessError(409, 'WORKSPACE_REQUIRED', '请先选择资料范围')
    workspace(binding)
    access.requireWorkspace(principal, projectId, binding.workspaceType || 'internal', binding.workspaceVersionId, environmentId)
    return { project, environmentId, threadId, binding, inputId }
  }
  function projectAtCwd(principal, cwd) {
    return scopeAtCwd(principal, cwd).project
  }
  function visible(principal, project, binding) {
    access.requireWorkspace(principal, project.id, binding?.workspaceType || 'internal', binding?.workspaceVersionId, binding?.environmentId)
    return catalog(project, access.listResourceThreads(principal, project.id), binding)
  }
  function assertPath(path) {
    if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.') || path.includes('\0')) fail()
  }
  const entriesWithFolders = (files) => {
    const result = new Map(files.map((file) => [file.path, { path: file.path, kind: file.type === 'directory' ? 'directory' : 'file' }]))
    for (const file of files) {
      const parts = file.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const path = parts.slice(0, i).join('/')
        result.set(path, { path, kind: 'directory' })
      }
    }
    return [...result.values()].sort((a, b) => a.path.localeCompare(b.path))
  }
  const directChildren = (files, directory) => {
    if (directory) assertPath(directory)
    const prefix = directory ? directory + '/' : ''
    return entriesWithFolders(files).filter((entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/'))
  }
  const inputs = () => workspaceInputs ??= configuredWorkspaceManagement(access)
  const inputRoot = (projectId, inputId) => `autoops/${projectId}/inputs/${inputId}`
  function referenceOwner(binding, input, actor) {
    if (!inputs().readInputReference) throw new AutoOpsAccessError(503, 'WORKSPACE_UNAVAILABLE', '工作区文件定位暂时不可用')
    try {
      inputs().readInputReference(binding.projectId, input.inputId, actor, actor, binding.workspaceType)
      return actor
    } catch (error) { if (error.code !== 'WORKSPACE_INPUT_NOT_FOUND') throw error }
    const own = access.listThreadInputs(binding.threadId).find(value => value.inputId === input.inputId)
    const reference = access.inputReferences(binding.threadId).find(value => value.inputId === input.inputId)
    const inputOwnerId = own?.inputOwnerId ?? reference?.actorId
    if (!inputOwnerId) fail('此文件输入不属于当前可见会话或已确认引用')
    return inputOwnerId
  }
  function referenceScope(principal, input) {
    const binding = access.requireCurrentFileReference(principal, input.threadId, input.viewerThreadId ?? input.threadId)
    if (binding.projectId !== input.projectId || binding.workspaceType !== input.workspaceType || binding.executionBinding?.kind === 'customer') fail()
    access.requireWorkspace(principal, binding.projectId, input.workspaceType, undefined, binding.environmentId)
    return referenceOwner(binding, input, principal.id)
  }
  function resolvedReference(principal, input, expectedRevision) {
    const request = decodeContract(WorkspaceFileReferenceRequest, { threadId: input.threadId, inputId: input.inputId, path: input.path, workspaceType: input.workspaceType,
      ...(input.viewerThreadId === undefined ? {} : { viewerThreadId: input.viewerThreadId }) })
    assertPath(request.path)
    const scoped = { ...request, projectId: input.projectId }
    const actor = referenceScope(principal, scoped)
    if (!inputs().resolveInputFileReference) throw new AutoOpsAccessError(503, 'WORKSPACE_UNAVAILABLE', '工作区文件定位暂时不可用')
    const current = inputs().resolveInputFileReference(scoped.projectId, request.inputId, request.path, actor, principal.id, request.workspaceType)
    if (current.workspaceType !== request.workspaceType || referenceScope(principal, scoped) !== actor) fail()
    if (expectedRevision !== undefined && (current.mode !== 'current' || current.revision !== expectedRevision))
      throw new AutoOpsAccessError(409, 'WORKSPACE_REFERENCE_CHANGED', '当前文件已更新，请重新打开预览')
    const resourcePath = current.mode === 'original' ? `${inputRoot(scoped.projectId, request.inputId)}/${request.path}` :
      `autoops/${scoped.projectId}/current-input-files/${request.threadId}/${request.inputId}/${current.revision}/${request.path}`
    const value = decodeContract(WorkspaceFileReference, { projectId: scoped.projectId, threadId: request.threadId, viewerThreadId: request.viewerThreadId ?? request.threadId, workspaceType: request.workspaceType,
      originalInputId: request.inputId, originalPath: request.path, currentPath: current.currentPath, mode: current.mode,
      resourcePath, revision: current.revision, sha256: current.sha256, changed: current.changed })
    return { value, file: current.file }
  }
  function currentIdentity(path) {
    assertPath(path)
    const match = /^autoops\/([^/]+)\/current-input-files\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(path)
    return match ? { projectId: match[1], threadId: match[2], inputId: match[3], revision: match[4], path: match[5] } : undefined
  }
  function currentReference(principal, path) {
    const identity = currentIdentity(path)
    if (!identity) fail('当前文件定位无效')
    const binding = access.requireThread(principal, identity.threadId)
    const result = resolvedReference(principal, { ...identity, workspaceType: binding.workspaceType }, identity.revision)
    return { type: 'current-reference', path, projectId: identity.projectId, name: result.file.name, mime: result.file.mime,
      size: result.file.bytes.byteLength, bytes: result.file.bytes }
  }
  function toolReferenceScope(threadId, identity, actor) {
    const target = access.requireToolThread(threadId, actor)
    const source = access.requireCurrentFileReferenceForActor(target.actorId, identity.threadId, threadId)
    if (source.projectId !== identity.projectId) fail()
    return { binding: target.binding, actor: target.actorId, owner: referenceOwner(source, identity, target.actorId) }
  }
  function inputIdentity(path) {
    assertPath(path)
    const match = path.match(/^autoops\/([^/]+)\/inputs\/([^/]+)(?:\/(.*))?$/)
    return match ? { projectId: match[1], inputId: match[2], relativePath: match[3] || '' } : undefined
  }
  function inputCatalog(projectId, inputId, actorId, workspaceType) {
    const capture = inputs().readInput(projectId, inputId, actorId)
    if (workspaceType && capture.workspaceType !== workspaceType) fail('资料输入不属于当前范围')
    const root = inputRoot(projectId, inputId)
    const files = inputs().inputFiles(projectId, inputId, actorId).map(file => ({
      ...file, path: `${root}/${file.path}`, relativePath: file.path, type: 'input', inputId, actorId, projectId,
      id: file.id, name: file.path.split('/').at(-1), sourceUrl: `/api/agent-demo/t3/autoops/resources?path=${encodeURIComponent(`${root}/${file.path}`)}`,
    }))
    for (const directory of capture.directories) files.push({ path: `${root}/${directory}`, type: 'directory', inputId, actorId, projectId })
    return { capture, files, root, actorId }
  }
  function userInput(principal, identity, workspaceType) {
    access.requireProject(principal, identity.projectId)
    const actors = [principal.id]
    for (const { binding } of access.listResourceThreads(principal, identity.projectId)) {
      for (const value of access.listThreadInputs(binding.threadId)) if (value.inputId === identity.inputId) actors.push(value.inputOwnerId)
      for (const reference of access.inputReferences(binding.threadId)) if (reference.inputId === identity.inputId) actors.push(reference.actorId)
    }
    for (const actor of new Set(actors)) {
      let selected
      try { selected = inputCatalog(identity.projectId, identity.inputId, actor, workspaceType) }
      catch (error) { if (error.code === 'WORKSPACE_INPUT_NOT_FOUND') continue; throw error }
      access.requireWorkspace(principal, identity.projectId, selected.capture.workspaceType)
      return selected
    }
    fail()
  }
  function threadInput(threadId, inputId, reference = false, actorId) {
    const own = access.listThreadInputs(threadId).find(value => value.inputId === inputId)
    const { binding, actorId: caller } = access.requireToolThread(threadId, actorId ?? own?.actorId)
    const retained = reference ? access.inputReferences(threadId).find(value => value.inputId === inputId) : undefined
    if (!own && !retained) fail('资料输入不属于此会话任务或已验证引用')
    access.requireWorkspaceInputReader(caller, binding.projectId, binding.workspaceType || 'internal')
    return inputCatalog(binding.projectId, inputId, retained?.actorId ?? own?.inputOwnerId ?? binding.ownerId, binding.workspaceType || 'internal')
  }
  async function scopedInput(principal, scope, path) {
    const identity = path ? inputIdentity(path) : undefined
    if (identity && (identity.projectId !== scope.project.id || (scope.inputId && scope.inputId !== identity.inputId))) fail()
    const inputId = identity?.inputId ?? scope.inputId
    if (inputId) return userInput(principal, { projectId: scope.project.id, inputId }, scope.binding.workspaceType)
    const capture = await inputs().captureAvailableInput(scope.project.id, { workspaceType: scope.binding.workspaceType }, principal.id)
    scopeAtCwd(principal, scope.cwd)
    return userInput(principal, { projectId: scope.project.id, inputId: capture.id }, scope.binding.workspaceType)
  }
  async function latestEntries(principal, input, listing) {
    const scope = { ...scopeAtCwd(principal, input.cwd), cwd: input.cwd }
    const selected = await scopedInput(principal, scope, input.directoryPath)
    const files = selected.files.filter(file => !input.imageOnly || file.mime?.startsWith('image/'))
    let matches
    if (listing) matches = directChildren(files, input.directoryPath?.replace(/\/$/, '') || selected.root)
    else if (input.query.startsWith('./') || input.query.endsWith('/')) {
      const query = input.query.replace(/^\.\//, '')
      if (query) assertPath(query)
      const separator = query.lastIndexOf('/'), directory = separator < 0 ? '' : query.slice(0, separator), prefix = query.slice(separator + 1).toLocaleLowerCase()
      matches = directChildren(files, selected.root + (directory ? '/' + directory : '')).filter(entry => entry.path.split('/').at(-1).toLocaleLowerCase().startsWith(prefix))
    } else matches = entriesWithFolders(files).filter(entry => entry.path.startsWith(selected.root + '/') && entry.path.slice(selected.root.length + 1).toLocaleLowerCase().includes(input.query.toLocaleLowerCase()))
    matches = matches.filter(entry => !input.kind || entry.kind === input.kind)
    const limit = listing ? 500 : input.limit
    return { entries: matches.slice(0, limit), truncated: matches.length > limit }
  }
  function findVisible(principal, path) {
    assertPath(path)
    if (path.split('/')[2] === 'current-input-files') return currentReference(principal, path)
    const identity = inputIdentity(path)
    if (identity) { const found = userInput(principal, identity).files.find(file => file.path === path && file.type !== 'directory'); if (!found) fail(); return found }
    const project = access.requireProject(principal, path.split('/')[1])
    const parts = path.split('/')
    const selected = parts[2] === 'workspaces' ? workspaceStore?.getVersion(project.id, parts[3]) : null
    if (parts[2] === 'workspaces' && !selected) fail()
    const binding = selected ? { projectId: project.id, workspaceType: selected.type, workspaceVersionId: selected.id } : parts[2] === 'threads' ? access.getThreadBinding(parts[3]) : undefined
    if (parts[2] === 'environments') access.requireEnvironment(principal, project.id, parts[3])
    const found = visible(principal, project, binding).find((entry) => entry.path === path)
    if (!found) fail()
    return found
  }
  async function bytes(resource) {
    if (resource.type === 'current-reference') return resource.bytes
    if (resource.type === 'input') return inputs().readInputFile(resource.projectId, resource.inputId, resource.relativePath, resource.actorId).bytes
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
    if (!readAttachment) throw new AutoOpsAccessError(503, 'ATTACHMENT_READER_UNAVAILABLE', '附件读取暂时不可用')
    return readAttachment(resource.id)
  }
  function requireExtractedText(extracted, fallback) {
    if (typeof extracted.content === 'string') return extracted.content
    const code = extracted.extraction?.code
    const retryable = new Set(['DOCUMENT_BUSY', 'DOCUMENT_WORKER_ERROR', 'DOCUMENT_WORKER_EXIT', 'DOCUMENT_RESOURCE_LIMIT'])
    if (code === 'DOCUMENT_TIMEOUT' || retryable.has(code))
      throw new AutoOpsAccessError(code === 'DOCUMENT_TIMEOUT' ? 504 : 503, code, extracted.extraction.message || '文档处理暂时不可用，请稍后重试')
    throw new AutoOpsAccessError(415, 'RESOURCE_NOT_TEXT', extracted.extraction?.message || fallback)
  }
  async function contents(resource) {
    if (resource.type === 'input') {
      const result = await inputs().readInputContent(resource.projectId, resource.inputId, resource.relativePath, resource.actorId)
      return requireExtractedText({ content: result.contents, extraction: result.extraction }, '正文暂不可用，请查看原件')
    }
    if (resource.type === 'workspace') return (await workspaceContents(resource)).contents
    const data = await bytes(resource)
    const extracted = await extractBusinessAttachment({ id: resource.id, name: resource.name, mime: resource.mime, bytes: data })
    return requireExtractedText(extracted, '该资料请通过原始文件预览')
  }
  async function workspaceContents(resource) {
    try { return workspaceStore.read(resource.projectId, resource.workspaceVersionId, resource.relativePath) }
    catch (error) { if (error.status !== 415) throw error }
    const data = workspaceStore.readBytes(resource.projectId, resource.workspaceVersionId, resource.relativePath)
    // 解析只接收已授权且通过固定版本校验的字节，不从变化中的资料目录读取。
    const extracted = await extractBusinessAttachment({ id: resource.id, name: resource.name, mime: resource.mime, bytes: data })
    const content = requireExtractedText(extracted, '该资料的正文不可提取，请查看原件')
    return { contents: content, byteLength: Buffer.byteLength(content), truncated: false }
  }
  function forThread(threadId, currentInput = false, actorId) {
    const target = access.requireToolThread(threadId, actorId)
    return catalog(target.project, access.listToolResourceThreads(threadId, actorId), target.binding, currentInput).filter((entry) => entry.environmentId === undefined || entry.environmentId === target.binding.environmentId)
  }

  return {
    resolveWorkspaceFileReference(principal, input) { return resolvedReference(principal, input).value },
    projectAtCwd,
    search(principal, input) {
      const scope = scopeAtCwd(principal, input.cwd), { project } = scope
      if (scope.binding.workspaceType && !scope.binding.workspaceVersionId) return latestEntries(principal, input, false)
      const needle = input.query.toLocaleLowerCase()
      const workspacePrefix = scope.binding.workspaceVersionId ? `autoops/${project.id}/workspaces/${scope.binding.workspaceVersionId}/` : undefined
      const workspaceAncestors = workspacePrefix ? new Set(['autoops', `autoops/${project.id}`, `autoops/${project.id}/workspaces`, workspacePrefix.slice(0, -1)]) : undefined
      const files = visible(principal, project, scope.binding).filter((file) => (file.environmentId === undefined || file.environmentId === scope.environmentId) && (!input.imageOnly || file.mime.startsWith('image/')))
      if (workspacePrefix && input.query.startsWith('./')) {
        const path = input.query.slice(2)
        if (path) assertPath(path)
        if (path.includes('//') || /[\u0000-\u001f\u007f:]/.test(path)) fail()
        const separator = path.lastIndexOf('/')
        const directory = separator < 0 ? '' : path.slice(0, separator)
        const prefix = path.slice(separator + 1).toLocaleLowerCase()
        const matches = directChildren(files, workspacePrefix.slice(0, -1) + (directory ? '/' + directory : '')).filter((entry) =>
          (!input.kind || entry.kind === input.kind) && entry.path.slice(entry.path.lastIndexOf('/') + 1).toLocaleLowerCase().startsWith(prefix))
        return { entries: matches.slice(0, input.limit), truncated: matches.length > input.limit }
      }
      if (workspacePrefix && input.query.endsWith('/')) {
        const directory = input.query.slice(0, -1)
        if (directory) assertPath(directory)
        const matches = directChildren(files, workspacePrefix.slice(0, -1) + (directory ? '/' + directory : '')).filter((entry) => !input.kind || entry.kind === input.kind)
        return { entries: matches.slice(0, input.limit), truncated: matches.length > input.limit }
      }
      const matches = entriesWithFolders(files).filter((entry) => {
        if (workspaceAncestors?.has(entry.path)) return false
        const relativePath = workspacePrefix && entry.path.startsWith(workspacePrefix) ? entry.path.slice(workspacePrefix.length) : entry.path
        return (!input.kind || entry.kind === input.kind) && relativePath.toLocaleLowerCase().includes(needle)
      })
      return { entries: matches.slice(0, input.limit), truncated: matches.length > input.limit }
    },
    list(principal, input) {
      const { project, environmentId, binding } = scopeAtCwd(principal, input.cwd)
      if (binding.workspaceType && !binding.workspaceVersionId) return latestEntries(principal, input, true)
      const directory = input.directoryPath?.replace(/\/$/, '') || ''
      const matches = directChildren(visible(principal, project, binding).filter((entry) => entry.environmentId === undefined || entry.environmentId === environmentId), directory)
      return { entries: matches.slice(0, 500), truncated: matches.length > 500 }
    },
    async read(principal, input) {
      const { project, environmentId, binding } = scopeAtCwd(principal, input.cwd)
      assertPath(input.relativePath)
      if (binding.workspaceType && !binding.workspaceVersionId) {
        const selected = await scopedInput(principal, { project, environmentId, binding, cwd: input.cwd, inputId: scopeAtCwd(principal, input.cwd).inputId }, input.relativePath)
        const file = selected.files.find(file => file.path === input.relativePath && file.type !== 'directory')
        if (!file) fail()
        const text = await contents(file)
        scopeAtCwd(principal, input.cwd); userInput(principal, inputIdentity(file.path), binding.workspaceType)
        return { relativePath: file.path, contents: text, byteLength: Buffer.byteLength(text), truncated: false, exists: true }
      }
      const resource = visible(principal, project, binding).find((entry) => entry.path === input.relativePath)
      if (!resource) fail()
      if (resource.path.split('/')[1] !== project.id || (resource.environmentId !== undefined && resource.environmentId !== environmentId)) fail()
      const recheck = () => {
        const current = scopeAtCwd(principal, input.cwd)
        if (!visible(principal, current.project, current.binding).some(entry => entry.path === resource.path && (entry.environmentId === undefined || entry.environmentId === current.environmentId))) fail()
      }
      if (resource.type === 'workspace') {
        const file = await workspaceContents(resource)
        recheck()
        return { relativePath: resource.path, contents: file.contents, byteLength: file.byteLength, truncated: file.truncated, exists: true }
      }
      const text = await contents(resource)
      recheck()
      return { relativePath: resource.path, contents: text, byteLength: Buffer.byteLength(text), truncated: false, exists: true }
    },
    async resource(principal, path) {
      const resource = findVisible(principal, path), data = await bytes(resource)
      findVisible(principal, path)
      return { ...resource, bytes: data }
    },
    async metadata(principal, paths) {
      const entries = []
      for (const path of paths) {
        assertPath(path)
        if (path.split('/')[2] === 'current-input-files') {
          const file = findVisible(principal, path)
          entries.push({ kind: 'file', byteLength: file.size, mimeType: file.mime })
          continue
        }
        const identity = inputIdentity(path)
        if (identity) {
          const selected = userInput(principal, identity), file = selected.files.find(file => file.path === path)
          entries.push(file ? file.type === 'directory' ? { kind: 'directory' } : { kind: 'file', byteLength: file.size, mimeType: file.mime } : path === selected.root || entriesWithFolders(selected.files).some(entry => entry.path === path && entry.kind === 'directory') ? { kind: 'directory' } : null)
          continue
        }
        if (path === 'autoops') { entries.push({kind:'directory'}); continue }
        const project = access.requireProject(principal, path.split('/')[1])
        const parts = path.split('/')
        if (parts.length === 2) { entries.push({kind:'directory'}); continue }
        if (parts.length === 3 && parts[2] === 'workspaces') { entries.push({kind:'directory'}); continue }
        const selected = parts[2] === 'workspaces' ? workspaceStore?.getVersion(project.id, parts[3]) : null
        const binding = selected ? { projectId: project.id, workspaceType: selected.type, workspaceVersionId: selected.id } : parts[2] === 'threads' ? access.getThreadBinding(parts[3]) : undefined
        if (parts[2] === 'environments') access.requireEnvironment(principal, project.id, parts[3])
        const files = visible(principal, project, binding)
        const file = files.find((entry) => entry.path === path)
        if (file) entries.push({ kind: 'file', byteLength: file.size ?? (file.content ? Buffer.byteLength(file.content) : 0), mimeType: file.mime })
        else entries.push(entriesWithFolders(files).some((entry) => entry.path === path && entry.kind === 'directory') ? {kind: 'directory'} : null)
      }
      return {entries}
    },
    requireContext(threadId, context, actorId, claim) {
      let allowed
      for (const record of context?.records || []) if (record.kind === 'mention') {
        assertPath(record.path)
        const current = currentIdentity(record.path)
        if (current) {
          const scope = toolReferenceScope(threadId, current, actorId)
          const file = inputs().resolveInputFileReference(current.projectId, current.inputId, current.path, scope.owner, scope.actor, scope.binding.workspaceType)
          if (file.mode !== 'current' || file.revision !== current.revision) throw new AutoOpsAccessError(409, 'WORKSPACE_REFERENCE_CHANGED', '当前文件已更新，请重新打开预览')
          toolReferenceScope(threadId, current, actorId)
          continue
        }
        const identity = inputIdentity(record.path)
        if (identity) {
          const { binding } = access.requireToolThread(threadId, actorId)
          if (identity.projectId !== binding.projectId) fail()
          const actors = [actorId ?? binding.ownerId]
          for (const source of access.listToolResourceThreads(threadId, actorId)) {
            if (source.binding.workspaceType !== binding.workspaceType) continue
            for (const value of access.listThreadInputs(source.binding.threadId)) if (value.inputId === identity.inputId) actors.push(value.inputOwnerId)
          }
          let selected
          for (const actor of new Set(actors)) {
            try { selected = inputCatalog(identity.projectId, identity.inputId, actor, binding.workspaceType || 'internal'); break }
            catch (error) { if (error.code !== 'WORKSPACE_INPUT_NOT_FOUND') throw error }
          }
          if (!selected || !(record.path === selected.root || entriesWithFolders(selected.files).some(entry => entry.path === record.path))) fail()
          access.retainInputReference(threadId, identity.inputId, selected.actorId, actorId, claim)
          continue
        }
        allowed ??= entriesWithFolders(forThread(threadId, false, actorId))
        if (!allowed.some((entry) => entry.path === record.path)) fail('引用不属于当前环境或授权受众，或其资料版本已改变')
      }
    },
    async readForThread(threadId, path, inputId, referenceInputIds = [], history) {
      assertPath(path)
      const run = inputId ? access.requireRunInput(threadId, inputId, history?.runId) : undefined
      const actorId = run?.actorId
      const current = currentIdentity(path)
      if (current) {
        if (!inputId || !history?.referencePaths?.includes(path)) fail('当前文件未在本轮上下文中获准')
        const scope = toolReferenceScope(threadId, current, actorId)
        const fixed = threadInput(threadId, inputId, false, actorId)
        const resolved = inputs().fixedInputFileReference(current.projectId, current.inputId, current.path, scope.owner, inputId, fixed.actorId, scope.actor, scope.binding.workspaceType)
        const content = await inputs().readInputContent(current.projectId, inputId, resolved.path, fixed.actorId)
        toolReferenceScope(threadId, current, actorId); threadInput(threadId, inputId, false, actorId)
        return { path, name: resolved.file.path.split('/').at(-1), mime: resolved.file.mime, content: requireExtractedText({ content: content.contents, extraction: content.extraction }, '正文暂不可用，请查看原件'), source: 'workspace_input', inputId, capturedAt: resolved.capturedAt,
          sourceUrl: `/api/agent-demo/t3/autoops/resources?path=${encodeURIComponent(`${inputRoot(current.projectId, inputId)}/${resolved.path}`)}` }
      }
      const identity = inputIdentity(path)
      if (identity) {
        if (!inputId) fail('读取本轮资料必须提供任务输入身份')
        threadInput(threadId, inputId, false, actorId)
        const history = access.listThreadInputs(threadId)
        const currentIndex = history.findIndex(value => value.inputId === inputId), targetIndex = history.findIndex(value => value.inputId === identity.inputId)
        if (identity.inputId !== inputId && !(targetIndex >= 0 && targetIndex < currentIndex) && !referenceInputIds.includes(identity.inputId)) fail('不能读取后来轮次或不在本轮上下文中的资料输入')
        const selected = threadInput(threadId, identity.inputId, true, actorId)
        if (identity.projectId !== selected.capture.projectId) fail()
        const file = selected.files.find(file => file.path === path && file.type !== 'directory')
        if (file) {
          const content = await contents(file)
          threadInput(threadId, inputId, false, actorId); threadInput(threadId, identity.inputId, true, actorId)
          return { path, name: file.name, mime: file.mime, content, source: 'workspace_input', inputId: identity.inputId, capturedAt: selected.capture.createdAt, sourceUrl: file.sourceUrl }
        }
        if (path !== selected.root && !entriesWithFolders(selected.files).some(entry => entry.path === path && entry.kind === 'directory')) {
          const unavailable = selected.capture.sourceErrors?.find(source => identity.relativePath === source.mountPath || identity.relativePath.startsWith(source.mountPath + '/'))
          if (unavailable) throw new AutoOpsAccessError(503, 'WORKSPACE_INPUT_SOURCE_UNAVAILABLE', unavailable.message)
          fail()
        }
        return { path, kind: 'directory', sourceErrors: selected.capture.sourceErrors ?? [], sourceWarnings: selected.capture.sourceWarnings ?? [], entries: selected.files.filter(file => file.type !== 'directory' && file.path.startsWith(path + '/')).map(({ path, name, mime }) => ({ path, name, mime })) }
      }
      if(path.startsWith('autoops/skills/'))return readScopedSkillResourceForThread(process.env.AUTOOPS_T3_DATA_DIR,threadId,path,access)
      const historical = path.startsWith(`autoops/${access.requireToolThread(threadId, actorId).binding.projectId}/workspaces/`)
      const resources = forThread(threadId, Boolean(inputId) && !historical, actorId).filter(resource => {
        if (!inputId || !['attachment', 'report'].includes(resource.type)) return true
        const mentioned = history?.referencePaths?.some(path => resource.path === path || resource.path.startsWith(path + '/'))
        if (mentioned && typeof resource.createdAt === 'string' && resource.createdAt <= history.acceptedAt) return true
        if (resource.type === 'attachment') return history?.attachmentIds?.includes(resource.id) ?? false
        const artifact = artifactStore?.read(resource.id)
        if (!artifact || artifact.threadId !== threadId) return false
        const runs = access.listThreadInputs(threadId), currentIndex = runs.findIndex(value => value.inputId === inputId), artifactIndex = runs.findIndex(value => value.runId === artifact.runId)
        return artifactIndex >= 0 && artifactIndex <= currentIndex
      })
      const resource = resources.find((entry) => entry.path === path)
      if (resource) {
        const read = resource.type === 'workspace' ? await workspaceContents(resource) : null
        const content = read ? read.contents : await contents(resource)
        if (!forThread(threadId, Boolean(inputId) && !historical, actorId).some((entry) => entry.path === path)) fail()
        return { path, name: resource.name, mime: resource.mime, content, ...(read ? { source: 'workspace_snapshot', workspaceVersionId: resource.workspaceVersionId, byteLength: read.byteLength, truncated: read.truncated } : {}), sourceUrl: resource.sourceUrl || `/api/agent-demo/t3/autoops/resources?path=${encodeURIComponent(path)}` }
      }
      const folder = entriesWithFolders(resources).find((entry) => entry.path === path && entry.kind === 'directory')
      if (!folder) fail()
      return { path, kind: 'directory', entries: resources.filter((entry) => entry.path.startsWith(path + '/')).map(({path,name,mime}) => ({path,name,mime})) }
    },
  }
}
export function configuredBusinessResourceCatalog({ readAttachment } = {}) {
  const access = configuredAutoOpsAccess()
  if (!access) return undefined
  // 配置资源由各自所有者持有；目录本身没有连接或可变缓存。
  return createBusinessResourceCatalog({ access, artifactStore: configuredBusinessArtifactStore(), readAttachment })
}
