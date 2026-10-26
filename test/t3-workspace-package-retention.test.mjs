import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, access, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'

const retention = 7 * 86400000
const startTime = Date.parse('2026-01-01T00:00:00.000Z')

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'autoops-package-retention-'))
  const store = createWorkspaceStore({ dataDir, authorizeTask() {} })
  await store.ensureProject({ id: 'p-retention', name: '源码包回收验证' })
  t.after(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }) })
  return { dataDir, store }
}

async function materializeCache(context) {
  return context.materializeCache({ cacheKey: 'fixed-source', source: { repositories: [{ path: 'app', commit: 'a'.repeat(40) }], documents: [] } }, async ({ root }) => {
    await mkdir(join(root, 'app'), { recursive: true })
    await writeFile(join(root, 'app', 'index.html'), '<h1>固定源码</h1>')
  })
}

async function packaged(store) {
  const input = { requestId: 'retained-package' }
  const prepare = async context => {
    const version = await materializeCache(context)
    return { sourceVersionId: version.id, contexts: [{ service: 'frontend', root: 'app', workingDirectory: '.' }] }
  }
  const task = store.startSourcePackages('p-retention', input, prepare, 'manager')
  await store.whenIdle()
  const receipt = store.taskForRequest('p-retention', 'packages', input.requestId, 'manager')
  assert.equal(receipt.status, 'completed', receipt.error)
  return { input, prepare, task, release: store.overview('p-retention').releases[0] }
}

test('源码打包确定失败后可以回收其无引用固定输入，失败收据仍按原请求返回', async t => {
  const { store } = await fixture(t)
  const input = { requestId: 'failed-package' }
  let version
  const prepare = async context => {
    version = await materializeCache(context)
    return { sourceVersionId: version.id, contexts: [{ service: 'frontend', root: 'missing', workingDirectory: '.' }] }
  }
  const task = store.startSourcePackages('p-retention', input, prepare, 'manager')
  await store.whenIdle()
  assert.equal(store.taskForRequest('p-retention', 'packages', input.requestId, 'manager').status, 'failed')
  assert.deepEqual(store.pruneVersions('p-retention', [version.id], 'manager').removed, [version.id])
  assert.throws(() => store.getVersion('p-retention', version.id), { status: 404 })
  assert.equal(store.startSourcePackages('p-retention', input, prepare, 'manager').id, task.id)
})

test('成功打包由交付包保护固定输入，不再遗留已经完成的任务保护引用', async t => {
  const { store } = await fixture(t)
  let version
  const task = store.startSourcePackages('p-retention', { requestId: 'completed-package' }, async context => {
    version = await materializeCache(context)
    return { sourceVersionId: version.id, contexts: [{ service: 'frontend', root: 'app', workingDirectory: '.' }] }
  }, 'manager')
  await store.whenIdle()
  const receipt = store.taskForRequest('p-retention', 'packages', task.requestId, 'manager')
  assert.equal(receipt.status, 'completed', receipt.error)
  assert.ok(store.packageFile('p-retention', receipt.releaseId, 'frontend').bytes.length)
  assert.throws(() => store.pruneVersions('p-retention', [version.id], 'manager'), { code: 'WORKSPACE_VERSION_IN_USE' })
  assert.deepEqual(store.planCleanupVersions('p-retention', [version.id], 'manager').reasons[version.id], [{ kind: 'package', reference: receipt.releaseId }])
})

test('仅下载的源码包七天后回收，重开保留原清单和原请求且不重复打包', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: startTime })
  const { store, dataDir } = await fixture(t)
  const { input, prepare, task, release } = await packaged(store)
  const original = store.packageFile('p-retention', release.id, 'manifest').bytes
  assert.ok(store.packageFile('p-retention', release.id, 'frontend').bytes.length)
  t.mock.timers.setTime(startTime + retention - 1)
  store.cleanupPackages([])
  assert.ok(store.packageFile('p-retention', release.id, 'frontend').bytes.length)
  await store.close()
  const reopened = createWorkspaceStore({ dataDir, authorizeTask() {} })
  t.after(() => reopened.close())
  t.mock.timers.setTime(startTime + retention + 1)
  reopened.cleanupPackages([])
  assert.throws(() => reopened.packageFile('p-retention', release.id, 'frontend'), { status: 410, code: 'WORKSPACE_PACKAGE_EXPIRED' })
  assert.deepEqual(reopened.packageFile('p-retention', release.id, 'manifest').bytes, original)
  assert.equal(reopened.startSourcePackages('p-retention', input, prepare, 'manager').id, task.id)
  assert.throws(() => reopened.getVersion('p-retention', release.sourceVersionId), { status: 404 })
  await assert.rejects(access(join(dataDir, 'project-workspaces/p-retention/packages', release.id)), { code: 'ENOENT' })
  await assert.rejects(access(join(dataDir, 'project-workspaces/p-retention/versions', release.sourceVersionId)), { code: 'ENOENT' })
})

test('原请求、包或固定版本的部署保护均阻止过期清理，引用读取失败时保留全部内容', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: startTime })
  const { store } = await fixture(t), { input, release } = await packaged(store)
  t.mock.timers.setTime(startTime + retention + 1)
  for (const reference of [{ requestId: input.requestId }, { packageId: release.id }, { versionId: release.sourceVersionId }]) {
    store.cleanupPackages([{ projectId: 'p-retention', ...reference }])
    assert.ok(store.packageFile('p-retention', release.id, 'frontend').bytes.length)
    assert.equal(store.getVersion('p-retention', release.sourceVersionId).id, release.sourceVersionId)
  }
  assert.throws(() => store.cleanupPackages(undefined), { code: 'WORKSPACE_PACKAGE_REFERENCES_UNAVAILABLE' })
  assert.ok(store.packageFile('p-retention', release.id, 'frontend').bytes.length)
  store.cleanupPackages([{ projectId: 'another-project', packageId: release.id }])
  assert.throws(() => store.packageFile('p-retention', release.id, 'frontend'), { status: 410 })
})

test('包到期不删除当前资料或其他输入保护的版本，最后一个引用归还后才能回收部署缓存', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: startTime })
  const { store } = await fixture(t), { release } = await packaged(store)
  store.retainVersion('p-retention', release.sourceVersionId, 'input:accepted-run')
  t.mock.timers.setTime(startTime + retention + 1)
  store.cleanupPackages([])
  assert.throws(() => store.packageFile('p-retention', release.id, 'frontend'), { status: 410 })
  assert.match(store.read('p-retention', release.sourceVersionId, 'app/index.html').contents, /固定源码/)
  store.releaseVersion('p-retention', 'input:accepted-run')
  store.cleanupPackages([])
  assert.throws(() => store.getVersion('p-retention', release.sourceVersionId), { status: 404 })
})

test('取消已落盘但本地生产者尚未退出时不清理其输入', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: startTime })
  const { store } = await fixture(t)
  let releaseWorker, ready
  const started = new Promise(resolve => { ready = resolve })
  const blocked = new Promise(resolve => { releaseWorker = resolve })
  let version
  const task = store.startSourcePackages('p-retention', { requestId: 'cancel-package' }, async context => {
    version = await materializeCache(context); ready()
    await blocked
    throw new Error('隔离生产者已停止')
  }, 'manager')
  await started
  store.cancelTask('p-retention', task.id)
  t.mock.timers.setTime(startTime + retention + 1)
  try {
    store.cleanupPackages([])
    assert.match(store.read('p-retention', version.id, 'app/index.html').contents, /固定源码/)
  } finally { releaseWorker() }
  await store.whenIdle()
  store.cleanupPackages([])
  assert.match(store.read('p-retention', version.id, 'app/index.html').contents, /固定源码/)
  t.mock.timers.setTime(startTime + 2 * retention + 2)
  store.cleanupPackages([])
  assert.throws(() => store.getVersion('p-retention', version.id), { status: 404 })
})

test('捕获归还候选仅包含无部署依赖且超过保留期的原打包收据', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: startTime })
  const { store } = await fixture(t), { input, task, release } = await packaged(store)
  assert.deepEqual(store.packageCleanupCandidates([]), [])
  t.mock.timers.setTime(startTime + retention + 1)
  for (const reference of [{ requestId: input.requestId }, { packageId: release.id }, { versionId: release.sourceVersionId }])
    assert.deepEqual(store.packageCleanupCandidates([{ projectId: 'p-retention', ...reference }]), [])
  assert.deepEqual(store.packageCleanupCandidates([]), [{ projectId: 'p-retention', requestId: input.requestId, actorId: 'manager', taskId: task.id, sourceVersionId: release.sourceVersionId }])
  assert.throws(() => store.packageCleanupCandidates([{ projectId: 'p-retention', packageId: 123 }]), { code: 'WORKSPACE_PACKAGE_REFERENCES_UNAVAILABLE' })
  assert.ok(store.packageFile('p-retention', release.id, 'frontend').bytes.length)
})

test('旧固定版本打包入口在包和输入回收后仍返回原请求收据，篡改参数继续拒绝', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: startTime })
  const { store } = await fixture(t), { release } = await packaged(store)
  const input = { sourceVersionId: release.sourceVersionId, services: ['frontend'], contexts: [{ service: 'frontend', root: 'app', workingDirectory: '.' }], requestId: 'fixed-version-package' }
  const task = store.startPackages('p-retention', input, 'manager')
  await store.whenIdle()
  t.mock.timers.setTime(startTime + retention + 1)
  store.cleanupPackages([])
  assert.throws(() => store.getVersion('p-retention', release.sourceVersionId), { status: 404 })
  assert.equal(store.startPackages('p-retention', input, 'manager').id, task.id)
  assert.throws(() => store.startPackages('p-retention', { ...input, services: ['backend'] }, 'manager'), { code: 'WORKSPACE_REQUEST_CONFLICT' })
})

test('物理回收失败保持不可读状态，修复存储权限后按原清理收据继续', async t => {
  if (process.platform === 'win32') { t.skip('此用例需要 POSIX 目录写权限'); return }
  t.mock.timers.enable({ apis: ['Date'], now: startTime })
  const { store, dataDir } = await fixture(t), { release } = await packaged(store)
  t.mock.timers.setTime(startTime + retention + 1)
  const packages = join(dataDir, 'project-workspaces/p-retention/packages')
  await chmod(packages, 0o500)
  try {
    assert.throws(() => store.cleanupPackages([]), AggregateError)
    assert.throws(() => store.packageFile('p-retention', release.id, 'frontend'), { status: 410 })
  } finally { await chmod(packages, 0o700) }
  store.cleanupPackages([])
  await assert.rejects(access(join(packages, release.id)), { code: 'ENOENT' })
  assert.equal(store.overview('p-retention').tasks.length, 1)
})
