import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const within = (root, target) => {
  const path = relative(root, target)
  return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path)
}

// 只使用发行文件及本次创建的临时数据，不读取配置中的业务数据目录。
export async function verifyT3WorkspaceRelease(releaseDirectory) {
  if (typeof releaseDirectory !== 'string' || !isAbsolute(releaseDirectory)) throw new Error('请提供发行目录的绝对路径')
  const root = await realpath(releaseDirectory)
  if (!(await stat(root)).isDirectory()) throw new Error('发行路径不是目录')
  if (!(await stat(join(root, 'node_modules'))).isDirectory()) throw new Error('发行目录缺少运行依赖')
  const adapters = join(root, 'agent-demo/t3-adapters')
  for (const file of ['workspaces.mjs', 'workspace-files.mjs', 'workspace-jobs.mjs', 'workspace-packages.mjs', 'workspace-package-worker.mjs', 'workspace-management.ts', 'credentials.ts', 'workspace-authoring/index.ts', 'workspace-current.ts', 'workspace-update-runtime.ts', 'workspace-updates/index.ts', 'workspace-updates/storage.ts', 'thread-inputs.ts', 'project-directory/index.ts', 'project-directory/schema.ts', 'assistants/index.ts', 'assistants/schema.ts', 'assistants/policy.ts']) {
    const path = await realpath(join(adapters, file))
    if (!within(root, path) || !(await stat(path)).isFile()) throw new Error(`发行工作区文件缺失或越界：${file}`)
  }
  const archiveFile = await realpath(join(root, 'agent/archive.mjs'))
  if (!within(root, archiveFile)) throw new Error('发行归档模块越过目录边界')
  const workerRequire = createRequire(pathToFileURL(join(adapters, 'workspace-package-worker.mjs')))
  const compression = await realpath(workerRequire.resolve('fflate'))
  if (!within(root, compression)) throw new Error('发行目录缺少独立的 fflate 依赖，不能借用上级目录依赖')

  const temporaryRoot = await realpath(tmpdir()), prefix = 'autoops-workspace-release-'
  const dataDir = await mkdtemp(join(temporaryRoot, prefix))
  const previousResources = process.env.AUTOOPS_BUSINESS_RESOURCES_DIR
  let store, management, authoring, credentials, projectDirectory, assistants, updates
  try {
    process.env.AUTOOPS_BUSINESS_RESOURCES_DIR = adapters
    const [{ createWorkspaceStore }, { inspectZip }] = await Promise.all([
      import(pathToFileURL(join(adapters, 'workspaces.mjs')).href), import(pathToFileURL(archiveFile).href),
    ])
    const schemaDependency = await realpath(workerRequire.resolve('effect/Schema'))
    if (!within(root, schemaDependency)) throw new Error('发行目录缺少独立的 Effect 合同依赖')
    const { createProjectDirectory } = await import(pathToFileURL(join(adapters, 'project-directory/index.ts')).href)
    const directoryOptions = { dataDir, seed: { users: [{ id: 'release-smoke-actor', name: '发行测试账号', role: 'member' }], projects: [], agents: [] }, authorize: (actor, project) => {
      assert.equal(actor, 'release-smoke-actor')
      assert.ok(project)
      return { userId: actor, role: 'project_admin', environmentIds: [] }
    } }
    projectDirectory = createProjectDirectory(directoryOptions)
    const createRequest = { requestId: randomUUID(), expectedRevision: 0, value: { name: '发行隔离项目', description: '' } }
    const created = projectDirectory.create('release-smoke-actor', createRequest)
    assert.deepEqual(created.environments, [])
    projectDirectory.close()
    projectDirectory = createProjectDirectory(directoryOptions)
    assert.equal(projectDirectory.create('release-smoke-actor', createRequest).id, created.id)
    const { createAssistantDirectory } = await import(pathToFileURL(join(adapters, 'assistants/index.ts')).href)
    const assistantOptions = { dataDir, membership: () => ({ userId: 'release-smoke-actor', role: 'project_admin', workspaceAccess: 'internal', environmentIds: [], status: 'active' }), manage: () => {}, validate: () => {}, validateTarget: () => {} }
    assistants = createAssistantDirectory(assistantOptions)
    const assistantRequest = { requestId: randomUUID(), expectedRevision: 0, value: { name: '发行助手', description: '', instructions: '', enabled: true, configuration: { agentId: 'a-project', executionBinding: { kind: 'platform' }, environmentId: null, workspaceType: 'internal', visibility: 'private', model: { instanceId: 'codex', model: 'release-model', reasoningEffort: null }, skillIds: [] } } }
    const assistant = assistants.save('release-smoke-actor', created.id, null, assistantRequest)
    assistants.close()
    assistants = createAssistantDirectory(assistantOptions)
    assert.equal(assistants.save('release-smoke-actor', created.id, null, assistantRequest).id, assistant.id)

    const projectId = 'p-release-smoke', actorId = 'release-smoke-actor', requestId = randomUUID()
    const diagnostics = []
    let authorizations = 0
    store = createWorkspaceStore({
      dataDir, taskLimits: { maxConcurrent: 1, maxQueued: 0 }, onTaskDiagnostic: (event) => diagnostics.push(event),
      // 这是隔离冒烟的限定授权桩，不装配或改变生产授权服务。
      authorizeTask(scope) {
        if (scope.actorId !== actorId || scope.projectId !== projectId || !['packages', 'snapshot', 'input', 'sync'].includes(scope.type))
          throw Object.assign(new Error('冒烟授权范围不符'), { status: 403 })
        authorizations++
      },
    })
    await store.ensureProject({ id: created.id, name: created.name, documents: [] })
    assert.deepEqual(store.overview(created.id).internalVersions, [], '新业务项目不应自动生成示例资料')
    assert.deepEqual(store.overview(created.id).releases, [], '新业务项目不应自动生成源码包')
    await store.ensureProject({ id: projectId, name: '发行工作区隔离验证', documents: [] }, { initialContent: 'example' })
    const source = store.overview(projectId).internalVersions[0]
    assert.equal(source?.status, 'published', '未生成内部固定版本')
    const input = { sourceVersionId: source.id, services: ['frontend'], requestId }
    const receipt = store.startPackages(projectId, input, actorId)
    assert.equal(receipt.requestId, requestId, '任务回执缺少原请求标识')
    assert.equal(receipt.type, 'packages')
    assert.equal(store.startPackages(projectId, input, actorId).id, receipt.id, '重复请求产生了不同任务')
    await store.whenIdle()
    const overview = store.overview(projectId), task = overview.tasks.find((entry) => entry.id === receipt.id)
    assert.equal(task?.status, 'completed', task?.error || '发行包后台打包没有完成')
    assert.ok(authorizations >= 2, '任务提交和领取未完成限定授权')
    assert.deepEqual(diagnostics, [], '工作区后台出现状态持久化故障')
    assert.equal(overview.releases.length, 1, '源码包发布次数不符')
    const release = overview.releases[0]
    assert.equal(task.releaseId, release.id)
    const archive = store.packageFile(projectId, release.id, 'frontend')
    const entries = inspectZip(Buffer.from(archive.bytes), { maxBytes: 8 * 1024 * 1024, maxFiles: 100, maxFileBytes: 1024 * 1024 })
    assert.ok(archive.bytes.length > 22 && entries.some((entry) => entry.name === 'package.json'), '源码 ZIP 为空或缺少构建入口')
    const manifest = JSON.parse(Buffer.from(store.packageFile(projectId, release.id, 'manifest').bytes).toString('utf8'))
    assert.equal(manifest.projectId, projectId)
    assert.equal(manifest.releaseId, release.id)
    assert.equal(manifest.sourceVersionId, source.id)
    assert.equal(manifest.source.contentHash, source.source.contentHash)
    assert.equal(manifest.status, 'packaged')
    assert.equal(manifest.services[0].service, 'frontend')
    assert.equal(manifest.services[0].size, archive.bytes.length)
    assert.equal(manifest.services[0].sha256, createHash('sha256').update(archive.bytes).digest('hex'))
    // 从发行目录真实加载并初始化新增模块，避免开发依赖或遗漏文件掩盖启动失败。
    const [{ createWorkspaceManagement }, { createWorkspaceAuthoring }, { createProjectCredentialService }, { createWorkspaceGit }] = await Promise.all([
      import(pathToFileURL(join(adapters, 'workspace-management.ts')).href),
      import(pathToFileURL(join(adapters, 'workspace-authoring/index.ts')).href),
      import(pathToFileURL(join(adapters, 'credentials.ts')).href),
      import(pathToFileURL(join(adapters, 'workspace-git.ts')).href),
    ])
    const authorize = (actor, project) => assert.ok(actor === actorId && project === projectId, '新增模块越过隔离范围')
    authoring = createWorkspaceAuthoring({ dataDir, authorize })
    credentials = createProjectCredentialService({ databasePath: join(dataDir, 'credentials.sqlite'), keyPath: join(dataDir, 'credentials.key'), initializeKeyIfNew: true, authorize })
    const access = { requireWorkspaceActor: authorize, requireWorkspaceReader: authorize, requireWorkspaceInputReader: authorize, requireCredentialActor: authorize, requireProjectActionForActor: authorize, workspaceVersionReferences: () => [] }
    management = createWorkspaceManagement({ access, store, authoring, credentials, git: createWorkspaceGit() })
    const { createManagedWorkspaceUpdates } = await import(pathToFileURL(join(adapters, 'workspace-update-runtime.ts')).href)
    updates = createManagedWorkspaceUpdates({ dataDir, access, store, service: management })
    const updateSettings = {requestId: randomUUID(), expectedRevision: 0, value: {enabled: false, intervalMinutes: 60, timezone: 'Asia/Shanghai', sourceIds: []}}
    const savedUpdate = updates.save(projectId, 'internal', updateSettings, actorId)
    assert.equal(savedUpdate.enabled, false, '发行冒烟不能擅自启用定期更新')
    assert.deepEqual(updates.save(projectId, 'internal', updateSettings, actorId), savedUpdate)
    await updates.start()
    const document = Buffer.from('# 发行验收\n\n这份资料应保持在原轮次输入中。')
    const uploaded = await authoring.upload(projectId, { requestId: randomUUID(), expectedRevision: 0, path: 'docs/发行验收.md', size: document.length, sha256: createHash('sha256').update(document).digest('hex'), conflict: 'replace' }, document, actorId)
    const firstRequest = { requestId: randomUUID(), workspaceType: 'internal' }
    const first = await management.captureAgentInput(projectId, firstRequest, actorId)
    assert.deepEqual(Buffer.from(management.readInputFile(projectId, first.id, 'docs/发行验收.md', actorId).bytes), document)
    const updated = '# 当前资料\n\n下一轮应自动读取本次更新。'
    authoring.saveText(projectId, { requestId: randomUUID(), expectedRevision: uploaded.revision, path: 'docs/发行验收.md', expectedContentRevision: uploaded.entry.revision, contents: updated }, actorId)
    const second = await management.captureAgentInput(projectId, { requestId: randomUUID(), workspaceType: 'internal' }, actorId)
    assert.equal((await management.readInputContent(projectId, second.id, 'docs/发行验收.md', actorId)).contents, updated)
    assert.deepEqual(Buffer.from(management.readInputFile(projectId, first.id, 'docs/发行验收.md', actorId).bytes), document)
    assert.equal((await management.captureAgentInput(projectId, firstRequest, actorId)).id, first.id)
    assert.equal(store.overview(projectId).internalVersions.length, overview.internalVersions.length, '每轮输入不应新增日常版本')
    return { verified: true, release: root, taskId: task.id, requestId, zipBytes: archive.bytes.length, zipFiles: entries.length, sourceVersionId: source.id, currentInput: second.id, previousInputPreserved: true, repeatedRequestPreserved: true, workspaceUpdateSettingsPreserved: true }
  } finally {
    try {
      const results = await Promise.allSettled([updates?.close()])
      results.push(...await Promise.allSettled([assistants?.close(), projectDirectory?.close(), store?.close(), management?.close(), !management && authoring?.close(), !management && credentials?.close()]))
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, '发行冒烟资源关闭失败')
    }
    finally {
      if (previousResources === undefined) delete process.env.AUTOOPS_BUSINESS_RESOURCES_DIR
      else process.env.AUTOOPS_BUSINESS_RESOURCES_DIR = previousResources
      // 递归清理前确认仍是本次创建的系统临时子目录，拒绝链接或越界路径。
      const details = await lstat(dataDir)
      if (dirname(resolve(dataDir)) !== temporaryRoot || !basename(dataDir).startsWith(prefix) || !details.isDirectory() || details.isSymbolicLink() || await realpath(dataDir) !== resolve(dataDir))
        throw new Error('冒烟临时目录边界改变，已停止自动清理')
      await rm(dataDir, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [release, ...extra] = process.argv.slice(2)
    if (!release || extra.length) throw new Error('用法：node scripts/verify-t3-workspace-release.mjs RELEASE_ABSOLUTE_DIRECTORY')
    console.log(JSON.stringify(await verifyT3WorkspaceRelease(release)))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
