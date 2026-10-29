import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { responseError, resourceHeaders } from './responses.ts'
import type { BusinessHttpContext } from './context.ts'
import { configuredDeploymentStore } from '../../../../../../../agent-demo/t3-adapters/deployments.mjs'
import { handleDeploymentRequest } from '../../../../../../../agent-demo/t3-adapters/deployment-http.mjs'

export function deploymentsRoutes({ access, principal }: BusinessHttpContext) {
  const deploymentRequest = Effect.gen(function* () {
    const current = yield* principal
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method !== 'GET')
      yield* Effect.try(() => access.requireCsrf(current, request.headers['x-demo-csrf']))
    if (request.method !== 'GET') {
      const environmentRemoval =
        /^\/api\/v1\/projects\/([^/]+)\/environments\/([^/]+)\/deployment-services\/[^/]+$/.exec(
          new URL(request.url, 'http://localhost').pathname,
        )
      if (environmentRemoval)
        yield* Effect.try(() =>
          access.requireDeploymentAction(
            current,
            decodeURIComponent(environmentRemoval[1]!),
            'configure',
            decodeURIComponent(environmentRemoval[2]!),
          ),
        )
      const node =
        /^\/autoops\/projects\/([^/]+)\/deployments\/servers(?:\/[^/]+(?:\/(bind|unbind|revoke|storage-policy))?)?$/.exec(
          new URL(request.url, 'http://localhost').pathname,
        )
      if (node) {
        const projectId = yield* Effect.try(() => decodeURIComponent(node[1]!))
        const action =
          node[2] === 'bind'
            ? 'server.bind'
            : node[2] === 'unbind'
              ? 'server.unbind'
              : new URL(request.url, 'http://localhost').pathname.endsWith('/servers')
                ? 'server.create'
                : 'server.admin'
        yield* Effect.try(() => access.requireDeploymentAction(current, projectId, action))
      }
    }
    const input = request.method === 'GET' ? undefined : yield* request.json
    const result = yield* Effect.tryPromise(() =>
      handleDeploymentRequest({
        access,
        store: configuredDeploymentStore(),
        principal: current,
        url: new URL(request.url, 'http://localhost'),
        method: request.method,
        input,
      }),
    )
    if (result.file)
      return HttpServerResponse.uint8Array(result.file.bytes, {
        status: result.status,
        headers: resourceHeaders(
          new URL(request.url, 'http://localhost'),
          result.file.name,
          result.file.mime,
        ),
      })
    return HttpServerResponse.jsonUnsafe(result.body, {
      status: result.status,
      headers: { 'cache-control': 'private, no-store' },
    })
  }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))
  return Layer.mergeAll(
    HttpRouter.add(
      'GET',
      '/api/v1/projects/:projectId/deployments/requests/:requestId',
      deploymentRequest,
    ),
    HttpRouter.add(
      'DELETE',
      '/api/v1/projects/:projectId/environments/:environmentId/deployment-services/:serviceId',
      deploymentRequest,
    ),
    HttpRouter.add(
      'DELETE',
      '/autoops/projects/:projectId/deployments/services/:serviceId',
      deploymentRequest,
    ),
    HttpRouter.add(
      'DELETE',
      '/autoops/projects/:projectId/deployments/targets/:targetId',
      deploymentRequest,
    ),
    HttpRouter.add('GET', '/autoops/projects/:projectId/deployments', deploymentRequest),
    HttpRouter.add('POST', '/autoops/projects/:projectId/deployments/servers', deploymentRequest),
    HttpRouter.add('GET', '/autoops/projects/:projectId/deployments/servers', deploymentRequest),
    HttpRouter.add(
      'GET',
      '/autoops/projects/:projectId/deployments/servers/receipts/:requestId',
      deploymentRequest,
    ),
    HttpRouter.add(
      'POST',
      '/autoops/projects/:projectId/deployments/servers/:serverId/bind',
      deploymentRequest,
    ),
    HttpRouter.add(
      'POST',
      '/autoops/projects/:projectId/deployments/servers/:serverId/unbind',
      deploymentRequest,
    ),
    HttpRouter.add(
      'POST',
      '/autoops/projects/:projectId/deployments/servers/:serverId/revoke',
      deploymentRequest,
    ),
    HttpRouter.add(
      'DELETE',
      '/autoops/projects/:projectId/deployments/servers/:serverId',
      deploymentRequest,
    ),
    HttpRouter.add(
      'PUT',
      '/autoops/projects/:projectId/deployments/servers/:serverId/storage-policy',
      deploymentRequest,
    ),
    HttpRouter.add('POST', '/autoops/projects/:projectId/deployments/services', deploymentRequest),
    HttpRouter.add(
      'GET',
      '/autoops/projects/:projectId/deployments/repositories/:sourceId/refs',
      deploymentRequest,
    ),
    HttpRouter.add(
      'GET',
      '/autoops/projects/:projectId/deployments/repositories/:sourceId/history',
      deploymentRequest,
    ),
    HttpRouter.add(
      'GET',
      '/autoops/projects/:projectId/deployments/services/:serviceId/sources/:environmentId',
      deploymentRequest,
    ),
    HttpRouter.add(
      'PUT',
      '/autoops/projects/:projectId/deployments/services/:serviceId/sources/:environmentId',
      deploymentRequest,
    ),
    HttpRouter.add(
      'PATCH',
      '/autoops/projects/:projectId/deployments/targets/:targetId',
      deploymentRequest,
    ),
    HttpRouter.add('POST', '/autoops/projects/:projectId/deployments/targets', deploymentRequest),
    HttpRouter.add('POST', '/autoops/projects/:projectId/deployments/tasks', deploymentRequest),
    HttpRouter.add(
      'GET',
      '/autoops/projects/:projectId/deployments/tasks/:taskId',
      deploymentRequest,
    ),
    HttpRouter.add(
      'GET',
      '/autoops/projects/:projectId/deployments/targets/:targetId/releases',
      deploymentRequest,
    ),
    HttpRouter.add(
      'GET',
      '/autoops/projects/:projectId/deployments/targets/:targetId/releases/:releaseId',
      deploymentRequest,
    ),
    HttpRouter.add(
      'GET',
      '/autoops/projects/:projectId/deployments/targets/:targetId/releases/:releaseId/source',
      deploymentRequest,
    ),
    HttpRouter.add(
      'DELETE',
      '/autoops/projects/:projectId/deployments/targets/:targetId/releases/:releaseId/source',
      deploymentRequest,
    ),
  )
}
