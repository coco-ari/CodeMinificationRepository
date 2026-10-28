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
import * as ThreadManagement from '../../orchestration-v2/ThreadManagementService.ts'
import { ThreadId, ProjectId, AuthSessionId } from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as EnvironmentAuth from '../../auth/EnvironmentAuth.ts'
import { createBusinessHttpContext } from './context.ts'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import { skillsRoutes } from './skills.ts'
import { conversationsRoutes } from './conversations.ts'

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'assistant-http-')),
    sessions = new DatabaseSync(':memory:'),
    bindings = new DatabaseSync(':memory:')
  sessions.exec(
    'CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)',
  )
  initializeAutoOpsAccessSchema(bindings)
  for (const id of ['admin', 'reader'])
    sessions
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(createHash('sha256').update(id).digest('hex'), id, 'test-csrf', 60_000)
  const catalog = {
    users: [
      { id: 'admin', name: '管理员', role: 'admin' },
      { id: 'reader', name: '只读成员', role: 'member' },
    ],
    projects: [
      {
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
      },
    ],
    agents: [
      {
        id: 'a-project',
        name: '项目助手',
        description: '',
        capabilities: [],
        projectIds: ['project'],
      },
    ],
  }
  const access = createAutoOpsAccess({
    sessionDb: sessions,
    bindingDb: bindings,
    catalog,
    now: () => 1000,
  })
  for (const id of ['admin', 'reader'])
    access.recordNativeSession(access.authenticateCookie(`demo_session=${id}`), id)
  vi.stubEnv('AUTOOPS_T3_DATA_DIR', dataDir)
  const context = createBusinessHttpContext(access)
  const app = HttpRouter.toWebHandler(
    Layer.mergeAll(conversationsRoutes(context), skillsRoutes(context)).pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ThreadManagement.ThreadManagementService, {
            getThreadSnapshot: (threadId: ThreadId) =>
              Effect.fail(
                new ThreadManagement.ThreadManagementThreadNotFoundError({
                  projectId: ProjectId.make('project'),
                  threadId,
                }),
              ),
          } as unknown as ThreadManagement.ThreadManagementService['Service']),
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
    suffix = '/autoops/thread-bindings',
    body?: unknown,
    user = 'admin',
    csrf = true,
  ) =>
    new Request(`http://localhost${suffix}`, {
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
    request,
    handle: app.handler,
    async [Symbol.asyncDispose]() {
      await app.dispose()
      vi.unstubAllEnvs()
      sessions.close()
      bindings.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
const binding = {
  threadId: 'binding-thread',
  projectId: 'project',
  environmentId: null,
  agentId: 'a-project',
  workspaceType: 'internal',
  visibility: 'private',
}
it('会话绑定真实 HTTP 解析共享合同，合法范围保持身份，篡改与无效字段返回 400', async () => {
  await using f = setup()
  const response = await f.handle(f.request('/autoops/thread-bindings', binding))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ binding: { ...binding, ownerId: 'admin' } })
  for (const patch of [
    { ownerId: 'reader' },
    { extra: 'unknown' },
    { threadId: 'x'.repeat(513) },
    { question: { assistantId: 'fake', presetRevision: 1, configuration: {} } },
  ])
    expect(
      (await f.handle(f.request('/autoops/thread-bindings', { ...binding, ...patch }))).status,
    ).toBe(400)
  const request = f.request('/autoops/thread-bindings', binding, 'admin', false)
  expect((await f.handle(request)).status).toBe(403)
  expect(request.bodyUsed).toBe(false)
})

it('技能查询真实 HTTP 按共同合同解析所选列表，空列表不回退，非法值明确拒绝', async () => {
  await using f = setup()
  const query = (ids: string) =>
    '/autoops/skill-library/context?' +
    new URLSearchParams({
      projectId: 'project',
      agentId: 'a-project',
      workspaceType: 'internal',
      skillIds: ids,
    })
  const response = await f.handle(f.request(query('[]')))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ skills: [] })
  for (const invalid of ['not-json', '["bad/path"]', 'null', '["x",1]'])
    expect((await f.handle(f.request(query(invalid)))).status).toBe(400)
})

it('已发送会话可往返调整可见范围，真实 HTTP 校验身份、权限、CSRF 与独立字段', async () => {
  await using f = setup()
  await f.handle(f.request('/autoops/thread-bindings', binding))
  f.access.markThreadAccepted(binding.threadId)
  const path = `/autoops/thread-bindings/${binding.threadId}/visibility`
  const shared = { expectedVisibility: 'private', visibility: 'project' }
  const response = await f.handle(f.request(path, shared))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ binding: { ...binding, visibility: 'project', scopeState: 'locked' } })
  expect((await f.handle(f.request(`/autoops/thread-bindings/${binding.threadId}`, undefined, 'reader'))).status).toBe(200)
  expect((await f.handle(f.request(path, { expectedVisibility: 'project', visibility: 'private' }, 'reader'))).status).toBe(403)
  for (const invalid of [{ ...shared, projectId: 'other' }, { ...shared, ownerId: 'reader' }, { visibility: 'public' }])
    expect((await f.handle(f.request(path, invalid))).status).toBe(400)
  expect((await f.handle(f.request(path, shared, 'admin', false))).status).toBe(403)
  const restored = await f.handle(f.request(path, { expectedVisibility: 'project', visibility: 'private' }))
  expect(restored.status).toBe(200)
  expect((await f.handle(f.request(`/autoops/thread-bindings/${binding.threadId}`, undefined, 'reader'))).status).toBe(404)
  expect(f.access.getThreadBinding(binding.threadId)?.scopeState).toBe('locked')
})
