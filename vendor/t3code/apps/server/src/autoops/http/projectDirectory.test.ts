// @effect-diagnostics nodeBuiltinImport:off -- 隔离测试直接创建临时 SQLite 与登录夹具，不访问宿主业务数据。
import { expect, it, vi } from 'vite-plus/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { HttpRouter } from 'effect/http'
import { AuthSessionId } from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as ProjectService from '../../project/ProjectService.ts'
import * as EnvironmentAuth from '../../auth/EnvironmentAuth.ts'
import { createBusinessHttpContext } from './context.ts'
import { createProjectDirectory, type ProjectDirectory } from '../../../../../../../agent-demo/t3-adapters/project-directory/index.ts'

const mocks = vi.hoisted(() => ({ directory: undefined as ProjectDirectory | undefined, synchronize: vi.fn(), synchronizationFailure: undefined as ProjectService.ProjectOperationError|undefined, blockers: [] as Array<{kind:string;count:number;message:string}>, nativeDelete: vi.fn(), nativeRead: vi.fn(), nativeExists: false }))
vi.mock(import('../../../../../../../agent-demo/t3-adapters/access.mjs'), async original => ({ ...await original(), configuredAutoOpsProjectDirectory: () => mocks.directory! }))
vi.mock(import('../projects.ts'), async original => ({ ...await original(), synchronizeProject: (...args: unknown[]) => Effect.suspend(() => { mocks.synchronize(...args);return mocks.synchronizationFailure ? Effect.fail(mocks.synchronizationFailure) : Effect.succeed(undefined) }) }))
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import { projectDirectoryRoutes } from './projectDirectory.ts'

function setup() {
  mocks.synchronize.mockReset()
  mocks.synchronizationFailure = undefined
  mocks.blockers = []
  mocks.nativeExists = false
  mocks.nativeDelete.mockReset()
  mocks.nativeRead.mockReset()
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
  const app = HttpRouter.toWebHandler(projectDirectoryRoutes(createBusinessHttpContext(access), () => mocks.blockers).pipe(
    HttpRouter.provideRequest(Layer.mergeAll(NodeServices.layer, Layer.mock(ProjectService.ProjectService)({
      getById: id => mocks.nativeRead(id) ?? Effect.succeed(mocks.nativeExists ? Option.some({} as never) : Option.none()),
      delete: input => mocks.nativeDelete(input) ?? Effect.succeed({} as never),
    }), Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
      authenticateHttpRequest: (request: { headers: Record<string, string> }) => Effect.succeed({ sessionId: AuthSessionId.make(request.headers['x-test-session'] ?? 'missing'), subject: 'test', method: 'bearer-access-token', scopes: [] }),
    } as unknown as EnvironmentAuth.EnvironmentAuth['Service']))),
  ), { disableLogger: true })
  const request = (path = '', body?: object, user = 'actor', csrf = true, method?: string) => new Request('http://localhost/api/v1/projects' + path, {
    method: method ?? (body ? 'POST' : 'GET'), headers: { 'x-test-session': user, ...(csrf ? { 'x-demo-csrf': 'test-csrf' } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
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

it('丢写入回复后只GET同actor原收据，返回原意图且不重复同步项目', async () => {
  await using f = setup()
  const response = await f.handle(f.request('', create))
  const project = await response.json() as { id: string }
  for (let round = 0; round < 2; round++) {
    const receipt = await f.handle(f.request(`/receipts/${create.requestId}`, undefined, 'actor', false))
    expect(receipt.status).toBe(200)
    expect(await receipt.json()).toMatchObject({
      state: 'completed', actorId: 'actor', requestId: create.requestId,
      operation: 'project.create', projectId: project.id, environmentId: null,
      saved: true, available: true,
      publicIntent: { expectedRevision: 0, value: create.value }, result: { id: project.id },
    })
  }
  expect(mocks.synchronize).toHaveBeenCalledTimes(1)
  expect(f.directory.list('actor')).toHaveLength(1)
})

it('删除结果未知的GET只返回耐久pending，不重发原生删除或把目录消失当成功', async () => {
  await using f = setup()
  const project = await (await f.handle(f.request('', create))).json() as { id: string }
  mocks.nativeExists = true
  mocks.nativeDelete.mockImplementationOnce(() => Effect.fail(new ProjectService.ProjectOperationError({ operation: 'dispatch-project-command', cause: '本次结果未知' })))
  const command = { requestId: 'delete-only-read-recovery', expectedRevision: 1 }
  expect((await f.handle(f.request(`/${project.id}`, command, 'actor', true, 'DELETE'))).status).toBe(503)
  const response = await f.handle(f.request(`/receipts/${command.requestId}`, undefined, 'actor', false))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ state: 'pending', saved: true, actorId: 'actor', projectId: project.id, operation: 'project.delete', publicIntent: { expectedRevision: 1 } })
  expect(mocks.nativeDelete).toHaveBeenCalledTimes(1)
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

it('环境删除、修订冲突和原请求恢复经真实 HTTP 保留最小结果', async () => {
  await using f = setup()
  const project = (await (await f.handle(f.request('', create))).json()) as { id: string }
  const env = (await (
    await f.handle(
      f.request(`/${project.id}/environments`, {
        requestId: 'env',
        expectedRevision: 0,
        value: { name: '空环境' },
      }),
    )
  ).json()) as { id: string }
  const path = `/${project.id}/environments/${env.id}`
  expect(await (await f.handle(f.request(`${path}/deletion-preview`))).json()).toMatchObject({
    canDelete: true,
    revision: 1,
  })
  expect(
    (
      await f.handle(
        f.request(path, { requestId: 'stale-env', expectedRevision: 2 }, 'actor', true, 'DELETE'),
      )
    ).status,
  ).toBe(409)
  const command = { requestId: 'delete-env', expectedRevision: 1 }
  for (let round = 0; round < 2; round++) {
    const response = await f.handle(f.request(path, command, 'actor', true, 'DELETE'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      deleted: true,
      projectId: project.id,
      environmentId: env.id,
    })
  }
  expect(f.directory.settings('actor', project.id).project.environments).toEqual([])
})

it('越权删除与缺 CSRF 不解析正文，引用在预检后变化仍拒绝，配置错误不被吞作空引用', async () => {
  await using f = setup()
  const project = (await (await f.handle(f.request('', create))).json()) as { id: string }
  for (const [user, csrf] of [
    ['outside', true],
    ['actor', false],
  ] as const) {
    const request = f.request(
      `/${project.id}`,
      { requestId: 'denied', expectedRevision: 1 },
      user,
      csrf,
      'DELETE',
    )
    expect((await f.handle(request)).status).toBe(403)
    expect(request.bodyUsed).toBe(false)
  }
  expect((await f.handle(f.request(`/${project.id}/deletion-preview`))).status).toBe(200)
  mocks.blockers = [{ kind: 'test-active', count: 1, message: '仍有活动输入' }]
  const response = await f.handle(
    f.request(
      `/${project.id}`,
      { requestId: 'blocked', expectedRevision: 1 },
      'actor',
      true,
      'DELETE',
    ),
  )
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'PROJECT_DELETE_BLOCKED' })
  expect(f.directory.list('actor')).toHaveLength(1)
})

it('原生结果未知保持 deleting，恢复同命令且删除完成后重复不重建原生项目', async () => {
  await using f = setup()
  const project = (await (await f.handle(f.request('', create))).json()) as { id: string }
  mocks.nativeExists = true
  mocks.nativeDelete.mockImplementationOnce(() =>
    Effect.fail(
      new ProjectService.ProjectOperationError({
        operation: 'dispatch-project-command',
        cause: '隔离结果未知',
      }),
    ),
  )
  const command = { requestId: 'delete-original', expectedRevision: 1 }
  expect(
    (await f.handle(f.request(`/${project.id}`, command, 'actor', true, 'DELETE'))).status,
  ).toBe(503)
  expect(f.directory.list('actor')).toEqual([])
  expect(
    (
      await f.handle(
        f.request(`/${project.id}/settings`, {
          ...create,
          requestId: 'late-save',
          expectedRevision: 2,
        }),
      )
    ).status,
  ).toBe(404)
  const recovered = await f.handle(f.request(`/${project.id}`, command, 'actor', true, 'DELETE'))
  expect(recovered.status).toBe(200)
  expect(await recovered.json()).toEqual({ deleted: true, projectId: project.id })
  const commands = mocks.nativeDelete.mock.calls.map(
    ([value]) => value as { commandId: string; force: boolean },
  )
  expect(commands[0]?.commandId).toBe(commands[1]?.commandId)
  expect(commands.every((value) => value.force === false)).toBe(true)
  expect(
    (await f.handle(f.request(`/${project.id}`, command, 'actor', true, 'DELETE'))).status,
  ).toBe(200)
  expect(mocks.nativeDelete).toHaveBeenCalledTimes(2)
  expect(mocks.synchronize).toHaveBeenCalledTimes(1)
})

it('原生同步失败后GET仅确认目录已保存，不补写或把缺失原生项目当就绪', async () => {
  await using f = setup()
  mocks.synchronizationFailure = new ProjectService.ProjectOperationError({ operation: 'dispatch-project-command', cause: '本次隔离同步失败' })
  expect([500, 503]).toContain((await f.handle(f.request('', create))).status)
  for (let round = 0; round < 2; round++) {
    const response = await f.handle(f.request(`/receipts/${create.requestId}`, undefined, 'actor', false))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ saved: true, state: 'completed', nativeSynchronization: 'unverified', publicIntent: { expectedRevision: 0, value: create.value } })
  }
  expect(mocks.synchronize).toHaveBeenCalledTimes(1)
  expect(mocks.nativeDelete).not.toHaveBeenCalled()
  expect(f.directory.list('actor')).toHaveLength(1)
})

it('GET只读核对当前原生目标，匹配可就绪，不匹配和读取异常保留已保存而未核验事实', async () => {
  await using f = setup()
  vi.stubEnv('AUTOOPS_T3_DATA_DIR', '/fixture-owned-directory')
  vi.stubEnv('AUTOOPS_T3_MODEL', 'fixture-model')
  try {
    const project = await (await f.handle(f.request('', create))).json() as { id: string }
    const native = { id: project.id, deletedAt: null, title: create.value.name, workspaceRoot: join('/fixture-owned-directory', 't3', 'workspaces', project.id), defaultModelSelection: { instanceId: 'codex', model: 'fixture-model' }, autoPull: false }
    for (const [patch, expected] of [[{}, 'current-verified'], [{ id: 'other-project' }, 'unverified'], [{ title: '另一个名称' }, 'unverified'], [{ workspaceRoot: '/another-root' }, 'unverified'], [{ deletedAt: '2026-01-01T00:00:00Z' }, 'unverified'], [{ defaultModelSelection: { instanceId: 'codex', model: 'another-model' } }, 'unverified'], [{ autoPull: true }, 'unverified']] as const) {
      mocks.nativeRead.mockReturnValue(Effect.succeed(Option.some({ ...native, ...patch })))
      const receipt = await f.handle(f.request(`/receipts/${create.requestId}`, undefined, 'actor', false))
      expect(receipt.status).toBe(200)
      expect(await receipt.json()).toMatchObject({ state: 'completed', saved: true, nativeSynchronization: expected, result: { id: project.id } })
    }
    mocks.nativeRead.mockReturnValue(Effect.fail(new ProjectService.ProjectOperationError({ operation: 'read-project', cause: '隔离读取失败' })))
    const failed = await f.handle(f.request(`/receipts/${create.requestId}`, undefined, 'actor', false))
    expect(failed.status).toBe(200)
    expect(await failed.json()).toMatchObject({ saved: true, nativeSynchronization: 'unverified' })
    expect(mocks.synchronize).toHaveBeenCalledTimes(1)
    expect(mocks.nativeDelete).not.toHaveBeenCalled()
  } finally { vi.unstubAllEnvs() }
})

it('原收据属于实际actor且无CSRF写要求，未知和其他actor均为空，当前撤权抹除结果详情', async () => {
  await using f = setup()
  const project = await (await f.handle(f.request('', create))).json() as { id: string }
  for (const [requestId, actor] of [[create.requestId, 'reader'], ['missing-request', 'actor']] as const) {
    const response = await f.handle(f.request(`/receipts/${requestId}`, undefined, actor, false))
    expect(response.status).toBe(200)
    expect(await response.json()).toBe(null)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  }
  expect((await f.handle(f.request(`/receipts/${create.requestId}`, undefined, 'missing', false))).status).toBe(401)
  f.directory.saveMember('actor', project.id, { requestId: 'receipt-another-admin', expectedRevision: 0, value: { userId: 'reader', role: 'project_admin', status: 'active', environmentIds: [], environmentRoles: {}, canAdjustChat: true } })
  f.directory.saveMember('reader', project.id, { requestId: 'receipt-revoke-admin', expectedRevision: 1, value: { userId: 'actor', role: 'reader', status: 'active', environmentIds: [], environmentRoles: {}, canAdjustChat: true } })
  const response = await f.handle(f.request(`/receipts/${create.requestId}`, undefined, 'actor', false))
  const receipt = await response.json() as Record<string, unknown>
  expect(response.status).toBe(200)
  expect(receipt).toMatchObject({ saved: true, available: false, actorId: 'actor', projectId: project.id })
  expect(receipt).not.toHaveProperty('result')
})

it('原生只读等待期间撤权会重新裁决，不能带回等待前的项目详情或就绪证明', async () => {
  await using f = setup()
  vi.stubEnv('AUTOOPS_T3_DATA_DIR', '/fixture-owned-directory')
  vi.stubEnv('AUTOOPS_T3_MODEL', 'fixture-model')
  try {
    const project = await (await f.handle(f.request('', create))).json() as { id: string }
    f.directory.saveMember('actor', project.id, { requestId: 'late-reader-admin', expectedRevision: 0, value: { userId: 'reader', role: 'project_admin', status: 'active', environmentIds: [], environmentRoles: {}, canAdjustChat: true } })
    mocks.nativeRead.mockReturnValue(Effect.sync(() => {
      f.directory.saveMember('reader', project.id, { requestId: 'late-revoke-receipt', expectedRevision: 1, value: { userId: 'actor', role: 'reader', status: 'active', environmentIds: [], environmentRoles: {}, canAdjustChat: true } })
      return Option.some({ id: project.id, deletedAt: null, title: create.value.name, workspaceRoot: join('/fixture-owned-directory', 't3', 'workspaces', project.id), defaultModelSelection: { instanceId: 'codex', model: 'fixture-model' }, autoPull: false })
    }))
    const response = await f.handle(f.request(`/receipts/${create.requestId}`, undefined, 'actor', false))
    expect(response.status).toBe(200)
    const receipt = await response.json() as Record<string, unknown>
    expect(receipt).toMatchObject({ saved: true, available: false, nativeSynchronization: 'unverified' })
    expect(receipt).not.toHaveProperty('result')
  } finally { vi.unstubAllEnvs() }
})

it('实际deleted墓碑GET仅返回原actor最小结果，blocked终态仍保留原阻止原因', async () => {
  await using f = setup()
  const project = await (await f.handle(f.request('', create))).json() as { id: string }
  mocks.nativeExists = true
  mocks.nativeDelete.mockImplementationOnce(() => Effect.fail(new ProjectService.ProjectNotEmptyError({ projectId: project.id as never })))
  const blocked = { requestId: 'blocked-original-get', expectedRevision: 1 }
  expect((await f.handle(f.request(`/${project.id}`, blocked, 'actor', true, 'DELETE'))).status).toBe(409)
  const stopped = await f.handle(f.request(`/receipts/${blocked.requestId}`, undefined, 'actor', false))
  expect(await stopped.json()).toMatchObject({ state: 'blocked', available: true, blockers: [{ kind: 'native-threads', count: 1 }] })
  const remove = { requestId: 'deleted-original-get', expectedRevision: 3 }
  expect((await f.handle(f.request(`/${project.id}`, remove, 'actor', true, 'DELETE'))).status).toBe(200)
  const response = await f.handle(f.request(`/receipts/${remove.requestId}`, undefined, 'actor', false))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ state: 'completed', available: false, result: { deleted: true, projectId: project.id } })
  expect(await (await f.handle(f.request(`/receipts/${remove.requestId}`, undefined, 'reader', false))).json()).toBe(null)
  expect(mocks.nativeDelete).toHaveBeenCalledTimes(2)
})


it('原生删除已完成但业务complete失败，GET保持pending，显式续办只完成同原请求', async () => {
  await using f = setup()
  const project = (await (await f.handle(f.request('', create))).json()) as { id: string }
  mocks.nativeExists = true
  const command = { requestId: 'delete-completion-failure', expectedRevision: 1 }
  const completion = vi.spyOn(f.directory, 'completeProjectDeletion').mockImplementationOnce(() => {
    throw new Error('隔离最终审计失败')
  })
  expect(
    (await f.handle(f.request(`/${project.id}`, command, 'actor', true, 'DELETE'))).status,
  ).toBe(503)
  expect(mocks.nativeDelete).toHaveBeenCalledTimes(1)
  expect(await (await f.handle(f.request('/receipts/' + command.requestId))).json()).toMatchObject({
    state: 'pending',
    canResume: true,
  })
  expect(mocks.nativeDelete).toHaveBeenCalledTimes(1)
  const response = await f.handle(
    f.request(`/receipts/${command.requestId}/resume`, {
      operation: 'project.delete',
      projectId: project.id,
      publicIntent: { expectedRevision: 1 },
    }),
  )
  expect(response.status, await response.clone().text()).toBe(200)
  expect(await response.json()).toMatchObject({
    state: 'completed',
    requestId: command.requestId,
    result: { deleted: true, projectId: project.id },
  })
  const count = mocks.nativeDelete.mock.calls.length
  expect(
    (
      await f.handle(
        f.request(`/receipts/${command.requestId}/resume`, {
          operation: 'project.delete',
          projectId: project.id,
          publicIntent: { expectedRevision: 1 },
        }),
      )
    ).status,
  ).toBe(200)
  expect(mocks.nativeDelete).toHaveBeenCalledTimes(count)
  completion.mockRestore()
})

it('显式继续删除拒绝跨actor、篡改范围与意图、当前撤权和新增引用，GET从不续写', async () => {
  await using f = setup()
  const project = (await (await f.handle(f.request('', create))).json()) as { id: string }
  const command = { requestId: 'resume-guards', expectedRevision: 1 }
  f.directory.beginProjectDeletion('actor', project.id, command, () => [])
  const path = `/receipts/${command.requestId}/resume`
  const intent = {
    operation: 'project.delete',
    projectId: project.id,
    publicIntent: { expectedRevision: 1 },
  }
  for (const request of [
    f.request(path, intent, 'reader'),
    f.request(path, intent, 'actor', false),
  ]) {
    expect([403, 404]).toContain((await f.handle(request)).status)
    expect(request.bodyUsed).toBe(false)
  }
  expect((await f.handle(f.request('/receipts/not-accepted/resume', intent))).status).toBe(404)
  for (const forged of [
    { ...intent, projectId: 'other-project' },
    { ...intent, publicIntent: { expectedRevision: 2 } },
  ])
    expect((await f.handle(f.request(path, forged))).status).toBe(409)
  expect(
    (await f.handle(f.request(path, { ...intent, operation: 'environment.delete' }))).status,
  ).toBe(400)
  mocks.blockers = [{ kind: 'late-reference', count: 1, message: '新增引用' }]
  expect((await f.handle(f.request(path, intent))).status).toBe(409)
  expect(await (await f.handle(f.request('/receipts/' + command.requestId))).json()).toMatchObject({
    state: 'pending',
    canResume: true,
  })
  expect(mocks.nativeDelete).not.toHaveBeenCalled()
  mocks.blockers = []
  f.directory.catalog.users[0]!.kind = 'external'
  expect(await (await f.handle(f.request('/receipts/' + command.requestId))).json()).toMatchObject({
    state: 'pending',
    canResume: false,
  })
  const denied = f.request(path, intent)
  expect((await f.handle(denied)).status).toBe(403)
  expect(denied.bodyUsed).toBe(false)
  expect(mocks.nativeDelete).not.toHaveBeenCalled()
})

it('继续删除实际正文流有界且读取后再核登录，不接受大JSON或迟到原会话', async () => {
  await using f = setup()
  const project = (await (await f.handle(f.request('', create))).json()) as { id: string }
  const command = { requestId: 'resume-body-guards', expectedRevision: 1 }
  f.directory.beginProjectDeletion('actor', project.id, command, () => [])
  const intent = {
    operation: 'project.delete',
    projectId: project.id,
    publicIntent: { expectedRevision: 1 },
  }
  const headers = {
    'x-test-session': 'actor',
    'x-demo-csrf': 'test-csrf',
    'content-type': 'application/json',
  }
  const url = `http://localhost/api/v1/projects/receipts/${command.requestId}/resume`
  const large = new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(intent) + ' '.repeat(4096),
  })
  expect((await f.handle(large)).status).toBe(400)
  let authorized!: () => void
  const allowed = new Promise<void>((resolve) => {
    authorized = resolve
  })
  const requireAccess = f.directory.requireProjectDeletionResumeAccess.bind(f.directory)
  vi.spyOn(f.directory, 'requireProjectDeletionResumeAccess').mockImplementationOnce((...args) => {
    requireAccess(...args)
    authorized()
  })
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await allowed
      f.directory.catalog.users[0]!.status = 'disabled'
      controller.enqueue(new TextEncoder().encode(JSON.stringify(intent)))
      controller.close()
    },
  })
  const lost = new Request(url, { method: 'POST', headers, body, duplex: 'half' } as RequestInit)
  expect((await f.handle(lost)).status).toBe(401)
  expect(lost.bodyUsed).toBe(true)
  expect(mocks.nativeDelete).not.toHaveBeenCalled()
})
