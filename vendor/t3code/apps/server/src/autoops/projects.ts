import { CommandId, ProjectId, ProviderInstanceId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as ProjectService from '../project/ProjectService.ts'
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
        force: false,
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

export const initializeProjects = Effect.gen(function* () {
  if (!isAutoOpsEnabled()) return
  for (const project of configuredAutoOpsProjects()) yield* synchronizeProject(project)
})
