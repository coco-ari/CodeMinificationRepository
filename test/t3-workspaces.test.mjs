import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'
import { extractZip } from '../agent/archive.mjs'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'

async function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 't3-workspaces-'))
  const store = createWorkspaceStore({ dataDir, authorizeTask: () => {}, ...options })
  t.after(async () => { await store.close(); rmSync(dataDir, { recursive: true, force: true }) })
  await store.ensureProject({ id: 'p-test', name: '验证项目', documents: [{ id: 'd1', name: '设计.md', content: '# 固定项目资料\n项目代号 INTERNAL-DEMO' }] })
  return { store, dataDir, version: store.overview('p-test').internalVersions[0] }
}
async function finish(store, task) {
  for (let i = 0; i < 200; i++) {
    const current = store.overview('p-test').tasks.find((entry) => entry.id === task.id)
    if (!['queued', 'running'].includes(current.status)) return current
    await new Promise((done) => setTimeout(done, 10))
  }
  assert.fail('工作区任务未在预期时间完成')
}
const publish = (store, version) => store.confirmExternal('p-test', version.id, { confirmedPaths: version.report.pendingFiles.map((entry) => entry.path), excludedPaths: [] })

test('工作区任务限制并发和排队容量，重复提交不占容量，取消排队任务不生成发布物', async (t) => {
  const { store, version } = await fixture(t, { taskLimits: { maxConcurrent: 1, maxQueued: 1 } })
  const firstInput = { sourceVersionId: version.id, services: ['frontend'], requestId: 'bounded-first' }
  const first = store.startPackages('p-test', firstInput)
  assert.equal(first.requestId, firstInput.requestId)
  assert.equal(first.actorId, undefined); assert.equal(first.fingerprint, undefined); assert.equal(first.ownerPid, undefined)
  const queued = store.startPackages('p-test', { ...firstInput, requestId: 'bounded-second' })
  assert.equal(store.startPackages('p-test', firstInput).id, first.id)
  assert.throws(() => store.startPackages('p-test', { ...firstInput, requestId: 'capacity-overflow' }), { status: 429, code: 'WORKSPACE_TASK_CAPACITY' })
  assert.equal(store.overview('p-test').tasks.length, 2)
  store.cancelTask('p-test', queued.id)
  const replacement = store.startPackages('p-test', { ...firstInput, requestId: 'capacity-after-cancel' })
  store.cancelTask('p-test', replacement.id)
  await store.whenIdle()
  const overview = store.overview('p-test')
  assert.equal(overview.tasks.find((entry) => entry.id === first.id).status, 'completed')
  assert.equal(overview.tasks.find((entry) => entry.id === queued.id).status, 'interrupted')
  assert.equal(overview.releases.length, 1)
  await store.close()
  assert.throws(() => store.startPackages('p-test', { ...firstInput, requestId: 'after-close' }), { code: 'WORKSPACE_STOPPING' })
})

test('工作区导入、脱敏和打包领取时重查真实项目权限，撤权不产生版本或发布包', async (t) => {
  let access
  const { store, version, dataDir } = await fixture(t, { authorizeTask: ({ actorId, projectId }) => access.requireWorkspaceActor(actorId, projectId) })
  const sessionDb = new DatabaseSync(':memory:'), bindingDb = new DatabaseSync(':memory:')
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  t.after(() => { sessionDb.close(); bindingDb.close() })
  const membership = { userId: 'manager', workspaceAccess: 'internal', role: 'project_admin', status: 'active', environmentIds: ['env-test'] }
  const catalog = { users: [{ id: 'manager', name: '项目管理者', role: 'member', status: 'active' }, { id: 'other-manager', name: '另一管理者', role: 'member', status: 'active' }], agents: [], projects: [{ id: 'p-test', name: '验证项目', memberships: [membership, { ...membership, userId: 'other-manager' }], memberIds: ['manager', 'other-manager'], environments: [{ id: 'env-test', name: '测试' }], documents: [], resources: [] }] }
  access = createAutoOpsAccess({ sessionDb, bindingDb, catalog, workspaceStore: store, deploymentEnabled: () => false })
  const before = store.overview('p-test')
  const tasks = [
    store.startPackages('p-test', { sourceVersionId: version.id, services: ['frontend'], requestId: 'revoked-packages' }, 'manager'),
    store.startExternal('p-test', { sourceVersionId: version.id, requestId: 'revoked-external' }, 'manager'),
    store.startImport('p-test', { repositoryUrl: 'https://github.com/example/repository', requestId: 'revoked-import' }, 'manager'),
  ]
  assert.throws(() => store.startPackages('p-test', { sourceVersionId: version.id, services: ['frontend'], requestId: 'revoked-packages' }, 'other-manager'), { code: 'WORKSPACE_REQUEST_CONFLICT' })
  membership.role = 'reader'
  await store.whenIdle()
  const after = store.overview('p-test')
  for (const task of tasks) {
    const persisted = after.tasks.find((entry) => entry.id === task.id)
    assert.equal(persisted.status, 'interrupted'); assert.match(persisted.error, /权限已失效/)
  }
  assert.deepEqual(after.internalVersions, before.internalVersions)
  assert.deepEqual(after.externalVersions, before.externalVersions)
  assert.deepEqual(after.releases, before.releases)
  assert.match(store.read('p-test', version.id, 'WORKSPACE.md').contents, /验证项目/)
  assert.throws(() => store.startPackages('p-test', { sourceVersionId: version.id, services: ['frontend'], requestId: 'unknown-actor' }, 'unknown'), { code: 'PROJECT_NOT_FOUND' })
  const unconfigured = createWorkspaceStore({ dataDir })
  assert.throws(() => unconfigured.startPackages('p-test', { sourceVersionId: version.id, services: ['frontend'], requestId: 'missing-port' }, 'manager'), { code: 'WORKSPACE_AUTHORIZATION_REQUIRED' })
  membership.role = 'project_admin'
  assert.throws(() => access.requireDeploymentActor('manager', 'p-test', 'env-test'), { code: 'DEPLOYMENT_DISABLED' })
  const independent = store.startPackages('p-test', { sourceVersionId: version.id, services: ['frontend'], requestId: 'package-with-deployment-disabled' }, 'manager')
  await store.whenIdle()
  assert.equal(store.overview('p-test').tasks.find((entry) => entry.id === independent.id).status, 'completed')
  assert.ok(store.packageFile('p-test', store.overview('p-test').releases[0].id, 'frontend').bytes.length > 0)
})

test('任务与失败状态双重写入异常被收敛，其他项目仍可读取并完成打包', async (t) => {
  const diagnostics = []
  const { store, version, dataDir } = await fixture(t, { onTaskDiagnostic: (event) => { diagnostics.push(event); throw new Error('诊断接收端也失败') } })
  await store.ensureProject({ id: 'p-healthy', name: '独立项目', documents: [] })
  const statePath = join(dataDir, 'project-workspaces', 'p-test', 'state.json')
  const task = store.startPackages('p-test', { sourceVersionId: version.id, services: ['frontend'], requestId: 'state-write-failure' })
  const original = readFileSync(statePath)
  writeFileSync(statePath, '{损坏状态')
  await store.whenIdle()
  assert.deepEqual(diagnostics, [{ event: 'workspace.task.persistence_failed', taskId: task.id, code: 'WORKSPACE_TASK_STATE_UNAVAILABLE' }])
  const healthy = store.overview('p-healthy').internalVersions[0]
  const next = store.startPackages('p-healthy', { sourceVersionId: healthy.id, services: ['frontend'], requestId: 'unaffected-project' })
  await store.whenIdle()
  assert.equal(store.overview('p-healthy').tasks.find((entry) => entry.id === next.id).status, 'completed')
  assert.match(store.read('p-healthy', healthy.id, 'WORKSPACE.md').contents, /独立项目/)
  writeFileSync(statePath, original)
  assert.equal(store.overview('p-test').tasks.find((entry) => entry.id === task.id).status, 'interrupted')
})

test('内部来源是真实持久化的独立 Git，固定提交与资料身份，重开store仍可读取', async (t) => {
  const { store, dataDir, version } = await fixture(t)
  assert.equal(version.isExample, true)
  assert.deepEqual(version.source.repositories.map((entry) => entry.path), ['frontend', 'backend'])
  for (const repository of version.source.repositories) assert.match(repository.commit, /^[a-f0-9]{40}$/)
  assert.match(version.source.contentHash, /^[a-f0-9]{64}$/)
  assert.ok(store.files('p-test', version.id).some((file) => file.path.startsWith('frontend/.git/objects/')))
  assert.match(store.read('p-test', version.id, 'docs/设计.md').contents, /固定项目资料/)
  const reopened = createWorkspaceStore({ dataDir })
  await reopened.ensureProject({ id: 'p-test', name: '不应覆盖', documents: [] })
  assert.equal(reopened.overview('p-test').internalVersions[0].id, version.id)
  assert.match(reopened.read('p-test', version.id, 'docs/设计.md').contents, /固定项目资料/)
})

test('脱敏移除全部Git并覆盖资料/源码，二进制确认前不可绑定或读取', async (t) => {
  const { store, version } = await fixture(t)
  const input = { sourceVersionId: version.id, rules: [{ find: 'INTERNAL-DEMO', replace: '公开项目' }], requestId: 'external-1' }
  const started = store.startExternal('p-test', input)
  assert.equal(started.status, 'queued')
  assert.equal(store.startExternal('p-test', input).id, started.id)
  assert.throws(() => store.startExternal('p-test', { ...input, rules: [], requestId: 'external-1' }), /请求标识/)
  const completed = await finish(store, started)
  assert.equal(completed.status, 'completed')
  const external = store.overview('p-test').externalVersions[0]
  assert.equal(external.status, 'pending_review')
  assert.equal(external.report.removedGitEntries, 2)
  assert.ok(external.report.replacements >= 4)
  assert.deepEqual(external.report.pendingFiles.map((entry) => entry.path), ['prototypes/示例图片.png'])
  assert.throws(() => store.getVersion('p-test', external.id), /尚未发布/)
  assert.throws(() => store.read('p-test', external.id, 'backend/.env.example'), /尚未发布/)
  assert.throws(() => store.files('p-test', external.id), /尚未发布/)
  assert.deepEqual(store.managementSearch('p-test', external.id, '示例图片', 20).entries, [{ path: 'prototypes/示例图片.png', kind: 'file' }])
  assert.ok(store.managementTree('p-test', external.id).entries.some((entry) => entry.path === 'frontend' && entry.kind === 'directory'))
  assert.doesNotMatch(store.managementRead('p-test', external.id, 'backend/.env.example').contents, /sk-example|example-password|192\.168\.99\.10/)
  assert.equal(store.versionFile('p-test', external.id, 'prototypes/示例图片.png').mime, 'image/png')
  assert.throws(() => store.confirmExternal('p-test', external.id, { confirmedPaths: [], excludedPaths: [] }), /遗漏/)
  const published = publish(store, external)
  assert.equal(published.status, 'published')
  assert.ok(!store.files('p-test', external.id).some((file) => file.path.split('/').includes('.git')))
  assert.ok(store.files('p-test', external.id).some((file) => file.path === 'frontend/.gitignore'))
  const contents = store.read('p-test', external.id, 'backend/.env.example').contents
  assert.match(contents, /\[已脱敏\]/)
  assert.doesNotMatch(contents, /sk-example|example-password|192\.168\.99\.10/)
  assert.match(store.read('p-test', external.id, 'docs/设计.md').contents, /公开项目/)
  assert.doesNotMatch(JSON.stringify(external), /sk-example|example-password|INTERNAL-DEMO|\/Users\//)
  assert.ok(store.readBytes('p-test', external.id, 'prototypes/示例图片.png').length > 1)
  assert.throws(() => store.read('p-test', external.id, 'prototypes/示例图片.png'), /二进制/)
})

test('排除未能可靠检查的图片后才发布，不修改内部原件', async (t) => {
  const { store, version } = await fixture(t)
  await finish(store, store.startExternal('p-test', { sourceVersionId: version.id, requestId: 'exclude' }))
  const external = store.overview('p-test').externalVersions[0]
  assert.throws(() => store.confirmExternal('p-test', external.id, { confirmedPaths: ['prototypes/示例图片.png'], excludedPaths: ['prototypes/示例图片.png'] }), /重复/)
  store.confirmExternal('p-test', external.id, { confirmedPaths: [], excludedPaths: ['prototypes/示例图片.png'] })
  assert.ok(!store.files('p-test', external.id).some((file) => file.path.endsWith('.png')))
  assert.deepEqual(store.managementSearch('p-test', external.id, '示例图片', 20).entries, [])
  assert.ok(store.readBytes('p-test', version.id, 'prototypes/示例图片.png').length)
  assert.deepEqual(store.getVersion('p-test', external.id).report.excludedFiles, ['prototypes/示例图片.png'])
})

test('实际ZIP保留独立服务构建上下文和固定原始值，校验与manifest来自内部', async (t) => {
  const { store, version, dataDir } = await fixture(t)
  const completed = await finish(store, store.startPackages('p-test', { sourceVersionId: version.id, services: ['frontend', 'backend'], requestId: 'packages' }))
  assert.equal(completed.status, 'completed')
  const release = store.overview('p-test').releases[0]
  assert.equal(release.services.length, 2)
  assert.equal(release.sourceVersionId, version.id)
  assert.equal(release.manifest.status, 'packaged')
  for (const service of ['frontend', 'backend']) {
    const packaged = store.packageFile('p-test', release.id, service)
    const entries = unzipSync(packaged.bytes)
    assert.ok(entries['package.json'])
    assert.ok(entries['package-lock.json'])
    assert.ok(!Object.keys(entries).some((path) => path.split('/').includes('.git')))
    if (service === 'backend') assert.match(Buffer.from(entries['.env.example']).toString(), /example-password-not-real/)
    const file = join(dataDir, `${service}.zip`), extracted = join(dataDir, `build-${service}`)
    writeFileSync(file, packaged.bytes)
    await extractZip(file, extracted)
    if (service === 'frontend') {
      execFileSync(process.execPath, ['build.mjs'], { cwd: extracted })
      assert.match(readFileSync(join(extracted, 'dist', 'index.html'), 'utf8'), /AutoOps 工作区示例/)
    } else execFileSync(process.execPath, ['--check', 'server.mjs'], { cwd: extracted })
  }
  assert.equal(JSON.parse(Buffer.from(store.packageFile('p-test', release.id, 'manifest').bytes).toString()).sourceVersionId, version.id)
  await finish(store, store.startExternal('p-test', { sourceVersionId: version.id, requestId: 'external-source' }))
  const external = publish(store, store.overview('p-test').externalVersions[0])
  assert.throws(() => store.startPackages('p-test', { sourceVersionId: external.id, services: ['frontend'], requestId: 'wrong-source' }), /内部原始/)
})

test('资源范围拒绝跨项目、目录穿越、绝对路径和符号链接逃逸', async (t) => {
  const { store, dataDir, version } = await fixture(t)
  for (const path of ['../../etc/passwd', '/etc/passwd', 'docs/../WORKSPACE.md', 'docs\\设计.md', 'docs//设计.md', 'file:thing']) {
    assert.throws(() => store.read('p-test', version.id, path), /有效相对路径/)
  }
  assert.throws(() => store.getVersion('p-other', version.id), /不存在/)
  const actual = join(dataDir, 'project-workspaces', 'p-test', 'versions', version.id, 'files', 'docs', '设计.md')
  if (process.platform === 'win32') {
    // Windows 的目录联接不依赖创建文件符号链接的系统权限，同样覆盖跨目录读取。
    const outside = join(dataDir, 'outside'), docs = join(actual, '..')
    mkdirSync(outside); writeFileSync(join(outside, '设计.md'), '工作区之外的内容')
    rmSync(docs, { recursive: true }); symlinkSync(outside, docs, 'junction')
  } else { unlinkSync(actual); symlinkSync('/etc/passwd', actual) }
  assert.throws(() => store.read('p-test', version.id, 'docs/设计.md'), /符号链接/)
  const failed = await finish(store, store.startExternal('p-test', { sourceVersionId: version.id, requestId: 'unsafe-source' }))
  assert.equal(failed.status, 'failed')
  assert.doesNotMatch(failed.error, /\/etc|\/tmp|\/Users/)
})

test('内部固定文件被改动时阻止导出，失败任务保留上个外部可用版本', async (t) => {
  const { store, dataDir, version } = await fixture(t)
  await finish(store, store.startExternal('p-test', { sourceVersionId: version.id, requestId: 'first' }))
  const published = publish(store, store.overview('p-test').externalVersions[0])
  const file = join(dataDir, 'project-workspaces', 'p-test', 'versions', version.id, 'files', 'docs', '设计.md')
  writeFileSync(file, '未经版本化的改变')
  assert.throws(() => store.read('p-test', version.id, 'docs/设计.md'), /校验失败/)
  const failed = await finish(store, store.startExternal('p-test', { sourceVersionId: version.id, requestId: 'second' }))
  assert.equal(failed.status, 'failed')
  assert.equal(store.overview('p-test').externalVersions.length, 1)
  assert.equal(store.getVersion('p-test', published.id).status, 'published')
  assert.match(store.read('p-test', published.id, 'docs/设计.md').contents, /固定项目资料/)
})

test('取消任务不发布半成品，重启识别PID复用且保留同实例及其他存活进程任务', async (t) => {
  const { store, dataDir, version } = await fixture(t)
  const task = store.startExternal('p-test', { sourceVersionId: version.id, requestId: 'cancel' })
  assert.equal(store.cancelTask('p-test', task.id).status, 'interrupted')
  assert.equal((await finish(store, task)).status, 'interrupted')
  assert.equal(store.overview('p-test').externalVersions.length, 0)
  // 跨进程 worker 创建 store 不得破坏当前存活进程拥有的任务。
  const stateFile = join(dataDir, 'project-workspaces', 'p-test', 'state.json')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  const ownerInstanceId = state.tasks.find((entry) => entry.id === task.id).ownerInstanceId
  assert.equal(typeof ownerInstanceId, 'string')
  const active = { type: 'external', status: 'running', ownerPid: process.pid, ownerInstanceId, message: '处理中', stage: 'checking', createdAt: new Date().toISOString() }
  state.tasks.push({ ...active, id: 'alive' }, { ...active, id: 'dead', ownerPid: 999999999 })
  state.tasks.push({ ...active, id: 'reused-pid', ownerInstanceId: '另一个进程实例' })
  state.tasks.push({ ...active, id: 'legacy-same-pid', ownerInstanceId: undefined })
  state.tasks.push({ ...active, id: 'other-process', ownerPid: process.ppid, ownerInstanceId: '另一个仍在运行的进程' })
  writeFileSync(stateFile, JSON.stringify(state))
  const reopened = createWorkspaceStore({ dataDir }), tasks = reopened.overview('p-test').tasks
  assert.equal(tasks.find((entry) => entry.id === 'alive').status, 'running')
  assert.equal(tasks.find((entry) => entry.id === 'dead').status, 'interrupted')
  assert.equal(tasks.find((entry) => entry.id === 'reused-pid').status, 'interrupted')
  assert.equal(tasks.find((entry) => entry.id === 'legacy-same-pid').status, 'interrupted')
  assert.equal(tasks.find((entry) => entry.id === 'other-process').status, 'running')
  assert.ok(!JSON.stringify(tasks).includes('ownerPid'))
  assert.ok(!JSON.stringify(tasks).includes('ownerInstanceId'))
  assert.equal(readdirSync(join(dataDir, 'project-workspaces', 'p-test', 'versions')).length, 1)
})

test('Git来源仅允许无凭据公开HTTPS托管，拒绝内网与选项注入且不会创建任务', async (t) => {
  const { store } = await fixture(t)
  for (const repositoryUrl of ['http://github.com/a/b', 'https://127.0.0.1/a/b', 'https://192.168.31.157/a/b', 'https://github.com.evil.invalid/a/b', 'https://user:pass@github.com/a/b', 'https://github.com:8443/a/b', 'https://github.com/a/b?token=secret', 'file:///tmp/repo']) {
    assert.throws(() => store.startImport('p-test', { repositoryUrl, branch: 'main', requestId: repositoryUrl }), /HTTPS|凭据|托管|仓库/)
  }
  assert.throws(() => store.startImport('p-test', { repositoryUrl: 'https://github.com/a/b', branch: '--upload-pack=evil', requestId: 'bad-branch' }), /分支名称/)
  assert.equal(store.overview('p-test').tasks.length, 0)
})
