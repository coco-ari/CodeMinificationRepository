import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema, AutoOpsAccessError } from '../agent-demo/t3-adapters/access.mjs'
import { createBusinessRunInputs } from '../agent-demo/t3-adapters/thread-inputs.ts'
import { createBusinessResourceCatalog } from '../agent-demo/t3-adapters/resources.mjs'
import { createBusinessArtifactStore } from '../agent-demo/t3-adapters/business-tools.mjs'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'
import { createWorkspaceAuthoring } from '../agent-demo/t3-adapters/workspace-authoring/index.ts'
import { createWorkspaceManagement } from '../agent-demo/t3-adapters/workspace-management.ts'
import { createProjectCredentialService } from '../agent-demo/t3-adapters/credentials.ts'
import { createNativeSubagentBindings } from '../agent-demo/t3-adapters/subagents.mjs'

function fixture(t, workspaceStore) {
  const directory = mkdtempSync(join(tmpdir(), 't3-turn-input-'))
  const bindingDb = new DatabaseSync(join(directory, 't3-autoops.sqlite')), sessionDb = new DatabaseSync(':memory:')
  initializeAutoOpsAccessSchema(bindingDb)
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  for (const id of ['u-admin', 'u-lin']) sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(id).digest('hex'), id, 'csrf', Date.now() + 60000)
  const access = createAutoOpsAccess({ bindingDb, sessionDb, workspaceStore }), principal = access.authenticateCookie('demo_session=u-admin')
  const scope = { projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'project', workspaceType: 'internal' }
  for (const threadId of ['one', 'two']) access.bindThread(principal, { ...scope, threadId })
  access.bindThread(principal, { ...scope, threadId: 'external', workspaceType: 'external' })
  let current = '产品说明第一稿', afterRead = () => {}, count = 0
  const snapshots = new Map(), requests = new Map()
  const workspace = {
    async captureAgentInput(projectId, input, actorId) {
      access.requireWorkspaceInputReader(actorId, projectId, input.workspaceType)
      const key = `${actorId}:${projectId}:${input.requestId}:${input.workspaceType}`
      if (requests.has(key)) return this.readInput(projectId, requests.get(key), actorId)
      const id = `input-${++count}`
      const content = input.workspaceType === 'external' ? '经过审核的脱敏产品说明' : current
      const capture = { id, projectId, requestId: input.requestId, workspaceType: input.workspaceType, revision: count, createdAt: new Date().toISOString(), status: 'active', repositories: [], directories: ['docs', 'empty'], files: [{ id: `file-${id}`, path: 'docs/产品.md', revision: id, sha256: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content), mime: 'text/markdown', extraction: { status: 'ready' } }] }
      snapshots.set(id, { actorId, content, capture }); requests.set(key, id)
      return capture
    },
    captureAvailableInput(projectId, input, actorId) { return this.captureAgentInput(projectId, { ...input, requestId: `picker-${current}` }, actorId) },
    readInput(projectId, id, actorId) {
      const found = snapshots.get(id)
      if (!found || found.actorId !== actorId || found.capture.projectId !== projectId) throw new AutoOpsAccessError(404, 'WORKSPACE_INPUT_NOT_FOUND', '资料不存在')
      access.requireWorkspaceInputReader(actorId, projectId, found.capture.workspaceType)
      return found.capture
    },
    inputFiles(projectId, id, actorId) { return this.readInput(projectId, id, actorId).files },
    readInputFile(projectId, id, path, actorId) {
      assert.equal(path, 'docs/产品.md'); this.readInput(projectId, id, actorId)
      return { bytes: Buffer.from(snapshots.get(id).content), name: '产品.md', mime: 'text/markdown', revision: id, sha256: snapshots.get(id).capture.files[0].sha256 }
    },
    async readInputContent(projectId, id, path, actorId) {
      const file = this.readInputFile(projectId, id, path, actorId)
      await afterRead()
      return { contents: file.bytes.toString(), extraction: { status: 'ready' }, ...file }
    },
  }
  const inputs = createBusinessRunInputs(access, workspace), catalog = createBusinessResourceCatalog({ access, workspaceInputs: workspace, workspaceStore })
  t.after(() => { bindingDb.close(); sessionDb.close(); rmSync(directory, { force: true, recursive: true }) })
  const cwd = threadId => `autoops://projects/p-autoops/environments/env-test/threads/${threadId}?workspaceType=${threadId === 'external' ? 'external' : 'internal'}`
  return { access, principal, workspace, inputs, catalog, directory, bindingDb, cwd, update(value) { current = value }, afterRead(value) { afterRead = value } }
}

test('新会话不选固定版本，每轮原任务幂等，恢复和迟到调用不会读取下一轮资料', async t => {
  const f = fixture(t)
  assert.equal(f.access.getThreadBinding('one').workspaceVersionId, undefined)
  const first = await f.inputs.prepare('one', 'run-one')
  f.update('产品说明第二稿')
  assert.equal((await f.inputs.prepare('one', 'run-one')).id, first.id)
  const second = await f.inputs.prepare('one', 'run-two')
  assert.notEqual(first.id, second.id)
  assert.equal((await f.inputs.prepare('one', 'restart', 'run-one')).id, first.id)
  const path = `autoops/p-autoops/inputs/${first.id}/docs/产品.md`
  assert.equal((await f.catalog.readForThread('one', path, first.id)).content, '产品说明第一稿')
  assert.equal((await f.catalog.readForThread('one', path.replace(first.id, second.id), second.id)).content, '产品说明第二稿')
  await assert.rejects(f.catalog.readForThread('one', path.replace(first.id, second.id), first.id), /不能读取后来轮次/)
  await assert.rejects(f.inputs.prepare('one', 'bad-restart', 'missing'), { code: 'THREAD_INPUT_MISSING' })
  await assert.rejects(f.catalog.readForThread('one', path), /必须提供任务输入/)
  assert.throws(() => f.inputs.require('two', first.id), { code: 'THREAD_INPUT_FORBIDDEN' })
  const recoveredDb = new DatabaseSync(join(f.directory, 't3-autoops.sqlite')), recoveredSessions = new DatabaseSync(':memory:')
  const reopened = createAutoOpsAccess({ bindingDb: recoveredDb, sessionDb: recoveredSessions })
  assert.equal(reopened.getRunInput('one', 'run-one').inputId, first.id)
  recoveredDb.close(); recoveredSessions.close()
})

test('当前目录不联网固定一次浏览，空目录保留，发送的历史引用独立保留且不能充当任务身份', async t => {
  const f = fixture(t), cwd = f.cwd('one')
  const root = await f.catalog.list(f.principal, { cwd, directoryPath: '' })
  assert.deepEqual(root.entries.map(entry => entry.path.split('/').at(-1)), ['docs', 'empty'])
  const inputId = root.entries[0].path.split('/')[3]
  const path = `autoops/p-autoops/inputs/${inputId}/docs/产品.md`
  assert.equal((await f.catalog.list(f.principal, { cwd, directoryPath: `autoops/p-autoops/inputs/${inputId}/docs` })).entries[0].path, path)
  f.catalog.requireContext('one', { records: [{ kind: 'mention', path }] })
  f.update('新的产品范围')
  const run = await f.inputs.prepare('one', 'current')
  assert.equal((await f.catalog.readForThread('one', path, run.id, [inputId])).content, '产品说明第一稿')
  assert.throws(() => f.inputs.require('one', inputId), { code: 'THREAD_INPUT_FORBIDDEN' })
  const pinned = await f.catalog.search(f.principal, { cwd: `${cwd}&inputId=${inputId}`, query: '产品', limit: 10 })
  assert.equal(pinned.entries[0].path, path)
  const second = await f.catalog.list(f.principal, { cwd, directoryPath: '' })
  assert.notEqual(second.entries[0].path.split('/')[3], inputId)
  await assert.rejects(f.catalog.list(f.principal, { cwd: `${cwd}&inputId=${run.id}`, directoryPath: `autoops/p-autoops/inputs/${inputId}` }), { code: 'RESOURCE_NOT_FOUND' })
  const otherRun = await f.inputs.prepare('two', 'other')
  await assert.rejects(f.catalog.readForThread('two', path, otherRun.id), /后来轮次|已验证引用/)
})

test('外部目录不能切入内部输入，引用读取解析中撤权不会返回正文', async t => {
  const f = fixture(t), internal = await f.inputs.prepare('one', 'inside'), external = await f.inputs.prepare('external', 'outside')
  const inside = `autoops/p-autoops/inputs/${internal.id}/docs/产品.md`
  await assert.rejects(f.catalog.list(f.principal, { cwd: `${f.cwd('external')}&inputId=${internal.id}`, directoryPath: '' }), /不属于当前范围/)
  assert.throws(() => f.catalog.requireContext('external', { records: [{ kind: 'mention', path: inside }] }), /不属于当前范围/)
  await assert.rejects(f.catalog.readForThread('external', inside, external.id), /后来轮次|已验证引用/)
  f.afterRead(() => f.access.markThreadDeleted('one'))
  await assert.rejects(f.catalog.readForThread('one', inside, internal.id))
})

test('原生子任务只继承事件所属父轮输入，深层子任务与重放不借用后来轮次', async t => {
  const f = fixture(t), native = createNativeSubagentBindings(f.directory, f.access)
  t.after(() => native.close())
  const first = await f.inputs.prepare('one', 'run-one')
  native.register('one', 'child', 'native-child', 'run-one')
  f.update('第二轮')
  const second = await f.inputs.prepare('one', 'run-two')
  native.register('one', 'child', 'native-child', 'run-one')
  native.register('child', 'grandchild', 'native-grandchild', 'run-one')
  assert.equal(f.inputs.require('child', first.id).input.runId, 'run-one')
  assert.equal(f.inputs.require('grandchild', first.id).capture.id, first.id)
  assert.throws(() => f.inputs.require('child', second.id), { code: 'THREAD_INPUT_FORBIDDEN' })
  assert.throws(() => native.register('one', 'unbound', 'native-unbound', 'missing'), /尚未固定/)
  f.access.markThreadDeleted('one')
  assert.throws(() => f.inputs.require('grandchild', first.id))
})


test('旧固定绑定下一轮自动读取当前资料，旧版本失效只影响明确历史读取', async t => {
  let available = true
  const oldStore = {
    getVersion() { if (!available) throw new Error('旧版本已不可用'); return { id: 'legacy', type: 'internal', status: 'published' } },
    files() { return [{ path: 'old.txt', name: 'old.txt', mime: 'text/plain', size: 3 }] },
    read() { this.getVersion(); return { contents: '旧稿', byteLength: 6, truncated: false } },
  }
  const f = fixture(t, oldStore)
  f.access.bindThread(f.principal, { threadId: 'legacy-thread', projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'private', workspaceType: 'internal', workspaceVersionId: 'legacy' })
  const current = await f.inputs.prepare('legacy-thread', 'new-turn')
  const path = `autoops/p-autoops/inputs/${current.id}/docs/产品.md`
  assert.equal((await f.catalog.readForThread('legacy-thread', path, current.id)).content, '产品说明第一稿')
  assert.equal((await f.catalog.readForThread('legacy-thread', 'autoops/p-autoops/workspaces/legacy/old.txt', current.id)).content, '旧稿')
  available = false
  f.update('旧版本已移除后的当前稿')
  const next = await f.inputs.prepare('legacy-thread', 'next-turn')
  const root = await f.catalog.list(f.principal, { cwd: f.cwd('legacy-thread'), directoryPath: '' })
  assert.ok(root.entries.every(entry => entry.path.includes('/inputs/')))
  f.catalog.requireContext('legacy-thread', { records: [{ kind: 'mention', path }] })
  assert.equal((await f.catalog.readForThread('legacy-thread', path.replace(current.id, next.id), next.id)).content, '旧版本已移除后的当前稿')
  await assert.rejects(f.catalog.readForThread('legacy-thread', 'autoops/p-autoops/workspaces/legacy/old.txt', next.id), /旧版本已不可用/)
  assert.deepEqual(f.access.workspaceVersionReferences('p-autoops'), ['legacy'])
})

test('真实资料SQLite上传替换后原任务仍读原件，新轮读取产品及运维当前正文', async t => {
  const f = fixture(t), project = 'p-autoops', actor = f.principal.id
  const store = createWorkspaceStore({ dataDir: f.directory, authorizeTask: ({ actorId, projectId }) => f.access.requireWorkspaceReader(actorId, projectId) })
  await store.ensureProject(f.access.requireProject(f.principal, project))
  const authoring = createWorkspaceAuthoring({ dataDir: f.directory, authorize: (actorId, projectId, action) => action === 'read' ? f.access.requireWorkspaceReader(actorId, projectId) : action === 'external-read' ? f.access.requireWorkspaceInputReader(actorId, projectId, 'external') : f.access.requireWorkspaceActor(actorId, projectId) })
  const credentials = createProjectCredentialService({ databasePath: join(f.directory, 'credentials.sqlite'), keyPath: join(f.directory, 'credential.key'), initializeKeyIfNew: true, authorize(actorId, projectId, action) { f.access.requireCredentialActor(actorId, projectId, action) } })
  const git = { validateRepositorySource(value) { return value }, async resolveRepositoryRef() { assert.fail('纯资料问答不能运行Git') }, async fetchRepositoryAt() { assert.fail('纯资料问答不能运行Git') } }
  const management = createWorkspaceManagement({ access: f.access, store, authoring, credentials, git })
  const inputs = createBusinessRunInputs(f.access, management), catalog = createBusinessResourceCatalog({ access: f.access, workspaceStore: store, workspaceInputs: management })
  try {
    let sequence = 0
    async function upload(path, content) {
      const bytes = Buffer.from(content)
      return authoring.upload(project, { requestId: `upload-${++sequence}`, expectedRevision: authoring.overview(project, actor).revision, path, conflict: 'replace', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, bytes, actor)
    }
    await upload('docs/产品.md', '# 产品说明\n已明确业务目标')
    await upload('docs/运维.md', '# 运维说明\n部署使用独立流程')
    const first = await inputs.prepare('one', 'real-first')
    await upload('docs/产品.md', '# 产品说明\n新的业务目标')
    const second = await inputs.prepare('one', 'real-second')
    assert.equal((await inputs.prepare('one', 'real-first')).id, first.id)
    assert.match((await catalog.readForThread('one', `autoops/${project}/inputs/${first.id}/docs/产品.md`, first.id)).content, /已明确业务目标/)
    assert.match((await catalog.readForThread('one', `autoops/${project}/inputs/${second.id}/docs/产品.md`, second.id)).content, /新的业务目标/)
    assert.match((await catalog.readForThread('one', `autoops/${project}/inputs/${second.id}/docs/运维.md`, second.id)).content, /部署使用独立流程/)
    assert.equal(store.overview(project).internalVersions.filter(version => version.source.authoringRevision !== undefined).length, 0)
  } finally { await management.close(); await store.close() }
})


test('引用资料工具不能绕过原轮历史读取下一轮附件或报告', async t => {
  const f = fixture(t), artifacts = createBusinessArtifactStore(f.directory)
  t.after(() => artifacts.close())
  const catalog = createBusinessResourceCatalog({ access: f.access, workspaceInputs: f.workspace, artifactStore: artifacts, readAttachment: async id => Buffer.from(id) })
  const first = await f.inputs.prepare('one', 'first')
  f.access.recordThreadAttachment(f.principal, 'first-file', 'one', { name: 'first.txt', mimeType: 'text/plain', sizeBytes: 10 })
  const older = artifacts.create({ binding: f.access.getThreadBinding('one'), runId: 'first', name: 'first.md', mime: 'text/markdown', bytes: Buffer.from('第一轮报告') })
  const second = await f.inputs.prepare('one', 'second')
  f.access.recordThreadAttachment(f.principal, 'later-file', 'one', { name: 'later.txt', mimeType: 'text/plain', sizeBytes: 10 })
  const later = artifacts.create({ binding: f.access.getThreadBinding('one'), runId: 'second', name: 'later.md', mime: 'text/markdown', bytes: Buffer.from('下一轮报告') })
  const history = { referencePaths: [], attachmentIds: ['first-file'], acceptedAt: new Date().toISOString() }
  assert.equal((await catalog.readForThread('one', 'autoops/p-autoops/threads/one/attachments/first-file/first.txt', first.id, [], history)).content, 'first-file')
  await assert.rejects(catalog.readForThread('one', 'autoops/p-autoops/threads/one/attachments/later-file/later.txt', first.id, [], history))
  await assert.rejects(catalog.readForThread('one', `autoops/p-autoops/threads/one/reports/${later.id}/later.md`, first.id, [], history))
  assert.equal((await catalog.readForThread('one', `autoops/p-autoops/threads/one/reports/${older.id}/first.md`, second.id, [], history)).content, '第一轮报告')
})
