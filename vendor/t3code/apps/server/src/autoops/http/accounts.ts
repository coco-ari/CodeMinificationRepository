import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import * as Schema from 'effect/Schema'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { configuredRuntimeAccounts } from '../../../../../../../agent-demo/t3-adapters/account-runtime.ts'
import type { RuntimeAccounts } from '../../../../../../../agent-demo/t3-adapters/accounts/index.ts'
import type {
  RuntimeAccount,
  AccountPasswordResult,
} from '../../../../../../../autoops/contracts/accounts.ts'
import type { BusinessHttpContext } from './context.ts'
import { responseError } from './responses.ts'

/** 账号来自同一持久所有者；HTTP 只提供当前可信会话和受限正文。 */
export function accountsRoutes(
  { access, principal }: BusinessHttpContext,
  configured: () => RuntimeAccounts = configuredRuntimeAccounts,
) {
  const handle = (
    operation:
      'own' | 'list' | 'receipt' | 'create' | 'enable' | 'resetPassword' | 'changePassword',
  ) =>
    Effect.gen(function* () {
      const current = yield* principal
      const request = yield* HttpServerRequest.HttpServerRequest
      const owner = yield* Effect.try(configured)
      const url = new URL(request.url, 'http://localhost')
      const parts = url.pathname.split('/')
      const target = yield* Effect.try(() => decodeURIComponent(parts[4] ?? ''))
      const check = () => {
        access.refresh(current)
        const account = owner.active(current.id)
        if (
          !['own', 'receipt', 'changePassword'].includes(operation) &&
          (!account.platformAdmin || account.kind !== 'internal')
        )
          throw Object.assign(new Error('账号管理仅限平台管理员'), {
            status: 403,
            code: 'ACCOUNT_FORBIDDEN',
          })
      }
      yield* Effect.try(check)
      const headers = { 'cache-control': 'private, no-store' }
      if (operation === 'own')
        return HttpServerResponse.jsonUnsafe(owner.own(current.id), { headers })
      if (operation === 'list') {
        const result = yield* Effect.try(() =>
          owner.list(current.id, url.searchParams.get('after') ?? ''),
        )
        yield* Effect.try(check)
        return HttpServerResponse.jsonUnsafe(result, { headers })
      }
      if (operation === 'receipt') {
        const result = yield* Effect.try(() =>
          owner.receipt(current.id, decodeURIComponent(parts[5] ?? '')),
        )
        yield* Effect.try(check)
        return HttpServerResponse.jsonUnsafe(result, { headers })
      }
      yield* Effect.try(() => access.requireCsrf(current, request.headers['x-demo-csrf']))
      const input = yield* request.stream.pipe(
        Stream.runFoldEffect(
          () => ({ buffer: new Uint8Array(16 * 1024), bytes: 0 }),
          (state, chunk) =>
            chunk.byteLength > state.buffer.byteLength - state.bytes
              ? Effect.fail({ code: 'ACCOUNT_INPUT_INVALID' })
              : Effect.sync(() => {
                  state.buffer.set(chunk, state.bytes)
                  state.bytes += chunk.byteLength
                  return state
                }),
        ),
        Effect.flatMap((state) =>
          Effect.try(() =>
            new TextDecoder('utf-8', { fatal: true }).decode(state.buffer.subarray(0, state.bytes)),
          ),
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
        Effect.mapError(() => ({
          status: 400,
          code: 'ACCOUNT_INPUT_INVALID',
          message: '账号正文无效或超过大小限制',
        })),
      )
      yield* Effect.try(check)
      const result =
        operation === 'enable'
          ? yield* Effect.try(() => owner.setEnabled(current.id, target, input, check))
          : yield* Effect.tryPromise(async (): Promise<RuntimeAccount | AccountPasswordResult> =>
              operation === 'create'
                ? owner.create(current.id, input, check)
                : operation === 'resetPassword'
                  ? owner.resetPassword(current.id, target, input, check)
                  : owner.changePassword(current.id, input, check),
            )
      // 本人改密或停用已同事务撤销会话，仍准确返回刚提交的事实。
      const selfRevoked =
        operation === 'changePassword' ||
        ((operation === 'resetPassword' || operation === 'enable') && target === current.id)
      if (!selfRevoked) {
        const available = yield* Effect.try(check).pipe(
          Effect.as(true),
          Effect.catch((error) => {
            const status = (error.cause as { status?: number } | undefined)?.status
            return status === 401 || status === 403 ? Effect.succeed(false) : Effect.fail(error)
          }),
        )
        if (!available)
          return HttpServerResponse.jsonUnsafe({ saved: true, available: false }, { headers })
      }
      return HttpServerResponse.jsonUnsafe(result, { headers })
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))
  return Layer.mergeAll(
    HttpRouter.add('GET', '/api/v1/account', handle('own')),
    HttpRouter.add('GET', '/api/v1/accounts', handle('list')),
    HttpRouter.add('GET', '/api/v1/accounts/receipts/:requestId', handle('receipt')),
    HttpRouter.add('POST', '/api/v1/accounts', handle('create')),
    HttpRouter.add('PUT', '/api/v1/accounts/:accountId', handle('enable')),
    HttpRouter.add('PUT', '/api/v1/accounts/:accountId/password', handle('resetPassword')),
    HttpRouter.add('PUT', '/api/v1/account/password', handle('changePassword')),
  )
}
