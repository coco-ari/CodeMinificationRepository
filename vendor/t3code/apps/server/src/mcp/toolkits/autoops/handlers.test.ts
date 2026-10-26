// @effect-diagnostics nodeBuiltinImport:off -- 使用隔离 SQLite 与受控正文读取端口验证真实 MCP 注册，不启动模型或网络。
import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeSqlite from 'node:sqlite'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import { vi } from 'vite-plus/test'
import * as C from '@t3tools/contracts'
import * as McpProviderSessions from '@t3tools/provider-core/server/McpProviderSessions'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as NetAddress from 'effect/net/NetAddress'
import * as Schema from 'effect/Schema'
import { McpSchema, McpServer } from 'effect/ai'
import { HttpServer } from 'effect/http'
import type { AutoOpsAccess, AutoOpsProject } from '../../../../../../../../agent-demo/t3-adapters/access.mjs'

const mocks = vi.hoisted(() => ({
  access: undefined as AutoOpsAccess | undefined,
  workspace: undefined as ReturnType<typeof workspacePort> | undefined,
}))
vi.mock(import('../../../../../../../../agent-demo/t3-adapters/access.mjs'), async original => ({ ...await original(), configuredAutoOpsAccess: () => mocks.access }))
vi.mock(import('../../../../../../../../agent-demo/t3-adapters/workspace-management.ts'), async original => {
  const actual = await original()
  // 本次只替换正文存储外部端口；授权、轮次和 MCP 注册均执行生产逻辑。
  return { ...actual, configuredWorkspaceManagement: () => mocks.workspace as unknown as ReturnType<typeof actual.configuredWorkspaceManagement> }
})
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../../../../../../../../agent-demo/t3-adapters/access.mjs'
import { createNativeSubagentBindings } from '../../../../../../../../agent-demo/t3-adapters/subagents.mjs'
import * as ServerConfig from '../../../config.ts'
import * as ServerEnvironment from '../../../environment/ServerEnvironment.ts'
import * as Threads from '../../../orchestration-v2/ThreadManagementService.ts'
import * as Invocation from '../../McpInvocationContext.ts'
import * as Registry from '../../McpSessionRegistry.ts'
import { toolkitRegistration } from '../../McpHttpServer.ts'
import * as Handlers from './handlers.ts'
import { AutoOpsToolkit } from './tools.ts'

const threadId = C.ThreadId.make('business-thread')
const instanceId = C.ProviderInstanceId.make('codex')
const environmentId = C.EnvironmentId.make('native-environment')
const nativeSessionId = 'provider-session:provider-instance:codex:shared'
const inputId = 'fixed-input'
const runId = C.RunId.make('business-run')
const client = McpSchema.McpServerClient.of({ clientId: 1, protocolVersion: '2025-06-18', clientCapabilities: {}, clientInfo: { name: 'business-test', version: '1' }, initializePayload: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'business-test', version: '1' } }, getClient: Effect.die('unused') })

function workspacePort() {
  return {
    readInput: vi.fn(() => ({ id: inputId, projectId: 'project', workspaceType: 'internal', createdAt: '2026-10-26T00:00:00Z', revision: 1, repositories: [], sourceErrors: [], sourceWarnings: [] })),
    inputFiles: vi.fn(() => [{ path: 'proof.md', mime: 'text/markdown', size: 14 }]),
    readInputContent: vi.fn(async () => ({ contents: '本轮固定正文', extraction: {} })),
  }
}

const decodeProjection = Schema.decodeUnknownSync(C.OrchestrationV2ThreadProjection)
function projection() {
  const at = DateTime.makeUnsafe('2026-10-26T00:00:00Z')
  const nativeId = 'provider-thread:codex:original'
  const modelSelection = { instanceId: 'codex', model: 'actual-model' }
  const thread = { id: threadId, createdBy: 'user', creationSource: 'web', projectId: 'project', title: '隔离会话', providerInstanceId: instanceId, modelSelection, runtimeMode: 'approval-required', interactionMode: 'default', branch: null, worktreePath: null, activeProviderThreadId: nativeId, lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null }, forkedFrom: null, createdAt: at, updatedAt: at, archivedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null }
  const run = { id: runId, threadId, ordinal: 1, providerInstanceId: instanceId, modelSelection, providerThreadId: nativeId, userMessageId: 'message', rootNodeId: null, activeAttemptId: null, status: 'running', requestedAt: at, startedAt: at, completedAt: null, checkpointId: null, contextHandoffId: null }
  const providerThread = { id: nativeId, driver: 'codex', providerInstanceId: instanceId, providerSessionId: nativeSessionId, appThreadId: threadId, ownerNodeId: null, nativeThreadRef: null, nativeConversationHeadRef: null, status: 'active', firstRunOrdinal: 1, lastRunOrdinal: 1, handoffIds: [], forkedFrom: null, createdAt: at, updatedAt: at }
  return decodeProjection({ ...Object.fromEntries(Object.keys(C.OrchestrationV2ThreadProjection.fields).map(key => [key, []])), thread, runs: [run], providerThreads: [providerThread], updatedAt: at })
}

function setup() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'mcp-business-session-'))
  const sessions = new NodeSqlite.DatabaseSync(':memory:'), bindings = new NodeSqlite.DatabaseSync(NodePath.join(directory, 't3-autoops.sqlite'))
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(NodeCrypto.createHash('sha256').update('owner').digest('hex'), 'owner', 'csrf', 60_000)
  const membership: NonNullable<AutoOpsProject['memberships']>[number] = { userId: 'reader', role: 'reader', workspaceAccess: 'internal', environmentIds: ['test'], status: 'active' }
  const project: AutoOpsProject = { id: 'project', name: '隔离项目', memberIds: ['owner', 'reader'], memberships: [membership], environments: [{ id: 'test', name: '测试' }], documents: [], resources: [] }
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, now: () => 1000, catalog: { users: [{ id: 'owner', name: '创建者', role: 'admin' }, { id: 'reader', name: '调用者', role: 'member' }], projects: [project], agents: [{ id: 'helper', name: '助手', description: '', capabilities: [], projectIds: ['project'] }] } })
  access.bindThread(access.authenticateCookie('demo_session=owner'), { threadId, projectId: 'project', environmentId: 'test', agentId: 'helper', workspaceType: 'internal', visibility: 'project' })
  access.bindRunInput(threadId, runId, inputId, 'reader')
  const workspace = workspacePort()
  mocks.access = access; mocks.workspace = workspace
  const subagents = createNativeSubagentBindings(directory, access)
  const state = { projection: projection(), otherProjections: new Map<C.ThreadId, C.OrchestrationV2ThreadProjection>(), projectionRead: Effect.void }
  const layer = toolkitRegistration(AutoOpsToolkit, Handlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provide(Layer.mock(Threads.ThreadManagementService)({ getThreadProjection: id => state.projectionRead.pipe(Effect.map(() => state.otherProjections.get(id) ?? state.projection)) })),
    Layer.provide(ServerConfig.layerTest(directory, NodePath.join(directory, 'native'))),
    Layer.provide(NodeServices.layer),
  )
  return { access, workspace, membership, state, layer, subagents, [Symbol.dispose]() { mocks.access = undefined; mocks.workspace = undefined; subagents.close(); sessions.close(); bindings.close(); NodeFS.rmSync(directory, { recursive: true, force: true }) } }
}

const issuedScope = (callerThreadId = threadId) => Effect.gen(function* () {
  const registry = yield* Registry.__testing.make({ now: () => 1000, livenessWindowMs: 100 }).pipe(
    Effect.provideService(HttpServer.HttpServer, HttpServer.HttpServer.of({ address: NetAddress.inetAddressFromIpStringUnsafe('127.0.0.1', 43123), serve: (() => Effect.void) as HttpServer.HttpServer['Service']['serve'] })),
    Effect.provideService(ServerEnvironment.ServerEnvironment, ServerEnvironment.ServerEnvironment.of({ getEnvironmentId: Effect.succeed(environmentId), getDescriptor: Effect.die('unused') })),
    Effect.provide(NodeServices.layer),
  )
  const issued = yield* registry.issue({ threadId: callerThreadId, providerInstanceId: instanceId, capabilities: new Set(['autoops']) })
  const scope = yield* registry.resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ''))
  if (!scope) return yield* Effect.die('真实 Registry 未生成调用范围')
  const providerSessions = yield* McpProviderSessions.McpProviderSessions
  yield* providerSessions.set(issued.config)
  return { scope, config: issued.config, providerSessions, registry }
})

const call = (scope: Invocation.McpInvocationScope, name = 'read_project_document', arguments_: Record<string, unknown> = { inputId, id: 'proof.md' }) => McpServer.McpServer.pipe(Effect.flatMap(server => server.callTool({ name, arguments: arguments_ })), Effect.provideService(Invocation.McpInvocationContext, scope), Effect.provideService(McpSchema.McpServerClient, client))
const declaredFailure = (result: McpSchema.CallToolResult) => result.isError && result.content[0]?.type === 'text' ? JSON.parse(result.content[0].text) : undefined

it.effect('真实 MCP UUID 与原生逻辑 session 不同仍按当前线程配置读取固定输入', () => Effect.gen(function* () {
  using f = setup()
  yield* Effect.gen(function* () {
    const { scope } = yield* issuedScope()
    expect(scope.thread?.providerSessionId).not.toBe(nativeSessionId)
    const listed = yield* call(scope, 'list_project_materials', { inputId })
    expect(declaredFailure(listed)).toBeUndefined()
    expect(listed.structuredContent).toMatchObject({ source: 'workspace_input', documents: [{ id: 'proof.md' }] })
    const result = yield* call(scope)
    expect(declaredFailure(result)).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ content: '本轮固定正文', inputId, source: 'workspace_input' })
    expect(f.workspace.readInputContent).toHaveBeenCalledWith('project', inputId, 'proof.md', 'reader')
  }).pipe(Effect.provide(f.layer))
}))

it.effect.each(['cleared', 'rotated', 'other-thread', 'other-instance', 'other-environment', 'no-capability'] as const)('拒绝 %s 的凭据且不读取正文', kind => Effect.gen(function* () {
  using f = setup()
  yield* Effect.gen(function* () {
    const issued = yield* issuedScope()
    let scope = issued.scope
    if (kind === 'cleared') yield* issued.providerSessions.clear(threadId)
    if (kind === 'rotated') {
      const replacement = yield* issued.registry.issue({ threadId, providerInstanceId: instanceId, capabilities: new Set(['autoops']) })
      yield* issued.providerSessions.set(replacement.config)
    }
    if (kind === 'other-thread') scope = { ...scope, thread: { ...scope.thread!, threadId: C.ThreadId.make('another-thread') } }
    if (kind === 'other-instance') scope = { ...scope, thread: { ...scope.thread!, providerInstanceId: C.ProviderInstanceId.make('claude') } }
    if (kind === 'other-environment') scope = { ...scope, environmentId: C.EnvironmentId.make('another-environment') }
    if (kind === 'no-capability') scope = { ...scope, capabilities: new Set() }
    const result = yield* call(scope)
    expect(declaredFailure(result)).toMatchObject({ code: 'capability_denied' })
    expect(f.workspace.readInputContent).not.toHaveBeenCalled()
  }).pipe(Effect.provide(f.layer))
}))

it.effect.each(['native-thread', 'native-instance', 'active-thread', 'active-instance'] as const)('当前凭据仍拒绝不匹配的 %s 原生投影', kind => Effect.gen(function* () {
  using f = setup()
  const original = f.state.projection
  f.state.projection = {
    ...original,
    providerThreads: original.providerThreads.map(thread => ({ ...thread, ...(kind === 'native-thread' ? { appThreadId: C.ThreadId.make('another-thread') } : {}), ...(kind === 'native-instance' ? { providerInstanceId: C.ProviderInstanceId.make('claude') } : {}) })),
    runs: original.runs.map(run => ({ ...run, ...(kind === 'active-thread' ? { providerThreadId: C.ProviderThreadId.make('another-native-thread') } : {}), ...(kind === 'active-instance' ? { providerInstanceId: C.ProviderInstanceId.make('claude') } : {}) })),
  }
  yield* Effect.gen(function* () {
    const { scope } = yield* issuedScope()
    expect(declaredFailure(yield* call(scope))).toMatchObject({ code: 'capability_denied' })
    expect(f.workspace.readInputContent).not.toHaveBeenCalled()
  }).pipe(Effect.provide(f.layer))
}))

it.effect.each(['old-input', 'inactive-run', 'withdrawn', 'revoked'] as const)('当前凭据不能绕过 %s 的业务授权', kind => Effect.gen(function* () {
  using f = setup()
  f.access.bindRunInput(threadId, 'old-run', 'old-input', 'reader')
  if (kind === 'inactive-run') f.state.projection = { ...f.state.projection, runs: [] }
  if (kind === 'withdrawn') f.membership.environmentIds = []
  if (kind === 'revoked') f.access.markThreadDeleted(threadId)
  yield* Effect.gen(function* () {
    const { scope } = yield* issuedScope()
    const result = yield* call(scope, 'read_project_document', { inputId: kind === 'old-input' ? 'old-input' : inputId, id: 'proof.md' })
    expect(declaredFailure(result)).toMatchObject({ code: 'invalid_request' })
    expect(f.workspace.readInputContent).not.toHaveBeenCalled()
  }).pipe(Effect.provide(f.layer))
}))

it.effect('读取原生投影期间轮换凭据，迟到投影不能启动正文读取', () => Effect.gen(function* () {
  using f = setup()
  yield* Effect.gen(function* () {
    const { scope, config, providerSessions } = yield* issuedScope()
    const started = yield* Deferred.make<void>(), release = yield* Deferred.make<void>()
    f.state.projectionRead = Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
    const fiber = yield* call(scope).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* providerSessions.set({ ...config, providerSessionId: NodeCrypto.randomUUID() })
    yield* Deferred.succeed(release, undefined)
    const result = yield* Fiber.join(fiber)
    expect(declaredFailure(result)).toMatchObject({ code: 'capability_denied' })
    expect(f.workspace.readInputContent).not.toHaveBeenCalled()
  }).pipe(Effect.provide(f.layer))
}))

it.effect.each(['credential', 'withdrawal', 'round'] as const)('正文读取期间发生 %s 变化，迟到结果不能交付', kind => Effect.gen(function* () {
  using f = setup()
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<{ contents: string; extraction: Record<string, never> }>()
  f.workspace.readInputContent.mockImplementation(() => { started.resolve(); return release.promise })
  yield* Effect.gen(function* () {
    const { scope, config, providerSessions } = yield* issuedScope()
    const fiber = yield* call(scope).pipe(Effect.forkChild)
    yield* Effect.promise(() => started.promise)
    if (kind === 'credential') yield* providerSessions.set({ ...config, providerSessionId: NodeCrypto.randomUUID() })
    if (kind === 'withdrawal') f.membership.environmentIds = []
    if (kind === 'round') {
      f.access.bindRunInput(threadId, 'next-run', 'next-input', 'reader')
      f.state.projection = { ...f.state.projection, runs: f.state.projection.runs.map(run => ({ ...run, id: C.RunId.make('next-run'), ordinal: 2 })) }
    }
    release.resolve({ contents: '不能交付的迟到正文', extraction: {} })
    const result = yield* Fiber.join(fiber)
    expect(declaredFailure(result)).toMatchObject({ code: kind === 'credential' ? 'capability_denied' : 'invalid_request' })
    expect(result.structuredContent).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('不能交付的迟到正文')
    expect(f.workspace.readInputContent).toHaveBeenCalledOnce()
  }).pipe(Effect.provide(f.layer))
}))

it.effect('真实注册的原生子任务按本线程 MCP 凭据读取原父轮输入，不能借父凭据或父撤权', () => Effect.gen(function* () {
  using f = setup()
  const childId = C.ThreadId.make('native-child')
  f.subagents.register(threadId, childId, 'actual-native-child', runId)
  const parent = f.state.projection
  f.state.otherProjections.set(threadId, parent)
  f.state.projection = { ...parent, thread: { ...parent.thread, id: childId }, runs: [], providerThreads: parent.providerThreads.map(thread => ({ ...thread, appThreadId: childId, id: C.ProviderThreadId.make('provider-thread:child'), providerSessionId: C.ProviderSessionId.make('provider-session:child') })) }
  yield* Effect.gen(function* () {
    const parentCredential = yield* issuedScope()
    const childCredential = yield* issuedScope(childId)
    expect(declaredFailure(yield* call(childCredential.scope))).toBeUndefined()
    expect(f.workspace.readInputContent).toHaveBeenCalledWith('project', inputId, 'proof.md', 'reader')
    const disguisedParent = { ...parentCredential.scope, thread: { ...parentCredential.scope.thread!, threadId: childId } }
    expect(declaredFailure(yield* call(disguisedParent))).toMatchObject({ code: 'capability_denied' })
    f.access.markThreadDeleted(threadId)
    expect(declaredFailure(yield* call(childCredential.scope))).toMatchObject({ code: 'invalid_request' })
    expect(f.workspace.readInputContent).toHaveBeenCalledOnce()
  }).pipe(Effect.provide(f.layer))
}))
