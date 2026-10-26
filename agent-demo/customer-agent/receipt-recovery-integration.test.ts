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

test('真实WS恢复撤回目录的原人工失败收据，不重发执行、不改本机原账本或伪造新结果',{timeout:15000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'autoops-original-receipt-')),directory=join(root,'source');mkdirSync(directory);
  const store=new CustomerAgentStore(join(root,'state')),registryDb=new DatabaseSync(':memory:'),transportDb=new DatabaseSync(':memory:');
  const registry=createCustomerRegistry({db:registryDb,enabled:()=>true,requireOwner(){},requireProjectForUser(){}});
  const paired=registry.consumePairing(registry.createPairing('provider').pairingCode,{label:'原收据隔离测试'}),principal=registry.authenticateToken(paired.deviceToken);
  const workspace=store.register(directory,'source-project','原目录');store.markPublished(workspace.registeredWorkspaceId);
  registry.registerWorkspace(principal,{registeredWorkspaceId:workspace.registeredWorkspaceId,projectId:workspace.projectId,label:workspace.label,workspaceBindingRevision:1,runtimeId:'codex'});
  const target={registeredWorkspaceId:workspace.registeredWorkspaceId,workspaceBindingRevision:1,runtimeId:'codex' as const};
  const command={type:'command',commandId:'original-resume',sessionId:'original-session',target,method:'resumeThread',runtimeEpoch:'original-epoch',input:{}} satisfies CustomerAgentCommand;
  store.saveSession({sessionId:command.sessionId,runtimeEpoch:command.runtimeEpoch!,workspaceId:workspace.registeredWorkspaceId,state:'unknown',nativeThreadId:'original-native-thread',nativeTurnId:null,runId:null,attemptId:null});
  store.accept(command);store.resolveStopped(command.sessionId,true);
  const original=store.queryReceipt(command.commandId,command.sessionId)!;
  assert.equal(original.runtimeEpoch,undefined);assert.equal(original.error?.code,'CUSTOMER_MANUALLY_RECONCILED');
  store.revoke(workspace.registeredWorkspaceId);registry.revokeWorkspace(principal,workspace.registeredWorkspaceId);
  const journal=createCustomerTransportJournal(transportDb);
  journal.saveSession({sessionId:command.sessionId,threadId:'revoked-thread',ownerId:'provider',projectId:workspace.projectId,deviceId:paired.device.id,target,runtimeEpoch:command.runtimeEpoch,state:'unknown'});
  journal.saveCommand(command);journal.saveReceipt({type:'receipt',commandId:command.commandId,sessionId:command.sessionId,state:'unknown'});
  let executionChecks=0,nativeStarts=0;
  const hub=new RemoteDeviceHub({assertAccepting(){},customerRegistry:registry,getThreadBinding(){return undefined},requireSharedExecutionScope(){executionChecks++;throw Error('撤回不允许执行')}} as never,journal);
  const server=createServer(),wss=new NodeWS.WebSocketServer({server}),done=Promise.withResolvers<void>();
  const sent:CustomerAgentServerFrame[]=[],received:CustomerAgentClientFrame[]=[];
  wss.on('connection',(socket:InstanceType<typeof NodeWS.WebSocket>,request:IncomingMessage)=>{
    const actual=registry.authenticateToken(request.headers.authorization?.slice(7)??'');
    const peer=hub.connect(actual,async frame=>{sent.push(frame);socket.send(JSON.stringify(frame))},()=>socket.close());
    socket.on('message',(raw:unknown)=>{
      const frame=decodeCustomerAgentClientFrame(String(raw));received.push(frame);
      void peer.accept(frame).then(()=>{if(frame.type==='receipt'&&frame.state==='failed')done.resolve()},done.reject);
    });
    socket.on('close',()=>peer.disconnect());
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const connection=new CustomerAgentConnection({store,credentials:{deviceId:paired.device.id,token:paired.deviceToken,baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`},runnerFactory:async()=>{nativeStarts++;throw Error('查询原收据不能启动原生执行')}});
  try{
    connection.start();await done.promise;
    assert.equal(received.find(frame=>frame.type==='hello')?.receiptQueries,true);
    assert.deepEqual(sent.filter(frame=>frame.type==='receiptQuery'),[{type:'receiptQuery',commandId:command.commandId,sessionId:command.sessionId}]);
    assert.equal(sent.filter(frame=>frame.type==='command').length,0);
    assert.equal(journal.command(command.commandId)?.receipt?.state,'failed');
    assert.equal(journal.command(command.commandId)?.receipt?.runtimeEpoch,command.runtimeEpoch);
    assert.deepEqual(store.queryReceipt(command.commandId,command.sessionId),original);
    assert.equal(store.pendingReceipts().length,0);assert.equal(journal.pendingCommands(command.sessionId).length,0);
    assert.equal(executionChecks,0);assert.equal(nativeStarts,0);
    assert.equal(transportDb.prepare('SELECT count(*) n FROM customer_transport_commands').get()?.n,1);
  }finally{
    await connection.close();hub.close();for(const socket of wss.clients)socket.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));
    store.close();registryDb.close();transportDb.close();rmSync(root,{recursive:true,force:true});
  }
});
