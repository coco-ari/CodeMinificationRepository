import { expect, it, vi } from 'vite-plus/test'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { createCustomerTransportJournal, customerCommandId } from '../../../../../../agent-demo/t3-adapters/customer-transport.mjs'
import { derive } from '@t3tools/provider-core/server/IdAllocator'
import { RemoteDeviceHub } from './RemoteDeviceService.ts'
import { validateCustomerEvent } from './CustomerEventValidation.ts'

async function fixture(){
 const previous=process.env.AUTOOPS_CUSTOMER_AGENTS;process.env.AUTOOPS_CUSTOMER_AGENTS='1'
 const bindingDb=new DatabaseSync(':memory:'),sessionDb=new DatabaseSync(':memory:');initializeAutoOpsAccessSchema(bindingDb);sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
 const catalog={users:[{id:'provider',name:'本人',role:'member',kind:'internal'}],projects:[{id:'project',name:'离线项目',memberIds:['provider'],memberships:[{userId:'provider',role:'developer',status:'active',environmentIds:[],workspaceAccess:'internal'}],environments:[],documents:[],resources:[]}],agents:[{id:'a-project',name:'助手',projectIds:['project']}]}
 sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('provider').digest('hex'),'provider','csrf',Date.now()+600000)
 const access=createAutoOpsAccess({sessionDb,bindingDb,catalog}),registry=access.customerRegistry,paired=registry.consumePairing(registry.createPairing('provider').pairingCode,{label:'本人设备'}),machine=registry.authenticateToken(paired.deviceToken)
 const target={kind:'customer',deviceId:machine.deviceId,registeredWorkspaceId:'owned-directory',workspaceBindingRevision:1,runtimeId:'codex'}
 registry.registerWorkspace(machine,{registeredWorkspaceId:target.registeredWorkspaceId,workspaceBindingRevision:1,runtimeId:'codex',projectId:'project',label:'目录'});registry.markConnected(machine)
 const oldThread=randomUUID();access.reserveThread(access.authenticateCookie('demo_session=provider'),{threadId:oldThread,projectId:'project',environmentId:null,agentId:'a-project',visibility:'private',executionBinding:target});access.markThreadAccepted(oldThread)
 const f={access,machine,target,oldThread},db=new DatabaseSync(':memory:'),journal=createCustomerTransportJournal(db),hub=new RemoteDeviceHub(access,journal),sent=[]
 const instance=`customer-${f.machine.deviceId}-codex`,prefix=`customer:${instance}:${f.oldThread}:`,driver='codex'
 const threadId=derive.providerThread({driver,providerInstanceId:instance,nativeThreadId:prefix+'native-thread'}),turnId=derive.providerTurn({driver,nativeTurnId:prefix+'native-turn'})
 const session={sessionId:'applied-session',deviceId:f.machine.deviceId,ownerId:'provider',projectId:'project',threadId:f.oldThread,runtimeEpoch:'original-epoch',target:{registeredWorkspaceId:f.target.registeredWorkspaceId,workspaceBindingRevision:1,runtimeId:'codex'},providerThreadId:threadId,runs:[{runId:'original-run',attemptId:'original-attempt',rootNodeId:'original-root',runOrdinal:1,providerTurnOrdinal:1}]}
 const event={type:'provider_turn.updated',driver,providerTurn:{id:turnId,providerThreadId:threadId,nodeId:'original-root',runAttemptId:'original-attempt',nativeTurnRef:{driver,strength:'strong',nativeId:'native-turn'},ordinal:1,status:'failed',startedAt:'2026-10-22T00:00:00.000Z',completedAt:'2026-10-22T00:00:01.000Z'}}
 validateCustomerEvent(session,event);journal.saveSession(session);journal.receive(session.sessionId,session.runtimeEpoch,[{seq:1,event}]);journal.applied(session.sessionId,session.runtimeEpoch,1)
 const providerThread={id:threadId,driver,providerInstanceId:instance,providerSessionId:session.sessionId,appThreadId:f.oldThread,ownerNodeId:null,nativeThreadRef:null,nativeConversationHeadRef:null,status:'idle',firstRunOrdinal:1,lastRunOrdinal:1,handoffIds:[],forkedFrom:null,createdAt:'2026-10-22T00:00:00.000Z',updatedAt:'2026-10-22T00:00:01.000Z'}
 for(const method of ['openSession','ensureThread','startTurn']) {
  const commandId=customerCommandId(session.sessionId,method,method==='startTurn'?['original-run','original-attempt']:method)
  journal.saveCommand({type:'command',commandId,sessionId:session.sessionId,target:session.target,method,...(method==='openSession'?{}:{runtimeEpoch:session.runtimeEpoch}),input:method==='startTurn'?{providerThread,runId:'original-run',attemptId:'original-attempt'}:{}})
  journal.saveReceipt({type:'receipt',commandId,sessionId:session.sessionId,runtimeEpoch:session.runtimeEpoch,state:'completed',result:{fixture:true}})
 }
 const peer=hub.connect(f.machine,async frame=>{sent.push(frame)},()=>{})
 await peer.accept({type:'hello',protocolVersion:1,deviceId:f.machine.deviceId,connectorVersion:'fixture',connectorEpoch:'fixture',workspaces:[{...session.target,projectId:'project',label:'目录'}],sessions:[{sessionId:session.sessionId,runtimeEpoch:session.runtimeEpoch,state:'idle',live:true,lastSeq:1}]})
 const frame={type:'events',sessionId:session.sessionId,runtimeEpoch:session.runtimeEpoch,events:[{seq:1,event}]}
 const snapshot=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>[row.name,db.prepare('SELECT * FROM "'+row.name+'" ORDER BY rowid').all()]))
 return {f,db,journal,hub,session,event,peer,frame,sent,snapshot,async close(){hub.close();db.close();bindingDb.close();sessionDb.close();if(previous===undefined)delete process.env.AUTOOPS_CUSTOMER_AGENTS;else process.env.AUTOOPS_CUSTOMER_AGENTS=previous}}
}

it.each(['completed','failed','interrupted','cancelled'])('已applied原%s重新可靠交付同persistenceKey，原生ack前不能完成accept且所有SQLite行不变',async status=>{
 const f=await fixture(),controller=new AbortController(),events=f.hub.events(f.session.sessionId,controller.signal)
 f.frame.events[0].event.providerTurn.status=status
 f.hub.update(f.session.sessionId,{pendingInterrupt:{runId:'original-run',attemptId:'original-attempt'}})
 const next=events.next(),before=f.snapshot()
 try {
  let accepted=false
  const accept=f.peer.accept(f.frame).then(()=>{accepted=true})
  const received=await Promise.race([next,accept.then(()=>({missingDelivery:true}))])
  expect(received.missingDelivery).not.toBe(true);expect(received.value.type).toBe('provider_turn.updated');expect(accepted).toBe(false)
  expect(f.hub.identity(received.value)).toBe(customerCommandId(f.session.sessionId,'event',[f.session.runtimeEpoch,1]))
  await f.hub.acknowledge(received.value);await accept
  expect(accepted).toBe(true);expect(f.snapshot()).toEqual(before)
  expect(f.sent.at(-1)).toEqual({type:'ack',sessionId:f.session.sessionId,runtimeEpoch:f.session.runtimeEpoch,seq:1})
 }finally{controller.abort();await events.return();await f.close()}
})

it('同slot相同正文等待一次交付，改变正文或同scope第二seq不能覆盖原槽',async()=>{
 const f=await fixture(),abort=new AbortController(),events=f.hub.events(f.session.sessionId,abort.signal)
 f.journal.receive(f.session.sessionId,f.session.runtimeEpoch,[{seq:2,event:f.event}]);f.journal.applied(f.session.sessionId,f.session.runtimeEpoch,2)
 const next=events.next(),before=f.snapshot()
 try {
  const first=f.peer.accept(f.frame),second=f.peer.accept(structuredClone(f.frame)),received=await next
  const changed=structuredClone(f.frame);changed.events[0].event.providerTurn.status='completed'
  await expect(f.peer.accept(changed)).rejects.toMatchObject({code:'EVENT_RETRY_CONFLICT'})
  const nextSeq=structuredClone(f.frame);nextSeq.events[0].seq=2
  await expect(f.peer.accept(nextSeq)).rejects.toMatchObject({code:'EVENT_RETRY_BUSY'})
  await f.hub.acknowledge(received.value);await Promise.all([first,second]);expect(f.snapshot()).toEqual(before)
 }finally{abort.abort();await events.return();await f.close()}
})

it.each(['disconnect','close','epoch','detach'])('原终态%s结束等待，迟到ack不能改写原SQLite',async mode=>{
 const f=await fixture(),abort=new AbortController(),events=f.hub.events(f.session.sessionId,abort.signal),next=events.next(),before=f.snapshot()
 try {
  const pending=f.peer.accept(f.frame),rejected=expect(pending).rejects.toMatchObject({code:'EVENT_RETRY_CANCELLED'}),received=await next
  if(mode==='disconnect')f.peer.disconnect()
  if(mode==='close')f.hub.close()
  if(mode==='epoch')f.hub.update(f.session.sessionId,{runtimeEpoch:'next-epoch'})
  if(mode==='detach'){abort.abort();await events.return()}
  await rejected;await expect(f.hub.acknowledge(received.value)).rejects.toMatchObject({code:'EVENT_RETRY_CANCELLED'})
  if(mode==='epoch')f.hub.update(f.session.sessionId,{runtimeEpoch:f.session.runtimeEpoch})
  expect(f.snapshot()).toEqual(before)
 }finally{abort.abort();await events.return();await f.close()}
})

it('原终态确认超时只拒绝等待，没有确认applied或修改原账本',async()=>{
 const f=await fixture(),abort=new AbortController(),events=f.hub.events(f.session.sessionId,abort.signal),next=events.next(),before=f.snapshot()
 vi.useFakeTimers()
 try {
  const pending=f.peer.accept(f.frame),rejected=expect(pending).rejects.toMatchObject({code:'EVENT_RETRY_TIMEOUT'}),received=await next
  await vi.advanceTimersByTimeAsync(20_000);await rejected
  await expect(f.hub.acknowledge(received.value)).rejects.toMatchObject({code:'EVENT_RETRY_CANCELLED'});expect(f.snapshot()).toEqual(before)
 }finally{vi.useRealTimers();abort.abort();await events.return();await f.close()}
})

it('旧非终态重复仅回复原ACK；未知轮次及跨代次终态仍拒绝',async()=>{
 const f=await fixture(),before=f.snapshot()
 try {
  const running=structuredClone(f.frame);running.events[0].event.providerTurn.status='running';running.events[0].event.providerTurn.completedAt=null
  await f.peer.accept(running)
  const unknown=structuredClone(f.frame);unknown.events[0].event.providerTurn.id=derive.providerTurn({driver:'codex',nativeTurnId:`customer:customer-${f.f.machine.deviceId}-codex:${f.f.oldThread}:another`})
  await expect(f.peer.accept(unknown)).rejects.toMatchObject({code:'EVENT_RETRY_SCOPE'})
  await expect(f.peer.accept({...f.frame,runtimeEpoch:'foreign'})).rejects.toMatchObject({code:'RUNTIME_EPOCH'})
  expect(f.snapshot()).toEqual(before)
 }finally{await f.close()}
})

it('全局最多16个原终态等待槽，服务关闭明确拒绝全部等待且完整SQLite保持',async()=>{
 const f=await fixture(),pending=[]
 try {
  for(let n=0;n<17;n++) {
   const session={...f.session,sessionId:`original-session-${n}`};f.journal.saveSession(session);f.journal.receive(session.sessionId,session.runtimeEpoch,[{seq:1,event:f.event}]);f.journal.applied(session.sessionId,session.runtimeEpoch,1)
  }
  const before=f.snapshot()
  for(let n=0;n<16;n++)pending.push(expect(f.peer.accept({...f.frame,sessionId:`original-session-${n}`})).rejects.toMatchObject({code:'EVENT_RETRY_CANCELLED'}))
  await expect(f.peer.accept({...f.frame,sessionId:'original-session-16'})).rejects.toMatchObject({code:'EVENT_RETRY_BUSY'})
  f.hub.close();await Promise.all(pending);expect(f.snapshot()).toEqual(before)
 }finally{await f.close()}
})
