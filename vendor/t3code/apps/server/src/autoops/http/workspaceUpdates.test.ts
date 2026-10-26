// @effect-diagnostics nodeBuiltinImport:off -- 原生会话、权限、SQLite 及字节流均使用独立隔离实例。
import { expect, it, vi } from 'vite-plus/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter } from 'effect/http'
import { AuthSessionId } from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as EnvironmentAuth from '../../auth/EnvironmentAuth.ts'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import { createWorkspaceUpdates } from '../../../../../../../agent-demo/t3-adapters/workspace-updates/index.ts'
import { createBusinessHttpContext } from './context.ts'
import { workspaceUpdatesRoutes } from './workspaceUpdates.ts'

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'autoops-updates-http-'))
  const sessions = new DatabaseSync(':memory:'),
    bindings = new DatabaseSync(':memory:')
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  const memberships = [
    {
      userId: 'manager',
      role: 'project_admin' as const,
      workspaceAccess: 'internal' as const,
      environmentIds: [],
      status: 'active' as 'active' | 'disabled',
    },
    {
      userId: 'second',
      role: 'project_admin' as const,
      workspaceAccess: 'internal' as const,
      environmentIds: [],
      status: 'active' as 'active' | 'disabled',
    },
    {
      userId: 'reader',
      role: 'reader' as const,
      workspaceAccess: 'internal' as const,
      environmentIds: [],
      status: 'active' as 'active' | 'disabled',
    },
  ]
  for (const id of ['manager', 'second', 'reader', 'outsider'])
    sessions
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(createHash('sha256').update(id).digest('hex'), id, 'fixture-csrf', 60_000)
  const access = createAutoOpsAccess({
    sessionDb: sessions,
    bindingDb: bindings,
    now: () => 1000,
    catalog: {
      users: ['manager', 'second', 'reader', 'outsider'].map((id) => ({
        id,
        name: id,
        role: 'member',
      })),
      projects: [
        {
          id: 'project',
          name: '隔离更新项目',
          memberIds: memberships.map((value) => value.userId),
          memberships,
          environments: [],
          documents: [],
          resources: [],
        },
      ],
      agents: [],
    },
  })
  for (const id of ['manager', 'second', 'reader', 'outsider'])
    access.recordNativeSession(access.authenticateCookie(`demo_session=${id}`), id)
  const owner = createWorkspaceUpdates({
    dataDir,
    ports: {
      authorize(actor, project, scope, action) {
        if (action === 'read') access.requireWorkspaceReader(actor, project)
        else {
          access.requireWorkspaceActor(actor, project)
          if (scope === 'external')
            access.requireProjectActionForActor(actor, project, 'workspace.external.publish')
        }
      },
      sources: () => ({
        revision: 1,
        sourceIds: ['repository'],
        fingerprint: 'source-fingerprint',
        names: { repository: '项目仓库' },
      }),
      busy: () => false,
      start: () => Promise.reject(new Error('保存设置不应启动真实更新')),
      receipt: () => ({}),
    },
  })
  const app = HttpRouter.toWebHandler(
    workspaceUpdatesRoutes(createBusinessHttpContext(access), owner).pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
            authenticateHttpRequest: (request: { headers: Record<string, string> }) =>
              Effect.succeed({
                sessionId: AuthSessionId.make(request.headers['x-test-session'] ?? 'missing'),
                subject: 'fixture',
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
    suffix = '',
    body?: unknown,
    actor = 'manager',
    csrf = true,
    project = 'project',
  ) =>
    new Request(`http://localhost/api/v1/projects/${project}/workspace/updates${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-test-session': actor,
        ...(csrf ? { 'x-demo-csrf': 'fixture-csrf' } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return {
    owner,
    access,
    memberships,
    request,
    handle: app.handler,
    async [Symbol.asyncDispose]() {
      await app.dispose()
      await owner.close()
      sessions.close()
      bindings.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
const input = {
  requestId: 'save-internal',
  expectedRevision: 0,
  value: {
    enabled: false,
    intervalMinutes: 60,
    timezone: 'Asia/Shanghai',
    sourceIds: ['repository'],
  },
}

it('定期更新 HTTP 默认关闭，内部外部独立保存并按原请求只保存一次', async () => {
  await using f = setup()
  expect(await (await f.handle(f.request())).json()).toEqual({
    internal: null,
    external: null,
    sources: [{ id: 'repository', name: '项目仓库' }],
  })
  const saved = await f.handle(f.request('/internal', input))
  expect(saved.status, await saved.clone().text()).toBe(200)
  expect(await saved.json()).toMatchObject({
    projectId: 'project',
    scope: 'internal',
    actorId: 'manager',
    revision: 1,
    enabled: false,
    nextRunAt: null,
  })
  expect(await (await f.handle(f.request('/internal', input))).json()).toMatchObject({
    revision: 1,
  })
  const external = await f.handle(
    f.request('/external', {
      ...input,
      requestId: 'save-external',
      value: { ...input.value, enabled: true },
    }),
  )
  expect(external.status).toBe(200)
  expect(await external.json()).toMatchObject({ scope: 'external', enabled: true, revision: 1 })
})

it('只读成员可读当前更新状态，但不能配置；跨项目和伪造范围均拒绝', async () => {
  await using f = setup()
  expect((await f.handle(f.request('', undefined, 'reader'))).status).toBe(200)
  expect((await f.handle(f.request('/internal', input, 'reader'))).status).toBe(403)
  expect((await f.handle(f.request('/internal', input, 'outsider'))).status).toBe(404)
  expect(
    (await f.handle(f.request('/internal', input, 'manager', true, 'other-project'))).status,
  ).toBe(404)
  expect((await f.handle(f.request('/production', input))).status).toBe(400)
})

it('保存前校验会话和 CSRF，不能用客户端自报 actor 或其他来源扩大范围', async () => {
  await using f = setup()
  expect((await f.handle(f.request('/internal', input, 'missing'))).status).toBe(401)
  expect((await f.handle(f.request('/internal', input, 'manager', false))).status).toBe(403)
  expect((await f.handle(f.request('/internal', { ...input, actorId: 'manager' }))).status).toBe(
    400,
  )
  expect(
    (
      await f.handle(
        f.request('/internal', {
          ...input,
          value: { ...input.value, sourceIds: ['foreign-source'] },
        }),
      )
    ).status,
  ).toBe(409)
  expect(f.owner.overview('project', 'manager').internal).toBeNull()
})

it('真正字节流超过16KiB即拒绝，合法 JSON 后空白不能绕过预算', async () => {
  await using f = setup()
  const request = f.request('/internal', input)
  const oversized = new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(input) + ' '.repeat(17_000),
  })
  const result = await f.handle(oversized)
  expect(result.status).toBe(400)
  expect(await result.json()).toMatchObject({ code: 'WORKSPACE_UPDATE_INPUT_INVALID' })
  expect(f.owner.overview('project', 'manager').internal).toBeNull()
})

it('读取正文期间撤回维护者，异步后重查阻止保存', async () => {
  await using f = setup()
  let checked!: () => void
  const authorized = new Promise<void>((resolve) => {
    checked = resolve
  })
  const original = f.access.requireWorkspaceReader.bind(f.access)
  using _reader = vi.spyOn(f.access, 'requireWorkspaceReader').mockImplementation((...args) => {
    const result = original(...args)
    checked()
    return result
  })
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller
    },
  })
  const base = f.request('/internal', input)
  const request = new Request(base.url, {
    method: 'POST',
    headers: base.headers,
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  const result = f.handle(request)
  await authorized
  f.memberships[0]!.status = 'disabled'
  stream.enqueue(new TextEncoder().encode(JSON.stringify(input)))
  stream.close()
  expect((await result).status).toBe(404)
  f.memberships[0]!.status = 'active'
  expect(f.owner.overview('project', 'manager').internal).toBeNull()
})

it('已保存后读取权限失效仅返回最小确认，原设置收据仍保留可恢复', async () => {
  await using f = setup()
  const original = f.owner.save.bind(f.owner)
  using _save = vi.spyOn(f.owner, 'save').mockImplementation((...args) => {
    const value = original(...args)
    f.memberships[0]!.status = 'disabled'
    return value
  })
  const result = await f.handle(f.request('/internal', input))
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ saved: true, available: false })
  f.memberships[0]!.status = 'active'
  expect(await (await f.handle(f.request('/requests/save-internal'))).json()).toMatchObject({
    kind: 'settings',
    result: { revision: 1 },
  })
})

it('原设置收据只属于实际操作者，其他管理者和不存在收据不能冒认成功', async () => {
  await using f = setup()
  await f.handle(f.request('/internal', input))
  expect((await f.handle(f.request('/requests/save-internal', undefined, 'second'))).status).toBe(
    404,
  )
  const missing = await f.handle(f.request('/requests/missing'))
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ code: 'WORKSPACE_UPDATE_RECEIPT_NOT_FOUND' })
})
