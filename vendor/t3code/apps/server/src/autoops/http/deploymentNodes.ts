import * as ByteSize from 'effect/ByteSize'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { decodeContract } from '../../../../../../../autoops/contracts/index.ts'
import {
  NodeCommand,
  RegisterDeploymentNode,
  DeploymentNodePolicy,
  DeploymentNodeProjectAccess,
} from '../../../../../../../autoops/contracts/deployment-nodes.ts'
import { configuredDeploymentStore } from '../../../../../../../agent-demo/t3-adapters/deployments.mjs'
import { responseError } from './responses.ts'
import type { BusinessHttpContext } from './context.ts'

export function deploymentNodesRoutes({ access, principal }: BusinessHttpContext) {
  const handle = (operation: 'list' | 'receipt' | 'create' | 'revoke' | 'delete' | 'storage' | 'project') =>
    Effect.gen(function* () {
      const current = yield* principal
      const request = yield* HttpServerRequest.HttpServerRequest
      const check = () => {
        access.refresh(current)
        access.requireDeploymentNodeManager(current)
      }
      yield* Effect.try(() => {
        check()
        if (!['list', 'receipt'].includes(operation)) access.requireCsrf(current, request.headers['x-demo-csrf'])
      })
      const store = configuredDeploymentStore()
      if (!store)
        return yield* Effect.fail({
          status: 503,
          code: 'DEPLOYMENT_DISABLED',
          message: '部署尚未启用',
        })
      const parts = new URL(request.url, 'http://localhost').pathname.split('/')
      const serverId = yield* Effect.try(() => decodeURIComponent(parts[3] ?? ''))
      if (operation === 'receipt') {
        const requestId = yield* Effect.try(() => decodeURIComponent(parts[4] ?? ''))
        const receipt = yield* Effect.try(() => store.globalNodeRequest(requestId, current))
        yield* Effect.try(check)
        return HttpServerResponse.jsonUnsafe(receipt, { headers: { 'cache-control': 'private, no-store' } })
      }
      if (operation === 'list') {
        const catalog = yield* Effect.try(() => store.globalNodeCatalog(current))
        const projects = yield* Effect.try(() =>
          access.bootstrap(current).projects.map((project) => ({
            id: project.id,
            name: project.name,
            environments: project.environments.map((environment) => ({
              id: environment.id,
              name: environment.name,
            })),
          })),
        )
        yield* Effect.try(check)
        return HttpServerResponse.jsonUnsafe(
          { ...catalog, projects },
          { headers: { 'cache-control': 'private, no-store' } },
        )
      }
      const body = yield* request.json.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)),
        Effect.mapError(() => ({
          status: 400,
          code: 'DEPLOYMENT_NODE_INPUT_INVALID',
          message: '节点配置正文无效或过大',
        })),
      )
      yield* Effect.try(check)
      const parse = <T extends Parameters<typeof decodeContract>[0]>(schema: T) =>
        Effect.try(() => decodeContract(schema, body)).pipe(
          Effect.mapError(() => ({
            status: 400,
            code: 'DEPLOYMENT_NODE_INPUT_INVALID',
            message: '节点配置字段或格式无效',
          })),
        )
      let result
      if (operation === 'create') {
        const input = yield* parse(RegisterDeploymentNode)
        result = yield* Effect.tryPromise(() => store.createGlobalServer(input, current))
      } else if (operation === 'project') {
        const input = yield* parse(DeploymentNodeProjectAccess)
        const projectId = yield* Effect.try(() => decodeURIComponent(parts[5] ?? ''))
        const project = yield* Effect.try(() => access.requireProject(current, projectId))
        yield* Effect.tryPromise(() => store.ensureProject(project))
        yield* Effect.try(check)
        result = yield* Effect.tryPromise(() =>
          store.setServerAccess(projectId, { ...input, serverId }, current),
        )
      } else {
        const input =
          operation === 'storage' ? yield* parse(DeploymentNodePolicy) : yield* parse(NodeCommand)
        result = yield* Effect.tryPromise(() =>
          store.mutateGlobalServer(serverId, operation, input, current),
        )
      }
      const available = yield* Effect.try(check).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          [401, 403, 404].includes((error.cause as { status?: number } | undefined)?.status ?? 0)
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      )
      return HttpServerResponse.jsonUnsafe(available ? result : { saved: true, available: false }, {
        headers: { 'cache-control': 'private, no-store' },
      })
    }).pipe(Effect.catch((cause) => Effect.succeed(responseError(cause))))
  return Layer.mergeAll(
    HttpRouter.add('GET', '/autoops/deployment-servers', handle('list')),
    HttpRouter.add('GET', '/autoops/deployment-servers/receipts/:requestId', handle('receipt')),
    HttpRouter.add('POST', '/autoops/deployment-servers', handle('create')),
    HttpRouter.add('POST', '/autoops/deployment-servers/:serverId/revoke', handle('revoke')),
    HttpRouter.add('DELETE', '/autoops/deployment-servers/:serverId', handle('delete')),
    HttpRouter.add(
      'PUT',
      '/autoops/deployment-servers/:serverId/storage-policy',
      handle('storage'),
    ),
    HttpRouter.add(
      'POST',
      '/autoops/deployment-servers/:serverId/projects/:projectId',
      handle('project'),
    ),
  )
}
