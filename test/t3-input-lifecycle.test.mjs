import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../agent-demo/t3-adapters/access.mjs'
import { users, projects, agents } from '../agent-demo/fixtures.mjs'

function fixture(t) {
  const sessionDb = new DatabaseSync(':memory:'),
    bindingDb = new DatabaseSync(':memory:')
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  for (const actor of ['u-admin', 'u-lin'])
    sessionDb
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(createHash('sha256').update(actor).digest('hex'), actor, 'csrf', Date.now() + 60_000)
  const catalog = structuredClone({ users, projects, agents })
  const access = createAutoOpsAccess({
      sessionDb,
      bindingDb,
      catalog,
      workspaceStore: {
        getVersion() {
          return { id: 'legacy-version', type: 'internal', status: 'published' }
        },
      },
    }),
    admin = access.authenticateCookie('demo_session=u-admin')
  const scope = {
    projectId: 'p-autoops',
    environmentId: 'env-test',
    agentId: 'a-project',
    visibility: 'project',
    workspaceType: 'internal',
  }
  for (const threadId of ['source', 'target']) access.bindThread(admin, { ...scope, threadId })
  access.bindRunInput('source', 'original-run', 'fixed-input', 'u-lin')
  t.after(() => {
    bindingDb.close()
    sessionDb.close()
  })
  return { access, admin, bindingDb, catalog }
}

test('资料引用快照精确聚合原运行与命令/分叉来源，撤权后仍可核对原身份事实', (t) => {
  const f = fixture(t)
  const claim = { kind: 'context', commandId: 'message-command', messageId: 'message' }
  f.access.retainInputReference('target', 'fixed-input', 'u-lin', 'u-admin', claim)
  f.access.retainInputReference('target', 'fixed-input', 'u-lin', 'u-admin', claim)
  f.access.forkBinding(f.admin, 'source', 'fork', 'fork-command')
  f.catalog.users.find((value) => value.id === 'u-lin').status = 'disabled'
  const snapshot = f.access.inputResourceSnapshot('p-autoops', 'fixed-input')
  assert.equal(snapshot.truncated, false)
  assert.deepEqual(
    snapshot.runs.map((value) => [value.threadId, value.runId, value.actorId, value.inputOwnerId]),
    [['source', 'original-run', 'u-lin', 'u-lin']],
  )
  assert.deepEqual(
    snapshot.references.map((value) => [value.threadId, value.inputOwnerId]),
    [
      ['fork', 'u-lin'],
      ['target', 'u-lin'],
    ],
  )
  assert.deepEqual(
    snapshot.claims.map((value) => [
      value.threadId,
      value.commandId,
      value.kind,
      value.messageId,
      value.sourceThreadId,
    ]),
    [
      ['fork', 'fork-command', 'fork', null, 'source'],
      ['target', 'message-command', 'context', 'message', null],
    ],
  )
  assert.deepEqual(f.access.inputResourceSnapshot('other-project', 'fixed-input').runs, [])
  assert.equal(
    f.access.withInputResourceSnapshot(snapshot, () => true),
    true,
  )
})

test('新运行引用使旧维护快照失效，同一写事务拒绝异步回调并回滚附带写入', (t) => {
  const f = fixture(t),
    old = f.access.inputResourceSnapshot('p-autoops', 'fixed-input')
  f.access.bindRunInput('target', 'later-run', 'fixed-input', 'u-admin', 'u-lin')
  let released = false
  assert.equal(
    f.access.withInputResourceSnapshot(old, () => {
      released = true
      return true
    }),
    false,
  )
  assert.equal(released, false)
  const current = f.access.inputResourceSnapshot('p-autoops', 'fixed-input')
  assert.throws(
    () =>
      f.access.withInputResourceSnapshot(current, () => {
        f.access.bindRunInput('target', 'not-committed', 'fixed-input', 'u-admin', 'u-lin')
        return Promise.resolve(true)
      }),
    /不能包含异步/u,
  )
  assert.equal(f.access.getRunInput('target', 'not-committed'), undefined)
  assert.deepEqual(f.access.inputResourceSnapshot('p-autoops', 'fixed-input'), current)
})

test('原命令不能改换引用所有者或消息身份，引用读取故障不伪装无活动引用', (t) => {
  const f = fixture(t)
  f.access.retainInputReference('target', 'fixed-input', 'u-lin', 'u-admin', {
    kind: 'context',
    commandId: 'fixed-command',
    messageId: 'first',
  })
  assert.throws(
    () =>
      f.access.retainInputReference('target', 'fixed-input', 'u-admin', 'u-admin', {
        kind: 'context',
        commandId: 'fixed-command',
        messageId: 'first',
      }),
    { code: 'THREAD_INPUT_OWNER_CONFLICT' },
  )
  assert.throws(
    () =>
      f.access.retainInputReference('target', 'fixed-input', 'u-lin', 'u-admin', {
        kind: 'context',
        commandId: 'fixed-command',
        messageId: 'changed',
      }),
    { code: 'THREAD_INPUT_CLAIM_CONFLICT' },
  )
  const snapshot = f.access.inputResourceSnapshot('p-autoops', 'fixed-input')
  f.bindingDb.exec('DROP TABLE t3_input_reference_claims')
  assert.throws(() => f.access.withInputResourceSnapshot(snapshot, () => true), /no such table/u)
})

test('原生资料准备先固定原任务及实际调用者，未知交接不能由另一请求或身份接管', (t) => {
  const f = fixture(t)
  f.access.recordRunInputRequest('source', 'preparing', 'agent-original-request', 'u-lin')
  const [origin] = f.access.inputPreparationCandidates('source')
  assert.deepEqual(
    { ...origin },
    {
      threadId: 'source',
      runId: 'preparing',
      projectId: 'p-autoops',
      requestId: 'agent-original-request',
      actorId: 'u-lin',
      workspaceType: 'internal',
    },
  )
  assert.deepEqual(f.access.inputRequestThreads('p-autoops', 'agent-original-request', 'u-lin'), [
    'source',
  ])
  assert.deepEqual(
    f.access.inputRequestThreads('p-autoops', 'agent-original-request', 'u-admin'),
    [],
  )
  assert.throws(
    () => f.access.completeRunInputRequest({ ...origin, actorId: 'u-admin' }, 'prepared-only'),
    { code: 'THREAD_INPUT_REQUEST_CONFLICT' },
  )
  f.access.completeRunInputRequest(origin, 'prepared-only')
  assert.deepEqual(f.access.inputPreparationCandidates('source'), [])
  assert.equal(
    f.access.inputResourceSnapshot('p-autoops', 'prepared-only').origins[0].actorId,
    'u-lin',
  )
  assert.throws(() => f.access.completeRunInputRequest(origin, 'other-input'), {
    code: 'THREAD_INPUT_REQUEST_CONFLICT',
  })
  assert.throws(
    () => f.access.recordRunInputRequest('source', 'preparing', 'another-request', 'u-lin'),
    { code: 'THREAD_INPUT_REQUEST_CONFLICT' },
  )
})

test('旧固定范围终态仅归还版本保护，保留绑定；新命令重新保护且并发快照不能释放', (t) => {
  const f = fixture(t)
  f.access.bindThread(f.admin, {
    threadId: 'legacy-thread',
    projectId: 'p-autoops',
    environmentId: 'env-test',
    agentId: 'a-project',
    visibility: 'project',
    workspaceType: 'internal',
    workspaceVersionId: 'legacy-version',
  })
  const original = f.access.workspaceVersionResourceSnapshot('legacy-thread')
  assert.throws(
    () => f.access.releaseWorkspaceVersionResource(original, 41, () => Promise.resolve(true)),
    /不能包含异步/u,
  )
  assert.deepEqual(f.access.workspaceVersionReferences('p-autoops'), ['legacy-version'])
  assert.equal(
    f.access.releaseWorkspaceVersionResource(original, 42, () => {}),
    true,
  )
  assert.deepEqual(f.access.workspaceVersionReferences('p-autoops'), [])
  assert.equal(f.access.getThreadBinding('legacy-thread').workspaceVersionId, 'legacy-version')
  f.access.recordMessageActor(f.admin, 'legacy-thread', 'next-command', 'next-message')
  assert.deepEqual(f.access.workspaceVersionReferences('p-autoops'), ['legacy-version'])
  assert.equal(
    f.access.releaseWorkspaceVersionResource(original, 42, () => {
      assert.fail('不能释放并发新命令')
    }),
    false,
  )
  const current = f.access.workspaceVersionResourceSnapshot('legacy-thread')
  f.access.releaseWorkspaceVersionResource(current, 43, () => {})
  f.access.recordQueuedEditActor(f.admin, 'legacy-thread', 'edit-command', 'queued-run')
  assert.deepEqual(f.access.workspaceVersionReferences('p-autoops'), ['legacy-version'])
  f.access.forkBinding(f.admin, 'legacy-thread', 'legacy-fork', 'fork-scope-command')
  assert.equal(
    f.access.workspaceVersionResourceSnapshot('legacy-fork').commands[0].kind,
    'thread.fork',
  )
  assert.equal(
    f.access.workspaceVersionResourceSnapshot('legacy-fork').commands[0].commandId,
    'fork-scope-command',
  )
})
