import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createWorkspaceUpdates } from '../agent-demo/t3-adapters/workspace-updates/index.ts'
import { createManagedWorkspaceUpdates } from '../agent-demo/t3-adapters/workspace-update-runtime.ts'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../agent-demo/t3-adapters/access.mjs'
import { createWorkspaceAuthoring } from '../agent-demo/t3-adapters/workspace-authoring/index.ts'
import { createProjectCredentialService } from '../agent-demo/t3-adapters/credentials.ts'
import { createWorkspaceManagement } from '../agent-demo/t3-adapters/workspace-management.ts'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'
import { validateRepositorySource } from '../agent-demo/t3-adapters/workspace-git.ts'
import { handleWorkspaceRequest } from '../agent-demo/t3-adapters/workspace-http.mjs'

const flush = () => new Promise((resolve) => setImmediate(resolve))
const error = (status, code) =>
  Object.assign(new Error('隔离夹具错误，不应返回底层详情'), { status, code })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const task = (input, status = 'running', type = 'sync') => ({
  id: randomUUID(),
  requestId: input.requestId,
  status,
  type,
  stage: status,
  message: '隔离资料任务',
  createdAt: '2026-10-26T00:00:00.000Z',
  ...(status === 'completed' ? { versionId: randomUUID() } : {}),
})
const command = (revision = 0, value = {}) => ({
  requestId: randomUUID(),
  expectedRevision: revision,
  value: {
    enabled: true,
    intervalMinutes: 5,
    timezone: 'Asia/Shanghai',
    sourceIds: ['repo-a'],
    ...value,
  },
})

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'autoops-workspace-updates-'))
  const state = {
    time: Date.parse('2026-10-26T00:00:00.000Z'),
    revision: 2,
    sourceIds: ['repo-a'],
    fingerprint: 'configured-source-a',
    allowed: true,
    externalAllowed: true,
    busy: false,
    calls: [],
    receipts: new Map(),
    errors: [],
  }
  const ports = {
    authorize(actor, project, scope, action) {
      if (
        project !== 'project-a' ||
        (!['manager', 'other-manager'].includes(actor) && action === 'manage') ||
        actor === 'outsider'
      )
        throw error(403, 'FIXTURE_FORBIDDEN')
      if (!state.allowed || (scope === 'external' && !state.externalAllowed))
        throw error(403, 'FIXTURE_REVOKED')
    },
    sources() {
      return {
        revision: state.revision,
        sourceIds: [...state.sourceIds],
        fingerprint: state.fingerprint,
      }
    },
    busy() {
      return state.busy
    },
    async start(project, scope, input, actor, signal) {
      state.calls.push({ project, scope, input, actor, signal })
      const result = task(input, 'running', scope === 'internal' ? 'sync' : 'external')
      state.receipts.set(input.requestId, { task: result })
      return result
    },
    receipt(_project, _scope, requestId) {
      return state.receipts.get(requestId) ?? {}
    },
    ...overrides,
  }
  const owners = []
  const open = (options = {}) => {
    const owner = createWorkspaceUpdates({
      dataDir,
      ports,
      now: () => state.time,
      onError: (entry) => state.errors.push(entry),
      ...options,
    })
    owners.push(owner)
    return owner
  }
  t.after(async () => {
    for (const owner of owners) await owner.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const owner = open()
  return {
    dataDir,
    owner,
    ports,
    state,
    open,
    advance: (minutes = 5) => {
      state.time += minutes * 60_000
    },
  }
}

test('未保存计划和显式停用计划均不自动开启，时区与下一次执行持久保留', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(f.owner.overview('project-a', 'manager'), {
    internal: null,
    external: null,
    sources: [{ id: 'repo-a', name: 'repo-a' }],
  })
  await f.owner.start()
  assert.equal(f.state.calls.length, 0)
  const saved = f.owner.save(
    'project-a',
    'internal',
    command(0, { enabled: false, timezone: 'Pacific/Auckland' }),
    'manager',
  )
  assert.equal(saved.nextRunAt, null)
  assert.equal(saved.timezone, 'Pacific/Auckland')
  f.advance(600)
  await f.owner.tick()
  await f.owner.close()
  const reopened = f.open()
  await reopened.start()
  assert.equal(reopened.overview('project-a', 'manager').internal.enabled, false)
  assert.equal(f.state.calls.length, 0)
})

test('计划保存拒绝伪造身份、非法周期时区和跨项目来源，不扩大成员权限', async (t) => {
  const f = await fixture(t)
  assert.throws(
    () => f.owner.save('project-a', 'internal', { ...command(), actorId: 'manager' }, 'manager'),
    { code: 'WORKSPACE_UPDATE_SETTINGS_INVALID' },
  )
  assert.throws(
    () => f.owner.save('project-a', 'internal', command(0, { intervalMinutes: 0 }), 'manager'),
    { code: 'WORKSPACE_UPDATE_SETTINGS_INVALID' },
  )
  assert.throws(
    () => f.owner.save('project-a', 'internal', command(0, { intervalMinutes: 43_201 }), 'manager'),
    { code: 'WORKSPACE_UPDATE_SETTINGS_INVALID' },
  )
  assert.throws(
    () =>
      f.owner.save(
        'project-a',
        'internal',
        command(0, { timezone: 'invalid/timezone' }),
        'manager',
      ),
    { code: 'WORKSPACE_UPDATE_TIMEZONE_INVALID' },
  )
  assert.throws(
    () =>
      f.owner.save(
        'project-a',
        'internal',
        command(0, { sourceIds: ['other-project-source'] }),
        'manager',
      ),
    { code: 'WORKSPACE_UPDATE_SOURCE_CHANGED' },
  )
  assert.throws(
    () =>
      f.owner.save(
        'project-a',
        'internal',
        command(0, { sourceIds: ['repo-a', 'repo-a'] }),
        'manager',
      ),
    { code: 'WORKSPACE_UPDATE_SETTINGS_INVALID' },
  )
  assert.throws(() => f.owner.save('project-a', 'internal', command(), 'reader'), {
    code: 'FIXTURE_FORBIDDEN',
  })
  assert.throws(() => f.owner.save('project-b', 'internal', command(), 'manager'), {
    code: 'FIXTURE_FORBIDDEN',
  })
  assert.throws(() => f.owner.save('project-a', 'other', command(), 'manager'), {
    code: 'WORKSPACE_UPDATE_SCOPE_INVALID',
  })
  assert.deepEqual(f.owner.overview('project-a', 'manager'), {
    internal: null,
    external: null,
    sources: [{ id: 'repo-a', name: 'repo-a' }],
  })
})

test('配置原请求稳定重放，参数篡改与不同配置者复用均拒绝', async (t) => {
  const f = await fixture(t),
    input = command()
  const saved = f.owner.save('project-a', 'internal', input, 'manager')
  assert.deepEqual(f.owner.save('project-a', 'internal', input, 'manager'), saved)
  assert.equal(f.owner.receipt('project-a', input.requestId, 'manager').kind, 'settings')
  assert.throws(
    () =>
      f.owner.save(
        'project-a',
        'internal',
        { ...input, value: { ...input.value, intervalMinutes: 10 } },
        'manager',
      ),
    { code: 'WORKSPACE_UPDATE_REQUEST_CONFLICT' },
  )
  assert.throws(() => f.owner.save('project-a', 'internal', input, 'other-manager'), {
    code: 'WORKSPACE_UPDATE_REQUEST_CONFLICT',
  })
  assert.throws(() => f.owner.receipt('project-a', input.requestId, 'other-manager'), {
    code: 'WORKSPACE_UPDATE_RECEIPT_NOT_FOUND',
  })
  assert.throws(() => f.owner.save('project-a', 'internal', command(0), 'manager'), {
    code: 'WORKSPACE_UPDATE_REVISION_CONFLICT',
  })
  f.state.sourceIds = []
  assert.deepEqual(f.owner.save('project-a', 'internal', input, 'manager'), saved)
})

test('异步授权端口不能被当作授权成功，拒绝前不保存或触发任何更新', async (t) => {
  const f = await fixture(t, {
    authorize: async () => {
      throw error(403, 'FIXTURE_ASYNC_REVOKED')
    },
  })
  assert.throws(() => f.owner.save('project-a', 'internal', command(), 'manager'), {
    code: 'WORKSPACE_UPDATE_PORT_INVALID',
  })
  await assert.rejects(
    f.owner.manual('project-a', 'internal', { requestId: randomUUID() }, 'manager'),
    { code: 'WORKSPACE_UPDATE_PORT_INVALID' },
  )
  assert.equal(f.state.calls.length, 0)
})

test('配置和必要审计同一 SQLite 事务，审计失败不留下计划或成功收据', async (t) => {
  const f = await fixture(t)
  const db = new DatabaseSync(join(f.dataDir, 'workspace-updates', 'state.sqlite'))
  t.after(() => db.close())
  db.exec(
    "CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON workspace_update_audit BEGIN SELECT RAISE(ABORT,'isolated fixture'); END",
  )
  const input = command()
  assert.throws(() => f.owner.save('project-a', 'internal', input, 'manager'), /isolated fixture/)
  assert.equal(f.owner.overview('project-a', 'manager').internal, null)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workspace_update_receipts').get().count, 0)
  db.exec('DROP TRIGGER fixture_audit_failure')
  assert.equal(f.owner.save('project-a', 'internal', input, 'manager').revision, 1)
})

test('到期以原配置者身份触发一次，超期时段合并且同范围不重叠', async (t) => {
  const f = await fixture(t)
  const saved = f.owner.save('project-a', 'internal', command(), 'manager')
  assert.equal(saved.nextRunAt, '2026-10-26T00:05:00.000Z')
  await f.owner.tick()
  assert.equal(f.state.calls.length, 0)
  f.advance(80)
  await Promise.all([f.owner.tick(), f.owner.tick()])
  await flush()
  assert.equal(f.state.calls.length, 1)
  assert.equal(f.state.calls[0].actor, 'manager')
  assert.equal(f.state.calls[0].input.expectedRevision, 2)
  assert.equal(
    f.owner.overview('project-a', 'manager').internal.nextRunAt,
    '2026-10-26T01:25:00.000Z',
  )
  f.advance(5)
  await f.owner.tick()
  assert.equal(f.state.calls.length, 1)
  const requestId = f.state.calls[0].input.requestId
  f.state.receipts.get(requestId).task.status = 'completed'
  f.state.receipts.get(requestId).task.versionId = 'new-version'
  await f.owner.tick()
  await flush()
  assert.equal(f.state.calls.length, 2)
  assert.equal(f.owner.overview('project-a', 'manager').internal.lastRun.outcome, 'completed')
})

test('内部与外部独立周期，外部待复核只记录结果，不调用确认发布', async (t) => {
  const f = await fixture(t)
  f.owner.save('project-a', 'internal', command(), 'manager')
  f.owner.save('project-a', 'external', command(0, { intervalMinutes: 15 }), 'manager')
  f.advance()
  await f.owner.tick()
  await flush()
  assert.deepEqual(
    f.state.calls.map((entry) => entry.scope),
    ['internal'],
  )
  f.advance(10)
  await f.owner.tick()
  await flush()
  const external = f.state.calls.find((entry) => entry.scope === 'external')
  assert.ok(external)
  const receipt = f.state.receipts.get(external.input.requestId)
  receipt.task.status = 'completed'
  receipt.task.versionId = 'pending-external'
  receipt.versionStatus = 'pending_review'
  await f.owner.tick()
  assert.equal(f.owner.overview('project-a', 'manager').external.lastRun.outcome, 'pending_review')
})

test('手动与定时更新共用范围锁，原手动收据恢复不再调用更新端口', async (t) => {
  const f = await fixture(t)
  f.owner.save('project-a', 'internal', command(), 'manager')
  const input = { requestId: randomUUID(), expectedRevision: 2 }
  const first = await f.owner.manual('project-a', 'internal', input, 'manager')
  f.advance()
  await f.owner.tick()
  assert.equal(f.state.calls.length, 1)
  await assert.rejects(
    f.owner.manual('project-a', 'internal', { ...input, requestId: randomUUID() }, 'manager'),
    { code: 'WORKSPACE_UPDATE_BUSY' },
  )
  assert.deepEqual(await f.owner.manual('project-a', 'internal', input, 'manager'), first)
  await assert.rejects(f.owner.manual('project-a', 'external', input, 'manager'), {
    code: 'WORKSPACE_UPDATE_REQUEST_CONFLICT',
  })
  await assert.rejects(f.owner.manual('project-a', 'internal', input, 'other-manager'), {
    code: 'WORKSPACE_UPDATE_REQUEST_CONFLICT',
  })
  assert.equal(f.state.calls.length, 1)
})

test('现有手动 Worker 活动期间推迟到期更新，不挤入另一份当前候选', async (t) => {
  const f = await fixture(t)
  f.owner.save('project-a', 'internal', command(), 'manager')
  f.state.busy = true
  f.advance()
  await f.owner.tick()
  assert.equal(f.state.calls.length, 0)
  f.state.busy = false
  await f.owner.tick()
  await flush()
  assert.equal(f.state.calls.length, 1)
})

test('配置者撤权使原计划停用，新管理员也不能借其旧身份触发', async (t) => {
  const f = await fixture(t)
  f.owner.save('project-a', 'internal', command(), 'manager')
  f.state.allowed = false
  f.advance()
  await f.owner.tick()
  assert.equal(f.state.calls.length, 0)
  assert.throws(() => f.owner.overview('project-a', 'manager'), { code: 'FIXTURE_REVOKED' })
  f.state.allowed = true
  const plan = f.owner.overview('project-a', 'other-manager').internal
  assert.equal(plan.enabled, false)
  assert.equal(plan.pausedReason.code, 'WORKSPACE_UPDATE_PERMISSION_REVOKED')
  assert.equal(plan.nextRunAt, null)
  f.advance(20)
  await f.owner.tick()
  assert.equal(f.state.calls.length, 0)
  f.owner.save('project-a', 'internal', command(plan.revision), 'other-manager')
  f.advance()
  await f.owner.tick()
  await flush()
  assert.equal(f.state.calls[0].actor, 'other-manager')
})

test('旧执行者撤权不会误停新管理者已经接管的计划，原未知请求仍保护不重发', async (t) => {
  const f = await fixture(t),
    authorize = f.ports.authorize
  let revoked = false
  f.ports.authorize = (actor, ...args) => {
    if (actor === 'manager' && revoked) throw error(403, 'FIXTURE_OLD_ACTOR_REVOKED')
    authorize(actor, ...args)
  }
  f.owner.save('project-a', 'internal', command(), 'manager')
  f.advance()
  await f.owner.tick()
  await flush()
  f.owner.save('project-a', 'internal', command(1), 'other-manager')
  revoked = true
  f.advance()
  await f.owner.tick()
  const plan = f.owner.overview('project-a', 'other-manager').internal
  assert.equal(plan.actorId, 'other-manager')
  assert.equal(plan.enabled, true)
  assert.equal(f.state.calls.length, 1)
  assert.equal(f.owner.deletionReferences('project-a')[0].count, 1)
  assert.deepEqual(f.owner.deletionReferences('project-a', 'environment-a'), [])
})

test('撤权后的终态证明必须匹配已接受taskId和原请求，其他任务不能结束此锁', async (t) => {
  const f = await fixture(t)
  f.owner.save('project-a', 'internal', command(), 'manager')
  const accepted = await f.owner.manual(
    'project-a',
    'internal',
    { requestId: randomUUID(), expectedRevision: 2 },
    'manager',
  )
  f.ports.settled = () => ({ task: { ...accepted, id: 'another-task', status: 'completed' } })
  f.state.allowed = false
  await f.owner.tick()
  assert.equal(f.owner.deletionReferences('project-a')[0].count, 1)
  f.ports.settled = () => ({
    task: { ...accepted, status: 'completed', versionId: 'original-version' },
  })
  await f.owner.tick()
  assert.deepEqual(f.owner.deletionReferences('project-a'), [])
  assert.throws(() => f.owner.receipt('project-a', accepted.requestId, 'manager'), {
    code: 'FIXTURE_REVOKED',
  })
  assert.equal(f.state.calls.length, 1)
})

test('来源撤回或新增均暂停旧计划，不能静默跟随未确认来源', async (t) => {
  for (const ids of [[], ['repo-a', 'new-repository']]) {
    const f = await fixture(t)
    f.owner.save('project-a', 'internal', command(), 'manager')
    f.state.sourceIds = ids
    f.advance()
    await f.owner.tick()
    const plan = f.owner.overview('project-a', 'manager').internal
    assert.equal(plan.enabled, false)
    assert.equal(plan.pausedReason.code, 'WORKSPACE_UPDATE_SOURCE_WITHDRAWN')
    assert.equal(f.state.calls.length, 0)
  }
})

test('重启后先读已接受原任务，完成前不重复触发，失败后保留原失败收据', async (t) => {
  const f = await fixture(t)
  f.owner.save('project-a', 'internal', command(), 'manager')
  f.advance()
  await f.owner.tick()
  await flush()
  const requestId = f.state.calls[0].input.requestId
  await f.owner.close()
  f.advance(50)
  const reopened = f.open()
  await reopened.start()
  await flush()
  assert.equal(f.state.calls.length, 1)
  assert.equal(reopened.overview('project-a', 'manager').internal.currentRun.requestId, requestId)
  const receipt = f.state.receipts.get(requestId)
  receipt.task.status = 'failed'
  receipt.task.failureCode = 'FIXTURE_SOURCE_DOWN'
  await reopened.tick()
  await flush()
  assert.equal(reopened.overview('project-a', 'manager').internal.lastRun.requestId, requestId)
  assert.equal(reopened.overview('project-a', 'manager').internal.lastRun.outcome, 'failed')
  assert.equal(f.state.calls.length, 2)
})

test('接受后断线通过持久原任务恢复，不用新请求重新执行', async (t) => {
  const f = await fixture(t)
  f.ports.start = async (project, scope, input, actor) => {
    f.state.calls.push({ project, scope, input, actor })
    f.state.receipts.set(input.requestId, { task: task(input) })
    throw error(503, 'FIXTURE_CONNECTION_LOST')
  }
  const input = { requestId: randomUUID(), expectedRevision: 2 }
  await assert.rejects(f.owner.manual('project-a', 'internal', input, 'manager'), {
    code: 'FIXTURE_CONNECTION_LOST',
  })
  const restored = await f.owner.manual('project-a', 'internal', input, 'manager')
  assert.equal(restored.requestId, input.requestId)
  assert.equal(f.state.calls.length, 1)
})

test('没有任务也没有确定失败收据时保留未知并阻止重发及下一周期', async (t) => {
  const f = await fixture(t)
  f.ports.start = async (_project, _scope, input) => {
    f.state.calls.push(input)
    throw error(503, 'FIXTURE_UNKNOWN')
  }
  f.owner.save('project-a', 'internal', command(), 'manager')
  f.advance()
  await f.owner.tick()
  await flush()
  const run = f.owner.overview('project-a', 'manager').internal.currentRun
  assert.equal(run.error.code, 'WORKSPACE_UPDATE_UNKNOWN')
  await f.owner.close()
  const reopened = f.open()
  f.advance(20)
  await reopened.start()
  await flush()
  assert.equal(f.state.calls.length, 1)
  await assert.rejects(
    reopened.manual(
      'project-a',
      'internal',
      { requestId: run.requestId, expectedRevision: 2 },
      'manager',
    ),
    { code: 'WORKSPACE_UPDATE_UNKNOWN' },
  )
  assert.equal(f.state.calls.length, 1)
})

test('普通收据返回404仅保留未知，不误判为配置者撤权或重新执行', async (t) => {
  const f = await fixture(t)
  f.owner.save('project-a', 'internal', command(), 'manager')
  f.advance()
  await f.owner.tick()
  await flush()
  f.ports.receipt = () => {
    throw error(404, 'FIXTURE_RECEIPT_NOT_FOUND')
  }
  f.advance(30)
  await f.owner.tick()
  assert.equal(f.owner.overview('project-a', 'manager').internal.enabled, true)
  assert.equal(f.state.calls.length, 1)
})

test('显式start的计时器可触发到期检查，关闭后不保留唤醒或后台执行', async (t) => {
  const f = await fixture(t),
    fired = deferred()
  await f.owner.close()
  const scheduled = f.open({ pollMs: 10 })
  f.ports.start = async (_project, _scope, input) => {
    f.state.calls.push(input)
    const accepted = task(input)
    f.state.receipts.set(input.requestId, { task: accepted })
    fired.resolve()
    return accepted
  }
  scheduled.save('project-a', 'internal', command(), 'manager')
  await scheduled.start()
  f.advance()
  const budget = new AbortController()
  try {
    await Promise.race([
      fired.promise,
      delay(2000, undefined, { signal: budget.signal }).then(() => {
        throw new Error('隔离更新计时器未触发')
      }),
    ])
  } finally {
    budget.abort()
  }
  await scheduled.close()
  const count = f.state.calls.length,
    errors = f.state.errors.length
  f.advance(20)
  await delay(30)
  assert.equal(f.state.calls.length, count)
  assert.equal(f.state.errors.length, errors)
})

test('来源准备已确定失败则记录原失败收据，下一周期可再次更新', async (t) => {
  const f = await fixture(t)
  f.ports.start = async (_project, _scope, input) => {
    f.state.calls.push(input)
    f.state.receipts.set(input.requestId, {
      capture: { resolution: 'failed', resolutionError: { code: 'WORKSPACE_GIT_UNAVAILABLE' } },
    })
    throw error(503, 'WORKSPACE_GIT_UNAVAILABLE')
  }
  f.owner.save('project-a', 'internal', command(), 'manager')
  f.advance()
  await f.owner.tick()
  await flush()
  assert.equal(f.owner.overview('project-a', 'manager').internal.lastRun.outcome, 'failed')
  f.advance()
  await f.owner.tick()
  await flush()
  assert.equal(f.state.calls.length, 2)
})

test('未显式提供资料修订的手动外部请求也固定原修订，恢复不改用后来内容', async (t) => {
  const f = await fixture(t)
  const input = { requestId: randomUUID(), rules: [{ find: '隔离项目', replace: '公开项目' }] }
  const accepted = await f.owner.manual('project-a', 'external', input, 'manager')
  assert.equal(f.state.calls[0].input.expectedRevision, 2)
  f.state.revision = 3
  assert.deepEqual(await f.owner.manual('project-a', 'external', input, 'manager'), accepted)
  assert.equal(f.state.calls.length, 1)
  await assert.rejects(
    f.owner.manual('project-a', 'external', { ...input, actorId: 'manager' }, 'manager'),
    { code: 'WORKSPACE_UPDATE_REQUEST_INVALID' },
  )
})

test('异步准备后重新裁决撤权，迟到结果不能作为授权成功返回', async (t) => {
  const f = await fixture(t),
    gate = deferred()
  f.ports.start = async (_project, _scope, input) => {
    await gate.promise
    const accepted = task(input)
    f.state.receipts.set(input.requestId, { task: accepted })
    return accepted
  }
  f.owner.save('project-a', 'internal', command(), 'manager')
  const updating = f.owner.manual(
    'project-a',
    'internal',
    { requestId: randomUUID(), expectedRevision: 2 },
    'manager',
  )
  await flush()
  f.state.allowed = false
  gate.resolve()
  await assert.rejects(updating, { code: 'FIXTURE_REVOKED' })
  const evidence = new DatabaseSync(join(f.dataDir, 'workspace-updates/state.sqlite'))
  const persisted = evidence.prepare('SELECT task_id FROM workspace_update_runs').get()
  evidence.close()
  assert.equal(persisted.task_id, [...f.state.receipts.values()][0].task.id)
  assert.equal(
    f.owner.deletionReferences('project-a')[0]?.count,
    1,
    '已接受任务的原收据无法读取时必须保留引用，撤权不证明操作未发生',
  )
  f.state.allowed = true
  assert.equal(f.owner.overview('project-a', 'manager').internal.enabled, false)
  assert.equal(
    f.owner.overview('project-a', 'manager').internal.currentRun.error.code,
    'WORKSPACE_UPDATE_UNKNOWN',
  )
})

test('异步准备后核查来源身份，固定分支改动不能被当作原设置成功', async (t) => {
  const f = await fixture(t),
    gate = deferred()
  f.ports.start = async (_project, _scope, input) => {
    await gate.promise
    return task(input)
  }
  const updating = f.owner.manual(
    'project-a',
    'internal',
    { requestId: randomUUID(), expectedRevision: 2 },
    'manager',
  )
  await flush()
  f.state.fingerprint = 'changed-branch'
  gate.resolve()
  await assert.rejects(updating, { code: 'WORKSPACE_UPDATE_SOURCE_CHANGED' })
})

test('关闭中取消准备并等待端口排空，原请求未知保留且关闭幂等', async (t) => {
  const f = await fixture(t),
    cancelled = deferred(),
    release = deferred()
  f.ports.start = async (_project, _scope, _input, _actor, signal) => {
    signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
    await release.promise
    throw error(503, 'FIXTURE_ABORTED_BEFORE_RECEIPT')
  }
  const updating = f.owner.manual(
    'project-a',
    'internal',
    { requestId: randomUUID(), expectedRevision: 2 },
    'manager',
  )
  await flush()
  let closed = false
  const closing = f.owner.close().then(() => {
    closed = true
  })
  await cancelled.promise
  assert.equal(closed, false)
  await assert.rejects(
    f.owner.manual(
      'project-a',
      'external',
      { requestId: randomUUID(), expectedRevision: 2 },
      'manager',
    ),
    { code: 'WORKSPACE_UPDATE_STOPPING' },
  )
  release.resolve()
  await assert.rejects(updating, { code: 'FIXTURE_ABORTED_BEFORE_RECEIPT' })
  await closing
  assert.equal(closed, true)
  await f.owner.close()
})

async function managedFixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'autoops-managed-updates-'))
  const sessionDb = new DatabaseSync(':memory:'),
    bindingDb = new DatabaseSync(':memory:')
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  for (const actor of ['manager', 'second'])
    sessionDb
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(
        createHash('sha256').update(actor).digest('hex'),
        actor,
        'isolated-csrf',
        Date.now() + 60_000,
      )
  initializeAutoOpsAccessSchema(bindingDb)
  const membership = {
    userId: 'manager',
    workspaceAccess: 'internal',
    role: 'project_admin',
    status: 'active',
    environmentIds: [],
  }
  const project = {
    id: 'project-a',
    name: '隔离定期更新',
    memberIds: ['manager', 'second'],
    memberships: [membership, { ...membership, userId: 'second' }],
    environments: [],
    documents: [],
    resources: [],
  }
  const catalog = {
    users: [
      { id: 'manager', name: '管理者', role: 'member', status: 'active' },
      { id: 'second', name: '另一管理者', role: 'member', status: 'active' },
    ],
    projects: [project],
    agents: [],
  }
  let access
  const store = createWorkspaceStore({
    dataDir,
    authorizeTask: ({ actorId, projectId, type }) =>
      type === 'input'
        ? access.requireWorkspaceReader(actorId, projectId)
        : access.requireWorkspaceActor(actorId, projectId),
  })
  access = createAutoOpsAccess({
    sessionDb,
    bindingDb,
    catalog,
    workspaceStore: store,
    deploymentEnabled: () => false,
  })
  await store.ensureProject(project)
  const authoring = createWorkspaceAuthoring({
    dataDir,
    authorize: (actor, id, action) =>
      action === 'read'
        ? access.requireWorkspaceReader(actor, id)
        : action === 'external-read'
          ? access.requireWorkspaceInputReader(actor, id, 'external')
          : access.requireWorkspaceActor(actor, id),
  })
  const credentials = createProjectCredentialService({
    databasePath: join(dataDir, 'credentials.sqlite'),
    keyPath: join(dataDir, 'master.key'),
    initializeKeyIfNew: true,
    authorize: (actor, id, action) => access.requireCredentialActor(actor, id, action),
  })
  const repository = join(dataDir, 'fixture-repository')
  await mkdir(repository)
  await writeFile(join(repository, 'README.md'), '隔离原始仓库内容\n')
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repository])
  execFileSync('git', ['-C', repository, 'add', '.'])
  execFileSync('git', [
    '-C',
    repository,
    '-c',
    'user.name=隔离定期验收',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    '保存隔离资料',
  ])
  const commit = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  const state = { time: Date.parse('2026-10-26T00:00:00.000Z'), resolves: 0, fail: false }
  // 只替换远端传输；Git 提交、权限、原件、SQLite、任务和发布均使用真实实现。
  const git = {
    validateRepositorySource,
    async resolveRepositoryRef(source, _secret, signal) {
      signal.throwIfAborted()
      state.resolves++
      if (state.fail) throw error(502, 'WORKSPACE_GIT_FAILED')
      return {
        sourceId: source.id,
        commit,
        refKind: source.refKind,
        ref: source.ref || 'main',
        defaultRef: 'main',
      }
    },
    async fetchRepositoryAt(_source, resolved, target, _secret, signal, checkBudget) {
      signal.throwIfAborted()
      assert.equal(resolved, commit)
      if (state.beforeFetch) await state.beforeFetch()
      await cp(repository, target, { recursive: true })
      checkBudget()
    },
  }
  const service = createWorkspaceManagement({ access, store, authoring, credentials, git })
  const updates = createManagedWorkspaceUpdates({
    dataDir,
    access,
    store,
    service,
    now: () => state.time,
  })
  const mutation = () => ({
    requestId: randomUUID(),
    expectedRevision: authoring.overview(project.id, 'manager').revision,
  })
  const upload = async (path, value) => {
    const bytes = Buffer.from(value)
    return authoring.upload(
      project.id,
      {
        ...mutation(),
        path,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        conflict: 'replace',
      },
      bytes,
      'manager',
    )
  }
  const addSource = () => {
    const connection = authoring.saveRepository(
      project.id,
      null,
      {
        ...mutation(),
        value: { name: '隔离仓库', url: 'https://github.com/fixtures/scheduled.git' },
      },
      'manager',
    ).repository
    return authoring.configureSource(
      project.id,
      {
        ...mutation(),
        id: connection.id,
        role: 'documentation',
        refKind: 'default',
        ref: '',
        mountPath: 'source',
      },
      'manager',
    ).source
  }
  const settle = async () => {
    await flush()
    await updates.drain()
    await store.whenIdle()
    await flush()
    await updates.tick()
  }
  t.after(async () => {
    await updates.close()
    await service.close()
    await store.close()
    sessionDb.close()
    bindingDb.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return {
    dataDir,
    catalog,
    access,
    principal: (actor) => access.authenticateCookie(`demo_session=${actor}`),
    store,
    service,
    authoring,
    updates,
    membership,
    state,
    mutation,
    upload,
    addSource,
    settle,
    advance: () => {
      state.time += 5 * 60_000
    },
  }
}

test('实际资料服务：定期 Git 同步失败保留原当前内容，问答读取不再访问远端', async (t) => {
  const f = await managedFixture(t),
    source = f.addSource()
  await f.upload('docs/上传资料.md', '人工上传资料不会被 Git 覆盖')
  f.updates.save('project-a', 'internal', command(0, { sourceIds: [source.id] }), 'manager')
  f.advance()
  await f.updates.tick()
  await f.settle()
  assert.equal(f.updates.overview('project-a', 'manager').internal.lastRun.outcome, 'completed')
  const current = f.service.currentFile('project-a', 'source/README.md', 'manager')
  assert.equal(current.bytes.toString(), '隔离原始仓库内容\n')
  const first = await f.service.captureAgentInput(
    'project-a',
    { requestId: randomUUID(), workspaceType: 'internal' },
    'manager',
  )
  assert.equal(first.repositories.length, 1)
  const resolves = f.state.resolves
  f.state.fail = true
  f.advance()
  await f.updates.tick()
  await f.settle()
  assert.equal(f.updates.overview('project-a', 'manager').internal.lastRun.outcome, 'failed')
  assert.equal(
    f.service.currentFile('project-a', 'source/README.md', 'manager').bytes.toString(),
    current.bytes.toString(),
  )
  const afterFailure = f.state.resolves
  assert.equal(afterFailure, resolves + 1)
  const second = await f.service.captureAgentInput(
    'project-a',
    { requestId: randomUUID(), workspaceType: 'internal' },
    'manager',
  )
  assert.equal(second.repositories[0].commit, first.repositories[0].commit)
  assert.equal(f.state.resolves, afterFailure)
  assert.equal(
    f.service.currentFile('project-a', 'docs/上传资料.md', 'manager').bytes.toString(),
    '人工上传资料不会被 Git 覆盖',
  )
})

test('实际资料服务：定期外部生成不重拉 Git，二进制待复核和生成失败保留已发布内容', async (t) => {
  const f = await managedFixture(t)
  await f.upload('docs/公开说明.md', '第一份已发布资料')
  const firstTask = await f.updates.manual(
    'project-a',
    'external',
    { requestId: randomUUID() },
    'manager',
  )
  await f.settle()
  const original = f.store.taskForRequest('project-a', 'external', firstTask.requestId, 'manager')
  assert.equal(original.status, 'completed')
  const first = f.store.getVersion('project-a', original.versionId)
  assert.equal(first.status, 'published')
  await f.upload('docs/公开说明.md', '待检查的新资料')
  await f.upload(
    'images/待复核.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  f.updates.save('project-a', 'external', command(0, { sourceIds: [] }), 'manager')
  f.advance()
  await f.updates.tick()
  await f.settle()
  const plan = f.updates.overview('project-a', 'manager').external
  assert.equal(plan.lastRun.outcome, 'pending_review')
  assert.equal(
    f.store
      .overview('project-a')
      .externalVersions.filter((version) => version.status === 'published').length,
    1,
  )
  assert.equal(f.store.read('project-a', first.id, 'docs/公开说明.md').contents, '第一份已发布资料')
  assert.equal(f.state.resolves, 0)
  await f.upload('docs/192.168.1.2.md', '文件名敏感，真实规则必须拒绝')
  f.advance()
  await f.updates.tick()
  await f.settle()
  assert.equal(f.updates.overview('project-a', 'manager').external.lastRun.outcome, 'failed')
  assert.equal(f.store.getVersion('project-a', first.id).status, 'published')
  assert.equal(f.store.read('project-a', first.id, 'docs/公开说明.md').contents, '第一份已发布资料')
})

test('实际权限服务：配置后撤回项目成员使定期任务停用，不能用保存时角色继续同步', async (t) => {
  const f = await managedFixture(t),
    source = f.addSource()
  f.updates.save('project-a', 'internal', command(0, { sourceIds: [source.id] }), 'manager')
  f.membership.status = 'disabled'
  f.advance()
  await f.updates.tick()
  await f.settle()
  assert.equal(f.state.resolves, 0)
  f.membership.status = 'active'
  const plan = f.updates.overview('project-a', 'manager').internal
  assert.equal(plan.enabled, false)
  assert.equal(plan.pausedReason.code, 'WORKSPACE_UPDATE_PERMISSION_REVOKED')
})

test('旧历史版本外部写入仅恢复同操作者原任务，新请求明确转到当前资料流程', async (t) => {
  const f = await managedFixture(t)
  await f.upload('docs/公开资料.md', '原外部任务的固定资料')
  const accepted = await f.updates.manual(
    'project-a',
    'external',
    { requestId: randomUUID() },
    'manager',
  )
  await f.settle()
  const url = new URL('http://fixture.invalid/autoops/projects/project-a/workspaces/external')
  const restore = (actor, input) =>
    handleWorkspaceRequest({
      access: f.access,
      store: f.store,
      principal: f.principal(actor),
      url,
      method: 'POST',
      input,
    })
  const result = await restore('manager', {
    requestId: accepted.requestId,
    sourceVersionId: 'forged-new-version',
  })
  assert.equal(result.status, 202)
  assert.equal(result.body.id, accepted.id)
  assert.equal(result.body.status, 'completed')
  const count = f.store.overview('project-a').tasks.length
  await assert.rejects(
    restore('manager', { requestId: randomUUID(), sourceVersionId: 'any-history-version' }),
    { status: 410, code: 'WORKSPACE_EXTERNAL_CURRENT_REQUIRED' },
  )
  await assert.rejects(restore('second', { requestId: accepted.requestId }), {
    code: 'WORKSPACE_REQUEST_CONFLICT',
  })
  assert.equal(f.store.overview('project-a').tasks.length, count)
})

test('实际Worker：撤权后精确原任务终态可释放更新锁，新管理员用自己身份继续', async (t) => {
  const f = await managedFixture(t),
    source = f.addSource(),
    entered = deferred(),
    release = deferred()
  f.state.beforeFetch = async () => {
    entered.resolve()
    await release.promise
  }
  f.updates.save('project-a', 'internal', command(0, { sourceIds: [source.id] }), 'manager')
  const accepted = await f.updates.manual('project-a', 'internal', f.mutation(), 'manager')
  await entered.promise
  assert.equal(f.updates.deletionReferences('project-a')[0].count, 1)
  f.membership.status = 'disabled'
  release.resolve()
  await f.store.whenIdle()
  await flush()
  await f.updates.tick()
  const actual = f.store.overview('project-a').tasks.find((task) => task.id === accepted.id)
  assert.equal(actual.status, 'failed')
  assert.deepEqual(f.updates.deletionReferences('project-a'), [])
  assert.throws(() => f.updates.receipt('project-a', accepted.requestId, 'manager'))
  const next = await f.updates.manual(
    'project-a',
    'internal',
    {
      requestId: randomUUID(),
      expectedRevision: f.authoring.overview('project-a', 'second').revision,
    },
    'second',
  )
  await f.store.whenIdle()
  await flush()
  await f.updates.tick()
  assert.equal(
    f.store.overview('project-a').tasks.find((task) => task.id === next.id).status,
    'completed',
  )
  assert.equal(
    f.service.currentFile('project-a', 'source/README.md', 'second').bytes.toString(),
    '隔离原始仓库内容\n',
  )
})
