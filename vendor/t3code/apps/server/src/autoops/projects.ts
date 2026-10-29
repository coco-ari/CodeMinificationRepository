import { CommandId, ThreadId, ProjectId, ProviderInstanceId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as ProjectService from '../project/ProjectService.ts'
import { purgeDeletedData } from '../orchestration-v2/DeletedDataCleanup.ts'
import * as ThreadManagement from '../orchestration-v2/ThreadManagementService.ts'
import type { ProjectDirectory } from '../../../../../../agent-demo/t3-adapters/project-directory/index.ts'
import type { ProjectDeletionInspection } from '../../../../../../agent-demo/t3-adapters/project-deletion.ts'
import type { DeletionBlocker } from '../../../../../../autoops/contracts/project-directory.ts'
import {
  configuredAutoOpsProjects,
  isAutoOpsEnabled,
} from '../../../../../../agent-demo/t3-adapters/access.mjs'

const synchronizations = new Map<string, number>()
export const projectSynchronizationReferences = (project: string): DeletionBlocker[] => {
  const count = synchronizations.get(project) ?? 0
  return count
    ? [{ kind: 'native-project-synchronization', count, message: '原生项目仍在登记或更新' }]
    : []
}

/** 只证明当前原生投影匹配已保存目标；不代替原同步收据，也不执行补写。 */
export const inspectProjectSynchronization = Effect.fn('AutoOps.inspectProjectSynchronization')(
  (project: { readonly id: string; readonly name: string }) =>
    Effect.gen(function* () {
      const dataDir = process.env.AUTOOPS_T3_DATA_DIR
      const model = process.env.AUTOOPS_T3_MODEL || process.env.AGENT_DEMO_MODEL
      if (!dataDir?.trim() || !model?.trim()) return 'unverified' as const
      const projects = yield* ProjectService.ProjectService
      const path = yield* Path.Path
      const current = yield* projects.getById(ProjectId.make(project.id), { includeDeleted: true })
      if (Option.isNone(current)) return 'unverified' as const
      const value = current.value
      return value.id === project.id &&
        value.deletedAt === null &&
        value.title === project.name &&
        value.workspaceRoot === path.resolve(dataDir, 't3', 'workspaces', project.id) &&
        value.defaultModelSelection?.instanceId === 'codex' &&
        value.defaultModelSelection.model === model &&
        value.autoPull === false
        ? ('current-verified' as const)
        : ('unverified' as const)
    }).pipe(Effect.catchCause(() => Effect.succeed('unverified' as const))),
)

/** 项目创建与事件仍归原生服务，业务目录只限定根目录及项目元数据。 */
export const synchronizeProject = Effect.fn('AutoOps.synchronizeProject')(
  (project: { readonly id: string; readonly name: string; readonly revision?: number }) =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        synchronizations.set(project.id, (synchronizations.get(project.id) ?? 0) + 1),
      ),
      () =>
        Effect.gen(function* () {
          if (!isAutoOpsEnabled()) return
          if (!configuredAutoOpsProjects().some((value) => value.id === project.id)) return
          const projects = yield* ProjectService.ProjectService
          const path = yield* Path.Path
          const dataDir = process.env.AUTOOPS_T3_DATA_DIR
          const model = process.env.AUTOOPS_T3_MODEL || process.env.AGENT_DEMO_MODEL
          if (!dataDir?.trim() || !model?.trim())
            return yield* Effect.die(
              new Error('AutoOps data directory and fixed model must be configured.'),
            )
          const projectId = ProjectId.make(project.id)
          const workspaceRoot = path.resolve(dataDir, 't3', 'workspaces', project.id)
          const current = yield* projects.getById(projectId, { includeDeleted: true })
          if (!configuredAutoOpsProjects().some((value) => value.id === project.id)) return
          if (Option.isSome(current)) {
            if (current.value.deletedAt !== null || current.value.workspaceRoot !== workspaceRoot)
              return yield* Effect.die(
                new Error(`AutoOps project ${project.id} conflicts with its registered workspace.`),
              )
          } else {
            yield* projects.create({
              commandId: CommandId.make(`autoops:project:create:${project.id}:v1`),
              projectId,
              title: project.name,
              workspaceRoot,
              createWorkspaceRootIfMissing: true,
              scripts: [],
            })
          }
          if (
            configuredAutoOpsProjects().some((value) => value.id === project.id) &&
            (Option.isNone(current) ||
              current.value.title !== project.name ||
              current.value.defaultModelSelection?.model !== model ||
              current.value.defaultModelSelection?.instanceId !== 'codex' ||
              current.value.autoPull !== false)
          ) {
            yield* projects.update({
              commandId: CommandId.make(
                `autoops:project:model:${project.id}:${model}:${project.revision ?? 0}:v2`,
              ),
              projectId,
              title: project.name,
              defaultModelSelection: { instanceId: ProviderInstanceId.make('codex'), model },
              autoPull: false,
              scripts: [],
            })
          }
        }),
      () =>
        Effect.sync(() => {
          const count = (synchronizations.get(project.id) ?? 1) - 1
          if (count) synchronizations.set(project.id, count)
          else synchronizations.delete(project.id)
        }),
    ),
)

export const deleteBusinessProject = Effect.fn('AutoOps.deleteBusinessProject')(function* (input: {
  actorId: string
  projectId: string
  command: unknown
  directory: ProjectDirectory
  inspect: ProjectDeletionInspection
}) {
  const { directory, actorId, projectId, command, inspect } = input
  const receipt = yield* Effect.try(() =>
    directory.beginProjectDeletion(actorId, projectId, command, () => [
      ...inspect(projectId),
      ...projectSynchronizationReferences(projectId),
    ]),
  )
  if (receipt.state === 'blocked')
    return yield* Effect.fail({
      status: 409,
      code: 'PROJECT_DELETE_BLOCKED',
      message: '项目仍有会话，尚未删除；请刷新后核对引用',
    })
  if (receipt.state === 'deleted') return { deleted: true as const, projectId }
  const projects = yield* ProjectService.ProjectService
  const nativeId = ProjectId.make(projectId)
  const current = yield* projects
    .getById(nativeId, { includeDeleted: true })
    .pipe(
      Effect.mapError((error) => ({
        status: 503,
        code: 'PROJECT_DELETE_PENDING',
        message: '原生项目状态尚待核对，请重试原请求',
        cause: error,
      })),
    )
  if (Option.isSome(current)) {
    const removed = yield* projects
      .delete({
        projectId: nativeId,
        commandId: CommandId.make(`autoops:project:delete:${projectId}:${receipt.requestId}`),
        force: true,
      })
      .pipe(
        Effect.as(true),
        Effect.catchTag('ProjectNotEmptyError', () =>
          Effect.try(() => {
            directory.blockProjectDeletion(actorId, projectId, command, [
              {
                kind: 'native-threads',
                count: 1,
                message: '原生项目仍有会话（包含私有及归档会话）',
              },
            ])
            return false
          }),
        ),
        Effect.mapError((error) => ({
          status: 503,
          code: 'PROJECT_DELETE_PENDING',
          message: '原生删除结果尚待核对，请重试原请求',
          cause: error,
        })),
      )
    if (!removed)
      return yield* Effect.fail({
        status: 409,
        code: 'PROJECT_DELETE_BLOCKED',
        message: '原生项目仍有会话，尚未删除；未删除任何会话',
      })
  }
  if (!inspect.purge)
    return yield* Effect.fail({
      status: 503,
      code: 'PROJECT_DELETE_PENDING',
      message: '关联清理尚未装配，请继续原删除',
    })
  yield* purgeDeletedData({ projectId }).pipe(
    Effect.mapError((cause) => ({
      status: 503,
      code: 'PROJECT_DELETE_PENDING',
      message: cause.message,
      cause,
    })),
  )
  yield* Effect.tryPromise(() => inspect.purge!(projectId)).pipe(
    Effect.mapError((cause) => ({
      status: 503,
      code: 'PROJECT_DELETE_PENDING',
      message: '关联数据删除尚未完成，请继续原删除',
      cause,
    })),
  )
  return yield* Effect.try(() =>
    directory.completeProjectDeletion(actorId, projectId, command),
  ).pipe(
    Effect.mapError((error) => ({
      status: 503,
      code: 'PROJECT_DELETE_PENDING',
      message: '原生删除已受理，业务收据尚待核对，请重试原请求',
      cause: error,
    })),
  )
})

export const deleteBusinessEnvironment = Effect.fn('AutoOps.deleteBusinessEnvironment')(
  function* (input: {
    actorId: string
    projectId: string
    environmentId: string
    command: unknown
    directory: ProjectDirectory
    inspect: ProjectDeletionInspection
  }) {
    const { actorId, projectId, environmentId, command, directory, inspect } = input
    if (!inspect.purge || !inspect.threads)
      return yield* Effect.fail({
        status: 503,
        code: 'PROJECT_DELETE_PENDING',
        message: '关联清理尚未装配',
      })
    const receipt = yield* Effect.try(() =>
      directory.beginEnvironmentDeletion(actorId, projectId, environmentId, command),
    )
    if (receipt.state === 'deleted') return { deleted: true as const, projectId, environmentId }
    const threads = yield* ThreadManagement.ThreadManagementService
    const snapshot = yield* threads.getShellSnapshot()
    const active = new Set(
      [...snapshot.threads, ...snapshot.archivedThreads].map((value) => String(value.id)),
    )
    for (const id of inspect.threads(projectId, environmentId))
      if (active.has(id)) {
        yield* threads.dispatch({
          type: 'thread.delete',
          threadId: ThreadId.make(id),
          commandId: CommandId.make(`autoops:environment:delete:${receipt.requestId}:${id}`),
        })
      }
    yield* purgeDeletedData({ threadIds: inspect.threads(projectId, environmentId) }).pipe(
      Effect.mapError((cause) => ({
        status: 503,
        code: 'PROJECT_DELETE_PENDING',
        message: cause.message,
        cause,
      })),
    )
    yield* Effect.tryPromise(() => inspect.purge!(projectId, environmentId)).pipe(
      Effect.mapError((cause) => ({
        status: 503,
        code: 'PROJECT_DELETE_PENDING',
        message: '关联数据删除未完成，请继续原删除',
        cause,
      })),
    )
    return yield* Effect.try(() =>
      directory.deleteEnvironment(actorId, projectId, environmentId, command, () => []),
    )
  },
)

/** 显式继续已受理的原删除；引用、身份和命令仍由原 owner 与原生服务裁决。 */
export const resumeBusinessProjectDeletion = Effect.fn('AutoOps.resumeBusinessProjectDeletion')(
  function* (input: {
    actorId: string
    requestId: string
    intent: unknown
    directory: ProjectDirectory
    inspect: ProjectDeletionInspection
  }) {
    const accepted = yield* Effect.try(() =>
      input.directory.resumeProjectDeletion(
        input.actorId,
        input.requestId,
        input.intent,
        (project, environment) => [
          ...input.inspect(project, environment),
          ...projectSynchronizationReferences(project),
        ],
      ),
    )
    if (accepted.environmentId)
      return yield* deleteBusinessEnvironment({
        ...input,
        projectId: accepted.projectId,
        environmentId: accepted.environmentId,
        command: accepted.command,
      })
    return yield* deleteBusinessProject({
      actorId: input.actorId,
      projectId: accepted.projectId,
      command: accepted.command,
      directory: input.directory,
      inspect: input.inspect,
    })
  },
)

export const initializeProjects = Effect.gen(function* () {
  if (!isAutoOpsEnabled()) return
  for (const project of configuredAutoOpsProjects()) yield* synchronizeProject(project)
})
