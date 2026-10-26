import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAccessService,
  initializeAutoOpsAccessSchema,
} from '../agent-demo/t3-adapters/access-service.mjs'
import { users, projects, agents } from '../agent-demo/fixtures.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-release-receipt-'))
  const path = join(directory, 'bindings.sqlite')
  const sessionDb = new DatabaseSync(':memory:')
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  let at = Date.parse('2026-10-26T12:00:00.000Z')
  sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(
    createHash('sha256').update('isolated-admin-cookie').digest('hex'),
    'u-admin', 'isolated-csrf', at + 86400000,
  )
  let db, access
  const open = () => {
    db = new DatabaseSync(path)
    initializeAutoOpsAccessSchema(db)
    access = createAccessService({
      sessionDb, bindingDb: db, catalog: structuredClone({ users, projects, agents }),
      now: () => at,
      workspaceStore: { getVersion: () => ({ id: 'fixed-version', type: 'internal', status: 'published' }) },
    })
  }
  open()
  const principal = access.authenticateCookie('demo_session=isolated-admin-cookie')
  access.bindThread(principal, {
    threadId: 'fixed-thread', projectId: 'p-autoops', environmentId: 'env-test',
    agentId: 'a-project', visibility: 'project', workspaceType: 'internal', workspaceVersionId: 'fixed-version',
  })
  t.after(() => { db.close(); sessionDb.close(); rmSync(directory, { recursive: true, force: true }) })
  return {
    get access() { return access },
    get db() { return db },
    principal,
    advance() { at += 60000 },
    reopen() { db.close(); open() },
    snapshot: () => access.workspaceVersionResourceSnapshot('fixed-thread'),
    receipt: () => db.prepare('SELECT * FROM t3_workspace_version_resource_releases WHERE thread_id=?').get('fixed-thread'),
  }
}

test('已释放固定版本重启后同一持久事件再核对，保留首次收据全部原字段且仍重试维护', t => {
  const f = fixture(t)
  let maintenanceCalls = 0
  const maintain = () => { maintenanceCalls++; assert.deepEqual(f.access.workspaceVersionReferences('p-autoops'), []) }
  assert.equal(f.access.releaseWorkspaceVersionResource(f.snapshot(), 41, maintain), true)
  const original = f.receipt()
  f.advance(); f.reopen()
  assert.equal(f.access.releaseWorkspaceVersionResource(f.snapshot(), 41, maintain), true)
  assert.deepEqual(f.receipt(), original)
  assert.equal(maintenanceCalls, 2)
})

test('原生附加事件位置前进而任务命令未新增，同版本重复维护不改释放位置和时间', t => {
  const f = fixture(t), snapshot = f.snapshot()
  f.access.releaseWorkspaceVersionResource(snapshot, 1433, () => {})
  const original = f.receipt()
  f.advance()
  assert.deepEqual(f.snapshot(), snapshot)
  let calls = 0
  for (const latestThreadSequence of [3533, 3540]) {
    assert.equal(f.access.releaseWorkspaceVersionResource(f.snapshot(), latestThreadSequence, () => { calls++ }), true)
    assert.deepEqual(f.receipt(), original)
  }
  assert.equal(calls, 2)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM t3_message_actors').get().n, 0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM t3_thread_inputs').get().n, 0)
})

for (const kind of ['message', 'queued-edit']) test(`真实新${kind}重新保护固定版本，旧快照拒绝且新终态形成新收据`, t => {
  const f = fixture(t), old = f.snapshot()
  f.access.releaseWorkspaceVersionResource(old, 41, () => {})
  const original = f.receipt()
  f.advance()
  if (kind === 'message') f.access.recordMessageActor(f.principal, 'fixed-thread', 'new-message-command', 'new-message')
  else f.access.recordQueuedEditActor(f.principal, 'fixed-thread', 'new-edit-command', 'queued-run')
  assert.equal(f.receipt(), undefined)
  assert.deepEqual(f.access.workspaceVersionReferences('p-autoops'), ['fixed-version'])
  assert.equal(f.access.releaseWorkspaceVersionResource(old, 42, () => assert.fail('旧快照不能启动回收')), false)
  assert.equal(f.access.releaseWorkspaceVersionResource(f.snapshot(), 42, () => {}), true)
  assert.equal(f.receipt().sequence, 42)
  assert.notEqual(f.receipt().created_at, original.created_at)
  assert.deepEqual(f.access.workspaceVersionReferences('p-autoops'), [])
})

test('首次维护失败回滚释放事实，已释放后的维护失败仍可重试且不重写成功收据', t => {
  const f = fixture(t), snapshot = f.snapshot()
  f.db.exec('CREATE TABLE isolated_maintenance_probe(id TEXT PRIMARY KEY)')
  assert.throws(() => f.access.releaseWorkspaceVersionResource(snapshot, 41, () => {
    f.db.prepare('INSERT INTO isolated_maintenance_probe VALUES(?)').run('not-committed')
    throw new Error('隔离维护失败')
  }), /隔离维护失败/)
  assert.equal(f.receipt(), undefined)
  assert.deepEqual(f.access.workspaceVersionReferences('p-autoops'), ['fixed-version'])
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM isolated_maintenance_probe').get().n, 0)
  f.access.releaseWorkspaceVersionResource(snapshot, 42, () => {})
  const original = f.receipt()
  f.advance()
  assert.throws(() => f.access.releaseWorkspaceVersionResource(snapshot, 43, () => { throw new Error('再次维护失败') }), /再次维护失败/)
  assert.deepEqual(f.receipt(), original)
  let recovered = false
  f.access.releaseWorkspaceVersionResource(snapshot, 43, () => { recovered = true })
  assert.equal(recovered, true)
  assert.deepEqual(f.receipt(), original)
})

test('已有释放收据不跳过真实来源快照、事件位置和同步事务校验', t => {
  const f = fixture(t), snapshot = f.snapshot()
  f.access.releaseWorkspaceVersionResource(snapshot, 41, () => {})
  const original = f.receipt()
  f.advance()
  for (const changed of [{ ...snapshot, versionId: 'other-version' }, { ...snapshot, projectId: 'other-project' }]) {
    assert.equal(f.access.releaseWorkspaceVersionResource(changed, 42, () => assert.fail('来源不一致不能回收')), false)
  }
  assert.throws(() => f.access.releaseWorkspaceVersionResource(snapshot, 0, () => {}), { code: 'THREAD_NATIVE_SOURCE_INVALID' })
  assert.throws(() => f.access.releaseWorkspaceVersionResource(snapshot, 42, () => Promise.resolve()), /不能包含异步/)
  assert.deepEqual(f.receipt(), original)
  f.db.exec('DROP TABLE t3_message_actors')
  assert.throws(() => f.access.releaseWorkspaceVersionResource(snapshot, 42, () => assert.fail('来源读取未知不能回收')), /no such table/)
  assert.deepEqual(f.receipt(), original)
})
