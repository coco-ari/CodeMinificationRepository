import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import * as Schema from 'effect/Schema'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { configuredWorkspaceUpdates } from '../../../../../../../agent-demo/t3-adapters/workspace-update-runtime.ts'
import type { WorkspaceUpdates } from '../../../../../../../agent-demo/t3-adapters/workspace-updates/index.ts'
import { decodeContract } from '../../../../../../../autoops/contracts/index.ts'
import { WorkspaceUpdateScope } from '../../../../../../../autoops/contracts/workspace-updates.ts'
import { responseError } from './responses.ts'
import type { BusinessHttpContext } from './context.ts'

export function workspaceUpdatesRoutes(
  { access, principal }: BusinessHttpContext,
  service?: WorkspaceUpdates,
) {
  const handle = (operation: 'overview' | 'save' | 'remove' | 'receipt') =>
    Effect.gen(function* () {
      const current = yield* principal
      const request = yield* HttpServerRequest.HttpServerRequest
      const parts = new URL(request.url, 'http://localhost').pathname.split('/')
      const project = yield* Effect.try(() => decodeURIComponent(parts[4] ?? ''))
      const check = () => {
        access.refresh(current)
        access.requireWorkspaceReader(current.id, project)
        if (operation !== 'overview') access.requireWorkspaceActor(current.id, project)
      }
      yield* Effect.try(() => {
        check()
        if (operation === 'save' || operation === 'remove')
          access.requireCsrf(current, request.headers['x-demo-csrf'])
      })
      const owner = yield* Effect.try(() => service ?? configuredWorkspaceUpdates(access))
      let result: unknown
      if (operation === 'overview')
        result = yield* Effect.try(() => owner.overview(project, current.id))
      else if (operation === 'receipt') {
        const requestId = yield* Effect.try(() => decodeURIComponent(parts[8] ?? ''))
        result = yield* Effect.try(() => owner.receipt(project, requestId, current.id))
      } else {
        const scope = yield* Effect.try(() =>
          decodeContract(WorkspaceUpdateScope, decodeURIComponent(parts[7] ?? '')),
        ).pipe(
          Effect.mapError(() => ({
            status: 400,
            code: 'WORKSPACE_UPDATE_SCOPE_INVALID',
            message: '资料更新范围无效',
          })),
        )
        if (scope === 'external')
          yield* Effect.try(() =>
            access.requireProjectActionForActor(current.id, project, 'workspace.external.publish'),
          )
        const input = yield* request.stream.pipe(
          Stream.runFoldEffect(
            () => ({ buffer: new Uint8Array(16 * 1024), bytes: 0 }),
            (state, chunk) =>
              chunk.byteLength > 16 * 1024 - state.bytes
                ? Effect.fail({ _tag: 'WorkspaceUpdateBodyLimit' as const })
                : Effect.sync(() => {
                    state.buffer.set(chunk, state.bytes)
                    state.bytes += chunk.byteLength
                    return state
                  }),
          ),
          Effect.flatMap((state) =>
            Effect.try(() =>
              new TextDecoder('utf-8', { fatal: true }).decode(
                state.buffer.subarray(0, state.bytes),
              ),
            ),
          ),
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
          Effect.mapError(() => ({
            status: 400,
            code: 'WORKSPACE_UPDATE_INPUT_INVALID',
            message: '资料更新正文无效或超过大小限制',
          })),
        )
        yield* Effect.try(check)
        result =
          operation === 'remove'
            ? yield* Effect.tryPromise(() => owner.remove(project, scope, input, current.id))
            : yield* Effect.try(() => owner.save(project, scope, input, current.id))
      }
      const available = yield* Effect.try(check).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          operation === 'save' &&
          [401, 403, 404].includes((error.cause as { status?: number } | undefined)?.status ?? 0)
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      )
      return HttpServerResponse.jsonUnsafe(available ? result : { saved: true, available: false }, {
        headers: { 'cache-control': 'private, no-store' },
      })
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))
  const base = '/api/v1/projects/:projectId/workspace/updates'
  return Layer.mergeAll(
    HttpRouter.add('GET', base, handle('overview')),
    HttpRouter.add('DELETE', `${base}/:scope`, handle('remove')),
    HttpRouter.add('POST', `${base}/:scope`, handle('save')),
    HttpRouter.add('GET', `${base}/requests/:requestId`, handle('receipt')),
  )
}
