import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import * as Schema from 'effect/Schema'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { configuredEnvironmentMcp } from '../../../../../../../agent-demo/t3-adapters/environment-mcp-runtime.ts'
import type { EnvironmentMcp } from '../../../../../../../agent-demo/t3-adapters/environment-mcp/index.ts'
import { responseError } from './responses.ts'
import type { BusinessHttpContext } from './context.ts'

export function environmentMcpRoutes({ access, principal }: BusinessHttpContext, service?: EnvironmentMcp) {
  const handle = (operation: 'list' | 'save' | 'test' | 'enabled' | 'remove' | 'receipt') => Effect.gen(function* () {
    const current = yield* principal
    const request = yield* HttpServerRequest.HttpServerRequest
    const parts = new URL(request.url, 'http://localhost').pathname.split('/')
    const [project, environment, id] = yield* Effect.try(() => [parts[4], parts[6], parts[8]].map(value => decodeURIComponent(value ?? '')))
    const write = !['list', 'receipt'].includes(operation)
    const check = () => {
      access.refresh(current)
      access.requireProjectAction(current, project!, 'project.manage')
      const projectRecord = access.requireProject(current, project!)
      if (!projectRecord.environments.some(entry => entry.id === environment))
        throw Object.assign(new Error('环境不存在或不属于当前项目'), {status: 404, code: 'ENVIRONMENT_NOT_FOUND'})
    }
    yield* Effect.try(() => { check(); if (write) access.requireCsrf(current, request.headers['x-demo-csrf']) })
    const owner = yield* Effect.try(() => service ?? configuredEnvironmentMcp(access))
    let result: unknown
    if (operation === 'list') result = {items: yield* Effect.try(() => owner.list(project!, environment!, current.id))}
    else if (operation === 'receipt') {
      const requestId = yield* Effect.try(() => decodeURIComponent(parts[9] ?? ''))
      result = {receipt: yield* Effect.try(() => owner.receipt(project!, environment!, requestId, current.id))}
    } else {
      // Web 和 Node 传输都从真实字节流限额，不能依赖可缺失的 Content-Length。
      const input = yield* request.stream.pipe(
        Stream.runFoldEffect(
          () => ({ buffer: new Uint8Array(16 * 1024), bytes: 0 }),
          (state, chunk) => chunk.byteLength > 16 * 1024 - state.bytes
            ? Effect.fail({ _tag: 'EnvironmentMcpBodyLimit' as const })
            : Effect.sync(() => {
              state.buffer.set(chunk, state.bytes)
              state.bytes += chunk.byteLength
              return state
            }),
        ),
        Effect.flatMap(state => Effect.try(() => {
          return new TextDecoder('utf-8', {fatal: true}).decode(state.buffer.subarray(0, state.bytes))
        })),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
        Effect.mapError(() => ({status: 400, code: 'ENVIRONMENT_MCP_INPUT_INVALID', message: '环境连接正文无效或超过大小限制'})),
      )
      yield* Effect.try(check)
      if (operation === 'save') result = yield* Effect.try(() => owner.save(project!, environment!, input, current.id, id || null))
      else if (operation === 'test') result = yield* Effect.tryPromise(signal => owner.testConnection(project!, environment!, id!, input, current.id, signal))
      else if (operation === 'enabled') result = yield* Effect.try(() => owner.setEnabled(project!, environment!, id!, input, current.id))
      else result = yield* Effect.try(() => owner.remove(project!, environment!, id!, input, current.id))
    }
    const available = yield* Effect.try(check).pipe(Effect.as(true), Effect.catch(error =>
      write && [401,403,404].includes((error.cause as {status?: number} | undefined)?.status ?? 0)
        ? Effect.succeed(false) : Effect.fail(error)))
    return HttpServerResponse.jsonUnsafe(available ? result : {saved: true, available: false}, {headers: {'cache-control': 'private, no-store'}})
  }).pipe(Effect.catch(cause => Effect.succeed(responseError(cause))))
  const base = '/api/v1/projects/:projectId/environments/:environmentId/mcp'
  return Layer.mergeAll(
    HttpRouter.add('GET', base, handle('list')),
    HttpRouter.add('POST', base, handle('save')),
    HttpRouter.add('POST', `${base}/:connectionId`, handle('save')),
    HttpRouter.add('POST', `${base}/:connectionId/test`, handle('test')),
    HttpRouter.add('POST', `${base}/:connectionId/enabled`, handle('enabled')),
    HttpRouter.add('DELETE', `${base}/:connectionId`, handle('remove')),
    HttpRouter.add('GET', `${base}/receipts/:requestId`, handle('receipt')),
  )
}
