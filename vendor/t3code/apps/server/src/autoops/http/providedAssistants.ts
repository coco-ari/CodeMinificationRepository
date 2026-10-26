import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { configuredAutoOpsAssistantDirectory } from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import type { BusinessHttpContext } from './context.ts'
import { responseError } from './responses.ts'

/** 接入管理只写提供者同意与预设事实，不开放跨用户运行命令。 */
export function providedAssistantsRoutes({ access, principal }: BusinessHttpContext) {
  const handle = (operation: 'own' | 'create' | 'save' | 'share' | 'project' | 'receipt') =>
    Effect.gen(function* () {
      const current = yield* principal
      const request = yield* HttpServerRequest.HttpServerRequest
      const parts = new URL(request.url, 'http://localhost').pathname.split('/')
      const directory = yield* Effect.try(configuredAutoOpsAssistantDirectory)
      if (operation === 'project') {
        const project = yield* Effect.try(() => decodeURIComponent(parts[4] ?? ''))
        const value = yield* Effect.try(() => directory.providedForProject(current.id, project))
        yield* Effect.try(() => access.requireProjectAction(current, project, 'project.manage'))
        return HttpServerResponse.jsonUnsafe(
          value,
          { headers: { 'cache-control': 'private, no-store' } },
        )
      }
      if (operation === 'receipt') {
        const value = yield* Effect.try(() => directory.providedReceipt(current.id, decodeURIComponent(parts[6] ?? '')))
        yield* Effect.try(() => access.refresh(current))
        return HttpServerResponse.jsonUnsafe(
          value,
          { headers: { 'cache-control': 'private, no-store' } },
        )
      }
      const id = yield* Effect.try(() => (parts[5] ? decodeURIComponent(parts[5]) : undefined))
      const check = () => {
        access.refresh(current)
        directory.requireProviderAccess(current.id, id)
      }
      yield* Effect.try(() => {
        check()
        if (operation !== 'own') access.requireCsrf(current, request.headers['x-demo-csrf'])
      })
      if (operation === 'own') {
        const value = yield* Effect.try(() => directory.providedSettings(current.id))
        yield* Effect.try(check)
        return HttpServerResponse.jsonUnsafe(
          value,
          { headers: { 'cache-control': 'private, no-store' } },
        )
      }
      // 实际字节流限额同时覆盖 Web 与 Node 传输，不依赖 Content-Length。
      const input = yield* request.stream.pipe(
        Stream.runFoldEffect(
          () => ({ buffer: new Uint8Array(64 * 1024), bytes: 0 }),
          (state, chunk) => chunk.byteLength > 64 * 1024 - state.bytes
            ? Effect.fail({ _tag: 'AssistantBodyLimit' as const })
            : Effect.sync(() => {
              state.buffer.set(chunk, state.bytes)
              state.bytes += chunk.byteLength
              return state
            }),
        ),
        Effect.flatMap(state => Effect.try(() => new TextDecoder('utf-8', { fatal: true }).decode(state.buffer.subarray(0, state.bytes)))),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
        Effect.mapError(() => ({
          status: 400,
          code: 'ASSISTANT_INPUT_INVALID',
          message: '助手配置正文无效或超过大小限制',
        })),
      )
      yield* Effect.try(check)
      const value = yield* Effect.try(() =>
        operation === 'share'
          ? directory.shareProvided(current.id, id!, decodeURIComponent(parts[7] ?? ''), input)
          : directory.saveProvided(current.id, operation === 'create' ? null : id!, input),
      )
      const available = yield* Effect.try(check).pipe(Effect.as(true), Effect.catch(error =>
        [401, 403, 404].includes((error.cause as { status?: number } | undefined)?.status ?? 0)
          ? Effect.succeed(false) : Effect.fail(error)))
      return HttpServerResponse.jsonUnsafe(available ? value : { saved: true, available: false }, {
        headers: { 'cache-control': 'private, no-store' },
      })
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))
  const base = '/api/v1/assistants/provided'
  return Layer.mergeAll(
    HttpRouter.add('GET', base, handle('own')),
    HttpRouter.add('GET', `${base}/receipts/:requestId`, handle('receipt')),
    HttpRouter.add('POST', base, handle('create')),
    HttpRouter.add('POST', `${base}/:assistantId`, handle('save')),
    HttpRouter.add('POST', `${base}/:assistantId/shares/:projectId`, handle('share')),
    HttpRouter.add('GET', '/api/v1/projects/:projectId/assistants/provided', handle('project')),
  )
}
