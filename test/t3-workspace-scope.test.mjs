import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createWorkspaceStore} from '../agent-demo/t3-adapters/workspaces.mjs'
import {createAutoOpsAccess, initializeAutoOpsAccessSchema} from '../agent-demo/t3-adapters/access.mjs'
import {handleWorkspaceRequest} from '../agent-demo/t3-adapters/workspace-http.mjs'
import {users,projects,agents} from '../agent-demo/fixtures.mjs'

const scope={projectId:'p-autoops',environmentId:'env-test',agentId:'a-project',visibility:'private'}
async function setup(t) {
  const directory=mkdtempSync(join(tmpdir(),'autoops-scope-'))
  const workspaceStore=createWorkspaceStore({dataDir:directory})
  const sessionDb=new DatabaseSync(':memory:'),bindingDb=new DatabaseSync(':memory:')
  t.after(()=>{sessionDb.close();bindingDb.close();rmSync(directory,{recursive:true,force:true})})
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  for(const user of users) sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(user.id).digest('hex'),user.id,'csrf',Date.now()+60000)
  const access=createAutoOpsAccess({sessionDb,bindingDb,workspaceStore,catalog:structuredClone({users,projects,agents})})
  const admin=access.authenticateCookie('demo_session=u-admin')
  await workspaceStore.ensureProject(projects.find(p=>p.id===scope.projectId))
  const internal=workspaceStore.overview(scope.projectId).internalVersions[0]
  return {workspaceStore,access,admin,internal,bindingDb}
}
async function completed(store,id) {
  for(let attempt=0;attempt<100;attempt++) {
    const task=store.overview(scope.projectId).tasks.find(t=>t.id===id)
    if(!['queued','running'].includes(task.status)) {assert.equal(task.status,'completed');return task}
    await new Promise(r=>setTimeout(r,10))
  }
  assert.fail('任务未完成')
}

test('workspace selection is required, fixed and inherited by a private fork',async t=>{
  const {workspaceStore,access,admin,internal}=await setup(t)
  assert.throws(()=>access.bindThread(admin,{...scope,threadId:'missing'}),{code:'WORKSPACE_REQUIRED'})
  const fixed={...scope,workspaceType:'internal',workspaceVersionId:internal.id}
  access.bindThread(admin,{...fixed,threadId:'raw'})
  const task=await completed(workspaceStore,workspaceStore.startExternal(scope.projectId,{sourceVersionId:internal.id,requestId:'external'}).id)
  let external=workspaceStore.overview(scope.projectId).externalVersions.find(v=>v.id===task.versionId)
  if(external.status==='pending_review') {
    assert.throws(()=>access.bindThread(admin,{...scope,threadId:'not-ready',workspaceType:'external',workspaceVersionId:external.id}))
    external=workspaceStore.confirmExternal(scope.projectId,external.id,{confirmedPaths:[],excludedPaths:external.report.pendingFiles.map(f=>f.path)})
  }
  assert.throws(()=>access.bindThread(admin,{...scope,threadId:'raw',workspaceType:'external',workspaceVersionId:external.id}),{code:'THREAD_BINDING_CONFLICT'})
  assert.throws(()=>access.bindThread(admin,{...fixed,threadId:'wrong-type',workspaceType:'external'}),{code:'WORKSPACE_NOT_AVAILABLE'})
  const fork=access.forkBinding(admin,'raw','raw-copy')
  assert.equal(fork.workspaceVersionId,internal.id)
  assert.equal(fork.workspaceType,'internal')
})

test('references and attachments cannot cross workspace boundaries even for their owner',async t=>{
  const {workspaceStore,access,admin,internal,bindingDb}=await setup(t)
  access.bindThread(admin,{...scope,threadId:'internal',workspaceType:'internal',workspaceVersionId:internal.id})
  const task=await completed(workspaceStore,workspaceStore.startExternal(scope.projectId,{sourceVersionId:internal.id,requestId:'external'}).id)
  let external=workspaceStore.overview(scope.projectId).externalVersions.find(v=>v.id===task.versionId)
  if(external.status==='pending_review')external=workspaceStore.confirmExternal(scope.projectId,external.id,{confirmedPaths:[],excludedPaths:external.report.pendingFiles.map(f=>f.path)})
  for(const threadId of ['external','external-copy']) access.bindThread(admin,{...scope,threadId,workspaceType:'external',workspaceVersionId:external.id})
  assert.throws(()=>access.requireReference(admin,'internal','external'),{code:'REFERENCE_WORKSPACE_MISMATCH'})
  access.recordThreadAttachment(admin,'raw-attachment','internal',{name:'raw.txt',mimeType:'text/plain',sizeBytes:12})
  assert.throws(()=>access.requireAttachment(admin,'raw-attachment','external'),{code:'REFERENCE_WORKSPACE_MISMATCH'})
  access.recordThreadAttachment(admin,'safe-attachment','external')
  assert.equal(access.requireAttachment(admin,'safe-attachment','external-copy').threadId,'external')
  bindingDb.prepare('INSERT INTO t3_thread_bindings(thread_id,project_id,environment_id,agent_id,owner_id,visibility,created_at) VALUES(?,?,?,?,?,?,?)').run('legacy',scope.projectId,scope.environmentId,scope.agentId,admin.id,'private','now')
  assert.equal(access.requireThread(admin,'legacy').workspaceType,undefined)
  assert.throws(()=>access.requireReference(admin,'legacy','external'),{code:'REFERENCE_WORKSPACE_MISMATCH'})
})

test('workspace HTTP scope checks membership before creating or serving project data',async t=>{
  const {workspaceStore,access,admin}=await setup(t)
  const call=(path,principal=admin)=>handleWorkspaceRequest({access,store:workspaceStore,principal,url:new URL('http://localhost/autoops/projects/'+path),method:'GET'})
  await assert.rejects(call('p-cabinet/workspaces',access.authenticateCookie('demo_session=u-lin')),{code:'PROJECT_NOT_FOUND'})
  const result=await call('p-autoops/workspaces')
  assert.equal(result.status,200)
  assert.equal(result.body.projectId,'p-autoops')
  await assert.rejects(call('p-autoops/workspaces/versions/nope/content?path=../../secrets'),{code:'WORKSPACE_PATH_INVALID'})
})
