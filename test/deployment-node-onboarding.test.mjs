import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RepositoryService } from '../src/service.mjs'
import { DeploymentService } from '../src/deployment.mjs'
import { deploymentServerDto, deploymentInstallationInfo } from '../agent-demo/t3-adapters/deployment-servers.mjs'

const command = value => ({ requestId: randomUUID(), actor: { id: 'isolated-admin' }, ...value })
async function fixture(t, authorizeProjectMutation) {
  const directory = await mkdtemp(join(tmpdir(), 'node-onboarding-'))
  const repository = new RepositoryService({ directory, builder: { initialize: async () => {}, build: async () => assert.fail('隔离验收不访问远端源码') } })
  await repository.initialize()
  const deployment = new DeploymentService(repository, { publicOrigin: 'https://deploy.example.invalid', authorizeProjectMutation })
  await deployment.initialize()
  await deployment.projects.initialize()
  await deployment.projects.ensureProject({ id: 'p-one', name: '隔离项目', environments: [{ id: 'test', name: '测试' }, { id: 'stage', name: '预发' }] })
  t.after(async () => { await deployment.close(); await repository.store.close(); await rm(directory, { recursive: true, force: true }) })
  return deployment
}

test('一次分配原子授权和绑定多个环境，重复请求保持结果，非法环境不留下部分分配', async t => {
  const deployment = await fixture(t), projects = deployment.projects
  const { server } = await projects.createGlobalServer(command({ name: '隔离节点' }))
  const before = projects.globalNodeCatalog(command({}))
  await assert.rejects(projects.assignServer(server.id, command({ projectId: 'p-one', environmentIds: ['test', 'missing'], expectedRevision: 1 })), { status: 404 })
  assert.deepEqual(projects.globalNodeCatalog(command({})), before)
  const input = command({ projectId: 'p-one', environmentIds: ['test', 'stage'], expectedRevision: 1 })
  const result = await projects.assignServer(server.id, input)
  assert.deepEqual(result.environmentIds, ['test', 'stage'])
  assert.equal(result.revision, 2)
  assert.deepEqual(await projects.assignServer(server.id, input), result)
  const catalog = projects.globalNodeCatalog(command({}))
  assert.equal(catalog.bindings.length, 2)
  assert.deepEqual(catalog.projectAccess[0].serverIds, [server.id])
  const receipt = projects.globalNodeRequest(input.requestId, command({}))
  assert.equal(receipt.operation, 'assign')
  assert.equal(receipt.targetProjectId, 'p-one')
  assert.deepEqual(receipt.publicIntent.environmentIds, ['test', 'stage'])
  await assert.rejects(projects.assignServer(server.id, command({ ...input, requestId: randomUUID(), expectedRevision: 1 })), { status: 409 })
  const other = await projects.createGlobalServer(command({ name: '仅授权节点' }))
  await projects.assignServer(other.server.id, command({ projectId: 'p-one', environmentIds: [], expectedRevision: 2 }))
  assert.equal(projects.globalNodeCatalog(command({})).bindings.length, 2)
})

test('一次分配仍检查平台和每个环境权限，拒绝时不产生授权或绑定', async t => {
  let deny = false
  const deployment = await fixture(t, ({ projectId, environmentId, actor }) => {
    if (actor.id !== 'isolated-admin' || deny && projectId === 'p-one' && environmentId === 'stage') throw Object.assign(new Error('无权操作'), { status: 403 })
  })
  const projects = deployment.projects, { server } = await projects.createGlobalServer(command({ name: '权限节点' }))
  const before = projects.globalNodeCatalog(command({}))
  const input = { projectId: 'p-one', environmentIds: ['test', 'stage'], expectedRevision: 1 }
  await assert.rejects(projects.assignServer(server.id, command({ ...input, actor: { id: 'project-admin' } })), { status: 403 })
  deny = true
  await assert.rejects(projects.assignServer(server.id, command(input)), { status: 403 })
  assert.deepEqual(projects.globalNodeCatalog(command({})), before)
})

test('更新未注册节点口令使旧口令失效，重放不返回秘密，注册后禁止覆盖身份', async t => {
  const deployment = await fixture(t), projects = deployment.projects
  const first = await projects.createGlobalServer(command({ name: '待接入' }))
  const input = command({}), issued = await projects.renewServerRegistration(first.server.id, input)
  assert.notEqual(issued.registrationToken, first.registrationToken)
  await assert.rejects(deployment.register({ registrationToken: first.registrationToken, version: 'isolated' }), { status: 401 })
  const repeated = await projects.renewServerRegistration(first.server.id, input)
  assert.equal(repeated.registrationToken, null)
  const receipt = projects.globalNodeRequest(input.requestId, command({}))
  assert.equal(receipt.operation, 'registration')
  assert(!JSON.stringify(receipt).includes(issued.registrationToken))
  const registered = await deployment.register({ registrationToken: issued.registrationToken, version: 'isolated', capabilities: ['storage-policy-v1'] })
  assert.equal(registered.serverId, first.server.id)
  await assert.rejects(projects.renewServerRegistration(first.server.id, command({})), { status: 409 })
  assert.equal(deployment.authenticate(registered.token), first.server.id)
})

test('存储保存与实际应用分离，未接入、忙碌及失败报告使用真实状态并脱敏', async t => {
  const deployment = await fixture(t), projects = deployment.projects
  const registration = await projects.createGlobalServer(command({ name: '存储节点' }))
  const dto = () => deploymentServerDto(projects.globalNodeCatalog(command({})).servers[0])
  await projects.mutateGlobalServer(registration.server.id, 'storage', command({ expectedRevision: 1, retainedVersions: 4, buildCacheGiB: 3 }))
  assert.equal(dto().storageWaitingReason, 'offline')
  assert.equal(dto().registrationState, 'pending')
  await deployment.register({ registrationToken: registration.registrationToken, version: 'isolated', capabilities: ['storage-policy-v1'] })
  await deployment.heartbeat(registration.server.id, { activeTaskId: 'isolated-task', capabilities: ['storage-policy-v1'], storageStatus: { revision: 1, state: 'applied' } })
  assert.equal(dto().storageState, 'waiting')
  assert.equal(dto().storageWaitingReason, 'busy')
  await deployment.heartbeat(registration.server.id, { storageStatus: { revision: 2, state: 'failed', errors: ['ECONNRESET https://private:secret@example.invalid/image'] } })
  assert.equal(dto().storageState, 'failed')
  assert.match(dto().storageStatus.errors[0], /网络或镜像仓库/)
  assert.doesNotMatch(JSON.stringify(dto()), /private:secret|example.invalid/)
})

test('内部 CA 指引配置必须完整，安装资源保持 Linux 换行', async () => {
  const fingerprint = Array(32).fill('AA').join(':')
  assert.equal(deploymentInstallationInfo('https://center.invalid', '/ca.crt', fingerprint).ca.sha256, fingerprint)
  assert.throws(() => deploymentInstallationInfo('https://center.invalid', '//other.invalid/ca.crt', 'invalid'))
  assert.throws(() => deploymentInstallationInfo('https://center.invalid', '/../private.key', fingerprint))
  assert.equal((await readFile(new URL('../agent/install.sh', import.meta.url))).includes(13), false)
})
