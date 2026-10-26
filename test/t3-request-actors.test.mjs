import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAutoOpsBusinessTools, createBusinessArtifactStore } from '../agent-demo/t3-adapters/business-tools.mjs'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createBusinessResourceCatalog } from '../agent-demo/t3-adapters/resources.mjs'
import { createBusinessRunInputs } from '../agent-demo/t3-adapters/thread-inputs.ts'
import { environmentRunScope } from '../agent-demo/t3-adapters/environment-run-inputs.ts'
import { businessToolRun } from '../vendor/t3code/apps/server/src/autoops/businessToolScope.ts'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'

function fixture(t) {
  const sessionDb = new DatabaseSync(':memory:'), bindingDb = new DatabaseSync(':memory:')
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  for (const id of ['owner', 'caller', 'other']) sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(id).digest('hex'), id, 'csrf', 60_000)
  const membership = { userId: 'caller', role: 'reader', environmentIds: ['test'], status: 'active', canAdjustChat: true }
  const catalog = { users: [{ id: 'owner', name: '创建者', role: 'admin' }, { id: 'caller', name: '调用者', role: 'member' }, { id: 'other', name: '其他成员', role: 'member' }], projects: [{ id: 'project', name: '项目', memberIds: ['owner', 'caller', 'other'], memberships: [membership, { ...membership, userId: 'other' }], environments: [{ id: 'test', name: '测试' }, { id: 'prod', name: '生产' }], documents: [], resources: [] }], agents: [{ id: 'helper', projectIds: ['project'] }] }
  const access = createAutoOpsAccess({ sessionDb, bindingDb, catalog, now: () => 1000 }), owner = access.authenticateCookie('demo_session=owner'), caller = access.authenticateCookie('demo_session=caller'), other = access.authenticateCookie('demo_session=other')
  access.bindThread(owner, { threadId: 'shared', projectId: 'project', environmentId: 'test', agentId: 'helper', workspaceType: 'internal', visibility: 'project' })
  access.bindThread(owner, { threadId: 'private', projectId: 'project', environmentId: 'test', agentId: 'helper', workspaceType: 'internal', visibility: 'private' })
  t.after(() => { sessionDb.close(); bindingDb.close() })
  return { access, owner, caller, other, membership, bindingDb }
}

test('工具范围保留会话所有者但按真实调用者裁决，撤回后不能继承创建者权限', t => {
  const f = fixture(t)
  const scope = f.access.requireToolThread('shared', 'caller')
  assert.equal(scope.actorId, 'caller')
  assert.equal(scope.binding.ownerId, 'owner')
  f.membership.environmentIds = []
  assert.throws(() => f.access.requireToolThread('shared', 'caller'), { code: 'ENVIRONMENT_FORBIDDEN' })
  assert.throws(() => f.access.requireToolThread('private', 'caller'), { code: 'THREAD_NOT_FOUND' })
})

test('消息调用者收据由可信登录固定，原请求可恢复，不能改成其他成员或另一条消息', t => {
  const f = fixture(t)
  f.access.recordMessageActor(f.caller, 'shared', 'command-one', 'message-one')
  assert.equal(f.access.requireMessageActor('shared', 'message-one').actorId, 'caller')
  f.access.recordMessageActor(f.caller, 'shared', 'command-one', 'message-one')
  assert.throws(() => f.access.recordMessageActor(f.other, 'shared', 'command-one', 'message-one'), { code: 'MESSAGE_ACTOR_CONFLICT' })
  assert.throws(() => f.access.recordMessageActor(f.caller, 'shared', 'command-one', 'another-message'), { code: 'MESSAGE_ACTOR_CONFLICT' })
  assert.throws(() => f.access.recordMessageActor(f.caller, 'private', 'private-command', 'private-message'), { code: 'THREAD_NOT_FOUND' })
  assert.throws(() => f.access.requireMessageActor('shared', 'unknown'), { code: 'MESSAGE_ACTOR_MISSING' })
})

test('每轮输入固定真实调用者，原收据不改写，读取时即时校验撤权', t => {
  const f = fixture(t)
  f.access.bindRunInput('shared', 'run', 'input', 'caller')
  assert.equal(f.access.getRunInput('shared', 'run').actorId, 'caller')
  assert.equal(f.access.requireRunInput('shared', 'input').actorId, 'caller')
  assert.throws(() => f.access.bindRunInput('shared', 'run', 'input', 'owner'), { code: 'THREAD_INPUT_CONFLICT' })
  f.membership.status = 'disabled'
  assert.throws(() => f.access.requireRunInput('shared', 'input'), { code: 'THREAD_SCOPE_REVOKED' })
})

test('环境工具范围只取本轮实际调用者和固定环境，不能借创建者身份或另一轮输入', t => {
  const f = fixture(t)
  f.access.bindRunInput('shared', 'caller-run', 'caller-input', 'caller')
  f.access.bindRunInput('shared', 'owner-run', 'owner-input', 'owner')
  assert.deepEqual(environmentRunScope(f.access, 'shared', 'caller-run'), {
    actorId: 'caller', projectId: 'project', environmentId: 'test', threadId: 'shared', runId: 'caller-run',
  })
  assert.equal(f.access.getThreadBinding('shared').ownerId, 'owner')
  assert.throws(() => environmentRunScope(f.access, 'private', 'caller-run'), {code: 'THREAD_ACTOR_UNVERIFIED'})
  assert.throws(() => environmentRunScope(f.access, 'shared', 'missing'), {code: 'THREAD_ACTOR_UNVERIFIED'})
  f.bindingDb.prepare('UPDATE t3_thread_inputs SET actor_verified=0 WHERE run_id=?').run('owner-run')
  assert.throws(() => environmentRunScope(f.access, 'shared', 'owner-run'), {code: 'THREAD_ACTOR_UNVERIFIED'})
  f.membership.environmentIds = ['prod']
  assert.throws(() => environmentRunScope(f.access, 'shared', 'caller-run'), {code: 'ENVIRONMENT_FORBIDDEN'})
})


test('原生活动轮限定 inputId，旧输入不能选择创建者身份，没有活动轮时拒绝迟到工具', t => {
  const f = fixture(t)
  f.access.bindRunInput('shared', 'owner-run', 'owner-input', 'owner')
  f.access.bindRunInput('shared', 'caller-run', 'caller-input', 'caller')
  assert.equal(businessToolRun(f.access, 'shared', 'caller-input', 'caller-run').actorId, 'caller')
  assert.throws(() => businessToolRun(f.access, 'shared', 'owner-input', 'caller-run'), { code: 'THREAD_INPUT_FORBIDDEN' })
  assert.throws(() => businessToolRun(f.access, 'shared', 'owner-input', undefined), { code: 'THREAD_RUN_INACTIVE' })
})

test('新轮以实际消息调用者捕获资料，恢复固定输入所有者而不更换实际调用者', async t => {
  const f = fixture(t), captures = [], reads = []
  const workspace = {
    async captureAgentInput(projectId, input, actor) { captures.push(actor); return { id: 'caller-capture', projectId, workspaceType: input.workspaceType } },
    readInput(projectId, inputId, actor) { reads.push(actor); return { id: inputId, projectId, workspaceType: 'internal' } },
  }
  const inputs = createBusinessRunInputs(f.access, workspace)
  await assert.rejects(inputs.prepare('shared', 'missing-actor'), { code: 'MESSAGE_ACTOR_MISSING' })
  f.access.recordMessageActor(f.caller, 'shared', 'caller-command', 'caller-message')
  await inputs.prepare('shared', 'caller-run', undefined, undefined, 'caller-message')
  assert.deepEqual(captures, ['caller'])
  assert.equal(inputs.require('shared', 'caller-capture', 'caller-run').actorId, 'caller')
  f.access.recordMessageActor(f.other, 'shared', 'restart-command', 'restart-message')
  await inputs.prepare('shared', 'restart', 'caller-run', undefined, 'restart-message')
  assert.equal(f.access.getRunInput('shared', 'restart').actorId, 'other')
  assert.equal(f.access.getRunInput('shared', 'restart').inputOwnerId, 'caller')
  assert.equal(reads.at(-1), 'caller')
  assert.deepEqual(captures, ['caller'])
  f.membership.status = 'disabled'
  assert.throws(() => inputs.require('shared', 'caller-capture', 'caller-run'), { code: 'THREAD_SCOPE_REVOKED' })
})


test('共享会话报告记录真实发起者，不把成果所有者改成会话管理员', async t => {
  const f = fixture(t), directory = mkdtempSync(join(tmpdir(), 'request-actor-report-'))
  const artifacts = createBusinessArtifactStore(directory)
  t.after(() => { artifacts.close(); rmSync(directory, { recursive: true, force: true }) })
  const tools = createAutoOpsBusinessTools({ authorizeThread: thread => f.access.requireToolThread(thread, 'caller'), loadAttachments: () => [], storeArtifact: input => artifacts.create(input) })
  const report = await tools.createReport('shared', 'caller-run', { name: '分析.md', mime: 'text/markdown', content: '真实调用者生成的分析' })
  assert.equal(artifacts.read(report.id).ownerId, 'caller')
  assert.equal(artifacts.read(report.id).threadId, 'shared')
  assert.equal(f.access.getThreadBinding('shared').ownerId, 'owner')
})


test('已固定身份的接受轮次按原持久输入恢复，没有消息身份的新轮仍拒绝', async t => {
  const f = fixture(t), captures = []
  f.access.bindRunInput('shared', 'legacy-run', 'legacy-input', 'owner')
  const inputs = createBusinessRunInputs(f.access, { readInput(projectId, id, actor) { assert.equal(actor, 'owner'); return { id, projectId, workspaceType: 'internal' } }, async captureAgentInput() { captures.push(true); throw new Error('不能捕获新资料') } })
  assert.equal((await inputs.prepare('shared', 'legacy-run', undefined, undefined, 'legacy-native-message')).id, 'legacy-input')
  await assert.rejects(inputs.prepare('shared', 'new-without-actor', undefined, undefined, 'untracked-message'), { code: 'MESSAGE_ACTOR_MISSING' })
  assert.deepEqual(captures, [])
})


test('存量私有输入可核验为原所有者，共享输入缺少实际调用者证据时保留记录但不继承管理员执行权', t => {
  const f = fixture(t)
  f.access.bindRunInput('shared', 'old-shared', 'shared-input', 'owner')
  f.access.bindRunInput('private', 'old-private', 'private-input', 'owner')
  f.bindingDb.exec('ALTER TABLE t3_thread_inputs DROP COLUMN actor_verified')
  initializeAutoOpsAccessSchema(f.bindingDb)
  assert.equal(f.access.getRunInput('private', 'old-private').actorVerified, true)
  assert.equal(businessToolRun(f.access, 'private', 'private-input', 'old-private').actorId, 'owner')
  assert.equal(f.access.getRunInput('shared', 'old-shared').inputId, 'shared-input')
  assert.throws(() => businessToolRun(f.access, 'shared', 'shared-input', 'old-shared'), { code: 'THREAD_ACTOR_UNVERIFIED' })
})


test('排队问题由另一位成员成功编辑后，新轮捕获采用编辑者而非原作者或会话所有者', async t => {
  const f = fixture(t), actors = []
  f.access.recordMessageActor(f.caller, 'shared', 'original-command', 'queued-message')
  f.access.recordQueuedEditActor(f.other, 'shared', 'accepted-edit', 'queued-run')
  const inputs = createBusinessRunInputs(f.access, { async captureAgentInput(projectId, input, actor) { actors.push(actor); return { id: 'edited-input', projectId, workspaceType: input.workspaceType } } })
  await inputs.prepare('shared', 'queued-run', undefined, undefined, 'queued-message', 'accepted-edit')
  assert.deepEqual(actors, ['other'])
  assert.equal(f.access.getRunInput('shared', 'queued-run').actorId, 'other')
})


test('调用者升级写入失败时连同字段回滚，重试仍保留私有原输入及未知共享事实', t => {
  const f = fixture(t)
  f.access.bindRunInput('private', 'old-private', 'input')
  for (const column of ['actor_verified', 'actor_id', 'input_owner_id']) f.bindingDb.exec(`ALTER TABLE t3_thread_inputs DROP COLUMN ${column}`)
  f.bindingDb.exec("CREATE TRIGGER actor_upgrade_fail BEFORE UPDATE ON t3_thread_inputs BEGIN SELECT RAISE(ABORT, 'isolated migration failure'); END")
  assert.throws(() => initializeAutoOpsAccessSchema(f.bindingDb), /isolated migration failure/)
  assert.equal(f.bindingDb.prepare('PRAGMA table_info(t3_thread_inputs)').all().some(row => row.name === 'actor_id'), false)
  f.bindingDb.exec('DROP TRIGGER actor_upgrade_fail')
  initializeAutoOpsAccessSchema(f.bindingDb)
  assert.equal(f.access.getRunInput('private', 'old-private').inputId, 'input')
  assert.equal(f.access.getRunInput('private', 'old-private').actorVerified, true)
})


test('共享会话提交真实调用者刚选择的当前资料，引用仍固定调用者输入而不借用创建者存储身份', t => {
  const f = fixture(t)
  const workspaceInputs = {
    readInput(projectId, inputId, actor) {
      if (actor !== 'caller' || inputId !== 'caller-picked') throw Object.assign(new Error('此输入不属于读取身份'), { code: 'WORKSPACE_INPUT_NOT_FOUND' })
      return { id: inputId, projectId, workspaceType: 'internal', directories: [], repositories: [], createdAt: 'now', revision: 1 }
    },
    inputFiles() { return [{ path: 'docs/产品.md', id: 'file', mime: 'text/markdown', size: 8 }] },
  }
  const catalog = createBusinessResourceCatalog({ access: f.access, workspaceInputs })
  catalog.requireContext('shared', { records: [{ kind: 'mention', path: 'autoops/project/inputs/caller-picked/docs/产品.md' }] }, 'caller')
  assert.deepEqual(f.access.inputReferences('shared'), [{ inputId: 'caller-picked', actorId: 'caller' }])
})


test('未知存量共享调用者不能通过原任务恢复转成已核验身份', async t => {
  const f = fixture(t)
  f.access.bindRunInput('shared', 'old-shared', 'shared-input', 'owner')
  f.bindingDb.exec('ALTER TABLE t3_thread_inputs DROP COLUMN actor_verified')
  initializeAutoOpsAccessSchema(f.bindingDb)
  const inputs = createBusinessRunInputs(f.access, { readInput() { return { id: 'shared-input' } } })
  await assert.rejects(inputs.prepare('shared', 'old-shared'), { code: 'THREAD_ACTOR_UNVERIFIED' })
  await assert.rejects(inputs.prepare('shared', 'recovered', 'old-shared'), { code: 'THREAD_ACTOR_UNVERIFIED' })
  assert.equal(f.access.getRunInput('shared', 'recovered'), undefined)
})


test('共享会话不能用猜测路径引用创建者尚未共享的私有资料输入', t => {
  const f = fixture(t)
  const catalog = createBusinessResourceCatalog({ access: f.access, workspaceInputs: {
    readInput(projectId, inputId, actor) {
      if (actor !== 'owner') throw Object.assign(new Error('不属于此账号'), { code: 'WORKSPACE_INPUT_NOT_FOUND' })
      return { id: inputId, projectId, workspaceType: 'internal', directories: [], repositories: [], createdAt: 'now', revision: 1 }
    },
    inputFiles() { return [{ path: 'private.txt', id: 'file', mime: 'text/plain', size: 1 }] },
  } })
  assert.throws(() => catalog.requireContext('shared', { records: [{ kind: 'mention', path: 'autoops/project/inputs/not-shared/private.txt' }] }, 'caller'), { code: 'RESOURCE_NOT_FOUND' })
  assert.deepEqual(f.access.inputReferences('shared'), [])
})
