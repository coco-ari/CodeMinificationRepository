// @effect-diagnostics nodeBuiltinImport:off -- 原生 HTTP 使用真实授权和独立 SQLite 所有者。
import { expect, it, vi } from 'vite-plus/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter } from 'effect/http'
import * as EnvironmentAuth from '../../auth/EnvironmentAuth.ts'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import {
  createWorkspaceStore,
  type WorkspaceStore,
} from '../../../../../../../agent-demo/t3-adapters/workspaces.mjs'
import { createWorkspaceAuthoring } from '../../../../../../../agent-demo/t3-adapters/workspace-authoring/index.ts'
import { createProjectCredentialService } from '../../../../../../../agent-demo/t3-adapters/credentials.ts'
import {
  createDeploymentStore,
  type DeploymentStore,
} from '../../../../../../../agent-demo/t3-adapters/deployments.mjs'
import {
  createEnvironmentMcp,
  type EnvironmentMcp,
} from '../../../../../../../agent-demo/t3-adapters/environment-mcp/index.ts'
import type { WorkspaceManagement } from '../../../../../../../agent-demo/t3-adapters/workspace-management.ts'

const configured = vi.hoisted(() => ({
  workspace: undefined as WorkspaceStore | undefined,
  service: undefined as WorkspaceManagement | undefined,
  deployments: undefined as DeploymentStore | undefined,
  mcp: undefined as EnvironmentMcp | undefined,
}))
vi.mock(import('../../../../../../../agent-demo/t3-adapters/workspaces.mjs'), async (original) => ({
  ...(await original()),
  configuredWorkspaceStore: () => configured.workspace,
}))
vi.mock(
  import('../../../../../../../agent-demo/t3-adapters/workspace-management.ts'),
  async (original) => ({
    ...(await original()),
    configuredWorkspaceManagement: () => configured.service!,
  }),
)
vi.mock(
  import('../../../../../../../agent-demo/t3-adapters/deployments.mjs'),
  async (original) => ({
    ...(await original()),
    configuredDeploymentStore: () => configured.deployments,
  }),
)
vi.mock(import('../../../../../../../agent-demo/t3-adapters/environment-mcp-runtime.ts'), () => ({
  configuredEnvironmentMcp: () => {
    if (!configured.mcp) throw new Error('隔离环境连接所有者尚未配置')
    return configured.mcp
  },
}))
import { workspaceAuthoringRoutes } from './workspaceAuthoring.ts'

it('原生凭据关系 GET 接入真实所有者，秘密不返回，使用成员与跨项目拒绝，读取故障不伪空', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'credential-usage-http-'))
  const sessions = new DatabaseSync(':memory:'),
    bindings = new DatabaseSync(':memory:')
  sessions.exec(
    'CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)',
  )
  initializeAutoOpsAccessSchema(bindings)
  for (const id of ['admin', 'reader'])
    sessions
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(createHash('sha256').update(id).digest('hex'), id, 'csrf', 60000)
  const project = {
    id: 'project',
    name: '项目',
    memberIds: ['reader'],
    memberships: [
      {
        userId: 'reader',
        role: 'reader' as const,
        workspaceAccess: 'internal' as const,
        environmentIds: [],
        status: 'active' as const,
      },
    ],
    environments: [],
    documents: [],
    resources: [],
  }
  const access = createAutoOpsAccess({
    sessionDb: sessions,
    bindingDb: bindings,
    catalog: {
      users: [
        { id: 'admin', name: '管理员', role: 'admin' },
        { id: 'reader', name: '只读成员', role: 'member' },
      ],
      projects: [project, { ...project, id: 'other', memberIds: [], memberships: [] }],
      agents: [],
    },
    now: () => 1000,
    deploymentEnabled: () => true,
  })
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
  const service = { credentials, authoring } as unknown as WorkspaceManagement
  const workspace = createWorkspaceStore({ dataDir, authorizeTask: () => {} })
  const deployments = createDeploymentStore({
    dataDir,
    workspaceStore: workspace,
    workspaceManagement: service,
    access,
  })
  const mcp = createEnvironmentMcp({
    dataDir,
    credentials,
    authorizeManage: (actor, scope) =>
      access.requireProjectActionForActor(actor, scope, 'project.manage'),
    authorizeQuery: () => {
      throw new Error('读取关系不能查询远端')
    },
    drivers: {},
  })
  await deployments.initialize()
  Object.assign(configured, { workspace, service, deployments, mcp })
  const credential = credentials.create('admin', 'project', {
    requestId: 'create',
    name: '项目凭据',
    username: 'fixture-only-user',
    password: 'fixture-only-secret',
  })
  const other = credentials.create('admin', 'other', {
    requestId: 'create',
    name: '其他项目凭据',
    username: 'other-fixture-user',
    password: 'other-fixture-secret',
  })
  const repository = authoring.saveRepository(
    'project',
    null,
    {
      requestId: 'repository',
      expectedRevision: 0,
      value: {
        name: '关联仓库',
        url: 'https://github.com/example/private.git',
        credentialId: credential.id,
      },
    },
    'admin',
  ).repository
  if (!repository) throw new Error('真实仓库保存未返回关联仓库')
  let actor = 'admin'
  const app = HttpRouter.toWebHandler(
    workspaceAuthoringRoutes({
      access,
      principal: Effect.sync(() => access.authenticateCookie(`demo_session=${actor}`)),
    }).pipe(HttpRouter.provideRequest(Layer.mock(EnvironmentAuth.EnvironmentAuth)({}))),
    { disableLogger: true },
  )
  const request = (id = credential.id) =>
    new Request(`http://localhost/api/v1/projects/project/workspace/credentials/${id}/usage`)
  try {
    const success = await app.handler(request())
    expect(success.status, await success.clone().text()).toBe(200)
    expect(success.headers.get('cache-control')).toBe('private, no-store')
    expect(await success.json()).toEqual({
      projectId: 'project',
      credentialId: credential.id,
      repositories: [{ id: repository.id, name: '关联仓库' }],
      workspaces: [],
      services: [],
      connections: [],
    })
    actor = 'reader'
    expect(credentials.list(actor, 'project')).toHaveLength(1)
    expect((await app.handler(request())).status).toBe(403)
    actor = 'admin'
    expect((await app.handler(request(other.id))).status).toBe(404)
    await authoring.close()
    const unavailable = await app.handler(request())
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({ code: 'CREDENTIAL_USAGE_UNAVAILABLE' })
  } finally {
    await app.dispose()
    await mcp.close()
    await deployments.close()
    await workspace.close()
    await authoring.close()
    credentials.close()
    Object.assign(configured, {
      workspace: undefined,
      service: undefined,
      deployments: undefined,
      mcp: undefined,
    })
    sessions.close()
    bindings.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
