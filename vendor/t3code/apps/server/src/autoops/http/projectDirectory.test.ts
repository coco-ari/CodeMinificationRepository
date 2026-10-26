// @effect-diagnostics nodeBuiltinImport:off -- 隔离测试直接创建临时 SQLite 与登录夹具，不访问宿主业务数据。
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
import * as ProjectService from '../../project/ProjectService.ts'
import * as EnvironmentAuth from '../../auth/EnvironmentAuth.ts'
import { createBusinessHttpContext } from './context.ts'
import { createProjectDirectory, type ProjectDirectory } from '../../../../../../../agent-demo/t3-adapters/project-directory/index.ts'

const mocks = vi.hoisted(() => ({ directory: undefined as ProjectDirectory | undefined, synchronize: vi.fn() }))
vi.mock(import('../../../../../../../agent-demo/t3-adapters/access.mjs'), async original => ({ ...await original(), configuredAutoOpsProjectDirectory: () => mocks.directory! }))
vi.mock(import('../projects.ts'), () => ({ synchronizeProject: (...args: unknown[]) => Effect.sync(() => mocks.synchronize(...args)) }))
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import { projectDirectoryRoutes } from './projectDirectory.ts'

function setup() {
  mocks.synchronize.mockReset()
  const dataDir = mkdtempSync(join(tmpdir(), 'directory-http-'))
  const sessions = new DatabaseSync(':memory:'), bindings = new DatabaseSync(':memory:')
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  for (const id of ['actor', 'reader', 'outside']) sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(id).digest('hex'), id, 'test-csrf', 60_000)
  let access: ReturnType<typeof createAutoOpsAccess>
  const directory = createProjectDirectory({ dataDir, seed: { users: [
    { id: 'actor', name: '内部账号', role: 'member' }, { id: 'reader', name: '只读成员', role: 'member' }, { id: 'outside', name: '外部账号', role: 'member', kind: 'external' },
  ], projects: [], agents: [] }, authorize: (...args) => access.requireProjectActionForActor(...args) })
  mocks.directory = directory
  access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, catalog: directory.catalog, now: () => 1000 })
  for (const id of ['actor', 'reader', 'outside']) access.recordNativeSession(access.authenticateCookie(`demo_session=${id}`), id)
  const app = HttpRouter.toWebHandler(projectDirectoryRoutes(createBusinessHttpContext(access)).pipe(
    HttpRouter.provideRequest(Layer.mergeAll(NodeServices.layer, Layer.mock(ProjectService.ProjectService)({}), Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
      authenticateHttpRequest: (request: { headers: Record<string, string> }) => Effect.succeed({ sessionId: AuthSessionId.make(request.headers['x-test-session'] ?? 'missing'), subject: 'test', method: 'bearer-access-token', scopes: [] }),
    } as unknown as EnvironmentAuth.EnvironmentAuth['Service']))),
  ), { disableLogger: true })
  const request = (path = '', body?: object, user = 'actor', csrf = true) => new Request('http://localhost/api/v1/projects' + path, {
    method: body ? 'POST' : 'GET', headers: { 'x-test-session': user, ...(csrf ? { 'x-demo-csrf': 'test-csrf' } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { access, directory, request, handle: app.handler, async [Symbol.asyncDispose]() { await app.dispose(); directory.close(); sessions.close(); bindings.close(); rmSync(dataDir, { recursive: true, force: true }); mocks.directory = undefined } }
}
const create = { requestId: 'create-project', expectedRevision: 0, value: { name: '真实目录接口项目', description: '' } }

it('真实会话、SQLite 和路由创建同一项目并登记原生入口，原请求恢复不重复创建', async () => {
  await using f = setup()
  const first = await f.handle(f.request('', create)), value = await first.json() as { id: string }
  expect(first.status).toBe(200)
  const replay = await f.handle(f.request('', create))
  expect(await replay.json()).toEqual(value)
  const listed = await f.handle(f.request())
  expect((await listed.json() as { items: unknown[] }).items).toHaveLength(1)
  expect(mocks.synchronize).toHaveBeenCalledTimes(2)
  const settings = await f.handle(f.request(`/${value.id}/settings`))
  expect(await settings.json()).toMatchObject({ project: { id: value.id, environments: [] }, members: [{ userId: 'actor', role: 'project_admin' }] })
})

it('缺失会话、CSRF、外部创建和只读保存全部拒绝，拒绝写入不消耗正文', async () => {
  await using f = setup()
  expect((await f.handle(f.request('', undefined, 'missing'))).status).toBe(401)
  const noCsrf = f.request('', create, 'actor', false)
  expect((await f.handle(noCsrf)).status).toBe(403)
  expect(noCsrf.bodyUsed).toBe(false)
  expect((await f.handle(f.request('', create, 'outside'))).status).toBe(403)
  const created = await f.handle(f.request('', create)), project = await created.json() as { id: string }
  f.directory.saveMember('actor', project.id, { requestId: 'add-reader', expectedRevision: 0, value: { userId: 'reader', role: 'reader', environmentIds: [], environmentRoles: {}, canAdjustChat: true, status: 'active' } })
  const forged = f.request(`/${project.id}/settings`, { ...create, requestId: 'forged', expectedRevision: 1 }, 'reader')
  expect((await f.handle(forged)).status).toBe(403)
  expect(forged.bodyUsed).toBe(false)
  expect((await f.handle(f.request(`/${project.id}/settings`, undefined, 'reader'))).status).toBe(403)
  expect(f.directory.settings('actor', project.id).project.revision).toBe(1)
})

it('环境与成员写入原子校验、修订冲突和即时撤权经真实路由生效', async () => {
  await using f = setup()
  const created = await f.handle(f.request('', create)), project = await created.json() as { id: string }
  const base = `/${project.id}`
  const environment = await f.handle(f.request(`${base}/environments`, { requestId: 'create-env', expectedRevision: 0, value: { name: '测试环境' } }))
  const env = await environment.json() as { id: string }
  expect(environment.status).toBe(200)
  const input = { requestId: 'assign', expectedRevision: 0, value: { userId: 'reader', role: 'release_operator', environmentIds: [env.id], environmentRoles: { [env.id]: 'reader' }, canAdjustChat: true, status: 'active' } }
  expect((await f.handle(f.request(`${base}/members`, input))).status).toBe(200)
  expect(() => f.access.requireDeploymentActionForActor('reader', project.id, 'publish', env.id)).toThrow()
  const conflict = await f.handle(f.request(`${base}/members`, { ...input, requestId: 'stale' }))
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ code: 'PROJECT_REVISION_CONFLICT' })
  expect((await f.handle(f.request(`${base}/members`, { ...input, requestId: 'disable', expectedRevision: 1, value: { ...input.value, status: 'disabled' } }))).status).toBe(200)
  expect(() => f.access.requireProjectActionForActor('reader', project.id, 'chat.use')).toThrow()
})

it('业务已保存后被撤权，仅确认保存而不返回项目详情，避免把已提交请求误报成可重做失败', async () => {
  await using f = setup()
  const created = await f.handle(f.request('', create)), project = await created.json() as { id: string }
  f.directory.saveMember('actor', project.id, { requestId: 'another-admin', expectedRevision: 0, value: { userId: 'reader', role: 'project_admin', environmentIds: [], environmentRoles: {}, canAdjustChat: true, status: 'active' } })
  mocks.synchronize.mockImplementationOnce(() => f.directory.saveMember('reader', project.id, { requestId: 'revoke-original-admin', expectedRevision: 1, value: { userId: 'actor', role: 'reader', environmentIds: [], environmentRoles: {}, canAdjustChat: true, status: 'active' } }))
  const response = await f.handle(f.request(`/${project.id}/settings`, { requestId: 'saved-before-revoke', expectedRevision: 1, value: { name: '已保存的新名称', description: '' } }))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ saved: true, available: false })
  expect(f.directory.settings('reader', project.id).project.name).toBe('已保存的新名称')
})
