import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createAutoOpsAccess,initializeAutoOpsAccessSchema} from '../agent-demo/t3-adapters/access.mjs'
import {createBusinessArtifactStore} from '../agent-demo/t3-adapters/business-tools.mjs'
import {saveAuthorizedPlan} from '../agent-demo/t3-adapters/plan-materials.mjs'

test('计划只能由授权成员从真实历史保存，继承私有范围且不触碰宿主路径',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'t3-plan-')),sessionDb=new DatabaseSync(':memory:'),bindingDb=new DatabaseSync(':memory:'),store=createBusinessArtifactStore(dir)
 t.after(async()=>{store.close();sessionDb.close();bindingDb.close();await rm(dir,{recursive:true,force:true})})
 sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)');initializeAutoOpsAccessSchema(bindingDb)
 for(const id of ['u-admin','u-lin'])sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(id).digest('hex'),id,'csrf',Date.now()+60000)
 const access=createAutoOpsAccess({sessionDb,bindingDb}),principal=access.authenticateCookie('demo_session=u-admin'),other=access.authenticateCookie('demo_session=u-lin')
 access.bindThread(principal,{threadId:'plan-thread',projectId:'p-autoops',environmentId:'env-test',agentId:'a-project',visibility:'private'})
 const contents='# 实际计划\n\n只读检查\n',projection={thread:{id:'plan-thread',deletedAt:null},plans:[{id:'actual-plan',kind:'proposed_plan',runId:'actual-run',markdown:contents}]}
 const input={threadId:'plan-thread',name:'检查计划.md',contents},args={access,principal,input,projection,store}
 const first=saveAuthorizedPlan(args);assert.equal(saveAuthorizedPlan(args).id,first.id);assert.equal(store.read(first.id).published,false);assert.equal(Buffer.from(store.read(first.id).bytes).toString(),contents)
 assert.throws(()=>saveAuthorizedPlan({...args,principal:other}),{code:'THREAD_NOT_FOUND'})
 assert.throws(()=>saveAuthorizedPlan({...args,input:{...input,contents:'# 伪造计划\n'}}),{code:'PLAN_CHANGED'})
 assert.throws(()=>saveAuthorizedPlan({...args,input:{...input,name:'../outside.md'}}),{code:'INVALID_PLAN_FILE'})
 bindingDb.prepare('UPDATE t3_thread_bindings SET compatibility_read_only=1 WHERE thread_id=?').run(input.threadId)
 assert.throws(()=>saveAuthorizedPlan(args),{code:'PLAN_READ_ONLY'})
 assert.equal(store.list(input.threadId).length,1)
})
