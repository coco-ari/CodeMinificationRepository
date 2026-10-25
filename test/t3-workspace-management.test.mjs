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
    role: ['manager', 'second'].includes(userId) ? 'project_admin' : userId === 'external' ? 'external' : 'reader',
    status: 'active',
    environmentIds: userId === 'external' ? [] : ['env-test'],
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
    authorizeTask: ({ actorId, projectId }) => access.requireWorkspaceActor(actorId, projectId),
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
  }
}

test('多仓与产品运维资料固定为真实版本，显式服务上下文打包及二进制外发复核保持隔离', async (t) => {
  const f = await fixture(t)
  const credential = f.credentials.create(owner, projectId, {
    requestId: randomUUID(),
    name: '验收凭证',
    username: 'test-user',
    password: 'test-token-v1',
  })
  const frontend = await f.source('frontend', credential.id),
    backend = await f.source('backend')
  const markdown = await f.upload('docs/产品/需求.md', '# 产品资料第一版\n验收内容')
  const pdf = await renderBusinessPdf('# 运维手册\n\n发布前保留业务资料。')
  await f.upload('docs/运维/运行.pdf', pdf)
  assert.equal(
    f.service.overview(projectId, owner).sourceStatus.every((entry) => entry.status === 'unsynced'),
    true,
  )
  assert.equal(
    (await f.http('current/metadata', { query: { path: 'docs/运维/运行.pdf' } })).body.extraction
      .status,
    'ready',
  )
  const input = f.mutation()
  const submitted = await f.http('versions', { method: 'POST', input })
  assert.equal(submitted.status, 202)
  const completed = await f.finish(submitted.body.task)
  assert.equal(completed.status, 'completed', completed.error)
  const version = f.store.getVersion(projectId, completed.versionId)
  assert.equal(version.isExample, false)
  assert.equal(version.source.authoringRevision, input.expectedRevision)
  assert.deepEqual(
    version.source.repositories.map((entry) => entry.path).sort(),
    [frontend.mountPath, backend.mountPath].sort(),
  )
  assert.equal(
    version.source.documents.find((entry) => entry.path === markdown.input.path).sha256,
    sha(markdown.bytes),
  )
  f.service.receipt(projectId, input.requestId, owner)
  const captured = f.authoring.captureByRequest(projectId, input.requestId, owner)
  assert.equal(captured.status, 'released')
  assert.equal(
    captured.resolvedRepositories.find((entry) => entry.sourceId === frontend.id).credentialVersion
      .version,
    1,
  )
  assert.equal(
    f.calls.fetch.find((entry) => entry.sourceId === frontend.id).credential,
    'test-token-v1',
  )
  assert.equal((await f.http(`requests/${input.requestId}`)).body.task.id, completed.id)
  assert.equal((await f.http('versions', { method: 'POST', input })).body.task.id, completed.id)
  assert.equal(f.calls.resolve.length, 2)
  const threadId = randomUUID()
  f.access.bindThread(
    { id: owner, sessionHash: `session-${owner}` },
    {
      threadId,
      projectId,
      environmentId: 'env-test',
      agentId: 'a-project',
      visibility: 'private',
      workspaceType: 'internal',
      workspaceVersionId: version.id,
    },
  )
  const catalog = createBusinessResourceCatalog({ access: f.access, workspaceStore: f.store })
  const pdfPath = `autoops/${projectId}/workspaces/${version.id}/docs/运维/运行.pdf`
  const resource = await catalog.readForThread(threadId, pdfPath)
  assert.match(resource.content, /运维手册/)
  assert.equal(resource.source, 'workspace_snapshot')
  assert.equal(resource.workspaceVersionId, version.id)
  assert.equal(f.service.overview(projectId, owner).hasUnpublishedChanges, false)
  await f.upload('docs/运维/运行.pdf', await renderBusinessPdf('# 新运维正文不属于旧会话'))
  assert.match((await catalog.readForThread(threadId, pdfPath)).content, /发布前保留业务资料/)
  assert.doesNotMatch((await catalog.readForThread(threadId, pdfPath)).content, /新运维正文/)
  f.memberships.find((entry) => entry.userId === owner).role = 'external'
  f.memberships.find((entry) => entry.userId === owner).environmentIds = []
  await assert.rejects(catalog.readForThread(threadId, pdfPath))
  f.memberships.find((entry) => entry.userId === owner).role = 'project_admin'
  f.memberships.find((entry) => entry.userId === owner).environmentIds = ['env-test']
  assert.equal(f.service.overview(projectId, owner).hasUnpublishedChanges, true)
  assert.equal(
    f.service.overview(projectId, owner).sourceStatus.every((entry) => entry.status === 'synced'),
    true,
  )
  assert.match(
    f.service.currentFile(projectId, `${frontend.mountPath}/README.md`, owner).bytes.toString(),
    /frontend 固定源码/,
  )
  assert.equal(f.service.search(projectId, 'README', owner).entries.length, 2)
  assert.equal(
    f.service.tree(projectId, 'apps', owner).entries.some((entry) => entry.path === 'apps/web'),
    true,
  )
  await f.upload(markdown.input.path, '# 第二版尚未发布')
  assert.equal(
    f.store.read(projectId, version.id, markdown.input.path).contents,
    markdown.bytes.toString(),
  )
  assert.equal(f.service.overview(projectId, owner).hasUnpublishedChanges, true)
  assert.throws(
    () =>
      f.store.startPackages(
        projectId,
        { requestId: randomUUID(), sourceVersionId: version.id, services: ['frontend'] },
        owner,
      ),
    { code: 'WORKSPACE_BUILD_CONTEXT_REQUIRED' },
  )
  const contexts = [
    { service: 'frontend', root: 'apps/web', workingDirectory: '.' },
    { service: 'backend', root: 'services/api', workingDirectory: '.' },
  ]
  const packaged = await f.finish(
    f.store.startPackages(
      projectId,
      {
        requestId: randomUUID(),
        sourceVersionId: version.id,
        services: ['frontend', 'backend'],
        contexts,
      },
      owner,
    ),
  )
  assert.equal(packaged.status, 'completed', packaged.error)
  for (const role of ['frontend', 'backend']) {
    const archive = f.store.packageFile(projectId, packaged.releaseId, role)
    const entries = unzipSync(archive.bytes)
    assert.equal(
      JSON.parse(Buffer.from(entries['package.json']).toString()).name,
      `fixture-${role}`,
    )
    assert.equal(
      Object.keys(entries).some(
        (path) => path.split('/').includes('.git') || path.startsWith('docs/'),
      ),
      false,
    )
    const build = join(f.dataDir, 'package-build', role)
    await mkdir(build, { recursive: true })
    for (const [path, bytes] of Object.entries(entries)) {
      await mkdir(dirname(join(build, path)), { recursive: true })
      await writeFile(join(build, path), bytes)
    }
    execFileSync(process.execPath, ['build.mjs'], { cwd: build })
    assert.equal(await readFile(join(build, 'dist/result.txt'), 'utf8'), role)
  }
  const manifest = JSON.parse(
    Buffer.from(f.store.packageFile(projectId, packaged.releaseId, 'manifest').bytes).toString(),
  )
  assert.equal(manifest.sourceVersionId, version.id)
  assert.deepEqual(
    manifest.services.map((entry) => ({
      service: entry.context.service,
      root: entry.context.root,
      workingDirectory: entry.context.workingDirectory,
    })),
    contexts,
  )
  const external = await f.finish(
    f.store.startExternal(
      projectId,
      { sourceVersionId: version.id, requestId: randomUUID() },
      owner,
    ),
  )
  assert.equal(external.status, 'completed', external.error)
  const review = f.store
    .overview(projectId)
    .externalVersions.find((entry) => entry.id === external.versionId)
  assert.equal(review.status, 'pending_review')
  assert.equal(
    review.report.pendingFiles.some((entry) => entry.path === 'docs/运维/运行.pdf'),
    true,
  )
  assert.throws(() => f.store.getVersion(projectId, review.id))
  assert.equal(
    Buffer.compare(
      Buffer.from(f.store.versionFile(projectId, version.id, 'docs/运维/运行.pdf').bytes),
      pdf,
    ),
    0,
  )
  const changedSource = { ...frontend, ...f.mutation(), refKind: 'branch', ref: 'next' }
  await f.http('sources', { method: 'POST', input: { action: 'save', input: changedSource } })
  assert.equal(
    f.service
      .overview(projectId, owner)
      .sourceStatus.find((entry) => entry.sourceId === frontend.id).status,
    'unsynced',
  )
  assert.throws(() => f.service.currentFile(projectId, `${frontend.mountPath}/README.md`, owner), {
    code: 'WORKSPACE_SOURCE_UNSYNCED',
  })
  assert.match(
    f.store.read(projectId, version.id, `${frontend.mountPath}/README.md`).contents,
    /frontend 固定源码/,
  )
})

test('无仓库资料也可发布，任务版本重开仍读取固定原件和原请求', async (t) => {
  const f = await fixture(t)
  const document = await f.upload('docs/运行.txt', '只有资料的固定版本')
  const input = f.mutation(),
    task = await f.service.generate(projectId, input, owner)
  const completed = await f.finish(task)
  assert.equal(completed.status, 'completed', completed.error)
  assert.deepEqual(f.store.getVersion(projectId, completed.versionId).source.repositories, [])
  assert.equal(
    f.store.read(projectId, completed.versionId, document.input.path).contents,
    document.bytes.toString(),
  )
  assert.equal(f.calls.resolve.length, 0)
  const reopened = createWorkspaceStore({ dataDir: f.dataDir, authorizeTask: () => {} })
  t.after(() => reopened.close())
  assert.equal(reopened.taskForRequest(projectId, 'snapshot', input.requestId, owner).id, task.id)
  assert.equal(
    reopened.read(projectId, completed.versionId, document.input.path).contents,
    document.bytes.toString(),
  )
})

test('同请求跨人或修改参数拒绝，未知请求只读取且不会创建捕获或任务', async (t) => {
  const f = await fixture(t)
  await f.upload('docs/资料.md', '# 第一版')
  const input = f.mutation(),
    task = await f.service.generate(projectId, input, owner)
  await f.finish(task)
  await assert.rejects(f.service.generate(projectId, input, 'second'), {
    code: 'WORKSPACE_REQUEST_CONFLICT',
  })
  await assert.rejects(
    f.service.generate(
      projectId,
      { ...input, expectedRevision: input.expectedRevision + 1 },
      owner,
    ),
    { code: 'WORKSPACE_REQUEST_CONFLICT' },
  )
  await assert.rejects(f.http(`requests/${input.requestId}`, { actor: 'second' }), {
    code: 'WORKSPACE_REQUEST_CONFLICT',
  })
  const before = f.store.overview(projectId),
    unknown = randomUUID()
  assert.deepEqual((await f.http(`requests/${unknown}`)).body, { result: null })
  assert.equal(f.authoring.captureByRequest(projectId, unknown, owner), null)
  assert.deepEqual(f.store.overview(projectId), before)
})

test('排队快照领取时撤权会中断且不发布，恢复权限后新请求成功', async (t) => {
  const entered = deferred(),
    release = deferred()
  t.after(() => release.resolve())
  const f = await fixture(t)
  const blocker = f.store.startSnapshot(
    projectId,
    { requestId: randomUUID(), captureId: 'fixture-blocker', source: { repositories: [] } },
    async ({ root }) => {
      entered.resolve()
      await release.promise
      await writeFile(join(root, 'blocker.txt'), '独立活动任务')
    },
    'second',
  )
  await entered.promise
  await f.upload('docs/撤权.txt', '应保持原件')
  const input = f.mutation(),
    task = await f.service.generate(projectId, input, owner)
  assert.equal(task.status, 'queued')
  const captureId = f.authoring.captureByRequest(projectId, input.requestId, owner).id
  f.memberships.find((entry) => entry.userId === owner).role = 'reader'
  release.resolve()
  const completed = await f.finish(task)
  assert.equal(completed.status, 'interrupted')
  assert.match(completed.error, /权限已失效/)
  assert.equal(
    f.store.overview(projectId).tasks.find((entry) => entry.id === blocker.id).status,
    'completed',
  )
  assert.equal(
    f.store
      .overview(projectId)
      .internalVersions.some((entry) => entry.source.captureId === captureId),
    false,
  )
  f.memberships.find((entry) => entry.userId === owner).role = 'project_admin'
  assert.equal(f.service.receipt(projectId, input.requestId, owner).task.status, 'interrupted')
  assert.equal(f.authoring.captureByRequest(projectId, input.requestId, owner).status, 'released')
  const next = await f.finish(await f.service.generate(projectId, f.mutation(), owner))
  assert.equal(next.status, 'completed', next.error)
  assert.equal(f.store.read(projectId, next.versionId, 'docs/撤权.txt').contents, '应保持原件')
})

test('解析失败保留旧版本与失败收据，同请求不重新解析，恢复后新请求可成功', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  const first = await f.finish(await f.service.generate(projectId, f.mutation(), owner))
  assert.equal(first.status, 'completed', first.error)
  const before = f.store.overview(projectId).internalVersions,
    input = f.mutation()
  f.control.failResolve = true
  await assert.rejects(f.service.generate(projectId, input, owner), {
    code: 'WORKSPACE_GIT_FAILED',
  })
  const calls = f.calls.resolve.length,
    receipt = f.service.receipt(projectId, input.requestId, owner)
  assert.equal(receipt.capture.resolution, 'failed')
  assert.equal(receipt.capture.resolutionError.code, 'WORKSPACE_GIT_FAILED')
  assert.equal(receipt.task, undefined)
  assert.deepEqual(f.store.overview(projectId).internalVersions, before)
  f.control.failResolve = false
  await assert.rejects(f.service.generate(projectId, input, owner), {
    code: 'WORKSPACE_GIT_FAILED',
  })
  assert.equal(f.calls.resolve.length, calls)
  const recovered = await f.finish(await f.service.generate(projectId, f.mutation(), owner))
  assert.equal(recovered.status, 'completed', recovered.error)
  assert.match(
    f.store.read(projectId, first.versionId, 'apps/web/README.md').contents,
    /frontend 固定源码/,
  )
})

test('HTTP 实际权限裁决、原件修订下载和原上传请求核对不暴露越权内容', async (t) => {
  const f = await fixture(t),
    first = await f.upload('docs/下载.md', '# 旧正文')
  const downloaded = await f.http('current/file', {
    actor: 'reader',
    query: { path: first.input.path, revision: first.result.entry.revision },
  })
  assert.equal(Buffer.from(downloaded.file.bytes).toString(), '# 旧正文')
  assert.equal(downloaded.file.mime, 'text/markdown')
  assert.deepEqual((await f.http(`requests/${first.input.requestId}`)).body.result, first.result)
  await f.upload(first.input.path, '# 新正文')
  await assert.rejects(
    f.http('current/file', {
      query: { path: first.input.path, revision: first.result.entry.revision },
    }),
    { code: 'WORKSPACE_CONTENT_CONFLICT' },
  )
  await assert.rejects(
    f.http('uploads', { actor: 'reader', method: 'POST', input: first.input, bytes: first.bytes }),
    { code: 'WORKSPACE_MANAGEMENT_FORBIDDEN' },
  )
  await assert.rejects(
    f.http('current/file', { actor: 'external', query: { path: first.input.path } }),
    { code: 'WORKSPACE_FORBIDDEN' },
  )
  await assert.rejects(
    f.http('current/file', { project: 'p-other', query: { path: first.input.path } }),
    { code: 'PROJECT_NOT_FOUND' },
  )
  f.memberships.find((entry) => entry.userId === owner).status = 'revoked'
  await assert.rejects(f.http('current/file', { query: { path: first.input.path } }), {
    code: 'PROJECT_NOT_FOUND',
  })
  await assert.rejects(
    f.http('uploads', { method: 'POST', input: first.input, bytes: first.bytes }),
    { code: 'PROJECT_NOT_FOUND' },
  )
})

test('源码快照遇到未获取的LFS指针拒绝发布，原固定版本和请求失败状态保持准确', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  const before = f.store.overview(projectId).internalVersions
  f.control.lfsPointer = true
  const input = f.mutation(),
    task = await f.service.generate(projectId, input, owner)
  const failed = await f.finish(task)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /LFS/)
  assert.deepEqual(f.store.overview(projectId).internalVersions, before)
  assert.equal(f.service.receipt(projectId, input.requestId, owner).task.status, 'failed')
  f.control.lfsPointer = false
  const next = await f.finish(await f.service.generate(projectId, f.mutation(), owner))
  assert.equal(next.status, 'completed', next.error)
})
