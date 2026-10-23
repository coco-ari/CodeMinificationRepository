import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as ByteSize from 'effect/ByteSize'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import type { BusinessHttpContext } from './context.ts'
import { resourceHeaders, responseError } from './responses.ts'
import { handleWorkspaceAuthoringRequest } from '../../../../../../../agent-demo/t3-adapters/workspace-authoring-http.ts'

export function workspaceAuthoringRoutes({ access, principal }: BusinessHttpContext) {
  const handler = Effect.gen(function* () {
    const current = yield* principal
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, 'http://localhost')
    const upload = request.method === 'POST' && url.pathname.endsWith('/uploads')
    if (request.method !== 'GET') yield* Effect.try(() => access.requireCsrf(current, request.headers['x-demo-csrf']))
    // 接收字节前校验项目权限，未授权请求不能占用上传或解析预算。
    const projectId = yield* Effect.try(() => decodeURIComponent(url.pathname.split('/')[4] ?? ''))
    yield* Effect.try(() => {
      access.requireWorkspace(current, projectId, 'internal')
      if (request.method !== 'GET') access.requireWorkspaceManager(current, projectId)
    })
    const contentLength = Number(request.headers['content-length'])
    if (request.method !== 'GET' && Number.isFinite(contentLength) && contentLength > (upload ? 8 : 2) * 1024 * 1024)
      return HttpServerResponse.jsonUnsafe({ code: upload ? 'WORKSPACE_UPLOAD_SIZE' : 'WORKSPACE_REQUEST_INVALID', error: upload ? '上传超过 8 MiB 上限，原有资料未修改' : '请求正文超过大小上限' }, { status: 413, headers: { 'cache-control': 'private, no-store' } })
    const invalid = () => ({ status: 400, code: 'WORKSPACE_REQUEST_INVALID', message: '请求正文无效或超过大小上限' })
    const input = request.method === 'GET' ? undefined : upload
      ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(url.searchParams.get('input') ?? 'null').pipe(Effect.mapError(invalid))
      : yield* request.json.pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(2)), Effect.mapError(invalid))
    const bytes = upload ? new Uint8Array(yield* request.arrayBuffer.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(8)),
      Effect.mapError(() => ({ status: 413, code: 'WORKSPACE_UPLOAD_SIZE', message: '上传未完成或超过 8 MiB 上限，原有资料未修改' })),
    )) : undefined
    const result = yield* Effect.tryPromise(() => handleWorkspaceAuthoringRequest({ access, principal: current, url, method: request.method, ...(input === undefined ? {} : { input }), ...(bytes ? { bytes } : {}) }))
    if (result.file) return HttpServerResponse.uint8Array(result.file.bytes, { status: result.status, headers: resourceHeaders(url, result.file.name, result.file.mime) })
    return HttpServerResponse.jsonUnsafe(result.body, { status: result.status, headers: { 'cache-control': 'private, no-store' } })
  }).pipe(Effect.catch(error => Effect.succeed(responseError(error))))
  const base = '/api/v1/projects/:projectId/workspace'
  return Layer.mergeAll(
    HttpRouter.add('GET', `${base}/authoring`, handler),
    ...['credentials', 'credentials/requests/:requestId', 'current/tree', 'current/search', 'current/metadata', 'current/file', 'requests/:requestId'].map(path => HttpRouter.add('GET', `${base}/${path}`, handler)),
    ...['sources', 'credentials', 'documents', 'uploads', 'versions', 'sync', 'external', 'deployment-packages', 'cleanup'].map(path => HttpRouter.add('POST', `${base}/${path}`, handler)),
  )
}
