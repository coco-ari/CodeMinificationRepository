const fail = (status, code, message) => {
  throw Object.assign(new Error(message), { status, code })
}

export async function handleDeploymentRequest({ access, store, principal, url, method, input }) {
  const readChecks = []
  const checkAccess = (check) => {
    const result = check()
    if (method === 'GET') readChecks.push(check)
    return result
  }
  const response = await routeDeploymentRequest({ access, store, principal, url, method, input, checkAccess })
  // 异步读取完成后重新裁决原对象范围，不沿用等待前的成员、环境或会话状态。
  for (const check of readChecks) check()
  return response
}

async function routeDeploymentRequest({ access, store, principal, url, method, input, checkAccess }) {
  const match = /^\/autoops\/projects\/([^/]+)\/deployments(?:\/(.*))?$/.exec(url.pathname)
  if (!match) fail(404, 'DEPLOYMENT_ROUTE_NOT_FOUND', '此部署操作不存在')
  const projectId = decodeURIComponent(match[1]),
    project = checkAccess(() => access.requireProject(principal, projectId)),
    membership = checkAccess(() => access.requireDeploymentAction(principal, projectId, 'read'))
  const parts = (match[2] || '').split('/').filter(Boolean).map(decodeURIComponent)
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const actor = { id: principal.id, displayName: principal.displayName }
  const authorize = (action, environmentId) =>
    checkAccess(() => access.requireDeploymentAction(principal, projectId, action, environmentId))
  const requireEnvironment = (environmentId) => {
    if (typeof environmentId !== 'string')
      fail(400, 'DEPLOYMENT_ENVIRONMENT_REQUIRED', '请选择部署环境')
    checkAccess(() => access.requireEnvironment(principal, projectId, environmentId))
    return environmentId
  }
  if (method === 'GET' && !parts.length) {
    const explicit = url.searchParams.get('environmentId'),
      environmentIds =
        explicit === null
          ? project.environments
              .filter((item) => membership.environmentIds.includes(item.id))
              .map((item) => item.id)
          : [explicit]
    for (const environmentId of environmentIds) requireEnvironment(environmentId)
    if (!store)
      return {
        status: 200,
        body: {
          enabled: false,
          environments: [],
          servers: [],
          services: [],
          serviceSources: [],
          targets: [],
          tasks: [],
        },
      }
    await store.ensureProject(project)
    return { status: 200, body: store.overview(project, environmentIds) }
  }
  if (!store) fail(503, 'DEPLOYMENT_DISABLED', '部署验证尚未启用')
  await store.ensureProject(project)
  if (method === 'GET' && parts.length === 1 && parts[0] === 'servers') {
    const environmentId = requireEnvironment(url.searchParams.get('environmentId'))
    let canBind = false
    try { authorize('server.bind', environmentId); canBind = true } catch (error) { if (error.status !== 403) throw error }
    return {
      status: 200,
      body: {
        servers: store.overview(project, [environmentId]).servers,
        availableServers: canBind ? store.availableServers(projectId) : [],
        canAdmin: false,
        canBind,
      },
    }
  }
  if (parts[0] === 'servers' && parts.length >= 2) {
    if (method === 'POST' && parts.length === 3 && ['bind', 'unbind'].includes(parts[2])) {
      const environmentId = requireEnvironment(body.environmentId)
      authorize(parts[2] === 'bind' ? 'server.bind' : 'server.unbind', environmentId)
      return {
        status: 200,
        body: await (parts[2] === 'bind'
          ? store.bindServer(projectId, { ...body, serverId: parts[1], actor })
          : store.unbindServer(projectId, { ...body, serverId: parts[1], actor })),
      }
    }
    authorize('server.admin')
    if (method === 'POST' && parts.length === 3 && parts[2] === 'revoke')
      return {
        status: 200,
        body: await store.revokeServer(projectId, parts[1], { ...body, actor }),
      }
    if (method === 'DELETE' && parts.length === 2)
      return {
        status: 200,
        body: await store.deleteServer(projectId, parts[1], { ...body, actor }),
      }
    if (method === 'PUT' && parts.length === 3 && parts[2] === 'storage-policy')
      return {
        status: 200,
        body: await store.saveStoragePolicy(projectId, parts[1], { ...body, actor }),
      }
  }
  if (method === 'POST' && parts.length === 1 && ['servers', 'targets'].includes(parts[0])) {
    requireEnvironment(body.environmentId)
    authorize(parts[0] === 'servers' ? 'server.create' : 'configure', body.environmentId)
    return {
      status: 201,
      body: await (parts[0] === 'servers'
        ? store.createServer(projectId, { ...body, actor })
        : store.createTarget(projectId, { ...body, actor })),
    }
  }
  if (
    method === 'GET' &&
    parts.length === 3 &&
    parts[0] === 'repositories' &&
    ['refs', 'history'].includes(parts[2])
  ) {
    authorize('read')
    return {
      status: 200,
      body: await (parts[2] === 'refs'
        ? store.repositoryRefs(projectId, parts[1], principal.id)
        : store.repositoryHistory(
            projectId,
            parts[1],
            {
              refKind: url.searchParams.get('refKind') || 'default',
              ref: url.searchParams.get('ref') || '',
            },
            principal.id,
          )),
    }
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'services') {
    authorize('service.configure')
    return { status: 200, body: await store.saveService(projectId, { ...body, actor }) }
  }
  if (
    parts.length === 4 &&
    parts[0] === 'services' &&
    parts[2] === 'sources' &&
    ['GET', 'PUT'].includes(method)
  ) {
    requireEnvironment(parts[3])
    authorize(method === 'GET' ? 'read' : 'configure', parts[3])
    return {
      status: 200,
      body:
        method === 'GET'
          ? store.serviceSource(projectId, parts[1], parts[3])
          : await store.saveServiceSource(
              projectId,
              { ...body, serviceId: parts[1], environmentId: parts[3] },
              principal,
            ),
    }
  }
  if (method === 'PATCH' && parts.length === 2 && parts[0] === 'targets') {
    const environmentId = store.targetScope(projectId, parts[1]).environmentId
    requireEnvironment(environmentId)
    authorize('configure', environmentId)
    return { status: 200, body: await store.updateTarget(projectId, parts[1], { ...body, actor }) }
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'tasks') {
    const environmentId = store.targetScope(projectId, body.targetId).environmentId
    requireEnvironment(environmentId)
    authorize(body.action === 'deploy' ? 'publish' : body.action, environmentId)
    return { status: 202, body: await store.createTask(projectId, body, principal) }
  }
  if (method === 'GET' && parts.length === 2 && parts[0] === 'tasks') {
    requireEnvironment(store.taskScope(projectId, parts[1]).environmentId)
    return {
      status: 200,
      body: await store.taskDetails(
        projectId,
        parts[1],
        Number(url.searchParams.get('after') || 0),
      ),
    }
  }
  if (method === 'GET' && parts.length === 3 && parts[0] === 'targets' && parts[2] === 'releases') {
    requireEnvironment(store.targetScope(projectId, parts[1]).environmentId)
    return {
      status: 200,
      body: store.releases(
        projectId,
        parts[1],
        url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined,
        url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
      ),
    }
  }
  if (parts[0] === 'targets' && parts[2] === 'releases' && parts.length >= 4) {
    const environmentId = store.targetScope(projectId, parts[1]).environmentId
    requireEnvironment(environmentId)
    if (method === 'GET' && parts.length === 4)
      return { status: 200, body: store.release(projectId, parts[1], parts[3]) }
    if (parts.length === 5 && parts[4] === 'source') {
      if (method === 'GET') {
        authorize('source.download', environmentId)
        const file = await store.releaseSource(projectId, parts[1], parts[3])
        authorize('source.download', environmentId)
        return url.searchParams.get('metadata') === '1'
          ? { status: 200, body: { name: file.name, size: file.bytes.length } }
          : { status: 200, file }
      }
      if (method === 'DELETE') {
        authorize('source.clear', environmentId)
        return {
          status: 200,
          body: await store.clearReleaseSource(projectId, parts[1], parts[3], { ...body, actor }),
        }
      }
    }
  }
  fail(404, 'DEPLOYMENT_ROUTE_NOT_FOUND', '此部署操作不存在')
}
