import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCustomerTransportJournal,customerCommandId} from './customer-transport.mjs';

const fixture=t=>{const db=new DatabaseSync(':memory:');t.after(()=>db.close());return createCustomerTransportJournal(db)};
const session={sessionId:'session',threadId:'thread',ownerId:'owner',projectId:'project',deviceId:'device',target:{registeredWorkspaceId:'workspace',workspaceBindingRevision:1,runtimeId:'codex'}};
const command={type:'command',commandId:'command',sessionId:'session',target:session.target,method:'startTurn',input:{runId:'run'}};
test('same command ID has immutable input and terminal receipts never regress',t=>{
 const journal=fixture(t);journal.saveSession(session);journal.saveCommand(command);
 assert.throws(()=>journal.saveCommand({...command,input:{runId:'other'}}),{code:'COMMAND_CONFLICT'});
 journal.saveReceipt({type:'receipt',commandId:'command',sessionId:'session',state:'completed',result:{accepted:true}});
 journal.saveReceipt({type:'receipt',commandId:'command',sessionId:'session',state:'accepted'});
 assert.equal(journal.command('command').receipt.state,'completed');assert.equal(journal.pendingCommands('session').length,0);
});
test('out-of-order persistence ACKs advance only a contiguous applied cursor',t=>{
 const journal=fixture(t);journal.receive('session','epoch',[{seq:1,event:{text:'a'}},{seq:2,event:{text:'b'}},{seq:3,event:{type:'terminal'}}]);
 assert.equal(journal.applied('session','epoch',2),0);
 assert.equal(journal.applied('session','epoch',1),2);
 assert.deepEqual(journal.events('session','epoch',0),[{seq:3,event:{type:'terminal'}}]);
 assert.equal(journal.applied('session','epoch',3),3);
 assert.deepEqual(journal.cursor('session','epoch'),{received:3,applied:3});
 journal.receive('session','epoch',[{seq:1,event:{text:'a'}},{seq:2,event:{text:'b'}}]);
 assert.equal(journal.events('session','epoch',0).length,0);
});
test('a gap rejects the entire batch and cannot silently lose a missing event',t=>{
 const journal=fixture(t);
 assert.throws(()=>journal.receive('s','e',[{seq:1,event:{}},{seq:3,event:{}}]),{code:'EVENT_GAP'});
 assert.deepEqual(journal.cursor('s','e'),{received:0,applied:0});
 assert.equal(journal.events('s','e',0).length,0);
});
test('runtime epochs isolate events and session bindings cannot change',t=>{
 const journal=fixture(t);journal.saveSession(session);
 assert.throws(()=>journal.saveSession({...session,deviceId:'other'}),{code:'SESSION_SCOPE_CHANGED'});
 journal.receive('session','old',[{seq:1,event:{text:'old'}}]);journal.receive('session','new',[{seq:1,event:{text:'new'}}]);
 journal.applied('session','new',1);assert.equal(journal.events('session','old',0).length,1);
 assert.notEqual(customerCommandId('session','start',['run','attempt1']),customerCommandId('session','start',['run','attempt2']));
});
test('unknown outcome is durable and will never enter automatic retry list',t=>{
 const journal=fixture(t);journal.saveCommand(command);
 journal.saveReceipt({type:'receipt',commandId:'command',sessionId:'session',state:'unknown'});
 assert.equal(journal.pendingCommands('session').length,0);
 assert.equal(journal.saveCommand(command).receipt.state,'unknown');
});
test('人工核实后的原失败收据只收束unknown，不改已完成结果也不进入重放',t=>{
 const journal=fixture(t);journal.saveSession({...session,runtimeEpoch:'original-epoch'});journal.saveCommand({...command,method:'resumeThread',runtimeEpoch:'original-epoch'});
 journal.saveReceipt({type:'receipt',commandId:'command',sessionId:'session',state:'unknown'});
 assert.equal(journal.pendingCommands('session').length,0);
 assert.deepEqual(journal.unknownCommands('session').map(value=>value.commandId),['command']);
 const failed={type:'receipt',commandId:'command',sessionId:'session',state:'failed',runtimeEpoch:'original-epoch',error:{code:'CUSTOMER_MANUALLY_RECONCILED',message:'原进程已人工核实停止，未重做'}};
 assert.equal(journal.reconcileStoppedReceipt(failed,{sessionId:'session',runtimeEpoch:'original-epoch'}).state,'failed');
 assert.equal(journal.unknownCommands('session').length,0);
 assert.equal(journal.saveReceipt({...failed,state:'completed',result:{fabricated:true}}).state,'failed');
});

test('人工失败收束严格固定原session/grant/epoch，非法结果不改原unknown',t=>{
 const journal=fixture(t),scope={grantId:'original-grant'};
 journal.saveSession({...session,runtimeEpoch:'epoch'});journal.saveCommand({...command,runtimeEpoch:'epoch',executionScope:scope});
 journal.saveReceipt({type:'receipt',commandId:'command',sessionId:'session',grantId:scope.grantId,state:'unknown'});
 const receipt={type:'receipt',commandId:'command',sessionId:'session',grantId:scope.grantId,state:'failed',runtimeEpoch:'epoch',error:{code:'CUSTOMER_MANUALLY_RECONCILED',message:'已核实停止'}};
 for(const [changed,code] of [[{sessionId:'other'},'UNKNOWN_COMMAND'],[{grantId:'other'},'RECEIPT_SCOPE_CHANGED'],[{runtimeEpoch:'other'},'RUNTIME_EPOCH'],[{state:'completed'},'RECEIPT_RECONCILIATION_INVALID'],[{result:{}},'RECEIPT_RECONCILIATION_INVALID'],[{error:{code:'other',message:'不能猜测'}},'RECEIPT_RECONCILIATION_INVALID']]) {
  assert.throws(()=>journal.reconcileStoppedReceipt({...receipt,...changed},{sessionId:'session',runtimeEpoch:'epoch'}),{code});
  assert.equal(journal.command('command').receipt.state,'unknown');
 }
 assert.equal(journal.pendingCommands('session').length,0);
 journal.reconcileStoppedReceipt(receipt,{sessionId:'session',runtimeEpoch:'epoch'});
 assert.deepEqual(journal.reconcileStoppedReceipt({...receipt,error:{code:'other',message:'篡改终态'}},{sessionId:'session',runtimeEpoch:'epoch'}),receipt);
 journal.saveCommand({...command,commandId:'completed'});const completed={type:'receipt',commandId:'completed',sessionId:'session',state:'completed',result:{original:true}};journal.saveReceipt(completed);
 assert.deepEqual(journal.reconcileStoppedReceipt({...receipt,commandId:'completed',grantId:undefined},{sessionId:'session',runtimeEpoch:'epoch'}),completed);
});

test('传输会话固定实际调用者、提供者与业务项目，不能通过旧设备会话改投身份', () => {
  const db = new DatabaseSync(':memory:'), journal = createCustomerTransportJournal(db)
  try {
    const session = {sessionId:'shared-session',deviceId:'device',threadId:'thread',ownerId:'caller',providerId:'provider',projectId:'business',target:{registeredWorkspaceId:'source',workspaceBindingRevision:1,runtimeId:'codex'}}
    journal.saveSession(session)
    for (const change of [{ownerId:'provider'},{projectId:'source'},{providerId:'caller'}])
      assert.throws(()=>journal.saveSession({...session,...change}),{code:'SESSION_SCOPE_CHANGED'})
    const command={type:'command',commandId:'shared-command',sessionId:session.sessionId,target:session.target,method:'startTurn',input:{},executionScope:{grantId:'issued-grant'}}
    journal.saveCommand(command)
    assert.throws(()=>journal.saveReceipt({type:'receipt',commandId:command.commandId,sessionId:session.sessionId,state:'completed',grantId:'other-grant'}),{code:'RECEIPT_SCOPE_CHANGED'})
  } finally { db.close() }
})
