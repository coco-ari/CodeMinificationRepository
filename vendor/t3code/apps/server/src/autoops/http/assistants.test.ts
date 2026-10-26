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
import { createAssistantDirectory, type AssistantDirectoryService } from '../../../../../../../agent-demo/t3-adapters/assistants/index.ts'
const mock = vi.hoisted(() => ({ directory: undefined as AssistantDirectoryService | undefined }))
vi.mock(import('../../../../../../../agent-demo/t3-adapters/access.mjs'), async original => ({ ...await original(), configuredAutoOpsAssistantDirectory: () => mock.directory! }))
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import { assistantsRoutes } from './assistants.ts'

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'assistant-http-')), sessions = new DatabaseSync(':memory:'), bindings = new DatabaseSync(':memory:')
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  for (const id of ['admin', 'reader']) sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(id).digest('hex'), id, 'test-csrf', 60_000)
  const catalog = { users: [{ id: 'admin', name: '管理员', role: 'admin' }, { id: 'reader', name: '只读成员', role: 'member' }], projects: [{ id: 'project', name: '项目', memberIds: ['reader'], memberships: [{ userId: 'reader', role: 'reader' as const, workspaceAccess: 'internal' as const, environmentIds: [], status: 'active' as const }], environments: [], documents: [], resources: [] }], agents: [] }
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, catalog, now: () => 1000 })
  for (const id of ['admin', 'reader']) access.recordNativeSession(access.authenticateCookie(`demo_session=${id}`), id)
  const directory = createAssistantDirectory({ dataDir, membership: (actor, project) => access.requireProjectActionForActor(actor, project, 'chat.use'), manage: (actor, project) => access.requireProjectActionForActor(actor, project, 'project.manage'), validate: () => {}, validateTarget: () => {} })
  mock.directory = directory
  const app = HttpRouter.toWebHandler(assistantsRoutes(createBusinessHttpContext(access)).pipe(HttpRouter.provideRequest(Layer.mergeAll(NodeServices.layer, Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
    authenticateHttpRequest: (request: { headers: Record<string, string> }) => Effect.succeed({ sessionId: AuthSessionId.make(request.headers['x-test-session'] ?? 'missing'), subject: 'test', method: 'bearer-access-token', scopes: [] }),
  } as unknown as EnvironmentAuth.EnvironmentAuth['Service'])))), { disableLogger: true })
  const request = (suffix = '/assistants', body?: unknown, user = 'admin', csrf = true, project = 'project') => new Request(`http://localhost/api/v1/projects/${project}${suffix}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-test-session': user, ...(csrf ? { 'x-demo-csrf': 'test-csrf' } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { access, request, handle: app.handler, async [Symbol.asyncDispose]() { await app.dispose(); directory.close(); sessions.close(); bindings.close(); rmSync(dataDir, { recursive: true, force: true }); mock.directory = undefined } }
}
const value = { name: '资料助手', description: '', instructions: '', enabled: true, configuration: { agentId: 'a-project', executionBinding: { kind: 'platform' }, workspaceType: 'internal', environmentId: null, visibility: 'private', model: { instanceId: 'codex', model: 'actual-model', reasoningEffort: null }, skillIds: [] } }
const create = { requestId: 'create-assistant', expectedRevision: 0, value }

it('助手真实 HTTP 原请求返回同一预设，成员分配后只看自己的候选与默认值', async () => {
  await using f = setup()
  const first = await f.handle(f.request('/assistants', create)), preset = await first.json() as { id: string }
  expect(first.status).toBe(200)
  expect(await (await f.handle(f.request('/assistants', create))).json()).toEqual(preset)
  expect(await (await f.handle(f.request('/assistants', undefined, 'reader'))).json()).toMatchObject({ items: [], ready: false })
  const assign = { requestId: 'assign-reader', expectedRevision: 0, target: { kind: 'member', id: 'reader' }, assistantIds: [preset.id], defaultAssistantId: preset.id }
  expect((await f.handle(f.request('/assistant-allocations', assign))).status).toBe(200)
  expect(await (await f.handle(f.request('/assistants', undefined, 'reader'))).json()).toMatchObject({ items: [{ preset: { id: preset.id } }], ready: true, defaultAssistantId: preset.id, canAdjust: false })
  expect((await f.handle(f.request('/assistants/' + preset.id, { ...create, requestId: 'disable', expectedRevision: 1, value: { ...value, enabled: false } }))).status).toBe(200)
  expect(await (await f.handle(f.request('/assistants', undefined, 'reader'))).json()).toMatchObject({ ready: false })
})

it('身份、CSRF、管理和跨项目边界在消费正文前拒绝，不返回别人的预设', async () => {
  await using f = setup()
  expect((await f.handle(f.request('/assistants', undefined, 'missing'))).status).toBe(401)
  for (const request of [f.request('/assistants', create, 'admin', false), f.request('/assistants', create, 'reader'), f.request('/assistant-allocations', create, 'reader')]) {
    expect((await f.handle(request)).status).toBe(403)
    expect(request.bodyUsed).toBe(false)
  }
  expect((await f.handle(f.request('/assistants/settings', undefined, 'reader'))).status).toBe(403)
  expect((await f.handle(f.request('/assistants', undefined, 'reader', true, 'another'))).status).toBe(404)
  expect((await f.handle(f.request('/assistants', { ...create, ownerId: 'reader' }))).status).toBe(400)
  expect(await (await f.handle(f.request('/assistants/settings'))).json()).toMatchObject({ presets: [], allocations: [] })
})
