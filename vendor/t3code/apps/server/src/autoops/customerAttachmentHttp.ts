import * as Effect from 'effect/Effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { RemoteDeviceService } from './RemoteDeviceService.ts'

export const layer = HttpRouter.add(
  'GET',
  '/autoops/customer/connector/attachments/:commandId/:attachmentId',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const { hub } = yield* RemoteDeviceService
    if (!hub) return HttpServerResponse.empty({ status: 404 })
    const principal = yield* Effect.try(() => {
      hub.access.assertAccepting()
      const authorization = request.headers.authorization
      if (!authorization?.startsWith('Bearer ')) throw new Error('缺少设备凭据')
      return hub.access.customerRegistry.authenticateToken(authorization.slice(7))
    })
    const parts = new URL(request.url, 'http://localhost').pathname.split('/')
    const bytes = yield* Effect.tryPromise(() =>
      hub.readAttachment(
        principal,
        decodeURIComponent(parts.at(-2) ?? ''),
        decodeURIComponent(parts.at(-1) ?? ''),
      ),
    )
    yield* Effect.try(() =>
      hub.access.customerRegistry.authenticateToken(request.headers.authorization!.slice(7)),
    )
    return HttpServerResponse.uint8Array(bytes, {
      headers: {
        'content-type': 'application/octet-stream',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: '附件不存在、已失效或无权访问' },
          { status: 403, headers: { 'cache-control': 'private, no-store' } },
        ),
      ),
    ),
  ),
)
