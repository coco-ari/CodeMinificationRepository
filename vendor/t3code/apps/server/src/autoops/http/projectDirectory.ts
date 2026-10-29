import { configuredAutoOpsAssistantDirectory } from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import * as ByteSize from 'effect/ByteSize'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import * as Schema from 'effect/Schema'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { configuredAutoOpsProjectDirectory } from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import {
  synchronizeProject,
  deleteBusinessProject,
  deleteBusinessEnvironment,
  projectSynchronizationReferences,
  inspectProjectSynchronization,
  resumeBusinessProjectDeletion,
} from '../projects.ts'
import type { ProjectDeletionInspection } from '../../../../../../../agent-demo/t3-adapters/project-deletion.ts'
import type { BusinessHttpContext } from './context.ts'
import { responseError } from './responses.ts'

export function projectDirectoryRoutes(
  { access, principal }: BusinessHttpContext,
  inspection?: ProjectDeletionInspection,
) {
  const inspect: ProjectDeletionInspection = (project: string, environment?: string) => {
    if (!inspection)
      throw Object.assign(new Error('引用检查尚未完整装配，尚未删除'), {
        status: 503,
        code: 'PROJECT_DELETE_INSPECTION_UNAVAILABLE',
      })
    return inspection(project, environment)
  }
  inspect.purge = inspection?.purge
  inspect.threads = inspection?.threads
  const handle = (
    operation:
      | 'list'
      | 'receipt'
      | 'resume'
      | 'settings'
      | 'create'
      | 'save'
      | 'environment'
      | 'member-delete'
      | 'member'
      | 'delete-project'
      | 'delete-environment'
      | 'preview-project'
      | 'preview-environment',
  ) =>
    Effect.gen(function* () {
      const current = yield* principal
      const request = yield* HttpServerRequest.HttpServerRequest
      const parts = new URL(request.url, 'http://localhost').pathname.split('/')
      const project = yield* Effect.try(() => decodeURIComponent(parts[4] ?? ''))
      const write = !['list', 'receipt', 'settings', 'preview-project', 'preview-environment'].includes(
        operation,
      )
      const directory = yield* Effect.try(configuredAutoOpsProjectDirectory)
      if (write)
        yield* Effect.try(() => {
          access.requireCsrf(current, request.headers['x-demo-csrf'])
          if (operation === 'resume') {
            access.refresh(current)
            directory.requireProjectDeletionResumeAccess(current.id, decodeURIComponent(parts[5] ?? ''))
          } else if (operation === 'delete-project' || operation === 'delete-environment')
            directory.requireDeletionAccess(current.id, project)
          else if (operation !== 'create')
            access.requireProjectAction(
              current,
              project,
              operation.startsWith('member') ? 'project.members.manage' : 'project.manage',
            )
        })
      if (operation === 'list')
        return HttpServerResponse.jsonUnsafe(
          { items: yield* Effect.try(() => directory.list(current.id)) },
          { headers: { 'cache-control': 'private, no-store' } },
        )
      if (operation === 'settings')
        return HttpServerResponse.jsonUnsafe(
          yield* Effect.try(() => directory.settings(current.id, project)),
          { headers: { 'cache-control': 'private, no-store' } },
        )
      if (operation === 'receipt') {
        const requestId = yield* Effect.try(() => decodeURIComponent(parts[5] ?? ''))
        const original = yield* Effect.try(() => {
          access.refresh(current)
          return directory.receipt(current.id, requestId)
        })
        const synchronization =
          original?.available &&
          original.state === 'completed' &&
          ['project.create', 'project.save'].includes(original.operation) &&
          original.result &&
          'id' in original.result &&
          'name' in original.result
            ? yield* inspectProjectSynchronization({
                id: original.result.id,
                name: original.result.name,
              })
            : ('unverified' as const)
        return yield* Effect.try(() => {
          // 原生读取期间可能撤权；再次投影当前权限，不能沿用等待前的项目详情。
          access.refresh(current)
          const latest = directory.receipt(current.id, requestId)
          return HttpServerResponse.jsonUnsafe(
            latest?.available && latest.nativeSynchronization === 'unverified'
              ? { ...latest, nativeSynchronization: synchronization }
              : latest,
            { headers: { 'cache-control': 'private, no-store' } },
          )
        })
      }
      if (operation === 'preview-project' || operation === 'preview-environment') {
        const environment =
          operation === 'preview-environment' ? decodeURIComponent(parts[6] ?? '') : null
        const value = yield* Effect.try(() =>
          directory.deletionPreview(current.id, project, environment, () => [
            ...inspect(project, environment ?? undefined),
            ...(environment === null ? projectSynchronizationReferences(project) : []),
          ]),
        )
        yield* Effect.try(() => {
          access.refresh(current)
          access.requireProjectAction(current, project, 'project.manage')
        })
        return HttpServerResponse.jsonUnsafe(value, {
          headers: { 'cache-control': 'private, no-store' },
        })
      }
      if (operation === 'resume') {
        const input = yield* request.stream.pipe(
          Stream.runFoldEffect(
            () => ({ buffer: new Uint8Array(4096), bytes: 0 }),
            (state, chunk) =>
              chunk.byteLength > 4096 - state.bytes
                ? Effect.fail({ _tag: 'ProjectResumeBodyLimit' as const })
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
            code: 'PROJECT_INPUT_INVALID',
            message: '继续删除正文无效或超过大小限制',
          })),
        )
        const requestId = yield* Effect.try(() => decodeURIComponent(parts[5] ?? ''))
        yield* Effect.try(() => access.refresh(current))
        yield* resumeBusinessProjectDeletion({
          actorId: current.id,
          requestId,
          intent: input,
          directory,
          inspect,
        })
        return HttpServerResponse.jsonUnsafe(
          yield* Effect.try(() => {
            access.refresh(current)
            return directory.receipt(current.id, requestId)
          }),
          { headers: { 'cache-control': 'private, no-store' } },
        )
      }
      const input = yield* request.json.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(64)),
        Effect.mapError(() => ({
          status: 400,
          code: 'PROJECT_INPUT_INVALID',
          message: '配置正文无效或超过大小限制',
        })),
      )
      if (operation === 'delete-project')
        return HttpServerResponse.jsonUnsafe(
          yield* deleteBusinessProject({
            actorId: current.id,
            projectId: project,
            command: input,
            directory,
            inspect,
          }),
          { headers: { 'cache-control': 'private, no-store' } },
        )
      if (operation === 'delete-environment') {
        const environment = decodeURIComponent(parts[6] ?? '')
        return HttpServerResponse.jsonUnsafe(
          yield* deleteBusinessEnvironment({
            actorId: current.id,
            projectId: project,
            environmentId: environment,
            command: input,
            directory,
            inspect,
          }),
          { headers: { 'cache-control': 'private, no-store' } },
        )
      }
      const value = yield* Effect.try(() => {
        if (operation === 'create') return directory.create(current.id, input)
        if (operation === 'save') return directory.saveProject(current.id, project, input)
        if (operation === 'member-delete')
          return directory.removeMember(
            current.id,
            project,
            decodeURIComponent(parts[6] ?? ''),
            input,
            () =>
              configuredAutoOpsAssistantDirectory().purgeMember(
                project,
                decodeURIComponent(parts[6] ?? ''),
              ),
          )
        if (operation === 'member') return directory.saveMember(current.id, project, input)
        return directory.saveEnvironment(
          current.id,
          project,
          parts[6] ? decodeURIComponent(parts[6]) : null,
          input,
        )
      })
      // 业务收据先固定；原请求重试可继续完成原生项目登记，不创建第二个业务项目。
      if (operation === 'create' || operation === 'save')
        yield* synchronizeProject(value as { id: string; name: string; revision: number })
      const available = yield* Effect.try(() => {
        access.refresh(current)
        access.requireProjectAction(
          current,
          operation === 'create' ? (value as { id: string }).id : project,
          'project.manage',
        )
        return true
      }).pipe(
        Effect.catch((error) => {
          const status = (error.cause as { status?: number } | undefined)?.status
          return status === 403 || status === 404 ? Effect.succeed(false) : Effect.fail(error)
        }),
      )
      return HttpServerResponse.jsonUnsafe(available ? value : { saved: true, available: false }, {
        headers: { 'cache-control': 'private, no-store' },
      })
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))
  const base = '/api/v1/projects'
  return Layer.mergeAll(
    HttpRouter.add('GET', base, handle('list')),
    HttpRouter.add('GET', `${base}/receipts/:requestId`, handle('receipt')),
    HttpRouter.add('POST', `${base}/receipts/:requestId/resume`, handle('resume')),
    HttpRouter.add('POST', base, handle('create')),
    HttpRouter.add('GET', `${base}/:projectId/settings`, handle('settings')),
    HttpRouter.add('POST', `${base}/:projectId/settings`, handle('save')),
    HttpRouter.add('POST', `${base}/:projectId/environments`, handle('environment')),
    HttpRouter.add('POST', `${base}/:projectId/environments/:environmentId`, handle('environment')),
    HttpRouter.add('POST', `${base}/:projectId/members/:userId/remove`, handle('member-delete')),
    HttpRouter.add('POST', `${base}/:projectId/members`, handle('member')),
    HttpRouter.add('GET', `${base}/:projectId/deletion-preview`, handle('preview-project')),
    HttpRouter.add(
      'GET',
      `${base}/:projectId/environments/:environmentId/deletion-preview`,
      handle('preview-environment'),
    ),
    HttpRouter.add('DELETE', `${base}/:projectId`, handle('delete-project')),
    HttpRouter.add(
      'DELETE',
      `${base}/:projectId/environments/:environmentId`,
      handle('delete-environment'),
    ),
  )
}
