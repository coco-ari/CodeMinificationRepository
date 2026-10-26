import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'autoops-input-retention-')),
    projectId = 'retention-project'
  const store = createWorkspaceStore({
    dataDir: directory,
    authorizeTask: ({ actorId, projectId: requested }) => {
      assert.equal(actorId, 'manager')
      assert.equal(requested, projectId)
    },
  })
  await store.ensureProject({ id: projectId, name: '隔离资料回收', documents: [] })
  t.after(async () => {
    await store.close({ force: true })
    rmSync(directory, { recursive: true, force: true })
  })
  let serial = 0
  async function snapshot(content, { cache = true, sourceId = 'repository-a', blocked } = {}) {
    const task = store.startSnapshot(
      projectId,
      {
        requestId: `source-${++serial}`,
        captureId: `capture-${serial}`,
        ...(cache ? { cacheKey: `cache-${serial}`, cachePurpose: 'source' } : {}),
        source: {
          capturedAt: new Date().toISOString(),
          repositories: [
            {
              sourceId,
              commit: String(serial).repeat(40),
              path: 'repo',
              configurationHash: 'configuration',
            },
          ],
        },
      },
      async ({ root }) => {
        if (blocked) await blocked
        await mkdir(join(root, 'repo'), { recursive: true })
        await writeFile(join(root, 'repo', 'README.md'), content)
      },
      'manager',
    )
    await store.whenIdle()
    const receipt = store.overview(projectId).tasks.find((value) => value.id === task.id)
    assert.equal(receipt.status, 'completed')
    store.releaseVersion(projectId, `task:${task.id}`)
    return receipt.versionId
  }
  return { directory, projectId, store, snapshot }
}

test('当前指针与活动输入共同保护原件，输入结束后只回收过期版本，恢复不替换为新内容', async (t) => {
  const f = await fixture(t),
    first = await f.snapshot('第一版'),
    second = await f.snapshot('第二版')
  f.store.retainVersion(f.projectId, first, 'current:repository-a')
  f.store.retainVersion(f.projectId, first, 'input:original:repository-a')
  const retention = { current: [{ sourceId: 'repository-a', versionId: second }], versions: [] }
  assert.deepEqual(f.store.collectUnusedWorkspaceVersions(f.projectId, retention), {
    removed: [],
    pending: [],
  })
  assert.equal(f.store.read(f.projectId, first, 'repo/README.md').contents, '第一版')
  f.store.releaseVersion(f.projectId, 'input:original:repository-a')
  assert.deepEqual(f.store.collectUnusedWorkspaceVersions(f.projectId, retention), {
    removed: [first],
    pending: [],
  })
  assert.throws(() => f.store.verifyInputVersion(f.projectId, first), { status: 404 })
  assert.equal(f.store.verifyInputVersion(f.projectId, second).id, second)
  assert.equal(f.store.read(f.projectId, second, 'repo/README.md').contents, '第二版')
  assert.deepEqual(f.store.collectUnusedWorkspaceVersions(f.projectId, retention), {
    removed: [],
    pending: [],
  })
})

test('待准备任务、未知保护、明确原输入引用和错误当前快照都不能被回收', async (t) => {
  const f = await fixture(t),
    first = await f.snapshot('必要原件'),
    second = await f.snapshot('当前')
  f.store.retainVersion(f.projectId, first, 'preparation:unknown-outcome')
  const retention = { current: [{ sourceId: 'repository-a', versionId: second }], versions: [] }
  assert.deepEqual(f.store.collectUnusedWorkspaceVersions(f.projectId, retention).removed, [])
  f.store.releaseVersion(f.projectId, 'preparation:unknown-outcome')
  assert.deepEqual(
    f.store.collectUnusedWorkspaceVersions(f.projectId, { ...retention, versions: [first] })
      .removed,
    [],
  )
  assert.throws(
    () =>
      f.store.collectUnusedWorkspaceVersions(f.projectId, {
        current: [{ sourceId: 'other-source', versionId: second }],
        versions: [],
      }),
    { code: 'WORKSPACE_CURRENT_IDENTITY_UNKNOWN' },
  )
  assert.equal(f.store.verifyInputVersion(f.projectId, first).id, first)
  let release, started
  const blocked = new Promise((resolve) => {
      release = resolve
    }),
    ready = new Promise((resolve) => {
      started = resolve
    })
  const task = f.store.startSnapshot(
    f.projectId,
    {
      requestId: 'active-source',
      captureId: 'active-capture',
      cacheKey: 'active-cache',
      cachePurpose: 'source',
      source: { repositories: [] },
    },
    async ({ root }) => {
      started()
      await blocked
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'active.txt'), 'accepted task')
    },
    'manager',
  )
  await ready
  assert.deepEqual(f.store.collectUnusedWorkspaceVersions(f.projectId, retention).removed, [])
  release()
  await f.store.whenIdle()
  f.store.releaseVersion(f.projectId, `task:${task.id}`)
  assert.ok(f.store.collectUnusedWorkspaceVersions(f.projectId, retention).removed.includes(first))
})

test('目录删除失败先留下不可访问收据，重开后重试原目录，不复活旧输入', async (t) => {
  const f = await fixture(t),
    first = await f.snapshot('待回收原件'),
    second = await f.snapshot('有效当前')
  const directory = join(f.directory, 'project-workspaces', f.projectId, 'versions', first)
  assert.equal(existsSync(directory), true)
  const original = fs.rmSync
  fs.rmSync = (path, options) => {
    if (String(path) === directory)
      throw Object.assign(new Error('隔离模拟磁盘忙'), { code: 'EBUSY' })
    return original(path, options)
  }
  syncBuiltinESMExports()
  try {
    const result = f.store.collectUnusedWorkspaceVersions(f.projectId, {
      current: [{ sourceId: 'repository-a', versionId: second }],
      versions: [],
    })
    assert.deepEqual(result, { removed: [first], pending: [first] })
    assert.throws(() => f.store.getVersion(f.projectId, first), { status: 404 })
    assert.equal(
      f.store
        .deletionReferences(f.projectId)
        .some((value) => value.kind === 'workspace-retired-inputs'),
      true,
    )
  } finally {
    fs.rmSync = original
    syncBuiltinESMExports()
  }
  await f.store.close()
  const reopened = createWorkspaceStore({ dataDir: f.directory })
  try {
    assert.deepEqual(
      reopened.collectUnusedWorkspaceVersions(f.projectId, {
        current: [{ sourceId: 'repository-a', versionId: second }],
        versions: [],
      }),
      { removed: [], pending: [] },
    )
    assert.equal(existsSync(directory), false)
    assert.throws(() => reopened.verifyInputVersion(f.projectId, first), { status: 404 })
    assert.equal(reopened.verifyInputVersion(f.projectId, second).id, second)
  } finally {
    await reopened.close()
  }
})
