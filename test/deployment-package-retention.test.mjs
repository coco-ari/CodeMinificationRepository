import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { RepositoryService } from '../src/service.mjs'
import { DeploymentService } from '../src/deployment.mjs'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'
import { createDeploymentStore } from '../agent-demo/t3-adapters/deployments.mjs'

const week = 7 * 86400000
const epoch = Date.parse('2026-01-01T00:00:00.000Z')
const principal = { id: 'package-manager', displayName: '隔离验收管理者' }
const project = { id: 'p-retention', name: '隔离回收项目', environments: [{ id: 'env-test', name: '隔离环境' }] }

async function fixture(t, workspaceManagement) {
  const dataDir = await mkdtemp(join(tmpdir(), 'autoops-delivery-retention-'))
  const workspace = createWorkspaceStore({ dataDir, authorizeTask() {} })
  await workspace.ensureProject(project)
  const task = workspace.startSourcePackages(project.id, { requestId: 'standalone-package' }, async ({ materializeCache }) => {
    const source = await materializeCache({ cacheKey: 'fixed-source', source: { repositories: [{ path: 'app', commit: 'a'.repeat(40) }], documents: [] } }, async ({ root }) => {
      await mkdir(join(root, 'app'), { recursive: true })
      await writeFile(join(root, 'app/index.html'), '<h1>按原提交交付</h1>')
    })
    return { sourceVersionId: source.id, contexts: [{ service: 'frontend', root: 'app', workingDirectory: '.' }] }
  }, principal.id)
  await workspace.whenIdle()
  const receipt = workspace.taskForRequest(project.id, 'packages', task.requestId, principal.id)
  assert.equal(receipt.status, 'completed', receipt.error)
  const pack = workspace.overview(project.id).releases[0], bytes = workspace.packageFile(project.id, pack.id, 'frontend').bytes
  // 本组只验证部署协议与存储交付；身份授权另由真实成员回归覆盖。
  const access = { requireDeploymentActor() {}, requireDeploymentActionForActor() {}, requireDeploymentNodeManager() {}, requireDeploymentNodeManagerForActor() {} }
  let store
  const open = async () => {
    if (store) await store.close()
    store = createDeploymentStore({ dataDir, workspaceStore: workspace, workspaceManagement, access, agentPort: 0 })
    await store.initialize()
    return store
  }
  await open()
  t.after(async () => { await store.close(); await workspace.close(); await rm(dataDir, { recursive: true, force: true }) })
  await store.ensureProject(project)
  const node = await store.createGlobalServer({ name: '隔离协议节点', requestId: randomUUID() }, principal)
  const expectedRevision = store.globalNodeCatalog(principal).projectAccess.find(value => value.projectId === project.id).revision
  await store.setServerAccess(project.id, { serverId: node.server.id, allowed: true, expectedRevision, requestId: randomUUID() }, principal)
  await store.bindServer(project.id, { serverId: node.server.id, environmentId: 'env-test', requestId: randomUUID(), actor: principal })
  const { target } = await store.createTarget(project.id, { name: '前端服务', environmentId: 'env-test', serverId: node.server.id, requestId: randomUUID(), actor: principal, config: { module: '.', artifactPath: 'dist', health: { url: 'http://127.0.0.1:12345/' } } })
  const agent = async (route, input, token) => {
    const response = await fetch(`http://127.0.0.1:${store.agentAddress.port}/api/agent/v1${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input) })
    const body = await response.json()
    assert.ok(response.ok, JSON.stringify(body))
    return body
  }
  const registered = await agent('/register', { registrationToken: node.registrationToken, capabilities: ['static-site-v1', 'source-archive-recovery-v1'] })
  const input = { targetId: target.id, service: 'frontend', action: 'deploy', packageId: pack.id, configKey: target.configKey, requestId: randomUUID() }
  return { workspace, pack, bytes, open, input, target, get store() { return store }, agent: (route, input) => agent(route, input, registered.token) }
}

test('包到期时排队与断线执行继续保护，真实失败收据七天后才释放', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: epoch })
  const f = await fixture(t), { task } = await f.store.createTask(project.id, f.input, principal)
  t.mock.timers.setTime(epoch + week + 1)
  await f.open()
  assert.deepEqual(f.workspace.packageFile(project.id, f.pack.id, 'frontend').bytes, f.bytes)
  await f.agent('/claim', {})
  t.mock.timers.setTime(epoch + 2 * week + 2)
  await f.open()
  assert.equal((await f.store.taskDetails(project.id, task.id)).task.status, 'running')
  assert.deepEqual(f.workspace.packageFile(project.id, f.pack.id, 'frontend').bytes, f.bytes)
  await f.agent(`/tasks/${task.id}/events`, { seq: 1, stage: 'failed', status: 'failed', message: '隔离协议验收失败收据' })
  assert.ok(f.workspace.packageFile(project.id, f.pack.id, 'frontend').bytes.length)
  t.mock.timers.setTime(epoch + 3 * week + 3)
  await f.open()
  assert.throws(() => f.workspace.packageFile(project.id, f.pack.id, 'frontend'), { status: 410 })
  assert.equal((await f.store.createTask(project.id, f.input, principal)).task.id, task.id)
  assert.equal((await f.store.taskDetails(project.id, task.id)).task.status, 'failed')
})

test('成功版本中心归档保留，工作区临时包过期后仍按原 ZIP 和配置恢复并形成新链条', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: epoch })
  const f = await fixture(t), { task } = await f.store.createTask(project.id, f.input, principal)
  await f.agent('/claim', {})
  await f.agent(`/tasks/${task.id}/events`, { seq: 1, stage: 'verifying', status: 'succeeded', result: { release: { id: task.id, kind: 'static', artifact: `static/${task.targetId}/${task.id}`, revision: task.revision } } })
  t.mock.timers.setTime(epoch + week + 1)
  await f.open()
  assert.throws(() => f.workspace.packageFile(project.id, f.pack.id, 'frontend'), { status: 410 })
  assert.deepEqual((await f.store.releaseSource(project.id, task.targetId, task.id)).bytes, f.bytes)
  const { task: rollback } = await f.store.createTask(project.id, { ...f.input, action: 'rollback', packageId: undefined, releaseId: task.id, requestId: randomUUID() }, principal)
  const claim = await f.agent('/claim', {})
  assert.equal(claim.task.id, rollback.id)
  assert.deepEqual(claim.task.config, task.config)
  assert.equal(claim.task.source.sha256, createHash('sha256').update(f.bytes).digest('hex'))
  await f.agent(`/tasks/${rollback.id}/events`, { seq: 1, stage: 'verifying', status: 'succeeded', result: { recoveryMethod: 'rebuild', release: { id: rollback.id, kind: 'static', artifact: `static/${task.targetId}/${rollback.id}`, revision: task.revision, restoredFromReleaseId: task.id } } })
  const releases = f.store.releases(project.id, task.targetId).releases
  assert.equal(releases.length, 2)
  assert.equal(releases[0].restoredFromReleaseId, task.id)
  assert.deepEqual((await f.store.releaseSource(project.id, task.targetId, rollback.id)).bytes, f.bytes)
})

test('缺失中心档案的保留版本链及未知任务仍在公开依赖快照内', async t => {
  const root = await mkdtemp(join(tmpdir(), 'autoops-package-references-'))
  const repository = new RepositoryService({ directory: root, builder: { async initialize() {} } })
  await repository.initialize()
  const deployment = new DeploymentService(repository)
  await deployment.initialize()
  t.after(async () => { await deployment.close(); await repository.store.close(); await rm(root, { recursive: true, force: true }) })
  const sourceIdentity = { projectId: project.id, packageId: randomUUID(), sourceVersionId: randomUUID() }
  // 持久化夹具覆盖执行器未回报的未知状态；不把它视为真实远端执行结果。
  await repository.store.change(state => {
    state.deployments.tasks.push({ id: randomUUID(), sourceKind: 'workspace-package', sourceIdentity, requestId: randomUUID(), status: 'unknown', createdAt: '2000-01-01T00:00:00Z' })
    state.deployments.releases.push({ id: randomUUID(), sourceKind: 'workspace-package', sourceIdentity, sourceArchiveId: randomUUID() })
  })
  assert.equal(deployment.workspacePackageReferences().length, 2)
  for (const reference of deployment.workspacePackageReferences()) {
    assert.equal(reference.packageId, sourceIdentity.packageId)
    assert.equal(reference.versionId, sourceIdentity.sourceVersionId)
  }
})

test('捕获证明失败时保留包与输入，恢复后先归还对应引用再回收', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: epoch })
  let proof = 'error'
  const candidates = []
  const f = await fixture(t, {
    releaseDeploymentSourceForMaintenance(candidate) {
      if (proof === 'error') throw new Error('隔离捕获证明故障')
      if (proof === 'blocked') return false
      if (proof === 'asynchronous') return Promise.resolve(true)
      candidates.push(candidate)
      // 此处仅验证适配器协调顺序；原捕获身份核对由真实资料所有者的回归负责。
      f.workspace.releaseVersion(project.id, 'deployment:isolated-capture')
      return true
    },
  })
  f.workspace.retainVersion(project.id, f.pack.sourceVersionId, 'deployment:isolated-capture')
  t.mock.timers.setTime(epoch + week + 1)
  for (const state of ['error', 'blocked', 'asynchronous']) {
    proof = state
    await f.open()
    assert.ok(f.workspace.packageFile(project.id, f.pack.id, 'frontend').bytes.length, state)
    assert.equal(f.workspace.getVersion(project.id, f.pack.sourceVersionId).id, f.pack.sourceVersionId)
  }
  proof = 'verified'
  await f.open()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].actorId, principal.id)
  assert.equal(candidates[0].sourceVersionId, f.pack.sourceVersionId)
  assert.throws(() => f.workspace.packageFile(project.id, f.pack.id, 'frontend'), { status: 410 })
  assert.throws(() => f.workspace.getVersion(project.id, f.pack.sourceVersionId), { status: 404 })
})
