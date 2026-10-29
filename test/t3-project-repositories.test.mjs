import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectCredentialService } from '../agent-demo/t3-adapters/credentials.ts'
import { openDatabase } from '../autoops/server/platform/database.ts'
import { authoringMigrations } from '../agent-demo/t3-adapters/workspace-authoring/storage.ts'
import { createWorkspaceAuthoring } from '../agent-demo/t3-adapters/workspace-authoring/index.ts'

function fixture(t, validateRepository) {
  const dataDir = mkdtempSync(join(tmpdir(), 'project-repositories-'))
  const authorize = (actor, project, action) => {
    if (project !== 'project' || actor !== 'admin' && !(actor === 'reader' && ['read', 'repository-read'].includes(action)) && !(actor === 'developer' && ['read','repository-read','manage'].includes(action))) throw Object.assign(new Error('没有此项目权限'), {status:403})
  }
  let service = createWorkspaceAuthoring({dataDir, authorize, validateRepository})
  t.after(() => { service.close(); rmSync(dataDir, {recursive:true,force:true}) })
  return {get service() {return service}, reopen() {service.close(); service=createWorkspaceAuthoring({dataDir,authorize})}}
}
const connection = {
  name: '项目代码',
  url: 'https://github.com/example/project.git',
  credentialId: 'credential-one',
}
const request = (requestId, expectedRevision, value) => ({
  requestId,
  expectedRevision,
  ...(value ? { value } : {}),
})

test('项目连接不含分支或挂载，工作区引用独立，固定捕获不随连接更新漂移', t => {
  const f=fixture(t), service=f.service
  const created=service.saveRepository('project',null,request('create-repo',0,connection),'admin')
  assert.equal(created.revision,1)
  assert.deepEqual(service.overview('project','reader').sources,[])
  assert.deepEqual(Object.keys(created.repository).sort(),['credentialId','id','name','url'])
  const repoId=created.repository.id
  const configured=service.configureSource('project',{...request('work-branch',1),id:repoId,role:'frontend',refKind:'branch',ref:'workbench',mountPath:'src/web'},'admin')
  const captured=service.capture('project',2,'admin','active-input')
  assert.equal(captured.sources[0].ref,'workbench')
  service.saveRepository('project',repoId,request('update-connection',2,{...connection,url:'https://github.com/example/new-project.git'}),'admin')
  const current=service.overview('project','admin').sources[0]
  assert.equal(current.url,'https://github.com/example/new-project.git')
  assert.equal(current.ref,'workbench')
  assert.equal(current.mountPath,'src/web')
  assert.equal(service.captureByRequest('project','active-input','admin').sources[0].url,connection.url)
  assert.deepEqual(service.saveRepository('project',null,request('create-repo',0,connection),'admin'),created)
  assert.throws(()=>service.saveRepository('project',repoId,request('create-repo',3,connection),'admin'),{code:'WORKSPACE_REQUEST_CONFLICT'})
  service.removeRepository('project',repoId,request('remove-used',3),'admin')
  assert.equal(service.repositories('project','admin').items.length,0)
  assert.equal(service.overview('project','admin').sources.length,0)
  assert.equal(service.captureByRequest('project','active-input','admin'),null)
  assert.equal(configured.source.id,repoId)
  f.reopen()
  assert.equal(f.service.repositories('project','admin').items.length,0)
})

test('连接和工作区使用配置拒绝篡改、跨项目及只读成员写入', t => {
  const {service}=fixture(t)
  for (const extra of [{refKind:'branch',ref:'main'},{mountPath:'src'},{password:'fixture-secret'}])
    assert.throws(()=>service.saveRepository('project',null,request('invalid-connection',0,{...connection,...extra}),'admin'),{code:'REPOSITORY_INPUT_INVALID'})
  assert.throws(()=>service.saveRepository('project',null,request('reader-write',0,connection),'reader'),{status:403})
  assert.throws(()=>service.repositories('another-project','admin'),{status:403})
  const created=service.saveRepository('project',null,request('create',0,connection),'admin')
  assert.throws(()=>service.configureSource('project',{...request('inject-url',1),id:created.repository.id,role:'frontend',refKind:'default',ref:'',mountPath:'src/web',url:'https://evil.invalid/repo.git'},'admin'),{code:'REPOSITORY_USAGE_INVALID'})
  assert.throws(()=>service.configureSource('project',{...request('missing-repo',1),id:'another',role:'frontend',refKind:'default',ref:'',mountPath:'src/web'},'admin'),{code:'REPOSITORY_NOT_FOUND'})
  assert.deepEqual(service.repositories('project','reader').items,[created.repository])
})

test('从现行版本升级原子拆分连接，保留来源 ID、工作区分支和已接受输入', t => {
  const dataDir=mkdtempSync(join(tmpdir(),'repository-upgrade-')), root=join(dataDir,'workspace-authoring')
  mkdirSync(root)
  const old=openDatabase(join(root,'state.sqlite'),authoringMigrations.slice(0,2))
  old.db.prepare('INSERT INTO authoring_projects VALUES(?,?)').run('project',7)
  old.db.prepare('INSERT INTO authoring_sources VALUES(?,?,?,?,?,?,?,?,?,?)').run('project','repo-one','既有来源','frontend',connection.url,'branch','current-work','src/web',null,'credential-one')
  old.db.prepare('INSERT INTO authoring_captures VALUES(?,?,?,?,?,?,?,?,?,?)').run('accepted-input','project','admin','accepted-request',7,'2026-10-26T00:00:00Z','active','pending',null,null)
  old.db.prepare('INSERT INTO authoring_capture_sources VALUES(?,?,?,?,?,?,?,?,?,?)').run('accepted-input','repo-one','原输入来源','frontend',connection.url,'commit','a'.repeat(40),'original/web',null,'credential-old')
  old.close()
  const service=createWorkspaceAuthoring({dataDir,authorize:()=>{}})
  t.after(()=>{service.close();rmSync(dataDir,{recursive:true,force:true})})
  assert.deepEqual(service.repositories('project','admin'),{revision:7,items:[{id:'repo-one',name:'既有来源',url:connection.url,credentialId:'credential-one'}]})
  assert.equal(service.overview('project','admin').sources[0].ref,'current-work')
  const captured=service.captureByRequest('project','accepted-request','admin')
  assert.equal(captured.sources[0].ref,'a'.repeat(40))
  assert.equal(captured.sources[0].credentialId,'credential-old')
  service.saveRepository('project','repo-one',request('change-url',7,{name:'新连接名称',url:'https://github.com/example/new.git'}),'admin')
  assert.equal(service.overview('project','admin').sources[0].name,'新连接名称')
  assert.equal(service.captureByRequest('project','accepted-request','admin').sources[0].name,'原输入来源')
})

test('连接凭证由原凭证服务裁决，撤销后新写拒绝，原成功请求仍按收据恢复',t => {
  const root=mkdtempSync(join(tmpdir(),'repository-credentials-'))
  const credentials=createProjectCredentialService({databasePath:join(root,'state.sqlite'),keyPath:join(root,'key'),initializeKeyIfNew:true,authorize:()=>{}})
  t.after(()=>{credentials.close();rmSync(root,{recursive:true,force:true})})
  const credential=credentials.create('admin','project',{requestId:'credential-create',name:'隔离凭证',username:'fixture-user',password:'fixture-secret'})
  const {service}=fixture(t,(actor,project,value)=>{if(value.credentialId) credentials.referenceVersion(actor,project,value.credentialId)})
  const input=request('create-with-credential',0,{...connection,credentialId:credential.id})
  const created=service.saveRepository('project',null,input,'admin')
  credentials.revoke('admin','project',credential.id,{requestId:'revoke-credential',expectedRevision:credential.revision})
  assert.deepEqual(service.saveRepository('project',null,input,'admin'),created)
  assert.throws(()=>service.saveRepository('project',null,{...input,requestId:'new-connection',expectedRevision:1},'admin'),{code:'CREDENTIAL_REVOKED'})
  assert.equal(service.repositories('project','admin').revision,1)
  assert.equal(service.repositories('project','admin').items.length,1)
})

test('开发成员只调整工作区使用配置，不能编辑连接；移除工作区配置保留项目连接',t => {
  const {service}=fixture(t), created=service.saveRepository('project',null,request('create',0,connection),'admin')
  const id=created.repository.id
  assert.throws(()=>service.saveRepository('project',id,request('edit-connection',1,{...connection,name:'越权修改'}),'developer'),{status:403})
  service.configureSource('project',{...request('work-selection',1),id,role:'frontend',refKind:'branch',ref:'development',mountPath:'src/frontend'},'developer')
  assert.equal(service.overview('project','developer').sources[0].ref,'development')
  service.removeSource('project',id,request('remove-work-config',2),'developer')
  assert.equal(service.overview('project','developer').sources.length,0)
  assert.deepEqual(service.repositories('project','developer').items,[created.repository])
  assert.throws(()=>service.removeRepository('project',id,request('remove-connection',3),'developer'),{status:403})
})
