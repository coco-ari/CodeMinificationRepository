import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
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
import { createCurrentWorkspace } from '../agent-demo/t3-adapters/workspace-current.ts'
import { handleWorkspaceAuthoringRequest } from '../agent-demo/t3-adapters/workspace-authoring-http.ts'
import { createBusinessResourceCatalog } from '../agent-demo/t3-adapters/resources.mjs'
import { createBusinessRunInputs } from '../agent-demo/t3-adapters/thread-inputs.ts'
import { validateRepositorySource as validateGitSource } from '../agent-demo/t3-adapters/workspace-git.ts'
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

async function fixture(t, initialization) {
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
    role: ['manager', 'second'].includes(userId)
      ? 'project_admin'
      : userId === 'external'
        ? 'external'
        : 'reader',
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
  await store.ensureProject(catalog.projects[0], initialization)
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
      return validateGitSource(source)
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
      const { commit } = await repository(
        source.url
          .split('/')
          .at(-1)
          .replace(/\.git$/, ''),
      )
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
      const repo = await repository(
        source.url
          .split('/')
          .at(-1)
          .replace(/\.git$/, ''),
      )
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
    const connection = authoring.saveRepository(
      projectId,
      null,
      {
        ...mutation(),
        value: {
          name: `${role} 仓库`,
          url: `https://github.com/fixtures/${role}.git`,
          ...(credentialId ? { credentialId } : {}),
        },
      },
      owner,
    ).repository
    const input = {
      ...mutation(),
      id: connection.id,
      role,
      refKind: 'default',
      ref: '',
      mountPath: role === 'frontend' ? 'apps/web' : 'services/api',
    }
    return (await http('sources', { method: 'POST', input: { action: 'save', input } })).body.source
  }
  const finish = async (task) => {
    await store.whenIdle()
    return store.overview(projectId).tasks.find((entry) => entry.id === task.id)
  }
  const syncCurrent = async (expected = 'completed') => {
    const task = await service.sync(projectId, mutation(), owner)
    const done = await finish(task)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(done.status, expected)
    return done
  }
  return {
    syncCurrent,
    git,
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

test('新项目的当前资料和固定输入保持可读空态，不调用 Git 或自动写入示例', async t => {
  const f = await fixture(t)
  const overview = await f.http('authoring')
  assert.deepEqual(overview.body.entries,[])
  assert.deepEqual(overview.body.sources,[])
  const tree = await f.http('current/tree')
  assert.deepEqual(tree.body.entries,[])
  const input = await f.service.captureAgentInput(projectId,{requestId:'empty-initial-input',workspaceType:'internal'},owner)
  assert.deepEqual(input.files,[])
  assert.deepEqual(input.repositories,[])
  assert.deepEqual(f.service.inputTree(projectId,input.id,'',owner).entries,[])
  assert.deepEqual(f.store.overview(projectId).internalVersions,[])
  assert.deepEqual(f.calls.resolve,[])
  assert.deepEqual(f.calls.fetch,[])
})

test('显式同步后的连续新轮只读取已同步当前资料，不重新解析或抓取远端Git', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  const task = await f.service.sync(projectId, f.mutation(), owner)
  assert.equal((await f.finish(task)).status, 'completed')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.resolve.length, 1)
  assert.equal(f.calls.fetch.length, 1)
  const first = await f.service.captureAgentInput(projectId, {requestId: 'local-first', workspaceType: 'internal'}, 'reader')
  const second = await f.service.captureAgentInput(projectId, {requestId: 'local-second', workspaceType: 'internal'}, 'reader')
  assert.equal(f.calls.resolve.length, 1)
  assert.equal(f.calls.fetch.length, 1)
  assert.equal(first.repositories[0].versionId, task.versionId ?? f.store.taskForRequest(projectId, 'sync', task.requestId, owner).versionId)
  assert.equal(second.repositories[0].versionId, first.repositories[0].versionId)
  assert.match(f.service.readInputFile(projectId, second.id, 'apps/web/README.md', 'reader').bytes.toString(), /固定源码/u)
})

test('待更新分支及同步失败保留真实旧当前来源，成功后才切换，移除来源才停止新轮读取', async t => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const synced = await f.service.sync(projectId, f.mutation(), owner)
  await f.finish(synced)
  await new Promise(resolve => setImmediate(resolve))
  const original = await f.service.captureAgentInput(projectId, {requestId: 'before-branch-change', workspaceType: 'internal'}, 'reader')
  f.authoring.configureSource(projectId, {...f.mutation(), id: source.id, role: source.role, refKind: 'branch', ref: 'next', mountPath: 'new-mount'}, owner)
  assert.match(f.service.currentFile(projectId, 'apps/web/README.md', 'reader').bytes.toString(), /固定源码/u)
  f.control.failResolve = true
  await assert.rejects(f.service.sync(projectId, f.mutation(), owner))
  const retained = await f.service.captureAgentInput(projectId, {requestId: 'after-branch-failure', workspaceType: 'internal'}, 'reader')
  assert.deepEqual(retained.repositories, original.repositories)
  assert.equal(retained.sourceWarnings[0].code, 'WORKSPACE_SOURCE_CONFIGURATION_PENDING')
  assert.equal(f.service.overview(projectId, owner).sourceStatus[0].currentSource.mountPath, 'apps/web')
  assert.match(f.service.currentFile(projectId, 'apps/web/README.md', 'reader').bytes.toString(), /固定源码/u)
  f.control.failResolve = false
  const updated = await f.service.sync(projectId, f.mutation(), owner)
  await f.finish(updated)
  await new Promise(resolve => setImmediate(resolve))
  const next = await f.service.captureAgentInput(projectId, {requestId: 'after-branch-success', workspaceType: 'internal'}, 'reader')
  assert.equal(next.repositories[0].source.ref, 'next')
  assert.equal(next.repositories[0].source.mountPath, 'new-mount')
  assert.equal(next.sourceWarnings, undefined)
  assert.throws(() => f.service.currentFile(projectId, 'apps/web/README.md', owner))
  f.authoring.removeSource(projectId, source.id, f.mutation(), owner)
  const removed = await f.service.captureAgentInput(projectId, {requestId: 'after-source-removal', workspaceType: 'internal'}, 'reader')
  assert.deepEqual(removed.repositories, [])
  assert.match(f.service.readInputFile(projectId, original.id, 'apps/web/README.md', 'reader').bytes.toString(), /固定源码/u)
  f.authoring.configureSource(projectId, {...f.mutation(), id: source.id, role: source.role, refKind: source.refKind, ref: source.ref, mountPath: source.mountPath}, owner)
  const readded = await f.service.captureAgentInput(projectId, {requestId: 'explicitly-readded-source', workspaceType: 'internal'}, 'reader')
  assert.deepEqual(readded.repositories, [])
  assert.equal(readded.sourceErrors[0].code, 'WORKSPACE_SOURCE_UNSYNCED')
})

async function advanceRepository(f, role, content) {
  const repository = await f.repository(role)
  await writeFile(join(repository.directory, 'README.md'), content)
  execFileSync('git', ['-C', repository.directory, 'add', 'README.md'])
  execFileSync('git', ['-C', repository.directory, '-c', 'user.name=隔离验收', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', '更新隔离当前资料'])
  repository.commit = execFileSync('git', ['-C', repository.directory, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()
  return repository.commit
}

test('输入交接失败后新同步不能漂移原请求，跨实例恢复旧源码和文档且不重新联网', async t => {
  const f = await fixture(t)
  await f.source('frontend')
  const initial = await f.syncCurrent()
  await f.upload('docs/original.md', '原输入文档')
  const save = f.authoring.saveInput
  f.authoring.saveInput = () => { throw Object.assign(new Error('隔离交接故障'), {code: 'FIXTURE_INPUT_HANDOFF_FAILED'}) }
  const input = {requestId: 'fixed-before-handoff', workspaceType: 'internal'}
  await assert.rejects(f.service.captureAgentInput(projectId, input, 'reader'), {code: 'FIXTURE_INPUT_HANDOFF_FAILED'})
  const prepared = f.authoring.preparedInputByRequest(projectId, input.requestId, 'reader', 'internal')
  assert.equal(prepared.repositories[0].versionId, initial.versionId)
  assert.ok(f.authoring.inputProtectionSummary(projectId, owner).inputs.some(value => value.inputId === prepared.id && value.kind === 'preparing-input'))
  f.authoring.saveInput = save
  await advanceRepository(f, 'frontend', '后来同步的源码')
  await f.upload('docs/original.md', '后来更新的文档')
  const latest = await f.syncCurrent()
  assert.notEqual(latest.versionId, initial.versionId)
  assert.ok(f.service.planCleanupVersions(projectId, [initial.versionId], owner).protected.includes(initial.versionId))
  const reopened = createWorkspaceAuthoring({dataDir: f.dataDir, authorize(actor, project, action) {
    return action === 'read' ? f.access.requireWorkspaceReader(actor, project) : action === 'external-read' ? f.access.requireWorkspaceInputReader(actor, project, 'external') : f.access.requireWorkspaceActor(actor, project)
  }})
  const restored = createCurrentWorkspace({access: f.access, store: f.store, authoring: reopened, credentials: f.credentials, git: f.git})
  try {
    const retain = f.store.retainVersion
    f.store.retainVersion = (project, version, reference) => {
      if (version === initial.versionId) throw Object.assign(new Error('隔离原件不可用'), {code: 'WORKSPACE_NOT_FOUND'})
      return retain(project, version, reference)
    }
    await assert.rejects(restored.captureAgentInput(projectId, input, 'reader'), {code: 'WORKSPACE_NOT_FOUND'})
    f.store.retainVersion = retain
    const recovered = await restored.captureAgentInput(projectId, input, 'reader')
    assert.deepEqual(recovered, prepared)
    assert.match(restored.readInputFile(projectId, recovered.id, 'apps/web/README.md', 'reader').bytes.toString(), /固定源码/u)
    assert.equal(restored.readInputFile(projectId, recovered.id, 'docs/original.md', 'reader').bytes.toString(), '原输入文档')
    assert.equal(f.calls.resolve.length, 2)
    assert.equal(f.calls.fetch.length, 2)
    await assert.rejects(restored.captureAgentInput(projectId, input, 'second'), {code: 'WORKSPACE_REQUEST_CONFLICT'})
    await assert.rejects(restored.captureAgentInput(projectId, {...input, workspaceType: 'external'}, 'reader'), {code: 'WORKSPACE_REQUEST_CONFLICT'})
    await assert.rejects(restored.captureAgentInput('foreign-project', input, 'reader'))
    await assert.rejects(restored.captureAgentInput(projectId, {requestId: 'external-to-internal', workspaceType: 'internal'}, 'external'))
    f.memberships.find(member => member.userId === 'reader').status = 'disabled'
    assert.throws(() => restored.readInput(projectId, recovered.id, 'reader'))
  } finally {
    await restored.drain()
    await reopened.close()
  }
})

test('外部输入交接失败后发布新版本，原请求仍恢复原已发布资料并保持内外范围隔离', async t => {
  const f = await fixture(t)
  await f.upload('docs/public.md', '外部原正文')
  const first = await f.finish(await f.service.generateCurrentExternal(projectId, {requestId: 'external-before-handoff'}, owner))
  const save = f.authoring.saveInput
  f.authoring.saveInput = (value, actor) => {
    if (value.workspaceType === 'external') throw Object.assign(new Error('隔离外部交接故障'), {code: 'FIXTURE_EXTERNAL_HANDOFF_FAILED'})
    return save(value, actor)
  }
  const input = {requestId: 'external-fixed-retry', workspaceType: 'external'}
  await assert.rejects(f.service.captureAgentInput(projectId, input, 'external'), {code: 'FIXTURE_EXTERNAL_HANDOFF_FAILED'})
  const prepared = f.authoring.preparedInputByRequest(projectId, input.requestId, 'external', 'external')
  assert.equal(prepared.externalVersionId, first.versionId)
  await f.upload('docs/public.md', '外部后来正文')
  const second = await f.finish(await f.service.generateCurrentExternal(projectId, {requestId: 'external-after-handoff'}, owner))
  f.authoring.saveInput = save
  assert.notEqual(second.versionId, first.versionId)
  const recovered = await f.service.captureAgentInput(projectId, input, 'external')
  assert.deepEqual(recovered, prepared)
  assert.equal(f.service.readInputFile(projectId, recovered.id, 'docs/public.md', 'external').bytes.toString(), '外部原正文')
  const current = await f.service.captureAgentInput(projectId, {requestId: 'external-current-new', workspaceType: 'external'}, 'external')
  assert.equal(current.externalVersionId, second.versionId)
  assert.equal(f.service.readInputFile(projectId, current.id, 'docs/public.md', 'external').bytes.toString(), '外部后来正文')
  assert.equal(f.calls.resolve.length, 0)
  assert.equal(f.calls.fetch.length, 0)
})

test('同步候选物化期间新轮只读完整旧当前，全部仓库发布后一次切换且原轮保留原件', async t => {
  const f = await fixture(t)
  await f.source('frontend')
  await f.source('backend')
  const first = await f.syncCurrent()
  await advanceRepository(f, 'frontend', '前端新当前')
  await advanceRepository(f, 'backend', '后端新当前')
  const entered = deferred(), gate = deferred()
  f.control.beforeFetch = async () => {entered.resolve(); await gate.promise}
  const task = await f.service.sync(projectId, f.mutation(), owner)
  await entered.promise
  let old
  try {
    old = await f.service.captureAgentInput(projectId, {requestId: 'during-current-update', workspaceType: 'internal'}, 'reader')
    assert.equal(old.repositories.length, 2)
    assert.ok(old.repositories.every(value => value.versionId === first.versionId))
    assert.match(f.service.readInputFile(projectId, old.id, 'apps/web/README.md', 'reader').bytes.toString(), /固定源码/u)
    assert.match(f.service.readInputFile(projectId, old.id, 'services/api/README.md', 'reader').bytes.toString(), /固定源码/u)
  } finally {gate.resolve()}
  const updated = await f.finish(task)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(updated.status, 'completed')
  const current = await f.service.captureAgentInput(projectId, {requestId: 'after-current-update', workspaceType: 'internal'}, 'reader')
  assert.ok(current.repositories.every(value => value.versionId === updated.versionId))
  assert.equal(f.service.readInputFile(projectId, current.id, 'apps/web/README.md', 'reader').bytes.toString(), '前端新当前')
  assert.equal(f.service.readInputFile(projectId, current.id, 'services/api/README.md', 'reader').bytes.toString(), '后端新当前')
  assert.match(f.service.readInputFile(projectId, old.id, 'apps/web/README.md', 'reader').bytes.toString(), /固定源码/u)
})

test('多仓当前指针发布的SQLite中途故障整体保留旧当前，新请求才能重新更新', async t => {
  const f = await fixture(t)
  const sources = [await f.source('frontend'), await f.source('backend')]
  const first = await f.syncCurrent()
  await advanceRepository(f, 'frontend', '前端候选完整正文')
  await advanceRepository(f, 'backend', '后端候选完整正文')
  const last = sources.map(value => value.id).sort().at(-1)
  const db = new DatabaseSync(join(f.dataDir, 'workspace-authoring', 'state.sqlite'))
  try {
    db.exec(`CREATE TRIGGER fixture_publish_failure BEFORE UPDATE ON authoring_source_sync WHEN NEW.source_id='${last}' AND json_extract(NEW.value,'$.status')='synced' AND json_extract(NEW.value,'$.versionId')<>'${first.versionId}' BEGIN SELECT RAISE(ABORT,'隔离当前指针发布失败'); END`)
    const prepared = await f.syncCurrent()
    // Worker已发布完整候选，故障限定在所属模块切换current指针。
    assert.equal(f.store.versionFile(projectId, prepared.versionId, 'apps/web/README.md').bytes.toString(), '前端候选完整正文')
    assert.equal(f.store.versionFile(projectId, prepared.versionId, 'services/api/README.md').bytes.toString(), '后端候选完整正文')
    const records = f.authoring.syncRecords(projectId, owner)
    assert.ok(records.every(value => value.status === 'failed'))
    assert.ok(records.every(value => value.versionId === first.versionId))
    const retained = await f.service.captureAgentInput(projectId, {requestId: 'after-current-publish-failure', workspaceType: 'internal'}, 'reader')
    assert.ok(retained.repositories.every(value => value.versionId === first.versionId))
    db.exec('DROP TRIGGER fixture_publish_failure')
    const restored = await f.syncCurrent()
    const next = await f.service.captureAgentInput(projectId, {requestId: 'after-current-publish-retry', workspaceType: 'internal'}, 'reader')
    assert.ok(next.repositories.every(value => value.versionId === restored.versionId))
  } finally {db.close()}
})

test('旧同步领取后迟到不能覆盖已成功的新分支当前指针', async t => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  await f.syncCurrent()
  const entered = deferred(), gate = deferred()
  f.control.beforeResolve = async selected => {
    if (selected.refKind === 'default') {entered.resolve(); await gate.promise}
  }
  const earlier = f.service.sync(projectId, f.mutation(), owner)
  await entered.promise
  let newer
  try {
    f.authoring.configureSource(projectId, {...f.mutation(), id: source.id, role: source.role, refKind: 'branch', ref: 'newer-branch', mountPath: 'newer-mount'}, owner)
    newer = await f.syncCurrent()
    const during = await f.service.captureAgentInput(projectId, {requestId: 'while-earlier-sync-pending', workspaceType: 'internal'}, 'reader')
    assert.equal(during.repositories[0].versionId, newer.versionId)
    assert.equal(during.repositories[0].source.ref, 'newer-branch')
  } finally {gate.resolve()}
  assert.equal((await f.finish(await earlier)).status, 'completed')
  await new Promise(resolve => setImmediate(resolve))
  const current = await f.service.captureAgentInput(projectId, {requestId: 'after-earlier-sync-arrives', workspaceType: 'internal'}, 'reader')
  assert.equal(current.repositories[0].versionId, newer.versionId)
  assert.equal(current.repositories[0].source.ref, 'newer-branch')
  assert.equal(current.sourceWarnings, undefined)
  assert.equal(f.authoring.syncRecords(projectId, owner)[0].requestId, newer.requestId)
})

test('真实旧版已发布源码经元数据接管保持原有效内容，重开后问答零Git且不改选后来档案', async t => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const published = await f.finish(await f.service.generate(projectId, f.mutation(), owner))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(published.status, 'completed')
  await f.authoring.close()
  const db = new DatabaseSync(join(f.dataDir, 'workspace-authoring', 'state.sqlite'))
  db.exec('DELETE FROM authoring_source_sync; DROP TABLE authoring_input_preparations; DROP TABLE IF EXISTS authoring_current_adoptions; DELETE FROM schema_migrations WHERE version=4')
  db.close()
  const reopened = createWorkspaceAuthoring({dataDir: f.dataDir, authorize: (actor, project, action) => action === 'read' ? f.access.requireWorkspaceReader(actor, project) : f.access.requireWorkspaceActor(actor, project)})
  const restored = createCurrentWorkspace({access: f.access, store: f.store, authoring: reopened, credentials: f.credentials, git: f.git})
  try {
    const input = await restored.captureAgentInput(projectId, {requestId: 'adopted-original', workspaceType: 'internal'}, 'reader')
    assert.equal(input.repositories[0]?.versionId, published.versionId)
    assert.equal(input.repositories[0].source.id, source.id)
    assert.match(restored.readInputFile(projectId, input.id, 'apps/web/README.md', 'reader').bytes.toString(), /固定源码/u)
    assert.equal(f.calls.resolve.length, 1)
    assert.equal(f.calls.fetch.length, 1)
    const originalVersion = f.store.getVersion(projectId, published.versionId)
    const archive = f.store.startSnapshot(projectId, {requestId: 'later-archive-only', source: originalVersion.source}, async ({root}) => {
      await mkdir(join(root, 'apps/web'), {recursive: true})
      await writeFile(join(root, 'apps/web/README.md'), '后来独立留档，未发布为当前')
    }, owner)
    const later = await f.finish(archive)
    assert.notEqual(later.versionId, published.versionId)
    const next = await restored.captureAgentInput(projectId, {requestId: 'adopted-still-original', workspaceType: 'internal'}, 'reader')
    assert.equal(next.repositories[0].versionId, published.versionId)
    assert.ok(restored.planCleanupVersions(projectId, [published.versionId], owner).protected.includes(published.versionId))
  } finally {await restored.drain(); await reopened.close()}
})

test('旧状态接管忽略不匹配配置的同步行，固定升级前实际可读的匹配已发布版本', async t => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const old = await f.syncCurrent()
  f.authoring.configureSource(projectId, {...f.mutation(), id: source.id, role: source.role, refKind: 'branch', ref: 'published-next', mountPath: 'new-mount'}, owner)
  const published = await f.finish(await f.service.generate(projectId, f.mutation(), owner))
  await new Promise(resolve => setImmediate(resolve))
  const record = f.authoring.syncRecords(projectId, owner)[0]
  assert.equal(record.versionId, old.versionId)
  const {current, currentOrigin, ...legacyRecord} = record
  await f.authoring.close()
  const db = new DatabaseSync(join(f.dataDir, 'workspace-authoring', 'state.sqlite'))
  db.prepare('UPDATE authoring_source_sync SET value=? WHERE project_id=? AND source_id=?').run(JSON.stringify(legacyRecord), projectId, source.id)
  db.exec('DROP TABLE authoring_input_preparations; DROP TABLE authoring_current_adoptions; DELETE FROM schema_migrations WHERE version=4')
  db.close()
  const reopened = createWorkspaceAuthoring({dataDir: f.dataDir, authorize: (actor, project, action) => action === 'read' ? f.access.requireWorkspaceReader(actor, project) : f.access.requireWorkspaceActor(actor, project)})
  const restored = createCurrentWorkspace({access: f.access, store: f.store, authoring: reopened, credentials: f.credentials, git: f.git})
  try {
    const input = await restored.captureAgentInput(projectId, {requestId: 'adopt-effective-new-configuration', workspaceType: 'internal'}, 'reader')
    assert.equal(input.repositories[0]?.versionId, published.versionId)
    assert.equal(input.repositories[0].source.ref, 'published-next')
    assert.equal(input.repositories[0].source.mountPath, 'new-mount')
    assert.match(restored.readInputFile(projectId, input.id, 'new-mount/README.md', 'reader').bytes.toString(), /固定源码/u)
    assert.equal(f.calls.resolve.length, 2)
    assert.equal(f.calls.fetch.length, 2)
  } finally {await restored.drain(); await reopened.close()}
})

test('调度取消只停止尚未交接的同步或外发准备，已接受同步仍按真实收据完成', async t => {
  const f = await fixture(t)
  await f.source('frontend')
  const cancelled = new AbortController()
  cancelled.abort()
  const rejected = f.mutation()
  await assert.rejects(f.service.sync(projectId, rejected, owner, cancelled.signal))
  assert.equal(f.calls.resolve.length, 0)
  assert.equal(f.store.taskForRequest(projectId, 'sync', rejected.requestId, owner), undefined)
  const acceptedSignal = new AbortController()
  const gate = deferred(), fetching = deferred()
  f.control.beforeFetch = async () => {fetching.resolve(); await gate.promise}
  const accepted = await f.service.sync(projectId, f.mutation(), owner, acceptedSignal.signal)
  await fetching.promise
  acceptedSignal.abort()
  gate.resolve()
  assert.equal((await f.finish(accepted)).status, 'completed')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.authoring.syncRecords(projectId, owner)[0].status, 'synced')
  const externalRequest = {requestId: 'cancel-before-external-handoff'}
  await assert.rejects(f.service.generateCurrentExternal(projectId, externalRequest, owner, cancelled.signal))
  assert.equal(f.store.taskForRequest(projectId, 'external', externalRequest.requestId, owner), undefined)
  const external = await f.service.generateCurrentExternal(projectId, externalRequest, owner)
  assert.equal((await f.finish(external)).status, 'completed')
})

test('同步解析迟到后仍检查取消，外部准备取消保留已接受原快照供原请求恢复', async t => {
  const f = await fixture(t)
  await f.source('frontend')
  const signal = new AbortController(), resolving = deferred(), resolved = deferred()
  f.control.beforeResolve = async () => {resolving.resolve(); await resolved.promise}
  const input = f.mutation()
  const sync = f.service.sync(projectId, input, owner, signal.signal)
  await resolving.promise
  signal.abort()
  resolved.resolve()
  await assert.rejects(sync)
  assert.equal(f.store.taskForRequest(projectId, 'sync', input.requestId, owner), undefined)
  assert.equal(f.calls.fetch.length, 0)
  f.control.beforeResolve = undefined
  await f.syncCurrent()
  await f.upload('docs/public.md', '外部准备固定的正文')
  const externalSignal = new AbortController(), accepted = deferred(), finish = deferred()
  const start = f.store.startSnapshot
  f.store.startSnapshot = (...args) => {
    const materialize = args[2]
    args[2] = async context => {accepted.resolve(); await finish.promise; return materialize(context)}
    return start(...args)
  }
  const externalInput = {requestId: 'cancel-during-external-preparation'}
  const pending = f.service.generateCurrentExternal(projectId, externalInput, owner, externalSignal.signal)
  await accepted.promise
  externalSignal.abort()
  finish.resolve()
  try {await assert.rejects(pending)} finally {f.store.startSnapshot = start}
  const sourceRequest = `external-source-${sha(JSON.stringify(externalInput.requestId))}`
  const prepared = f.store.taskForRequest(projectId, 'snapshot', sourceRequest, owner)
  assert.equal(prepared.status, 'completed')
  assert.equal(f.store.taskForRequest(projectId, 'external', externalInput.requestId, owner), undefined)
  await f.upload('docs/public.md', '后来的正文')
  const recovered = await f.finish(await f.service.generateCurrentExternal(projectId, externalInput, owner))
  assert.equal(recovered.status, 'completed')
  assert.equal(f.store.getVersion(projectId, recovered.versionId).sourceVersionId, prepared.versionId)
  const external = await f.service.captureAgentInput(projectId, {requestId:'read-restored-external',workspaceType:'external'}, 'external')
  assert.equal(f.service.readInputFile(projectId, external.id, 'docs/public.md', 'external').bytes.toString(), '外部准备固定的正文')
})

test('待更新来源保留旧实际路径时拒绝发布重叠current，完整同步后才原子切换两仓', async t => {
  const f = await fixture(t)
  const frontend = await f.source('frontend')
  const original = await f.syncCurrent()
  f.authoring.configureSource(projectId, {...f.mutation(), id: frontend.id, role: frontend.role, refKind: 'branch', ref: 'moved', mountPath: 'new-mount'}, owner)
  const backend = await f.source('backend')
  f.authoring.configureSource(projectId, {...f.mutation(), id: backend.id, role: backend.role, refKind: 'default', ref: '', mountPath: 'apps/web'}, owner)
  const archive = await f.finish(await f.service.generate(projectId, f.mutation(), owner))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(archive.status, 'completed')
  assert.match(f.store.versionFile(projectId, archive.versionId, 'apps/web/README.md').bytes.toString(), /backend/u)
  assert.match(f.store.versionFile(projectId, archive.versionId, 'new-mount/README.md').bytes.toString(), /frontend/u)
  const blocked = f.authoring.syncRecords(projectId, owner).find(value => value.sourceId === backend.id)
  assert.equal(blocked.versionId, undefined)
  assert.equal(blocked.status, 'failed')
  assert.equal(blocked.error.code, 'WORKSPACE_CURRENT_SOURCE_CONFLICT')
  const retained = await f.service.captureAgentInput(projectId, {requestId: 'read-unambiguous-original', workspaceType:'internal'}, 'reader')
  assert.deepEqual(retained.repositories.map(value => value.versionId), [original.versionId])
  assert.equal(retained.repositories[0].source.mountPath, 'apps/web')
  assert.match(f.service.readInputFile(projectId, retained.id, 'apps/web/README.md', 'reader').bytes.toString(), /frontend/u)
  assert.ok(f.service.inputTree(projectId, retained.id, 'apps/web', 'reader').entries.some(value => value.name === 'README.md'))
  const binding = {projectId,environmentId:'env-test',agentId:'a-project',visibility:'project',workspaceType:'internal'}
  const principal = {id:owner,sessionHash:'session-manager'}
  f.access.bindThread(principal, {...binding,threadId:'current-source-reader'})
  f.access.bindThread(principal, {...binding,threadId:'other-source-reader'})
  f.access.bindRunInput('current-source-reader','current-source-run',retained.id,'reader')
  const catalog = createBusinessResourceCatalog({access:f.access,workspaceInputs:f.service,workspaceStore:f.store})
  const root = `autoops/${projectId}/inputs/${retained.id}/apps/web`
  assert.match((await catalog.readForThread('current-source-reader',`${root}/README.md`,retained.id)).content,/frontend/u)
  assert.equal((await catalog.readForThread('current-source-reader',root,retained.id)).kind,'directory')
  await assert.rejects(catalog.readForThread('current-source-reader',`${root}/missing.md`,retained.id),{code:'WORKSPACE_INPUT_SOURCE_UNAVAILABLE'})
  await assert.rejects(catalog.readForThread('other-source-reader',`${root}/README.md`,retained.id),{code:'THREAD_INPUT_FORBIDDEN'})
  const synced = await f.syncCurrent()
  const updated = await f.service.captureAgentInput(projectId, {requestId:'read-complete-new-mounts',workspaceType:'internal'}, 'reader')
  assert.ok(updated.repositories.every(value => value.versionId === synced.versionId))
  assert.equal(updated.repositories.find(value => value.sourceId === frontend.id).source.mountPath, 'new-mount')
  assert.equal(updated.repositories.find(value => value.sourceId === backend.id).source.mountPath, 'apps/web')
  assert.match(f.service.readInputFile(projectId, updated.id, 'apps/web/README.md', 'reader').bytes.toString(), /backend/u)
})

test('待更新挂载配置不开放旧实际Git目录写入，成功迁走后才可上传本地资料', async t => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  await f.syncCurrent()
  f.authoring.configureSource(projectId, {...f.mutation(), id:source.id, role:source.role, refKind:'branch',ref:'move-directory',mountPath:'new-mount'},owner)
  await assert.rejects(f.upload('apps/web/local.md', '不能覆盖仍生效的只读目录'), {code:'WORKSPACE_GIT_READ_ONLY'})
  assert.match(f.service.currentFile(projectId, 'apps/web/README.md', 'reader').bytes.toString(), /固定源码/u)
  await f.syncCurrent()
  await f.upload('apps/web/local.md', '来源已成功迁走，此路径现在是项目资料')
  assert.equal(f.service.currentFile(projectId, 'apps/web/local.md', 'reader').bytes.toString(), '来源已成功迁走，此路径现在是项目资料')
})

test('旧当前多仓接管中途SQLite失败全回滚，原件保护后可按同一事实重试接管', async t => {
  const f = await fixture(t)
  const sources = [await f.source('frontend'), await f.source('backend')]
  const published = await f.finish(await f.service.generate(projectId, f.mutation(), owner))
  await new Promise(resolve => setImmediate(resolve))
  await f.authoring.close()
  const db = new DatabaseSync(join(f.dataDir, 'workspace-authoring', 'state.sqlite'))
  db.exec('DELETE FROM authoring_source_sync; DROP TABLE authoring_input_preparations; DROP TABLE authoring_current_adoptions; DELETE FROM schema_migrations WHERE version=4')
  for (const source of sources) f.store.releaseVersion(projectId, `current:${source.id}`)
  const reopened = createWorkspaceAuthoring({dataDir: f.dataDir, authorize: (actor, project, action) => action === 'read' ? f.access.requireWorkspaceReader(actor, project) : f.access.requireWorkspaceActor(actor, project)})
  const last = reopened.currentAdoptionSources(projectId).at(-1).source.id
  db.exec(`CREATE TRIGGER fixture_adoption_failure BEFORE INSERT ON authoring_current_adoptions WHEN NEW.source_id='${last}' BEGIN SELECT RAISE(ABORT,'隔离接管失败'); END`)
  const restored = createCurrentWorkspace({access: f.access, store: f.store, authoring: reopened, credentials: f.credentials, git: f.git})
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM authoring_current_adoptions').get().n, 0)
    assert.deepEqual(reopened.syncRecords(projectId, owner), [])
    assert.ok(f.store.planCleanupVersions(projectId, [published.versionId], owner).protected.includes(published.versionId))
    await assert.rejects(restored.captureAgentInput(projectId, {requestId: 'adoption-failed-run', workspaceType: 'internal'}, 'reader'), /隔离接管失败/u)
    assert.match(f.store.versionFile(projectId, published.versionId, 'apps/web/README.md').bytes.toString(), /固定源码/u)
    db.exec('DROP TRIGGER fixture_adoption_failure')
    const recovered = await restored.captureAgentInput(projectId, {requestId: 'adoption-retried-run', workspaceType: 'internal'}, 'reader')
    assert.ok(recovered.repositories.every(value => value.versionId === published.versionId))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM authoring_current_adoptions').get().n, 2)
    assert.equal(f.calls.resolve.length, 2)
    assert.equal(f.calls.fetch.length, 2)
  } finally {db.close(); await restored.drain(); await reopened.close()}
})

test('两个独立进程并发接管真实旧状态，固定相同原版本且标记幂等不重复选择', async t => {
  const f = await fixture(t)
  await f.source('frontend')
  await f.source('backend')
  const published = await f.finish(await f.service.generate(projectId, f.mutation(), owner))
  await new Promise(resolve => setImmediate(resolve))
  await f.authoring.close()
  const db = new DatabaseSync(join(f.dataDir, 'workspace-authoring', 'state.sqlite'))
  db.exec('DELETE FROM authoring_source_sync; DROP TABLE authoring_input_preparations; DROP TABLE authoring_current_adoptions; DELETE FROM schema_migrations WHERE version=4')
  db.close()
  const script = `
    const {createWorkspaceAuthoring}=await import(${JSON.stringify(new URL('../agent-demo/t3-adapters/workspace-authoring/index.ts', import.meta.url).href)});
    const {createWorkspaceStore}=await import(${JSON.stringify(new URL('../agent-demo/t3-adapters/workspaces.mjs', import.meta.url).href)});
    const {createCurrentWorkspace}=await import(${JSON.stringify(new URL('../agent-demo/t3-adapters/workspace-current.ts', import.meta.url).href)});
    const dataDir=process.argv[1];
    const authoring=createWorkspaceAuthoring({dataDir,authorize(){return true}});
    const store=createWorkspaceStore({dataDir});
    const forbidden=()=>{throw new Error('元数据接管不能取密或访问Git')};
    const current=createCurrentWorkspace({access:{},store,authoring,credentials:{referenceVersion:forbidden,withCredential:forbidden},git:{resolveRepositoryRef:forbidden,fetchRepositoryAt:forbidden}});
    const records=authoring.syncRecords('p-test','fixture-metadata-reader');
    console.log(JSON.stringify(records.map(value=>[value.sourceId,value.versionId])));
    await current.drain();await authoring.close();await store.close();
  `
  const results = await Promise.all([1,2].map(() => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.dataDir], {timeout: 10000, maxBuffer: 65536})))
  for (const result of results) {
    const records = JSON.parse(result.stdout)
    assert.equal(records.length, 2)
    assert.ok(records.every(value => value[1] === published.versionId))
  }
  const verify = new DatabaseSync(join(f.dataDir, 'workspace-authoring', 'state.sqlite'))
  try {assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM authoring_current_adoptions').get().n, 2)} finally {verify.close()}
  assert.ok(f.store.planCleanupVersions(projectId, [published.versionId], owner).protected.includes(published.versionId))
  assert.equal(f.calls.resolve.length, 2)
  assert.equal(f.calls.fetch.length, 2)
})

test('当前文档立即可读，每轮只固定引用，原请求重放不联网且新轮复用相同源码缓存', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  await f.syncCurrent()
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
  assert.equal(f.calls.resolve.length, 1)
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
  assert.equal(
    f.service.overview(projectId, owner).sourceStatus[0].error.code,
    'WORKSPACE_GIT_FAILED',
  )
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

test('新对话的当前资料候选包含源码和上传文件，固定引用且撤权后不可读', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  await f.syncCurrent()
  await f.service.captureAgentInput(
    projectId,
    { requestId: 'picker-source', workspaceType: 'internal' },
    owner,
  )
  await f.upload('docs/product.md', '项目产品说明')
  const catalog = createBusinessResourceCatalog({
    access: f.access,
    workspaceStore: f.store,
    workspaceInputs: f.service,
  })
  const principal = { id: 'reader', sessionHash: 'session-reader' }
  const cwd = `autoops://projects/${projectId}/environments/env-test/threads/new-draft?workspaceType=internal`
  const networkCalls = f.calls.resolve.length
  const result = await catalog.search(principal, { cwd, query: './', limit: 80 })
  assert.deepEqual(
    result.entries.map((entry) => [entry.path.split('/').at(-1), entry.kind]),
    [
      ['apps', 'directory'],
      ['docs', 'directory'],
    ],
  )
  assert.deepEqual(await catalog.list(principal, { cwd }), result)
  const files = await catalog.search(principal, { cwd, query: './docs/', limit: 80 })
  assert.equal(files.entries.length, 1)
  assert.match(files.entries[0].path, /^autoops\/p-test\/inputs\/[^/]+\/docs\/product.md$/)
  const file = await catalog.read(principal, { cwd, relativePath: files.entries[0].path })
  assert.equal(file.contents, '项目产品说明')
  const sources = await catalog.search(principal, { cwd, query: './apps/web/README', limit: 80 })
  assert.match(
    (await catalog.read(principal, { cwd, relativePath: sources.entries[0].path })).contents,
    /frontend 固定源码/,
  )
  assert.equal(f.calls.resolve.length, networkCalls)
  assert.equal((await catalog.metadata(principal, [files.entries[0].path])).entries[0].kind, 'file')
  await f.upload('docs/product.md', '更新后的产品说明')
  assert.equal(
    (await catalog.read(principal, { cwd, relativePath: files.entries[0].path })).contents,
    '项目产品说明',
  )
  const updated = await catalog.search(principal, { cwd, query: './docs/', limit: 80 })
  assert.equal(
    (await catalog.read(principal, { cwd, relativePath: updated.entries[0].path })).contents,
    '更新后的产品说明',
  )
  assert.throws(
    () =>
      catalog.search(principal, {
        cwd: `${cwd}&workspaceVersionId=missing-version`,
        query: './',
        limit: 80,
      }),
    { code: 'WORKSPACE_NOT_FOUND' },
  )
  f.memberships.find((entry) => entry.userId === principal.id).role = 'external'
  f.memberships.find((entry) => entry.userId === principal.id).environmentIds = []
  assert.throws(() => catalog.search(principal, { cwd, query: './', limit: 80 }), {
    code: 'ENVIRONMENT_FORBIDDEN',
  })
  await assert.rejects(catalog.read(principal, { cwd, relativePath: files.entries[0].path }), {
    code: 'ENVIRONMENT_FORBIDDEN',
  })
})

test('新外部对话的文件候选读取已发布资料并拒绝内部范围', async (t) => {
  const f = await fixture(t)
  await f.upload('docs/public.md', '已发布正文')
  const task = await f.service.generateCurrentExternal(
    projectId,
    { requestId: 'picker-external' },
    owner,
  )
  assert.equal((await f.finish(task)).status, 'completed')
  await f.upload('docs/public.md', '尚未发布正文')
  const catalog = createBusinessResourceCatalog({
    access: f.access,
    workspaceStore: f.store,
    workspaceInputs: f.service,
  })
  const principal = { id: 'external', sessionHash: 'session-external' }
  const cwd = `autoops://projects/${projectId}/environments/~/threads/new-external-draft?workspaceType=external`
  const result = await catalog.search(principal, { cwd, query: './docs/', limit: 80 })
  assert.equal(result.entries.length, 1)
  assert.equal(
    (await catalog.read(principal, { cwd, relativePath: result.entries[0].path })).contents,
    '已发布正文',
  )
  assert.throws(
    () =>
      catalog.search(principal, {
        cwd: cwd.replace('workspaceType=external', 'workspaceType=internal'),
        query: './',
        limit: 80,
      }),
    { code: 'WORKSPACE_FORBIDDEN' },
  )
})

test('文件选择捕获只使用已同步源码和当前文档，不联网且相同内容键复用原输入', async (t) => {
  const f = await fixture(t)
  const front = await f.source('frontend')
  await f.source('backend')
  await f.syncCurrent()
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
    sources: [
      { sourceId: front.id, refKind: 'default', ref: '', mountPath: front.mountPath },
      { sourceId: back.id, refKind: 'default', ref: '', mountPath: back.mountPath },
    ],
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

test('Git暂不可用时保留工作区已同步源码与更新警告，原轮不重新联网且外部更新使用有效当前资料', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  await f.syncCurrent()
  await f.upload('docs/product.md', '网络故障仍须可读的产品资料')
  await f.service.captureAgentInput(
    projectId,
    { requestId: 'network-initial', workspaceType: 'internal' },
    'reader',
  )
  f.control.failResolve = true
  await assert.rejects(f.service.sync(projectId, f.mutation(), owner))
  const input = await f.service.captureAgentInput(
    projectId,
    { requestId: 'agent-run:network-failed', workspaceType: 'internal' },
    'reader',
  )
  assert.equal(input.repositories.length, 1)
  assert.equal(input.sourceErrors, undefined)
  assert.equal(input.sourceWarnings[0].code, 'WORKSPACE_GIT_FAILED')
  assert.equal(
    f.service.readInputFile(projectId, input.id, 'docs/product.md', 'reader').bytes.toString(),
    '网络故障仍须可读的产品资料',
  )
  assert.match(
    f.service.readInputFile(projectId, input.id, 'apps/web/README.md', 'reader').bytes.toString(),
    /frontend 固定源码/,
  )
  const external = await f.service.generateCurrentExternal(projectId, { requestId: 'external-unavailable' }, owner)
  assert.equal((await f.finish(external)).status, 'completed')
  assert.equal(
    f.service.receipt(projectId, 'external-unavailable', owner).capture.resolution,
    'resolved',
  )
  const calls = f.calls.resolve.length
  const repeated = await f.service.captureAgentInput(
    projectId,
    { requestId: 'agent-run:network-failed', workspaceType: 'internal' },
    'reader',
  )
  assert.deepEqual(repeated, input)
  assert.equal(f.calls.resolve.length, calls)
  f.control.failResolve = false
  await f.syncCurrent()
  const next = await f.service.captureAgentInput(
    projectId,
    { requestId: 'network-restored', workspaceType: 'internal' },
    'reader',
  )
  assert.equal(next.repositories.length, 1)
  assert.equal(next.sourceErrors, undefined)
  assert.equal(next.sourceWarnings, undefined)
  assert.equal(f.calls.fetch.length, 1)
})

test('抓取新提交失败保留旧源码及其真实提交，恢复后新轮更新而原轮保持不变', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  await f.syncCurrent()
  const capture = (requestId) =>
    f.service.captureAgentInput(projectId, { requestId, workspaceType: 'internal' }, 'reader')
  const first = await capture('first')
  const repo = await f.repository('frontend')
  await writeFile(join(repo.directory, 'README.md'), '更新后的源码正文')
  execFileSync('git', ['-C', repo.directory, 'add', 'README.md'])
  execFileSync('git', [
    '-C',
    repo.directory,
    '-c',
    'user.name=隔离验收',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    '更新隔离源码',
  ])
  repo.commit = execFileSync('git', ['-C', repo.directory, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  f.control.beforeFetch = () => {
    throw Object.assign(new Error('隔离抓取超时'), { code: 'WORKSPACE_GIT_TIMEOUT', status: 504 })
  }
  await f.syncCurrent('failed')
  const retained = await capture('failed-new-commit')
  assert.equal(retained.repositories[0].commit, first.repositories[0].commit)
  assert.equal(retained.repositories[0].versionId, first.repositories[0].versionId)
  assert.equal(retained.sourceWarnings[0].code, 'WORKSPACE_GIT_TIMEOUT')
  assert.match(
    f.service
      .readInputFile(projectId, retained.id, 'apps/web/README.md', 'reader')
      .bytes.toString(),
    /frontend 固定源码/,
  )
  const record = f.authoring.syncRecords(projectId, owner)[0]
  assert.equal(record.status, 'failed')
  assert.equal(record.commit, first.repositories[0].commit)
  assert.equal(record.versionId, first.repositories[0].versionId)
  f.control.beforeFetch = undefined
  await f.syncCurrent()
  const restored = await capture('restored')
  assert.equal(restored.sourceWarnings, undefined)
  assert.equal(restored.repositories[0].commit, repo.commit)
  assert.equal(
    f.service
      .readInputFile(projectId, restored.id, 'apps/web/README.md', 'reader')
      .bytes.toString(),
    '更新后的源码正文',
  )
  assert.match(
    f.service
      .readInputFile(projectId, retained.id, 'apps/web/README.md', 'reader')
      .bytes.toString(),
    /frontend 固定源码/,
  )
})

test('新仓库明确未同步，同一来源的待更新配置保留真实当前版本', async (t) => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  await f.syncCurrent()
  const capture = (requestId) =>
    f.service.captureAgentInput(projectId, { requestId, workspaceType: 'internal' }, 'reader')
  await capture('initial')
  const other = await f.source('backend')
  f.control.failResolve = true
  await assert.rejects(f.service.sync(projectId, f.mutation(), owner))
  const partial = await capture('partial')
  assert.deepEqual(
    partial.repositories.map((repository) => repository.sourceId),
    [source.id],
  )
  assert.deepEqual(
    partial.sourceErrors.map((issue) => issue.sourceId),
    [other.id],
  )
  assert.deepEqual(
    partial.sourceWarnings.map((issue) => issue.sourceId),
    [source.id],
  )
  const updated = f.authoring.saveRepository(
    projectId,
    source.id,
    {
      ...f.mutation(),
      value: { name: source.name, url: 'https://github.com/fixtures/changed.git' },
    },
    owner,
  )
  assert.equal(updated.repository.url, 'https://github.com/fixtures/changed.git')
  const changed = await capture('changed-source')
  assert.equal(changed.repositories.length, 1)
  assert.equal(changed.repositories[0].source.url, source.url)
  assert.equal(changed.sourceWarnings[0].code, 'WORKSPACE_SOURCE_CONFIGURATION_PENDING')
  assert.equal(changed.sourceErrors.length, 1)
  const record = f.authoring
    .syncRecords(projectId, owner)
    .find((record) => record.sourceId === source.id)
  assert.equal(record.versionId, changed.repositories[0].versionId)
  assert.equal(record.commit, changed.repositories[0].commit)
  const picker = await f.service.captureAvailableInput(
    projectId,
    { workspaceType: 'internal' },
    'reader',
  )
  assert.equal(picker.repositories.length, 1)
  assert.match(f.service.readInputFile(projectId, changed.id, 'apps/web/README.md', 'reader').bytes.toString(), /固定源码/u)
})

test('本地固定选择时仍核对当前权限和修订，移除来源不用于下一新轮', async t => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  await f.syncCurrent()
  const capture = requestId => f.service.captureAgentInput(projectId, {requestId, workspaceType: 'internal'}, 'reader')
  const prepare = f.authoring.prepareInput
  f.authoring.prepareInput = (...args) => {
    f.memberships.find(member => member.userId === 'reader').status = 'disabled'
    return prepare(...args)
  }
  await assert.rejects(capture('revoked'))
  f.memberships.find(member => member.userId === 'reader').status = 'active'
  f.authoring.prepareInput = (...args) => {
    f.authoring.removeSource(projectId, source.id, f.mutation(), owner)
    return prepare(...args)
  }
  await assert.rejects(capture('removed-during-selection'), {code: 'WORKSPACE_REVISION_CONFLICT'})
  f.authoring.prepareInput = prepare
  const removed = await capture('removed')
  assert.deepEqual(removed.repositories, [])
  assert.equal(removed.sourceErrors, undefined)
  assert.equal(f.calls.resolve.length, 1)
})

test('已选源码引用在新轮Git失败时仍能按所选原件读取，未发送引用和撤权仍拒绝', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  await f.syncCurrent()
  const principal = { id: 'reader', sessionHash: 'session-reader' }
  for (const threadId of ['selected', 'unselected'])
    f.access.bindThread(principal, {
      threadId,
      projectId,
      environmentId: 'env-test',
      agentId: 'a-project',
      visibility: 'private',
      workspaceType: 'internal',
    })
  await f.service.captureAgentInput(
    projectId,
    { requestId: 'sync', workspaceType: 'internal' },
    'reader',
  )
  const catalog = createBusinessResourceCatalog({
    access: f.access,
    workspaceStore: f.store,
    workspaceInputs: f.service,
  })
  const cwd = `autoops://projects/${projectId}/environments/env-test/threads/selected?workspaceType=internal`
  const found = await catalog.search(principal, { cwd, query: 'README', limit: 10 })
  const path = found.entries.find((entry) => entry.path.endsWith('/README.md')).path
  const selectedInputId = path.split('/')[3]
  catalog.requireContext('selected', { records: [{ kind: 'mention', path }] })
  f.control.failResolve = true
  await assert.rejects(f.service.sync(projectId, f.mutation(), owner))
  const inputs = createBusinessRunInputs(f.access, f.service)
  f.access.recordMessageActor(principal, 'selected', 'current-command', 'current-message')
  const current = await inputs.prepare(
    'selected',
    'current',
    undefined,
    undefined,
    'current-message',
  )
  assert.equal(current.repositories.length, 1)
  assert.equal(current.sourceErrors, undefined)
  assert.equal(current.sourceWarnings[0].code, 'WORKSPACE_GIT_FAILED')
  assert.notEqual(current.id, selectedInputId)
  await assert.rejects(catalog.readForThread('selected', path, current.id))
  assert.match(
    (await catalog.readForThread('selected', path, current.id, [selectedInputId])).content,
    /frontend 固定源码/,
  )
  f.access.recordMessageActor(principal, 'unselected', 'other-command', 'other-message')
  const other = await inputs.prepare('unselected', 'other', undefined, undefined, 'other-message')
  await assert.rejects(catalog.readForThread('unselected', path, other.id, [selectedInputId]))
  f.memberships.find((member) => member.userId === 'reader').status = 'disabled'
  await assert.rejects(catalog.readForThread('selected', path, current.id, [selectedInputId]))
})

test('抓取故障限定源码范围，但校验失败、撤权与取消不能降级伪装成可执行输入', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  await f.upload('docs/product.md', '当前正文')
  f.control.beforeFetch = () => {
    throw Object.assign(new Error('虚构网络故障'), { code: 'WORKSPACE_GIT_TIMEOUT', status: 504 })
  }
  await f.syncCurrent('failed')
  const unavailable = await f.service.captureAgentInput(
    projectId,
    { requestId: 'fetch-unavailable', workspaceType: 'internal' },
    'reader',
  )
  assert.equal(unavailable.sourceErrors[0].code, 'WORKSPACE_SOURCE_UNSYNCED')
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
  const failed = await f.syncCurrent('failed')
  assert.equal(failed.failureCode, 'WORKSPACE_GIT_COMMIT_MISMATCH')
  const prepare = f.authoring.prepareInput
  f.authoring.prepareInput = (...args) => {
    f.memberships.find((value) => value.userId === 'reader').status = 'disabled'
    return prepare(...args)
  }
  await assert.rejects(
    f.service.captureAgentInput(
      projectId,
      { requestId: 'revoked-during-fetch', workspaceType: 'internal' },
      'reader',
    ),
  )
  f.memberships.find((value) => value.userId === 'reader').status = 'active'
  f.authoring.prepareInput = prepare
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
  const f = await fixture(t, { initialContent: 'example' })
  await f.source('frontend')
  await f.syncCurrent()
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

test('跟踪分支新提交经显式更新后才影响下一轮，原轮和原请求继续读取原Git提交', async (t) => {
  const f = await fixture(t)
  await f.source('frontend')
  await f.syncCurrent()
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
  const beforeUpdate = await f.service.captureAgentInput(projectId, {requestId: 'before-explicit-update', workspaceType: 'internal'}, 'reader')
  assert.equal(beforeUpdate.repositories[0].commit, first.repositories[0].commit)
  await f.syncCurrent()
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
  const synced = await f.syncCurrent()
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
  const task = synced
  const pending = f.authoring.preparedInputByRequest(projectId, 'unknown-input', owner, 'internal')
  assert.equal(pending.repositories[0].versionId, task.versionId)
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

test('部署解析失败和固定提交抓取失败在原任务持久终态后释放捕获，原请求不重复执行', async (t) => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const contexts = [{ service: 'frontend', root: 'apps/web', workingDirectory: '.' }]
  f.control.beforeResolve = () => {
    throw Object.assign(new Error('隔离部署解析超时'), {
      code: 'WORKSPACE_GIT_TIMEOUT',
      status: 504,
    })
  }
  const resolving = {
    requestId: 'deployment-resolve-failed',
    sources: [{ sourceId: source.id, refKind: 'default', ref: '', mountPath: source.mountPath }],
    contexts,
  }
  const first = f.service.startDeploymentPackages(projectId, resolving, owner)
  const failed = await f.finish(first)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(failed.status, 'failed')
  assert.equal(failed.failureCode, 'WORKSPACE_GIT_TIMEOUT')
  const original = f.authoring.captureByRequest(projectId, resolving.requestId, owner)
  assert.equal(original.resolution, 'failed')
  assert.equal(original.status, 'released')
  assert.equal(original.resolutionError.code, 'WORKSPACE_GIT_TIMEOUT')
  const resolveCalls = f.calls.resolve.length
  assert.equal(f.service.startDeploymentPackages(projectId, resolving, owner).id, failed.id)
  assert.equal(f.calls.resolve.length, resolveCalls)

  f.control.beforeResolve = undefined
  f.control.beforeFetch = () => {
    throw Object.assign(new Error('隔离固定提交下载失败'), {
      code: 'WORKSPACE_GIT_FAILED',
      status: 502,
    })
  }
  const repository = await f.repository('frontend')
  const fetching = {
    requestId: 'deployment-fetch-failed',
    sources: [
      {
        sourceId: source.id,
        refKind: 'commit',
        ref: repository.commit,
        mountPath: source.mountPath,
      },
    ],
    contexts,
  }
  const second = f.service.startDeploymentPackages(projectId, fetching, owner)
  const fetched = await f.finish(second)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fetched.status, 'failed')
  assert.equal(fetched.failureCode, 'WORKSPACE_GIT_FAILED')
  const frozen = f.authoring.captureByRequest(projectId, fetching.requestId, owner)
  assert.equal(frozen.status, 'released')
  assert.equal(frozen.resolution, 'resolved')
  assert.equal(frozen.resolvedRepositories[0].commit, repository.commit)
  assert.equal(
    f.authoring.deploymentInput(
      projectId,
      fetching.requestId,
      sha(JSON.stringify(fetching)),
      owner,
    ),
    null,
  )
  assert.equal(f.authoring.inputProtectionSummary(projectId, owner).pendingCaptures.length, 0)
  const fetchCalls = f.calls.fetch.length
  assert.deepEqual(f.service.receipt(projectId, fetching.requestId, owner).task, fetched)
  assert.equal(f.service.startDeploymentPackages(projectId, fetching, owner).id, fetched.id)
  assert.equal(f.calls.fetch.length, fetchCalls)
})

async function legacyDeploymentFailure(f, input, resolution) {
  const source = f.authoring
    .overview(projectId, owner)
    .sources.find((value) => value.id === input.sources[0].sourceId)
  const revision = f.authoring.overview(projectId, owner).revision
  const repository = await f.repository('frontend')
  // 只通过所属模块的公开入口重现旧版已失败但未归还捕获的状态，不修改存储表或状态文件。
  const task = f.store.startSourcePackages(
    projectId,
    input,
    async () => {
      const capture = f.authoring.capture(projectId, revision, owner, input.requestId, {
        sources: [source],
        documents: false,
      })
      if (resolution === 'resolved')
        f.authoring.freezeCaptureRepositories(
          projectId,
          capture.id,
          [
            {
              sourceId: source.id,
              commit: repository.commit,
              refKind: source.refKind,
              ref: 'main',
              defaultRef: 'main',
            },
          ],
          owner,
        )
      if (resolution === 'failed')
        f.authoring.failCaptureResolution(
          projectId,
          capture.id,
          { code: 'WORKSPACE_GIT_TIMEOUT', message: '隔离旧部署超时' },
          owner,
        )
      throw Object.assign(new Error('隔离旧部署失败'), {
        code: resolution === 'pending' ? 'FIXTURE_RECEIPT_UNKNOWN' : 'WORKSPACE_GIT_FAILED',
        status: 502,
      })
    },
    owner,
  )
  return f.finish(task)
}

test('部署来源维护按真实过期任务和原输入身份归还pin，撤权不借管理员且非部署引用继续保护', async t => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const input = {requestId:'maintenance-deployment',sources:[{sourceId:source.id,refKind:'default',ref:'',mountPath:source.mountPath}],contexts:[{service:'frontend',root:source.mountPath,workingDirectory:'.'}]}
  const done = await f.finish(f.service.startDeploymentPackages(projectId,input,owner))
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(done.status,'completed')
  const original = f.authoring.deploymentInput(projectId,input.requestId,sha(JSON.stringify(input)),owner)
  assert.ok(original)
  const reference = `deployment:${original.id}`
  assert.ok(f.store.planCleanupVersions(projectId,[original.versionId],owner).reasons[original.versionId].some(value=>value.reference===reference))
  assert.deepEqual(f.store.packageCleanupCandidates([]),[])
  t.mock.timers.enable({apis:['Date'],now:Date.now()+8*24*60*60*1000})
  const candidate = f.store.packageCleanupCandidates([]).find(value=>value.taskId===done.id)
  assert.ok(candidate)
  assert.equal(f.service.releaseDeploymentSourceForMaintenance({...candidate,actorId:'second'}),false)
  assert.equal(f.service.releaseDeploymentSourceForMaintenance({...candidate,taskId:'different-task'}),false)
  assert.equal(f.service.releaseDeploymentSourceForMaintenance({...candidate,sourceVersionId:'different-version'}),false)
  const preparing = f.authoring.prepareInput(projectId,'maintenance-unrelated-input',owner,{workspaceType:'internal',revision:f.mutation().expectedRevision,repositories:original.repositories})
  assert.equal(f.service.releaseDeploymentSourceForMaintenance(candidate),false)
  f.authoring.saveInput(preparing,owner)
  assert.equal(f.service.releaseDeploymentSourceForMaintenance(candidate),false)
  f.authoring.releaseInput(projectId,preparing.id,owner)
  const scope = f.memberships.find(value=>value.userId===owner)
  scope.status='disabled'
  assert.equal(f.service.releaseDeploymentSourceForMaintenance(candidate),true)
  assert.equal(f.service.releaseDeploymentSourceForMaintenance(candidate),true)
  scope.status='active'
  assert.ok(!f.store.planCleanupVersions(projectId,[original.versionId],owner).reasons[original.versionId].some(value=>value.reference===reference))
  assert.equal(f.store.getVersion(projectId,original.versionId).id,original.versionId)
  assert.equal(f.store.overview(projectId).releases.find(value=>value.id===done.releaseId).id,done.releaseId)
})

test('部署来源维护遇到本项目活动准备或收据读取故障保持pin，准备终止并恢复事实后才归还', async t => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const input = {requestId:'maintenance-preparation-guard',sources:[{sourceId:source.id,refKind:'default',ref:'',mountPath:source.mountPath}],contexts:[{service:'frontend',root:source.mountPath,workingDirectory:'.'}]}
  const done = await f.finish(f.service.startDeploymentPackages(projectId,input,owner))
  await new Promise(resolve=>setImmediate(resolve))
  const original = f.authoring.deploymentInput(projectId,input.requestId,sha(JSON.stringify(input)),owner)
  const reference = `deployment:${original.id}`
  t.mock.timers.enable({apis:['Date'],now:Date.now()+8*24*60*60*1000})
  const candidate = f.store.packageCleanupCandidates([]).find(value=>value.taskId===done.id)
  assert.ok(candidate)
  const resolving = deferred(), gate = deferred(), cancellation = new AbortController()
  f.control.beforeResolve = async () => {resolving.resolve();await gate.promise}
  const preparing = f.service.sync(projectId,f.mutation(),owner,cancellation.signal)
  await resolving.promise
  try {assert.equal(f.service.releaseDeploymentSourceForMaintenance(candidate),false)} finally {cancellation.abort();gate.resolve()}
  await assert.rejects(preparing)
  const read = f.authoring.withDeploymentSourceMaintenanceReceipt
  f.authoring.withDeploymentSourceMaintenanceReceipt = () => {throw new Error('隔离原收据读取失败')}
  assert.throws(()=>f.service.releaseDeploymentSourceForMaintenance(candidate),/隔离原收据读取失败/u)
  assert.ok(f.store.planCleanupVersions(projectId,[original.versionId],owner).reasons[original.versionId].some(value=>value.reference===reference))
  f.authoring.withDeploymentSourceMaintenanceReceipt = read
  assert.equal(f.service.releaseDeploymentSourceForMaintenance(candidate),true)
})

test('部署任务确定失败但固定输入交接收据未知时保持部署来源pin，不用过期代替原请求事实', async t => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const input = {requestId:'maintenance-unknown-input',sources:[{sourceId:source.id,refKind:'default',ref:'',mountPath:source.mountPath}],contexts:[{service:'frontend',root:source.mountPath,workingDirectory:'.'}]}
  f.authoring.saveDeploymentInput = () => {throw Object.assign(new Error('隔离部署输入收据丢失'),{code:'FIXTURE_DEPLOYMENT_INPUT_UNKNOWN'})}
  const done = await f.finish(f.service.startDeploymentPackages(projectId,input,owner))
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(done.status,'failed')
  const captured = f.authoring.captureByRequest(projectId,input.requestId,owner)
  t.mock.timers.enable({apis:['Date'],now:Date.now()+8*24*60*60*1000})
  const candidate = f.store.packageCleanupCandidates([]).find(value=>value.taskId===done.id)
  assert.ok(candidate)
  assert.equal(f.service.releaseDeploymentSourceForMaintenance(candidate),false)
  assert.ok(f.store.planCleanupVersions(projectId,[candidate.sourceVersionId],owner).reasons[candidate.sourceVersionId].some(value=>value.reference===`deployment:${captured.id}`))
})

test('旧部署failed记录通过GET或原POST核对收敛捕获，保留原任务标识和失败事实', async (t) => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  for (const [resolution, method] of [
    ['failed', 'GET'],
    ['resolved', 'GET'],
    ['resolved', 'POST'],
  ]) {
    const input = {
      requestId: `legacy-deployment-${resolution}-${method}`,
      sources: [{ sourceId: source.id, refKind: 'default', ref: '', mountPath: source.mountPath }],
      contexts: [{ service: 'frontend', root: 'apps/web', workingDirectory: '.' }],
    }
    const previous = await legacyDeploymentFailure(f, input, resolution)
    assert.equal(previous.status, 'failed')
    const capture = f.authoring.captureByRequest(projectId, input.requestId, owner)
    assert.equal(capture.status, 'active')
    const count = f.store.overview(projectId).tasks.length
    const actual =
      method === 'GET'
        ? (await f.http(`requests/${input.requestId}`)).body.task
        : (await f.http('deployment-packages', { method: 'POST', input })).body.task
    assert.deepEqual(actual, previous)
    assert.equal(f.store.overview(projectId).tasks.length, count)
    const settled = f.authoring.captureByRequest(projectId, input.requestId, owner)
    assert.equal(settled.id, capture.id)
    assert.equal(settled.status, 'released')
    assert.equal(settled.resolution, resolution)
    assert.deepEqual(settled.resolutionError, capture.resolutionError)
    assert.equal(f.calls.resolve.length, 0)
    assert.equal(f.calls.fetch.length, 0)
  }
})

test('部署正在运行时重复核对不释放捕获，缺少任务或解析结果未知也继续保护', async (t) => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const entered = deferred(),
    gate = deferred()
  f.control.beforeFetch = async () => {
    entered.resolve()
    await gate.promise
    throw Object.assign(new Error('隔离下载结束失败'), {
      code: 'WORKSPACE_GIT_FAILED',
      status: 502,
    })
  }
  const input = {
    requestId: 'deployment-running',
    sources: [{ sourceId: source.id, refKind: 'default', ref: '', mountPath: source.mountPath }],
    contexts: [{ service: 'frontend', root: 'apps/web', workingDirectory: '.' }],
  }
  const task = f.service.startDeploymentPackages(projectId, input, owner)
  await entered.promise
  try {
    assert.equal(
      f.store.taskForRequest(projectId, 'packages', input.requestId, owner).status,
      'running',
    )
    assert.equal(
      f.service.reconcileFailedDeploymentCapture(projectId, input.requestId, owner),
      false,
    )
    assert.equal(f.service.receipt(projectId, input.requestId, owner).task.id, task.id)
    assert.equal(f.service.startDeploymentPackages(projectId, input, owner).id, task.id)
    assert.equal(f.authoring.captureByRequest(projectId, input.requestId, owner).status, 'active')
  } finally {
    gate.resolve()
  }
  assert.equal((await f.finish(task)).status, 'failed')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.authoring.captureByRequest(projectId, input.requestId, owner).status, 'released')

  const absent = 'deployment-task-unknown'
  const capture = f.authoring.capture(projectId, f.mutation().expectedRevision, owner, absent, {
    sources: [source],
    documents: false,
  })
  f.authoring.failCaptureResolution(
    projectId,
    capture.id,
    { code: 'WORKSPACE_GIT_TIMEOUT', message: '隔离无任务收据' },
    owner,
  )
  assert.equal(f.service.reconcileFailedDeploymentCapture(projectId, absent, owner), false)
  assert.equal(f.service.receipt(projectId, absent, owner).task, undefined)
  assert.equal(f.authoring.captureByRequest(projectId, absent, owner).status, 'active')

  const unresolved = { ...input, requestId: 'deployment-resolution-unknown' }
  await legacyDeploymentFailure(f, unresolved, 'pending')
  assert.equal(
    f.service.reconcileFailedDeploymentCapture(projectId, unresolved.requestId, owner),
    false,
  )
  assert.equal(f.service.receipt(projectId, unresolved.requestId, owner).task.status, 'failed')
  assert.equal(
    f.authoring.captureByRequest(projectId, unresolved.requestId, owner).status,
    'active',
  )
})

test('跨API原失败部署不能释放尚未交接的本地资料准备，原输入收据可恢复', async t => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const synced = await f.syncCurrent()
  const input = {requestId: 'deployment-reused-by-agent', sources: [{sourceId: source.id, refKind: 'default', ref: '', mountPath: source.mountPath}], contexts: [{service: 'frontend', root: 'apps/web', workingDirectory: '.'}]}
  const failed = await legacyDeploymentFailure(f, input, 'resolved')
  const original = f.authoring.captureByRequest(projectId, input.requestId, owner)
  const saveInput = f.authoring.saveInput
  f.authoring.saveInput = () => {throw Object.assign(new Error('隔离输入收据未知'), {code: 'FIXTURE_INPUT_RECEIPT_UNKNOWN'})}
  const agentInput = {requestId: input.requestId, workspaceType: 'internal'}
  const capturing = f.service.captureAgentInput(projectId, agentInput, owner)
  assert.equal(f.service.reconcileFailedDeploymentCapture(projectId, input.requestId, owner), false)
  await assert.rejects(capturing, {code: 'FIXTURE_INPUT_RECEIPT_UNKNOWN'})
  assert.equal(f.service.reconcileFailedDeploymentCapture(projectId, input.requestId, owner), false)
  assert.deepEqual((await f.http(`requests/${input.requestId}`)).body.task, failed)
  assert.equal(f.authoring.captureByRequest(projectId, input.requestId, owner).status, 'active')
  assert.equal(f.store.taskForRequest(projectId, 'input', input.requestId, owner), undefined)
  f.authoring.saveInput = saveInput
  const recovered = await f.service.captureAgentInput(projectId, agentInput, owner)
  assert.equal(recovered.captureId, original.id)
  assert.equal(recovered.repositories[0].versionId, synced.versionId)
  assert.equal(f.calls.fetch.length, 1)
  assert.match(f.service.readInputFile(projectId, recovered.id, 'apps/web/README.md', owner).bytes.toString(), /固定源码/u)
})

test('工作区 HTTP 只保存项目仓库使用配置，拒绝 URL 凭证和跨项目来源', async (t) => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const usage = {
    id: source.id,
    role: 'documentation',
    refKind: 'branch',
    ref: 'workspace-only',
    mountPath: 'repositories/code',
  }
  const input = { ...f.mutation(), ...usage }
  const updated = await f.http('sources', { method: 'POST', input: { action: 'save', input } })
  assert.equal(updated.body.source.ref, 'workspace-only')
  assert.equal(updated.body.source.url, source.url)
  assert.deepEqual(f.authoring.repositories(projectId, owner).items, [
    { id: source.id, name: source.name, url: source.url },
  ])
  assert.deepEqual(
    (await f.http('sources', { method: 'POST', input: { action: 'save', input } })).body,
    updated.body,
  )
  for (const forged of [
    { url: 'https://github.com/fixtures/other.git' },
    { credentialId: 'foreign-credential' },
    { password: 'fictional-secret' },
    { name: '改写连接' },
  ]) {
    await assert.rejects(
      f.http('sources', {
        method: 'POST',
        input: { action: 'save', input: { ...f.mutation(), ...usage, ...forged } },
      }),
      (error) => error.status === 400 && error.code === 'WORKSPACE_REQUEST_INVALID',
    )
  }
  await assert.rejects(
    f.http('sources', {
      method: 'POST',
      actor: 'reader',
      input: { action: 'save', input: { ...f.mutation(), ...usage } },
    }),
    (error) => error.status === 403,
  )
  await assert.rejects(
    f.http('sources', {
      method: 'POST',
      input: { action: 'save', input: { ...f.mutation(), ...usage, id: 'foreign-repository' } },
    }),
    (error) => error.status === 404,
  )
  assert.equal(f.authoring.overview(projectId, owner).sources[0].ref, 'workspace-only')
  assert.equal(f.calls.fetch.length, 0)
})

test('只登记项目连接即可独立固定部署源码，不创建或读取工作区使用配置', async (t) => {
  const f = await fixture(t)
  const connection = f.authoring.saveRepository(
    projectId,
    null,
    {
      ...f.mutation(),
      value: { name: '仅用于部署', url: 'https://github.com/fixtures/frontend.git' },
    },
    owner,
  ).repository
  await f.upload('docs/private.md', '不能进入部署包的资料')
  assert.deepEqual(f.authoring.overview(projectId, owner).sources, [])
  const input = {
    requestId: 'repository-only-deployment',
    sources: [
      {
        sourceId: connection.id,
        refKind: 'branch',
        ref: 'deployment-only',
        mountPath: 'repository',
      },
    ],
    contexts: [{ service: 'frontend', root: 'repository', workingDirectory: '.' }],
  }
  const task = f.service.startDeploymentPackages(projectId, input, owner)
  const result = await f.finish(task)
  assert.equal(result.status, 'completed', result.error)
  const release = f.store
    .overview(projectId)
    .releases.find((value) => value.id === result.releaseId)
  const files = Object.keys(
    unzipSync(Buffer.from(f.store.packageFile(projectId, release.id, 'frontend').bytes)),
  )
  assert(files.includes('README.md'))
  assert(!files.some((file) => file.includes('private.md')))
  assert.deepEqual(f.authoring.overview(projectId, owner).sources, [])
  assert.equal(
    f.authoring.captureByRequest(projectId, input.requestId, owner).sources[0].ref,
    'deployment-only',
  )
  assert.equal(f.service.startDeploymentPackages(projectId, input, owner).id, task.id)
  const tampered = { ...input, sources: [{ ...input.sources[0], mountPath: 'changed' }] }
  assert.throws(() => f.service.startDeploymentPackages(projectId, tampered, owner), {
    status: 409,
  })
})

test('独立部署选源拒绝跨项目、连接篡改和目录重叠，不请求远端', async (t) => {
  const f = await fixture(t)
  const source = await f.source('frontend')
  const back = await f.source('backend')
  const selection = { sourceId: source.id, refKind: 'default', ref: '', mountPath: 'app' }
  const contexts = [{ service: 'frontend', root: '.', workingDirectory: '.' }]
  for (const [change, code] of [
    [{ sourceId: 'foreign-repository' }, 'WORKSPACE_SOURCE_NOT_FOUND'],
    [{ url: 'https://github.com/fixtures/other.git' }, 'WORKSPACE_DEPLOYMENT_SOURCES_INVALID'],
    [{ credentialId: 'foreign-credential' }, 'WORKSPACE_DEPLOYMENT_SOURCES_INVALID'],
    [{ ref: 'hidden-branch' }, 'WORKSPACE_REF_INVALID'],
  ]) {
    const task = f.service.startDeploymentPackages(
      projectId,
      { requestId: randomUUID(), sources: [{ ...selection, ...change }], contexts },
      owner,
    )
    const failed = await f.finish(task)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failureCode, code)
  }
  const overlapped = f.service.startDeploymentPackages(
    projectId,
    {
      requestId: randomUUID(),
      sources: [
        selection,
        { sourceId: back.id, refKind: 'default', ref: '', mountPath: 'app/nested' },
      ],
      contexts,
    },
    owner,
  )
  assert.equal((await f.finish(overlapped)).failureCode, 'WORKSPACE_DEPLOYMENT_SOURCES_INVALID')
  assert.equal(f.calls.resolve.length, 0)
  assert.equal(f.calls.fetch.length, 0)
})
