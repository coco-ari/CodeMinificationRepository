import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'
import { createBusinessArtifactStore } from '../agent-demo/t3-adapters/business-tools.mjs'
import { createBusinessResourceCatalog } from '../agent-demo/t3-adapters/resources.mjs'
import { createAutoOpsBusinessTools } from '../agent-demo/t3-adapters/business-tools.mjs'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'

test('业务@目录只接受资源身份，保留版本/目录/环境与共享受众，拒绝任意宿主路径', async () => {
  const directory = mkdtempSync(join(tmpdir(), 't3-resource-'))
  const sessions = new DatabaseSync(':memory:'), bindings = new DatabaseSync(':memory:')
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('resource-test').digest('hex'), 'u-admin', 'csrf', Date.now()+100000)
  const access = createAutoOpsAccess({sessionDb:sessions,bindingDb:bindings}), principal = access.authenticateCookie('demo_session=resource-test')
  for (const [threadId,visibility] of [['private-source','private'],['shared-target','project']]) access.bindThread(principal,{threadId,projectId:'p-autoops',environmentId:'env-test',agentId:'a-project',visibility})
  const store = createBusinessArtifactStore(directory)
  const report = store.create({binding:access.getThreadBinding('private-source'),runId:'run1',name:'私有报告.md',mime:'text/markdown',bytes:Buffer.from('只有我可读')})
  const catalog = createBusinessResourceCatalog({access,bindingDb:bindings,artifactStore:store,attachmentsDir:join(directory,'attachments')})
  const cwd = 'autoops://projects/p-autoops/environments/env-test/threads/shared-target'
  try {
    const listing = catalog.search(principal,{cwd,query:'',limit:100})
    const document = listing.entries.find((entry)=>entry.path.includes('/documents/')&&entry.kind==='file')
    assert.match(document.path,/\/documents\/doc-design\/[a-f0-9]{16}\//)
    assert.ok(!listing.entries.some((entry)=>entry.path.includes('/environments/env-prod/')))
    assert.ok(listing.entries.some((entry)=>entry.kind==='directory'&&entry.path.endsWith('/documents')))
    assert.match((await catalog.read(principal,{cwd,relativePath:document.path})).contents,/工作台/)
    assert.throws(()=>catalog.search(principal,{cwd:'/etc',query:'',limit:100}),/业务资料目录/)
    await assert.rejects(catalog.read(principal,{cwd,relativePath:'../../etc/passwd'}),/资料不存在/)
    await assert.rejects(catalog.read(principal,{cwd,relativePath:document.path.replace(/[a-f0-9]{16}/,'0000000000000000')}),/资料不存在/)
    const reportPath=listing.entries.find(entry=>entry.path.includes(report.id)&&entry.kind==='file').path
    assert.throws(()=>catalog.requireContext('shared-target',{records:[{kind:'mention',path:reportPath}]}),/授权受众/)
    await assert.rejects(catalog.readForThread('shared-target',reportPath),/资料不存在/)
    assert.equal((await catalog.readForThread('private-source',reportPath)).content,'只有我可读')
    assert.throws(()=>catalog.requireContext('shared-target',{records:[{kind:'mention',path:'autoops/p-autoops/environments/env-prod/snapshot.json'}]}),/当前环境/)
    const folder=await catalog.readForThread('shared-target','autoops/p-autoops/documents')
    assert.equal(folder.kind,'directory'); assert.equal(folder.entries.length,2)
    assert.deepEqual((await catalog.metadata(principal,['autoops/p-autoops/documents'])).entries,[{kind:'directory'}])
    assert.throws(()=>catalog.search(principal,{cwd:cwd.replace('p-autoops','p-unknown'),query:'',limit:100}),/项目不存在/)
  } finally {store.close();sessions.close();bindings.close();rmSync(directory,{recursive:true,force:true})}
})

test('工作区@引用、读取和预览锁定版本，外部不混入原始资料、附件或报告', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 't3-workspace-resource-'))
  const sessions = new DatabaseSync(':memory:'), bindings = new DatabaseSync(':memory:')
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('workspace-resource').digest('hex'), 'u-admin', 'csrf', Date.now() + 100000)
  const file = { path: 'docs/需求.md', name: '需求.md', mime: 'text/markdown', size: 100000, sha256: 'content-hash' }
  const versions = [
    { id: 'internal-v1', type: 'internal', status: 'published', content: '原始内部资料' },
    { id: 'external-v1', type: 'external', status: 'published', content: '已经脱敏资料' },
    { id: 'external-v2', type: 'external', status: 'published', content: '下一版脱敏资料' },
    { id: 'external-pending', type: 'external', status: 'pending_review', content: '尚未复核' },
  ]
  const workspaceStore = {
    getVersion(projectId, id) {
      const found = projectId === 'p-autoops' && versions.find((version) => version.id === id && version.status === 'published')
      if (!found) throw new Error('工作区版本不可用')
      return found
    },
    files(projectId, id) { this.getVersion(projectId, id); return [file] },
    read(projectId, id, path) { assert.equal(path, file.path); return { contents: this.getVersion(projectId, id).content, byteLength: file.size, truncated: true } },
    readBytes(projectId, id, path) { assert.equal(path, file.path); return Buffer.from(this.getVersion(projectId, id).content + ':完整文件') },
  }
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, workspaceStore })
  const principal = access.authenticateCookie('demo_session=workspace-resource')
  const shared = { projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'project' }
  for (const [threadId, workspaceType, workspaceVersionId] of [['internal', 'internal', 'internal-v1'], ['external', 'external', 'external-v1'], ['next-external', 'external', 'external-v2']])
    access.bindThread(principal, { ...shared, threadId, workspaceType, workspaceVersionId })
  const artifacts = createBusinessArtifactStore(directory)
  t.after(() => { artifacts.close(); sessions.close(); bindings.close(); rmSync(directory, { recursive: true, force: true }) })
  const internalReport = artifacts.create({ binding: access.getThreadBinding('internal'), runId: 'r1', name: '内部报告.md', mime: 'text/markdown', bytes: Buffer.from('原始报告') })
  const externalReport = artifacts.create({ binding: access.getThreadBinding('external'), runId: 'r2', name: '脱敏报告.md', mime: 'text/markdown', bytes: Buffer.from('外部报告') })
  access.recordThreadAttachment(principal, 'internal-attachment', 'internal', { name: '内部附件.txt', mimeType: 'text/plain', sizeBytes: 10 })
  const catalog = createBusinessResourceCatalog({ access, bindingDb: bindings, artifactStore: artifacts, attachmentsDir: join(directory, 'attachments'), workspaceStore })
  const cwd = 'autoops://projects/p-autoops/environments/env-test/threads/external'
  const externalPath = 'autoops/p-autoops/workspaces/external-v1/docs/需求.md'
  const internalPath = externalPath.replace('external-v1', 'internal-v1')
  const listing = catalog.search(principal, { cwd, query: '', limit: 100 })
  assert.ok(listing.entries.some(({path}) => path === externalPath))
  assert.ok(!listing.entries.some(({path}) => path.includes('/documents/') || path.includes('/environments/') || path.includes('internal-v1') || path.includes(internalReport.id) || path.includes('internal-attachment')))
  assert.ok(listing.entries.some(({path}) => path.includes(externalReport.id)))
  const read = await catalog.read(principal, { cwd, relativePath: externalPath })
  assert.equal(read.contents, '已经脱敏资料'); assert.equal(read.byteLength, file.size); assert.equal(read.truncated, true)
  assert.equal((await catalog.readForThread('external', externalPath)).content, read.contents)
  assert.equal((await catalog.readForThread('external', externalPath)).truncated, true)
  await assert.rejects(catalog.read(principal, { cwd, relativePath: internalPath }), /资料不存在/)
  await assert.rejects(catalog.readForThread('external', internalPath), /资料不存在/)
  await assert.rejects(catalog.readForThread('external', externalPath.replace('external-v1', 'external-v2')), /资料不存在/)
  assert.throws(() => catalog.requireContext('external', { records: [{ kind: 'mention', path: internalPath }] }), /授权受众/)
  catalog.requireContext('external', { records: [{ kind: 'mention', path: externalPath }] })
  const metadata = await catalog.metadata(principal, [externalPath, 'autoops/p-autoops/workspaces/external-v1/docs'])
  assert.deepEqual(metadata.entries, [{ kind: 'file', byteLength: file.size, mimeType: file.mime }, { kind: 'directory' }])
  assert.equal(Buffer.from((await catalog.resource(principal, externalPath)).bytes).toString(), '已经脱敏资料:完整文件')
  const externalReportPath = listing.entries.find(({path}) => path.includes(externalReport.id) && path.endsWith('.md')).path
  assert.equal(Buffer.from((await catalog.resource(principal, externalReportPath)).bytes).toString(), '外部报告')
  const draft = 'autoops://projects/p-autoops/environments/env-test/threads/new-draft'
  assert.throws(() => catalog.search(principal, { cwd: draft, query: '', limit: 100 }), { code: 'WORKSPACE_REQUIRED' })
  assert.ok(catalog.search(principal, { cwd: draft + '?workspaceType=external&workspaceVersionId=external-v1', query: '', limit: 100 }).entries.some(({path}) => path === externalPath))
  for (const query of ['workspaceType=internal&workspaceVersionId=external-v1', 'workspaceType=external&workspaceVersionId=external-pending', 'workspaceType=external&workspaceVersionId=missing', 'workspaceType=external'])
    assert.throws(() => catalog.search(principal, { cwd: draft + '?' + query, query: '', limit: 100 }))
  assert.throws(() => catalog.search(principal, { cwd: cwd + '?workspaceType=external&workspaceVersionId=external-v2', query: '', limit: 100 }), /不能切换/)
})

test('真实生成的脱敏快照同时驱动MCP文档与原生@读取，原始资料保持独立', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 't3-workspace-tools-'))
  const sessions = new DatabaseSync(':memory:'), bindings = new DatabaseSync(':memory:')
  t.after(() => { sessions.close(); bindings.close(); rmSync(dataDir, { recursive: true, force: true }) })
  const workspaceStore = createWorkspaceStore({ dataDir })
  await workspaceStore.ensureProject({ id: 'p-autoops', name: '真实工作区验证', documents: [{ id: 'custom-doc', name: '测试资料.md', content: '# 资料\n内部项目代号 PRIVATE-CONTENT' }] })
  const internal = workspaceStore.overview('p-autoops').internalVersions[0]
  const task = workspaceStore.startExternal('p-autoops', { sourceVersionId: internal.id, rules: [{ find: 'PRIVATE-CONTENT', replace: '公开项目' }], requestId: 'resource-integration' })
  for (let i = 0; i < 200 && ['queued', 'running'].includes(workspaceStore.overview('p-autoops').tasks.find(({id}) => id === task.id).status); i++)
    await new Promise((done) => setTimeout(done, 10))
  assert.equal(workspaceStore.overview('p-autoops').tasks.find(({id}) => id === task.id).status, 'completed')
  const external = workspaceStore.overview('p-autoops').externalVersions[0]
  if (external.status === 'pending_review') workspaceStore.confirmExternal('p-autoops', external.id, { confirmedPaths: [], excludedPaths: external.report.pendingFiles.map(({path}) => path) })
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('real-workspace-resource').digest('hex'), 'u-admin', 'csrf', Date.now() + 100000)
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, workspaceStore })
  const principal = access.authenticateCookie('demo_session=real-workspace-resource')
  for (const version of [internal, external]) access.bindThread(principal, { threadId: version.type, projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'private', workspaceType: version.type, workspaceVersionId: version.id })
  const catalog = createBusinessResourceCatalog({ access, bindingDb: bindings, attachmentsDir: join(dataDir, 'attachments'), workspaceStore })
  const tools = createAutoOpsBusinessTools({ authorizeThread: (threadId) => access.requireToolThread(threadId), loadAttachments: () => [], storeArtifact: () => { throw new Error('unexpected write') }, workspaceStore })
  const material = (await tools.listMaterials('external')).documents.find(({id}) => id === 'docs/测试资料.md')
  assert.ok(material)
  assert.match((await tools.readDocument('internal', material.id)).content, /PRIVATE-CONTENT/)
  assert.match((await tools.readDocument('external', material.id)).content, /公开项目/)
  await assert.rejects(tools.readDocument('external', 'doc-design'), { code: 'DOCUMENT_FORBIDDEN' })
  const cwd = 'autoops://projects/p-autoops/environments/env-test/threads/external'
  assert.match((await catalog.read(principal, { cwd, relativePath: material.path })).contents, /公开项目/)
  assert.match((await catalog.readForThread('external', material.path)).content, /公开项目/)
  const files = catalog.search(principal, { cwd, query: '', limit: 500 })
  assert.ok(!files.entries.some(({path}) => path.split('/').includes('.git')))
  const internalPath = material.path.replace(external.id, internal.id)
  await assert.rejects(catalog.readForThread('external', internalPath), /资料不存在/)
  const originalGit = workspaceStore.files('p-autoops', internal.id).find(({path}) => path.endsWith('/.git/config'))
  assert.ok(originalGit)
  await assert.rejects(catalog.readForThread('external', `autoops/p-autoops/workspaces/${internal.id}/${originalGit.path}`), /资料不存在/)
})
