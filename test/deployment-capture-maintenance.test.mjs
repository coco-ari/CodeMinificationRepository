import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'
import { createDeploymentStore } from '../agent-demo/t3-adapters/deployments.mjs'
import { createWorkspaceAuthoring } from '../agent-demo/t3-adapters/workspace-authoring/index.ts'
import { createWorkspaceManagement } from '../agent-demo/t3-adapters/workspace-management.ts'
import { createProjectCredentialService } from '../agent-demo/t3-adapters/credentials.ts'

test('真实捕获所有者在操作者撤权后归还过期部署输入，维护保留原任务收据', async t => {
  const epoch = Date.parse('2026-01-01T00:00:00Z')
  t.mock.timers.enable({ apis: ['Date'], now: epoch })
  const dataDir = await mkdtemp(join(tmpdir(), 'autoops-deployment-owner-'))
  const projectId = 'p-owner-check', actorId = 'source-manager'
  let revoked = false
  const guard = () => { if (revoked) throw Object.assign(new Error('隔离成员已撤权'), { status: 403 }) }
  const access = {
    requireProjectActionForActor: guard, requireWorkspaceActor: guard, requireWorkspaceReader: guard,
    requireCredentialActor: guard, requireWorkspaceInputReader: guard, workspaceVersionReferences: () => [],
    requireDeploymentActor: guard, requireDeploymentActionForActor: guard,
  }
  const store = createWorkspaceStore({ dataDir, authorizeTask: guard })
  await store.ensureProject({ id: projectId, name: '隔离所有者核对' })
  const authoring = createWorkspaceAuthoring({ dataDir, authorize: guard })
  const credentials = createProjectCredentialService({ databasePath: join(dataDir, 'credentials.sqlite'), keyPath: join(dataDir, 'master.key'), initializeKeyIfNew: true, authorize: guard })
  // 只替换外部 Git 传输；捕获、收据、引用和回收均使用真实所有者。
  const git = {
    validateRepositorySource: value => value,
    async resolveRepositoryRef(source) { return { sourceId: source.id, commit: 'a'.repeat(40), refKind: source.refKind, ref: source.ref || 'main', defaultRef: 'main' } },
    async fetchRepositoryAt(source, commit, target, credential, signal, checkBudget) {
      signal.throwIfAborted()
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'index.html'), '<h1>隔离的固定 Git 内容</h1>')
      checkBudget()
    },
  }
  const management = createWorkspaceManagement({ access, store, authoring, credentials, git })
  const open = () => createDeploymentStore({ dataDir, workspaceStore: store, workspaceManagement: management, access, agentPort: 0 })
  let deployment = open()
  t.after(async () => { await deployment.close(); await management.close(); await store.close(); await rm(dataDir, { recursive: true, force: true }) })
  const revision = authoring.overview(projectId, actorId).revision
  const connection = authoring.saveRepository(projectId, null, {
    expectedRevision: revision, requestId: randomUUID(),
    value: { name: '隔离仓库', url: 'https://github.com/fixtures/d6-source.git' },
  }, actorId).repository
  const input = {
    requestId: randomUUID(),
    sources: [{ sourceId: connection.id, refKind: 'commit', ref: 'a'.repeat(40), mountPath: 'app' }],
    contexts: [{ service: 'frontend', root: 'app', workingDirectory: '.' }],
  }
  const task = management.startDeploymentPackages(projectId, input, actorId)
  await store.whenIdle()
  const receipt = store.taskForRequest(projectId, 'packages', input.requestId, actorId)
  assert.equal(receipt.status, 'completed', receipt.error)
  const pack = store.overview(projectId).releases.find(value => value.id === receipt.releaseId)
  assert.ok(store.planCleanupVersions(projectId, [pack.sourceVersionId], actorId).reasons[pack.sourceVersionId].some(value => value.kind === 'deployment'))
  assert.ok(store.packageFile(projectId, pack.id, 'frontend').bytes.length)
  revoked = true
  t.mock.timers.setTime(epoch + 8 * 86400000)
  await deployment.initialize()
  assert.throws(() => store.packageFile(projectId, pack.id, 'frontend'), { status: 410 })
  assert.throws(() => store.getVersion(projectId, pack.sourceVersionId), { status: 404 })
  assert.equal(store.overview(projectId).tasks.find(value => value.id === task.id).status, 'completed')
  await deployment.close()
  revoked = false
  const next = management.startDeploymentPackages(projectId, { ...input, requestId: randomUUID() }, actorId)
  await store.whenIdle()
  const nextReceipt = store.taskForRequest(projectId, 'packages', next.requestId, actorId)
  assert.equal(nextReceipt.status, 'completed', nextReceipt.error)
  const nextPack = store.overview(projectId).releases.find(value => value.id === nextReceipt.releaseId)
  assert.ok(store.packageFile(projectId, nextPack.id, 'frontend').bytes.length)
  revoked = true
  t.mock.timers.setTime(epoch + 16 * 86400000)
  deployment = open()
  await deployment.initialize()
  assert.throws(() => store.packageFile(projectId, nextPack.id, 'frontend'), { status: 410 })
  assert.throws(() => store.getVersion(projectId, nextPack.sourceVersionId), { status: 404 })
  assert.deepEqual(store.packageCleanupCandidates([]), [])
  assert.equal(store.overview(projectId).tasks.filter(value => value.status === 'completed').length, 2)
})
