const fail = (status, code, message) => { throw Object.assign(new Error(message), {status, code}) }

export async function handleDeploymentRequest({access, store, principal, url, method, input}) {
  const match = /^\/autoops\/projects\/([^/]+)\/deployments(?:\/(.*))?$/.exec(url.pathname)
  if (!match) fail(404, 'DEPLOYMENT_ROUTE_NOT_FOUND', '此部署操作不存在')
  const projectId = decodeURIComponent(match[1]), project = access.requireProject(principal, projectId), membership = access.requireWorkspaceManager(principal, projectId)
  const parts = (match[2] || '').split('/').filter(Boolean).map(decodeURIComponent)
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const requireEnvironment = (environmentId) => { if (typeof environmentId !== 'string') fail(400, 'DEPLOYMENT_ENVIRONMENT_REQUIRED', '请选择部署环境'); access.requireEnvironment(principal, projectId, environmentId); return environmentId }
  if (method === 'GET' && !parts.length) {
    const explicit = url.searchParams.get('environmentId'), environmentIds = explicit === null ? project.environments.filter((item) => membership.environmentIds.includes(item.id)).map((item) => item.id) : [explicit]
    for (const environmentId of environmentIds) requireEnvironment(environmentId)
    if (!store) return {status:200, body:{enabled:false, environments:[], servers:[], targets:[], tasks:[]}}
    await store.ensureProject(project)
    return {status:200, body:store.overview(project, environmentIds)}
  }
  if (!store) fail(503, 'DEPLOYMENT_DISABLED', '部署验证尚未启用')
  await store.ensureProject(project)
  if (method === 'POST' && parts.length === 1 && ['servers', 'targets'].includes(parts[0])) {
    requireEnvironment(body.environmentId)
    return {status:201, body:await (parts[0] === 'servers' ? store.createServer(projectId, body) : store.createTarget(projectId, body))}
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'tasks') {
    requireEnvironment(store.targetScope(projectId, body.targetId).environmentId)
    return {status:202, body:await store.createTask(projectId, body, principal)}
  }
  if (method === 'GET' && parts.length === 2 && parts[0] === 'tasks') {
    requireEnvironment(store.taskScope(projectId, parts[1]).environmentId)
    return {status:200, body:await store.taskDetails(projectId, parts[1], Number(url.searchParams.get('after') || 0))}
  }
  if (method === 'GET' && parts.length === 3 && parts[0] === 'targets' && parts[2] === 'releases') {
    requireEnvironment(store.targetScope(projectId, parts[1]).environmentId)
    return {status:200, body:store.releases(projectId, parts[1])}
  }
  fail(404, 'DEPLOYMENT_ROUTE_NOT_FOUND', '此部署操作不存在')
}
