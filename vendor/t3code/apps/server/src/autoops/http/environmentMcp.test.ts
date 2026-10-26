// @effect-diagnostics nodeBuiltinImport:off -- HTTP回归使用隔离SQLite、真实授权/凭证/环境所有者，外部只读端口受控。
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
  AutoOpsAccessError,
  type AutoOpsProject,
} from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import { createProjectCredentialService } from '../../../../../../../agent-demo/t3-adapters/credentials.ts'
import {
  createEnvironmentMcp,
  type EnvironmentMcpReadonlyDriver,
} from '../../../../../../../agent-demo/t3-adapters/environment-mcp/index.ts'
import type * as C from '../../../../../../../autoops/contracts/environment-mcp.ts'
import { environmentMcpRoutes } from './environmentMcp.ts'

const base = '/api/v1/projects/project/environments/test/mcp'
const command = (expectedRevision: number) => ({ requestId: randomUUID(), expectedRevision })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'environment-mcp-http-')),
    sessions = new DatabaseSync(':memory:'),
    bindings = new DatabaseSync(':memory:')
  sessions.exec(
    'CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)',
  )
  initializeAutoOpsAccessSchema(bindings)
  const users = ['manager', 'reader', 'outsider', 'pending'].map((id) => ({
    id,
    name: id,
    role: 'member',
    kind: 'internal' as const,
  }))
  const project: AutoOpsProject = {
    id: 'project',
    name: '环境验收项目',
    memberIds: ['manager', 'reader', 'pending'],
    documents: [],
    resources: [],
    environments: [
      { id: 'test', name: '测试' },
      { id: 'production', name: '生产' },
    ],
    memberships: [
      {
        userId: 'manager',
        role: 'project_admin',
        workspaceAccess: 'internal',
        environmentIds: ['test', 'production'],
        status: 'active',
      },
      {
        userId: 'reader',
        role: 'reader',
        workspaceAccess: 'internal',
        environmentIds: ['test'],
        status: 'active',
      },
      {
        userId: 'pending',
        role: 'project_admin',
        workspaceAccess: 'internal',
        environmentIds: ['test'],
        status: 'active',
        authorizationPending: true,
      },
    ],
  }
  const access = createAutoOpsAccess({
    sessionDb: sessions,
    bindingDb: bindings,
    catalog: { users, projects: [project], agents: [] },
    now: () => 1000,
  })
  for (const user of users) {
    sessions
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(createHash('sha256').update(user.id).digest('hex'), user.id, 'csrf', 60000)
    access.recordNativeSession(access.authenticateCookie(`demo_session=${user.id}`), user.id)
  }
  const credentials = createProjectCredentialService({
    databasePath: join(dataDir, 'credentials.sqlite'),
    keyPath: join(dataDir, 'credentials.key'),
    initializeKeyIfNew: true,
    authorize: (actor, projectId, action) => {
      access.requireCredentialActor(actor, projectId, action)
    },
  })
  const credential = credentials.create('manager', 'project', {
    requestId: randomUUID(),
    name: '隔离只读凭证',
    username: 'isolated-reader',
    password: 'isolated-secret',
  })
  const driver: EnvironmentMcpReadonlyDriver = {
    test: vi.fn(async () => ({
      actions: [
        'mysql.tables',
        'mysql.describe',
        'mysql.query',
        'mysql.explain',
      ] as C.EnvironmentMcpAction[],
    })),
    execute: vi.fn(async () => ({ data: { value: 'isolated' }, truncated: false })),
    close: vi.fn(),
  }
  const owner = createEnvironmentMcp({
    dataDir,
    credentials,
    authorizeManage(actor, projectId, environment) {
      const member = access.requireProjectActionForActor(actor, projectId, 'project.manage')
      if (!member.environmentIds.includes(environment))
        throw new AutoOpsAccessError(404, 'ENVIRONMENT_NOT_FOUND', '环境不存在或不属于当前项目')
    },
    authorizeQuery(actor, projectId, environment) {
      if (environment === null) access.requireProjectActionForActor(actor, projectId, 'chat.use')
      else access.requireEnvironmentQueryForActor(actor, projectId, environment)
    },
    drivers: { mysql: driver },
  })
  const app = HttpRouter.toWebHandler(
    environmentMcpRoutes(createBusinessHttpContext(access), owner).pipe(
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
    path: string,
    input?: unknown,
    actor = 'manager',
    csrf = true,
    method?: string,
  ) =>
    new Request(`http://localhost${path}`, {
      method: method ?? (input === undefined ? 'GET' : 'POST'),
      headers: {
        'x-test-session': actor,
        'content-type': 'application/json',
        ...(csrf ? { 'x-demo-csrf': 'csrf' } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    })
  const config: C.EnvironmentMcpConfiguration = {
    type: 'mysql',
    name: '隔离库',
    host: 'isolated.invalid',
    port: 3306,
    credentialId: credential.id,
    database: 'app',
    tls: 'required',
  }
  const save = async () => {
    const response = await app.handler(request(base, { ...command(0), value: config }))
    expect(response.status).toBe(200)
    return (await response.json()) as C.EnvironmentMcpConnection
  }
  return {
    access,
    owner,
    credentials,
    credential,
    driver,
    project,
    sessions,
    request,
    config,
    save,
    handle: app.handler,
    async [Symbol.asyncDispose]() {
      await app.dispose()
      await owner.close()
      credentials.close()
      sessions.close()
      bindings.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

it('管理员在环境内新增、测试、启用、停用和移除，原请求恢复不重复操作或泄露凭证', async () => {
  await using f = await setup()
  const save = { ...command(0), value: f.config }
  const first = await f.handle(f.request(base, save))
  expect(first.status).toBe(200)
  const connection = (await first.json()) as C.EnvironmentMcpConnection
  expect(connection.enabled).toBe(false)
  expect(await (await f.handle(f.request(base, save))).json()).toEqual(connection)
  const tested = { ...command(1) }
  const testedResponse = await f.handle(f.request(`${base}/${connection.id}/test`, tested))
  expect(testedResponse.status).toBe(200)
  expect(((await testedResponse.json()) as C.EnvironmentMcpTestResult).status).toBe('passed')
  expect((await f.handle(f.request(`${base}/${connection.id}/test`, tested))).status).toBe(200)
  expect(f.driver.test).toHaveBeenCalledTimes(1)
  const enabled = await f.handle(
    f.request(`${base}/${connection.id}/enabled`, { ...command(1), enabled: true }),
  )
  expect(enabled.status).toBe(200)
  expect((await enabled.json()) as C.EnvironmentMcpConnection).toMatchObject({
    revision: 2,
    enabled: true,
  })
  const disabled = await f.handle(
    f.request(`${base}/${connection.id}/enabled`, { ...command(2), enabled: false }),
  )
  expect(disabled.status).toBe(200)
  const remove = command(3)
  expect(
    (await f.handle(f.request(`${base}/${connection.id}`, remove, 'manager', true, 'DELETE')))
      .status,
  ).toBe(200)
  expect(
    (await f.handle(f.request(`${base}/${connection.id}`, remove, 'manager', true, 'DELETE')))
      .status,
  ).toBe(200)
  const list = await f.handle(f.request(base))
  expect(await list.json()).toEqual({ items: [] })
  const receipt = await f.handle(f.request(`${base}/receipts/${save.requestId}`))
  const encoded = JSON.stringify(await receipt.json())
  expect(encoded).toContain('completed')
  expect(encoded).not.toContain('isolated-secret')
})

it('只读、项目外及待分配成员不能管理，跨环境连接ID不泄露或修改', async () => {
  await using f = await setup()
  const connection = await f.save()
  for (const [actor, status] of [
    ['reader', 403],
    ['pending', 403],
    ['outsider', 404],
  ] as const) {
    expect((await f.handle(f.request(base, undefined, actor))).status).toBe(status)
    expect(
      (await f.handle(f.request(`${base}/${connection.id}/test`, command(1), actor))).status,
    ).toBe(status)
  }
  const other = base.replace('/test/', '/production/')
  expect((await f.handle(f.request(`${other}/${connection.id}/test`, command(1)))).status).toBe(404)
  expect(
    (
      await f.handle(
        f.request(`${other}/${connection.id}/enabled`, { ...command(1), enabled: true }),
      )
    ).status,
  ).toBe(404)
  expect((await f.handle(f.request(base.replace('/test/', '/foreign/')))).status).toBe(404)
  expect(f.driver.test).not.toHaveBeenCalled()
})

it('授权和CSRF先于正文解析，严格拒绝伪造身份、额外字段、错误JSON与超过16KiB正文', async () => {
  await using f = await setup()
  for (const [actor, csrf] of [
    ['reader', true],
    ['manager', false],
  ] as const) {
    const request = new Request(`http://localhost${base}`, {
      method: 'POST',
      headers: { 'x-test-session': actor, ...(csrf ? { 'x-demo-csrf': 'csrf' } : {}) },
      body: 'invalid JSON',
    })
    expect((await f.handle(request)).status).toBe(403)
    expect(request.bodyUsed).toBe(false)
  }
  for (const input of [
    { ...command(0), value: f.config, actor: 'manager' },
    { ...command(0), value: f.config, projectId: 'project' },
    { ...command(0), value: { ...f.config, password: 'forged' } },
    { ...command(0), value: { ...f.config, name: 'x'.repeat(17000) } },
  ])
    expect((await f.handle(f.request(base, input))).status).toBe(400)
  const malformed = new Request(`http://localhost${base}`, {
    method: 'POST',
    headers: { 'x-test-session': 'manager', 'x-demo-csrf': 'csrf' },
    body: '{bad',
  })
  expect((await f.handle(malformed)).status).toBe(400)
  const oversized = new Request(`http://localhost${base}`, {
    method: 'POST',
    headers: {
      'x-test-session': 'manager',
      'x-demo-csrf': 'csrf',
      'content-type': 'application/json',
    },
    body: ' '.repeat(17000) + JSON.stringify({ ...command(0), value: f.config }),
  })
  expect((await f.handle(oversized)).status).toBe(400)
  expect(f.owner.list('project', 'test', 'manager')).toEqual([])
})

it('修订冲突和凭证更新要求重新测试，不能沿旧成功结果启用新秘密', async () => {
  await using f = await setup()
  const connection = await f.save()
  expect((await f.handle(f.request(`${base}/${connection.id}/test`, command(1)))).status).toBe(200)
  f.credentials.replace('manager', 'project', f.credential.id, {
    requestId: randomUUID(),
    expectedRevision: 1,
    username: 'isolated-reader',
    password: 'isolated-new-secret',
  })
  const rejected = await f.handle(
    f.request(`${base}/${connection.id}/enabled`, { ...command(1), enabled: true }),
  )
  expect(rejected.status).toBe(409)
  expect(((await rejected.json()) as { code: string }).code).toBe('ENVIRONMENT_MCP_TEST_REQUIRED')
  expect((await f.handle(f.request(`${base}/${connection.id}/test`, command(1)))).status).toBe(200)
  const enabled = await f.handle(
    f.request(`${base}/${connection.id}/enabled`, { ...command(1), enabled: true }),
  )
  expect(enabled.status).toBe(200)
  const conflict = await f.handle(
    f.request(`${base}/${connection.id}`, {
      ...command(1),
      value: { ...f.config, name: '过期修改' },
    }),
  )
  expect(conflict.status).toBe(409)
  expect(((await conflict.json()) as { code: string }).code).toBe(
    'ENVIRONMENT_MCP_REVISION_CONFLICT',
  )
  expect(f.owner.list('project', 'test', 'manager')[0]?.configuration.name).toBe('隔离库')
})

it('写入后撤权只确认已保存，恢复角色后原请求读取同一连接', async () => {
  await using f = await setup()
  const original = f.owner.save.bind(f.owner)
  vi.spyOn(f.owner, 'save').mockImplementationOnce((...args) => {
    const value = original(...args)
    f.project.memberships!.find((member) => member.userId === 'manager')!.role = 'reader'
    return value
  })
  const input = { ...command(0), value: f.config }
  const saved = await f.handle(f.request(base, input))
  expect(saved.status).toBe(200)
  expect(await saved.json()).toEqual({ saved: true, available: false })
  f.project.memberships!.find((member) => member.userId === 'manager')!.role = 'project_admin'
  const recovered = await f.handle(f.request(base, input))
  expect(recovered.status).toBe(200)
  const connection = (await recovered.json()) as C.EnvironmentMcpConnection
  expect(f.owner.list('project', 'test', 'manager').map((value) => value.id)).toEqual([
    connection.id,
  ])
})

it('读取返回前注销当前会话拒绝返回已取得的连接配置', async () => {
  await using f = await setup()
  await f.save()
  const original = f.owner.list.bind(f.owner)
  vi.spyOn(f.owner, 'list').mockImplementationOnce((...args) => {
    const value = original(...args)
    f.sessions.prepare('DELETE FROM sessions WHERE uid=?').run('manager')
    return value
  })
  const response = await f.handle(f.request(base))
  expect(response.status).toBe(401)
  const body = JSON.stringify(await response.json())
  expect(body).not.toContain('isolated.invalid')
  expect(body).not.toContain('隔离库')
})

it('连接测试等待期间撤权拒绝迟到成功，原收据可核查且不会自动另测', async () => {
  await using f = await setup()
  const connection = await f.save(),
    started = deferred<void>(),
    release = deferred<void>()
  vi.mocked(f.driver.test).mockImplementationOnce(async () => {
    started.resolve()
    await release.promise
    return { actions: ['mysql.tables'] }
  })
  const input = command(1),
    response = f.handle(f.request(`${base}/${connection.id}/test`, input))
  await started.promise
  f.project.memberships!.find((member) => member.userId === 'manager')!.role = 'reader'
  release.resolve()
  expect((await response).status).toBe(403)
  f.project.memberships!.find((member) => member.userId === 'manager')!.role = 'project_admin'
  const receipt = await f.handle(f.request(`${base}/receipts/${input.requestId}`))
  expect(((await receipt.json()) as { receipt: C.EnvironmentMcpReceipt }).receipt.status).toBe(
    'failed',
  )
  expect((await f.handle(f.request(`${base}/${connection.id}/test`, input))).status).toBe(409)
  expect(f.driver.test).toHaveBeenCalledTimes(1)
})

it('连接断线保留失败原收据和恢复入口，原请求不重连且新测试显式通过', async () => {
  await using f = await setup()
  const connection = await f.save(),
    input = command(1)
  vi.mocked(f.driver.test).mockRejectedValueOnce(new Error('isolated-secret connection lost'))
  const failed = await f.handle(f.request(`${base}/${connection.id}/test`, input))
  expect(failed.status).toBe(502)
  expect(JSON.stringify(await failed.json())).not.toContain('isolated-secret')
  const receipt = await f.handle(f.request(`${base}/receipts/${input.requestId}`))
  expect(((await receipt.json()) as { receipt: C.EnvironmentMcpReceipt }).receipt).toMatchObject({
    status: 'failed',
    error: { code: 'ENVIRONMENT_MCP_CONNECTION_FAILED' },
  })
  expect((await f.handle(f.request(`${base}/${connection.id}/test`, input))).status).toBe(409)
  expect(f.driver.test).toHaveBeenCalledTimes(1)
  expect((await f.handle(f.request(`${base}/${connection.id}/test`, command(1)))).status).toBe(200)
  expect(f.driver.test).toHaveBeenCalledTimes(2)
})

it('正文读取等待期间注销会话，合法正文到达后仍拒绝写入', async () => {
  await using f = await setup()
  const reading = deferred<void>(),
    release = deferred<void>()
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reading.resolve()
        await release.promise
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ ...command(0), value: f.config })),
        )
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const input: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: {
      'x-test-session': 'manager',
      'x-demo-csrf': 'csrf',
      'content-type': 'application/json',
    },
    body: stream,
    duplex: 'half',
  }
  const response = f.handle(new Request(`http://localhost${base}`, input))
  await reading.promise
  f.sessions.prepare('DELETE FROM sessions WHERE uid=?').run('manager')
  release.resolve()
  expect((await response).status).toBe(401)
  expect(f.owner.list('project', 'test', 'manager')).toEqual([])
})

it('已接受测试在最终响应前注销时只确认保存，原测试收据不会泄露或自动重复', async () => {
  await using f = await setup()
  const connection = await f.save(),
    started = deferred<void>(),
    release = deferred<void>()
  vi.mocked(f.driver.test).mockImplementationOnce(async () => {
    started.resolve()
    await release.promise
    return { actions: ['mysql.tables'] }
  })
  const input = command(1),
    pending = f.handle(f.request(`${base}/${connection.id}/test`, input))
  await started.promise
  f.sessions.prepare('DELETE FROM sessions WHERE uid=?').run('manager')
  release.resolve()
  const response = await pending
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ saved: true, available: false })
  expect((await f.handle(f.request(`${base}/receipts/${input.requestId}`))).status).toBe(401)
  f.sessions
    .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
    .run(createHash('sha256').update('manager').digest('hex'), 'manager', 'csrf', 60000)
  const recovered = await f.handle(f.request(`${base}/${connection.id}/test`, input))
  expect(recovered.status).toBe(200)
  expect(((await recovered.json()) as C.EnvironmentMcpTestResult).status).toBe('passed')
  expect(f.driver.test).toHaveBeenCalledTimes(1)
})
