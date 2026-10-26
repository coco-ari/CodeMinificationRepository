import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createProjectDirectory } from '../agent-demo/t3-adapters/project-directory/index.ts'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'
import { filterAutoOpsShellItem } from '../agent-demo/t3-adapters/rpc-policy.mjs'

const input = (requestId='delete-original',expectedRevision=1) => ({requestId,expectedRevision})
const empty = () => []
function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(),'project-delete-'))
  const sessions = new DatabaseSync(':memory:'),bindings = new DatabaseSync(':memory:')
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  const users = [{id:'creator',name:'项目管理者',role:'member'},{id:'outside',name:'非成员',role:'member'},{id:'admin',name:'平台管理员',role:'admin'}]
  for (const user of users) sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(user.id,user.id,'csrf',Date.now()+60000)
  const seed = {users,projects:[],agents:[{id:'a-project',projectIds:[]}]}
  let directory,access
  const open = () => {
    directory = createProjectDirectory({dataDir,seed,authorize:(...args) => access.requireProjectActionForActor(...args)})
    access = createAutoOpsAccess({sessionDb:sessions,bindingDb:bindings,catalog:directory.catalog,deploymentEnabled:()=>true})
  }
  open()
  const created = directory.create('creator',{requestId:'create-original',expectedRevision:0,value:{name:'可删除项目',description:''}})
  seed.agents[0].projectIds.push(created.id)
  t.after(() => {directory.close();sessions.close();bindings.close();rmSync(dataDir,{recursive:true,force:true})})
  return {dataDir,users,project:created.id,open,get directory(){return directory},get access(){return access},principal:id => ({id,sessionHash:id})}
}

test('环境删除同事务移除成员范围及覆盖，原请求重开仍返回最小收据，不能重建原环境', t => {
  const f=fixture(t), d=f.directory
  const env=d.saveEnvironment('creator',f.project,null,{requestId:'new-env',expectedRevision:0,value:{name:'测试环境'}})
  d.saveMember('creator',f.project,{requestId:'member-env',expectedRevision:1,value:{userId:'creator',role:'project_admin',status:'active',environmentIds:[env.id],environmentRoles:{[env.id]:'reader'},canAdjustChat:true}})
  assert.equal(d.deletionPreview('creator',f.project,env.id,empty).canDelete,true)
  const db=new DatabaseSync(join(f.dataDir,'project-directory','state.sqlite'))
  try {
    db.exec("CREATE TRIGGER reject_environment_delete BEFORE INSERT ON directory_audit WHEN NEW.operation='environment.delete' BEGIN SELECT RAISE(ABORT,'隔离环境审计失败'); END")
    assert.throws(() => d.deleteEnvironment('creator',f.project,env.id,input(),empty),/隔离环境审计失败/)
    const unchanged=d.settings('creator',f.project)
    assert.deepEqual(unchanged.project.environments,[env])
    assert.deepEqual(unchanged.members[0].environmentIds,[env.id])
    assert.deepEqual(unchanged.members[0].environmentRoles,{[env.id]:'reader'})
    assert.equal(unchanged.members[0].revision,2)
    assert.equal(db.prepare('SELECT request_id FROM directory_deletions WHERE request_id=?').get(input().requestId),undefined)
    db.exec('DROP TRIGGER reject_environment_delete')
  } finally {db.close()}
  const result=d.deleteEnvironment('creator',f.project,env.id,input(),empty)
  assert.deepEqual(result,{deleted:true,projectId:f.project,environmentId:env.id})
  const member=d.settings('creator',f.project).members[0]
  assert.deepEqual(member.environmentIds,[]);assert.deepEqual(member.environmentRoles,{})
  assert.equal(member.revision,3)
  assert.throws(() => f.access.requireEnvironmentQueryForActor('creator',f.project,env.id))
  assert.throws(() => d.saveEnvironment('creator',f.project,env.id,{requestId:'recreate-env',expectedRevision:2,value:{name:'不能复活'}}),{code:'ENVIRONMENT_NOT_FOUND'})
  d.close();f.open()
  assert.deepEqual(f.directory.deleteEnvironment('creator',f.project,env.id,input(),() => assert.fail('原收据不能重新做删除')),result)
  assert.throws(() => f.directory.deleteEnvironment('creator',f.project,env.id,input('delete-new'),empty),{code:'ENVIRONMENT_NOT_FOUND'})
})

test('删除前重新查询真实引用，预检后新引用和过期修订均拒绝且不消费原请求', t => {
  const f=fixture(t),d=f.directory
  let references=[]
  const inspect=() => references
  assert.equal(d.deletionPreview('creator',f.project,null,inspect).canDelete,true)
  references=[{kind:'new-reference',count:2,message:'新增了运行输入'}]
  assert.throws(() => d.beginProjectDeletion('creator',f.project,input(),inspect),{code:'PROJECT_DELETE_BLOCKED'})
  assert.equal(d.settings('creator',f.project).project.revision,1)
  references=[]
  assert.throws(() => d.beginProjectDeletion('creator',f.project,input('stale',2),inspect),{code:'PROJECT_REVISION_CONFLICT'})
  assert.equal(d.beginProjectDeletion('creator',f.project,input(),inspect).state,'pending')
})

test('项目删除耐久阻止新授权与配置，只按原操作者原请求恢复，不用旧创建收据复活', t => {
  const f=fixture(t),d=f.directory
  d.beginProjectDeletion('creator',f.project,input(),empty)
  assert.equal(d.catalog.projects.length,0)
  assert.throws(() => f.access.requireProjectActionForActor('creator',f.project,'chat.use'),{code:'PROJECT_NOT_FOUND'})
  assert.throws(() => d.saveEnvironment('creator',f.project,null,{requestId:'late-env',expectedRevision:0,value:{name:'迟到环境'}}),{code:'PROJECT_NOT_FOUND'})
  d.close();f.open()
  assert.equal(f.directory.beginProjectDeletion('creator',f.project,input(),() => assert.fail('原请求不应替换已固定删除')).state,'pending')
  assert.throws(() => f.directory.beginProjectDeletion('admin',f.project,input(),empty),{code:'PROJECT_REQUEST_CONFLICT'})
  assert.throws(() => f.directory.beginProjectDeletion('creator',f.project,input('different'),empty),{code:'PROJECT_NOT_FOUND'})
  assert.throws(() => f.directory.beginProjectDeletion('creator',f.project,{...input(),expectedRevision:2},empty),{code:'PROJECT_REQUEST_CONFLICT'})
  assert.deepEqual(f.directory.completeProjectDeletion('creator',f.project,input()),{deleted:true,projectId:f.project})
  assert.equal(f.directory.beginProjectDeletion('creator',f.project,input(),empty).state,'deleted')
  assert.throws(() => f.directory.create('creator',{requestId:'create-original',expectedRevision:0,value:{name:'可删除项目',description:''}}),{code:'PROJECT_NOT_FOUND'})
  f.users[0].status='disabled'
  assert.throws(() => f.directory.beginProjectDeletion('creator',f.project,input(),empty),{code:'PROJECT_ACTOR_FORBIDDEN'})
})

test('私有会话计数阻止环境删除；删除项目后只有原可见成员收到移除通知', t => {
  const f=fixture(t),d=f.directory
  const env=d.saveEnvironment('creator',f.project,null,{requestId:'env',expectedRevision:0,value:{name:'私有环境'}})
  f.access.bindThread(f.principal('creator'),{threadId:'private-thread-id',projectId:f.project,environmentId:env.id,agentId:'a-project',visibility:'private',workspaceType:'internal'})
  const inspect=() => f.access.deletionReferences(f.project,env.id)
  const preview=d.deletionPreview('creator',f.project,env.id,inspect)
  assert.equal(preview.canDelete,false)
  assert(!JSON.stringify(preview).includes('private-thread-id'))
  assert.throws(() => d.deleteEnvironment('creator',f.project,env.id,input(),inspect),{code:'PROJECT_DELETE_BLOCKED'})
  f.access.markThreadDeleted('private-thread-id')
  d.deleteEnvironment('creator',f.project,env.id,input(),inspect)
  d.beginProjectDeletion('creator',f.project,input('project-delete'),empty)
  const event={kind:'project.removed',projectId:f.project}
  assert.deepEqual(filterAutoOpsShellItem(f.access,f.principal('creator'),event),event)
  assert.equal(filterAutoOpsShellItem(f.access,f.principal('outside'),event),null)
})

test('删除审计失败回滚墓碑和成员范围；原生明确非空可恢复管理并保留拒绝收据', t => {
  const f=fixture(t),d=f.directory
  const db=new DatabaseSync(join(f.dataDir,'project-directory','state.sqlite'))
  try {
    db.exec("CREATE TRIGGER reject_delete_audit BEFORE INSERT ON directory_audit WHEN NEW.operation LIKE '%delete%' BEGIN SELECT RAISE(ABORT,'隔离删除审计失败'); END")
    assert.throws(() => d.beginProjectDeletion('creator',f.project,input(),empty),/隔离删除审计失败/)
    assert.equal(d.settings('creator',f.project).project.revision,1)
    db.exec('DROP TRIGGER reject_delete_audit')
    d.beginProjectDeletion('creator',f.project,input(),empty)
    d.blockProjectDeletion('creator',f.project,input(),[{kind:'native-threads',count:1,message:'原生仍有归档会话'}])
    assert.equal(d.settings('creator',f.project).project.revision,3)
    assert.equal(d.beginProjectDeletion('creator',f.project,input(),empty).state,'blocked')
  } finally {db.close()}
})


test('显式续办仅接受本人原项目删除意图，重新核对引用与当前权限，不消费新的删除请求', t => {
  const f=fixture(t),d=f.directory,command=input('accepted-resume')
  const intent={operation:'project.delete',projectId:f.project,publicIntent:{expectedRevision:1}}
  assert.throws(() => d.resumeProjectDeletion('creator',command.requestId,intent,empty),{code:'PROJECT_DELETE_RECEIPT_NOT_FOUND'})
  d.beginProjectDeletion('creator',f.project,command,empty)
  assert.equal(d.receipt('creator',command.requestId).canResume,true)
  assert.throws(() => d.resumeProjectDeletion('admin',command.requestId,intent,empty),{code:'PROJECT_DELETE_RECEIPT_NOT_FOUND'})
  for(const forged of [{...intent,projectId:'another-project'},{...intent,publicIntent:{expectedRevision:2}}])
    assert.throws(() => d.resumeProjectDeletion('creator',command.requestId,forged,empty),{code:'PROJECT_REQUEST_CONFLICT'})
  assert.throws(() => d.resumeProjectDeletion('creator',command.requestId,{...intent,operation:'environment.delete'},empty),{code:'PROJECT_INPUT_INVALID'})
  assert.throws(() => d.resumeProjectDeletion('creator',command.requestId,intent,() => [{kind:'late-reference',count:1,message:'新增引用'}]),{code:'PROJECT_DELETE_BLOCKED'})
  assert.equal(d.receipt('creator',command.requestId).state,'pending')
  f.users[0].kind='external'
  assert.equal(d.receipt('creator',command.requestId).canResume,false)
  assert.throws(() => d.resumeProjectDeletion('creator',command.requestId,intent,empty),{code:'PROJECT_DELETE_FORBIDDEN'})
  delete f.users[0].kind
  assert.throws(() => d.resumeProjectDeletion('creator',command.requestId,intent,() => {f.users[0].kind='external';return []}),{code:'PROJECT_DELETE_FORBIDDEN'})
  delete f.users[0].kind
  assert.deepEqual(d.resumeProjectDeletion('creator',command.requestId,intent,empty),{projectId:f.project,command})
  d.completeProjectDeletion('creator',f.project,command)
  assert.deepEqual(d.resumeProjectDeletion('creator',command.requestId,intent,() => assert.fail('已完成续办不能重查或重做删除')),{projectId:f.project,command})
})
