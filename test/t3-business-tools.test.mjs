import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projects, agents } from '../agent-demo/fixtures.mjs'
import { createAutoOpsBusinessTools, createBusinessArtifactStore } from '../agent-demo/t3-adapters/business-tools.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'autoops-t3-business-'))
  const artifacts = createBusinessArtifactStore(root)
  t.after(async () => { artifacts.close(); await rm(root, { recursive: true, force: true }) })
  const binding = { threadId: 'thread-1', projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', ownerId: 'u-admin', visibility: 'private' }
  let allowed = true
  let byteReads = 0
  const tools = createAutoOpsBusinessTools({
    authorizeThread: (threadId) => {
      if (!allowed || threadId !== binding.threadId) throw Object.assign(new Error('会话已无权访问'), { code: 'FORBIDDEN' })
      return { binding, project: projects[0], agent: agents[0] }
    },
    loadAttachments: () => [{ id: 'present-file', name: '证据.txt', mime: 'text/plain', sourceUrl: '/authorized-resource' }],
    loadAttachmentBytes: () => { byteReads++; return Buffer.from('真实文件证据', 'utf8') },
    storeArtifact: (input) => artifacts.create(input),
  })
  return { tools, artifacts, binding, revoke: () => { allowed = false }, reads: () => byteReads }
}

test('资料和环境由可信线程绑定决定，跨项目和跨环境输入不扩权', async (t) => {
  const { tools } = await fixture(t)
  const document = await tools.readDocument('thread-1', 'doc-design')
  assert.match(document.content, /项目/)
  assert.match(document.sourceUrl, /p-autoops\/documents\/doc-design$/)
  await assert.rejects(tools.readDocument('thread-1', 'doc-cabinet'), { code: 'DOCUMENT_FORBIDDEN' })
  await assert.rejects(tools.queryEnvironment('thread-1', 'env-prod'), { code: 'ENVIRONMENT_FORBIDDEN' })
  const environment = await tools.queryEnvironment('thread-1', 'env-test')
  assert.match(environment.notice, /不是生产环境/)
  assert.equal(environment.resourceSnapshot.diskPercent, undefined)
})

test('历史范围外附件拒绝读取，列目录不加载文件内容', async (t) => {
  const f = await fixture(t)
  const catalog = await f.tools.listMaterials('thread-1')
  assert.equal(catalog.attachments.length, 1)
  assert.equal(f.reads(), 0)
  await assert.rejects(f.tools.readAttachment('thread-1', 'future-turn-file'), { code: 'ATTACHMENT_FORBIDDEN' })
  assert.equal(f.reads(), 0)
  const read = await f.tools.readAttachment('thread-1', 'present-file')
  assert.equal(read.content, '真实文件证据')
  assert.equal(f.reads(), 1)
  f.revoke()
  await assert.rejects(f.tools.readAttachment('thread-1', 'present-file'), { code: 'FORBIDDEN' })
  assert.equal(f.reads(), 1)
})

test('报告真实保存、同轮重试幂等、不同轮不覆盖且共享状态来自绑定', async (t) => {
  const f = await fixture(t)
  const input = { name: '检查报告.md', mime: 'text/markdown', content: '# 检查证据\n\n磁盘正常。' }
  const first = await f.tools.createReport('thread-1', 'run-1', input)
  const repeat = await f.tools.createReport('thread-1', 'run-1', input)
  assert.equal(first.id, repeat.id)
  assert.equal(first.published, false)
  assert.equal(Buffer.from(f.artifacts.read(first.id).bytes).toString(), input.content)
  f.binding.visibility = 'project'
  const next = await f.tools.createReport('thread-1', 'run-2', input)
  assert.notEqual(next.id, first.id)
  assert.equal(next.published, true)
  assert.equal(f.artifacts.list('thread-1').length, 2)
  await assert.rejects(f.tools.createReport('thread-1', 'run-3', { ...input, name: '../escape.md' }), { code: 'INVALID_TOOL_INPUT' })
})

test('工作区资料工具只读固定版本，不回退到原始夹具或暴露内部仓库地址', async () => {
  const binding = { threadId: 'external-thread', projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', ownerId: 'u-admin', visibility: 'private', workspaceType: 'external', workspaceVersionId: 'external-v1' }
  const source = { contentHash: 'version-digest', repositories: [{ path: 'backend', commit: 'fixed-commit' }], repositoryHost: 'internal.invalid', branch: 'private-release' }
  const version = { id: 'external-v1', projectId: binding.projectId, type: 'external', source }
  const file = { path: 'docs/需求.md', name: '需求.md', mime: 'text/markdown', size: 40 }
  const tools = createAutoOpsBusinessTools({
    authorizeThread: () => ({ binding, project: projects[0], agent: agents[0] }),
    loadAttachments: () => [],
    storeArtifact: () => { throw new Error('unexpected write') },
    workspaceStore: {
      getVersion(projectId, id) { assert.equal(projectId, 'p-autoops'); assert.equal(id, 'external-v1'); return version },
      files() { return [file] },
      read(projectId, id, path) { assert.equal(path, file.path); return { contents: '已脱敏的需求', byteLength: 100000, truncated: true } },
    },
  })
  const materials = await tools.listMaterials(binding.threadId)
  assert.equal(materials.source, 'workspace_snapshot')
  assert.equal(materials.workspace.root, 'autoops/p-autoops/workspaces/external-v1')
  assert.deepEqual(materials.documents.map(({id}) => id), [file.path])
  assert.ok(!JSON.stringify(materials).includes('internal.invalid'))
  assert.ok(!JSON.stringify(materials).includes('private-release'))
  const result = await tools.readDocument(binding.threadId, file.path)
  assert.equal(result.content, '已脱敏的需求')
  assert.equal(result.truncated, true)
  assert.equal(result.byteLength, 100000)
  assert.equal(result.workspaceVersionId, 'external-v1')
  assert.match(result.sourceUrl, /resources\?path=/)
  assert.equal((await tools.readDocument(binding.threadId, materials.documents[0].path)).content, result.content)
  await assert.rejects(tools.readDocument(binding.threadId, 'doc-design'), { code: 'DOCUMENT_FORBIDDEN' })
  await assert.rejects(tools.readDocument(binding.threadId, 'autoops/p-autoops/workspaces/internal-v1/docs/需求.md'), { code: 'DOCUMENT_FORBIDDEN' })
  const environment = await tools.queryEnvironment(binding.threadId, 'env-test')
  assert.equal(environment.source, 'workspace_snapshot')
  assert.equal(environment.resourceSnapshot, undefined)
  binding.workspaceType = 'internal'
  await assert.rejects(tools.listMaterials(binding.threadId), { code: 'WORKSPACE_FORBIDDEN' })
  delete binding.workspaceVersionId
  await assert.rejects(tools.listMaterials(binding.threadId), { code: 'WORKSPACE_UNAVAILABLE' })
})
