import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createCodexBridge, runnerResponseError } from '../agent-demo/codex-bridge.mjs'
import { contextFor } from '../agent-demo/fixtures.mjs'

// Protocol integration only: injected runner, synthetic documents, loopback
// HTTP. Never invokes Codex or a provider; real verification is separate.
const temporary = await mkdtemp(join(tmpdir(), 'autoops-native-sessions-'))
const token = 'native-session-test-only-token-0000000000000000'
const calls = [],
  checks = [],
  replies = [],
  deleteFailures = new Map(),
  nativeThreads = new Map()
let emit,
  bridge,
  base,
  sequence = 0,
  nativeThreadSequence = 0,
  failResume = false,
  attachmentReads = 0
const metadata = (threadId) => ({
  thread: { id: threadId },
  activePermissionProfile: { id: 'agent_demo' },
  approvalPolicy: 'never',
  sandbox: { type: 'readOnly', networkAccess: false },
})
async function launch() {
  bridge = await createCodexBridge({
    enabled: true,
    token,
    model: 'protocol-only',
    codexHome: join(temporary, 'empty-home'),
    stateDir: join(temporary, 'state'),
    readAttachment: async (_runId, id) => {
      attachmentReads++
      return {
        file: {
          id,
          content: 'historical-text-from-authorized-host',
          extraction: { status: 'ready', format: 'text' },
        },
      }
    },
    runnerFactory(onMessage) {
      emit = onMessage
      return {
        async request(method, params) {
          calls.push({ method, params })
          if (method === 'account/read') return { requiresOpenaiAuth: false }
          if (method === 'thread/start') {
            const id = `native_${++nativeThreadSequence}`
            nativeThreads.set(id, { total: 0 })
            return metadata(id)
          }
          if (method === 'thread/resume') {
            if (failResume) throw new Error('synthetic resume failure')
            assert(nativeThreads.has(params.threadId))
            return metadata(params.threadId)
          }
          if (method === 'thread/delete') {
            if (deleteFailures.has(params.threadId))
              throw runnerResponseError(
                method,
                params.threadId,
                deleteFailures.get(params.threadId),
              )
            if (!nativeThreads.has(params.threadId))
              throw runnerResponseError(method, params.threadId, {
                code: -32600,
                message: `no rollout found for thread id ${params.threadId}`,
              })
            nativeThreads.delete(params.threadId)
            return {}
          }
          if (method === 'turn/start') {
            const threadId = params.threadId,
              turnId = `native_turn_${++sequence}`
            const native = nativeThreads.get(threadId)
            await emit({ method: 'turn/started', params: { threadId, turn: { id: turnId } } })
            if (params.input[0].text.endsWith('hold')) return { turn: { id: turnId } }
            if (params.input[0].text.endsWith('read-files')) {
              for (const id of ['ref-old', 'ref-old', 'ref-missing'])
                await emit({
                  id: `call-${sequence}-${replies.length}`,
                  method: 'item/tool/call',
                  params: {
                    threadId,
                    turnId,
                    callId: `file-${replies.length}`,
                    tool: 'read_attachment',
                    arguments: { id },
                  },
                })
            }
            if (params.input[0].text.endsWith('compact')) {
              for (const suffix of ['started', 'completed'])
                await emit({
                  method: `item/${suffix}`,
                  params: {
                    threadId,
                    turnId,
                    item: { id: 'native-compact', type: 'contextCompaction' },
                  },
                })
            }
            native.total++
            const usage = {
              inputTokens: native.total * 100,
              outputTokens: native.total * 20,
              totalTokens: native.total * 120,
              cachedInputTokens: native.total * 25,
              cacheWriteInputTokens: 0,
              reasoningOutputTokens: native.total * 5,
            }
            await emit({
              method: 'thread/tokenUsage/updated',
              params: {
                threadId,
                turnId,
                tokenUsage: {
                  total: usage,
                  last: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
                  modelContextWindow: 128000,
                },
              },
            })
            await emit({
              method: 'item/agentMessage/delta',
              params: { threadId, turnId, itemId: `answer_${sequence}`, delta: 'test response' },
            })
            await emit({
              method: 'turn/completed',
              params: { threadId, turn: { id: turnId, status: 'completed' } },
            })
            return { turn: { id: turnId } }
          }
          if (method === 'turn/interrupt') {
            await emit({
              method: 'turn/completed',
              params: {
                threadId: params.threadId,
                turn: { id: params.turnId, status: 'interrupted' },
              },
            })
          }
          return {}
        },
        notify() {},
        reply(id, result) {
          replies.push({ id, result })
        },
        replyError() {},
        close() {},
      }
    },
  })
  base = `http://127.0.0.1:${(await bridge.listen(0)).port}`
}
async function request(route, body) {
  const response = await fetch(base + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  })
  return { status: response.status, value: await response.json() }
}
const context = {
  projectId: 'project',
  environmentId: 'environment',
  documents: [{ id: 'doc', name: 'Authorized', content: 'allowed' }],
}
const ref = {
  id: 'ref-old',
  name: 'older.txt',
  mime: 'text/plain',
  reference: true,
  readable: true,
  extraction: { status: 'ready', format: 'text' },
}
const initialHistory = Array.from({ length: 240 }, (_, n) => ({
  role: n % 2 ? 'assistant' : 'user',
  content: `legacy-message-${n}`,
}))
let requestSequence = 0
async function run(overrides = {}) {
  const input = {
    runId: `test-run-${++requestSequence}`,
    prompt: 'short',
    context,
    history: initialHistory,
    session: { id: 'conversation', revision: 0 },
    sessionAttachments: [ref],
    ...overrides,
  }
  const accepted = await request('/runs', input)
  assert.equal(accepted.status, 202, JSON.stringify(accepted))
  if (input.prompt === 'hold') return { input }
  const response = await fetch(`${base}/runs/${input.runId}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  })
  const events = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  return {
    input,
    events,
    terminal: events.at(-1),
    started: events.find((event) => event.type === 'started')?.payload,
  }
}
let evidence
try {
  await launch()
  const first = await run()
  assert.equal(first.terminal.type, 'completed')
  assert.equal(calls.find((call) => call.method === 'thread/start').params.ephemeral, false)
  assert(
    calls
      .find((call) => call.method === 'turn/start')
      .params.input[0].text.includes('legacy-message-239'),
  )
  const next = await run({ prompt: 'read-files' })
  assert.equal(next.started.runnerThreadId, first.started.runnerThreadId)
  const inputs = calls.filter((call) => call.method === 'turn/start')
  assert(!inputs.at(-1).params.input[0].text.includes('legacy-message-'))
  assert(!inputs.at(-1).params.input[0].text.includes('historical-text-from-authorized-host'))
  assert.equal(attachmentReads, 1)
  assert.equal(replies.at(-1).result.success, false)
  assert(
    replies
      .slice(-3, -1)
      .every(
        (reply) =>
          reply.result.success &&
          reply.result.contentItems[0].text.includes('historical-text-from-authorized-host'),
      ),
  )
  checks.push(
    '240-message legacy history bootstraps once; next native turn is incremental and reads an old authorized file on demand once',
  )
  assert.equal(next.events.find((event) => event.type === 'usage').payload.totalTokens, 120)
  assert.equal(
    next.events.find((event) => event.type === 'usage').payload.threadTotal.totalTokens,
    240,
  )
  assert.equal(next.events.find((event) => event.type === 'usage').payload.scope, 'turn')
  const timings = next.terminal.payload.timings
  assert(
    ['threadReady', 'turnStarted', 'firstRunnerEvent', 'firstText', 'firstTool', 'finished'].every(
      (name) => Number.isFinite(timings[name]),
    ),
  )
  assert(timings.firstText >= timings.turnStarted && timings.finished >= timings.firstText)
  checks.push(
    'usage is a per-turn difference, native totals retained; milestones derive from real protocol events',
  )
  await bridge.close()
  await launch()
  const resumed = await run({ prompt: 'compact' })
  assert.equal(resumed.started.runnerThreadId, first.started.runnerThreadId)
  assert.equal(resumed.events.find((event) => event.type === 'usage').payload.totalTokens, 120)
  assert.equal(resumed.events.filter((event) => event.type === 'context.compaction').length, 2)
  assert(
    calls
      .filter((call) => call.method === 'thread/resume')
      .every((call) => call.params.excludeTurns === true),
  )
  checks.push(
    'bridge restart resumes persisted binding and token baseline; native compaction lifecycle forwarded without a custom summary',
  )
  const branch = await run({ session: { id: 'branch', revision: 0 } })
  assert.notEqual(branch.started.runnerThreadId, first.started.runnerThreadId)
  const retry = await run({ session: { id: 'conversation', revision: 1 } })
  assert.notEqual(retry.started.runnerThreadId, first.started.runnerThreadId)
  assert(
    calls
      .filter((call) => call.method === 'turn/start')
      .at(-1)
      .params.input[0].text.includes('legacy-message-239'),
  )
  const continued = await run({
    session: { id: 'conversation', revision: 1 },
    prompt: 'continue',
    context: { ...context, partialOutput: 'partial' },
  })
  assert.equal(continued.started.runnerThreadId, retry.started.runnerThreadId)
  const expanded = await run({
    session: { id: 'conversation', revision: 1 },
    sessionAttachments: [ref, { ...ref, id: 'second' }],
  })
  assert.equal(expanded.started.runnerThreadId, retry.started.runnerThreadId)
  const revoked = await run({
    session: { id: 'conversation', revision: 1 },
    sessionAttachments: [],
  })
  assert.notEqual(revoked.started.runnerThreadId, retry.started.runnerThreadId)
  assert.equal(revoked.started.sessionMode, 'authorization-reset')
  assert(
    !calls
      .filter((call) => call.method === 'turn/start')
      .at(-1)
      .params.input[0].text.includes('legacy-message-'),
  )
  checks.push(
    'branch/retry isolate context; continue and added attachments retain it; revoked attachments discard native context and old replay',
  )
  const changed = await run({
    session: { id: 'conversation', revision: 1 },
    context: { ...context, documents: [] },
  })
  assert.equal(changed.started.sessionMode, 'authorization-reset')
  assert(
    !calls
      .filter((call) => call.method === 'turn/start')
      .at(-1)
      .params.input[0].text.includes('legacy-message-'),
  )
  await bridge.close()
  await launch()
  failResume = true
  const countBeforeFailure = calls.filter((call) => call.method === 'thread/start').length
  const failed = await run({
    session: { id: 'conversation', revision: 1 },
    context: { ...context, documents: [] },
  })
  assert.equal(failed.terminal.type, 'failed')
  assert.equal(calls.filter((call) => call.method === 'thread/start').length, countBeforeFailure)
  failResume = false
  checks.push(
    'authorization changes do not replay revoked material; failed native resume never silently creates an empty replacement',
  )
  const held = await run({ session: { id: 'exclusive', revision: 0 }, prompt: 'hold' })
  for (
    let i = 0;
    i < 100 &&
    !calls
      .filter((call) => call.method === 'turn/start')
      .at(-1)
      .params.input[0].text.endsWith('hold');
    i++
  )
    await new Promise((r) => setTimeout(r, 5))
  assert.equal((await request('/runs', { ...held.input, runId: 'parallel-conflict' })).status, 409)
  await request(`/runs/${held.input.runId}/stop`, { requestId: 'stop-held' })
  checks.push('concurrent turns in the same native session are rejected before runner dispatch')
  const liveFixture = contextFor({ projectId: 'p-autoops', environmentId: 'env-test' })
  const fixtureFirst = await run({
    session: { id: 'real-fixture', revision: 0 },
    context: liveFixture,
  })
  const nextFixture = structuredClone(liveFixture)
  nextFixture.resourceSnapshot.collectedAt = '2099-12-01T00:00:00.000Z'
  nextFixture.resourceSnapshot.services[0].cpuPercent = 99
  const fixtureNext = await run({
    session: { id: 'real-fixture', revision: 0 },
    context: nextFixture,
  })
  assert.equal(fixtureNext.started.runnerThreadId, fixtureFirst.started.runnerThreadId)
  const imageFile = { id: 'image-id', name: 'image.png', mime: 'image/png', data: 'aW1hZ2U=' }
  const imageFirst = await run({
    session: { id: 'image-history', revision: 0 },
    attachments: [imageFile],
  })
  const { data, ...imageMetadata } = imageFile
  const imageNext = await run({
    session: { id: 'image-history', revision: 0 },
    sessionAttachments: [ref, { ...imageMetadata, reference: true, readable: false }],
  })
  assert.equal(imageNext.started.runnerThreadId, imageFirst.started.runnerThreadId)
  checks.push(
    'real fixture timestamp/observations and current-image to historical-image presentation changes retain authorized context',
  )
  let longThread
  for (let index = 0; index < 205; index++) {
    const result = await run({
      session: {
        id: 'long-native',
        revision: 0,
        ...(longThread ? { expectedThreadId: longThread } : {}),
      },
      history: [],
      prompt: `round ${index + 1}`,
    })
    assert.equal(result.terminal.type, 'completed')
    longThread ??= result.started.runnerThreadId
    assert.equal(result.started.runnerThreadId, longThread)
    assert.equal(result.events.find((event) => event.type === 'usage').payload.totalTokens, 120)
  }
  checks.push(
    '205 sequential protocol turns keep one native thread; terminal event-cache eviction does not impose a conversation cap',
  )
  const startsBeforeMissing = calls.filter((call) => call.method === 'thread/start').length
  for (const id of ['long-native', 'missing-binding']) {
    const missing = await run({
      session: { id, revision: 0, expectedThreadId: 'missing-thread' },
      history: [],
    })
    assert.equal(missing.terminal.type, 'failed')
    assert.equal(missing.terminal.payload.code, 'SESSION_CONTEXT_MISSING')
  }
  assert.equal(calls.filter((call) => call.method === 'thread/start').length, startsBeforeMissing)
  checks.push(
    'incremental host sends pin expected native identity; missing/mismatched binding fails instead of silently losing context',
  )
  const stored = JSON.parse(await readFile(join(temporary, 'state/sessions.json'), 'utf8'))
  assert(!JSON.stringify(stored).includes('legacy-message-'))
  assert(!JSON.stringify(stored).includes('historical-text-from-authorized-host'))
  checks.push(
    'session index persists only identities/fingerprints/token totals, not transcripts or attachment bodies',
  )
  const deleted = await fetch(`${base}/sessions/conversation`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(deleted.status, 200)
  const deletedResult = await deleted.json()
  assert(deletedResult.nativeThreads >= 3)
  assert.equal(
    calls.filter((call) => call.method === 'thread/delete').length,
    deletedResult.nativeThreads,
  )
  const storedAfterDelete = JSON.parse(
    await readFile(join(temporary, 'state/sessions.json'), 'utf8'),
  )
  assert(!storedAfterDelete.entries.some(([id]) => id === 'conversation'))
  checks.push(
    'delete removes every owned native thread, including retired revision/auth scopes, then removes binding and cached run content',
  )
  const deleteSession = async (id) => {
    const response = await fetch(`${base}/sessions/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    return { status: response.status, value: await response.json() }
  }
  const deletionEntry = async (id) => {
    const state = JSON.parse(await readFile(join(temporary, 'state/sessions.json'), 'utf8'))
    return state.entries.find(([key]) => key === id)?.[1]
  }
  const createRevisions = async (id) => {
    const ids = []
    for (let revision = 0; revision < 3; revision++) {
      const result = await run({ session: { id, revision } })
      ids.push(result.started.runnerThreadId)
    }
    return ids
  }
  const partialIds = await createRevisions('partial-delete')
  deleteFailures.set(partialIds[1], { code: -32000, message: 'synthetic private diagnostic' })
  const partial = await deleteSession('partial-delete')
  assert.equal(partial.status, 502)
  assert.equal(partial.value.code, 'RUNNER_ERROR')
  assert(!JSON.stringify(partial).includes('private diagnostic'))
  assert(!nativeThreads.has(partialIds[0]))
  assert.deepEqual((await deletionEntry('partial-delete')).deletionPending, partialIds.slice(1))
  const duringDeletion = await request('/runs', {
    runId: 'while-delete-pending',
    prompt: 'short',
    context,
    session: { id: 'partial-delete', revision: 2 },
  })
  assert.equal(duringDeletion.status, 409)
  deleteFailures.delete(partialIds[1])
  assert.equal((await deleteSession('partial-delete')).status, 200)
  assert.equal(await deletionEntry('partial-delete'), undefined)
  assert.equal(
    calls.filter(
      (call) => call.method === 'thread/delete' && call.params.threadId === partialIds[0],
    ).length,
    1,
  )
  checks.push(
    'partial native deletion checkpoints each owned id; failed deletion blocks reuse and retry skips already confirmed ids',
  )

  const restartIds = await createRevisions('restart-delete')
  deleteFailures.set(restartIds[1], { code: -32000, message: 'synthetic failure' })
  assert.equal((await deleteSession('restart-delete')).status, 502)
  // Crash window: native deletion succeeded, but the old pending checkpoint
  // is all that survived. The official exact not-found result is recoverable.
  nativeThreads.delete(restartIds[1])
  deleteFailures.delete(restartIds[1])
  await bridge.close()
  await launch()
  assert.deepEqual((await deletionEntry('restart-delete')).deletionPending, restartIds.slice(1))
  assert.equal((await deleteSession('restart-delete')).status, 200)
  assert.equal(await deletionEntry('restart-delete'), undefined)
  assert.equal(
    calls.filter(
      (call) => call.method === 'thread/delete' && call.params.threadId === restartIds[0],
    ).length,
    1,
  )
  const deletesBeforeUnknown = calls.filter((call) => call.method === 'thread/delete').length
  assert.equal((await deleteSession('unknown-session')).status, 200)
  assert.equal(calls.filter((call) => call.method === 'thread/delete').length, deletesBeforeUnknown)
  checks.push(
    'restart resumes pending deletion; exact missing owned native id is idempotent, unknown host session never dispatches arbitrary ids',
  )

  for (const [method, threadId, error] of [
    ['thread/delete', 'owned', { code: -32000, message: 'thread not found: owned' }],
    ['thread/delete', 'owned', { code: -32600, message: 'thread not found: other' }],
    [
      'thread/delete',
      'owned',
      { code: -32600, message: 'thread not found: owned; private diagnostic' },
    ],
    ['thread/resume', 'owned', { code: -32600, message: 'thread not found: owned' }],
    ['thread/delete', 'owned', { code: -32600, message: 'no rollout found for thread id other' }],
    ['thread/resume', 'owned', { code: -32600, message: 'no rollout found for thread id owned' }],
  ]) {
    const classified = runnerResponseError(method, threadId, error)
    assert.equal(classified.code, 'RUNNER_ERROR')
    assert(!classified.message.includes('private diagnostic'))
  }
  for (const message of ['thread not found: owned', 'no rollout found for thread id owned'])
    assert.equal(
      runnerResponseError('thread/delete', 'owned', { code: -32600, message }).code,
      'RUNNER_THREAD_NOT_FOUND',
    )
  checks.push(
    'RPC missing classification matches only official thread/delete method, code and exact id; other raw diagnostics stay private and fail',
  )
  evidence = {
    passed: true,
    checks,
    nativeProtocolTurns: sequence,
    realModelCalls: 0,
    providerConfigurationChanged: false,
  }
} catch (error) {
  evidence = { passed: false, checks, error: error.stack, realModelCalls: 0 }
  process.exitCode = 1
} finally {
  await bridge?.close()
  await rm(temporary, { recursive: true, force: true })
  const output = resolve('.test-artifacts/agent-demo-api/native-sessions.json')
  await mkdir(resolve('.test-artifacts/agent-demo-api'), { recursive: true })
  await writeFile(
    output,
    JSON.stringify({ testedAt: new Date().toISOString(), ...evidence }, null, 2),
  )
  console.log(JSON.stringify({ ...evidence, report: output }))
}
