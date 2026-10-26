import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createWorkspaceStore} from '../agent-demo/t3-adapters/workspaces.mjs'
import {createWorkspaceAuthoring} from '../agent-demo/t3-adapters/workspace-authoring/index.ts'
import {createProjectCredentialService} from '../agent-demo/t3-adapters/credentials.ts'
import {createAssistantDirectory} from '../agent-demo/t3-adapters/assistants/index.ts'
import {createProjectDeletionInspection} from '../agent-demo/t3-adapters/project-deletion.ts'

test('工作区初始化在真正发布前阻止项目删除，空初始化完成后不产生引用',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'project-delete-initializing-'))
  const store=createWorkspaceStore({dataDir})
  t.after(async()=>{await store.close();rmSync(dataDir,{recursive:true,force:true})})
  const pending=store.ensureProject({id:'project',name:'空项目'})
  assert.equal(store.deletionReferences('project')[0]?.kind,'workspace-initializing')
  await pending
  assert.deepEqual(store.deletionReferences('project'),[])
  assert.deepEqual(store.deletionReferences('other'),[])
})

test('资料与固定输入真实 SQLite 摘要区分项目，释放输入后才解除输入保护',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'project-delete-authoring-'))
  const authoring=createWorkspaceAuthoring({dataDir,authorize:()=>{}})
  t.after(async()=>{await authoring.close();rmSync(dataDir,{recursive:true,force:true})})
  const bytes=Buffer.from('受保护资料')
  await authoring.upload('project',{requestId:'upload',expectedRevision:0,path:'docs/test.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),conflict:'replace'},bytes,'actor')
  assert.equal(authoring.deletionReferences('project').find(value=>value.kind==='workspace-current').count,2)
  assert.deepEqual(authoring.deletionReferences('other'),[])
  assert.deepEqual(authoring.deletionReferences('project','environment'),[])
  authoring.saveInput({id:'fixed-input',projectId:'project',requestId:'input-original',workspaceType:'internal',status:'active',revision:1,createdAt:new Date().toISOString(),repositories:[],files:[],directories:[]},'actor')
  assert.equal(authoring.deletionReferences('project').find(value=>value.kind==='workspace-fixed-inputs').count,1)
  authoring.releaseInput('project','fixed-input','actor')
  assert(!authoring.deletionReferences('project').some(value=>value.kind==='workspace-fixed-inputs'))
})

test('有效凭证和启用助手阻止相应范围删除，撤销和停用保留历史但不授权新使用',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'project-delete-config-'))
  const credentials=createProjectCredentialService({databasePath:join(dataDir,'credentials.sqlite'),keyPath:join(dataDir,'credential.key'),initializeKeyIfNew:true,authorize:()=>{}})
  const assistants=createAssistantDirectory({dataDir,membership:()=>({userId:'actor',role:'project_admin',workspaceAccess:'internal',environmentIds:['test'],status:'active'}),manage:()=>{},validate:()=>{},validateTarget:()=>{}})
  t.after(()=>{assistants.close();credentials.close();rmSync(dataDir,{recursive:true,force:true})})
  const credential=credentials.create('actor','project',{requestId:'credential',name:'虚构凭证',username:'fake',password:'isolated-not-a-real-secret'})
  const references=credentials.deletionReferences('project')
  assert.equal(references[0].count,1)
  assert(!JSON.stringify(references).includes('isolated-not-a-real-secret'))
  assert.deepEqual(credentials.deletionReferences('other'),[])
  credentials.revoke('actor','project',credential.id,{requestId:'revoke',expectedRevision:credential.revision})
  assert.deepEqual(credentials.deletionReferences('project'),[])
  const value={name:'启用助手',description:'',instructions:'',enabled:true,configuration:{agentId:'a-project',executionBinding:{kind:'platform'},environmentId:'test',workspaceType:'internal',visibility:'private',model:{instanceId:'codex',model:'test-model',reasoningEffort:null},skillIds:[]}}
  const preset=assistants.save('actor','project',null,{requestId:'preset',expectedRevision:0,value})
  assert.equal(assistants.deletionReferences('project','test')[0].count,1)
  assert.deepEqual(assistants.deletionReferences('project','production'),[])
  assistants.save('actor','project',preset.id,{requestId:'disable',expectedRevision:preset.revision,value:{...value,enabled:false}})
  assert.deepEqual(assistants.deletionReferences('project','test'),[])
})

test('删除组合根必须装配全部所有者，任一存储失败都不能当作无引用',()=>{
  const empty={deletionReferences:()=>[]}
  const sources={access:empty,workspace:empty,authoring:empty,credentials:empty,assistants:empty,deployments:empty,skills:empty,environmentMcp:empty}
  assert.deepEqual(createProjectDeletionInspection(sources)('project'),[])
  assert.throws(()=>createProjectDeletionInspection({...sources,environmentMcp:undefined})('project'),{status:503,code:'PROJECT_DELETE_INSPECTION_UNAVAILABLE'})
  const unavailable={deletionReferences(){throw new Error('隔离存储故障')}}
  assert.throws(()=>createProjectDeletionInspection({...sources,deployments:unavailable})('project'),{status:503,code:'PROJECT_DELETE_INSPECTION_UNAVAILABLE'})
})
