import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { responseError } from './responses.ts'
import type { BusinessHttpContext } from './context.ts'
import { configuredDeploymentStore } from '../../../../../../../agent-demo/t3-adapters/deployments.mjs'
import { handleDeploymentRequest } from '../../../../../../../agent-demo/t3-adapters/deployment-http.mjs'

export function deploymentsRoutes({ access, principal }: BusinessHttpContext) {
const deploymentRequest = Effect.gen(function* () {
    const current = yield* principal;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== 'GET') yield* Effect.try(() => access.requireCsrf(current, request.headers['x-demo-csrf']));
    const input = request.method === 'GET' ? undefined : yield* request.json;
    const result = yield* Effect.tryPromise(() => handleDeploymentRequest({
      access, store: configuredDeploymentStore(), principal: current,
      url: new URL(request.url, 'http://localhost'), method: request.method, input,
    }));
    return HttpServerResponse.jsonUnsafe(result.body, {
      status: result.status, headers: { 'cache-control': 'private, no-store' },
    });
  }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))));
return Layer.mergeAll(
HttpRouter.add('GET', '/autoops/projects/:projectId/deployments', deploymentRequest),
HttpRouter.add('POST', '/autoops/projects/:projectId/deployments/servers', deploymentRequest),
HttpRouter.add('POST', '/autoops/projects/:projectId/deployments/targets', deploymentRequest),
HttpRouter.add('POST', '/autoops/projects/:projectId/deployments/tasks', deploymentRequest),
HttpRouter.add('GET', '/autoops/projects/:projectId/deployments/tasks/:taskId', deploymentRequest),
HttpRouter.add('GET', '/autoops/projects/:projectId/deployments/targets/:targetId/releases', deploymentRequest)
)
}
