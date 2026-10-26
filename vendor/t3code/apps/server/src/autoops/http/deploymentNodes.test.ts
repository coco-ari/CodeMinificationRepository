// @effect-diagnostics nodeBuiltinImport:off -- 节点 HTTP 以隔离 SQLite、当前登录和原生路由验证。
import { expect, it, vi } from 'vite-plus/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter } from 'effect/http'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { AuthSessionId } from '@t3tools/contracts'
import * as EnvironmentAuth from '../../auth/EnvironmentAuth.ts'
import { createBusinessHttpContext } from './context.ts'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import { createWorkspaceStore } from '../../../../../../../agent-demo/t3-adapters/workspaces.mjs'
import type { DeploymentStore } from '../../../../../../../agent-demo/t3-adapters/deployments.mjs'
const mock = vi.hoisted(() => ({ store: undefined as DeploymentStore | undefined }))
vi.mock(
  import('../../../../../../../agent-demo/t3-adapters/deployments.mjs'),
  async (original) => ({ ...(await original()), configuredDeploymentStore: () => mock.store }),
)
import { createDeploymentStore } from '../../../../../../../agent-demo/t3-adapters/deployments.mjs'
import { deploymentNodesRoutes } from './deploymentNodes.ts'
import { deploymentsRoutes } from './deployments.ts'

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'node-http-')),
    sessions = new DatabaseSync(':memory:'),
    bindings = new DatabaseSync(':memory:')
  sessions.exec(
    'CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)',
  )
  initializeAutoOpsAccessSchema(bindings)
  const users = [
    { id: 'admin', name: '平台管理员', role: 'admin', kind: 'internal' as const },
    { id: 'manager', name: '项目管理员', role: 'member', kind: 'internal' as const },
  ]
  const project = {
    id: 'project',
    name: '项目',
    memberIds: ['manager'],
    memberships: [
      {
        userId: 'manager',
        role: 'project_admin' as const,
        workspaceAccess: 'internal' as const,
        environmentIds: ['test'],
        status: 'active' as const,
      },
    ],
    environments: [{ id: 'test', name: '测试' }],
    documents: [],
    resources: [],
  }
  const access = createAutoOpsAccess({
    sessionDb: sessions,
    bindingDb: bindings,
    catalog: { users, projects: [project], agents: [] },
    now: () => 1000,
    deploymentEnabled: () => true,
  })
  for (const user of users) {
    sessions
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(createHash('sha256').update(user.id).digest('hex'), user.id, 'csrf', 60000)
    access.recordNativeSession(access.authenticateCookie(`demo_session=${user.id}`), user.id)
  }
  const workspaces = createWorkspaceStore({ dataDir, authorizeTask: () => {} })
  const store = createDeploymentStore({ dataDir, workspaceStore: workspaces, access })
  await store.initialize()
  mock.store = store
  const context = createBusinessHttpContext(access)
  const app = HttpRouter.toWebHandler(
    Layer.mergeAll(deploymentNodesRoutes(context), deploymentsRoutes(context)).pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
            authenticateHttpRequest: (request: { headers: Record<string, string> }) =>
              Effect.succeed({
                sessionId: AuthSessionId.make(request.headers['x-test-session'] ?? 'missing'),
                subject: 'test',
                method: 'bearer-access-token',
                scopes: [],
              }),
          } as unknown as EnvironmentAuth.EnvironmentAuth['Service']),
        ),
      ),
    ),
    { disableLogger: true },
  )
  const request = (path: string, input?: unknown, actor = 'admin', csrf = true, method?: string) =>
    new Request(`http://localhost${path}`, {
      method: method ?? (input === undefined ? 'GET' : 'POST'),
      headers: {
        'x-test-session': actor,
        ...(csrf ? { 'x-demo-csrf': 'csrf' } : {}),
        'content-type': 'application/json',
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    })
  return {
    store,
    request,
    users,
    sessions,
    access,
    handle: app.handler,
    async [Symbol.asyncDispose]() {
      await app.dispose()
      await store.close()
      await workspaces.close()
      sessions.close()
      bindings.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
const base = '/autoops/deployment-servers'
const projectNodes = '/autoops/projects/project/deployments/servers'

it('全局登记不创建项目绑定，准入后项目管理员能绑定但不能登记或改变准入', async () => {
  await using f = await setup()
  const input = { requestId: randomUUID(), name: '全局 HTTP 节点' }
  const registered = await f.handle(f.request(base, input))
  expect(registered.status).toBe(200)
  const created = (await registered.json()) as { server: { id: string }; registrationToken: string }
  expect(typeof created.registrationToken).toBe('string')
  const repeated = (await (await f.handle(f.request(base, input))).json()) as {
    server: { id: string }
    registrationToken: null
  }
  expect(repeated.server.id).toBe(created.server.id)
  expect(repeated.registrationToken).toBeNull()
  const grant = `${base}/${created.server.id}/projects/project`
  expect(
    (
      await f.handle(
        f.request(grant, { requestId: randomUUID(), allowed: true, expectedRevision: 1 }),
      )
    ).status,
  ).toBe(200)
  const globalCatalog = (await (await f.handle(f.request(base))).json()) as {
    bindings: Array<{ projectId: string; environmentId: string; serverId: string }>
    projects: Array<{ id: string; name: string; environments: Array<{ id: string; name: string }> }>
  }
  expect(globalCatalog.projects).toEqual([
    { id: 'project', name: '项目', environments: [{ id: 'test', name: '测试' }] },
  ])
  expect(globalCatalog.bindings).toEqual([])
  const listed = (await (
    await f.handle(f.request(`${projectNodes}?environmentId=test`, undefined, 'manager'))
  ).json()) as {
    availableServers: Array<{ id: string }>
    servers: unknown[]
    canBind: boolean
    canAdmin: boolean
  }
  expect(listed.servers).toEqual([])
  expect(listed.availableServers[0]?.id).toBe(created.server.id)
  expect(listed.canBind).toBe(true)
  expect(listed.canAdmin).toBe(false)
  expect(
    (
      await f.handle(
        f.request(
          `${projectNodes}/${created.server.id}/bind`,
          { requestId: randomUUID(), environmentId: 'test' },
          'manager',
        ),
      )
    ).status,
  ).toBe(200)
  expect(
    ((await (await f.handle(f.request(base))).json()) as typeof globalCatalog).bindings,
  ).toEqual([{ projectId: 'project', environmentId: 'test', serverId: created.server.id }])
  expect(
    (
      await f.handle(
        f.request(
          projectNodes,
          { requestId: randomUUID(), name: '越权登记', environmentId: 'test' },
          'manager',
        ),
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await f.handle(
        f.request(
          grant,
          { requestId: randomUUID(), allowed: false, expectedRevision: 2 },
          'manager',
        ),
      )
    ).status,
  ).toBe(403)
  expect((await f.handle(f.request(base, undefined, 'manager'))).status).toBe(403)
})

it('拒绝授权和 CSRF 均发生在解析正文前，篡改字段及过大正文返回明确错误', async () => {
  await using f = await setup()
  for (const [actor, csrf] of [
    ['manager', true],
    ['admin', false],
  ] as const) {
    const request = new Request(`http://localhost${base}`, {
      method: 'POST',
      headers: { 'x-test-session': actor, ...(csrf ? { 'x-demo-csrf': 'csrf' } : {}) },
      body: '无效 JSON',
    })
    expect((await f.handle(request)).status).toBe(403)
    expect(request.bodyUsed).toBe(false)
  }
  expect(
    (
      await f.handle(
        f.request(base, {
          requestId: randomUUID(),
          name: '伪造项目',
          projectId: 'project',
          actor: { id: 'manager' },
        }),
      )
    ).status,
  ).toBe(400)
  expect(
    (await f.handle(f.request(base, { requestId: randomUUID(), name: 'a'.repeat(5000) }))).status,
  ).toBe(400)
  const forbiddenProjectCreate = new Request(`http://localhost${projectNodes}`, {
    method: 'POST',
    headers: { 'x-test-session': 'manager', 'x-demo-csrf': 'csrf' },
    body: '无效 JSON',
  })
  expect((await f.handle(forbiddenProjectCreate)).status).toBe(403)
  expect(forbiddenProjectCreate.bodyUsed).toBe(false)
})

it('节点已登记后撤回管理权限只确认已保存，恢复权限按原收据核对而不重复登记', async () => {
  await using f = await setup()
  const original = f.store.createGlobalServer
  using _write = vi.spyOn(f.store, 'createGlobalServer').mockImplementation(async (...args) => {
    const value = await original(...args)
    f.users[0]!.role = 'member'
    return value
  })
  const input = { requestId: randomUUID(), name: '撤权前已保存' }
  const response = await f.handle(f.request(base, input))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ saved: true, available: false })
  f.users[0]!.role = 'admin'
  _write.mockRestore()
  const replay = (await (await f.handle(f.request(base, input))).json()) as {
    registrationToken: null
  }
  expect(replay.registrationToken).toBeNull()
  const catalog = (await (await f.handle(f.request(base))).json()) as { servers: unknown[] }
  expect(catalog.servers).toHaveLength(1)
})

it('准入撤回拒绝新绑定而原收据保留，读取注销后不透出全局目录', async () => {
  await using f = await setup()
  const created = (await (
    await f.handle(f.request(base, { requestId: randomUUID(), name: '撤回准入' }))
  ).json()) as { server: { id: string } }
  const grant = `${base}/${created.server.id}/projects/project`
  await f.handle(f.request(grant, { requestId: randomUUID(), allowed: true, expectedRevision: 1 }))
  const input = { requestId: randomUUID(), environmentId: 'test' },
    bind = `${projectNodes}/${created.server.id}/bind`
  expect((await f.handle(f.request(bind, input, 'manager'))).status).toBe(200)
  await f.handle(f.request(grant, { requestId: randomUUID(), allowed: false, expectedRevision: 2 }))
  const withdrawn = (await (
    await f.handle(f.request(`${projectNodes}?environmentId=test`, undefined, 'manager'))
  ).json()) as {
    servers: Array<{ projectAllowed: boolean; metrics?: unknown; capabilities?: unknown }>
  }
  expect(withdrawn.servers[0]?.projectAllowed).toBe(false)
  expect(withdrawn.servers[0]?.metrics).toBeUndefined()
  expect(withdrawn.servers[0]?.capabilities).toBeUndefined()
  expect(
    (await f.handle(f.request(bind, { ...input, requestId: randomUUID() }, 'manager'))).status,
  ).toBe(403)
  const repeated = await f.handle(f.request(bind, input, 'manager'))
  expect(repeated.status).toBe(200)
  expect(await repeated.json()).toEqual({
    server: {
      id: created.server.id,
      name: '撤回准入',
      environmentId: 'test',
      projectAllowed: false,
    },
  })
  f.sessions.prepare('DELETE FROM sessions WHERE uid=?').run('admin')
  expect((await f.handle(f.request(base))).status).toBe(401)
})

it('旧项目全局管理路径不能接受新命令，平台管理者须使用独立全局入口', async () => {
  await using f = await setup()
  const response = await f.handle(
    f.request(projectNodes, {
      name: '不应在项目登记',
      environmentId: 'test',
      requestId: randomUUID(),
    }),
  )
  expect(response.status).toBe(410)
  expect((await response.json()) as { code: string }).toMatchObject({
    code: 'DEPLOYMENT_NODE_ROUTE_RETIRED',
  })
  const catalog = (await (await f.handle(f.request(base))).json()) as { servers: unknown[] }
  expect(catalog.servers).toEqual([])
  const created = (await (
    await f.handle(f.request(base, { name: '仍有效节点', requestId: randomUUID() }))
  ).json()) as { server: { id: string } }
  for (const [path, method, input] of [
    [`${projectNodes}/${created.server.id}/revoke`, 'POST', { requestId: randomUUID() }],
    [`${projectNodes}/${created.server.id}`, 'DELETE', { requestId: randomUUID() }],
    [
      `${projectNodes}/${created.server.id}/storage-policy`,
      'PUT',
      { requestId: randomUUID(), expectedRevision: 1, retainedVersions: 3, buildCacheGiB: 4 },
    ],
  ] as const)
    expect((await f.handle(f.request(path, input, 'admin', true, method))).status).toBe(410)
  const current = (await (await f.handle(f.request(base))).json()) as {
    servers: Array<{ revoked: boolean; storagePolicy: { revision: number } }>
  }
  expect(current.servers[0]?.revoked).toBe(false)
  expect(current.servers[0]?.storagePolicy.revision).toBe(1)
})

it('目录读取期间撤回平台角色时不返回已读到的全局节点和项目准入', async () => {
  await using f = await setup()
  await f.handle(f.request(base, { name: '不可泄露的目录', requestId: randomUUID() }))
  const original = f.store.globalNodeCatalog
  using _read = vi.spyOn(f.store, 'globalNodeCatalog').mockImplementation((...args) => {
    const result = original(...args)
    f.users[0]!.role = 'member'
    return result
  })
  const response = await f.handle(f.request(base))
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain('不可泄露的目录')
})
