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
