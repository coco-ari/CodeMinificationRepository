// @effect-diagnostics nodeBuiltinImport:off -- 使用真实登录、来源目录和临时 SQLite 验证管理事实，不运行客户任务。
import { expect, it, vi } from 'vite-plus/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { HttpRouter } from 'effect/http'
import { AuthSessionId } from '@t3tools/contracts'
import * as EnvironmentAuth from '../../auth/EnvironmentAuth.ts'
import {
  createAssistantDirectory,
  questionConfigurationPolicy,
  type AssistantDirectoryService,
} from '../../../../../../../agent-demo/t3-adapters/assistants/index.ts'
import { createCustomerRegistry } from '../../../../../../../agent-demo/t3-adapters/customer-registry.mjs'
const mock = vi.hoisted(() => ({ directory: undefined as AssistantDirectoryService | undefined }))
vi.mock(import('../../../../../../../agent-demo/t3-adapters/access.mjs'), async (original) => ({
  ...(await original()),
  configuredAutoOpsAssistantDirectory: () => mock.directory!,
}))
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import { createBusinessHttpContext } from './context.ts'
import { assistantsRoutes } from './assistants.ts'
import { providedAssistantsRoutes } from './providedAssistants.ts'

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'provided-assistant-http-')),
    sessions = new DatabaseSync(':memory:'),
    bindings = new DatabaseSync(':memory:')
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  const users = [
    { id: 'provider', name: '普通提供者', role: 'member' },
    { id: 'manager', name: '项目管理者', role: 'member' },
    { id: 'recipient', name: '被分配者', role: 'member' },
  ]
  const projects = ['source-project', 'target-project'].map((id) => ({
    id,
    name: id,
    memberIds: users.map((user) => user.id),
    memberships: users.map((user) => ({
      userId: user.id,
      role: user.id === 'manager' ? ('project_admin' as const) : ('reader' as const),
      status: 'active' as const,
      workspaceAccess: 'internal' as const,
      environmentIds: [],
      canAdjustChat: false,
    })),
    environments: [],
    documents: [],
    resources: [],
  }))
  const agents = [
    {
      id: 'a-project',
      name: '业务助手',
      description: '',
      capabilities: [],
      projectIds: projects.map((project) => project.id),
    },
  ]
  for (const user of users)
    sessions
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(createHash('sha256').update(user.id).digest('hex'), user.id, 'csrf', 60_000)
  let access: ReturnType<typeof createAutoOpsAccess>, directory: AssistantDirectoryService
  const registry = createCustomerRegistry({
    db: bindings,
    enabled: () => true,
    requireOwner(actor) {
      if (!users.some((user) => user.id === actor))
        throw { status: 403, code: 'ACTOR_FORBIDDEN', message: '账号不可用' }
    },
    requireProjectForUser: (actor, project) =>
      access.requireProjectActionForActor(actor, project, 'project.read'),
  })
  access = createAutoOpsAccess({
    sessionDb: sessions,
    bindingDb: bindings,
    catalog: { users, projects, agents },
    customerRegistry: registry,
    now: () => 1000,
    questions: () => directory,
  })
  for (const user of users)
    access.recordNativeSession(access.authenticateCookie(`demo_session=${user.id}`), user.id)
  const paired = registry.consumePairing(registry.createPairing('provider').pairingCode, {
    label: '真实隔离设备',
  })
  const principal = registry.authenticateToken(paired.deviceToken),
    target = {
      kind: 'customer' as const,
      deviceId: paired.device.id,
      registeredWorkspaceId: 'registered-workspace',
      workspaceBindingRevision: 1,
      runtimeId: 'codex' as const,
    }
  registry.registerWorkspace(principal, {
    registeredWorkspaceId: target.registeredWorkspaceId,
    projectId: 'source-project',
    label: '本人登记目录',
    workspaceBindingRevision: 1,
    runtimeId: 'codex',
  })
  registry.markConnected(principal)
  registry.updateCapabilities(principal, {
    registeredWorkspaceId: target.registeredWorkspaceId,
    workspaceBindingRevision: 1,
    runtimeId: 'codex',
    revision: 'real-models',
    protocolVersion: 1,
    assistantConfiguration: true,
    models: [{ id: 'runner-actual', supportedReasoningEfforts: ['high'] }],
    skills: [],
  })
  directory = createAssistantDirectory({
    dataDir,
    membership: (actor, project) => access.requireProjectActionForActor(actor, project, 'chat.use'),
    manage: (actor, project) =>
      access.requireProjectActionForActor(actor, project, 'project.manage'),
    validate: questionConfigurationPolicy({
      projects: () => projects,
      agents: () => agents,
      customers: () => registry,
      models: () => {
        throw new Error('禁止替换成平台能力')
      },
      skills: () => [],
    }),
    validateTarget() {},
    providers: {
      registry: () => registry,
      displayName: (actor) => users.find((user) => user.id === actor)?.name ?? '不可用提供者',
    },
  })
  mock.directory = directory
  const context = createBusinessHttpContext(access)
  const app = HttpRouter.toWebHandler(
    Layer.mergeAll(assistantsRoutes(context), providedAssistantsRoutes(context)).pipe(
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
    path = '/api/v1/assistants/provided',
    body?: unknown,
    user = 'provider',
    csrf = true,
  ) =>
    new Request(`http://localhost${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-test-session': user,
        ...(csrf ? { 'x-demo-csrf': 'csrf' } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const value = {
    name: '本人运行助手',
    description: '',
    instructions: '真实预设',
    enabled: true,
    configuration: {
      agentId: 'a-project',
      executionBinding: target,
      environmentId: null,
      workspaceType: null,
      visibility: 'private',
      model: {
        instanceId: `customer-${target.deviceId}-codex`,
        model: 'runner-actual',
        reasoningEffort: 'high',
      },
      skillIds: [],
    },
  }
  return {
    access,
    sessions,
    projects,
    directory,
    registry,
    target,
    value,
    request,
    handle: app.handler,
    async [Symbol.asyncDispose]() {
      await app.dispose()
      directory.close()
      sessions.close()
      bindings.close()
      rmSync(dataDir, { recursive: true, force: true })
      mock.directory = undefined
    },
  }
}
const command = (value: unknown) => ({ requestId: 'create-provided', expectedRevision: 0, value })

it('普通成员创建本人助手，主动共享到另一真实项目后管理者才能分配，仍不开放跨用户执行', async () => {
  await using f = setup()
  const created = await f.handle(f.request(undefined, command(f.value))),
    preset = (await created.json()) as { id: string }
  expect(created.status).toBe(200)
  expect(await (await f.handle(f.request())).json()).toMatchObject({
    items: [
      {
        preset: {
          id: preset.id,
          providedBy: { id: 'provider', sourceProjectId: 'source-project' },
        },
      },
    ],
    sources: [{ capabilities: { models: [{ id: 'runner-actual' }] } }],
  })
  const project = '/api/v1/projects/target-project'
  const allocate = {
    requestId: 'allocation',
    expectedRevision: 0,
    target: { kind: 'member', id: 'recipient' },
    assistantIds: [preset.id],
    defaultAssistantId: null,
  }
  expect(
    (await f.handle(f.request(`${project}/assistant-allocations`, allocate, 'manager'))).status,
  ).toBe(403)
  const sharePath = `/api/v1/assistants/provided/${preset.id}/shares/target-project`
  const share = { requestId: 'share-project', expectedRevision: 0, enabled: true }
  expect((await f.handle(f.request(sharePath, share))).status).toBe(200)
  expect(
    (await f.handle(f.request(`${project}/assistant-allocations`, allocate, 'manager'))).status,
  ).toBe(200)
  expect(
    await (
      await f.handle(f.request(`${project}/assistants/provided`, undefined, 'manager'))
    ).json(),
  ).toMatchObject({
    items: [
      {
        available: false,
        reason: { code: 'CUSTOMER_SHARED_ISOLATION_UNVERIFIED' },
        source: { sourceProjectId: 'source-project' },
      },
    ],
  })
  expect(
    await (await f.handle(f.request(`${project}/assistants`, undefined, 'recipient'))).json(),
  ).toMatchObject({ ready: false, items: [{ available: false }] })
  expect(f.registry.listWorkspaces('provider')[0]?.projectId).toBe('source-project')
})

it('身份、CSRF及本人所有权在消费正文前拒绝，管理员不能代提供者共享或修改预设', async () => {
  await using f = setup()
  const preset = f.directory.saveProvided('provider', null, command(f.value))
  const base = `/api/v1/assistants/provided/${preset.id}`
  for (const request of [
    f.request(base, command(f.value), 'provider', false),
    f.request(base, command(f.value), 'manager'),
    f.request(
      `${base}/shares/target-project`,
      { requestId: 'forge', expectedRevision: 0, enabled: true },
      'manager',
    ),
  ]) {
    expect([403, 404]).toContain((await f.handle(request)).status)
    expect(request.bodyUsed).toBe(false)
  }
  expect((await f.handle(f.request(undefined, undefined, 'missing'))).status).toBe(401)
  expect(
    (
      await f.handle(
        f.request('/api/v1/projects/target-project/assistants/provided', undefined, 'recipient'),
      )
    ).status,
  ).toBe(403)
  expect(
    (await f.handle(f.request(undefined, { ...command(f.value), providerId: 'manager' }))).status,
  ).toBe(400)
})

it('共享目标和修订受真实项目身份约束，原请求可恢复，撤回后不靠旧分配重新开启', async () => {
  await using f = setup()
  const preset = f.directory.saveProvided('provider', null, command(f.value))
  const base = `/api/v1/assistants/provided/${preset.id}/shares/`
  const share = { requestId: 'share', expectedRevision: 0, enabled: true }
  expect((await f.handle(f.request(base + 'hidden-project', share))).status).toBe(404)
  const accepted = await (await f.handle(f.request(base + 'target-project', share))).json()
  expect(await (await f.handle(f.request(base + 'target-project', share))).json()).toEqual(accepted)
  expect(
    (
      await f.handle(
        f.request(base + 'target-project', {
          requestId: 'stale',
          expectedRevision: 0,
          enabled: false,
        }),
      )
    ).status,
  ).toBe(409)
  const revoke = { requestId: 'revoke', expectedRevision: 1, enabled: false }
  expect(await (await f.handle(f.request(base + 'target-project', revoke))).json()).toMatchObject({
    enabled: false,
    revision: 2,
  })
  expect(
    await (
      await f.handle(
        f.request('/api/v1/projects/target-project/assistants/provided', undefined, 'manager'),
      )
    ).json(),
  ).toEqual({ items: [] })
  const encoded = JSON.stringify(await (await f.handle(f.request())).json())
  expect(encoded).not.toContain('tokenHash')
  expect(encoded).not.toContain('deviceToken')
})

it('只读收据按当前本人及provider操作隔离，读取未知ID不构造新操作或泄露其他人的结果', async () => {
  await using f = setup()
  const preset = f.directory.saveProvided('provider', null, command(f.value))
  const receipt = '/api/v1/assistants/provided/receipts/create-provided'
  expect(await (await f.handle(f.request(receipt))).json()).toMatchObject({
    requestId: 'create-provided',
    operation: 'provider.preset.save:new',
    projectId: 'source-project',
    payload: command(f.value),
    result: { id: preset.id },
  })
  expect((await f.handle(f.request(receipt, undefined, 'manager'))).status).toBe(404)
  expect(
    (await f.handle(f.request('/api/v1/assistants/provided/receipts/never-accepted'))).status,
  ).toBe(404)
  f.directory.assign('manager', 'source-project', {
    requestId: 'project-only-operation',
    expectedRevision: 0,
    target: { kind: 'member', id: 'recipient' },
    assistantIds: [],
    defaultAssistantId: null,
  })
  expect(
    (
      await f.handle(
        f.request(
          '/api/v1/assistants/provided/receipts/project-only-operation',
          undefined,
          'manager',
        ),
      )
    ).status,
  ).toBe(404)
  expect(f.directory.providedSettings('provider').items).toHaveLength(1)
})


it('提供者保存从真实正文流限制大小，拒绝后不产生预设或原请求收据', async () => {
  await using f = setup()
  const original = f.request(undefined, command(f.value))
  const request = new Request(original.url, {
    method: 'POST', headers: original.headers,
    body: JSON.stringify(command(f.value)) + ' '.repeat(64 * 1024),
  })
  const response = await f.handle(request)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: 'ASSISTANT_INPUT_INVALID' })
  expect(f.directory.providedSettings('provider').items).toHaveLength(0)
  expect((await f.handle(f.request('/api/v1/assistants/provided/receipts/create-provided'))).status).toBe(404)
})


it('提供者目录读取返回前注销会话，不返回刚取得的预设和设备目录', async () => {
  await using f = setup()
  f.directory.saveProvided('provider', null, command(f.value))
  const original = f.directory.providedSettings.bind(f.directory)
  vi.spyOn(f.directory, 'providedSettings').mockImplementationOnce((...args) => {
    const value = original(...args)
    f.sessions.prepare('DELETE FROM sessions WHERE uid=?').run('provider')
    return value
  })
  const response = await f.handle(f.request())
  expect(response.status).toBe(401)
  expect(JSON.stringify(await response.json())).not.toContain('本人运行助手')
})

it('提供者写入后注销只确认已保存，原会话不能取得预设或继续读收据', async () => {
  await using f = setup()
  const original = f.directory.saveProvided.bind(f.directory)
  vi.spyOn(f.directory, 'saveProvided').mockImplementationOnce((...args) => {
    const value = original(...args)
    f.sessions.prepare('DELETE FROM sessions WHERE uid=?').run('provider')
    return value
  })
  const response = await f.handle(f.request(undefined, command(f.value)))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ saved: true, available: false })
  expect((await f.handle(f.request('/api/v1/assistants/provided/receipts/create-provided'))).status).toBe(401)
  f.sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('provider').digest('hex'), 'provider', 'csrf', 60000)
  expect(await (await f.handle(f.request('/api/v1/assistants/provided/receipts/create-provided'))).json()).toMatchObject({ requestId: 'create-provided', result: { name: f.value.name } })
  expect(f.directory.providedSettings('provider').items).toHaveLength(1)
})

it('提供者正文等待期间注销，正文到达后拒绝保存且不建立收据', async () => {
  await using f = setup()
  let started!: () => void, release!: () => void
  const reading = new Promise<void>(resolve => { started = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    started()
    await waiting
    controller.enqueue(new TextEncoder().encode(JSON.stringify(command(f.value))))
    controller.close()
  } }, { highWaterMark: 0 })
  const original = f.request(undefined, command(f.value))
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers: original.headers, body, duplex: 'half' }
  const pending = f.handle(new Request(original.url, init))
  await reading
  f.sessions.prepare('DELETE FROM sessions WHERE uid=?').run('provider')
  release()
  expect((await pending).status).toBe(401)
  expect(f.directory.providedSettings('provider').items).toHaveLength(0)
})


it('项目获共享目录读取后撤回管理权，不能返回已经取得的来源', async () => {
  await using f = setup()
  const preset = f.directory.saveProvided('provider', null, command(f.value))
  f.directory.shareProvided('provider', preset.id, 'target-project', { requestId: 'share-read', expectedRevision: 0, enabled: true })
  const original = f.directory.providedForProject.bind(f.directory)
  vi.spyOn(f.directory, 'providedForProject').mockImplementationOnce((...args) => {
    const result = original(...args)
    f.projects.find(project => project.id === 'target-project')!.memberships.find(member => member.userId === 'manager')!.role = 'reader'
    return result
  })
  const response = await f.handle(f.request('/api/v1/projects/target-project/assistants/provided', undefined, 'manager'))
  expect(response.status).toBe(403)
  expect(JSON.stringify(await response.json())).not.toContain('真实隔离设备')
})
