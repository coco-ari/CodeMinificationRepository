import { expect, it } from 'vite-plus/test'
import { DatabaseSync } from 'node:sqlite'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { BusinessRuntime, layer, stopping } from './BusinessRuntime.ts'
import { configuredAutoOpsAccess } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { configuredWorkspaceStore } from '../../../../../../agent-demo/t3-adapters/workspaces.mjs'

it('请求退出后先排空业务，消费者随后释放，身份资源最后关闭', async () => {
  const events: string[] = []
  let accepting = true
  let resourcesOpen = true
  const runtime = Layer.effect(
    BusinessRuntime,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          resourcesOpen = false
          events.push('resources-closed')
        }),
      )
      return {
        initialize() {
          return undefined
        },
        stopAccepting() {
          accepting = false
        },
        async drain() {
          accepting = false
          events.push('drained')
        },
        async close() {},
      }
    }),
  )
  const consumers = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* BusinessRuntime
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          expect(accepting).toBe(false)
          expect(resourcesOpen).toBe(true)
          events.push('consumers-closed')
        }),
      )
    }),
  )
  const requests = Layer.effectDiscard(
    Effect.addFinalizer(() =>
      Effect.sync(() => {
        events.push('requests-closed')
      }),
    ),
  )
  await Effect.runPromise(
    Effect.scoped(
      Layer.build(
        requests.pipe(Layer.provide(stopping), Layer.provide(consumers), Layer.provide(runtime)),
      ),
    ),
  )
  expect(events).toEqual(['requests-closed', 'drained', 'consumers-closed', 'resources-closed'])
})

it('真实宿主层初始化失败也关闭已获取资源，关闭后惰性入口拒绝重建', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'autoops-effect-initialize-' })
      const previous = process.env.AUTOOPS_T3_DATA_DIR
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.AUTOOPS_T3_DATA_DIR
          else process.env.AUTOOPS_T3_DATA_DIR = previous
        }),
      )
      process.env.AUTOOPS_T3_DATA_DIR = directory
      const sessions = new DatabaseSync(path.join(directory, 'demo.sqlite'))
      try {
        sessions.exec(
          'CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)',
        )
      } finally {
        sessions.close()
      }
      const bindings = new DatabaseSync(path.join(directory, 't3-autoops.sqlite'))
      try {
        bindings.exec('CREATE TABLE t3_thread_bindings(broken TEXT)')
      } finally {
        bindings.close()
      }
      const result = yield* Effect.exit(Effect.scoped(Layer.build(layer)))
      expect(result._tag).toBe('Failure')
      expect(() => configuredAutoOpsAccess()).toThrow(
        expect.objectContaining({ code: 'AUTOOPS_STOPPING' }),
      )
      expect(() => configuredWorkspaceStore()).toThrow(
        expect.objectContaining({ code: 'WORKSPACE_STOPPING' }),
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
