import * as ByteSize from 'effect/ByteSize'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { configuredAutoOpsAssistantDirectory } from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import type { BusinessHttpContext } from './context.ts'
import { responseError } from './responses.ts'

export function assistantsRoutes({ access, principal }: BusinessHttpContext) {
  const handle = (
    operation:
      'list' | 'settings' | 'create' | 'save' | 'assign' | 'choices' | 'receipt' | 'delete',
  ) =>
    Effect.gen(function* () {
      const current = yield* principal
      const request = yield* HttpServerRequest.HttpServerRequest
      const parts = new URL(request.url, 'http://localhost').pathname.split('/')
      const project = yield* Effect.try(() => decodeURIComponent(parts[4] ?? ''))
      const directory = yield* Effect.try(configuredAutoOpsAssistantDirectory)
      if (operation === 'receipt') {
        const requestId = yield* Effect.try(() => decodeURIComponent(parts[7] ?? ''))
        yield* Effect.try(() => {
          access.refresh(current)
          return directory.projectReceipt(current.id, project, requestId)
        })
        const value = yield* Effect.try(() => {
          access.refresh(current)
          return directory.projectReceipt(current.id, project, requestId)
        })
        return HttpServerResponse.jsonUnsafe(value, {
          headers: { 'cache-control': 'private, no-store' },
        })
      }
      if (operation === 'list' || operation === 'settings' || operation === 'choices') {
        const value = yield* Effect.try(() =>
          operation === 'list'
            ? directory.catalog(current.id, project)
            : operation === 'choices'
              ? directory.choices(current.id, project)
              : directory.settings(current.id, project),
        )
        return HttpServerResponse.jsonUnsafe(value, {
          headers: { 'cache-control': 'private, no-store' },
        })
      }
      yield* Effect.try(() => {
        access.requireCsrf(current, request.headers['x-demo-csrf'])
        access.requireProjectAction(current, project, 'project.manage')
      })
      const input = yield* request.json.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(64)),
        Effect.mapError(() => ({
          status: 400,
          code: 'ASSISTANT_INPUT_INVALID',
          message: '助手配置正文无效或超过大小限制',
        })),
      )
      const value = yield* Effect.try(() =>
        operation === 'delete'
          ? directory.remove(current.id, project, decodeURIComponent(parts[6] ?? ''), input)
          : operation === 'assign'
          ? directory.assign(current.id, project, input)
          : directory.save(
              current.id,
              project,
              operation === 'create' ? null : decodeURIComponent(parts[6] ?? ''),
              input,
            ),
      )
      const available = yield* Effect.try(() => {
        access.requireProjectAction(current, project, 'project.manage')
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
  const base = '/api/v1/projects/:projectId'
  return Layer.mergeAll(
    HttpRouter.add('GET', `${base}/assistants`, handle('list')),
    HttpRouter.add('GET', `${base}/assistants/receipts/:requestId`, handle('receipt')),
    HttpRouter.add('GET', `${base}/assistants/settings`, handle('settings')),
    HttpRouter.add('GET', `${base}/assistants/choices`, handle('choices')),
    HttpRouter.add('POST', `${base}/assistants`, handle('create')),
    HttpRouter.add('POST', `${base}/assistants/:assistantId`, handle('save')),
    HttpRouter.add('DELETE', `${base}/assistants/:assistantId`, handle('delete')),
    HttpRouter.add('POST', `${base}/assistant-allocations`, handle('assign')),
  )
}
