import * as SqlitePersistence from '../../persistence/Sqlite.ts'
import * as ThreadManagement from '../../orchestration-v2/ThreadManagementService.ts'
// @effect-diagnostics nodeBuiltinImport:off -- 使用真实隔离 SQLite 与原生 HTTP，测试身份只替换认证传输。
import { expect, it } from 'vite-plus/test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter } from 'effect/http'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { AuthSessionId } from '@t3tools/contracts'
import * as EnvironmentAuth from '../../auth/EnvironmentAuth.ts'
import { createRuntimeAccounts } from '../../../../../../../agent-demo/t3-adapters/accounts/index.ts'
import type { RuntimeAccounts } from '../../../../../../../agent-demo/t3-adapters/accounts/index.ts'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import { createBusinessHttpContext } from './context.ts'
import { accountsRoutes } from './accounts.ts'
import type {
  RuntimeAccount,
  AccountReceipt,
  AccountPasswordResult,
} from '../../../../../../../autoops/contracts/accounts.ts'

const password = '隔离HTTP账号密码20261026'
async function setup(wrap: (owner: RuntimeAccounts) => RuntimeAccounts = (owner) => owner) {
  const data = mkdtempSync(join(tmpdir(), 'accounts-http-'))
  const owner = createRuntimeAccounts({ databasePath: join(data, 'demo.sqlite') })
  const admin = await owner.initialize({
    username: 'http.admin',
    name: '平台管理员',
    password,
    kind: 'internal',
    platformAdmin: true,
  })
  const reader = await owner.create(admin.id, {
    requestId: randomUUID(),
    value: {
      username: 'http.reader',
      name: '只读成员',
      password,
      kind: 'internal',
      platformAdmin: false,
    },
  })
  const sessions = new DatabaseSync(join(data, 'demo.sqlite'), { readOnly: true }),
    bindings = new DatabaseSync(':memory:')
  initializeAutoOpsAccessSchema(bindings)
  const access = createAutoOpsAccess({
    sessionDb: sessions,
    bindingDb: bindings,
    catalog: {
      get users() {
        return owner.users()
      },
      projects: [],
      agents: [],
    },
  })
  const native = new Map<string, { csrf: string; sessionId: string }>()
  for (const user of [admin, reader]) {
    const login = await owner.login({ username: user.username, password })
    const principal = access.authenticateCookie(`demo_session=${login.token}`)
    access.recordNativeSession(principal, user.id)
    native.set(user.id, { csrf: login.csrf, sessionId: user.id })
  }
  const facade = wrap(owner)
  const app = HttpRouter.toWebHandler(
    accountsRoutes(createBusinessHttpContext(access), () => facade).pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          SqlitePersistence.layerMemory,
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] } as never),
            dispatch: () => Effect.succeed({} as never),
          }),
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
    body?: unknown,
    actor: string = admin.id,
    method?: string,
    csrf = true,
  ) =>
    new Request(`http://localhost${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        'x-test-session': actor,
        ...(csrf ? { 'x-demo-csrf': native.get(actor)?.csrf ?? '' } : {}),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
  return {
    owner,
    access,
    admin,
    reader,
    request,
    handle: app.handler,
    native,
    async [Symbol.asyncDispose]() {
      await app.dispose()
      bindings.close()
      sessions.close()
      await owner.close()
      rmSync(data, { recursive: true, force: true })
    },
  }
}

it('真实HTTP平台创建、原收据与重复提交同一账号，普通成员只能读本人，伪造管理参数不能越权', async () => {
  await using f = await setup()
  expect((await f.handle(f.request('/api/v1/accounts', undefined, f.reader.id))).status).toBe(403)
  const own = await f.handle(f.request('/api/v1/account', undefined, f.reader.id))
  expect(((await own.json()) as { account: RuntimeAccount }).account.id).toBe(f.reader.id)
  const input = {
    requestId: randomUUID(),
    value: {
      username: 'http.created',
      name: '新成员',
      password,
      kind: 'internal',
      platformAdmin: false,
    },
  }
  const response = await f.handle(f.request('/api/v1/accounts', input))
  expect(response.status).toBe(200)
  const created = (await response.json()) as RuntimeAccount
  expect(created.username).toBe(input.value.username)
  const original = await f.handle(f.request(`/api/v1/accounts/receipts/${input.requestId}`))
  expect(((await original.json()) as AccountReceipt).result).toEqual(created)
  expect(await (await f.handle(f.request('/api/v1/accounts', input))).json()).toEqual(created)
  const denied = await f.handle(
    f.request('/api/v1/accounts', { ...input, actorId: f.admin.id }, f.reader.id),
  )
  expect(denied.status).toBe(403)
  const otherReceipt = await f.handle(
    f.request(`/api/v1/accounts/receipts/${input.requestId}`, undefined, f.reader.id),
  )
  expect(await otherReceipt.json()).toBeNull()
})

it('CSRF、超限流正文及修订冲突保留账号事实，非管理员不能停用或重置他人', async () => {
  await using f = await setup()
  const enable = { requestId: randomUUID(), expectedRevision: 1, value: { enabled: false } }
  expect(
    (await f.handle(f.request(`/api/v1/accounts/${f.reader.id}`, enable, f.admin.id, 'PUT', false)))
      .status,
  ).toBe(403)
  expect(
    (await f.handle(f.request(`/api/v1/accounts/${f.admin.id}`, enable, f.reader.id, 'PUT')))
      .status,
  ).toBe(403)
  expect(
    (
      await f.handle(
        f.request(
          `/api/v1/accounts/${f.admin.id}/password`,
          { requestId: randomUUID(), expectedRevision: 1, value: { newPassword: password } },
          f.reader.id,
          'PUT',
        ),
      )
    ).status,
  ).toBe(403)
  expect((await f.handle(f.request('/api/v1/accounts', '{}' + ' '.repeat(17000)))).status).toBe(400)
  expect(
    (
      await f.handle(
        f.request(
          `/api/v1/accounts/${f.reader.id}`,
          { ...enable, expectedRevision: 99 },
          f.admin.id,
          'PUT',
        ),
      )
    ).status,
  ).toBe(409)
  expect(f.owner.active(f.reader.id).revision).toBe(1)
})

it('本人改密确定返回成功且立即撤销原生会话，正常新登录后GET原收据不重跑', async () => {
  await using f = await setup()
  const input = {
    requestId: randomUUID(),
    expectedRevision: 1,
    value: { currentPassword: password, newPassword: password + '-next' },
  }
  const changed = await f.handle(f.request('/api/v1/account/password', input, f.reader.id, 'PUT'))
  expect(changed.status).toBe(200)
  const saved = (await changed.json()) as AccountPasswordResult
  expect(saved).toEqual({ userId: f.reader.id, revision: 2, sessionsRevoked: true, loginPath: '/' })
  expect((await f.handle(f.request('/api/v1/account', undefined, f.reader.id))).status).toBe(401)
  const login = await f.owner.login({ username: f.reader.username, password: password + '-next' })
  const principal = f.access.authenticateCookie(`demo_session=${login.token}`)
  f.access.recordNativeSession(principal, f.reader.id)
  f.native.set(f.reader.id, { csrf: login.csrf, sessionId: f.reader.id })
  const receipt = await f.handle(
    f.request(`/api/v1/accounts/receipts/${input.requestId}`, undefined, f.reader.id),
  )
  expect(receipt.status).toBe(200)
  expect(((await receipt.json()) as AccountReceipt).result).toEqual(saved)
  expect(f.owner.active(f.reader.id).revision).toBe(2)
})

it('平台停用撤销真实旧session与后台授权，启用不恢复原cookie', async () => {
  await using f = await setup()
  const input = { requestId: randomUUID(), expectedRevision: 1, value: { enabled: false } }
  const disabled = await f.handle(
    f.request(`/api/v1/accounts/${f.reader.id}`, input, f.admin.id, 'PUT'),
  )
  expect(disabled.status).toBe(200)
  expect(f.owner.users().find((item) => item.id === f.reader.id)?.status).toBe('disabled')
  expect((await f.handle(f.request('/api/v1/account', undefined, f.reader.id))).status).toBe(401)
  expect(
    (
      await f.handle(
        f.request(
          `/api/v1/accounts/${f.reader.id}`,
          { requestId: randomUUID(), expectedRevision: 2, value: { enabled: true } },
          f.admin.id,
          'PUT',
        ),
      )
    ).status,
  ).toBe(200)
  expect((await f.handle(f.request('/api/v1/account', undefined, f.reader.id))).status).toBe(401)
})

it('既有密码派生并发保护通过原生HTTP返回429，不暴露秘密或伪装500', async () => {
  await using f = await setup()
  const results = await Promise.all(
    Array.from({ length: 9 }, async (_, index) => {
      const response = await f.handle(
        f.request('/api/v1/accounts', {
          requestId: randomUUID(),
          value: {
            username: 'concurrent.' + index,
            name: '并发成员',
            password,
            kind: 'internal',
            platformAdmin: false,
          },
        }),
      )
      return { status: response.status, body: (await response.json()) as { code?: string } }
    }),
  )
  expect(results.some((value) => value.status === 429 && value.body.code === 'RATE_LIMITED')).toBe(
    true,
  )
  expect(results.every((value) => value.status === 200 || value.status === 429)).toBe(true)
})

it('真实密码派生期间停用原调用者，HTTP不能在原会话失效后创建新账号', async () => {
  const entered = Promise.withResolvers<void>()
  await using f = await setup((owner) => ({
    ...owner,
    create(...args) {
      const work = owner.create(...args)
      entered.resolve()
      return work
    },
  }))
  const other = await f.owner.create(f.admin.id, {
    requestId: randomUUID(),
    value: {
      username: 'other.admin',
      name: '另一管理员',
      password,
      kind: 'internal',
      platformAdmin: true,
    },
  })
  const requestId = randomUUID()
  const pending = f.handle(
    f.request('/api/v1/accounts', {
      requestId,
      value: {
        username: 'late.created',
        name: '迟到创建',
        password,
        kind: 'internal',
        platformAdmin: false,
      },
    }),
  )
  await entered.promise
  f.owner.setEnabled(other.id, f.admin.id, {
    requestId: randomUUID(),
    expectedRevision: 1,
    value: { enabled: false },
  })
  expect((await pending).status).toBe(401)
  expect(f.owner.list(other.id).items.some((item) => item.username === 'late.created')).toBe(false)
})

it('仅注销原会话而账号仍有效时，派生后的当前session守卫仍阻止迟到写入', async () => {
  const entered = Promise.withResolvers<void>()
  await using f = await setup((owner) => ({
    ...owner,
    create(...args) {
      const work = owner.create(...args)
      entered.resolve()
      return work
    },
  }))
  const original = f.access.principalForNativeSession(f.admin.id)
  const requestId = randomUUID()
  const pending = f.handle(
    f.request('/api/v1/accounts', {
      requestId,
      value: {
        username: 'session.revoked',
        name: '会话已撤销',
        password,
        kind: 'internal',
        platformAdmin: false,
      },
    }),
  )
  await entered.promise
  f.owner.logout(original.sessionHash)
  expect(f.owner.active(f.admin.id).enabled).toBe(true)
  expect((await pending).status).toBe(401)
  expect(f.owner.list(f.admin.id).items.some((item) => item.username === 'session.revoked')).toBe(
    false,
  )
  expect(f.owner.receipt(f.admin.id, requestId)).toBeNull()
})

it('停用操作进入owner前仅注销调用者会话，HTTP必须将当前session守卫带入事务', async () => {
  let revoke: (() => void) | undefined
  await using f = await setup((owner) => ({
    ...owner,
    setEnabled(...args) {
      revoke?.()
      return owner.setEnabled(...args)
    },
  }))
  const original = f.access.principalForNativeSession(f.admin.id)
  revoke = () => f.owner.logout(original.sessionHash)
  const requestId = randomUUID()
  const result = await f.handle(
    f.request(
      `/api/v1/accounts/${f.reader.id}`,
      {
        requestId,
        expectedRevision: 1,
        value: { enabled: false },
      },
      f.admin.id,
      'PUT',
    ),
  )
  expect(result.status).toBe(401)
  expect(f.owner.active(f.admin.id).enabled).toBe(true)
  expect(f.owner.active(f.reader.id).revision).toBe(1)
  expect(f.owner.receipt(f.admin.id, requestId)).toBeNull()
})

it('账号已提交再撤销会话准确返回saved，恢复后只GET原收据取得同一结果', async () => {
  let afterSave: (() => void) | undefined
  await using f = await setup((owner) => ({
    ...owner,
    async create(...args) {
      const result = await owner.create(...args)
      afterSave?.()
      return result
    },
  }))
  const other = await f.owner.create(f.admin.id, {
    requestId: randomUUID(),
    value: {
      username: 'recovery.admin',
      name: '恢复管理员',
      password,
      kind: 'internal',
      platformAdmin: true,
    },
  })
  afterSave = () => {
    f.owner.setEnabled(other.id, f.admin.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
      value: { enabled: false },
    })
  }
  const requestId = randomUUID()
  const saved = await f.handle(
    f.request('/api/v1/accounts', {
      requestId,
      value: {
        username: 'saved.created',
        name: '已保存成员',
        password,
        kind: 'internal',
        platformAdmin: false,
      },
    }),
  )
  expect(saved.status).toBe(200)
  expect(await saved.json()).toEqual({ saved: true, available: false })
  const accounts = f.owner.list(other.id).items.filter((item) => item.username === 'saved.created')
  expect(accounts).toHaveLength(1)
  f.owner.setEnabled(other.id, f.admin.id, {
    requestId: randomUUID(),
    expectedRevision: 2,
    value: { enabled: true },
  })
  const login = await f.owner.login({ username: f.admin.username, password })
  f.access.recordNativeSession(
    f.access.authenticateCookie(`demo_session=${login.token}`),
    f.admin.id,
  )
  f.native.set(f.admin.id, { csrf: login.csrf, sessionId: f.admin.id })
  const restored = await f.handle(f.request(`/api/v1/accounts/receipts/${requestId}`))
  expect(restored.status).toBe(200)
  expect(((await restored.json()) as AccountReceipt).result).toEqual(accounts[0])
  expect(
    f.owner.list(other.id).items.filter((item) => item.username === 'saved.created'),
  ).toHaveLength(1)
})
