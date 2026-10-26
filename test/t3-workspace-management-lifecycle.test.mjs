import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWorkspaceManagement } from '../agent-demo/t3-adapters/workspace-management.ts'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(options = {}) {
  const source = { id: 'repo', name: '源码', role: 'frontend', url: 'https://github.com/example/fixture.git', refKind: 'branch', ref: 'main', mountPath: 'frontend' }
  const configurationHash = createHash('sha256').update(JSON.stringify(source)).digest('hex')
  const version = { id: 'version-a', status: 'published', createdAt: '2026-10-23T00:00:00.000Z', source: { repositories: [{ sourceId: 'repo', path: 'frontend', configurationHash, commit: 'a'.repeat(40) }], authoringRevision: 1 } }
  const state = { readable: true, released: 0, authoringClosed: 0, credentialStopped: 0, credentialDrained: 0, credentialClosed: 0 }
  const access = { requireWorkspaceInputReader() { this.requireWorkspaceReader() }, requireWorkspaceReader() { if (!state.readable) throw Object.assign(new Error('测试读取权限已撤回'), { status: 403, code: 'FIXTURE_REVOKED' }) }, requireWorkspaceActor() {} }
  const authoring = {
    currentAdoptionProjects() { return [] },
    currentAdoptionSources() { return [] },
    recordSyncBatch(_project, values) { return values },
    overview() { return { projectId: 'project-a', revision: 1, sources: [source], entries: [], limits: {} } },
    syncRecords() { return [{sourceId: source.id, configurationHash, versionId: version.id, status: 'synced', current: {sourceId: source.id, commit: 'a'.repeat(40), refKind: 'branch', ref: 'main', defaultRef: null, source, versionId: version.id}}] },
    capture() { return { id: 'capture-a', projectId: 'project-a', requestId: 'snapshot-a', revision: 1, sources: [], files: [], directories: [], resolution: 'resolved', resolvedRepositories: [], status: 'active' } },
    releaseCapture() { state.released++ },
    async close() { state.authoringClosed++; if (options.authoringCloseError) throw new Error('测试资料库关闭失败') },
  }
  const credentials = {
    stopAccepting() { state.credentialStopped++ },
    async drain() { state.credentialDrained++; if (options.credentialDrainError) throw new Error('测试凭证排空失败') },
    close() { state.credentialClosed++ },
  }
  const store = {
    overview() { return { internalVersions: [version] } },
    getVersion() { return version },
    versionFile() { return { bytes: new TextEncoder().encode('测试正文'), name: 'README.md', mime: 'text/markdown' } },
    async whenIdle() {},
    taskForRequest() {},
    ...options.store,
  }
  const service = createWorkspaceManagement({ access, authoring, credentials, store, git: {}, ...options.ports })
  return { service, state, authoring, store }
}

test('来源正文提取限制两项并发，关闭等待已接收预览且拒绝新的Worker', async () => {
  const gates = [deferred(), deferred()], entered = []
  const { service, state } = fixture({ ports: { extractAttachment(file) { entered.push(file.id); return gates[entered.length - 1].promise } } })
  const first = service.currentContent('project-a', 'frontend/one.md', 'actor-a')
  const second = service.currentContent('project-a', 'frontend/two.md', 'actor-a')
  await assert.rejects(service.currentContent('project-a', 'frontend/three.md', 'actor-a'), error => error.code === 'WORKSPACE_PREVIEW_BUSY')
  await tick(); assert.deepEqual(entered, ['frontend/one.md', 'frontend/two.md'])
  let closed = false
  const closing = service.close().then(() => { closed = true })
  await assert.rejects(service.currentContent('project-a', 'frontend/new.md', 'actor-a'), error => error.code === 'WORKSPACE_STOPPING')
  await tick(); assert.equal(closed, false); assert.equal(state.authoringClosed, 0)
  gates[0].resolve({ content: '第一份正文', extraction: { status: 'ready' } })
  assert.equal((await first).contents, '第一份正文')
  await tick(); assert.equal(closed, false)
  gates[1].resolve({ content: '第二份正文', extraction: { status: 'ready' } })
  assert.equal((await second).contents, '第二份正文')
  await closing
  assert.equal(state.authoringClosed, 1); assert.equal(state.credentialClosed, 1)
  await service.close(); assert.equal(state.credentialClosed, 1)
})

test('来源预览在解析后重新裁决权限，迟到正文不能在撤权后返回', async () => {
  const gate = deferred(), { service, state } = fixture({ ports: { extractAttachment() { return gate.promise } } })
  const reading = service.currentContent('project-a', 'frontend/private.md', 'actor-a')
  await tick(); state.readable = false
  gate.resolve({ content: '不得返回的测试正文', extraction: { status: 'ready' } })
  await assert.rejects(reading, error => error.code === 'FIXTURE_REVOKED')
  await service.close(); assert.equal(state.credentialClosed, 1)
})

test('资料关闭和凭证排空各自失败时仍尝试所有资源关闭，并保留聚合错误', async () => {
  const { service, state } = fixture({ authoringCloseError: true, credentialDrainError: true })
  await assert.rejects(service.close(), error => error instanceof AggregateError && error.errors.length === 2)
  assert.equal(state.authoringClosed, 1); assert.equal(state.credentialStopped, 1)
  assert.equal(state.credentialDrained, 1); assert.equal(state.credentialClosed, 1)
  await assert.rejects(service.close(), AggregateError)
  assert.equal(state.credentialClosed, 1)
})

test('物化结束仍保留原件，只有发布后的原任务持久终态才释放capture', async () => {
  const idle = deferred(), materialized = deferred()
  let task
  const f = fixture({ store: {
    whenIdle() { return idle.promise },
    taskForRequest() { return task },
    startSnapshot(_project, input, materialize) {
      task = { id: 'task-a', requestId: input.requestId, status: 'running', stage: 'preparing' }
      void materialize({ root: '/tmp/fixture-empty-no-write', signal: new AbortController().signal, progress() {}, checkBudget() {} }).then(() => { task.stage = 'publishing'; materialized.resolve() }, materialized.reject)
      return task
    },
  } })
  await f.service.generate('project-a', { requestId: 'snapshot-a', expectedRevision: 1 }, 'actor-a')
  await materialized.promise; await tick()
  assert.equal(task.stage, 'publishing'); assert.equal(f.state.released, 0)
  task.status = 'completed'; task.stage = 'completed'; task.versionId = 'version-a'; idle.resolve()
  await tick(); assert.equal(f.state.released, 1)
  await f.service.close()
})

test('队列排空不能代替持久终态证明，未知原收据继续保留capture', async () => {
  let task
  const f = fixture({ store: { startSnapshot(_project, input) { task = { id: 'task-a', requestId: input.requestId, status: 'running' }; return task }, taskForRequest() { return task } } })
  await f.service.generate('project-a', { requestId: 'snapshot-a', expectedRevision: 1 }, 'actor-a')
  await tick(); assert.equal(f.state.released, 0)
  await f.service.close(); assert.equal(f.state.released, 0)
})
