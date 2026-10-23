import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { DatabaseSync } from 'node:sqlite'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter } from 'effect/http'
import { AuthSessionId } from '@t3tools/contracts'
import * as EnvironmentAuth from '../auth/EnvironmentAuth.ts'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import type { WorkspaceStore } from '../../../../../../agent-demo/t3-adapters/workspaces.mjs'
import { createBusinessHttpContext } from './http/context.ts'
import { workspacesRoutes } from './http/workspaces.ts'
import { deploymentsRoutes } from './http/deployments.ts'

const mock = vi.hoisted(() => ({ workspace: undefined as WorkspaceStore | undefined }))
vi.mock('../../../../../../agent-demo/t3-adapters/workspaces.mjs', () => ({ configuredWorkspaceStore: () => mock.workspace }))
vi.mock('../../../../../../agent-demo/t3-adapters/deployments.mjs', () => ({ configuredDeploymentStore: () => undefined }))
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); mock.workspace = undefined })

async function fixture() {
  const sessions = new DatabaseSync(':memory:')
  const bindings = new DatabaseSync(':memory:')
  cleanup.push(() => { sessions.close(); bindings.close() })
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  for (const user of ['u-admin', 'u-guest']) {
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user))).toString('hex')
    sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash, user, 'test-csrf', 60000)
  }
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, now: () => 1000 })
  for (const user of ['u-admin', 'u-guest']) access.recordNativeSession(access.authenticateCookie(`demo_session=${user}`), user)
  const context = createBusinessHttpContext(access)
  const app = HttpRouter.toWebHandler(Layer.mergeAll(workspacesRoutes(context), deploymentsRoutes(context)).pipe(
    Layer.provideMerge(Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
      authenticateHttpRequest: (request: { headers: Record<string, string> }) => Effect.succeed({
        sessionId: AuthSessionId.make(request.headers['x-test-session'] ?? 'missing'), subject: 'test', method: 'bearer-access-token', scopes: [],
      }),
    } as unknown as EnvironmentAuth.EnvironmentAuth['Service'])),
  ), { disableLogger: true })
  cleanup.push(app.dispose)
  const request = (path: string, options: { user?: string; body?: object; csrf?: boolean } = {}) => app.handler(new Request('http://localhost/autoops/projects/p-autoops/' + path, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: { ...(options.user ? { 'x-test-session': options.user } : {}), ...(options.csrf ? { 'x-demo-csrf': 'test-csrf' } : {}), 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }))
  return { request }
}

describe('业务 HTTP 模块边界', () => {
  it('工作区存储故障只影响工作区，发布区仍返回真实停用状态', async () => {
    const { request } = await fixture()
    mock.workspace = { ensureProject: async () => { throw new Error('隔离测试中的存储故障') } } as unknown as WorkspaceStore
    const failed = await request('workspaces', { user: 'u-admin' })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toMatchObject({ error: 'AutoOps 请求未完成' })
    const deployment = await request('deployments', { user: 'u-admin' })
    expect(deployment.status).toBe(200)
    expect(await deployment.json()).toMatchObject({ enabled: false })
  })
  it('独立模块入口仍校验同一原生身份与CSRF，拒绝前不调用业务存储', async () => {
    const { request } = await fixture()
    const initialize = vi.fn()
    mock.workspace = { ensureProject: initialize } as unknown as WorkspaceStore
    expect((await request('workspaces')).status).toBe(401)
    expect((await request('deployments')).status).toBe(401)
    expect((await request('workspaces/packages', { user: 'u-admin', body: {} })).status).toBe(403)
    expect((await request('deployments/tasks', { user: 'u-admin', body: {} })).status).toBe(403)
    expect(initialize).not.toHaveBeenCalled()
  })
})
