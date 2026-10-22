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
