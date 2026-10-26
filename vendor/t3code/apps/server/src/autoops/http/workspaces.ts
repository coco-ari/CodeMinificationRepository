import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { responseError } from './responses.ts'
import type { BusinessHttpContext } from './context.ts'
import { configuredWorkspaceStore } from '../../../../../../../agent-demo/t3-adapters/workspaces.mjs'
import {configuredWorkspaceManagement} from '../../../../../../../agent-demo/t3-adapters/workspace-management.ts'
import { handleWorkspaceRequest } from '../../../../../../../agent-demo/t3-adapters/workspace-http.mjs'
import { resourceHeaders } from './responses.ts'

export function workspacesRoutes({ access, principal }: BusinessHttpContext) {
const workspaceRequest = Effect.gen(function* () {
    const current = yield* principal;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== 'GET') yield* Effect.try(() => access.requireCsrf(current, request.headers['x-demo-csrf']));
    const input = request.method === 'GET' ? undefined : yield* request.json;
    const result = yield* Effect.tryPromise(() => handleWorkspaceRequest({access, store:configuredWorkspaceStore(), principal:current, url:new URL(request.url,'http://localhost'), method:request.method, input,maintainCurrent:(projectId:string)=>configuredWorkspaceManagement(access).collectUnusedCurrentVersionsForMaintenance(projectId)}));
    if (result.file) {
      const url = new URL(request.url,'http://localhost');
      if (url.searchParams.get('metadata') === '1') return HttpServerResponse.jsonUnsafe({name:result.file.name,mime:result.file.mime,size:result.file.bytes.byteLength}, {headers:{'cache-control':'private, no-store'}});
      return HttpServerResponse.uint8Array(result.file.bytes, {status:result.status, headers:resourceHeaders(url,result.file.name,result.file.mime)});
    }
    return HttpServerResponse.jsonUnsafe(result.body, {status:result.status, headers:{'cache-control':'private, no-store'}});
  }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))));
return Layer.mergeAll(
HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces', workspaceRequest),
HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces/versions/:versionId/tree', workspaceRequest),
HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces/versions/:versionId/search', workspaceRequest),
HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces/versions/:versionId/content', workspaceRequest),
HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces/versions/:versionId/download', workspaceRequest),
HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces/packages/:releaseId/:service/download', workspaceRequest),
HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces/packages/:releaseId/manifest', workspaceRequest),
HttpRouter.add('POST', '/autoops/projects/:projectId/workspaces/external', workspaceRequest),
HttpRouter.add('POST', '/autoops/projects/:projectId/workspaces/packages', workspaceRequest),
HttpRouter.add('POST', '/autoops/projects/:projectId/workspaces/import', workspaceRequest),
HttpRouter.add('POST', '/autoops/projects/:projectId/workspaces/versions/:versionId/publish', workspaceRequest),
HttpRouter.add('POST', '/autoops/projects/:projectId/workspaces/tasks/:taskId/cancel', workspaceRequest)
)
}
