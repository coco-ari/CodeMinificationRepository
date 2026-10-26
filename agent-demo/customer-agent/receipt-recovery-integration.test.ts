import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type IncomingMessage} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {NodeWS} from '../../vendor/t3code/apps/server/node_modules/@effect/platform-node-shared/dist/NodeSocket.js';
import {decodeCustomerAgentClientFrame,type CustomerAgentCommand,type CustomerAgentClientFrame,type CustomerAgentServerFrame} from '../../vendor/t3code/packages/contracts/src/autoopsRemote.ts';
import {RemoteDeviceHub} from '../../vendor/t3code/apps/server/src/autoops/RemoteDeviceService.ts';
import {createCustomerRegistry} from '../t3-adapters/customer-registry.mjs';
import {createCustomerTransportJournal} from '../t3-adapters/customer-transport.mjs';
import {CustomerAgentStore} from './store.ts';
import {CustomerAgentConnection} from './connection.ts';

async function recoverOriginalReceipt(options:{nativeTurnId:string|null;activity?:'same'|'other'}){
  const root=mkdtempSync(join(tmpdir(),'autoops-original-receipt-')),directory=join(root,'source');mkdirSync(directory);
  const store=new CustomerAgentStore(join(root,'state')),registryDb=new DatabaseSync(':memory:'),transportDb=new DatabaseSync(':memory:');
  const registry=createCustomerRegistry({db:registryDb,enabled:()=>true,requireOwner(){},requireProjectForUser(){}});
  const paired=registry.consumePairing(registry.createPairing('provider').pairingCode,{label:'原收据隔离测试'}),principal=registry.authenticateToken(paired.deviceToken);
  const workspace=store.register(directory,'source-project','原目录');store.markPublished(workspace.registeredWorkspaceId);
  registry.registerWorkspace(principal,{registeredWorkspaceId:workspace.registeredWorkspaceId,projectId:workspace.projectId,label:workspace.label,workspaceBindingRevision:1,runtimeId:'codex'});
  const target={registeredWorkspaceId:workspace.registeredWorkspaceId,workspaceBindingRevision:1,runtimeId:'codex' as const};
  const command={type:'command',commandId:'original-resume',sessionId:'original-session',target,method:'resumeThread',runtimeEpoch:'original-epoch',input:{}} satisfies CustomerAgentCommand;
  store.saveSession({sessionId:command.sessionId,runtimeEpoch:command.runtimeEpoch!,workspaceId:workspace.registeredWorkspaceId,state:'unknown',nativeThreadId:'original-native-thread',nativeTurnId:options.nativeTurnId,runId:null,attemptId:null});
  store.accept(command);store.resolveStopped(command.sessionId,true);
  const original=store.queryReceipt(command.commandId,command.sessionId)!;
  assert.equal(original.runtimeEpoch,undefined);assert.equal(original.error?.code,'CUSTOMER_MANUALLY_RECONCILED');
  if(!options.activity){store.revoke(workspace.registeredWorkspaceId);registry.revokeWorkspace(principal,workspace.registeredWorkspaceId)}
  const journal=createCustomerTransportJournal(transportDb);
  journal.saveSession({sessionId:command.sessionId,threadId:'revoked-thread',ownerId:'provider',projectId:workspace.projectId,deviceId:paired.device.id,target,runtimeEpoch:command.runtimeEpoch,state:'unknown'});
  journal.saveCommand(command);journal.saveReceipt({type:'receipt',commandId:command.commandId,sessionId:command.sessionId,state:'unknown'});
  let executionChecks=0,nativeStarts=0;
  const hub=new RemoteDeviceHub({assertAccepting(){},customerRegistry:registry,getThreadBinding(){return undefined},requireSharedExecutionScope(){executionChecks++;throw Error('撤回不允许执行')}} as never,journal);
  const server=createServer(),wss=new NodeWS.WebSocketServer({server}),done=Promise.withResolvers<void>();
  const sent:CustomerAgentServerFrame[]=[],received:CustomerAgentClientFrame[]=[];
  let originalError:string|undefined;
  wss.on('connection',(socket:InstanceType<typeof NodeWS.WebSocket>,request:IncomingMessage)=>{
    const actual=registry.authenticateToken(request.headers.authorization?.slice(7)??'');
    const peer=hub.connect(actual,async frame=>{sent.push(frame);socket.send(JSON.stringify(frame))},()=>socket.close());
    socket.on('message',(raw:unknown)=>{
      const frame=decodeCustomerAgentClientFrame(String(raw));received.push(frame);
      if(frame.type==='receipt'&&frame.commandId!==command.commandId)return;
      void peer.accept(frame).then(()=>{if(frame.type==='receipt'&&frame.state==='failed')done.resolve()},error=>{
        if(options.activity==='same'&&frame.type==='receipt'&&frame.commandId===command.commandId){originalError=error.code;done.resolve()}else done.reject(error)
      });
    });
    socket.on('close',()=>peer.disconnect());
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const opening=Promise.withResolvers<never>(),entered=Promise.withResolvers<void>();
  const connection=new CustomerAgentConnection({store,credentials:{deviceId:paired.device.id,token:paired.deviceToken,baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`},runnerFactory:async()=>{nativeStarts++;if(options.activity){entered.resolve();return opening.promise}throw Error('查询原收据不能启动原生执行')}});
  let pending:Promise<unknown>|undefined;
  try{
    if(options.activity){pending=connection.executor.execute({...command,commandId:'pending-local-open',sessionId:options.activity==='same'?command.sessionId:'other-session',method:'openSession'});await entered.promise}
    connection.start();await done.promise;
    assert.equal(received.find(frame=>frame.type==='hello')?.receiptQueries,true);
    assert.deepEqual(sent.filter(frame=>frame.type==='receiptQuery'),[{type:'receiptQuery',commandId:command.commandId,sessionId:command.sessionId}]);
    assert.equal(sent.filter(frame=>frame.type==='command').length,0);
    if(options.activity==='same'){
      assert.equal(originalError,'RUNTIME_EPOCH','同session仍有在途受管入口，不得补出已停止原代次');
      assert.equal(journal.command(command.commandId)?.receipt?.state,'unknown');
    }else{
      assert.equal(journal.command(command.commandId)?.receipt?.state,'failed');
      assert.equal(journal.command(command.commandId)?.receipt?.runtimeEpoch,command.runtimeEpoch);
    }
    assert.deepEqual(store.queryReceipt(command.commandId,command.sessionId),original);
    assert.equal(store.pendingReceipts().length,options.activity?1:0);assert.equal(journal.pendingCommands(command.sessionId).length,0);
    assert.equal(executionChecks,0);assert.equal(nativeStarts,options.activity?1:0);
    assert.equal(transportDb.prepare('SELECT count(*) n FROM customer_transport_commands').get()?.n,1);
  }finally{
    if(options.activity){opening.reject(Error('仅关闭本测试持有的受管入口'));await pending}
    await connection.close();hub.close();for(const socket of wss.clients)socket.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));
    store.close();registryDb.close();transportDb.close();rmSync(root,{recursive:true,force:true});
  }
}

test('真实WS恢复撤回目录的原人工失败收据，不重发执行、不改本机原账本或伪造新结果',{timeout:15000},()=>recoverOriginalReceipt({nativeTurnId:null}));
test('真实WS保留历史nativeTurn引用仍可恢复同代次原人工失败收据',{timeout:15000},()=>recoverOriginalReceipt({nativeTurnId:'finished-native-turn'}));
test('真实WS同session受管入口尚在建立时不补原epoch，不把idle字段当停止证明',{timeout:15000},()=>recoverOriginalReceipt({nativeTurnId:null,activity:'same'}));
test('真实WS另一session在建立不阻断已停止原session收据恢复',{timeout:15000},()=>recoverOriginalReceipt({nativeTurnId:'finished-native-turn',activity:'other'}));
