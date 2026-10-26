import {expect,it} from 'vite-plus/test';
import {DatabaseSync} from 'node:sqlite';
import {RemoteDeviceHub} from './RemoteDeviceService.ts';
import {createCustomerTransportJournal} from '../../../../../../agent-demo/t3-adapters/customer-transport.mjs';

function fixture(options:{shared?:boolean;terminal?:'completed'|'failed'}={}){
  const db=new DatabaseSync(':memory:'),journal=createCustomerTransportJournal(db),sent:unknown[]=[];
  let executionChecks=0;
  const registry={resetPresence(){},markConnected:()=>({connectionEpoch:1}),markHeartbeat(){},markDisconnected(){},listWorkspaces:()=>[],validateTarget(){executionChecks++;throw Error('已撤回来源，不能新执行')}};
  const hub=new RemoteDeviceHub({assertAccepting(){},customerRegistry:registry,requireSharedExecutionScope(){executionChecks++;throw Error('已撤回共享，不能新执行')}} as never,journal);
  const session={sessionId:'original-session',deviceId:'original-device',ownerId:'caller',providerId:'provider',projectId:'business',threadId:'revoked-thread',runtimeEpoch:'original-epoch',state:'unknown' as const,target:{registeredWorkspaceId:'revoked-workspace',workspaceBindingRevision:1,runtimeId:'codex' as const}};
  journal.saveSession(session);
  const grant=options.shared?{grantId:'original-grant'}:{};
  const command={type:'command' as const,commandId:'original-command',sessionId:session.sessionId,target:session.target,method:'resumeThread',runtimeEpoch:session.runtimeEpoch,input:{},...(options.shared?{executionScope:{grantId:'original-grant'} as never}:{})};
  journal.saveCommand(command);journal.saveReceipt({type:'receipt',commandId:command.commandId,sessionId:session.sessionId,state:options.terminal??'unknown',...grant});
  const principal={deviceId:session.deviceId,ownerId:'provider'};
  const connect=(identity=principal)=>hub.connect(identity as never,async frame=>{sent.push(frame)},()=>{});
  const connection=connect();
  const hello=(peer=connection,options:{support?:boolean;epoch?:string;state?:'idle'|'active'|'unknown'}={})=>peer.accept({type:'hello',protocolVersion:1,deviceId:session.deviceId,connectorVersion:'test',connectorEpoch:'test-connection',receiptQueries:options.support??true,workspaces:[],sessions:[{sessionId:session.sessionId,runtimeEpoch:options.epoch??session.runtimeEpoch,state:options.state??'idle',live:false,lastSeq:0}]} as never);
  const receipt={type:'receipt' as const,commandId:command.commandId,sessionId:session.sessionId,state:'failed' as const,runtimeEpoch:session.runtimeEpoch,...grant,error:{code:'CUSTOMER_MANUALLY_RECONCILED',message:'提供者已核实原进程停止，不重做'}};
  return{db,journal,hub,session,command,connection,connect,hello,receipt,sent,checks:()=>executionChecks,close(){hub.close();db.close()}};
}

it('撤回会话的原unknown仅查询原收据，同设备代次人工失败可收束，绝不重发执行',async()=>{
  const f=fixture();try{
    await f.hello();expect(f.sent).toContainEqual({type:'receiptQuery',commandId:f.command.commandId,sessionId:f.session.sessionId});
    expect(f.sent.some(frame=>(frame as {type:string}).type==='command')).toBe(false);
    await f.connection.accept(f.receipt);expect(f.journal.command(f.command.commandId)?.receipt?.state).toBe('failed');expect(f.checks()).toBe(0);
    expect(f.journal.session(f.session.sessionId)?.state).toBe('unknown');
    await f.connection.accept({...f.receipt,state:'completed',result:{forged:true}});expect(f.journal.command(f.command.commandId)?.receipt?.state).toBe('failed');
  }finally{f.close()}
});

it('共享原grant撤回后仍仅查询原事实，错误grant拒绝且正确失败不会恢复会话执行权',async()=>{
  const f=fixture({shared:true});try{
    await f.hello();expect(f.sent).toContainEqual({type:'receiptQuery',commandId:f.command.commandId,sessionId:f.session.sessionId,grantId:'original-grant'});
    await expect(f.connection.accept({...f.receipt,grantId:'new-grant'})).rejects.toMatchObject({code:'RECEIPT_SCOPE_CHANGED'});
    await f.connection.accept(f.receipt);
    expect(f.journal.command(f.command.commandId)?.receipt).toEqual(f.receipt);
    expect(f.journal.session(f.session.sessionId)?.state).toBe('unknown');expect(f.checks()).toBe(0);
    expect(f.sent.some(frame=>(frame as {type:string}).type==='command')).toBe(false);
  }finally{f.close()}
});

it('未查询、错误session/grant/epoch及自报completed均不能收束原unknown',async()=>{
  const f=fixture();try{
    await f.hello(f.connection,{support:false});
    await expect(f.connection.accept(f.receipt)).rejects.toMatchObject({code:'RECEIPT_QUERY_REQUIRED'});
    const newer=f.connect();await f.hello(newer);
    await expect(newer.accept({...f.receipt,sessionId:'other-session'})).rejects.toMatchObject({code:'SESSION_SCOPE'});
    await expect(newer.accept({...f.receipt,grantId:'other-grant'})).rejects.toMatchObject({code:'RECEIPT_SCOPE_CHANGED'});
    await expect(newer.accept({...f.receipt,runtimeEpoch:'new-generation'})).rejects.toMatchObject({code:'RUNTIME_EPOCH'});
    await newer.accept({...f.receipt,state:'completed',result:{forged:true}});expect(f.journal.command(f.command.commandId)?.receipt?.state).toBe('unknown');
    await expect(f.connection.accept(f.receipt)).rejects.toMatchObject({code:'STALE_CONNECTION'});
    await newer.accept(f.receipt);expect(f.journal.command(f.command.commandId)?.receipt?.state).toBe('failed');
  }finally{f.close()}
});

it('错误结构和运行中报告保留unknown，旧连接程序仅得到升级提示',async()=>{
  const f=fixture();try{
    await f.hello(f.connection,{support:false});expect(f.sent).toContainEqual(expect.objectContaining({type:'error',code:'RECEIPT_QUERY_UPDATE_REQUIRED'}));
    const active=f.connect();await f.hello(active,{state:'active'});await expect(active.accept(f.receipt)).rejects.toMatchObject({code:'RECEIPT_QUERY_REQUIRED'});
    const idle=f.connect();await f.hello(idle);
    for(const changed of [{result:{}},{error:{code:'CUSTOMER_MANUALLY_RECONCILED',message:''}},{error:{code:'CUSTOMER_MANUALLY_RECONCILED',message:'x'.repeat(2001)}},{error:{code:'runtime_error',message:'不能猜停止'}}]){
      await expect(idle.accept({...f.receipt,...changed})).rejects.toMatchObject({code:'RECEIPT_RECONCILIATION_INVALID'});
      expect(f.journal.command(f.command.commandId)?.receipt?.state).toBe('unknown');
    }
  }finally{f.close()}
});

it('另一设备不能取得原查询或提交原收据，错误握手代次也不能收束',async()=>{
  const f=fixture();try{
    const foreign=f.connect({deviceId:'foreign-device',ownerId:'provider'});
    await foreign.accept({type:'hello',protocolVersion:1,deviceId:'foreign-device',connectorVersion:'test',connectorEpoch:'foreign',receiptQueries:true,workspaces:[],sessions:[{sessionId:f.session.sessionId,runtimeEpoch:f.session.runtimeEpoch,state:'idle'}]} as never);
    expect(f.sent.some(frame=>(frame as {type:string}).type==='receiptQuery')).toBe(false);
    await expect(foreign.accept(f.receipt)).rejects.toMatchObject({code:'SESSION_SCOPE'});
    const newer=f.connect();await f.hello(newer,{epoch:'other-epoch'});
    await expect(newer.accept(f.receipt)).rejects.toMatchObject({code:'RECEIPT_QUERY_REQUIRED'});
    expect(f.journal.command(f.command.commandId)?.receipt?.state).toBe('unknown');
  }finally{f.close()}
});

it('已completed或failed命令不查询也不允许人工失败改写',async()=>{
  for(const terminal of ['completed','failed'] as const){
    const f=fixture({shared:true,terminal});try{
      const original=f.journal.command(f.command.commandId)?.receipt;
      await f.hello();expect(f.sent.some(frame=>(frame as {type:string}).type==='receiptQuery')).toBe(false);
      await f.connection.accept(f.receipt);expect(f.journal.command(f.command.commandId)?.receipt).toEqual(original);
      expect(f.sent.some(frame=>(frame as {type:string}).type==='command')).toBe(false);
    }finally{f.close()}
  }
});
