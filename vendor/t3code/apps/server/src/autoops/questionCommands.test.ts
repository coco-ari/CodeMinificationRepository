// @effect-diagnostics nodeBuiltinImport:off -- 仅以临时 SQLite 和原生读取端口夹具验证准入，不连接真实模型。
import { expect, it, vi } from 'vite-plus/test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Deferred from 'effect/Deferred'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as DateTime from 'effect/DateTime'
import * as Exit from 'effect/Exit'
import * as C from '@t3tools/contracts'
import * as Threads from '../orchestration-v2/ThreadManagementService.ts'
import { createAssistantDirectory, questionConfigurationPolicy } from '../../../../../../agent-demo/t3-adapters/assistants/index.ts'
import { readBusinessModels } from '../../../../../../agent-demo/t3-adapters/models.mjs'
import type { AutoOpsAccess, AutoOpsProject, AutoOpsAgent } from '../../../../../../agent-demo/t3-adapters/access.mjs'
const mocks = vi.hoisted(() => ({ access: undefined as AutoOpsAccess | undefined }))
vi.mock(import('../../../../../../agent-demo/t3-adapters/access.mjs'), async original => ({ ...await original(), configuredAutoOpsAccess: () => mocks.access }))
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { withCommandPrincipal } from './RequestScope.ts'
const model = (effort = 'low') => ({ instanceId: 'codex', model: 'actual-model', options: [{ id: 'reasoningEffort', value: effort }] })
function setup(direct = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'question-command-')), sessions = new DatabaseSync(':memory:'), bindings = new DatabaseSync(':memory:')
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)'); initializeAutoOpsAccessSchema(bindings)
  const project: AutoOpsProject = { id: 'project', name: '项目', documents: [], resources: [], environments: [], memberIds: ['reader'], memberships: [{ userId: 'reader', role: 'reader', workspaceAccess: 'internal', environmentIds: [], status: 'active', canAdjustChat: direct }] }
  const agents: AutoOpsAgent[] = [{ id: 'a-project', name: '项目开发', description: '', projectIds: ['project'], capabilities: [] }]
  let assistants: ReturnType<typeof createAssistantDirectory>
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, now: () => 1000, catalog: { users: [{ id: 'admin', name: '管理员', role: 'admin' }, { id: 'reader', name: '成员', role: 'member' }], projects: [project], agents }, questions: () => assistants })
  mkdirSync(join(dataDir, 't3'))
  writeFileSync(join(dataDir, 't3/models-catalog.json'), JSON.stringify({ version: 1, source: 'https://catalog.example/models', models: [{ id: 'actual-model', name: '登记模型', reasoningLevels: ['low', 'high'], defaultReasoning: 'low', inputModalities: ['text'] }] }))
  assistants = createAssistantDirectory({ dataDir, membership: (actor, id) => access.requireProjectActionForActor(actor, id, 'chat.use'), manage: (actor, id) => access.requireProjectActionForActor(actor, id, 'project.manage'), validate: questionConfigurationPolicy({ projects: () => [project], agents: () => agents, models: () => readBusinessModels(dataDir, 'actual-model'), skills: () => [], customers: () => access.customerRegistry }), validateTarget: () => {} })
  sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('reader').digest('hex'), 'reader', 'csrf', 60_000)
  const principal = access.authenticateCookie('demo_session=reader'); access.recordNativeSession(principal, 'reader-native')
  const preset = assistants.save('admin', 'project', null, { requestId: 'preset', expectedRevision: 0, value: { name: '只读助手', description: '', instructions: '', enabled: true, configuration: { agentId: 'a-project', executionBinding: { kind: 'platform' }, environmentId: null, workspaceType: 'internal', visibility: 'project', model: { instanceId: 'codex', model: 'actual-model', reasoningEffort: 'low' }, skillIds: [] } } })
  const assignment = { requestId: 'assignment', expectedRevision: 0, target: { kind: 'role', id: 'reader' }, assistantIds: [preset.id], defaultAssistantId: preset.id }
  assistants.assign('admin', 'project', assignment)
  access.reserveThread(principal, { threadId: 'question-thread', projectId: 'project', environmentId: null, agentId: 'a-project', visibility: 'project', workspaceType: 'internal', question: direct ? { assistantId: null, presetRevision: null, configuration: preset.configuration } : { assistantId: preset.id, presetRevision: 1, configuration: preset.configuration } }); access.markThreadAccepted('question-thread')
  mocks.access = access
  return { access, assistants, assignment, project, [Symbol.dispose]() { mocks.access = undefined; assistants.close(); sessions.close(); bindings.close(); rmSync(dataDir, { recursive: true, force: true }) } }
}
function projection(effort: string) {
  const at = DateTime.makeUnsafe('2026-10-26T00:00:00Z')
  const thread = { id: 'question-thread', createdBy: 'user', creationSource: 'web', projectId: 'project', title: '原生会话', providerInstanceId: 'codex', modelSelection: model(effort), runtimeMode: 'approval-required', interactionMode: 'default', branch: null, worktreePath: null, activeProviderThreadId: null, lineage: { parentThreadId: null, rootThreadId: 'question-thread', relationshipToParent: null }, forkedFrom: null, createdAt: at, updatedAt: at, archivedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null }
  const run = { id: 'queued-run', threadId: thread.id, ordinal: 1, providerInstanceId: 'codex', modelSelection: model(effort), providerThreadId: null, userMessageId: 'queued-message', rootNodeId: null, activeAttemptId: null, status: 'queued', requestedAt: at, startedAt: null, completedAt: null, checkpointId: null, contextHandoffId: null }
  return Schema.decodeUnknownSync(C.OrchestrationV2ThreadProjection)({ ...Object.fromEntries(Object.keys(C.OrchestrationV2ThreadProjection.fields).map(key => [key, []])), thread, runs: [run], updatedAt: at })
}
const command = (type: string) => ({ type, commandId: 'native-command', threadId: 'question-thread', runId: 'queued-run', text: '继续原问题', attachments: [] })
const provide = (read: Effect.Effect<C.OrchestrationV2ThreadProjection>) => Layer.mock(Threads.ThreadManagementService)({ getThreadProjection: () => read })

it.each(['queued-run.edit', 'prepared-run.retry', 'queue.resume', 'message.dispatch'])('直接配置的 %s 使用原生参数且撤回调整权限后禁止继续', async type => {
  using f = setup(true); const native = vi.fn()
  const run = () => withCommandPrincipal(Effect.sync(native), 'reader-native', 'orchestration.dispatchCommand', command(type)).pipe(Effect.provide(provide(Effect.succeed(projection('high')))))
  await Effect.runPromise(run())
  expect(native).toHaveBeenCalledTimes(1)
  f.project.memberships![0]!.canAdjustChat = false
  await expect(Effect.runPromise(run())).rejects.toThrow('当前成员须使用已分配的助手预设')
  expect(native).toHaveBeenCalledTimes(1)
})

it.each(['queued-run.edit', 'prepared-run.retry', 'queue.resume', 'message.dispatch'])('省略模型的 %s 按原生已固定参数拒绝越过受限预设，拒绝前不执行或固定编辑者', async type => {
  using f = setup(); const native = vi.fn()
  const run = withCommandPrincipal(Effect.sync(native), 'reader-native', 'orchestration.dispatchCommand', { ...command(type), messageId: 'new-message' }).pipe(Effect.provide(provide(Effect.succeed(projection('high')))))
  await expect(Effect.runPromise(run)).rejects.toThrow('当前成员只能使用已分配预设的参数')
  expect(native).not.toHaveBeenCalled()
  expect(f.access.getQueuedEditActor('question-thread', 'native-command', 'queued-run')).toBeUndefined()
})

it('合法排队编辑保留真实成员身份并执行一次，原生读取能力缺失时拒绝', async () => {
  using f = setup(); const native = vi.fn()
  const effect = () => withCommandPrincipal(Effect.sync(native), 'reader-native', 'orchestration.dispatchCommand', command('queued-run.edit'))
  await expect(Effect.runPromise(effect())).rejects.toThrow('原生问答参数读取尚未就绪')
  expect(native).not.toHaveBeenCalled()
  await Effect.runPromise(effect().pipe(Effect.provide(provide(Effect.succeed(projection('low'))))))
  expect(native).toHaveBeenCalledTimes(1)
  expect(f.access.requireQueuedEditActor('question-thread', 'native-command', 'queued-run').actorId).toBe('reader')
})

it('原生参数读取期间撤回默认分配，迟到读取不能继续执行或登记原生编辑者', async () => {
  using f = setup(); const native = vi.fn()
  await Effect.runPromise(Effect.gen(function* () {
    const started = yield* Deferred.make<void>(), release = yield* Deferred.make<void>()
    const read = Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(projection('low')))
    const fiber = yield* withCommandPrincipal(Effect.sync(native), 'reader-native', 'orchestration.dispatchCommand', command('queued-run.edit')).pipe(Effect.provide(provide(read)), Effect.forkChild)
    yield* Deferred.await(started)
    f.assistants.assign('admin', 'project', { ...f.assignment, requestId: 'withdraw', expectedRevision: 1, assistantIds: [], defaultAssistantId: null })
    yield* Deferred.succeed(release, undefined)
    const result = yield* Effect.exit(Fiber.join(fiber))
    expect(Exit.isFailure(result)).toBe(true)
  }))
  expect(native).not.toHaveBeenCalled()
  expect(f.access.getQueuedEditActor('question-thread', 'native-command', 'queued-run')).toBeUndefined()
})
