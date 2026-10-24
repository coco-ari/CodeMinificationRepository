import { CustomerAttachmentDelivery } from './CustomerAttachmentDelivery.ts';
import { customerMessageAttachments } from '../../../../packages/contracts/src/customerAttachments.ts';
import { ServerConfig } from '../config.ts';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { SKILL_MENTION_PATTERN } from '@t3tools/shared/composerInlineTokens';
import { ProviderAdapterV2Event } from '@t3tools/provider-core/server/ProviderAdapter';
import { validateCustomerEvent, validateCustomerResult } from './CustomerEventValidation.ts';
export { validateCustomerEvent } from './CustomerEventValidation.ts';
import type { CustomerAgentClientFrame, CustomerAgentServerFrame, CustomerAgentMethod } from '../../../../packages/contracts/src/autoopsRemote.ts';
import { configuredAutoOpsAccess, type AutoOpsAccess, type ThreadBinding } from '../../../../../../agent-demo/t3-adapters/access.mjs';
import type { CustomerDevicePrincipal } from '../../../../../../agent-demo/t3-adapters/customer-registry.mjs';
import { customerProviderInstanceId,customerWorkspaceKey } from '../../../../../../agent-demo/t3-adapters/customer-target.mjs';
import { createCustomerTransportJournal, customerCommandId, CustomerTransportError, type CustomerTransportJournal, type TransportSession, type TransportReceipt } from '../../../../../../agent-demo/t3-adapters/customer-transport.mjs';

type Send = (frame: CustomerAgentServerFrame) => Promise<void>;
type Connection = { principal:CustomerDevicePrincipal; epoch:number; connectorEpoch?:string; attachmentTransfers?:boolean; send:Send; hello:boolean; sessions:Map<string,{runtimeEpoch:string;state:string;live?:boolean|undefined;lastSeq?:number|undefined}>; close:()=>void };
type Delivery = {sessionId:string;epoch:string;seq:number};
const error = (code:string,message:string) => new CustomerTransportError(code,message);
export class RemoteDeviceHub {
  readonly access:AutoOpsAccess;
  readonly journal:CustomerTransportJournal;
  private readonly connections=new Map<string,Connection>();
  private readonly signals=new EventEmitter();
  private readonly metadata=new WeakMap<object,Delivery>();
  private readonly waiters=new Map<string,Set<(receipt:TransportReceipt)=>void>>();
  private readonly attachments:CustomerAttachmentDelivery|undefined;
  constructor(access:AutoOpsAccess,journal:CustomerTransportJournal,attachments?:CustomerAttachmentDelivery) {this.attachments=attachments;this.access=access;this.journal=journal;this.signals.setMaxListeners(0);access.customerRegistry.resetPresence();}
  session(id:string) {return this.journal.session(id);}
  hasDispatchedRun(sessionId:string,runId:string,attemptId:string) {
    return Boolean(this.journal.command(customerCommandId(sessionId,'startTurn',[runId,attemptId])));
  }
  enqueueInterrupt(sessionId:string,providerThread:unknown,providerTurnId:string) {
    const session=this.journal.session(sessionId);if(!session?.runtimeEpoch)throw error('RUNTIME_EPOCH','客户运行代次尚未确认');
    const thread=validateCustomerResult(session,'ensureThread',providerThread);
    if(!session.providerTurnBindings?.some(turn=>turn.id===providerTurnId))throw error('TURN_SCOPE','客户轮次尚未确认');
    const commandId=customerCommandId(sessionId,'interruptTurn',[providerTurnId]);
    const prior=this.journal.command(commandId);
    const command=prior?.command??{type:'command' as const,commandId,sessionId,target:session.target,method:'interruptTurn',runtimeEpoch:session.runtimeEpoch,input:{providerThread:thread,providerTurnId}};
    this.journal.saveCommand(command);
    if(!prior?.receipt||prior.receipt.state==='accepted')void this.connections.get(session.deviceId)?.send(command as CustomerAgentServerFrame).catch(()=>undefined);
    return commandId;
  }
  clearPendingInterrupt(sessionId:string,attemptId:string) {
    const session=this.session(sessionId);
    if(session?.pendingInterrupt?.attemptId!==attemptId)return;
    delete session.pendingInterrupt;this.journal.saveSession(session);
  }
  async acquireWorkspace(threadId:string,runId:string,signal?:AbortSignal) {
    this.access.assertAccepting();
    const binding=this.access.getThreadBinding(threadId);if(binding?.executionBinding.kind!=='customer')throw error('NOT_CUSTOMER','客户对话绑定不存在');
    const key=customerWorkspaceKey(binding.executionBinding);
    await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{this.signals.off(`lease:${key}`,tryAcquire);signal?.removeEventListener('abort',abort);};
      const tryAcquire=()=>{if(this.journal.acquireWorkspace(key,threadId,runId)){cleanup();resolve();}};
      const abort=()=>{cleanup();reject(error('WAIT_CANCELLED','已取消等待客户工作区；没有因此停止其他任务'));};
      this.signals.on(`lease:${key}`,tryAcquire);signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();else tryAcquire();
    });
  }
  releaseWorkspace(threadId:string,runId:string,options?:{onlyIfNotDispatched:true}) {
    const binding=this.access.getThreadBinding(threadId);if(binding?.executionBinding.kind!=='customer')return;
    if(options?.onlyIfNotDispatched)for(const session of this.journal.sessions(binding.executionBinding.deviceId)) {
      const run=session.threadId===threadId?session.runs?.find(value=>value.runId===runId):undefined;
      if(run&&this.journal.command(customerCommandId(session.sessionId,'startTurn',[runId,run.attemptId])))return;
    }
    const key=customerWorkspaceKey(binding.executionBinding);
    if(this.journal.releaseWorkspace(key,runId))this.signals.emit(`lease:${key}`);
  }
  runtimeState(sessionId:string) {const saved=this.session(sessionId);return saved?this.connections.get(saved.deviceId)?.sessions.get(sessionId):undefined;}
  connectorEpoch(deviceId:string) {return this.connections.get(deviceId)?.connectorEpoch;}
  subscribeSession(listener:(sessionId:string)=>void) {this.signals.on('session-state',listener);return ()=>this.signals.off('session-state',listener);}
  async awaitOnline(sessionId:string,signal?:AbortSignal) {
    const saved=this.session(sessionId);if(!saved)throw error('SESSION_MISSING','客户会话尚未绑定');
    if(this.online(saved.deviceId))return;
    await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{this.signals.off('connection',changed);signal?.removeEventListener('abort',abort);};
      const changed=()=>{if(this.online(saved.deviceId)){cleanup();resolve();}};
      const abort=()=>{cleanup();reject(error('WAIT_CANCELLED','中心结束了等待，客户执行不受此影响'));};
      this.signals.on('connection',changed);signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();else changed();
    });
  }
  async awaitInboxDrained(sessionId:string,signal?:AbortSignal) {
    await this.awaitOnline(sessionId,signal);
    await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{this.signals.off(`applied:${sessionId}`,changed);this.signals.off(sessionId,changed);this.signals.off('connection',changed);signal?.removeEventListener('abort',abort);};
      const fail=(code:string,message:string)=>{cleanup();reject(error(code,message));};
      const changed=()=>{
        const saved=this.session(sessionId);if(!saved?.runtimeEpoch){cleanup();resolve();return;}
        const reported=this.runtimeState(sessionId);
        if(!reported)return;
        if(reported.runtimeEpoch!==saved.runtimeEpoch)return fail('RUNTIME_EPOCH','旧运行代次尚未完成对账，不能建立新的运行器');
        if(!Number.isSafeInteger(reported.lastSeq))return fail('CONNECTOR_UPDATE_REQUIRED','请更新客户连接程序后再恢复会话');
        const cursor=this.journal.cursor(sessionId,saved.runtimeEpoch);
        const tail=Math.max(reported.lastSeq!,cursor.received);
        if(cursor.received>=tail&&cursor.applied>=tail){cleanup();resolve();}
      };
      const abort=()=>fail('WAIT_CANCELLED','已取消等待旧事件入库；没有重新启动客户任务');
      this.signals.on(`applied:${sessionId}`,changed);this.signals.on(sessionId,changed);this.signals.on('connection',changed);signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();else changed();
    });
  }
  online(deviceId:string) {return this.connections.get(deviceId)?.hello===true;}
  identity(event:ProviderAdapterV2Event) {const delivery=this.metadata.get(event);return delivery?customerCommandId(delivery.sessionId,'event',[delivery.epoch,delivery.seq]):undefined;}
  async acknowledge(event:ProviderAdapterV2Event) {
    const delivery=this.metadata.get(event);if(!delivery)return;
    const saved=this.journal.session(delivery.sessionId);
    const pending=saved?.pendingInterrupt;
    if(saved&&pending&&event.type==='provider_turn.updated'&&event.providerTurn.runAttemptId===pending.attemptId) {
      const start=this.journal.command(customerCommandId(saved.sessionId,'startTurn',[pending.runId,pending.attemptId]));
      const thread=(start?.command.input as {providerThread?:unknown}|undefined)?.providerThread;
      if(thread){this.enqueueInterrupt(saved.sessionId,thread,event.providerTurn.id);this.clearPendingInterrupt(saved.sessionId,pending.attemptId);}
    }
    if(saved&&pending&&event.type==='turn.terminal'&&saved.runs?.some(run=>run.runId===pending.runId&&run.runOrdinal===event.runOrdinal))this.clearPendingInterrupt(saved.sessionId,pending.attemptId);
    const seq=this.journal.applied(delivery.sessionId,delivery.epoch,delivery.seq);
    this.signals.emit(`applied:${delivery.sessionId}`);
    const session=this.journal.session(delivery.sessionId);
    if(event.type==='turn.terminal'&&session){const run=session.runs?.find(run=>run.runOrdinal===event.runOrdinal);if(run)this.releaseWorkspace(session.threadId,run.runId);}
    if(session)await this.connections.get(session.deviceId)?.send({type:'ack',sessionId:delivery.sessionId,runtimeEpoch:delivery.epoch,seq}).catch(()=>undefined);
  }
  connect(principal:CustomerDevicePrincipal,send:Send,onClose:()=>void) {
    this.access.assertAccepting();
    const prior=this.connections.get(principal.deviceId);prior?.close();
    const {connectionEpoch}=this.access.customerRegistry.markConnected(principal);
    const connection:Connection={principal,epoch:connectionEpoch,send,hello:false,sessions:new Map(),close:onClose};
    this.connections.set(principal.deviceId,connection);
    const current=()=>{if(this.connections.get(principal.deviceId)!==connection)throw error('STALE_CONNECTION','旧设备连接已被替换');};
    return {
      accept:async(frame:CustomerAgentClientFrame)=>{
        current();
        this.access.customerRegistry.markHeartbeat(principal,connectionEpoch);
        if(frame.type==='hello') {
          if(connection.hello || frame.deviceId!==principal.deviceId)throw error('INVALID_HELLO','设备握手信息不匹配');
          // HTTP registration is authoritative; a hello cannot register a directory.
          connection.attachmentTransfers = frame.attachmentTransfers === true;
          const registered=this.access.customerRegistry.listWorkspaces(principal.ownerId);
          for(const workspace of frame.workspaces)if(!registered.some(item=>item.deviceId===principal.deviceId&&item.projectId===workspace.projectId&&item.registeredWorkspaceId===workspace.registeredWorkspaceId&&item.workspaceBindingRevision===workspace.workspaceBindingRevision&&item.runtimeId===workspace.runtimeId))throw error('WORKSPACE_SCOPE','客户设备声明了未登记的工作区');
          connection.hello=true;
          connection.connectorEpoch=frame.connectorEpoch;
          connection.sessions=new Map(frame.sessions.map(s=>[s.sessionId,s]));
          await send({type:'welcome',connectionEpoch:String(connectionEpoch)});
          for(const session of this.journal.sessions(principal.deviceId)) {
            const reported=connection.sessions.get(session.sessionId);
            if(reported&&reported.runtimeEpoch===session.runtimeEpoch) {
              await send({type:'replay',sessionId:session.sessionId,runtimeEpoch:reported.runtimeEpoch,afterSeq:this.journal.cursor(session.sessionId,reported.runtimeEpoch).received});
              // Only previously journaled commands are retried. The local ledger decides
              // accepted/completed/unknown; a new prompt is never synthesized here.
              for(const command of this.journal.pendingCommands(session.sessionId))await send(command as CustomerAgentServerFrame);
            }
          }
          for(const reported of frame.sessions) {
            const saved=this.session(reported.sessionId);
            if(saved?.deviceId===principal.deviceId) {
              if(reported.resolution && (saved.appliedResolution?.runId!==reported.resolution.runId || saved.appliedResolution?.attemptId!==reported.resolution.attemptId || saved.appliedResolution?.resolvedAt!==reported.resolution.resolvedAt)) {this.update(saved.sessionId,{resolution:reported.resolution,state:'unknown'});}
              else if(reported.state==='unknown')this.update(saved.sessionId,{state:'unknown'});
              this.signals.emit('session-state',saved.sessionId);
            }
          }
          this.signals.emit('connection',principal.deviceId);
          return;
        }
        if(!connection.hello)throw error('HELLO_REQUIRED','请先完成设备握手');
        if(frame.type==='ping') {await send({type:'pong',at:frame.at});return;}
        if(frame.type==='pong')return;
        const session=this.journal.session(frame.sessionId);
        if(!session || session.deviceId!==principal.deviceId || session.ownerId!==principal.ownerId)throw error('SESSION_SCOPE','客户会话不属于此设备');
        if(frame.type==='receipt') {
          const pending=this.journal.command(frame.commandId);
          if(!pending || pending.command.sessionId!==session.sessionId)throw error('COMMAND_SCOPE','客户回执不属于此会话');
          // A delayed replay of an already settled openSession must not roll a newer runtime back.
          if(pending.receipt&&['completed','failed','unknown'].includes(pending.receipt.state)) {
            for(const notify of this.waiters.get(frame.commandId)??[])notify(pending.receipt);
            this.signals.emit(session.sessionId);return;
          }
          if(frame.state==='completed'&&(!frame.runtimeEpoch||(pending.command.runtimeEpoch&&pending.command.runtimeEpoch!==frame.runtimeEpoch)))throw error('RUNTIME_EPOCH','客户完成回执缺少匹配的运行代次');
          if(pending.command.runtimeEpoch && frame.runtimeEpoch && pending.command.runtimeEpoch!==frame.runtimeEpoch)throw error('RUNTIME_EPOCH','客户回执运行代次不匹配');
          const admitted=frame.state==='completed'?{...frame,result:validateCustomerResult(session,pending.command.method,frame.result)}:frame;
          if(frame.runtimeEpoch && (!session.runtimeEpoch || pending.command.method==='openSession')) {
            session.runtimeEpoch=frame.runtimeEpoch;
            if(frame.state==='completed'&&pending.command.method==='openSession')session.providerSession=admitted.result;
            this.journal.saveSession(session);
            connection.sessions.set(session.sessionId,{runtimeEpoch:frame.runtimeEpoch,state:'active',live:true,lastSeq:0});
          }
          const receipt=this.journal.saveReceipt(admitted);
          this.journal.saveSession(session);
          this.signals.emit('session-state',session.sessionId);
          if(receipt.state==='failed'&&pending.command.method==='startTurn') {
            const runId=(pending.command.input as {runId?:string}).runId;if(runId)this.releaseWorkspace(session.threadId,runId);
          }
          for(const notify of this.waiters.get(frame.commandId)??[])notify(receipt);
          this.signals.emit(session.sessionId);
          return;
        }
        if(session.runtimeEpoch!==frame.runtimeEpoch)throw error('RUNTIME_EPOCH','客户事件运行代次不匹配');
        if(frame.type==='runtimeState') {
          this.update(session.sessionId,{state:'unknown'});
          connection.sessions.set(session.sessionId,{...connection.sessions.get(session.sessionId),runtimeEpoch:frame.runtimeEpoch,state:'unknown',live:true});
          this.signals.emit('session-state',session.sessionId);return;
        }
        if(frame.type==='delta') {
          const decoded=validateCustomerEvent(session,frame.event);
          if(decoded.type!=='command_output.delta')throw error('UNRELIABLE_EVENT','仅命令增量允许不可靠传输');
          this.signals.emit(`delta:${session.sessionId}`,decoded);return;
        }
        // Validate the whole frame before atomically admitting it to the transport inbox.
        for(const item of frame.events)validateCustomerEvent(session,item.event);
        try {this.journal.receive(session.sessionId,frame.runtimeEpoch,frame.events);}
        catch(cause) {if(cause instanceof CustomerTransportError&&cause.code==='EVENT_GAP') {await send({type:'replay',sessionId:session.sessionId,runtimeEpoch:frame.runtimeEpoch,afterSeq:this.journal.cursor(session.sessionId,frame.runtimeEpoch).received});return;}throw cause;}
        if(frame.events.some(item=>(item.event as {type?:string}).type==='turn.terminal'))session.state='idle';
        this.journal.saveSession(session);
        this.signals.emit(session.sessionId);
        // Duplicate batches can arrive after a lost ACK; reply with applied, never received.
        await send({type:'ack',sessionId:session.sessionId,runtimeEpoch:frame.runtimeEpoch,seq:this.journal.cursor(session.sessionId,frame.runtimeEpoch).applied});
      },
      disconnect:()=>{if(this.connections.get(principal.deviceId)!==connection)return;this.connections.delete(principal.deviceId);this.access.customerRegistry.markDisconnected(principal.deviceId,connectionEpoch);this.signals.emit('connection',principal.deviceId);},
    };
  }
  bind(binding:ThreadBinding,sessionId:string) {
    if(binding.executionBinding.kind!=='customer')throw error('NOT_CUSTOMER','这不是客户工作区');
    const {deviceId,...rest}=binding.executionBinding;
    const target={registeredWorkspaceId:rest.registeredWorkspaceId,workspaceBindingRevision:rest.workspaceBindingRevision,runtimeId:rest.runtimeId};
    const old=this.journal.session(sessionId);
    this.journal.saveSession({...old,sessionId,deviceId,ownerId:binding.ownerId,projectId:binding.projectId,threadId:binding.threadId,target});
  }
  update(sessionId:string,update:Partial<TransportSession>) {const session=this.journal.session(sessionId);if(!session)throw error('SESSION_MISSING','客户会话尚未绑定');this.journal.saveSession({...session,...update});if(update.pendingInterrupt)this.signals.emit('session-state',sessionId);}
  async readAttachment(principal:CustomerDevicePrincipal,commandId:string,attachmentId:string) {
    const saved=this.journal.command(commandId), session=saved && this.journal.session(saved.command.sessionId);
    if(!saved || !session || session.deviceId!==principal.deviceId || session.ownerId!==principal.ownerId || !this.attachments)throw error('ATTACHMENT_SCOPE','附件不属于此设备');
    this.access.customerRegistry.validateTarget(session.ownerId,session.projectId,{kind:'customer',deviceId:session.deviceId,...session.target});
    const binding=this.access.getThreadBinding(session.threadId);
    if(binding?.executionBinding.kind!=='customer' || binding.executionBinding.deviceId!==session.deviceId || binding.executionBinding.runtimeId!==session.target.runtimeId || customerWorkspaceKey(binding.executionBinding)!==customerWorkspaceKey({kind:'customer',deviceId:session.deviceId,...session.target}))throw error('ATTACHMENT_SCOPE','附件绑定已失效');
    const manifest=saved.command.attachments?.find(item=>item.id===attachmentId);
    const attachment=customerMessageAttachments(saved.command.input).find(item=>item.id===attachmentId);
    if(!manifest || !attachment)throw error('ATTACHMENT_SCOPE','原命令没有此附件');
    return (await this.attachments.read(session,attachment,manifest)).bytes;
  }
  async command(sessionId:string,method:CustomerAgentMethod,input:unknown,key:unknown,signal?:AbortSignal):Promise<unknown> {
    const session=this.journal.session(sessionId);if(!session)throw error('SESSION_MISSING','客户会话尚未绑定');
    const connection=this.connections.get(session.deviceId);
    const control=['interruptTurn','respondToRuntimeRequest'].includes(method);
    // 停止期间只允许已接受执行的控制及结果核对，不再下发新的执行命令。
    if (!control && method !== 'readThreadSnapshot') this.access.assertAccepting();
    if(!connection?.hello&&!control)throw error('DEVICE_OFFLINE','客户设备已离线，请等待重新连接');
    const target={kind:'customer' as const,deviceId:session.deviceId,...session.target};
    if(method!=='readThreadSnapshot')this.access.customerRegistry.validateTarget(session.ownerId,session.projectId,target,{requireOnline:!control});
    const commandId=customerCommandId(sessionId,method,key);
    const prior=this.journal.command(commandId);
    const requestedAttachments=['startTurn','steerTurn'].includes(method)?customerMessageAttachments(input):[];
    if(requestedAttachments.length && (!this.attachments || !connection?.attachmentTransfers))throw Object.assign(error('CONNECTOR_UPDATE_REQUIRED','请更新这台电脑的连接程序后发送附件'),{outcome:'not_started'});
    const attachments=!prior && requestedAttachments.length?await this.attachments!.prepare(session,input):undefined;
    if(signal?.aborted)throw Object.assign(error('WAIT_CANCELLED','已取消发送附件'),{outcome:'not_started'});
    const names=['startTurn','steerTurn'].includes(method)?[...new Set([...String((input as {message?:{text?:string}})?.message?.text??'').matchAll(SKILL_MENTION_PATTERN)].map(match=>match[2]!))]:[];
    const catalog=names.length?this.access.customerRegistry.getCapabilities(session.ownerId,target):undefined;
    const skillBindings=names.map(name=>{const matches=catalog?.skills.filter(skill=>skill.name===name)??[];if(matches.length!==1)throw error('CUSTOMER_SKILL_UNAVAILABLE','所选本机技能已变更或有重名，请刷新后重选');return {id:matches[0]!.id,name};});
    const command=prior?.command??{type:'command' as const,commandId,sessionId,target:session.target,method,...(method!=='openSession'&&session.runtimeEpoch?{runtimeEpoch:session.runtimeEpoch}:{}),...(skillBindings.length?{skillBindings}:{}),...(attachments?.length?{attachments}:{}),input};
    this.journal.saveCommand(command);
    const settle=(receipt:TransportReceipt)=>{if(receipt.state==='completed')return receipt.result;if(receipt.state!=='accepted'){const failure=error(receipt.error?.code??'CUSTOMER_OUTCOME_UNKNOWN',receipt.error?.message??'客户执行结果尚未确认，请先检查本机任务');if(receipt.state==='failed'&&['startTurn','steerTurn'].includes(method))Object.assign(failure,{outcome:'not_started'});throw failure;}};
    if(prior?.receipt&&prior.receipt.state!=='accepted')return settle(prior.receipt);
    return await new Promise((resolve,reject)=>{
      const callbacks=this.waiters.get(commandId)??new Set();this.waiters.set(commandId,callbacks);
      const cleanup=()=>{callbacks.delete(onReceipt);if(!callbacks.size)this.waiters.delete(commandId);clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      const onReceipt=(receipt:TransportReceipt)=>{if(receipt.state==='accepted')return;cleanup();try {resolve(settle(receipt));}catch(cause){reject(cause);}};
      const abort=()=>{cleanup();reject(error('WAIT_CANCELLED','中心已停止等待；客户任务状态仍需核实'));};
      // Promise/WebSocket boundary; cancellation is bound to the caller's Effect signal.
      // @effect-diagnostics-next-line globalTimers:off
      const timer=setTimeout(()=>{cleanup();reject(error('CUSTOMER_OUTCOME_UNKNOWN','客户设备尚未确认执行结果；不要重复发起相同任务'));},60_000);
      callbacks.add(onReceipt);signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}
      void connection?.send(command as CustomerAgentServerFrame).catch(()=>{/* Durable command remains pending for same-id replay. */});
    });
  }
  async *events(sessionId:string,signal?:AbortSignal):AsyncGenerator<ProviderAdapterV2Event> {
    let delivered=0,epoch:string|undefined;
    const deltas:ProviderAdapterV2Event[]=[];
    const onDelta=(event:ProviderAdapterV2Event)=>{
      // Terminal output is also sent reliably in turn_item.updated. Live chunks
      // are bounded and may be dropped while a slow subscriber catches up.
      if(deltas.length>=32)deltas.shift();
      deltas.push(event);this.signals.emit(sessionId);
    };
    this.signals.on(`delta:${sessionId}`,onDelta);
    try {while(!signal?.aborted) {
      let wake!:()=>void;const wait=new Promise<void>(resolve=>{wake=resolve;});
      this.signals.once(sessionId,wake);signal?.addEventListener('abort',wake,{once:true});
      try {
        const session=this.journal.session(sessionId);
        if(session?.runtimeEpoch) {
          if(epoch!==session.runtimeEpoch){epoch=session.runtimeEpoch;delivered=this.journal.cursor(sessionId,epoch).applied;}
          const entries=this.journal.events(sessionId,epoch,delivered);
          if(entries.length) {
            for(const entry of entries) {const event=validateCustomerEvent(session,entry.event);this.metadata.set(event,{sessionId,epoch,seq:entry.seq});delivered=entry.seq;yield event;}
            continue;
          }
        }
        if(deltas.length){for(const event of deltas.splice(0))yield event;continue;}
        await wait;
      } finally {this.signals.off(sessionId,wake);signal?.removeEventListener('abort',wake);}
    }}finally{this.signals.off(`delta:${sessionId}`,onDelta);}
  }
  close() {for(const connection of this.connections.values())connection.close();this.connections.clear();this.signals.removeAllListeners();}
}

export class RemoteDeviceService extends Context.Service<RemoteDeviceService,{readonly hub:RemoteDeviceHub|undefined}>()('t3/autoops/RemoteDeviceService') {}
export const layer=Layer.effect(RemoteDeviceService,Effect.gen(function*(){
  const access=configuredAutoOpsAccess();if(!access)return {hub:undefined};
  const fs=yield* FileSystem.FileSystem,path=yield* Path.Path;
  const directory=process.env.AUTOOPS_T3_DATA_DIR!;yield* fs.makeDirectory(path.join(directory,'t3'),{recursive:true}).pipe(Effect.orDie);
  const db=yield* Effect.acquireRelease(Effect.sync(()=>new DatabaseSync(path.join(directory,'t3','customer-transport.sqlite'))),db=>Effect.sync(()=>db.close()));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const config=yield* ServerConfig;
  const hub=new RemoteDeviceHub(access,createCustomerTransportJournal(db),new CustomerAttachmentDelivery(access,config.attachmentsDir));
  yield* Effect.addFinalizer(()=>Effect.sync(()=>hub.close()));
  return {hub};
}));
