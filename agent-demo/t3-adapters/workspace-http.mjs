// Business transport only; file processing and version publication belong to the store.
const fail = (status, code, message) => { throw Object.assign(new Error(message), {status, code}) }

export async function handleWorkspaceRequest({access, store, principal, url, method, input}) {
  const match = /^\/autoops\/projects\/([^/]+)\/workspaces(?:\/(.*))?$/.exec(url.pathname)
  if (!match || !store) fail(404, 'WORKSPACE_NOT_FOUND', '工作区不存在')
  const projectId = decodeURIComponent(match[1])
  const project = access.requireProject(principal, projectId)
  await store.ensureProject(project)
  const parts = (match[2] ?? '').split('/').filter(Boolean).map(decodeURIComponent)
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  if (method === 'GET') {
    if (!parts.length) return {status:200, body:store.overview(projectId)}
    if (parts[0] === 'versions' && parts.length === 3) {
      const [, versionId, action] = parts
      const path = url.searchParams.get('path') ?? ''
      if (action === 'tree') return {status:200, body:store.managementTree(projectId, versionId, url.searchParams.get('directory') ?? '')}
      if (action === 'content') return {status:200, body:store.managementRead(projectId, versionId, path)}
      if (action === 'download') return {status:200, file:store.versionFile(projectId, versionId, path)}
    }
    if (parts[0] === 'packages') {
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
    if (parts.length === 1 && parts[0] === 'external') return {status:202, body:store.startExternal(projectId, body)}
    if (parts.length === 1 && parts[0] === 'packages') return {status:202, body:store.startPackages(projectId, body)}
    if (parts.length === 1 && parts[0] === 'import') return {status:202, body:store.startImport(projectId, body)}
    if (parts.length === 3 && parts[0] === 'versions' && parts[2] === 'publish')
      return {status:200, body:store.confirmExternal(projectId, parts[1], body)}
    if (parts.length === 3 && parts[0] === 'tasks' && parts[2] === 'cancel')
      return {status:200, body:store.cancelTask(projectId, parts[1])}
  }
  fail(404, 'WORKSPACE_ROUTE_NOT_FOUND', '此工作区操作不存在')
}
