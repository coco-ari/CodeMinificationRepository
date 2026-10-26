// 入口只裁决业务动作；文件处理和版本发布仍由工作区服务拥有。
const fail = (status, code, message) => { throw Object.assign(new Error(message), {status, code}) }

export async function handleWorkspaceRequest({access, store, principal, url, method, input}) {
  const match = /^\/autoops\/projects\/([^/]+)\/workspaces(?:\/(.*))?$/.exec(url.pathname)
  if (!match || !store) fail(404, 'WORKSPACE_NOT_FOUND', '工作区不存在')
  const projectId = decodeURIComponent(match[1])
  const project = access.requireProject(principal, projectId)
  const membership = access.requireMembership(principal, projectId)
  await store.ensureProject(project)
  const parts = (match[2] ?? '').split('/').filter(Boolean).map(decodeURIComponent)
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const canManage = access.projectCapabilities(principal, projectId)['workspace.manage']
  const publicExternal = (version) => {
    const { sourceVersionId: _sourceVersionId, ...rest } = version
    return { ...rest, source: { contentHash: version.source.contentHash, repositories: [] } }
  }
  if (method === 'GET') {
    if (!parts.length) {
      const overview = store.overview(projectId), internal = membership.workspaceAccess === 'internal'
      return {status:200, body:{...overview, internalVersions: internal ? overview.internalVersions.filter((entry) => canManage || entry.status === 'published') : [], externalVersions: overview.externalVersions.filter((entry) => canManage || entry.status === 'published').map((entry) => internal ? entry : publicExternal(entry)), releases: canManage ? overview.releases : [], tasks: canManage ? overview.tasks : [], import: {...overview.import, supported:canManage, ...(internal ? {} : {hosts:[]})}}}
    }
    if (parts[0] === 'versions' && parts.length === 3) {
      const [, versionId, action] = parts
      const overview = store.overview(projectId)
      const version = [...overview.internalVersions, ...overview.externalVersions].find((entry) => entry.id === versionId && (canManage || entry.status === 'published'))
      if (!version) fail(404, 'WORKSPACE_NOT_FOUND', '工作区版本不存在或尚未发布')
      access.requireWorkspace(principal, projectId, version.type, version.status === 'published' ? version.id : undefined)
      const path = url.searchParams.get('path') ?? ''
      if (action === 'tree') return {status:200, body:store.managementTree(projectId, versionId, url.searchParams.get('directory') ?? '')}
      if (action === 'search') return {status:200, body:store.managementSearch(projectId, versionId, url.searchParams.get('query') ?? '', Number(url.searchParams.get('limit') ?? 200))}
      if (action === 'content') return {status:200, body:store.managementRead(projectId, versionId, path)}
      if (action === 'download') return {status:200, file:store.versionFile(projectId, versionId, path)}
    }
    if (parts[0] === 'packages') {
      access.requireWorkspaceManager(principal, projectId)
      if (parts.length === 4 && parts[3] === 'download')
        return {status:200, file:store.packageFile(projectId, parts[1], parts[2])}
      if (parts.length === 3 && parts[2] === 'manifest') {
        const release = store.overview(projectId).releases.find((entry) => entry.id === parts[1])
        if (!release) fail(404, 'PACKAGE_NOT_FOUND', '发布记录不存在')
        return {status:200, file:{name:'manifest.json', mime:'application/json', bytes:Buffer.from(JSON.stringify(release.manifest, null, 2) + '\n')}}
      }
    }
  }
  if (method === 'POST') {
    access.requireWorkspaceManager(principal, projectId)
    if (parts.length === 1 && parts[0] === 'external') {
      access.requireProjectAction(principal, projectId, 'workspace.external.publish')
      const previous = store.taskForRequest(projectId, 'external', body.requestId, principal.id)
      if (previous) return {status:202, body:previous}
      fail(410, 'WORKSPACE_EXTERNAL_CURRENT_REQUIRED', '请从当前内部资料更新外部工作区，不再从历史版本创建新任务')
    }
    if (parts.length === 1 && parts[0] === 'packages') return {status:202, body:store.startPackages(projectId, body, principal.id)}
    if (parts.length === 1 && parts[0] === 'import') return {status:202, body:store.startImport(projectId, body, principal.id)}
    if (parts.length === 3 && parts[0] === 'versions' && parts[2] === 'publish') {
      access.requireProjectAction(principal, projectId, 'workspace.external.publish')
      return {status:200, body:store.confirmExternal(projectId, parts[1], body)}
    }
    if (parts.length === 3 && parts[0] === 'tasks' && parts[2] === 'cancel')
      return {status:200, body:store.cancelTask(projectId, parts[1])}
  }
  fail(404, 'WORKSPACE_ROUTE_NOT_FOUND', '此工作区操作不存在')
}
