// @effect-diagnostics nodeBuiltinImport:off -- 真实登录、SQLite 和路由使用独立临时数据验证。
import { expect, it, vi } from 'vite-plus/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter } from 'effect/http'
import { AuthSessionId } from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as EnvironmentAuth from '../../auth/EnvironmentAuth.ts'
import { createBusinessHttpContext } from './context.ts'
import { createWorkspaceAuthoring } from '../../../../../../../agent-demo/t3-adapters/workspace-authoring/index.ts'
import type { WorkspaceManagement } from '../../../../../../../agent-demo/t3-adapters/workspace-management.ts'
const mock = vi.hoisted(() => ({ service: undefined as WorkspaceManagement | undefined }))
vi.mock(
  import('../../../../../../../agent-demo/t3-adapters/workspace-management.ts'),
  async (original) => ({
    ...(await original()),
    configuredWorkspaceManagement: () => mock.service!,
  }),
)
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import { repositoriesRoutes } from './repositories.ts'
import { repositoryReceiptIntent, type RepositoryRequestReceipt } from '../../../../../../../autoops/contracts/project-management-receipts.ts'

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'assistant-http-')),
    sessions = new DatabaseSync(':memory:'),
    bindings = new DatabaseSync(':memory:')
  sessions.exec(
    'CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)',
  )
  initializeAutoOpsAccessSchema(bindings)
  for (const id of ['admin', 'reader', 'developer'])
    sessions
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(createHash('sha256').update(id).digest('hex'), id, 'test-csrf', 60_000)
  const catalog = {
    users: [
      { id: 'admin', name: '管理员', role: 'admin' },
      { id: 'reader', name: '只读成员', role: 'member' },
      { id: 'developer', name: '开发成员', role: 'member' },
    ],
    projects: [
      {
        id: 'project',
        name: '项目',
        memberIds: ['reader', 'developer'],
        memberships: [
          {
            userId: 'reader',
            role: 'reader' as const,
            workspaceAccess: 'internal' as const,
            environmentIds: [],
            status: 'active' as const,
          },
          {
            userId: 'developer',
            role: 'developer' as const,
            workspaceAccess: 'internal' as const,
            environmentIds: [],
            status: 'active' as const,
          },
        ],
        environments: [],
        documents: [],
        resources: [],
      },
    ],
    agents: [],
  }
  const access = createAutoOpsAccess({
    sessionDb: sessions,
    bindingDb: bindings,
    catalog,
    now: () => 1000,
  })
  for (const id of ['admin', 'reader', 'developer'])
    access.recordNativeSession(access.authenticateCookie(`demo_session=${id}`), id)
  const authoring = createWorkspaceAuthoring({
    dataDir,
    authorize: (actor, project, action) =>
      access.requireProjectActionForActor(
        actor,
        project,
        action === 'repository-read'
          ? 'repository.read'
          : action === 'source-manage'
            ? 'repository.manage'
            : action === 'read'
              ? 'workspace.read'
              : 'workspace.manage',
      ),
  })
  mock.service = {
    authoring,
    repositoryRefs: async (_project: string, id: string, _actor: string) => ({
      sourceId: id,
      truncated: false,
      branches: [{ name: 'main', commit: 'a'.repeat(40) }],
      tags: [],
      defaultRef: 'main',
    }),
  } as unknown as WorkspaceManagement
  const app = HttpRouter.toWebHandler(
    repositoriesRoutes(createBusinessHttpContext(access)).pipe(
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
  const request = (
    suffix = '/repositories',
    body?: unknown,
    user = 'admin',
    csrf = true,
    project = 'project',
  ) =>
    new Request(`http://localhost/api/v1/projects/${project}${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-test-session': user,
        ...(csrf ? { 'x-demo-csrf': 'test-csrf' } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return {
    access,
    authoring,
    sessions,
    catalog,
    request,
    handle: app.handler,
    async [Symbol.asyncDispose]() {
      await app.dispose()
      authoring.close()
      sessions.close()
      bindings.close()
      rmSync(dataDir, { recursive: true, force: true })
      mock.service = undefined
    },
  }
}
const create = {
  requestId: 'create-repository',
  expectedRevision: 0,
  value: { name: '项目仓库', url: 'https://github.com/example/repo.git' },
}

it('仓库 HTTP 连接不选择分支，工作区配置只引用项目仓库，原请求单次保存', async () => {
  await using f = setup()
  const first = await f.handle(f.request('/repositories', create))
  expect(first.status, await first.clone().text()).toBe(200)
  const result = (await first.json()) as { repository: { id: string } }
  expect(await (await f.handle(f.request('/repositories', create))).json()).toEqual(result)
  expect(
    await (await f.handle(f.request('/repositories', undefined, 'reader'))).json(),
  ).toMatchObject({ revision: 1, items: [{ name: '项目仓库' }] })
  const id = result.repository.id
  const refs = await f.handle(f.request(`/repositories/${id}/refs`, undefined, 'reader'))
  expect(refs.status).toBe(200)
  expect(await refs.json()).toMatchObject({ defaultRef: 'main', branches: [{ name: 'main' }] })
  const configured = await f.handle(
    f.request(`/repositories/${id}/workspace`, {
      requestId: 'workspace-selection',
      expectedRevision: 1,
      id,
      role: 'frontend',
      refKind: 'branch',
      ref: 'workbench',
      mountPath: 'src/web',
    }),
  )
  expect(configured.status).toBe(200)
  expect(await configured.json()).toMatchObject({
    source: { id, ref: 'workbench', mountPath: 'src/web', url: create.value.url },
  })
  expect(
    (
      await f.handle(
        f.request(`/repositories/${id}/remove`, {
          requestId: 'remove-in-use',
          expectedRevision: 2,
        }),
      )
    ).status,
  ).toBe(409)
})

it('仓库 HTTP 在读取正文前拒绝未登录、CSRF、非管理员和跨项目，连接合同拒绝业务分支及秘密', async () => {
  await using f = setup()
  expect((await f.handle(f.request('/repositories', undefined, 'missing'))).status).toBe(401)
  for (const request of [
    f.request('/repositories', create, 'reader'),
    f.request('/repositories', create, 'admin', false),
  ]) {
    expect((await f.handle(request)).status).toBe(403)
    expect(request.bodyUsed).toBe(false)
  }
  expect(
    (await f.handle(f.request('/repositories', undefined, 'reader', true, 'another'))).status,
  ).toBe(404)
  for (const patch of [{ ref: 'main' }, { mountPath: 'src' }, { password: 'fixture-secret' }])
    expect(
      (
        await f.handle(
          f.request('/repositories', { ...create, value: { ...create.value, ...patch } }),
        )
      ).status,
    ).toBe(400)
  expect(await (await f.handle(f.request())).json()).toMatchObject({ items: [] })
})

it('保存完成后撤销管理权只确认原收据，不返回已不可见的连接，恢复权限后可核对同一请求', async () => {
  await using f = setup()
  const save = f.authoring.saveRepository.bind(f.authoring)
  const spy = vi.spyOn(f.authoring, 'saveRepository').mockImplementation((...args) => {
    const result = save(...args)
    f.catalog.users[0]!.role = 'member'
    return result
  })
  const response = await f.handle(f.request('/repositories', create))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ saved: true, available: false })
  spy.mockRestore()
  f.catalog.users[0]!.role = 'admin'
  const restored = await f.handle(f.request('/repositories', create))
  expect(restored.status).toBe(200)
  expect(await restored.json()).toMatchObject({ revision: 1, repository: { name: '项目仓库' } })
  expect(await (await f.handle(f.request())).json()).toMatchObject({
    items: [{ name: '项目仓库' }],
  })
})

it('分支读取等待期间注销登录，不返回迟到分支内容', async () => {
  await using f = setup()
  let release!: (value: Awaited<ReturnType<WorkspaceManagement['repositoryRefs']>>) => void
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<Awaited<ReturnType<WorkspaceManagement['repositoryRefs']>>>(
    (resolve) => {
      release = resolve
    },
  )
  vi.spyOn(mock.service!, 'repositoryRefs').mockImplementation(async () => {
    entered()
    return waiting
  })
  const reading = f.handle(f.request('/repositories/connection/refs'))
  await ready
  f.sessions.prepare('DELETE FROM sessions WHERE uid=?').run('admin')
  release({
    truncated: false,
    sourceId: 'connection',
    defaultRef: 'private-branch-marker',
    branches: [],
    tags: [],
  })
  const response = await reading
  expect(response.status).toBe(401)
  expect(await response.text()).not.toContain('private-branch-marker')
})


it('仓库已保存原请求可通过本人只读收据恢复，不重新写入或借目录推断', async () => {
  await using f = setup()
  const response = await f.handle(f.request('/repositories', create))
  expect(response.status).toBe(200)
  const result = await response.json()
  const receipt = await f.handle(
    f.request('/repositories/receipts/' + create.requestId, undefined, 'admin', false),
  )
  expect(receipt.status, await receipt.clone().text()).toBe(200)
  expect(await receipt.json()).toMatchObject({
    state: 'completed',
    saved: true,
    available: true,
    actorId: 'admin',
    projectId: 'project',
    requestId: create.requestId,
    operation: 'save-repository',
    result,
  })
  expect(f.authoring.repositories('project', 'admin').revision).toBe(1)
})

it('仓库收据核对创建、编辑、工作区选择和删除的精确原指纹，读取不再写入', async () => {
  await using f = setup()
  const hash = (
    operation: 'save-repository' | 'remove-repository' | 'configure-source',
    id: string | null,
    input: unknown,
  ) =>
    createHash('sha256')
      .update(repositoryReceiptIntent('admin', operation, id, input))
      .digest('hex')
  const created = (await (await f.handle(f.request('/repositories', create))).json()) as {
    repository: { id: string }
  }
  const id = created.repository.id
  const first = (await (
    await f.handle(f.request('/repositories/receipts/' + create.requestId))
  ).json()) as RepositoryRequestReceipt
  expect(first.publicIntent).toEqual({
    algorithm: 'sha256',
    digest: 'cc9f80c505fbb2dbd1c709d15562ddcb12e5b0c5aaff27535a49b8e4c3ff058f',
  })
  const changed = { ...create, value: { ...create.value, name: '篡改名称' } }
  expect((await f.handle(f.request('/repositories', changed))).status).toBe(409)
  expect(first.publicIntent.digest).not.toBe(hash('save-repository', null, changed))
  const edit = {
    requestId: 'edit-repository',
    expectedRevision: 1,
    value: {
      name: ' 更新名称 ',
      url: 'https://github.com/example/updated.git',
      credentialId: 'credential-reference',
    },
  }
  const edited = await f.handle(f.request('/repositories/' + id, edit))
  expect(edited.status).toBe(200)
  const saved = await edited.json()
  expect(
    await (await f.handle(f.request('/repositories/receipts/' + edit.requestId))).json(),
  ).toMatchObject({ publicIntent: { digest: hash('save-repository', id, edit) }, result: saved })
  const configure = {
    mountPath: 'src/web',
    ref: 'workbench',
    id,
    expectedRevision: 2,
    requestId: 'configure-source',
    refKind: 'branch',
    role: 'frontend',
  }
  const configured = await f.handle(f.request(`/repositories/${id}/workspace`, configure))
  expect(configured.status, await configured.clone().text()).toBe(200)
  expect(
    await (await f.handle(f.request('/repositories/receipts/' + configure.requestId))).json(),
  ).toMatchObject({
    operation: 'configure-source',
    publicIntent: { digest: hash('configure-source', id, configure) },
    result: await configured.json(),
  })
  f.authoring.removeSource(
    'project',
    id,
    { requestId: 'detach-source', expectedRevision: 3 },
    'admin',
  )
  const remove = { requestId: 'remove-repository', expectedRevision: 4 }
  const removed = await f.handle(f.request(`/repositories/${id}/remove`, remove))
  expect(removed.status).toBe(200)
  expect(
    await (await f.handle(f.request('/repositories/receipts/' + remove.requestId))).json(),
  ).toMatchObject({
    operation: 'remove-repository',
    publicIntent: { digest: hash('remove-repository', id, remove) },
    result: await removed.json(),
  })
  expect(f.authoring.repositories('project', 'admin').revision).toBe(5)
  expect(
    await (await f.handle(f.request('/repositories/receipts/detach-source'))).json(),
  ).toBeNull()
})

it('仓库收据隔离操作者和项目，撤权后只返回本人已保存事实，关闭和失去登录不伪造空结果', async () => {
  await using f = setup()
  expect((await f.handle(f.request('/repositories', create))).status).toBe(200)
  const path = '/repositories/receipts/' + create.requestId
  expect(await (await f.handle(f.request(path, undefined, 'reader'))).json()).toBeNull()
  expect(
    await (await f.handle(f.request(path, undefined, 'admin', true, 'other-project'))).json(),
  ).toBeNull()
  expect(await (await f.handle(f.request('/repositories/receipts/missing'))).json()).toBeNull()
  expect((await f.handle(f.request('/repositories/receipts/%21'))).status).toBe(400)
  expect((await f.handle(f.request(path, undefined, 'missing'))).status).toBe(401)
  f.catalog.users[0]!.role = 'member'
  const masked = await (await f.handle(f.request(path))).json()
  expect(masked).toMatchObject({
    saved: true,
    available: false,
    actorId: 'admin',
    requestId: create.requestId,
  })
  expect(masked).not.toHaveProperty('result')
  expect(JSON.stringify(masked)).not.toContain(create.value.url)
  f.catalog.users[0]!.role = 'admin'
  const original = f.authoring.repositoryReceipt.bind(f.authoring)
  const spy = vi.spyOn(f.authoring, 'repositoryReceipt').mockImplementationOnce((...args) => {
    const result = original(...args)
    f.catalog.users[0]!.role = 'member'
    return result
  })
  expect(await (await f.handle(f.request(path))).json()).toMatchObject({ available: false })
  spy.mockRestore()
  f.catalog.users[0]!.role = 'admin'
  vi.spyOn(f.authoring, 'repositoryReceipt').mockImplementationOnce((...args) => {
    const result = original(...args)
    f.sessions.prepare('DELETE FROM sessions WHERE uid=?').run('admin')
    return result
  })
  expect((await f.handle(f.request(path))).status).toBe(401)
  await f.authoring.close()
  expect(() => f.authoring.repositoryReceipt('project', create.requestId, 'admin')).toThrow(
    '工作区资料服务已停止',
  )
})
