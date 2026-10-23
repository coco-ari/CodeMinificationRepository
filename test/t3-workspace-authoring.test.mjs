import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, rename, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createWorkspaceAuthoring } from '../agent-demo/t3-adapters/workspace-authoring/index.ts'
import {
  extractBusinessAttachment,
  renderBusinessPdf,
} from '../agent-demo/t3-adapters/business-documents.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const request = (expectedRevision) => ({ expectedRevision, requestId: randomUUID() })
const source = (mountPath = 'frontend') => ({
  name: mountPath,
  role: 'frontend',
  url: 'https://github.com/example/project.git',
  refKind: 'default',
  ref: '',
  mountPath,
})
async function fixture(t, projects = ['project']) {
  const dataDir = await mkdtemp(join(tmpdir(), 'autoops-authoring-'))
  const allowed = new Set(['owner', 'reader'])
  const authorize = (actor, project, action) => {
    if (
      !allowed.has(actor) ||
      !projects.includes(project) ||
      (action === 'manage' && actor !== 'owner')
    )
      throw Object.assign(new Error('无权访问'), { status: 403 })
  }
  let service = createWorkspaceAuthoring({ dataDir, authorize })
  t.after(async () => {
    await service.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return {
    dataDir,
    allowed,
    get service() {
      return service
    },
    async reopen() {
      await service.close()
      service = createWorkspaceAuthoring({ dataDir, authorize })
      return service
    },
  }
}
const current = (service) => service.overview('project', 'owner')
const mutation = (service) => request(current(service).revision)
async function upload(service, path, contents, conflict = 'replace') {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
  const input = { ...mutation(service), path, size: bytes.length, sha256: sha(bytes), conflict }
  return { input, bytes, result: await service.upload('project', input, bytes, 'owner') }
}
function rejectsCode(callback, code) {
  assert.throws(callback, (error) => error.code === code)
}

test('来源定义持久化、多来源路径互斥和配置修订防止覆盖', async (t) => {
  const f = await fixture(t),
    service = f.service
  const input = { ...request(0), ...source() }
  const first = service.saveSource('project', input, 'owner')
  assert.equal(first.revision, 1)
  assert.equal(first.source.refKind, 'default')
  assert.equal(first.source.ref, '')
  assert.deepEqual(service.saveSource('project', input, 'owner'), first)
  rejectsCode(
    () => service.saveSource('project', { ...input, name: '另一个输入' }, 'owner'),
    'WORKSPACE_REQUEST_CONFLICT',
  )
  rejectsCode(
    () => service.saveSource('project', { ...request(0), ...source('backend') }, 'owner'),
    'WORKSPACE_REVISION_CONFLICT',
  )
  rejectsCode(
    () =>
      service.saveSource(
        'project',
        { ...mutation(service), ...source('frontend/nested') },
        'owner',
      ),
    'WORKSPACE_MOUNT_CONFLICT',
  )
  rejectsCode(
    () =>
      service.saveSource('project', { ...mutation(service), ...source('docs/product') }, 'owner'),
    'WORKSPACE_MOUNT_CONFLICT',
  )
  rejectsCode(
    () =>
      service.saveSource(
        'project',
        { ...mutation(service), ...source('other'), url: 'https://user:secret@github.com/a/b.git' },
        'owner',
      ),
    'WORKSPACE_SOURCE_INVALID',
  )
  const backend = service.saveSource(
    'project',
    {
      ...mutation(service),
      ...source('backend'),
      role: 'backend',
      refKind: 'tag',
      ref: 'v1.0.0',
      sourcePath: 'apps/api',
      credentialId: 'credential-one',
    },
    'owner',
  )
  assert.equal(backend.source.sourcePath, 'apps/api')
  await f.reopen()
  assert.equal(current(f.service).sources.length, 2)
  assert.equal(current(f.service).revision, 2)
})

test('上传真实原件、同名策略、摘要和幂等收据不覆盖并发变更', async (t) => {
  const { service } = await fixture(t)
  const first = await upload(service, 'docs/产品资料/需求.md', '# 原始需求')
  assert.equal(
    service.readFile('project', first.input.path, 'reader').bytes.toString(),
    '# 原始需求',
  )
  assert.equal(service.readContent('project', first.input.path, 'reader').contents, '# 原始需求')
  assert.equal(service.readFile('project', first.input.path, 'reader').mime, 'text/markdown')
  const both = await upload(service, first.input.path, '# 第二份', 'keep-both')
  assert.equal(both.result.entry.path, 'docs/产品资料/需求 (2).md')
  const beforeSkip = current(service).revision
  const skipped = await upload(service, first.input.path, '不会写入', 'skip')
  assert.equal(skipped.result.skipped, true)
  assert.equal(current(service).revision, beforeSkip)
  assert.deepEqual(await service.upload('project', first.input, first.bytes, 'owner'), first.result)
  assert.deepEqual(service.receipt('project', first.input.requestId, 'owner'), first.result)
  assert.equal(service.receipt('project', randomUUID(), 'owner'), null)
  await assert.rejects(
    service.upload(
      'project',
      { ...first.input, sha256: sha(Buffer.from('变更')), size: 6 },
      Buffer.from('变更'),
      'owner',
    ),
    { code: 'WORKSPACE_REQUEST_CONFLICT' },
  )
  await assert.rejects(
    service.upload(
      'project',
      {
        ...mutation(service),
        path: 'docs/x.txt',
        size: 1,
        sha256: '0'.repeat(64),
        conflict: 'replace',
      },
      Buffer.from('x'),
      'owner',
    ),
    { code: 'WORKSPACE_UPLOAD_CHECKSUM' },
  )
  await assert.rejects(
    service.upload(
      'project',
      {
        ...mutation(service),
        path: 'docs/x.txt',
        size: 2,
        sha256: sha(Buffer.from('x')),
        conflict: 'replace',
      },
      Buffer.from('x'),
      'owner',
    ),
    { code: 'WORKSPACE_UPLOAD_SIZE' },
  )
  assert.equal(
    service.readFile('project', first.input.path, 'owner').bytes.toString(),
    '# 原始需求',
  )
})

test('捕获保护原件与空目录，替换删除清理和重启后仍读原内容', async (t) => {
  const f = await fixture(t),
    service = f.service
  await upload(service, 'docs/运维文档/运行.txt', '旧运行手册')
  service.createDirectory('project', { ...mutation(service), path: 'docs/空目录' }, 'owner')
  const captureRequest = randomUUID(),
    captured = service.capture('project', current(service).revision, 'owner', captureRequest)
  assert.equal(captured.resolution, 'resolved')
  assert.deepEqual(captured.resolvedRepositories, [])
  assert(captured.directories.includes('docs/空目录'))
  const updated = await upload(service, 'docs/运维文档/运行.txt', '新运行手册')
  service.remove(
    'project',
    {
      ...mutation(service),
      path: updated.input.path,
      expectedContentRevision: updated.result.entry.revision,
    },
    'owner',
  )
  service.collectUnused('project', 'owner')
  assert.equal(
    service.readCapturedFile('project', captured.id, updated.input.path, 'owner').bytes.toString(),
    '旧运行手册',
  )
  assert.deepEqual(service.capture('project', captured.revision, 'owner', captureRequest), captured)
  await f.reopen()
  assert.equal(
    f.service
      .readCapturedFile('project', captured.id, updated.input.path, 'owner')
      .bytes.toString(),
    '旧运行手册',
  )
  assert.equal(f.service.captureByRequest('project', captureRequest, 'owner').id, captured.id)
  f.service.releaseCapture('project', captured.id, 'owner')
  assert.equal(f.service.collectUnused('project', 'owner').removed, 0)
  assert.deepEqual(await readdir(join(f.dataDir, 'workspace-authoring', 'originals')), [])
  rejectsCode(
    () => f.service.readCapturedFile('project', captured.id, updated.input.path, 'owner'),
    'WORKSPACE_CAPTURE_RELEASED',
  )
  assert.equal(f.service.captureByRequest('project', captureRequest, 'owner').status, 'released')
})

test('仓库解析与凭证版本一次冻结，同标识不重新选分支', async (t) => {
  const f = await fixture(t),
    service = f.service
  const created = service.saveSource(
    'project',
    { ...request(0), ...source(), credentialId: 'private-token' },
    'owner',
  )
  const captured = service.capture('project', current(service).revision, 'owner', randomUUID())
  const resolved = [
    {
      sourceId: created.source.id,
      commit: 'a'.repeat(40),
      refKind: 'default',
      ref: 'main',
      defaultRef: 'main',
      credentialVersion: { projectId: 'project', credentialId: 'private-token', version: 2 },
    },
  ]
  assert.equal(
    service.freezeCaptureRepositories('project', captured.id, resolved, 'owner').resolution,
    'resolved',
  )
  assert.equal(
    service.freezeCaptureRepositories('project', captured.id, resolved, 'owner')
      .resolvedRepositories[0].credentialVersion.version,
    2,
  )
  rejectsCode(
    () =>
      service.freezeCaptureRepositories(
        'project',
        captured.id,
        [{ ...resolved[0], commit: 'b'.repeat(40) }],
        'owner',
      ),
    'WORKSPACE_REQUEST_CONFLICT',
  )
  await f.reopen()
  assert.equal(
    f.service.readCaptured('project', captured.id, 'owner').resolvedRepositories[0].commit,
    'a'.repeat(40),
  )
  const failed = f.service.capture('project', current(f.service).revision, 'owner', randomUUID())
  f.service.failCaptureResolution(
    'project',
    failed.id,
    { code: 'GIT_UNAVAILABLE', message: 'https://user:secret@example.test' },
    'owner',
  )
  assert(!JSON.stringify(f.service.readCaptured('project', failed.id, 'owner')).includes('secret'))
  rejectsCode(
    () => f.service.freezeCaptureRepositories('project', failed.id, resolved, 'owner'),
    'WORKSPACE_CAPTURE_STATE',
  )
})

test('目录移动删除和仅文件名搜索，Git挂载和路径穿越拒绝写入', async (t) => {
  const { service } = await fixture(t)
  service.saveSource('project', { ...request(0), ...source('repo') }, 'owner')
  await assert.rejects(upload(service, 'repo/config.txt', '拒绝'), {
    code: 'WORKSPACE_GIT_READ_ONLY',
  })
  await assert.rejects(upload(service, '../outside.txt', '拒绝'), {
    code: 'WORKSPACE_PATH_INVALID',
  })
  await assert.rejects(upload(service, 'docs/.git/config', '拒绝'), {
    code: 'WORKSPACE_PATH_INVALID',
  })
  const original = await upload(service, 'docs/产品资料/内容.txt', '资料正文')
  assert.equal(
    service.search('project', '产品资料', 'owner').entries.some((entry) => entry.kind === 'file'),
    false,
  )
  assert.equal(service.search('project', '内容', 'owner').entries.length, 1)
  const directory = current(service).entries.find((entry) => entry.path === 'docs/产品资料')
  const moved = service.move(
    'project',
    {
      ...mutation(service),
      path: directory.path,
      destination: 'docs/交付资料',
      expectedContentRevision: directory.revision,
    },
    'owner',
  )
  assert.equal(
    service.readFile('project', 'docs/交付资料/内容.txt', 'owner').bytes.toString(),
    '资料正文',
  )
  assert.equal(service.tree('project', 'docs/交付资料', 'owner').entries[0].name, '内容.txt')
  rejectsCode(
    () => service.readFile('project', original.input.path, 'owner'),
    'WORKSPACE_MATERIAL_NOT_FOUND',
  )
  service.remove(
    'project',
    { ...mutation(service), path: moved.entry.path, expectedContentRevision: moved.entry.revision },
    'owner',
  )
  assert.equal(
    current(service).entries.some((entry) => entry.path.includes('内容.txt')),
    false,
  )
})

test('文本保存检查文件修订，二进制原件不因伪MIME成为可编辑正文', async (t) => {
  const { service } = await fixture(t)
  const created = await upload(service, 'docs/编辑.md', '第一版')
  const input = {
    ...mutation(service),
    path: created.input.path,
    expectedContentRevision: created.result.entry.revision,
    contents: '第二版',
  }
  const saved = service.saveText('project', input, 'owner')
  assert.equal(service.readContent('project', input.path, 'owner').contents, '第二版')
  assert.deepEqual(service.saveText('project', input, 'owner'), saved)
  rejectsCode(
    () =>
      service.saveText(
        'project',
        { ...input, ...mutation(service), contents: '覆盖新版本' },
        'owner',
      ),
    'WORKSPACE_CONTENT_CONFLICT',
  )
  rejectsCode(
    () =>
      service.saveText(
        'project',
        { ...input, ...mutation(service), path: 'docs/code.js' },
        'owner',
      ),
    'WORKSPACE_EDIT_UNSUPPORTED',
  )
  const malformed = await upload(service, 'docs/损坏.pdf', Buffer.from('%PDF-invalid\0\xff'))
  const stored = service.readFile('project', malformed.input.path, 'owner')
  assert.equal(stored.mime, 'application/pdf')
  assert.equal(stored.editable, false)
  assert.equal(
    service.readContent('project', malformed.input.path, 'owner').extraction.status,
    'unavailable',
  )
  assert.deepEqual(stored.bytes, malformed.bytes)
})

test('真实PDF提取与原件摘要关联，关闭排空后重启仍可读取正文', async (t) => {
  const f = await fixture(t),
    service = f.service
  const pdf = await renderBusinessPdf('工作区资料验收\n唯一测试内容：运行手册。')
  const input = {
    ...request(0),
    path: 'docs/运行手册.pdf',
    size: pdf.length,
    sha256: sha(pdf),
    conflict: 'replace',
  }
  const pending = service.upload('project', input, pdf, 'owner')
  const closing = service.close()
  await pending
  await closing
  await f.reopen()
  const content = f.service.readContent('project', input.path, 'owner')
  assert.equal(content.extraction.status, 'ready')
  assert.match(content.contents, /唯一测试内容/)
  assert.equal(content.extraction.contentHash, sha(pdf))
  assert.equal(f.service.readFile('project', input.path, 'owner').sha256, sha(pdf))
})

test('每个业务入口重查授权，撤权后的旧幂等请求不能返回资料', async (t) => {
  const f = await fixture(t),
    service = f.service
  const file = await upload(service, 'docs/私有.txt', '内部资料')
  const captured = service.capture('project', current(service).revision, 'owner', randomUUID())
  assert.throws(() => service.overview('other-project', 'owner'), { status: 403 })
  assert.throws(
    () => service.createDirectory('project', { ...mutation(service), path: 'new' }, 'reader'),
    { status: 403 },
  )
  f.allowed.delete('owner')
  for (const operation of [
    () => service.overview('project', 'owner'),
    () => service.readFile('project', file.input.path, 'owner'),
    () => service.readContent('project', file.input.path, 'owner'),
    () => service.tree('project', '', 'owner'),
    () => service.search('project', '', 'owner'),
    () => service.receipt('project', file.input.requestId, 'owner'),
    () => service.captureByRequest('project', captured.requestId, 'owner'),
    () => service.readCaptured('project', captured.id, 'owner'),
    () => service.readCapturedFile('project', captured.id, file.input.path, 'owner'),
    () => service.releaseCapture('project', captured.id, 'owner'),
  ])
    assert.throws(operation, { status: 403 })
  await assert.rejects(service.upload('project', file.input, file.bytes, 'owner'), { status: 403 })
})

test('停止接单保留读取，重复关闭幂等，错误升级记录拒绝打开而不清空资料', async (t) => {
  const f = await fixture(t),
    service = f.service
  const file = await upload(service, 'docs/保留.txt', '保留内容')
  service.stopAccepting()
  assert.equal(service.readFile('project', file.input.path, 'owner').bytes.toString(), '保留内容')
  rejectsCode(
    () => service.createDirectory('project', { ...request(1), path: 'docs/new' }, 'owner'),
    'WORKSPACE_AUTHORING_STOPPING',
  )
  const one = service.close(),
    two = service.close()
  assert.equal(one, two)
  await one
  rejectsCode(() => service.overview('project', 'owner'), 'WORKSPACE_AUTHORING_STOPPING')
  const dbPath = join(f.dataDir, 'workspace-authoring', 'state.sqlite')
  const db = new DatabaseSync(dbPath)
  db.prepare("UPDATE schema_migrations SET checksum='incorrect'").run()
  db.close()
  assert.throws(
    () => createWorkspaceAuthoring({ dataDir: f.dataDir, authorize: () => true }),
    /升级版本未知或已应用升级被修改/,
  )
  assert.equal(
    (
      await readFile(join(f.dataDir, 'workspace-authoring', 'originals', file.result.entry.sha256))
    ).toString(),
    '保留内容',
  )
})

test('文本保存不能省略内容修订条件，超提取预算保留原件并明确不可读', async (t) => {
  const { service } = await fixture(t)
  const first = await upload(service, 'docs/长文本.md', '# 原始文本')
  rejectsCode(
    () =>
      service.saveText(
        'project',
        { ...mutation(service), path: first.input.path, contents: '拒绝无条件覆盖' },
        'owner',
      ),
    'WORKSPACE_CONTENT_REVISION_REQUIRED',
  )
  const long = '字'.repeat(500_001)
  const result = service.saveText(
    'project',
    {
      ...mutation(service),
      path: first.input.path,
      expectedContentRevision: first.result.entry.revision,
      contents: long,
    },
    'owner',
  )
  assert.equal(service.readFile('project', first.input.path, 'owner').bytes.toString(), long)
  const content = service.readContent('project', first.input.path, 'owner')
  assert.equal(content.revision, result.entry.revision)
  assert.equal(content.extraction.status, 'unavailable')
  assert.equal(content.extraction.code, 'TEXT_CHARACTER_LIMIT')
  assert.equal(content.contents, undefined)
})

test('完整提交冻结不能替换配置指定提交，分支解析不能冒充其他分支', async (t) => {
  const { service } = await fixture(t)
  const fixed = service.saveSource(
    'project',
    { ...mutation(service), ...source(), refKind: 'commit', ref: 'a'.repeat(40) },
    'owner',
  ).source
  const capture = service.capture('project', current(service).revision, 'owner', randomUUID())
  rejectsCode(
    () =>
      service.freezeCaptureRepositories(
        'project',
        capture.id,
        [
          {
            sourceId: fixed.id,
            commit: 'b'.repeat(40),
            refKind: 'commit',
            ref: fixed.ref,
            defaultRef: null,
          },
        ],
        'owner',
      ),
    'WORKSPACE_CAPTURE_RESOLUTION',
  )
  service.releaseCapture('project', capture.id, 'owner')
  service.saveSource(
    'project',
    { ...fixed, ...mutation(service), refKind: 'branch', ref: 'release' },
    'owner',
  )
  const branch = service.capture('project', current(service).revision, 'owner', randomUUID())
  rejectsCode(
    () =>
      service.freezeCaptureRepositories(
        'project',
        branch.id,
        [
          {
            sourceId: fixed.id,
            commit: 'a'.repeat(40),
            refKind: 'branch',
            ref: 'main',
            defaultRef: null,
          },
        ],
        'owner',
      ),
    'WORKSPACE_CAPTURE_RESOLUTION',
  )
})

test('总量预算按逻辑文件累计，失败上传回滚原件与目录且不留下未知成功收据', async (t) => {
  const { service, dataDir } = await fixture(t)
  const bytes = Buffer.alloc(8 * 1024 * 1024)
  for (let index = 0; index < 8; index++) await upload(service, `docs/容量-${index}.bin`, bytes)
  const before = current(service)
  const tooMuch = Buffer.alloc(bytes.length, 1)
  const input = {
    ...mutation(service),
    path: 'docs/新增目录/超限.bin',
    size: tooMuch.length,
    sha256: sha(tooMuch),
    conflict: 'replace',
  }
  await assert.rejects(service.upload('project', input, tooMuch, 'owner'), {
    code: 'WORKSPACE_MATERIAL_LIMIT',
  })
  assert.deepEqual(current(service), before)
  assert.equal(service.receipt('project', input.requestId, 'owner'), null)
  assert.deepEqual(await readdir(join(dataDir, 'workspace-authoring', 'originals')), [sha(bytes)])
  await assert.rejects(upload(service, 'docs/单件超限.bin', Buffer.alloc(8 * 1024 * 1024 + 1)), {
    code: 'WORKSPACE_UPLOAD_SIZE',
  })
})

test('实际Word原件复用文档提取并绑定摘要，声明文件类型不能伪造正文', async (t) => {
  const { service } = await fixture(t)
  const bytes = await readFile(
    new URL('./t3-business-documents-fixtures/release.docx', import.meta.url),
  )
  const result = await upload(service, 'docs/发布检查.docx', bytes)
  const content = service.readContent('project', result.input.path, 'owner')
  assert.equal(content.extraction.status, 'ready')
  assert.equal(content.extraction.contentHash, sha(bytes))
  assert.match(content.contents, /发布检查文档/)
  assert.equal(service.readFile('project', result.input.path, 'owner').editable, false)
})

test('资料写入与版本捕获共享请求冲突边界，原标识不能变成第二种业务操作', async (t) => {
  const { service } = await fixture(t)
  const first = await upload(service, 'docs/原请求.txt', '原始写入')
  rejectsCode(
    () => service.capture('project', current(service).revision, 'owner', first.input.requestId),
    'WORKSPACE_REQUEST_CONFLICT',
  )
  const requestId = randomUUID(),
    revision = current(service).revision
  const captured = service.capture('project', revision, 'owner', requestId)
  rejectsCode(
    () =>
      service.createDirectory(
        'project',
        { requestId, expectedRevision: revision, path: 'docs/不应新增' },
        'owner',
      ),
    'WORKSPACE_REQUEST_CONFLICT',
  )
  assert.equal(current(service).revision, revision)
  assert.deepEqual(service.receipt('project', first.input.requestId, 'owner'), first.result)
  assert.equal(service.captureByRequest('project', requestId, 'owner').id, captured.id)
})

test('反复替换自动回收旧原件与提取正文，同内容跨项目引用独立保护', async (t) => {
  const f = await fixture(t, ['project', 'other-project']),
    service = f.service
  const first = await upload(service, 'docs/日常编辑.txt', '共享原件')
  await service.upload('other-project', { ...first.input, ...request(0) }, first.bytes, 'owner')
  for (let index = 0; index < 12; index++)
    await upload(service, first.input.path, `日常编辑第${index}版`)
  const latest = service.readFile('project', first.input.path, 'owner')
  const originals = join(f.dataDir, 'workspace-authoring', 'originals')
  assert.deepEqual((await readdir(originals)).sort(), [sha(first.bytes), latest.sha256].sort())
  assert.equal(
    service.readFile('other-project', first.input.path, 'owner').bytes.toString(),
    '共享原件',
  )
  const shared = service.readFile('other-project', first.input.path, 'owner')
  service.remove(
    'other-project',
    { ...request(1), path: shared.path, expectedContentRevision: shared.revision },
    'owner',
  )
  assert.deepEqual(await readdir(originals), [latest.sha256])
  const db = new DatabaseSync(join(f.dataDir, 'workspace-authoring', 'state.sqlite'))
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM authoring_extractions').get().n, 1)
  } finally {
    db.close()
  }
  assert.deepEqual(service.receipt('project', first.input.requestId, 'owner'), first.result)
})

test('自动回收保护正在提取的原件，解析排空与关闭后才删除失效引用', async (t) => {
  const f = await fixture(t),
    service = f.service
  const bytes = await renderBusinessPdf('# 在途原件保护\n\n仍在提取的原件不能先删除。')
  const input = {
    ...request(0),
    path: 'docs/在途.pdf',
    size: bytes.length,
    sha256: sha(bytes),
    conflict: 'replace',
  }
  const pending = service.upload('project', input, bytes, 'owner')
  const file = service.readFile('project', input.path, 'owner')
  service.remove(
    'project',
    { ...mutation(service), path: file.path, expectedContentRevision: file.revision },
    'owner',
  )
  assert.deepEqual(await readdir(join(f.dataDir, 'workspace-authoring', 'originals')), [sha(bytes)])
  const closing = service.close()
  await pending
  await closing
  assert.deepEqual(await readdir(join(f.dataDir, 'workspace-authoring', 'originals')), [])
})

test('清理SQL失败不破坏已成功替换的收据，后续成功修改会回收残留', async (t) => {
  const f = await fixture(t),
    service = f.service
  const first = await upload(service, 'docs/清理失败.txt', '旧内容')
  const db = new DatabaseSync(join(f.dataDir, 'workspace-authoring', 'state.sqlite'))
  t.after(() => db.close())
  db.exec(
    "CREATE TRIGGER fixture_gc_failure BEFORE DELETE ON authoring_blobs BEGIN SELECT RAISE(ABORT, '模拟清理失败'); END",
  )
  const next = await upload(service, first.input.path, '已成功的新内容')
  assert.deepEqual(service.receipt('project', next.input.requestId, 'owner'), next.result)
  assert.equal(
    service.readFile('project', first.input.path, 'owner').bytes.toString(),
    '已成功的新内容',
  )
  assert.deepEqual(
    (await readdir(join(f.dataDir, 'workspace-authoring', 'originals'))).sort(),
    [sha(first.bytes), sha(next.bytes)].sort(),
  )
  db.exec('DROP TRIGGER fixture_gc_failure')
  service.createDirectory('project', { ...mutation(service), path: 'docs/触发后续维护' }, 'owner')
  assert.deepEqual(await readdir(join(f.dataDir, 'workspace-authoring', 'originals')), [
    sha(next.bytes),
  ])
})

test('清理文件失败在元数据提交后留下可重试孤件，重启维护不改动新原件和收据', async (t) => {
  const f = await fixture(t),
    service = f.service
  const first = await upload(service, 'docs/清理文件.txt', '旧文件')
  const originals = join(f.dataDir, 'workspace-authoring', 'originals'),
    blocked = join(originals, sha(first.bytes))
  await rename(blocked, join(f.dataDir, 'fixture-old-original'))
  await mkdir(blocked)
  await writeFile(join(blocked, 'fixture-blocker'), '模拟无法按普通文件删除')
  const next = await upload(service, first.input.path, '新文件')
  assert.deepEqual(service.receipt('project', next.input.requestId, 'owner'), next.result)
  assert.equal(service.readFile('project', first.input.path, 'owner').bytes.toString(), '新文件')
  const db = new DatabaseSync(join(f.dataDir, 'workspace-authoring', 'state.sqlite'))
  try {
    assert.equal(
      db.prepare('SELECT 1 FROM authoring_blobs WHERE hash=?').get(sha(first.bytes)),
      undefined,
    )
  } finally {
    db.close()
  }
  await service.close()
  await rm(blocked, { recursive: true })
  await rename(join(f.dataDir, 'fixture-old-original'), blocked)
  await f.reopen()
  assert.deepEqual(await readdir(originals), [sha(next.bytes)])
  assert.deepEqual(f.service.receipt('project', next.input.requestId, 'owner'), next.result)
})

test('失败提取使用原件修订与原请求收据恢复，同ID不重复解析，明确新请求才重试', async (t) => {
  const f = await fixture(t),
    service = f.service
  const bytes = await renderBusinessPdf('# 明确重试\n\n原件仍然可用。')
  const attachment = { id: 'busy-fixture', name: '占用.pdf', mime: 'application/pdf', bytes }
  const held = [extractBusinessAttachment(attachment), extractBusinessAttachment(attachment)]
  let uploaded
  try {
    uploaded = await upload(service, 'docs/重新提取.pdf', bytes)
  } finally {
    await Promise.allSettled(held)
  }
  assert.equal(
    service.readContent('project', uploaded.input.path, 'owner').extraction.code,
    'DOCUMENT_BUSY',
  )
  const input = {
    ...mutation(service),
    path: uploaded.input.path,
    expectedContentRevision: uploaded.result.entry.revision,
  }
  await assert.rejects(
    service.retryExtraction('project', { ...input, expectedContentRevision: 'stale' }, 'owner'),
    { code: 'WORKSPACE_CONTENT_CONFLICT' },
  )
  const result = await service.retryExtraction('project', input, 'owner')
  assert.equal(result.revision, input.expectedRevision)
  assert.equal(result.entry.extraction.status, 'pending')
  assert.equal(service.readContent('project', input.path, 'owner').extraction.status, 'ready')
  assert.match(service.readContent('project', input.path, 'owner').contents, /原件仍然可用/)
  const db = new DatabaseSync(join(f.dataDir, 'workspace-authoring', 'state.sqlite'))
  try {
    db.exec(
      "CREATE TRIGGER fixture_retry_failure BEFORE UPDATE ON authoring_extractions BEGIN SELECT RAISE(ABORT, '不允许重复解析'); END",
    )
    assert.deepEqual(await service.retryExtraction('project', input, 'owner'), result)
  } finally {
    db.exec('DROP TRIGGER fixture_retry_failure')
    db.close()
  }
  assert.deepEqual(service.receipt('project', input.requestId, 'owner'), result)
  await assert.rejects(
    service.retryExtraction('project', { ...input, ...mutation(service) }, 'owner'),
    { code: 'WORKSPACE_EXTRACTION_STATE' },
  )
  const malformed = await upload(service, 'docs/仍然损坏.pdf', Buffer.from('%PDF-invalid\0'))
  const failedInput = {
    ...mutation(service),
    path: malformed.input.path,
    expectedContentRevision: malformed.result.entry.revision,
  }
  const failed = await service.retryExtraction('project', failedInput, 'owner')
  assert.equal(
    service.readContent('project', malformed.input.path, 'owner').extraction.status,
    'unavailable',
  )
  assert.deepEqual(await service.retryExtraction('project', failedInput, 'owner'), failed)
  const next = await service.retryExtraction(
    'project',
    { ...failedInput, ...mutation(service) },
    'owner',
  )
  assert.notEqual(next.requestId, failed.requestId)
  assert.equal(
    service.readContent('project', malformed.input.path, 'owner').extraction.status,
    'unavailable',
  )
})
