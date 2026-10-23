import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../agent-demo/t3-adapters/access.mjs'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'
import { createWorkspaceAuthoring } from '../agent-demo/t3-adapters/workspace-authoring/index.ts'
import { createProjectCredentialService } from '../agent-demo/t3-adapters/credentials.ts'
import { createWorkspaceManagement } from '../agent-demo/t3-adapters/workspace-management.ts'
import { handleWorkspaceAuthoringRequest } from '../agent-demo/t3-adapters/workspace-authoring-http.ts'
import { createBusinessResourceCatalog } from '../agent-demo/t3-adapters/resources.mjs'
import { renderBusinessPdf } from '../agent-demo/t3-adapters/business-documents.mjs'

const projectId = 'p-test'
const owner = 'manager'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const request = (revision) => ({ requestId: randomUUID(), expectedRevision: revision })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'autoops-workspace-management-'))
  const sessionDb = new DatabaseSync(':memory:'),
    bindingDb = new DatabaseSync(':memory:')
  sessionDb.exec(
    'CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)',
  )
  initializeAutoOpsAccessSchema(bindingDb)
  const memberships = [owner, 'second', 'reader', 'external'].map((userId) => ({
    userId,
    workspaceAccess: userId === 'external' ? 'external' : 'internal',
    role: ['manager', 'second'].includes(userId) ? 'manager' : 'member',
    status: 'active',
    environmentIds: ['env-test'],
  }))
  const catalog = {
    users: memberships.map(({ userId }) => ({
      id: userId,
      name: userId,
      role: 'member',
      status: 'active',
    })),
    agents: [{ id: 'a-project', projectIds: [projectId] }],
    projects: [
      {
        id: projectId,
        name: '隔离工作区',
        memberships,
        memberIds: memberships.map((entry) => entry.userId),
        environments: [{ id: 'env-test', name: '测试' }],
        documents: [],
        resources: [],
      },
    ],
  }
  for (const { userId } of memberships)
    sessionDb
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(`session-${userId}`, userId, `csrf-${userId}`, Date.now() + 60_000)
  let access
  const store = createWorkspaceStore({
    dataDir,
    taskLimits: { maxConcurrent: 1, maxQueued: 8 },
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
  await store.ensureProject(catalog.projects[0])
  const authoring = createWorkspaceAuthoring({
    dataDir,
    authorize: (actor, project, action) =>
      action === 'read'
        ? access.requireWorkspaceReader(actor, project)
        : action === 'external-read'
          ? access.requireWorkspaceInputReader(actor, project, 'external')
          : access.requireWorkspaceActor(actor, project),
  })
  const credentials = createProjectCredentialService({
    databasePath: join(dataDir, 'credentials.sqlite'),
    keyPath: join(dataDir, 'master.key'),
    initializeKeyIfNew: true,
    authorize: (actor, project, action) => {
      access.requireCredentialActor(actor, project, action)
    },
  })
  const repositories = new Map(),
    calls = { resolve: [], fetch: [] }
  const control = {
    lfsPointer: false,
    failResolve: false,
    beforeResolve: undefined,
    beforeFetch: undefined,
    revision: 0,
  }
  async function repository(role) {
    if (repositories.has(role)) return repositories.get(role)
    const directory = join(dataDir, 'git-fixtures', role)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: `fixture-${role}`,
        private: true,
        scripts: { build: 'node build.mjs' },
      }),
    )
    await writeFile(
      join(directory, 'package-lock.json'),
      JSON.stringify({ name: `fixture-${role}`, lockfileVersion: 3, packages: {} }),
    )
    await writeFile(
      join(directory, 'build.mjs'),
      `import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('dist', { recursive: true }); writeFileSync('dist/result.txt', '${role}');`,
    )
    await writeFile(join(directory, 'README.md'), `# ${role} 固定源码\n`)
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', directory])
    execFileSync('git', ['-C', directory, 'add', '.'])
    execFileSync('git', [
      '-C',
      directory,
      '-c',
      'user.name=隔离验收',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      '初始化隔离源码',
    ])
    const commit = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const value = { directory, commit }
    repositories.set(role, value)
    return value
  }
  // 只替换远端传输端口；授权、捕获、SQLite、原件、工作区任务及打包 Worker 均使用真实实现。
  const git = {
    validateRepositorySource(source) {
      return source
    },
    async resolveRepositoryRef(source, credential, signal) {
      signal.throwIfAborted()
      calls.resolve.push({ sourceId: source.id, credential: credential?.password })
      if (control.beforeResolve) await control.beforeResolve(source)
      if (control.failResolve)
        throw Object.assign(new Error('隔离来源暂不可用'), {
          status: 502,
          code: 'WORKSPACE_GIT_FAILED',
        })
      const { commit } = await repository(source.role)
      return {
        sourceId: source.id,
        commit,
        refKind: source.refKind,
        ref: source.ref || 'main',
        defaultRef: source.refKind === 'default' ? 'main' : null,
      }
    },
    async fetchRepositoryAt(source, commit, target, credential, signal, checkBudget) {
      signal.throwIfAborted()
      calls.fetch.push({ sourceId: source.id, commit, credential: credential?.password })
      if (control.beforeFetch) await control.beforeFetch(source)
      signal.throwIfAborted()
      const repo = await repository(source.role)
      assert.equal(commit, repo.commit)
      await cp(repo.directory, target, { recursive: true, force: false, errorOnExist: true })
      if (control.lfsPointer)
        await writeFile(
          join(target, 'required-asset.bin'),
          'version https://git-lfs.github.com/spec/v1\noid sha256:' +
            'a'.repeat(64) +
            '\nsize 100\n',
        )
      checkBudget()
    },
  }
  const service = createWorkspaceManagement({ access, store, authoring, credentials, git })
  t.after(async () => {
    await service.close()
    await store.close()
    sessionDb.close()
    bindingDb.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const http = (
    action,
    { method = 'GET', input, bytes, actor = owner, query = {}, project = projectId } = {},
  ) => {
    const url = new URL(`http://workspace.invalid/api/v1/projects/${project}/workspace/${action}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    return handleWorkspaceAuthoringRequest({
      access,
      principal: { id: actor, sessionHash: `session-${actor}` },
      url,
      method,
      input,
      bytes,
      service,
      store,
    })
  }
  const mutation = () => request(authoring.overview(projectId, owner).revision)
  const upload = async (path, contents) => {
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
    const input = {
      ...mutation(),
      path,
      size: bytes.length,
      sha256: sha(bytes),
      conflict: 'replace',
    }
    const { body } = await http('uploads', { method: 'POST', input, bytes })
    return { input, bytes, result: body }
  }
  const source = async (role, credentialId) => {
    const input = {
      ...mutation(),
      name: `${role} 仓库`,
      role,
      url: `https://github.com/fixtures/${role}.git`,
      refKind: 'default',
      ref: '',
      mountPath: role === 'frontend' ? 'apps/web' : 'services/api',
      ...(credentialId ? { credentialId } : {}),
    }
    return (await http('sources', { method: 'POST', input: { action: 'save', input } })).body.source
  }
  const finish = async (task) => {
    await store.whenIdle()
    return store.overview(projectId).tasks.find((entry) => entry.id === task.id)
  }
  return {
    dataDir,
    access,
    store,
    service,
    authoring,
    credentials,
    memberships,
    calls,
    control,
    http,
    mutation,
    upload,
    source,
    finish,
    repository,
  }
}

test('当前文档立即可读，每轮只固定引用，原请求重放不联网且新轮复用相同源码缓存', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  await f.upload('docs/product.md', '第一轮正文')
  const first = await f.service.captureAgentInput(
    projectId,
    { requestId: 'run-one', workspaceType: 'internal' },
    'reader',
  )
  assert.equal(
    f.service.readInputFile(projectId, first.id, 'docs/product.md', 'reader').bytes.toString(),
    '第一轮正文',
  )
  assert.equal(f.calls.fetch.length, 1)
  assert.equal(
    f.store.overview(projectId).internalVersions.filter((value) => !value.isExample).length,
    0,
  )
  await f.upload('docs/product.md', '第二轮正文')
  assert.equal(
    f.service.currentFile(projectId, 'docs/product.md', owner).bytes.toString(),
    '第二轮正文',
  )
  assert.equal(
    f.service.readInputFile(projectId, first.id, 'docs/product.md', 'reader').bytes.toString(),
    '第一轮正文',
  )
  const repeated = await f.service.captureAgentInput(
    projectId,
    { requestId: 'run-one', workspaceType: 'internal' },
    'reader',
  )
  assert.equal(repeated.id, first.id)
  assert.equal(f.calls.resolve.length, 1)
  const second = await f.service.captureAgentInput(
    projectId,
    { requestId: 'run-two', workspaceType: 'internal' },
    'reader',
  )
  assert.equal(f.calls.resolve.length, 2)
  assert.equal(f.calls.fetch.length, 1)
  assert.equal(first.repositories[0].versionId, second.repositories[0].versionId)
  assert.equal(
    f.service.readInputFile(projectId, second.id, 'docs/product.md', 'reader').bytes.toString(),
    '第二轮正文',
  )
  assert.throws(
    () => f.service.cleanupVersions(projectId, [second.repositories[0].versionId], owner),
    (error) => error.code === 'WORKSPACE_VERSION_IN_USE',
  )
  f.memberships.find((value) => value.userId === 'reader').status = 'disabled'
  assert.throws(() => f.service.readInput(projectId, first.id, 'reader'))
})

test('显式同步有真实持久收据，失败不伪装成功且保留最近成功源码', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  const { body } = await f.http('sync', { method: 'POST', input: f.mutation() })
  const done = await f.finish(body.task)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(done.status, 'completed')
  assert.equal(f.service.overview(projectId, owner).sourceStatus[0].status, 'synced')
  assert.match(
    (await f.service.currentContent(projectId, 'apps/web/README.md', owner)).contents,
    /固定源码/,
  )
  f.control.failResolve = true
  const request = f.mutation()
  await assert.rejects(f.service.sync(projectId, request, owner))
  assert.equal(f.service.overview(projectId, owner).sourceStatus[0].status, 'failed')
  assert.match(
    f.service.currentFile(projectId, 'apps/web/README.md', owner).bytes.toString(),
    /固定源码/,
  )
  assert.equal(f.service.receipt(projectId, request.requestId, owner).capture.resolution, 'failed')
  assert.equal(f.authoring.captureByRequest(projectId, request.requestId, owner).status, 'released')
  assert.equal(f.store.taskForRequest(projectId, 'sync', request.requestId, owner), undefined)
  assert.equal(
    f.authoring
      .inputProtectionSummary(projectId, owner)
      .pendingCaptures.some((value) => value.requestId === request.requestId),
    false,
  )
  const calls = f.calls.resolve.length
  await assert.rejects(
    f.service.sync(projectId, request, owner),
    (error) => error.code === 'WORKSPACE_GIT_FAILED',
  )
  assert.equal(f.calls.resolve.length, calls)
  f.control.failResolve = false
  const restored = await f.service.sync(projectId, f.mutation(), owner)
  assert.equal((await f.finish(restored)).status, 'completed')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.service.overview(projectId, owner).sourceStatus[0].status, 'synced')
  assert.equal(
    f.authoring.captureByRequest(projectId, restored.requestId, owner).status,
    'released',
  )
  assert.equal(
    f.service.receipt(projectId, request.requestId, owner).capture.resolutionError.code,
    'WORKSPACE_GIT_FAILED',
  )
})

test('文件选择捕获只使用已同步源码和当前文档，不联网且相同内容键复用原输入', async (t) => {
  const f = await fixture(t)
  const front = await f.source('frontend')
  await f.source('backend')
  await f.service.captureAgentInput(
    projectId,
    { requestId: 'initial', workspaceType: 'internal' },
    owner,
  )
  await f.upload('docs/latest.md', '当前文档')
  const calls = f.calls.resolve.length
  const first = await f.service.captureAvailableInput(
    projectId,
    { workspaceType: 'internal' },
    'reader',
  )
  const second = await f.service.captureAvailableInput(
    projectId,
    { workspaceType: 'internal' },
    'reader',
  )
  assert.equal(first.id, second.id)
  assert.equal(f.calls.resolve.length, calls)
  assert.equal(
    f.service.readInputFile(projectId, first.id, 'docs/latest.md', 'reader').bytes.toString(),
    '当前文档',
  )
  f.authoring.removeSource(projectId, front.id, f.mutation(), owner)
  const after = await f.service.captureAvailableInput(
    projectId,
    { workspaceType: 'internal' },
    'reader',
  )
  assert.equal(
    f.service
      .inputFiles(projectId, after.id, 'reader')
      .some((file) => file.path.startsWith('apps/web/')),
    false,
  )
  assert.throws(() => f.service.readInputFile(projectId, after.id, 'apps/web/README.md', 'reader'))
})

test('部署源码独立排队固定多仓，ZIP保留选定上下文且不夹上传文档', async (t) => {
  const f = await fixture(t)
  const front = await f.source('frontend'),
    back = await f.source('backend')
  await f.upload('docs/private.txt', '此资料绝不能进入部署包')
  const gate = deferred()
  f.control.beforeResolve = () => gate.promise
  const input = {
    requestId: 'deployment-multi',
    sources: [{ sourceId: front.id }, { sourceId: back.id }],
    contexts: [
      { service: 'frontend', root: '.', workingDirectory: 'apps/web' },
      { service: 'backend', root: 'services/api', workingDirectory: '.' },
    ],
  }
  const response = await f.http('deployment-packages', { method: 'POST', input })
  assert.equal(response.status, 202)
  assert.equal(response.body.task.type, 'packages')
  assert.equal(f.service.receipt(projectId, input.requestId, owner).task.id, response.body.task.id)
  assert.throws(
    () =>
      f.service.startDeploymentPackages(
        projectId,
        { ...input, contexts: [{ service: 'frontend', root: 'apps/web', workingDirectory: '.' }] },
        owner,
      ),
    (error) => error.code === 'WORKSPACE_REQUEST_CONFLICT',
  )
  gate.resolve()
  const task = await f.finish(response.body.task)
  assert.equal(task.status, 'completed', task.error)
  const release = f.store.overview(projectId).releases.find((value) => value.id === task.releaseId)
  const source = f.store.getVersion(projectId, release.sourceVersionId)
  assert.equal(source.cachePurpose, 'deployment')
  assert.deepEqual(source.source.documents, [])
  const names = Object.keys(unzipSync(f.store.packageFile(projectId, release.id, 'frontend').bytes))
  assert.ok(names.some((name) => name.endsWith('apps/web/package.json')))
  assert.ok(names.some((name) => name.endsWith('services/api/package.json')))
  assert.equal(
    names.some((name) => name.includes('docs/private.txt') || name.includes('/.git/')),
    false,
  )
  assert.equal(f.service.startDeploymentPackages(projectId, input, owner).id, task.id)
  assert.throws(
    () => f.service.cleanupVersions(projectId, [source.id], owner),
    (error) => error.code === 'WORKSPACE_VERSION_IN_USE',
  )
})

test('外部新输入只取最新已发布资料，旧输入保持固定且拒绝内部路径', async (t) => {
  const f = await fixture(t)
  await f.upload('docs/public.md', '对外正文第一版')
  const task = await f.service.generateCurrentExternal(
    projectId,
    { requestId: 'external-one' },
    owner,
  )
  assert.equal((await f.finish(task)).status, 'completed')
  await assert.rejects(
    f.service.generateCurrentExternal(
      projectId,
      { requestId: 'external-one', rules: [{ find: '不同参数', replace: 'changed' }] },
      owner,
    ),
    (error) => error.code === 'WORKSPACE_REQUEST_CONFLICT',
  )
  const first = await f.service.captureAgentInput(
    projectId,
    { requestId: 'external-run-one', workspaceType: 'external' },
    'external',
  )
  assert.equal(
    f.service.readInputFile(projectId, first.id, 'docs/public.md', 'external').bytes.toString(),
    '对外正文第一版',
  )
  await f.upload('docs/public.md', '对外正文第二版')
  await assert.rejects(
    f.service.captureAgentInput(
      projectId,
      { requestId: 'wrong-scope', workspaceType: 'internal' },
      'external',
    ),
  )
  const next = await f.service.generateCurrentExternal(
    projectId,
    { requestId: 'external-two' },
    owner,
  )
  assert.equal((await f.finish(next)).status, 'completed')
  const second = await f.service.captureAgentInput(
    projectId,
    { requestId: 'external-run-two', workspaceType: 'external' },
    'external',
  )
  assert.notEqual(first.externalVersionId, second.externalVersionId)
  assert.deepEqual(
    f.service.planCleanupVersions(projectId, [second.externalVersionId], owner).protected,
    [second.externalVersionId],
  )
  assert.equal(
    f.service.readInputFile(projectId, first.id, 'docs/public.md', 'external').bytes.toString(),
    '对外正文第一版',
  )
  assert.equal(
    f.service.readInputFile(projectId, second.id, 'docs/public.md', 'external').bytes.toString(),
    '对外正文第二版',
  )
})

test('Git暂不可用时固定上传资料与明确失败事实，不回退旧源码且原轮不重新联网', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  await f.upload('docs/product.md', '网络故障仍须可读的产品资料')
  await f.service.captureAgentInput(
    projectId,
    { requestId: 'network-initial', workspaceType: 'internal' },
    'reader',
  )
  f.control.failResolve = true
  const input = await f.service.captureAgentInput(
    projectId,
    { requestId: 'agent-run:network-failed', workspaceType: 'internal' },
    'reader',
  )
  assert.equal(input.repositories.length, 0)
  assert.equal(input.sourceErrors[0].code, 'WORKSPACE_GIT_FAILED')
  assert.equal(
    f.service.readInputFile(projectId, input.id, 'docs/product.md', 'reader').bytes.toString(),
    '网络故障仍须可读的产品资料',
  )
  assert.throws(
    () => f.service.readInputFile(projectId, input.id, 'apps/web/README.md', 'reader'),
    (error) => error.code === 'WORKSPACE_INPUT_SOURCE_UNAVAILABLE',
  )
  await assert.rejects(
    f.service.generateCurrentExternal(projectId, { requestId: 'external-unavailable' }, owner),
  )
  assert.equal(
    f.service.receipt(projectId, 'external-unavailable', owner).capture.resolution,
    'failed',
  )
  const calls = f.calls.resolve.length
  const repeated = await f.service.captureAgentInput(
    projectId,
    { requestId: 'agent-run:network-failed', workspaceType: 'internal' },
    'reader',
  )
  assert.deepEqual(repeated.sourceErrors, input.sourceErrors)
  assert.equal(f.calls.resolve.length, calls)
  f.control.failResolve = false
  const next = await f.service.captureAgentInput(
    projectId,
    { requestId: 'network-restored', workspaceType: 'internal' },
    'reader',
  )
  assert.equal(next.repositories.length, 1)
  assert.equal(next.sourceErrors, undefined)
  assert.equal(f.calls.fetch.length, 1)
})

test('抓取故障限定源码范围，但校验失败、撤权与取消不能降级伪装成可执行输入', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  await f.upload('docs/product.md', '当前正文')
  f.control.beforeFetch = () => {
    throw Object.assign(new Error('虚构网络故障'), { code: 'WORKSPACE_GIT_TIMEOUT', status: 504 })
  }
  const unavailable = await f.service.captureAgentInput(
    projectId,
    { requestId: 'fetch-unavailable', workspaceType: 'internal' },
    'reader',
  )
  assert.equal(unavailable.sourceErrors[0].code, 'WORKSPACE_GIT_TIMEOUT')
  assert.equal(
    f.service
      .readInputFile(projectId, unavailable.id, 'docs/product.md', 'reader')
      .bytes.toString(),
    '当前正文',
  )
  f.control.beforeFetch = () => {
    throw Object.assign(new Error('虚构完整性故障'), {
      code: 'WORKSPACE_GIT_COMMIT_MISMATCH',
      status: 502,
    })
  }
  await assert.rejects(
    f.service.captureAgentInput(
      projectId,
      { requestId: 'integrity-failed', workspaceType: 'internal' },
      'reader',
    ),
    (error) => error.code === 'WORKSPACE_GIT_COMMIT_MISMATCH',
  )
  f.control.beforeResolve = () => {
    f.memberships.find((value) => value.userId === 'reader').status = 'disabled'
  }
  await assert.rejects(
    f.service.captureAgentInput(
      projectId,
      { requestId: 'revoked-during-fetch', workspaceType: 'internal' },
      'reader',
    ),
  )
  f.memberships.find((value) => value.userId === 'reader').status = 'active'
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(
    f.service.captureAgentInput(
      projectId,
      { requestId: 'cancelled-input', workspaceType: 'internal' },
      'reader',
      abort.signal,
    ),
  )
})

test('清理预检保护旧会话与当前输入，显式释放后只删除无引用版本', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  const captured = await f.service.captureAgentInput(
    projectId,
    { requestId: 'protected-input', workspaceType: 'internal' },
    owner,
  )
  const versionId = captured.repositories[0].versionId
  const preflight = f.service.planCleanupVersions(projectId, [versionId], owner)
  assert.ok(preflight.reasons[versionId].some((value) => value.kind === 'input'))
  assert.ok(preflight.inputProtection.inputs.some((value) => value.inputId === captured.id))
  assert.deepEqual(f.service.planCleanupVersions(projectId, [versionId], owner).protected, [
    versionId,
  ])
  f.service.releaseInput(projectId, captured.id, owner)
  assert.deepEqual(f.service.planCleanupVersions(projectId, [versionId], owner).protected, [
    versionId,
  ])
  const legacy = f.store.overview(projectId).internalVersions[0]
  f.access.bindThread(
    { id: owner, sessionHash: `session-${owner}` },
    {
      threadId: randomUUID(),
      projectId,
      environmentId: 'env-test',
      agentId: 'a-project',
      visibility: 'private',
      workspaceType: 'internal',
      workspaceVersionId: legacy.id,
    },
  )
  assert.throws(
    () => f.service.cleanupVersions(projectId, [legacy.id], owner),
    (error) => error.code === 'WORKSPACE_VERSION_IN_USE',
  )
  await f.upload('docs/unused.md', '只在未关联的旧完整版本中')
  const task = await f.service.generate(projectId, f.mutation(), owner)
  const done = await f.finish(task)
  assert.deepEqual(f.service.planCleanupVersions(projectId, [done.versionId], owner).removable, [
    done.versionId,
  ])
  assert.deepEqual(f.service.cleanupVersions(projectId, [done.versionId], owner).removed, [
    done.versionId,
  ])
  assert.throws(() => f.store.getVersion(projectId, done.versionId))
  assert.equal(
    f.service.currentFile(projectId, 'docs/unused.md', owner).bytes.toString(),
    '只在未关联的旧完整版本中',
  )
})

test('跟踪分支新提交只影响下一轮，原轮和原请求继续读取原Git提交', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  const first = await f.service.captureAgentInput(
    projectId,
    { requestId: 'commit-one', workspaceType: 'internal' },
    'reader',
  )
  const repository = await f.repository('frontend')
  await writeFile(join(repository.directory, 'README.md'), '# 分支的新提交正文\n')
  execFileSync('git', ['-C', repository.directory, 'add', 'README.md'])
  execFileSync('git', [
    '-C',
    repository.directory,
    '-c',
    'user.name=隔离验收',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    '修改隔离源码',
  ])
  repository.commit = execFileSync('git', ['-C', repository.directory, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  const second = await f.service.captureAgentInput(
    projectId,
    { requestId: 'commit-two', workspaceType: 'internal' },
    'reader',
  )
  assert.notEqual(first.repositories[0].commit, second.repositories[0].commit)
  assert.equal(f.calls.fetch.length, 2)
  assert.match(
    f.service.readInputFile(projectId, first.id, 'apps/web/README.md', 'reader').bytes.toString(),
    /固定源码/,
  )
  assert.match(
    f.service.readInputFile(projectId, second.id, 'apps/web/README.md', 'reader').bytes.toString(),
    /新提交正文/,
  )
  assert.equal(
    (
      await f.service.captureAgentInput(
        projectId,
        { requestId: 'commit-one', workspaceType: 'internal' },
        'reader',
      )
    ).repositories[0].commit,
    first.repositories[0].commit,
  )
})

test('源码已写入而输入收据失败时任务保护仍有效，原请求恢复后显式释放才能清理', async (t) => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const save = f.authoring.saveInput
  f.authoring.saveInput = () => {
    throw Object.assign(new Error('隔离持久化故障'), { code: 'FIXTURE_STORAGE_FAILED' })
  }
  await assert.rejects(
    f.service.captureAgentInput(
      projectId,
      { requestId: 'unknown-input', workspaceType: 'internal' },
      owner,
    ),
    (error) => error.code === 'FIXTURE_STORAGE_FAILED',
  )
  const task = f.store.taskForRequest(projectId, 'input', 'unknown-input', owner)
  await f.http('sources', {
    method: 'POST',
    input: { action: 'remove', input: { ...f.mutation(), id: source.id } },
  })
  assert.deepEqual(f.service.planCleanupVersions(projectId, [task.versionId], owner).protected, [
    task.versionId,
  ])
  f.authoring.saveInput = save
  const recovered = await f.service.captureAgentInput(
    projectId,
    { requestId: 'unknown-input', workspaceType: 'internal' },
    owner,
  )
  assert.equal(recovered.repositories[0].versionId, task.versionId)
  assert.equal(f.calls.fetch.length, 1)
  f.service.releaseInput(projectId, recovered.id, owner)
  assert.deepEqual(f.service.planCleanupVersions(projectId, [task.versionId], owner).removable, [
    task.versionId,
  ])
  assert.deepEqual(f.service.cleanupVersions(projectId, [task.versionId], owner).removed, [
    task.versionId,
  ])
})

test('Git解析超时先持久失败再释放捕获，原请求保持超时错误且不重新联网', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  f.control.beforeResolve = () => {
    throw Object.assign(new Error('隔离Git超时'), { code: 'WORKSPACE_GIT_TIMEOUT', status: 504 })
  }
  const request = f.mutation()
  await assert.rejects(
    f.service.sync(projectId, request, owner),
    (error) => error.code === 'WORKSPACE_GIT_TIMEOUT',
  )
  const capture = f.authoring.captureByRequest(projectId, request.requestId, owner)
  assert.equal(capture.status, 'released')
  assert.equal(capture.resolution, 'failed')
  assert.equal(capture.resolutionError.code, 'WORKSPACE_GIT_TIMEOUT')
  assert.equal(f.store.taskForRequest(projectId, 'sync', request.requestId, owner), undefined)
  const calls = f.calls.resolve.length
  await assert.rejects(
    f.service.sync(projectId, request, owner),
    (error) => error.code === 'WORKSPACE_GIT_TIMEOUT' && error.status === 422,
  )
  assert.equal(f.calls.resolve.length, calls)
  assert.equal(
    f.service.receipt(projectId, request.requestId, owner).capture.resolutionError.code,
    'WORKSPACE_GIT_TIMEOUT',
  )
})

test('旧版遗留active失败捕获在原请求核对时经公开接口收尾，不覆盖原失败或创建任务', async (t) => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const request = f.mutation()
  const capture = f.authoring.capture(
    projectId,
    request.expectedRevision,
    owner,
    request.requestId,
    { sources: [source], documents: false },
  )
  f.authoring.failCaptureResolution(
    projectId,
    capture.id,
    { code: 'WORKSPACE_GIT_TIMEOUT', message: '隔离旧版超时' },
    owner,
  )
  assert.equal(f.authoring.captureByRequest(projectId, request.requestId, owner).status, 'active')
  await assert.rejects(
    f.service.sync(projectId, request, owner),
    (error) => error.code === 'WORKSPACE_GIT_TIMEOUT',
  )
  const original = f.authoring.captureByRequest(projectId, request.requestId, owner)
  assert.equal(original.id, capture.id)
  assert.equal(original.status, 'released')
  assert.equal(original.resolution, 'failed')
  assert.equal(f.calls.resolve.length, 0)
  assert.equal(f.calls.fetch.length, 0)
  assert.equal(f.store.taskForRequest(projectId, 'sync', request.requestId, owner), undefined)
  assert.equal(f.authoring.inputProtectionSummary(projectId, owner).pendingCaptures.length, 0)
})
