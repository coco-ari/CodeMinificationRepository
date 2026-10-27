import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { once } from 'node:events'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../agent-demo/t3-adapters/access.mjs'
import { createWorkspaceAuthoring } from '../agent-demo/t3-adapters/workspace-authoring/index.ts'
import { createProjectCredentialService } from '../agent-demo/t3-adapters/credentials.ts'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'
import { createDeploymentStore } from '../agent-demo/t3-adapters/deployments.mjs'
import { createEnvironmentMcp } from '../agent-demo/t3-adapters/environment-mcp/index.ts'
import { readCredentialUsage } from '../agent-demo/t3-adapters/credential-usage.ts'
import { CredentialUsage } from '../autoops/contracts/credential-usage.ts'
import { decodeContract } from '../autoops/contracts/index.ts'
import { handleWorkspaceAuthoringRequest } from '../agent-demo/t3-adapters/workspace-authoring-http.ts'

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'credential-usage-'))
  const sessions = new DatabaseSync(':memory:'),
    bindings = new DatabaseSync(':memory:')
  sessions.exec(
    'CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)',
  )
  initializeAutoOpsAccessSchema(bindings)
  for (const id of ['admin', 'manager', 'reader'])
    sessions
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(createHash('sha256').update(id).digest('hex'), id, 'csrf', Date.now() + 60000)
  const project = {
    id: 'project',
    name: '项目',
    environments: [
      { id: 'test', name: '测试' },
      { id: 'production', name: '生产' },
    ],
    memberIds: ['manager', 'reader'],
    memberships: ['manager', 'reader'].map((userId) => ({
      userId,
      role: userId === 'manager' ? 'project_admin' : 'reader',
      workspaceAccess: 'internal',
      environmentIds: ['test'],
      status: 'active',
    })),
    documents: [],
    resources: [],
  }
  const other = { ...project, id: 'other', name: '其他项目', memberIds: [], memberships: [] }
  const access = createAutoOpsAccess({
    sessionDb: sessions,
    bindingDb: bindings,
    catalog: {
      users: [
        { id: 'admin', name: '管理员', role: 'admin' },
        { id: 'manager', name: '项目管理员', role: 'member' },
        { id: 'reader', name: '只读成员', role: 'member' },
      ],
      projects: [project, other],
      agents: [],
    },
    deploymentEnabled: () => true,
  })
  const principals = Object.fromEntries(
    ['admin', 'manager', 'reader'].map((id) => [
      id,
      access.authenticateCookie(`demo_session=${id}`),
    ]),
  )
  const credentials = createProjectCredentialService({
    databasePath: join(dataDir, 'credentials.sqlite'),
    keyPath: join(dataDir, 'master.key'),
    initializeKeyIfNew: true,
    authorize: (actor, scope, action) => {
      access.requireCredentialActor(actor, scope, action)
    },
  })
  const authoring = createWorkspaceAuthoring({
    dataDir,
    authorize: (actor, scope, action) =>
      access.requireProjectActionForActor(
        actor,
        scope,
        action === 'repository-read'
          ? 'repository.read'
          : action === 'source-manage'
            ? 'repository.manage'
            : action === 'read'
              ? 'workspace.read'
              : 'workspace.manage',
      ),
  })
  const store = createWorkspaceStore({ dataDir, authorizeTask: () => {} })
  const service = { authoring, credentials }
  const deployments = createDeploymentStore({
    dataDir,
    workspaceStore: store,
    workspaceManagement: service,
    access,
  })
  await deployments.initialize()
  await deployments.ensureProject(project)
  const credential = credentials.create('admin', 'project', {
    requestId: 'create',
    name: '私有 Git',
    username: 'fixture-user',
    password: 'fixture-secret-only',
  })
  const foreign = credentials.create('admin', 'other', {
    requestId: 'create-other',
    name: '其他项目凭据',
    username: 'other-user',
    password: 'other-secret',
  })
  const repository = authoring.saveRepository(
    'project',
    null,
    {
      requestId: 'repository',
      expectedRevision: 0,
      value: {
        name: '前端仓库',
        url: 'https://github.com/example/private.git',
        credentialId: credential.id,
      },
    },
    'admin',
  ).repository
  authoring.configureSource(
    'project',
    {
      requestId: 'workspace',
      expectedRevision: 1,
      id: repository.id,
      role: 'frontend',
      refKind: 'branch',
      ref: 'develop',
      mountPath: 'sources/web',
    },
    'admin',
  )
  const deploymentService = (
    await deployments.saveService('project', {
      requestId: randomUUID(),
      name: '前端服务',
      kind: 'static',
      module: '.',
      actor: { id: 'admin', displayName: '管理员' },
    })
  ).service
  for (const environmentId of ['test', 'production'])
    await deployments.saveServiceSource(
      'project',
      {
        requestId: randomUUID(),
        serviceId: deploymentService.id,
        environmentId,
        sources: [{ sourceId: repository.id, refKind: 'branch', ref: 'release', mountPath: 'app' }],
        contexts: [{ service: 'frontend', root: 'app', workingDirectory: '.' }],
      },
      principals.admin,
    )
  const environmentMcp = createEnvironmentMcp({
    dataDir,
    credentials,
    authorizeManage: (actor, scope, environment) => {
      const member = access.requireProjectActionForActor(actor, scope, 'project.manage')
      if (!member.environmentIds.includes(environment))
        throw Object.assign(new Error('环境无权访问'), { status: 403 })
    },
    authorizeQuery: () => {
      throw new Error('关系读取不能调用查询工具')
    },
    drivers: {},
  })
  const connection = environmentMcp.save(
    'project',
    'test',
    {
      requestId: 'mcp-reference',
      expectedRevision: 0,
      value: {
        type: 'redis',
        name: '测试缓存',
        host: 'redis.example.invalid',
        port: 6379,
        credentialId: credential.id,
        database: 0,
        tls: 'disabled',
        keyPatterns: ['public:*'],
      },
    },
    'admin',
  )
  const request = (
    id = credential.id,
    user = 'admin',
    scope = 'project',
    dependency = deployments,
  ) =>
    handleWorkspaceAuthoringRequest({
      access,
      principal: principals[user],
      url: new URL(`http://localhost/api/v1/projects/${scope}/workspace/credentials/${id}/usage`),
      method: 'GET',
      store,
      service,
      deployments: dependency,
      environmentMcp,
    })
  t.after(async () => {
    await environmentMcp.close()
    await deployments.close()
    await store.close()
    await authoring.close()
    credentials.close()
    sessions.close()
    bindings.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return {
    access,
    project,
    credentials,
    authoring,
    deployments,
    credential,
    foreign,
    repository,
    deploymentService,
    request,
    service,
    store,
    principals,
    environmentMcp,
    connection,
  }
}

test('凭据使用关系组合真实所属模块，只返回当前仓库、工作区及服务引用，不返回秘密和分支', async (t) => {
  const f = await fixture(t)
  const response = await f.request()
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    projectId: 'project',
    credentialId: f.credential.id,
    repositories: [{ id: f.repository.id, name: '前端仓库' }],
    workspaces: [{ repositoryId: f.repository.id, mountPath: 'sources/web' }],
    services: ['test', 'production'].map((environmentId) => ({
      serviceId: f.deploymentService.id,
      serviceName: '前端服务',
      environmentId,
      environmentName: environmentId === 'test' ? '测试' : '生产',
      repositoryIds: [f.repository.id],
    })),
    connections: [
      {
        connectionId: f.connection.id,
        name: '测试缓存',
        type: 'redis',
        environmentId: 'test',
        environmentName: '测试',
        enabled: false,
      },
    ],
  })
  for (const value of ['fixture-user', 'fixture-secret', 'https://', 'develop', 'release'])
    assert.equal(JSON.stringify(response.body).includes(value), false)
  f.credentials.revoke('admin', 'project', f.credential.id, {
    requestId: 'revoke',
    expectedRevision: 1,
  })
  assert.deepEqual((await f.request()).body, response.body)
  f.authoring.removeSource(
    'project',
    f.repository.id,
    { requestId: 'remove-workspace', expectedRevision: 2 },
    'admin',
  )
  assert.deepEqual((await f.request()).body.workspaces, [])
  assert.equal((await f.request()).body.services.length, 2)
})

test('使用权不包含关系管理读取，跨项目凭据不泄露且等待期间撤权拒绝', async (t) => {
  const f = await fixture(t)
  assert.equal(f.credentials.list('reader', 'project').length, 1)
  await assert.rejects(f.request(undefined, 'reader'), { status: 403 })
  await assert.rejects(f.request(f.foreign.id), { status: 404, code: 'CREDENTIAL_NOT_FOUND' })
  await assert.rejects(f.request(undefined, 'manager', 'other'), { status: 404 })
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  const dependency = {
    overview: f.deployments.overview,
    ensureProject: async (project) => {
      await f.deployments.ensureProject(project)
      entered.resolve()
      await release.promise
    },
  }
  const pending = f.request(undefined, 'manager', 'project', dependency)
  await entered.promise
  f.project.memberships[0].role = 'reader'
  release.resolve()
  await assert.rejects(pending, { status: 403 })
})

test('所有者不可用明确失败并可原查询恢复，不把缺失来源或超量关系显示为空', async (t) => {
  const f = await fixture(t)
  const unavailable = {
    ensureProject: async () => {
      throw new Error('fixture-database-unavailable')
    },
    overview: () => assert.fail('不可越过失败读取'),
  }
  await assert.rejects(f.request(undefined, 'admin', 'project', unavailable), {
    status: 503,
    code: 'CREDENTIAL_USAGE_UNAVAILABLE',
  })
  assert.equal((await f.request()).body.services.length, 2)
  const unavailableOwner = {
    ensureProject: async () => {},
    overview: () => ({
      services: [],
      serviceSources: [
        { serviceId: 'missing', environmentId: 'test', sources: [{ sourceId: f.repository.id }] },
      ],
    }),
  }
  await assert.rejects(f.request(undefined, 'admin', 'project', unavailableOwner), {
    status: 503,
    code: 'CREDENTIAL_USAGE_UNAVAILABLE',
  })
  await assert.rejects(
    readCredentialUsage({
      access: f.access,
      principal: f.principals.admin,
      projectId: 'project',
      credentialId: f.credential.id,
      workspace: f.service,
      deployments: f.deployments,
      environmentMcp: undefined,
    }),
    { status: 503, code: 'CREDENTIAL_USAGE_UNAVAILABLE' },
  )
  const oversized = {
    ensureProject: async () => {},
    overview: (...args) => {
      const value = f.deployments.overview(...args)
      return {
        ...value,
        serviceSources: Array.from({ length: 1001 }, () => value.serviceSources[0]),
      }
    },
  }
  await assert.rejects(f.request(undefined, 'admin', 'project', oversized), {
    status: 503,
    code: 'CREDENTIAL_USAGE_UNAVAILABLE',
  })
  const result = (await f.request()).body
  assert.throws(() => decodeContract(CredentialUsage, { ...result, secret: 'forbidden' }))
  assert.throws(() =>
    decodeContract(CredentialUsage, {
      ...result,
      connections: [{ ...result.connections[0], host: 'private.invalid' }],
    }),
  )
})

test('实际 HTTP GET 成功、越权及跨项目使用同一聚合合同且禁止缓存', async (t) => {
  const f = await fixture(t)
  const server = createServer(async (req, res) => {
    try {
      const response = await handleWorkspaceAuthoringRequest({
        access: f.access,
        principal: f.principals[req.headers['x-fixture-user'] ?? 'admin'],
        url: new URL(req.url, 'http://localhost'),
        method: req.method,
        store: f.store,
        service: f.service,
        deployments: f.deployments,
        environmentMcp: f.environmentMcp,
      })
      res.writeHead(response.status, {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      })
      res.end(JSON.stringify(response.body))
    } catch (error) {
      res.writeHead(error.status ?? 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: error.code ?? 'INTERNAL_ERROR' }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const url = (id) =>
    `http://127.0.0.1:${server.address().port}/api/v1/projects/project/workspace/credentials/${id}/usage`
  const result = await fetch(url(f.credential.id))
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('cache-control'), 'private, no-store')
  assert.equal((await result.json()).services.length, 2)
  assert.equal(
    (await fetch(url(f.credential.id), { headers: { 'x-fixture-user': 'reader' } })).status,
    403,
  )
  assert.equal((await fetch(url(f.foreign.id))).status, 404)
})

// 使用真实授权服务先裁决，再在窄公开端口模拟范围读取后的撤回。
test('引用投影逐环境过滤并在等待期间缩小时拒绝旧范围', async (t) => {
  const f = await fixture(t)
  let allowed = ['test']
  const access = {
    ...f.access,
    requireDeploymentAction(principal, project, action, environment) {
      const member = f.access.requireDeploymentAction(principal, project, action, environment)
      if (environment && !allowed.includes(environment))
        throw Object.assign(new Error('环境已撤回'), { status: 403 })
      return { ...member, environmentIds: allowed }
    },
  }
  const options = {
    access,
    principal: f.principals.admin,
    projectId: 'project',
    credentialId: f.credential.id,
    workspace: f.service,
    deployments: f.deployments,
    environmentMcp: f.environmentMcp,
  }
  const result = await readCredentialUsage(options)
  assert.deepEqual(
    result.services.map((value) => value.environmentId),
    ['test'],
  )
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  const deployments = {
    overview: f.deployments.overview,
    ensureProject: async () => {
      entered.resolve()
      await release.promise
    },
  }
  const pending = readCredentialUsage({ ...options, deployments })
  await entered.promise
  allowed = []
  release.resolve()
  await assert.rejects(pending, { status: 403, code: 'CREDENTIAL_USAGE_SCOPE_CHANGED' })
})
