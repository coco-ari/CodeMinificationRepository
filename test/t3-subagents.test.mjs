import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createAutoOpsAccess,initializeAutoOpsAccessSchema} from '../agent-demo/t3-adapters/access.mjs'
import {createNativeSubagentBindings} from '../agent-demo/t3-adapters/subagents.mjs'
import {authorizeAutoOpsRpc} from '../agent-demo/t3-adapters/rpc-policy.mjs'
test('native 子任务继承可信父范围，只读入口、身份冲突和父撤权均生效',t=>{
  const directory=mkdtempSync(join(tmpdir(),'t3-native-child-'));const db=new DatabaseSync(join(directory,'t3-autoops.sqlite')),sessions=new DatabaseSync(':memory:')
  initializeAutoOpsAccessSchema(db);sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  for(const id of ['u-admin','u-lin'])sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(id).digest('hex'),id,'csrf',Date.now()+60000)
  const access=createAutoOpsAccess({sessionDb:sessions,bindingDb:db}),bindings=createNativeSubagentBindings(directory,access)
  t.after(()=>{bindings.close();db.close();sessions.close();rmSync(directory,{recursive:true,force:true})})
  const admin=access.authenticateCookie('demo_session=u-admin'),lin=access.authenticateCookie('demo_session=u-lin')
  const scope={projectId:'p-autoops',environmentId:'env-test',agentId:'a-project',visibility:'project'}
  access.bindThread(admin,{...scope,threadId:'parent'})
  const child=bindings.register('parent','child','native-child')
  assert.equal(child.nativeParentThreadId,'parent');assert.equal(child.ownerId,admin.id)
  assert.equal(access.canSeeThread(lin,'child'),true)
  assert.equal(bindings.register('parent','child','native-child').nativeThreadId,'native-child')
  access.bindThread(admin,{...scope,threadId:'other'})
  assert.throws(()=>bindings.register('other','child','native-child'),/其他来源/)
  assert.throws(()=>bindings.register('parent','other','other-native'),/占用/)
  assert.throws(()=>authorizeAutoOpsRpc(access,admin,'orchestration.dispatchCommand',{type:'thread.delete',threadId:'child'}))
  db.prepare('UPDATE t3_thread_bindings SET revoked_at=? WHERE thread_id=?').run(new Date().toISOString(),'parent')
  assert.equal(access.canSeeThread(lin,'child'),false)
  assert.throws(()=>access.requireToolThread('child'))
  assert.throws(()=>bindings.register('parent','second','second-native'))
})
