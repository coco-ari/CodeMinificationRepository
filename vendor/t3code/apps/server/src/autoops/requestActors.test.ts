// @effect-diagnostics nodeBuiltinImport:off -- 只使用内存 SQLite 和虚构登录，不访问运行中的业务数据库。
import { expect, it, vi } from 'vite-plus/test'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as EventStore from '../orchestration-v2/EventStore.ts'
import * as SqlitePersistence from '../persistence/Sqlite.ts'
import * as Schema from 'effect/Schema'
import * as DateTime from 'effect/DateTime'
import * as C from '@t3tools/contracts'
import { queuedRunActorCommand } from './runActors.ts'
import type { AutoOpsAccess, AutoOpsProject } from '../../../../../../agent-demo/t3-adapters/access.mjs'
const mocks = vi.hoisted(() => ({ access: undefined as AutoOpsAccess | undefined }))
vi.mock(import('../../../../../../agent-demo/t3-adapters/access.mjs'), async original => ({ ...await original(), configuredAutoOpsAccess: () => mocks.access }))
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { CurrentAutoOpsPrincipal, withCommandPrincipal } from './RequestScope.ts'
import { prepareBusinessMessagePayload } from './messageContext.ts'

function setup() {
  const sessions = new DatabaseSync(':memory:'), bindings = new DatabaseSync(':memory:')
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  const users = [{ id: 'owner', name: '创建者', role: 'admin', status: 'active' }, { id: 'caller', name: '实际调用者', role: 'member', status: 'active' }, { id: 'other', name: '其他用户', role: 'member', status: 'active' }]
  const project: AutoOpsProject = { id: 'project', name: '隔离项目', memberIds: users.map(user => user.id), documents: [], resources: [], environments: [{ id: 'test', name: '测试' }], memberships: users.map(user => ({ userId: user.id, role: 'reader', workspaceAccess: 'internal', environmentIds: ['test'], status: 'active', canAdjustChat: true })) }
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, now: () => 1000, catalog: { users, projects: [project], agents: [{ id: 'helper', name: '项目助手', description: '', projectIds: ['project'], capabilities: [] }] } })
  mocks.access = access
  for (const user of users) {
    sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(user.id).digest('hex'), user.id, 'csrf', 60000)
    access.recordNativeSession(access.authenticateCookie(`demo_session=${user.id}`), user.id)
  }
  access.bindThread(access.authenticateCookie('demo_session=owner'), { threadId: 'shared', projectId: 'project', environmentId: 'test', agentId: 'helper', visibility: 'project', workspaceType: 'internal' })
  return { access, users, [Symbol.dispose]() { mocks.access = undefined; sessions.close(); bindings.close() } }
}
const message = { type: 'message.dispatch', threadId: 'shared', commandId: 'command', messageId: 'message', text: '一个问题', attachments: [] }

it('原生启动队列的同一身份同时约束授权、消息收据和执行上下文，不采用浏览器声明的创建者', async () => {
  using f = setup()
  const result = await Effect.runPromise(withCommandPrincipal(Effect.service(CurrentAutoOpsPrincipal), 'caller', 'orchestration.dispatchCommand', { ...message, actorId: 'owner', ownerId: 'owner' }))
  expect(result?.id).toBe('caller')
  expect(f.access.requireMessageActor('shared', 'message').actorId).toBe('caller')
  expect(f.access.getThreadBinding('shared')?.ownerId).toBe('owner')
  await expect(Effect.runPromise(withCommandPrincipal(Effect.void, 'other', 'orchestration.dispatchCommand', message))).rejects.toThrow('消息已固定其他调用者或原请求')
})

it('缺省初始消息身份在授权与真实启动输入中保持确定，同一请求恢复不换消息或调用者', async () => {
  using f = setup()
  const input = { threadId: 'shared', commandId: 'launch-command', projectId: 'project', initialMessage: { text: '首条问题', attachments: [] } }
  const prepared = prepareBusinessMessagePayload(f.access, 'orchestration.launchThread', input) as typeof input & { initialMessage: { messageId: string } }
  expect(prepared.initialMessage.messageId).toBeTruthy()
  expect(prepareBusinessMessagePayload(f.access, 'orchestration.launchThread', input)).toEqual(prepared)
  await Effect.runPromise(withCommandPrincipal(Effect.void, 'caller', 'orchestration.launchThread', prepared))
  await Effect.runPromise(withCommandPrincipal(Effect.void, 'caller', 'orchestration.launchThread', prepared))
  expect(f.access.requireMessageActor('shared', prepared.initialMessage.messageId).actorId).toBe('caller')
})

it('排队后账号被停用时不执行原生命令，也不产生可恢复的冒名消息记录', async () => {
  using f = setup()
  const native = vi.fn()
  const queued = withCommandPrincipal(Effect.sync(native), 'caller', 'orchestration.dispatchCommand', message)
  f.users.find(user => user.id === 'caller')!.status = 'disabled'
  await expect(Effect.runPromise(queued)).rejects.toThrow('登录已失效')
  expect(native).not.toHaveBeenCalled()
  expect(() => f.access.requireMessageActor('shared', 'message')).toThrow('消息缺少可信调用者记录')
})


it('排队编辑只按原生已提交事件选择真实编辑者，拒绝或迟到候选不能夺取执行身份', async () => {
  using f = setup()
  f.access.recordQueuedEditActor(f.access.authenticateCookie('demo_session=other'), 'shared', 'accepted-edit', 'queued-run')
  f.access.recordQueuedEditActor(f.access.authenticateCookie('demo_session=owner'), 'shared', 'rejected-later-edit', 'queued-run')
  const at = DateTime.makeUnsafe('2026-10-26T00:00:00Z')
  const stored = (sequence: number, commandId: string, messageId = 'queued-message') => Schema.decodeUnknownSync(C.OrchestrationV2StoredEvent)({ sequence, commandId,
    event: { id: `event-${sequence}`, type: 'message.updated', threadId: 'shared', runId: 'queued-run', occurredAt: at,
      payload: { id: messageId, threadId: 'shared', runId: 'queued-run', nodeId: null, role: 'user', text: '已编辑的问题', createdBy: 'user', creationSource: 'web', attachments: [], streaming: false, createdAt: at, updatedAt: at } },
  })
  const command = await Effect.runPromise(Effect.gen(function* () {
    const events = yield* EventStore.EventStoreV2
    for (const row of [stored(1, 'accepted-edit'), stored(2, 'system-update'), stored(3, 'rejected-later-edit', 'other-message')])
      yield* events.append({ commandId: row.commandId!, events: [row.event] })
    return yield* queuedRunActorCommand(f.access, events.read, C.ThreadId.make('shared'), C.RunId.make('queued-run'), C.MessageId.make('queued-message'))
  }).pipe(Effect.provide(EventStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))), Effect.scoped))
  expect(command).toBe('accepted-edit')
  expect(f.access.requireQueuedEditActor('shared', command!, 'queued-run').actorId).toBe('other')
  expect(() => f.access.recordQueuedEditActor(f.access.authenticateCookie('demo_session=caller'), 'shared', 'accepted-edit', 'queued-run')).toThrow('原编辑请求已属于其他调用者或任务')
})
