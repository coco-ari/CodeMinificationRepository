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
import { projectAssistantReceiptIntent, type ProjectAssistantRequestReceipt } from '../../../../../../../autoops/contracts/project-management-receipts.ts'

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'assistant-http-')), sessions = new DatabaseSync(':memory:'), bindings = new DatabaseSync(':memory:')
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  for (const id of ['admin', 'reader']) sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(id).digest('hex'), id, 'test-csrf', 60_000)
  const catalog = { users: [{ id: 'admin', name: '管理员', role: 'admin' }, { id: 'reader', name: '只读成员', role: 'member' }], projects: [{ id: 'project', name: '项目', memberIds: ['reader'], memberships: [{ userId: 'reader', role: 'reader' as const, workspaceAccess: 'internal' as const, environmentIds: [], status: 'active' as const }], environments: [], documents: [], resources: [] }], agents: [] }
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, catalog, now: () => 1000 })
  for (const id of ['admin', 'reader']) access.recordNativeSession(access.authenticateCookie(`demo_session=${id}`), id)
  const directory = createAssistantDirectory({ dataDir, membership: (actor, project) => access.requireProjectActionForActor(actor, project, 'chat.use'), manage: (actor, project) => access.requireProjectActionForActor(actor, project, 'project.manage'), validate: () => {}, validateTarget: () => {}, choices: () => ({ agents: [], sources: [], platformSkills: [] }) })
  mock.directory = directory
  const app = HttpRouter.toWebHandler(assistantsRoutes(createBusinessHttpContext(access)).pipe(HttpRouter.provideRequest(Layer.mergeAll(NodeServices.layer, Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
    authenticateHttpRequest: (request: { headers: Record<string, string> }) => Effect.succeed({ sessionId: AuthSessionId.make(request.headers['x-test-session'] ?? 'missing'), subject: 'test', method: 'bearer-access-token', scopes: [] }),
  } as unknown as EnvironmentAuth.EnvironmentAuth['Service'])))), { disableLogger: true })
  const request = (suffix = '/assistants', body?: unknown, user = 'admin', csrf = true, project = 'project') => new Request(`http://localhost/api/v1/projects/${project}${suffix}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-test-session': user, ...(csrf ? { 'x-demo-csrf': 'test-csrf' } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { access, directory, catalog, sessions, request, handle: app.handler, async [Symbol.asyncDispose]() { await app.dispose(); directory.close(); sessions.close(); bindings.close(); rmSync(dataDir, { recursive: true, force: true }); mock.directory = undefined } }
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
  expect((await f.handle(f.request('/assistants/choices', undefined, 'reader'))).status).toBe(403)
  expect(await (await f.handle(f.request('/assistants/choices'))).json()).toEqual({ agents: [], sources: [], platformSkills: [] })
  expect((await f.handle(f.request('/assistants', undefined, 'reader', true, 'another'))).status).toBe(404)
  expect((await f.handle(f.request('/assistants', { ...create, ownerId: 'reader' }))).status).toBe(400)
  expect(await (await f.handle(f.request('/assistants/settings'))).json()).toMatchObject({ presets: [], allocations: [] })
})


it('项目助手和分配已保存原请求可通过本人只读收据恢复', async () => {
  await using f = setup()
  const response = await f.handle(f.request('/assistants', create))
  expect(response.status).toBe(200)
  const preset = (await response.json()) as { id: string }
  const receipt = await f.handle(
    f.request('/assistants/receipts/' + create.requestId, undefined, 'admin', false),
  )
  expect(receipt.status, await receipt.clone().text()).toBe(200)
  expect(await receipt.json()).toMatchObject({
    state: 'completed',
    saved: true,
    available: true,
    actorId: 'admin',
    projectId: 'project',
    requestId: create.requestId,
    operation: 'preset.save:new',
    result: preset,
  })
  const assign = {
    requestId: 'assign-reader',
    expectedRevision: 0,
    target: { kind: 'member', id: 'reader' },
    assistantIds: [preset.id],
    defaultAssistantId: preset.id,
  }
  const assigned = await f.handle(f.request('/assistant-allocations', assign))
  expect(assigned.status).toBe(200)
  const allocation = await assigned.json()
  expect(
    await (await f.handle(f.request('/assistants/receipts/' + assign.requestId))).json(),
  ).toMatchObject({ operation: 'allocation.save:member:reader', result: allocation })
})

it('助手收据绑定精确预设、分配目标和修订，篡改同ID不能被原成功确认', async () => {
  await using f = setup()
  const digest = (operation: string, input: unknown) =>
    createHash('sha256').update(projectAssistantReceiptIntent(operation, input)).digest('hex')
  const preset = (await (await f.handle(f.request('/assistants', create))).json()) as { id: string }
  const first = (await (
    await f.handle(f.request('/assistants/receipts/' + create.requestId))
  ).json()) as ProjectAssistantRequestReceipt
  expect(first.publicIntent).toEqual({
    algorithm: 'sha256',
    digest: digest('preset.save:new', create),
  })
  const changed = { ...create, value: { ...value, instructions: '篡改正文' } }
  expect((await f.handle(f.request('/assistants', changed))).status).toBe(409)
  expect(first.publicIntent.digest).not.toBe(digest('preset.save:new', changed))
  const edit = {
    ...create,
    requestId: 'edit-preset',
    expectedRevision: 1,
    value: { ...value, instructions: '保存的私有说明' },
  }
  const saved = await f.handle(f.request('/assistants/' + preset.id, edit))
  expect(saved.status).toBe(200)
  expect(
    await (await f.handle(f.request('/assistants/receipts/' + edit.requestId))).json(),
  ).toMatchObject({
    operation: 'preset.save:' + preset.id,
    publicIntent: { digest: digest('preset.save:' + preset.id, edit) },
    result: await saved.json(),
  })
  const assign = {
    requestId: 'assign-reader',
    expectedRevision: 0,
    target: { kind: 'member', id: 'reader' },
    assistantIds: [preset.id],
    defaultAssistantId: preset.id,
  }
  const assigned = await f.handle(f.request('/assistant-allocations', assign))
  expect(assigned.status).toBe(200)
  const receipt = (await (
    await f.handle(f.request('/assistants/receipts/' + assign.requestId))
  ).json()) as ProjectAssistantRequestReceipt
  expect(receipt).toMatchObject({
    operation: 'allocation.save:member:reader',
    publicIntent: { digest: digest('allocation.save:member:reader', assign) },
    result: await assigned.json(),
  })
  const otherTarget = { ...assign, target: { kind: 'member', id: 'admin' } }
  expect((await f.handle(f.request('/assistant-allocations', otherTarget))).status).toBe(409)
  expect(receipt.publicIntent.digest).not.toBe(digest('allocation.save:member:admin', otherTarget))
  expect(f.directory.settings('admin', 'project').allocations).toHaveLength(1)
})

it('助手原收据不暴露其他操作者或项目，撤权与晚到登录失败保留安全事实', async () => {
  await using f = setup()
  expect((await f.handle(f.request('/assistants', create))).status).toBe(200)
  const path = '/assistants/receipts/' + create.requestId
  expect(await (await f.handle(f.request(path, undefined, 'reader'))).json()).toBeNull()
  expect(
    await (await f.handle(f.request(path, undefined, 'admin', true, 'other-project'))).json(),
  ).toBeNull()
  expect(await (await f.handle(f.request('/assistants/receipts/missing'))).json()).toBeNull()
  expect((await f.handle(f.request('/assistants/receipts/%21'))).status).toBe(400)
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
  expect(JSON.stringify(masked)).not.toContain(value.name)
  f.catalog.users[0]!.role = 'admin'
  const original = f.directory.projectReceipt.bind(f.directory)
  const spy = vi.spyOn(f.directory, 'projectReceipt').mockImplementationOnce((...args) => {
    const result = original(...args)
    f.catalog.users[0]!.role = 'member'
    return result
  })
  expect(await (await f.handle(f.request(path))).json()).toMatchObject({ available: false })
  spy.mockRestore()
  f.catalog.users[0]!.role = 'admin'
  vi.spyOn(f.directory, 'projectReceipt').mockImplementationOnce((...args) => {
    const result = original(...args)
    f.sessions.prepare('DELETE FROM sessions WHERE uid=?').run('admin')
    return result
  })
  expect((await f.handle(f.request(path))).status).toBe(401)
  f.directory.close()
  expect(() => f.directory.projectReceipt('admin', 'project', create.requestId)).toThrow(
    '助手目录已停止',
  )
})
