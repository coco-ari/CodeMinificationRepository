import * as ByteSize from 'effect/ByteSize'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { decodeContract } from '../../../../../../../autoops/contracts/index.ts'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { configuredWorkspaceManagement } from '../../../../../../../agent-demo/t3-adapters/workspace-management.ts'
import {
  SaveRepository,
  ConfigureRepositoryWorkspace,
} from '../../../../../../../autoops/contracts/project-repositories.ts'
import { DirectoryCommand } from '../../../../../../../autoops/contracts/project-directory.ts'
import type { BusinessHttpContext } from './context.ts'
import { responseError } from './responses.ts'

export function repositoriesRoutes({ access, principal }: BusinessHttpContext) {
  const handle = (operation: 'list' | 'refs' | 'save' | 'remove' | 'workspace' | 'receipt') =>
    Effect.gen(function* () {
      const current = yield* principal
      const request = yield* HttpServerRequest.HttpServerRequest
      const parts = new URL(request.url, 'http://localhost').pathname.split('/')
      const project = yield* Effect.try(() => decodeURIComponent(parts[4] ?? ''))
      const repositoryId = parts[6] ? yield* Effect.try(() => decodeURIComponent(parts[6]!)) : null
      if (operation === 'receipt') {
        yield* Effect.try(() => access.refresh(current))
        const service = yield* Effect.try(() => configuredWorkspaceManagement(access))
        const requestId = yield* Effect.try(() => decodeURIComponent(parts[7] ?? ''))
        yield* Effect.try(() => service.authoring.repositoryReceipt(project, requestId, current.id))
        const value = yield* Effect.try(() => {
          access.refresh(current)
          return service.authoring.repositoryReceipt(project, requestId, current.id)
        })
        return HttpServerResponse.jsonUnsafe(value, {
          headers: { 'cache-control': 'private, no-store' },
        })
      }
      const read = operation === 'list' || operation === 'refs'
      const action = read
        ? 'repository.read'
        : operation === 'workspace'
          ? 'workspace.manage'
          : 'repository.manage'
      const assertCurrent = () => {
        access.refresh(current)
        access.requireProjectAction(current, project, action)
      }
      yield* Effect.try(() => {
        if (!read) access.requireCsrf(current, request.headers['x-demo-csrf'])
        assertCurrent()
      })
      const service = yield* Effect.try(() => configuredWorkspaceManagement(access))
      if (operation === 'list')
        return HttpServerResponse.jsonUnsafe(
          yield* Effect.try(() => service.authoring.repositories(project, current.id)),
          { headers: { 'cache-control': 'private, no-store' } },
        )
      if (operation === 'refs') {
        const value = yield* Effect.tryPromise(() =>
          service.repositoryRefs(project, repositoryId ?? '', current.id),
        )
        yield* Effect.try(assertCurrent)
        return HttpServerResponse.jsonUnsafe(value, {
          headers: { 'cache-control': 'private, no-store' },
        })
      }
      const body = yield* request.json.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(16)),
        Effect.mapError(() => ({
          status: 400,
          code: 'REPOSITORY_INPUT_INVALID',
          message: '仓库配置正文无效或过大',
        })),
      )
      yield* Effect.try(assertCurrent)
      const inputError = () => ({
        status: 400,
        code: 'REPOSITORY_INPUT_INVALID',
        message: '仓库字段或格式无效；连接不选择业务分支',
      })
      let result: unknown
      if (operation === 'workspace') {
        const input = yield* Effect.try(() =>
          decodeContract(ConfigureRepositoryWorkspace, body),
        ).pipe(Effect.mapError(inputError))
        if (input.id !== repositoryId)
          return yield* Effect.fail({
            status: 400,
            code: 'REPOSITORY_USAGE_INVALID',
            message: '工作区仓库身份不一致',
          })
        result = yield* Effect.try(() =>
          service.authoring.configureSource(project, input, current.id),
        )
      } else if (operation === 'remove') {
        const input = yield* Effect.try(() => decodeContract(DirectoryCommand, body)).pipe(
          Effect.mapError(inputError),
        )
        yield* Effect.tryPromise(() => service.cancelProjectWork(project))
        result = yield* Effect.try(() =>
          service.authoring.removeRepository(project, repositoryId ?? '', input, current.id),
        )
        yield* Effect.tryPromise(() =>
          service.purgeRelated(
            project,
            result as { removedCaptures?: string[]; removedInputs?: string[] },
            repositoryId ?? '',
          ),
        )
      } else {
        const input = yield* Effect.try(() => decodeContract(SaveRepository, body)).pipe(
          Effect.mapError(inputError),
        )
        result = yield* Effect.try(() =>
          service.authoring.saveRepository(project, repositoryId, input, current.id),
        )
      }
      const available = yield* Effect.try(() => {
        assertCurrent()
        return true
      }).pipe(
        Effect.catch((error) => {
          const status = (error.cause as { status?: number } | undefined)?.status
          return status === 401 || status === 403 || status === 404
            ? Effect.succeed(false)
            : Effect.fail(error)
        }),
      )
      return HttpServerResponse.jsonUnsafe(available ? result : { saved: true, available: false }, {
        headers: { 'cache-control': 'private, no-store' },
      })
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))
  const base = '/api/v1/projects/:projectId/repositories'
  return Layer.mergeAll(
    HttpRouter.add('GET', base, handle('list')),
    HttpRouter.add('GET', `${base}/receipts/:requestId`, handle('receipt')),
    HttpRouter.add('GET', `${base}/:repositoryId/refs`, handle('refs')),
    HttpRouter.add('POST', base, handle('save')),
    HttpRouter.add('POST', `${base}/:repositoryId`, handle('save')),
    HttpRouter.add('POST', `${base}/:repositoryId/remove`, handle('remove')),
    HttpRouter.add('POST', `${base}/:repositoryId/workspace`, handle('workspace')),
  )
}
