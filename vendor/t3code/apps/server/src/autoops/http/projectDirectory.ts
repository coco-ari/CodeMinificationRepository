import * as ByteSize from 'effect/ByteSize'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { configuredAutoOpsProjectDirectory } from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import { synchronizeProject } from '../projects.ts'
import type { BusinessHttpContext } from './context.ts'
import { responseError } from './responses.ts'

export function projectDirectoryRoutes({ access, principal }: BusinessHttpContext) {
  const handle = (operation: 'list' | 'settings' | 'create' | 'save' | 'environment' | 'member') =>
    Effect.gen(function* () {
      const current = yield* principal
      const request = yield* HttpServerRequest.HttpServerRequest
      const parts = new URL(request.url, 'http://localhost').pathname.split('/')
      const project = yield* Effect.try(() => decodeURIComponent(parts[4] ?? ''))
      const write = !['list', 'settings'].includes(operation)
      const directory = yield* Effect.try(configuredAutoOpsProjectDirectory)
      if (write)
        yield* Effect.try(() => {
          access.requireCsrf(current, request.headers['x-demo-csrf'])
          if (operation !== 'create')
            access.requireProjectAction(
              current,
              project,
              operation === 'member' ? 'project.members.manage' : 'project.manage',
            )
        })
      if (operation === 'list')
        return HttpServerResponse.jsonUnsafe(
          { items: yield* Effect.try(() => directory.list(current.id)) },
          { headers: { 'cache-control': 'private, no-store' } },
        )
      if (operation === 'settings')
        return HttpServerResponse.jsonUnsafe(
          yield* Effect.try(() => directory.settings(current.id, project)),
          { headers: { 'cache-control': 'private, no-store' } },
        )
      const input = yield* request.json.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(64)),
        Effect.mapError(() => ({
          status: 400,
          code: 'PROJECT_INPUT_INVALID',
          message: '配置正文无效或超过大小限制',
        })),
      )
      const value = yield* Effect.try(() => {
        if (operation === 'create') return directory.create(current.id, input)
        if (operation === 'save') return directory.saveProject(current.id, project, input)
        if (operation === 'member') return directory.saveMember(current.id, project, input)
        return directory.saveEnvironment(
          current.id,
          project,
          parts[6] ? decodeURIComponent(parts[6]) : null,
          input,
        )
      })
      // 业务收据先固定；原请求重试可继续完成原生项目登记，不创建第二个业务项目。
      if (operation === 'create' || operation === 'save')
        yield* synchronizeProject(value as { id: string; name: string; revision: number })
      const available = yield* Effect.try(() => {
        access.refresh(current)
        access.requireProjectAction(
          current,
          operation === 'create' ? (value as { id: string }).id : project,
          'project.manage',
        )
        return true
      }).pipe(
        Effect.catch((error) => {
          const status = (error.cause as { status?: number } | undefined)?.status
          return status === 403 || status === 404 ? Effect.succeed(false) : Effect.fail(error)
        }),
      )
      return HttpServerResponse.jsonUnsafe(available ? value : { saved: true, available: false }, {
        headers: { 'cache-control': 'private, no-store' },
      })
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))
  const base = '/api/v1/projects'
  return Layer.mergeAll(
    HttpRouter.add('GET', base, handle('list')),
    HttpRouter.add('POST', base, handle('create')),
    HttpRouter.add('GET', `${base}/:projectId/settings`, handle('settings')),
    HttpRouter.add('POST', `${base}/:projectId/settings`, handle('save')),
    HttpRouter.add('POST', `${base}/:projectId/environments`, handle('environment')),
    HttpRouter.add('POST', `${base}/:projectId/environments/:environmentId`, handle('environment')),
    HttpRouter.add('POST', `${base}/:projectId/members`, handle('member')),
  )
}
