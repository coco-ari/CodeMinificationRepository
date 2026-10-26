import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { RepositoryService } from '../src/service.mjs'
import { DeploymentService } from '../src/deployment.mjs'
import { Store } from '../src/store.mjs'

const mutation = (fields = {}) => ({ ...fields, requestId: randomUUID(), actor: { id: 'u-test-manager' } })
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cmr-project-api-'))
  const repository = new RepositoryService({ directory: root, builder: { initialize: async () => {}, build: async () => { throw new Error('隔离测试禁止远程构建') } } })
  await repository.initialize()
  const deployment = new DeploymentService(repository, options)
  await deployment.initialize()
  t.after(async () => { await deployment.close(); await repository.store.close(); await rm(root, { recursive: true, force: true }) })
  const projects = deployment.projects
  await projects.initialize()
  for (const id of ['p-one', 'p-two']) await projects.ensureProject({ id, name: id, environments: [{ id: 'test', name: '测试' }, { id: 'prod', name: '生产' }] })
  const server = await projects.createServer('p-one', mutation({ name: '隔离节点', environmentId: 'test' }))
  return { root, repository, deployment, projects, server: server.server }
}

test('独立 Java 服务与多个部署位置共享身份，同名服务不自动合并', async t => {
  const f = await fixture(t)
  const input = mutation({ name: '后端', kind: 'java', module: 'backend' })
  const service = await f.projects.saveService('p-one', input)
  assert.equal((await f.projects.saveService('p-one', input)).id, service.id)
  const another = await f.projects.saveService('p-one', mutation({ name: '后端', kind: 'java', module: 'backend' }))
  assert.notEqual(another.id, service.id)
  await f.projects.bindServer('p-one', mutation({ serverId: f.server.id, environmentId: 'prod' }))
  const target1 = await f.projects.createTarget('p-one', mutation({ serviceId: service.id, environmentId: 'test', serverId: f.server.id, config: {} }))
  const target2 = await f.projects.createTarget('p-one', mutation({ serviceId: service.id, environmentId: 'prod', serverId: f.server.id, config: {} }))
  assert.notEqual(target1, target2)
  assert.equal(f.projects.target('p-one', target1).service.id, service.id)
  assert.equal(f.projects.target('p-one', target2).target.config.kind, 'java')
  assert.equal(f.projects.snapshot('p-one').services.length, 2)
  await assert.rejects(f.projects.createTarget('p-two', mutation({ serviceId: service.id, environmentId: 'test', serverId: f.server.id, config: {} })), { status: 404 })
})

test('服务与目标编辑核对条件键，拒绝重绑归属和活动任务修改', async t => {
  const f = await fixture(t)
  const service = await f.projects.saveService('p-one', mutation({ name: '后端', kind: 'java', module: '.' }))
  const changed = await f.projects.saveService('p-one', mutation({ id: service.id, name: '新名称', kind: 'java', module: '.', configKey: service.configKey }))
  await assert.rejects(f.projects.saveService('p-one', mutation({ id: service.id, name: '覆盖', kind: 'java', module: '.', configKey: service.configKey })), { status: 409 })
  const targetId = await f.projects.createTarget('p-one', mutation({ serviceId: service.id, environmentId: 'test', serverId: f.server.id, config: {} }))
  const oldKey = f.deployment.configKey(targetId)
  const edit = mutation({ config: { profile: 'test' }, configKey: oldKey })
  assert.equal(await f.projects.updateTarget('p-one', targetId, edit), targetId)
  assert.equal(await f.projects.updateTarget('p-one', targetId, edit), targetId)
  await assert.rejects(f.projects.updateTarget('p-one', targetId, mutation({ config: {}, configKey: oldKey })), { status: 409 })
  await assert.rejects(f.projects.updateTarget('p-one', targetId, mutation({ config: {}, configKey: f.deployment.configKey(targetId), serverId: 'another' })), { status: 400 })
  await f.repository.store.change(state => state.deployments.tasks.push({ id: randomUUID(), targetId, applicationId: f.projects.snapshot('p-one').mapping.applicationId, status: 'running' }))
  await assert.rejects(f.projects.updateTarget('p-one', targetId, mutation({ config: {}, configKey: f.deployment.configKey(targetId) })), { status: 409 })
  await assert.rejects(f.projects.saveService('p-one', mutation({ id: service.id, name: '不可改', kind: 'java', module: '.', configKey: changed.configKey })), { status: 409 })
})

test('共享节点显式绑定，解绑保护现有目标且不改其他项目', async t => {
  const f = await fixture(t)
  const bind = mutation({ serverId: f.server.id, environmentId: 'test' })
  await f.projects.bindServer('p-two', bind)
  await f.projects.bindServer('p-two', bind)
  assert.equal(f.projects.snapshot('p-two').mapping.servers.length, 1)
  await f.projects.unbindServer('p-two', mutation({ serverId: f.server.id, environmentId: 'test' }))
  assert.equal(f.projects.snapshot('p-two').servers.length, 0)
  assert.equal(f.projects.snapshot('p-one').servers.length, 1)
  const targetId = await f.projects.createTarget('p-one', mutation({ name: '原静态服务', environmentId: 'test', serverId: f.server.id, config: { health: { url: 'https://test.invalid/' } } }))
  await assert.rejects(f.projects.unbindServer('p-one', mutation({ serverId: f.server.id, environmentId: 'test' })), { status: 409 })
  assert.equal(f.projects.target('p-one', targetId).service.kind, 'static')
  const listed = f.projects.availableServers()
  assert.equal(listed[0].registrationHash, undefined)
  assert.equal(listed[0].tokenHash, undefined)
})

test('服务来源按环境独立保存，重复请求和迟到修改不覆盖，不能混用服务类型', async t => {
  const f = await fixture(t)
  const service = await f.projects.saveService('p-one', mutation({ name: '后端', kind: 'java', module: '.' }))
  const source = mutation({ serviceId: service.id, environmentId: 'test', sources: [{ sourceId: 'repo-one', refKind: 'branch', ref: 'main', mountPath: 'repository' }], contexts: [{ service: 'backend', root: '.', workingDirectory: '.' }] })
  const saved = await f.projects.saveServiceSource('p-one', source)
  assert.deepEqual(await f.projects.saveServiceSource('p-one', source), saved)
  assert.equal(f.projects.serviceSource('p-one', service.id, 'prod'), null)
  await assert.rejects(f.projects.saveServiceSource('p-one', mutation({ ...source, sources: [{ sourceId: 'repo-two', refKind: 'default', ref: '', mountPath: 'repository' }] })), { status: 409 })
  const updated = await f.projects.saveServiceSource('p-one', mutation({ ...source, configKey: saved.configKey, sources: [{ sourceId: 'repo-two', refKind: 'default', ref: '', mountPath: 'repository' }] }))
  assert.notEqual(updated.configKey, saved.configKey)
  await assert.rejects(f.projects.saveServiceSource('p-one', mutation({ ...source, configKey: updated.configKey, contexts: [{ service: 'frontend', root: '.', workingDirectory: '.' }] })), { status: 400 })
  await assert.rejects(f.projects.saveServiceSource('p-two', source), { status: 404 })
})

test('映射版本升级保留原静态服务、目标和旧请求，重复初始化不改变身份', async t => {
  const f = await fixture(t)
  const input = mutation({ name: '存量静态', environmentId: 'test', serverId: f.server.id, config: { health: { url: 'https://old.invalid/' } } })
  const targetId = await f.projects.createTarget('p-one', input)
  const before = f.projects.target('p-one', targetId)
  await f.repository.store.change(state => {
    const bindings = state.autoopsDeploymentBindings, map = bindings.projects.find(entry => entry.projectId === 'p-one')
    bindings.version = 1; delete bindings.configurationVersion
    map.targetRequests.push({ requestId: input.requestId, fingerprint: '', targetId })
    delete map.mutationRequests; delete map.serviceSources
  })
  // 旧收据的摘要按旧静态创建合同生成，不依赖新事务元数据。
  const { digest } = await import('../src/security.mjs')
  await f.repository.store.change(state => {
    const map = state.autoopsDeploymentBindings.projects.find(entry => entry.projectId === 'p-one')
    map.targetRequests[0].fingerprint = digest(JSON.stringify([input.name, input.environmentId, input.serverId, before.target.config]))
  })
  await f.projects.initialize(); await f.projects.initialize()
  assert.equal(await f.projects.createTarget('p-one', input), targetId)
  assert.deepEqual(f.projects.target('p-one', targetId), before)
  assert.equal(f.projects.snapshot('p-one').services.length, 1)
  assert.equal(f.projects.snapshot('p-one').targets.length, 1)
  assert.equal(f.repository.store.state.autoopsDeploymentBindings.version, 1)
  assert.equal(f.repository.store.state.autoopsDeploymentBindings.configurationVersion, 1)
})

test('旧发行真实项目模块可在扩展后数据副本上初始化，保留新增服务来源和幂等收据', async t => {
  const f = await fixture(t)
  const service = await f.projects.saveService('p-one', mutation({name:'回滚保留服务',kind:'java',module:'.'}))
  await f.projects.saveServiceSource('p-one', mutation({serviceId:service.id,environmentId:'test',sources:[{sourceId:'repo-one',refKind:'tag',ref:'v1.0', mountPath: 'repository' }],contexts:[{service:'backend',root:'.',workingDirectory:'.'}]}))
  // 固定旧发行真实字节随测试保存，浅克隆也执行同一份回滚兼容程序。
  const previous = await readFile(new URL('./fixtures/deployment-projects-27fa5b34/deployment-projects.mjs', import.meta.url))
  assert.equal(createHash('sha256').update(previous).digest('hex'), 'a462431a6b44997327aff46a94fea550b64a0345be6638c685c0d849f12c1ad3')
  const source = previous.toString('utf8').replace("'./security.mjs'",JSON.stringify(new URL('../src/security.mjs',import.meta.url).href))
  const oldModule = path.join(f.root,'previous-deployment-projects.mjs')
  await writeFile(oldModule,source)
  const {createProjectDeployments} = await import(pathToFileURL(oldModule).href)
  const copyStore = new Store(path.join(f.root,'rollback-copy'))
  await copyStore.open(); t.after(()=>copyStore.close())
  const original = structuredClone(f.repository.store.state)
  await copyStore.change(state=>Object.assign(state,original))
  const oldProjects = createProjectDeployments({store:copyStore})
  await oldProjects.initialize()
  await oldProjects.ensureProject({id:'p-one',name:'p-one',environments:[{id:'test',name:'测试'},{id:'prod',name:'生产'}]})
  assert.deepEqual(copyStore.state,original)
  assert.equal(copyStore.state.autoopsDeploymentBindings.version,1)
  assert.ok(copyStore.state.autoopsDeploymentBindings.projects.find(value=>value.projectId==='p-one').mutationRequests.length>0)
  assert.equal(copyStore.state.autoopsDeploymentBindings.projects.find(value=>value.projectId==='p-one').serviceSources[0].sources[0].ref,'v1.0')
})

test('部署映射与配置扩展的未知格式拒绝初始化，不静默降级', async t => {
  const f = await fixture(t)
  for (const version of [{version:2,configurationVersion:1},{version:1,configurationVersion:2}]) {
    await f.repository.store.change(state=>Object.assign(state.autoopsDeploymentBindings,version))
    const before = structuredClone(f.repository.store.state)
    await assert.rejects(f.projects.initialize(),/部署项目.*版本无效/)
    assert.deepEqual(f.repository.store.state,before)
  }
})

test('并发服务创建只建一个实体，事务写入失败后可用原请求重试', async t => {
  const f = await fixture(t)
  const input = mutation({ name: '并发服务', kind: 'java', module: '.' })
  const results = await Promise.all([f.projects.saveService('p-one', input), f.projects.saveService('p-one', input)])
  assert.equal(results[0].id, results[1].id)
  await assert.rejects(f.projects.saveService('p-one', { ...input, actor: { id: 'u-other' } }), { status: 409 })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(f.repository.store.databaseFile)
  const another = mutation({ name: '写入故障', kind: 'static', module: '.' })
  try {
    db.exec("CREATE TRIGGER reject_deployment_write BEFORE UPDATE ON application_state BEGIN SELECT RAISE(ABORT, '隔离持久化失败'); END")
    await assert.rejects(f.projects.saveService('p-one', another), /隔离持久化失败/)
    assert.equal(f.projects.snapshot('p-one').services.length, 1)
  } finally { db.exec('DROP TRIGGER IF EXISTS reject_deployment_write'); db.close() }
  await f.projects.saveService('p-one', another)
  assert.equal(f.projects.snapshot('p-one').services.length, 2)
})

test('Java 部署位置保留固定网络身份，更新配置不会改当前版本', async t => {
  const f = await fixture(t)
  const service = await f.projects.saveService('p-one', mutation({ name: '后端', kind: 'java', module: '.' }))
  const networkIdentity = { network: 'shared-test', alias: 'backend-test' }
  const targetId = await f.projects.createTarget('p-one', mutation({ serviceId: service.id, environmentId: 'test', serverId: f.server.id, config: { networks: ['shared-test'] }, networkIdentity }))
  const currentRelease = { id: randomUUID(), config: { profile: 'current' }, revision: 'a'.repeat(40) }
  await f.repository.store.change(state => { state.deployments.targets.find(entry => entry.id === targetId).currentRelease = currentRelease })
  await f.projects.updateTarget('p-one', targetId, mutation({ config: { profile: 'next', networks: ['shared-test'] }, configKey: f.deployment.configKey(targetId) }))
  const selected = f.projects.target('p-one', targetId)
  assert.equal(selected.target.config.profile, 'next')
  assert.deepEqual(selected.target.currentRelease, currentRelease)
  assert.deepEqual(selected.target.networkIdentity, networkIdentity)
  await assert.rejects(f.projects.updateTarget('p-one', targetId, mutation({ config: selected.target.config, configKey: f.deployment.configKey(targetId), networkIdentity: null })), { status: 400 })
})

async function selectionFixture(t, options) {
  const f = await fixture(t, options)
  const service = await f.projects.saveService('p-one', mutation({ name: '持久源码服务', kind: 'java', module: '.' }))
  const targetId = await f.projects.createTarget('p-one', mutation({ serviceId: service.id, environmentId: 'test', serverId: f.server.id, config: {} }))
  const input = mutation({ projectId: 'p-one', targetId, configKey: f.deployment.configKey(targetId), sourceSelection: { sources: [{ sourceId: 'repo-one', refKind: 'branch', ref: 'main', mountPath: 'repository' }], contexts: [{ service: 'backend', root: '.', workingDirectory: '.' }] } })
  const bytes = Buffer.from('隔离的持久源码档案'), file = path.join(f.root, 'captured.zip')
  await writeFile(file, bytes)
  const archive = { file, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, revision: 'a'.repeat(40), commitSubject: '固定源码' }
  const sourceIdentity = { projectId: 'p-one', sourceVersionId: randomUUID(), packageId: randomUUID(), service: 'backend', contentHash: archive.sha256, repositories: [{ path: '.', commit: archive.revision }] }
  return { ...f, input, archive, sourceIdentity }
}

test('源码选择先持久任务，关闭页面不影响准备，同请求仅解析一次并固定来源', async t => {
  let resolve, calls = 0, cleaned = 0, authorizations = 0
  const waiting = new Promise(done => { resolve = done })
  const captured = []
  const f = await selectionFixture(t, { resolveWorkspaceSource: async task => { calls++; captured.push(task); return waiting }, authorizeTask: () => { authorizations++ } })
  const first = await f.deployment.createTaskFromWorkspaceSource(f.input)
  assert.equal(first.status, 'preparing')
  assert.equal(f.projects.task('p-one', first.id).requestId, f.input.requestId)
  assert.equal((await f.deployment.createTaskFromWorkspaceSource(f.input)).id, first.id)
  assert.equal(calls, 1)
  f.input.sourceSelection.sources[0].ref = 'later-branch'
  assert.equal(captured[0].sourceSelection.sources[0].ref, 'main')
  resolve({ archive: f.archive, sourceIdentity: f.sourceIdentity, cleanup: () => { cleaned++ } })
  await f.deployment.preparations.get(first.id)
  const ready = f.projects.task('p-one', first.id)
  assert.equal(ready.status, 'queued')
  assert.deepEqual(ready.sourceIdentity, f.sourceIdentity)
  assert.equal(ready.revision, f.archive.revision)
  assert.equal(cleaned, 1)
  assert.ok(authorizations >= 3)
  await assert.rejects(f.deployment.createTaskFromWorkspaceSource(f.input), { status: 409 })
})

for (const changed of [false, true]) test(`源码准备重启复用原请求，已固定内容不得漂移：${changed}`, async t => {
  const captured = []
  let f
  f = await selectionFixture(t, { resolveWorkspaceSource: async task => { captured.push(task); return { archive: f.archive, sourceIdentity: f.sourceIdentity } } })
  const first = await f.deployment.createTaskFromWorkspaceSource(f.input)
  await f.deployment.preparations.get(first.id)
  await f.repository.store.change(state => {
    const task = state.deployments.tasks.find(entry => entry.id === first.id)
    task.status = 'preparing'; task.stage = 'preparing'; task.source = null; delete task.sourceArchiveId
    if (changed) task.pendingSource.sha256 = 'b'.repeat(64)
  })
  await f.deployment.close()
  const restarted = new DeploymentService(f.repository, { resolveWorkspaceSource: async task => { captured.push(task); return { archive: f.archive, sourceIdentity: f.sourceIdentity } } })
  t.after(async () => { await restarted.close() })
  await restarted.initialize()
  await restarted.preparations.get(first.id)
  const recovered = restarted.projects.task('p-one', first.id)
  assert.equal(recovered.status, changed ? 'failed' : 'queued')
  assert.equal(recovered.id, first.id)
  assert.equal(captured[1].requestId, captured[0].requestId)
  assert.deepEqual(captured[1].sourceSelection, captured[0].sourceSelection)
  assert.equal(restarted.data.tasks.length, 1)
})

test('准备源码期间撤权拒绝入队，解析异常不改变其他任务或当前版本', async t => {
  let authorized = true, resolve
  const waiting = new Promise(done => { resolve = done })
  const f = await selectionFixture(t, { resolveWorkspaceSource: async () => waiting, authorizeTask: () => { if (!authorized) throw Object.assign(new Error('项目权限已撤销'), { status: 403 }) } })
  const task = await f.deployment.createTaskFromWorkspaceSource(f.input)
  authorized = false
  resolve({ archive: f.archive, sourceIdentity: f.sourceIdentity })
  await f.deployment.preparations.get(task.id)
  const failed = f.projects.task('p-one', task.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /权限/)
  assert.equal(f.deployment.releases(f.input.targetId).length, 0)
  assert.equal(await f.deployment.claim(f.server.id), null)
  await assert.rejects(f.deployment.createTaskFromWorkspaceSource({ ...f.input, requestId: randomUUID() }), { status: 403 })
})

test('项目写入在事务内重新裁决当前授权，排队期间撤权不落盘且不记录成功收据', async t => {
  let allowed = true
  const calls = []
  const f = await fixture(t, { authorizeProjectMutation: context => {
    calls.push(context)
    if (!allowed) throw Object.assign(new Error('事务前权限已撤销'), { status: 403 })
  } })
  const initial = await f.projects.saveService('p-one', mutation({ name: '原服务', kind: 'java', module: '.' }))
  const node = await f.projects.createServer('p-one', mutation({ name: '待删除节点', environmentId: 'test' }))
  await f.projects.revokeServer('p-one', node.server.id, mutation())
  const attempts = [
    { action: 'service.configure', execute: input => f.projects.saveService('p-one', input), input: mutation({ id: initial.id, name: '新服务', kind: 'java', module: '.', configKey: initial.configKey }) },
    { action: 'server.admin', execute: input => f.projects.saveStoragePolicy('p-one', f.server.id, input), input: mutation({ expectedRevision: 1, retainedVersions: 5, buildCacheGiB: 6 }) },
    { action: 'server.admin', execute: input => f.projects.revokeServer('p-one', f.server.id, input), input: mutation() },
    { action: 'server.admin', execute: input => f.projects.deleteServer('p-one', node.server.id, input), input: mutation() },
  ]
  for (const attempt of attempts) {
    let unblock, entered
    const gate = new Promise(resolve => { unblock = resolve }), started = new Promise(resolve => { entered = resolve })
    const blocker = f.repository.store.change(async () => { entered(); await gate })
    await started
    const waiting = attempt.execute(attempt.input)
    allowed = false
    unblock()
    await blocker
    await assert.rejects(waiting, { status: 403 })
    assert.equal(calls.at(-1).action, attempt.action)
    assert.equal(calls.at(-1).actor.id, 'u-test-manager')
    assert.equal(calls.at(-1).projectId, 'p-one')
    allowed = true
    await attempt.execute(attempt.input)
  }
  assert.equal(f.projects.service('p-one', initial.id).name, '新服务')
  assert.equal(f.projects.server('p-one', f.server.id).storagePolicy.revision, 2)
  assert.equal(f.projects.server('p-one', f.server.id).revoked, true)
  await assert.rejects(async () => f.projects.server('p-one', node.server.id), { status: 404 })
})

test('部署事务授权不能用未等待的异步结果放行', async t => {
  let asyncDecision = false
  const f = await fixture(t, { authorizeProjectMutation: () => asyncDecision ? Promise.resolve() : undefined })
  asyncDecision = true
  await assert.rejects(f.projects.saveService('p-one', mutation({ name: '不能落盘', kind: 'java', module: '.' })), { status: 503 })
  assert.equal(f.projects.snapshot('p-one').services.length, 0)
})

test('成功发布、重启和回退保留真实源码选择，历史记录不推断当前分支', async t => {
  let f
  f = await selectionFixture(t, { resolveWorkspaceSource: async () => ({ archive: f.archive, sourceIdentity: f.sourceIdentity }) })
  await f.deployment.heartbeat(f.server.id, { capabilities: ['source-archive-recovery-v1'] })
  const task = await f.deployment.createTaskFromWorkspaceSource(f.input)
  await f.deployment.preparations.get(task.id)
  await f.deployment.claim(f.server.id)
  const result = { id: task.id, image: `cmr/${task.targetId}:${task.id}`, revision: f.archive.revision }
  await f.deployment.events(f.server.id, task.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: result } })
  assert.deepEqual(f.deployment.release(task.targetId, task.id).sourceSelection, f.input.sourceSelection)
  const restart = await f.deployment.createTask(mutation({ targetId: task.targetId, action: 'restart', configKey: f.deployment.configKey(task.targetId) }))
  assert.deepEqual(restart.sourceSelection, f.input.sourceSelection)
  await f.deployment.claim(f.server.id)
  await f.deployment.events(f.server.id, restart.id, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: result } })
  const rollback = await f.deployment.createTask(mutation({ targetId: task.targetId, action: 'rollback', releaseId: task.id, configKey: f.deployment.configKey(task.targetId) }))
  assert.deepEqual(rollback.sourceSelection, f.input.sourceSelection)
  assert.equal(f.projects.taskForRequest('p-one', restart.requestId).id, restart.id)
  assert.equal(f.projects.taskForRequest('p-two', restart.requestId), null)
})

for (const operation of ['create-target', 'update-target', 'service-source']) test(`服务目录变化后原配置请求仍返回已接受收据：${operation}`, async t => {
  let allowed = true
  const f = await fixture(t, { authorizeProjectMutation() { if (!allowed) throw Object.assign(new Error('当前权限已撤销'), { status: 403 }) } })
  const service = await f.projects.saveService('p-one', mutation({ name: '收据服务', kind: 'java', module: '.' }))
  const create = mutation({ serviceId: service.id, environmentId: 'test', serverId: f.server.id, config: {} })
  const targetId = await f.projects.createTarget('p-one', create)
  const update = mutation({ config: { profile: 'test' }, configKey: f.deployment.configKey(targetId) })
  await f.projects.updateTarget('p-one', targetId, update)
  const source = mutation({ serviceId: service.id, environmentId: 'test', sources: [{ sourceId: 'repo-one', refKind: 'branch', ref: 'main', mountPath: 'repository' }], contexts: [{ service: 'backend', root: '.', workingDirectory: '.' }] })
  const saved = await f.projects.saveServiceSource('p-one', source)
  const input = operation === 'create-target' ? create : operation === 'update-target' ? update : source
  const submit = value => operation === 'create-target' ? f.projects.createTarget('p-one', value) : operation === 'update-target' ? f.projects.updateTarget('p-one', targetId, value) : f.projects.saveServiceSource('p-one', value)
  const expected = operation === 'service-source' ? saved : targetId
  assert.deepEqual(await submit(input), expected)
  await f.projects.saveService('p-one', mutation({ id: service.id, name: service.name, kind: 'java', module: 'backend', configKey: service.configKey }))
  const latest = await f.projects.saveServiceSource('p-one', mutation({ ...source, configKey: saved.configKey, contexts: [{ service: 'backend', root: '.', workingDirectory: 'backend' }] }))
  assert.deepEqual(await submit(input), expected)
  assert.equal(f.projects.snapshot('p-one').targets.length, 1)
  assert.equal(f.deployment.effectiveConfig(targetId).module, 'backend')
  assert.deepEqual(f.projects.serviceSource('p-one', service.id, 'test'), latest)
  const changed = operation === 'service-source' ? { ...input, sources: [{ sourceId: 'repo-two', refKind: 'default', ref: '', mountPath: 'repository' }] } : { ...input, config: { profile: 'changed' } }
  await assert.rejects(submit(changed), { status: 409, code: 'DEPLOYMENT_REQUEST_CONFLICT' })
  await assert.rejects(submit({ ...input, actor: { id: 'another-manager' } }), { status: 409, code: 'DEPLOYMENT_REQUEST_CONFLICT' })
  allowed = false
  await assert.rejects(submit(input), { status: 403 })
})

test('旧配置修改收据保留严格参数校验，不以新增指纹绕过冲突', async t => {
  const f = await fixture(t)
  const service = await f.projects.saveService('p-one', mutation({ name: '旧收据服务', kind: 'java', module: '.' }))
  const create = mutation({ serviceId: service.id, environmentId: 'test', serverId: f.server.id, config: {} })
  const targetId = await f.projects.createTarget('p-one', create)
  const update = mutation({ config: { profile: 'test' }, configKey: f.deployment.configKey(targetId) })
  await f.projects.updateTarget('p-one', targetId, update)
  const source = mutation({ serviceId: service.id, environmentId: 'test', sources: [{ sourceId: 'repo-one', refKind: 'default', ref: '', mountPath: 'repository' }], contexts: [{ service: 'backend', root: '.', workingDirectory: '.' }] })
  const saved = await f.projects.saveServiceSource('p-one', source)
  await f.repository.store.change(state => {
    for (const receipt of state.autoopsDeploymentBindings.projects[0].mutationRequests) delete receipt.submissionFingerprint
  })
  assert.equal(await f.projects.createTarget('p-one', create), targetId)
  assert.equal(await f.projects.updateTarget('p-one', targetId, update), targetId)
  assert.deepEqual(await f.projects.saveServiceSource('p-one', source), saved)
  await assert.rejects(f.projects.createTarget('p-one', { ...create, config: { profile: 'changed' } }), { status: 409 })
  await assert.rejects(f.projects.updateTarget('p-one', targetId, { ...update, config: { profile: 'changed' } }), { status: 409 })
  await assert.rejects(f.projects.saveServiceSource('p-one', { ...source, sources: [{ sourceId: 'repo-two', refKind: 'default', ref: '', mountPath: 'repository' }] }), { status: 409 })
})
