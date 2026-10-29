import * as ThreadManagement from '../orchestration-v2/ThreadManagementService.ts'
// @effect-diagnostics nodeBuiltinImport:off -- 使用隔离目录与真实原生持久事件验证项目删除协作。
import { assert, it } from '@effect/vitest'
import * as TestClock from 'effect/testing/TestClock'
import { vi } from 'vite-plus/test'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  CommandId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  EventId,
  type OrchestrationV2AppThread,
} from '@t3tools/contracts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Fiber from 'effect/Fiber'
import * as SqlClient from 'effect/sql/SqlClient'
import * as RuntimeLayer from '../orchestration-v2/runtimeLayer.ts'
import * as EventSink from '../orchestration-v2/EventSink.ts'
import * as ProjectionStore from '../orchestration-v2/ProjectionStore.ts'
import * as SqlitePersistence from '../persistence/Sqlite.ts'
import * as ServerConfig from '../config.ts'
import * as ServerSettings from '../serverSettings.ts'
import * as WorkspacePaths from '../workspace/WorkspacePaths.ts'
import * as ProjectEnrichmentService from '../project/ProjectEnrichmentService.ts'
import * as ProjectFaviconResolver from '../project/ProjectFaviconResolver.ts'
import * as RepositoryIdentityResolver from '../project/RepositoryIdentityResolver.ts'
import * as ProjectService from '../project/ProjectService.ts'
import {
  createProjectDirectory,
  type ProjectDirectory,
} from '../../../../../../agent-demo/t3-adapters/project-directory/index.ts'
const mocks = vi.hoisted(() => ({ directory: undefined as ProjectDirectory | undefined }))
vi.mock(import('../../../../../../agent-demo/t3-adapters/access.mjs'), async (original) => ({
  ...(await original()),
  isAutoOpsEnabled: () => true,
  configuredAutoOpsProjects: () => mocks.directory?.catalog.projects ?? [],
}))
import {
  deleteBusinessProject,
  resumeBusinessProjectDeletion,
  synchronizeProject,
  projectSynchronizationReferences,
} from './projects.ts'

const testLayer = RuntimeLayer.layerProjectService.pipe(
  Layer.provideMerge(Layer.merge(RuntimeLayer.layerEventSink, ProjectionStore.layer)),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(
    Layer.succeed(WorkspacePaths.WorkspacePaths, {
      normalizeWorkspaceRoot: (root) => Effect.succeed(root),
      resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
        Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
      resolvePath: () => Effect.succeed(null),
      invalidate: () => Effect.void,
    }),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: 'autoops-project-delete-' })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] } as never),
      dispatch: () => Effect.succeed({} as never),
    }),
  ),
)
const resource = Effect.acquireRelease(
  Effect.sync(() => {
    const dataDir = mkdtempSync(join(tmpdir(), 'business-project-delete-'))
    const directory = createProjectDirectory({
      dataDir,
      seed: {
        users: [{ id: 'actor', name: '隔离管理者', role: 'member' }],
        projects: [],
        agents: [],
      },
      authorize: (actor) => {
        assert.equal(actor, 'actor')
        return {
          userId: 'actor',
          role: 'project_admin',
          workspaceAccess: 'internal',
          environmentIds: [],
          status: 'active',
        }
      },
    })
    const project = directory.create('actor', {
      requestId: 'create-original',
      expectedRevision: 0,
      value: { name: '隔离删除', description: '' },
    })
    mocks.directory = directory
    const previous = { data: process.env.AUTOOPS_T3_DATA_DIR, model: process.env.AUTOOPS_T3_MODEL }
    process.env.AUTOOPS_T3_DATA_DIR = dataDir
    process.env.AUTOOPS_T3_MODEL = 'isolated-model'
    return { dataDir, directory, project, previous }
  }),
  (value) =>
    Effect.sync(() => {
      value.directory.close()
      rmSync(value.dataDir, { recursive: true, force: true })
      mocks.directory = undefined
      if (value.previous.data === undefined) delete process.env.AUTOOPS_T3_DATA_DIR
      else process.env.AUTOOPS_T3_DATA_DIR = value.previous.data
      if (value.previous.model === undefined) delete process.env.AUTOOPS_T3_MODEL
      else process.env.AUTOOPS_T3_MODEL = value.previous.model
    }),
)

it.layer(testLayer)('业务项目删除复用原生服务', (it) => {
  it.effect('项目与原生事件彻底清除，删除重试不重建项目', () =>
    Effect.gen(function* () {
      const f = yield* resource
      const projects = yield* ProjectService.ProjectService
      const id = ProjectId.make(f.project.id)
      yield* projects.create({
        projectId: id,
        commandId: CommandId.make('native-create'),
        title: '隔离删除',
        workspaceRoot: join(f.dataDir, 'native-workspace'),
        scripts: [],
      })
      const input = {
        actorId: 'actor',
        projectId: f.project.id,
        command: { requestId: 'delete-original', expectedRevision: 1 },
        directory: f.directory,
        inspect: Object.assign(() => [], { purge: async () => {}, threads: () => [] }),
      }
      assert.deepEqual(yield* deleteBusinessProject(input), {
        deleted: true,
        projectId: f.project.id,
      })
      assert.deepEqual(yield* deleteBusinessProject(input), {
        deleted: true,
        projectId: f.project.id,
      })
      assert.isTrue(Option.isNone(yield* projects.getById(id, { includeDeleted: true })))
      assert.deepEqual(f.directory.catalog.projects, [])
      const sql = yield* SqlClient.SqlClient
      const events = yield* sql<{
        n: number
      }>`SELECT COUNT(*) AS n FROM orchestration_events WHERE stream_id=${id} AND event_type='project.deleted'`
      assert.equal(events[0]?.n, 0)
      yield* synchronizeProject(f.project)
      assert.isTrue(Option.isNone(yield* projects.getById(id, { includeDeleted: true })))
    }),
  )
  it.effect('项目级联删除归档会话，资源清理未结束时保留待办，完成后清除正文', () =>
    Effect.gen(function* () {
      const f = yield* resource
      const projects = yield* ProjectService.ProjectService
      const id = ProjectId.make(f.project.id),
        threadId = ThreadId.make('private-archived-thread')
      yield* projects.create({
        projectId: id,
        commandId: CommandId.make('native-create-with-thread'),
        title: '隔离删除',
        workspaceRoot: join(f.dataDir, 'native-workspace'),
        scripts: [],
      })
      const command = { requestId: 'delete-original', expectedRevision: 1 }
      f.directory.beginProjectDeletion('actor', f.project.id, command, () => [])
      const at = DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
        provider = ProviderInstanceId.make('codex')
      const payload: OrchestrationV2AppThread = {
        createdBy: 'user',
        creationSource: 'web',
        id: threadId,
        projectId: id,
        title: '不可被项目管理员删除的私有历史',
        providerInstanceId: provider,
        modelSelection: { instanceId: provider, model: 'test-model' },
        runtimeMode: 'approval-required',
        interactionMode: 'default',
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: at,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      }
      const sink = yield* EventSink.EventSinkV2
      yield* sink.write({
        events: [
          {
            id: EventId.make('native-private-created'),
            type: 'thread.created',
            threadId,
            providerInstanceId: provider,
            occurredAt: at,
            payload,
          },
        ],
      })
      const input = {
        actorId: 'actor',
        projectId: f.project.id,
        command,
        directory: f.directory,
        inspect: Object.assign(() => [], { purge: async () => {}, threads: () => [] }),
      }
      const pending = yield* deleteBusinessProject(input).pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust('20 seconds')
      const failure = yield* Fiber.join(pending)
      assert.equal((failure as { code: string }).code, 'PROJECT_DELETE_PENDING')
      const projection = yield* ProjectionStore.ProjectionStoreV2
      const thread = yield* projection.getThreadRecords(threadId, [])
      assert.isNotNull(thread.thread.deletedAt)
      assert.equal(
        f.directory.beginProjectDeletion('actor', f.project.id, command, () => []).state,
        'pending',
      )
      const sql = yield* SqlClient.SqlClient
      const queued = yield* sql<{
        effect_type: string
      }>`SELECT effect_type FROM orchestration_v2_effect_outbox WHERE thread_id=${threadId}`
      assert.isTrue(queued.some((row) => row.effect_type === 'thread-data.cleanup'))
      // 此夹具无资源工作器；单独结算队列以验证项目协调器的续办，资源删除另有 owner 测试。
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status='succeeded' WHERE thread_id=${threadId}`
      assert.deepEqual(yield* deleteBusinessProject(input), {
        deleted: true,
        projectId: f.project.id,
      })
      assert.equal(
        (yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`)
          .length,
        0,
      )
    }),
  )
  it.effect('项目登记真正等待原生读取时预检可见，等待前后的新删除不能穿过初始化窗口', () =>
    Effect.gen(function* () {
      const f = yield* resource
      const projects = yield* ProjectService.ProjectService
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const scoped = ProjectService.ProjectService.of({
        ...projects,
        getById: (...args) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return yield* projects.getById(...args)
          }),
      })
      const pending = yield* synchronizeProject(f.project).pipe(
        Effect.provideService(ProjectService.ProjectService, scoped),
        Effect.forkChild,
      )
      yield* Deferred.await(entered)
      const inspect = () => projectSynchronizationReferences(f.project.id)
      assert.equal(
        f.directory.deletionPreview('actor', f.project.id, null, inspect).canDelete,
        false,
      )
      assert.throws(() =>
        f.directory.beginProjectDeletion(
          'actor',
          f.project.id,
          { requestId: 'during-sync', expectedRevision: 1 },
          inspect,
        ),
      )
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(pending)
      assert.deepEqual(inspect(), [])
      assert.equal(
        f.directory.deletionPreview('actor', f.project.id, null, inspect).canDelete,
        true,
      )
    }),
  )
  it.effect('原生数据已清理而业务收据失败时，原请求重试收口且不复活', () =>
    Effect.gen(function* () {
      const f = yield* resource
      const projects = yield* ProjectService.ProjectService
      const id = ProjectId.make(f.project.id)
      yield* projects.create({
        projectId: id,
        commandId: CommandId.make('native-create-before-audit-failure'),
        title: '删除审计恢复',
        workspaceRoot: join(f.dataDir, 'native-workspace'),
        scripts: [],
      })
      const input = {
        actorId: 'actor',
        projectId: f.project.id,
        command: { requestId: 'delete-after-native-commit', expectedRevision: 1 },
        directory: f.directory,
        inspect: Object.assign(() => [], { purge: async () => {}, threads: () => [] }),
      }
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(join(f.dataDir, 'project-directory', 'state.sqlite'))),
        (db) => Effect.sync(() => db.close()),
      )
      db.exec(
        "CREATE TRIGGER reject_completion BEFORE UPDATE ON directory_deletions WHEN NEW.state='deleted' BEGIN SELECT RAISE(ABORT,'隔离最终收据失败'); END",
      )
      const failure = yield* deleteBusinessProject(input).pipe(Effect.flip)
      assert.equal((failure as { code: string }).code, 'PROJECT_DELETE_PENDING')
      assert.isTrue(Option.isNone(yield* projects.getById(id, { includeDeleted: true })))
      assert.equal(
        f.directory.beginProjectDeletion('actor', f.project.id, input.command, () => []).state,
        'pending',
      )
      assert.equal(f.directory.receipt('actor', input.command.requestId)?.state, 'pending')
      assert.equal(f.directory.receipt('actor', input.command.requestId)?.canResume, true)
      db.exec('DROP TRIGGER reject_completion')
      const resume = {
        actorId: 'actor',
        requestId: input.command.requestId,
        intent: {
          operation: 'project.delete',
          projectId: f.project.id,
          publicIntent: { expectedRevision: 1 },
        },
        directory: f.directory,
        inspect: Object.assign(() => [], { purge: async () => {}, threads: () => [] }),
      }
      assert.deepEqual(yield* resumeBusinessProjectDeletion(resume), {
        deleted: true,
        projectId: f.project.id,
      })
      assert.deepEqual(yield* resumeBusinessProjectDeletion(resume), {
        deleted: true,
        projectId: f.project.id,
      })
      assert.equal(f.directory.receipt('actor', input.command.requestId)?.state, 'completed')
      const sql = yield* SqlClient.SqlClient
      const events = yield* sql<{
        n: number
      }>`SELECT COUNT(*) AS n FROM orchestration_events WHERE stream_id=${id} AND event_type='project.deleted'`
      assert.equal(events[0]?.n, 0)
    }),
  )
})
