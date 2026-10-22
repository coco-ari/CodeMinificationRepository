import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { users, projects, agents } from '../agent-demo/fixtures.mjs'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'
import { createBusinessResourceCatalog } from '../agent-demo/t3-adapters/resources.mjs'
import { handleWorkspaceRequest } from '../agent-demo/t3-adapters/workspace-http.mjs'
import { authorizeAutoOpsRpc, filterAutoOpsShell, filterAutoOpsShellItem, prepareAutoOpsRpcPayload } from '../agent-demo/t3-adapters/rpc-policy.mjs'

const base = { projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'project' }
function setup(t) {
  const sessionDb = new DatabaseSync(':memory:'), bindingDb = new DatabaseSync(':memory:')
  t.after(() => { sessionDb.close(); bindingDb.close() })
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  const catalog = structuredClone({ users, projects, agents })
  for (const user of catalog.users) sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(user.id).digest('hex'), user.id, 'csrf', Date.now() + 60000)
  const versions = [
    { id:'internal-v1', type:'internal', status:'published', source:{contentHash:'internal-digest',repositories:[{path:'.',commit:'internal-commit'}],repositoryHost:'private.invalid'} },
    { id:'external-v1', type:'external', status:'published', sourceVersionId:'internal-v1', source:{contentHash:'external-digest',repositories:[{path:'.',commit:'internal-commit'}]} },
    { id:'external-pending', type:'external', status:'pending_review', source:{contentHash:'pending',repositories:[]} },
  ]
  let writes = 0
  const file = { path:'docs/资料.md',name:'资料.md',mime:'text/markdown',size:10,sha256:'digest' }
  const store = {
    async ensureProject() {},
    getVersion(projectId,id) { const version = projectId === base.projectId && versions.find((entry) => entry.id === id && entry.status === 'published'); if (!version) throw Object.assign(new Error('未发布'),{code:'WORKSPACE_NOT_FOUND'}); return version },
    overview() { return {projectId:base.projectId,internalVersions:versions.filter((entry) => entry.type === 'internal'),externalVersions:versions.filter((entry) => entry.type === 'external'),releases:[{id:'release',manifest:{source:'raw-source'}}],tasks:[{id:'raw-task',message:'internal'}],import:{supported:true,hosts:['github.com']}} },
    files(projectId,id) { this.getVersion(projectId,id); return [file] },
    read(projectId,id) { return {contents:this.getVersion(projectId,id).type === 'internal'?'原始内容':'脱敏内容',byteLength:10,truncated:false} },
    readBytes(projectId,id) { return Buffer.from(this.read(projectId,id).contents) },
    managementTree() { return {entries:[file]} },
    managementRead(projectId,id) { return {contents:id === 'internal-v1'?'原始内容':'脱敏内容'} },
    versionFile(projectId,id) { return {bytes:Buffer.from(id),name:'资料.md',mime:'text/markdown'} },
    packageFile() { return {bytes:Buffer.from('raw-package'),name:'frontend.zip',mime:'application/zip'} },
    startExternal() { writes++; return {id:'new-task'} },
  }
  const access = createAutoOpsAccess({sessionDb,bindingDb,catalog,workspaceStore:store})
  const principal = (id) => access.authenticateCookie('demo_session=' + id)
  const admin=principal('u-admin'), member=principal('u-lin'), guest=principal('u-guest')
  const call = (principal,path='',method='GET',input) => handleWorkspaceRequest({access,store,principal,url:new URL('http://localhost/autoops/projects/p-autoops/workspaces'+path),method,input})
  return {access,store,catalog,bindingDb,admin,member,guest,call,writes:()=>writes}
}

test('项目身份独立于全局角色，兼容内部成员且外部默认不授予原始权限', t => {
  const {access,admin,member,guest,catalog} = setup(t)
  assert.equal(access.requireMembership(admin,base.projectId).role,'manager')
  assert.equal(access.requireMembership(member,base.projectId).workspaceAccess,'internal')
  assert.equal(access.requireMembership(member,base.projectId).role,'member')
  assert.equal(access.requireMembership(guest,base.projectId).workspaceAccess,'external')
  assert.throws(() => access.requireWorkspace(guest,base.projectId,'internal'),{code:'WORKSPACE_FORBIDDEN'})
  assert.throws(() => access.requireWorkspaceManager(member,base.projectId),{code:'WORKSPACE_MANAGEMENT_FORBIDDEN'})
  assert.throws(() => access.requireEnvironment(guest,base.projectId,'env-prod'),{code:'ENVIRONMENT_FORBIDDEN'})
  assert.equal(access.requireWorkspace(guest,base.projectId,'external','external-v1','env-test').workspaceAccess,'external')
  assert.throws(() => access.requireWorkspace(guest,base.projectId,'external','internal-v1'),{code:'WORKSPACE_NOT_AVAILABLE'})
  assert.throws(() => access.requireWorkspace(guest,base.projectId,'external','external-pending'),{code:'WORKSPACE_NOT_FOUND'})
  const boot=access.bootstrap(guest)
  assert.deepEqual(boot.projects.map(({id}) => id),[base.projectId])
  assert.deepEqual(boot.projects[0].environments.map(({id}) => id),['env-test'])
  assert.equal(boot.projects[0].membership.workspaceAccess,'external')
  catalog.users.find(({id})=>id==='u-guest').role='admin'
  assert.throws(() => access.requireWorkspaceManager(guest,base.projectId),{code:'WORKSPACE_FORBIDDEN'})
})

test('内部共享、私有、旧记录与环境权限全部在会话ACL生效', t => {
  const {access,admin,member,guest,bindingDb}=setup(t)
  for(const [threadId,workspaceType,workspaceVersionId,visibility,environmentId] of [
    ['raw','internal','internal-v1','project','env-test'],['safe','external','external-v1','project','env-test'],['private','external','external-v1','private','env-test'],['production','external','external-v1','project','env-prod'],
  ]) access.bindThread(admin,{...base,threadId,workspaceType,workspaceVersionId,visibility,environmentId})
  bindingDb.prepare('INSERT INTO t3_thread_bindings(thread_id,project_id,environment_id,agent_id,owner_id,visibility,created_at) VALUES(?,?,?,?,?,?,?)').run('legacy',base.projectId,base.environmentId,base.agentId,admin.id,'project','now')
  assert.equal(access.canSeeThread(guest,'raw'),false)
  assert.equal(access.canSeeThread(guest,'safe'),true)
  assert.equal(access.canSeeThread(guest,'private'),false)
  assert.equal(access.canSeeThread(guest,'production'),false)
  assert.equal(access.canSeeThread(guest,'legacy'),false)
  assert.equal(access.canSeeThread(member,'raw'),true)
  assert.deepEqual(access.threadAudience(access.getThreadBinding('raw')).sort(),['u-admin','u-lin'])
  assert.deepEqual(access.threadAudience(access.getThreadBinding('safe')).sort(),['u-admin','u-guest','u-lin'])
  assert.throws(()=>access.bindThread(guest,{...base,threadId:'forged',workspaceType:'internal',workspaceVersionId:'internal-v1'}),{code:'WORKSPACE_FORBIDDEN'})
  assert.throws(()=>access.bindThread(guest,{...base,threadId:'forged-prod',workspaceType:'external',workspaceVersionId:'external-v1',environmentId:'env-prod'}),{code:'ENVIRONMENT_FORBIDDEN'})
  access.recordThreadAttachment(admin,'raw-file','raw')
  assert.throws(()=>access.requireAttachment(guest,'raw-file'),{code:'THREAD_NOT_FOUND'})
  assert.throws(()=>access.requireReference(guest,'raw','safe'),{code:'THREAD_NOT_FOUND'})
})

test('权限撤回立即阻止读取和工具，其他授权成员保留共享历史', t => {
  const {access,admin,member,guest,catalog}=setup(t)
  access.bindThread(admin,{...base,threadId:'raw',workspaceType:'internal',workspaceVersionId:'internal-v1'})
  const project=catalog.projects.find(({id})=>id===base.projectId)
  project.memberships.push({userId:admin.id,workspaceAccess:'external',role:'member',environmentIds:['env-test'],status:'active'})
  assert.equal(access.canSeeThread(admin,'raw'),false)
  assert.equal(access.canSeeThread(member,'raw'),true)
  assert.throws(()=>access.requireToolThread('raw'),{code:'WORKSPACE_FORBIDDEN'})
  project.memberships.find(({userId})=>userId===guest.id).status='disabled'
  assert.throws(()=>access.requireMembership(guest,base.projectId),{code:'PROJECT_NOT_FOUND'})
  assert.equal(access.bootstrap(guest).projects.length,0)
})

test('overview、pending、原件、部署包与管理操作按身份过滤', async t => {
  const {access,admin,member,guest,call,writes}=setup(t)
  const external=(await call(guest)).body
  assert.deepEqual(external.internalVersions,[]);assert.deepEqual(external.releases,[]);assert.deepEqual(external.tasks,[])
  assert.deepEqual(external.externalVersions.map(({id})=>id),['external-v1'])
  assert.ok(!JSON.stringify(external).includes('internal-commit'))
  assert.ok(!JSON.stringify(external).includes('internal-v1'))
  assert.equal(external.import.supported,false)
  assert.equal((await call(member)).body.externalVersions.length,1)
  assert.equal((await call(admin)).body.externalVersions.length,2)
  await assert.rejects(call(guest,'/versions/internal-v1/content?path=docs/资料.md'),{code:'WORKSPACE_FORBIDDEN'})
  await assert.rejects(call(guest,'/versions/external-pending/download?path=image.png'),{code:'WORKSPACE_NOT_FOUND'})
  await assert.rejects(call(member,'/versions/external-pending/content?path=docs/资料.md'),{code:'WORKSPACE_NOT_FOUND'})
  await assert.rejects(call(guest,'/packages/release/frontend/download'),{code:'WORKSPACE_FORBIDDEN'})
  await assert.rejects(call(member,'/packages/release/frontend/download'),{code:'WORKSPACE_MANAGEMENT_FORBIDDEN'})
  assert.equal((await call(admin,'/packages/release/frontend/download')).file.name,'frontend.zip')
  assert.equal((await call(guest,'/versions/external-v1/content?path=docs/资料.md')).body.contents,'脱敏内容')
  await assert.rejects(call(member,'/external','POST',{}),{code:'WORKSPACE_MANAGEMENT_FORBIDDEN'})
  await assert.rejects(call(guest,'/external','POST',{}),{code:'WORKSPACE_FORBIDDEN'})
  assert.equal(writes(),0)
  await call(admin,'/external','POST',{})
  assert.equal(writes(),1)
})

test('直接资源、元数据与草稿@不能绕过外部资料授权', async t => {
  const {access,store,bindingDb,admin,guest}=setup(t)
  access.bindThread(admin,{...base,threadId:'raw',workspaceType:'internal',workspaceVersionId:'internal-v1'})
  const catalog=createBusinessResourceCatalog({access,bindingDb,workspaceStore:store,attachmentsDir:'/unused'})
  const raw='autoops/p-autoops/workspaces/internal-v1/docs/资料.md',safe=raw.replace('internal-v1','external-v1')
  await assert.rejects(catalog.resource(guest,raw),{code:'WORKSPACE_FORBIDDEN'})
  await assert.rejects(catalog.metadata(guest,[raw]),{code:'WORKSPACE_FORBIDDEN'})
  await assert.rejects(catalog.resource(guest,'autoops/p-autoops/documents/doc-design/not-real/design.md'),{code:'WORKSPACE_FORBIDDEN'})
  assert.equal(Buffer.from((await catalog.resource(guest,safe)).bytes).toString(),'脱敏内容')
  const cwd='autoops://projects/p-autoops/environments/env-test/threads/draft?workspaceType=internal&workspaceVersionId=internal-v1'
  assert.throws(()=>catalog.search(guest,{cwd,query:'',limit:100}),{code:'WORKSPACE_FORBIDDEN'})
  assert.ok(catalog.search(guest,{cwd:cwd.replace('internal&','external&').replace('internal-v1','external-v1'),query:'',limit:100}).entries.some(({path})=>path===safe))
})

test('草稿范围可编辑，提交冻结按命令幂等，明确失败解锁、被接受后永久锁定', t => {
  const {access,admin,member,guest}=setup(t)
  const input={...base,threadId:'draft',workspaceType:'internal',workspaceVersionId:'internal-v1'}
  assert.equal(access.reserveThread(admin,{...input,scopeState:'locked',scopeLocked:true,submission_command_id:'forged-command'}).scopeState,'draft')
  assert.equal(access.canSeeThread(member,'draft'),false)
  assert.throws(()=>access.reserveThread(member,input),{code:'THREAD_BINDING_CONFLICT'})
  const safe={...input,workspaceType:'external',workspaceVersionId:'external-v1'}
  assert.equal(access.reserveThread(admin,safe).workspaceType,'external')
  assert.equal(access.beginThreadSubmission(admin,'draft','command-1').scopeState,'submitting')
  assert.equal(access.beginThreadSubmission(admin,'draft','command-1').scopeState,'submitting')
  assert.throws(()=>access.beginThreadSubmission(admin,'draft','command-2'),{code:'THREAD_SUBMISSION_CONFLICT'})
  assert.throws(()=>access.reserveThread(admin,input),{code:'THREAD_SCOPE_LOCKED'})
  assert.equal(access.finishThreadSubmission('draft','wrong-command',false).scopeState,'submitting')
  assert.equal(access.finishThreadSubmission('draft','command-1',false).scopeState,'draft')
  assert.equal(access.reserveThread(admin,input).workspaceType,'internal')
  access.beginThreadSubmission(admin,'draft','command-2')
  const accepted=access.finishThreadSubmission('draft','command-2',true)
  assert.equal(accepted.scopeLocked,true)
  assert.equal(access.canSeeThread(member,'draft'),true)
  assert.equal(access.canSeeThread(guest,'draft'),false)
  assert.equal(access.finishThreadSubmission('draft','command-2',false).scopeLocked,true)
  assert.equal(access.beginThreadSubmission(admin,'draft','command-2').scopeLocked,true)
  assert.throws(()=>access.reserveThread(admin,safe),{code:'THREAD_SCOPE_LOCKED'})
  assert.equal(access.reconcileThreadSubmission('draft',false).scopeState,'locked')
})

test('旧会话默认锁定，不确定提交在重开数据库后保留，受控核对才释放', t => {
  const {access,admin,bindingDb}=setup(t)
  const input={...base,workspaceType:'internal',workspaceVersionId:'internal-v1'}
  assert.equal(access.bindThread(admin,{...input,threadId:'old'}).scopeLocked,true)
  access.reserveThread(admin,{...input,threadId:'uncertain'})
  access.beginThreadSubmission(admin,'uncertain','unknown-command')
  initializeAutoOpsAccessSchema(bindingDb)
  assert.equal(access.getThreadBinding('uncertain').scopeState,'submitting')
  assert.equal(access.reconcileThreadSubmission('uncertain',false).scopeState,'draft')
  access.beginThreadSubmission(admin,'uncertain','new-command')
  assert.equal(access.markThreadAccepted('uncertain').scopeState,'locked')
  assert.equal(access.markThreadAccepted('uncertain').scopeState,'locked')
  assert.equal(access.finishThreadSubmission('uncertain','new-command',false).scopeState,'locked')
})

test('外部RPC只返回虚拟项目根，技能刷新仍映射到服务端固定目录', t => {
  const {access,admin,guest}=setup(t)
  const originalRoot='/home/tao/private-runtime/t3/workspaces/p-autoops'
  const project={id:base.projectId,workspaceRoot:originalRoot,repositoryIdentity:{path:'/home/tao/private-repository'}}
  const snapshot={projects:[project],threads:[]}
  assert.equal(filterAutoOpsShell(access,admin,snapshot).projects[0].workspaceRoot,originalRoot)
  const safe=filterAutoOpsShell(access,guest,snapshot)
  assert.equal(safe.projects[0].workspaceRoot,'autoops/p-autoops/workspaces')
  assert.equal(safe.projects[0].repositoryIdentity,null)
  assert.equal(project.workspaceRoot,originalRoot)
  assert.ok(!JSON.stringify(safe).includes('/home/tao'))
  const item=filterAutoOpsShellItem(access,guest,{kind:'snapshot',snapshot,resolvedRepositoryIdentityRoots:[originalRoot]})
  assert.deepEqual(item.resolvedRepositoryIdentityRoots,[])
  assert.equal(filterAutoOpsShellItem(access,guest,{kind:'project.updated',project}).project.workspaceRoot,'autoops/p-autoops/workspaces')
  const previous=process.env.AUTOOPS_T3_DATA_DIR
  process.env.AUTOOPS_T3_DATA_DIR='/private/tmp/autoops-authorized-data'
  try {
    const payload={instanceId:'codex',cwd:'autoops/p-autoops/workspaces',fresh:true}
    authorizeAutoOpsRpc(access,guest,'server.refreshProviders',payload)
    const actual=prepareAutoOpsRpcPayload(access,guest,'server.refreshProviders',payload)
    assert.equal(actual.cwd,'/private/tmp/autoops-authorized-data/t3/workspaces/p-autoops')
    assert.equal(payload.cwd,'autoops/p-autoops/workspaces')
    assert.throws(()=>prepareAutoOpsRpcPayload(access,guest,'server.refreshProviders',{...payload,cwd:'autoops/p-cabinet/workspaces'}),{code:'AUTOOPS_OPERATION_FORBIDDEN'})
    assert.throws(()=>authorizeAutoOpsRpc(access,guest,'server.refreshProviders',{...payload,cwd:actual.cwd}),{code:'AUTOOPS_OPERATION_FORBIDDEN'})
    authorizeAutoOpsRpc(access,admin,'server.refreshProviders',{...payload,cwd:actual.cwd})
  } finally {
    if(previous===undefined)delete process.env.AUTOOPS_T3_DATA_DIR
    else process.env.AUTOOPS_T3_DATA_DIR=previous
  }
  access.reserveThread(guest,{...base,threadId:'external-launch',workspaceType:'external',workspaceVersionId:'external-v1'})
  authorizeAutoOpsRpc(access,guest,'orchestration.launchThread',{threadId:'external-launch',projectId:base.projectId,initialMessage:{text:'分析资料'}})
})
