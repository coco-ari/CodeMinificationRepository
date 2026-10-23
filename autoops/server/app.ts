import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import * as C from '../contracts/index.ts'
import { AppError, decode, requireCondition as must } from './platform/errors.ts'
import { openDatabase } from './platform/database.ts'
import type { Authorization, Runtime } from './platform/ports.ts'
import { createIdentity, migration as identityMigration } from './modules/identity/index.ts'
import { createProjects, migration as projectMigration } from './modules/projects/index.ts'
import { createAccess, migration as accessMigration } from './modules/access/index.ts'
import { createAudit, migration as auditMigration } from './modules/audit/index.ts'

export interface Options {
  readonly databaseFile: string
  readonly publicOrigin: string
  readonly secureCookie: boolean
  readonly runtime?: Runtime
  readonly log?: (event: { event: string; requestId: string; code: C.ErrorCode }) => void
}
type Env = { Variables: { userId: string; requestId: string } }
export const migrations = [identityMigration, projectMigration, accessMigration, auditMigration]
export function createAutoOps(options: Options) {
  const runtime = options.runtime ?? { now: () => Date.now(), id: randomUUID }
  const storage = openDatabase(options.databaseFile, migrations)
  // 组合根注入模块端口，服务执行时解析授权，业务模块无需循环导入。
  const authorization: Authorization = {
    require: (...args) => access.require(...args),
    allows: (...args) => access.allows(...args),
    environmentScope: (...args) => access.environmentScope(...args),
  }
  const audit = createAudit(storage.db, runtime, authorization)
  const identity = createIdentity(
    storage.db,
    storage.transaction,
    audit.writer,
    runtime,
    authorization,
  )
  const projectModule = createProjects(
    storage.db,
    authorization,
    {
      initializeProject: (...args) => access.initializeProject(...args),
      removeMemberAccess: (...args) => access.removeMemberAccess(...args),
    },
    identity,
    storage.transaction,
    audit.writer,
    runtime,
  )
  const access = createAccess(
    storage.db,
    identity,
    projectModule.directory,
    storage.transaction,
    audit.writer,
    runtime,
  )
  const projects = projectModule.service
  const app = new Hono<Env>()
  app.use('*', requestId(), secureHeaders())
  app.use(
    '/api/v1/*',
    bodyLimit({
      maxSize: 32 * 1024,
      onError: () => {
        throw new AppError('INVALID_INPUT', '请求内容过大')
      },
    }),
  )
  app.use('/api/v1/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
    if (mutation)
      must(c.req.header('Origin') === options.publicOrigin, 'FORBIDDEN', '请求来源校验失败')
    if (c.req.path !== '/api/v1/login') {
      const user = identity.authenticate(
        getCookie(c, 'autoops_session'),
        mutation ? (c.req.header('X-CSRF-Token') ?? '') : undefined,
      )
      c.set('userId', user.id)
    }
    await next()
  })
  app.onError((error, c) => {
    const conflict =
      'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 255) === 19
    const safe =
      error instanceof AppError
        ? error
        : conflict
          ? new AppError('CONFLICT', '数据冲突，请刷新后重试')
          : new AppError('INTERNAL_ERROR', '服务暂时无法处理请求')
    const id = c.get('requestId')
    options.log?.({ event: 'request.failed', requestId: id, code: safe.code })
    return c.json({ error: { code: safe.code, message: safe.message, requestId: id } }, safe.status)
  })
  app.notFound((c) =>
    c.json(
      { error: { code: 'NOT_FOUND', message: '接口不存在', requestId: c.get('requestId') } },
      404,
    ),
  )
  app.get('/health/live', (c) => c.json({ status: 'ok' }))
  app.get('/health/ready', (c) => {
    storage.db.prepare('SELECT 1').get()
    return c.json({ status: 'ready' })
  })
  const body = async (c: Context<Env>): Promise<unknown> => {
    must(
      c.req.header('Content-Type')?.split(';')[0]?.trim() === 'application/json',
      'INVALID_INPUT',
      '请求必须使用 JSON',
    )
    try {
      return await c.req.json<unknown>()
    } catch {
      throw new AppError('INVALID_INPUT', 'JSON 格式无效')
    }
  }
  const id = (c: Context<Env>, key: string) => decode(C.Id, c.req.param(key))
  const actor = (c: Context<Env>) => c.get('userId')
  const command = (c: Context<Env>) => decode(C.Id, c.req.header('Idempotency-Key'))
  const cookie = {
    httpOnly: true,
    secure: options.secureCookie,
    sameSite: 'Strict' as const,
    path: '/api/v1',
  }
  app.post('/api/v1/login', async (c) => {
    const session = await identity.login(await body(c))
    setCookie(c, 'autoops_session', session.token, {
      ...cookie,
      expires: new Date(session.expiresAt),
    })
    return c.json({
      user: session.user,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    })
  })
  app.get('/api/v1/session', (c) => c.json(identity.sessionInfo(getCookie(c, 'autoops_session')!)))
  app.post('/api/v1/logout', (c) => {
    identity.logout(actor(c), getCookie(c, 'autoops_session')!)
    deleteCookie(c, 'autoops_session', cookie)
    return c.body(null, 204)
  })
  app.get('/api/v1/accounts', (c) => c.json(identity.list(actor(c), c.req.query('after') ?? '')))
  app.post('/api/v1/accounts', async (c) =>
    c.json(await identity.create(actor(c), await body(c)), 201),
  )
  app.patch('/api/v1/accounts/:userId', async (c) =>
    c.json(identity.setEnabled(actor(c), id(c, 'userId'), await body(c))),
  )
  app.put('/api/v1/accounts/:userId/password', async (c) => {
    await identity.resetPassword(actor(c), id(c, 'userId'), await body(c))
    return c.body(null, 204)
  })
  app.put('/api/v1/session/password', async (c) => {
    await identity.changePassword(actor(c), await body(c))
    deleteCookie(c, 'autoops_session', cookie)
    return c.body(null, 204)
  })
  app.get('/api/v1/projects', (c) => c.json(projects.list(actor(c), c.req.query('after') ?? '')))
  app.post('/api/v1/projects', async (c) =>
    c.json(projects.create(actor(c), await body(c), command(c)), 201),
  )
  app.get('/api/v1/projects/:projectId', (c) => c.json(projects.get(actor(c), id(c, 'projectId'))))
  app.get('/api/v1/projects/:projectId/environments', (c) =>
    c.json(projects.environments(actor(c), id(c, 'projectId'), c.req.query('after') ?? '')),
  )
  app.post('/api/v1/projects/:projectId/environments', async (c) =>
    c.json(projects.addEnvironment(actor(c), id(c, 'projectId'), await body(c), command(c)), 201),
  )
  app.get('/api/v1/projects/:projectId/members', (c) =>
    c.json(projects.members(actor(c), id(c, 'projectId'), c.req.query('after') ?? '')),
  )
  app.post('/api/v1/projects/:projectId/members', async (c) => {
    projects.addMember(actor(c), id(c, 'projectId'), await body(c))
    return c.body(null, 204)
  })
  app.delete('/api/v1/projects/:projectId/members/:userId', (c) => {
    projects.removeMember(actor(c), id(c, 'projectId'), id(c, 'userId'))
    return c.body(null, 204)
  })
  app.get('/api/v1/projects/:projectId/grants', (c) =>
    c.json(access.list(actor(c), id(c, 'projectId'), c.req.query('after') ?? '')),
  )
  app.post('/api/v1/projects/:projectId/grants', async (c) =>
    c.json(access.assign(actor(c), id(c, 'projectId'), await body(c)), 201),
  )
  app.delete('/api/v1/projects/:projectId/grants/:grantId', (c) => {
    access.revoke(actor(c), id(c, 'projectId'), id(c, 'grantId'))
    return c.body(null, 204)
  })
  app.get('/api/v1/projects/:projectId/capabilities', (c) => {
    const projectId = id(c, 'projectId'),
      rawEnvironment = c.req.query('environmentId')
    const resource =
      rawEnvironment === undefined
        ? { projectId }
        : { projectId, environmentId: decode(C.Id, rawEnvironment) }
    access.require(actor(c), 'project.read', { projectId })
    return c.json({ actions: access.capabilities(actor(c), resource) })
  })
  app.get('/api/v1/projects/:projectId/audit', (c) =>
    c.json(audit.list(actor(c), id(c, 'projectId'), c.req.query('after') ?? '')),
  )
  return { app, identity, projects, access, audit, close: storage.close }
}
