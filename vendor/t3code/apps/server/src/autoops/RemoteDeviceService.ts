import { CustomerAttachmentDelivery } from './CustomerAttachmentDelivery.ts';
import { customerMessageAttachments } from '../../../../packages/contracts/src/customerAttachments.ts';
import { ServerConfig } from '../config.ts';
import { DatabaseSync } from 'node:sqlite';
// @effect-diagnostics-next-line nodeBuiltinImport:off -- 请求标识只在现有 Promise/WebSocket 传输边界使用。
import { randomUUID } from 'node:crypto';
import { CUSTOMER_FILE_LIMITS, decodeCustomerFileResult, type CustomerFileInput, type CustomerFileResult } from '../../../../packages/contracts/src/customerFiles.ts';
import type { CustomerExecutionBinding } from '../../../../../../autoops/contracts/runtime.ts';
import type { CustomerPlatformToolRequest } from '../../../../../../autoops/contracts/customer-platform-tools.ts';
import { EventEmitter } from 'node:events';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { SKILL_MENTION_PATTERN, collectComposerInlineTokens } from '@t3tools/shared/composerInlineTokens';
import { ProviderAdapterV2Event } from '@t3tools/provider-core/server/ProviderAdapter';
import { validateCustomerEvent, validateCustomerResult } from './CustomerEventValidation.ts';
export { validateCustomerEvent } from './CustomerEventValidation.ts';
import type { CustomerAgentClientFrame, CustomerAgentServerFrame, CustomerAgentMethod } from '../../../../packages/contracts/src/autoopsRemote.ts';
import { configuredAutoOpsAccess, type AutoOpsAccess, type ThreadBinding } from '../../../../../../agent-demo/t3-adapters/access.mjs';
import type { CustomerDevicePrincipal } from '../../../../../../agent-demo/t3-adapters/customer-registry.mjs';
import { customerProviderInstanceId,customerWorkspaceKey } from '../../../../../../agent-demo/t3-adapters/customer-target.mjs';
import { createCustomerTransportJournal, customerCommandId, CustomerTransportError, type CustomerTransportJournal, type TransportSession, type TransportReceipt } from '../../../../../../agent-demo/t3-adapters/customer-transport.mjs';

type Send = (frame: CustomerAgentServerFrame) => Promise<void>;
type Connection = { principal:CustomerDevicePrincipal; epoch:number; connectorEpoch?:string; attachmentTransfers?:boolean; workspaceFiles?:boolean; assistantConfiguration?:boolean; platformToolsVersion?:1; sharedExecutionVersion?:1; receiptQueries:Map<string,{sessionId:string;runtimeEpoch:string;grantId?:string|undefined}>; send:Send; hello:boolean; sessions:Map<string,{runtimeEpoch:string;state:string;live?:boolean|undefined;lastSeq?:number|undefined}>; close:()=>void };
type Delivery = {sessionId:string;epoch:string;seq:number};
type AppliedTerminalRetry = Delivery & {connection:Connection;event:ProviderAdapterV2Event;body:string;delivered:boolean;completion:Promise<void>;resolve:()=>void;reject:(cause:unknown)=>void};
const error = (code:string,message:string) => new CustomerTransportError(code,message);
export class RemoteDeviceHub {
  readonly access:AutoOpsAccess;
  readonly journal:CustomerTransportJournal;
  private readonly connections=new Map<string,Connection>();
  private readonly signals=new EventEmitter();
  private readonly metadata=new WeakMap<object,Delivery>();
  private readonly appliedTerminalRetries=new Map<string,AppliedTerminalRetry>();
  private readonly retryMetadata=new WeakMap<object,AppliedTerminalRetry>();
  private readonly waiters=new Map<string,Set<(receipt:TransportReceipt)=>void>>();
  private readonly attachments:CustomerAttachmentDelivery|undefined;
  private readonly fileWaiters = new Map<string, { connection: Connection; resolve: (value: CustomerFileResult) => void; reject: (cause: unknown) => void }>();
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
    const command=prior?.command??{type:'command' as const,commandId,sessionId,target:session.target,method:'interruptTurn',runtimeEpoch:session.runtimeEpoch,...(session.executionScope?{executionScope:session.executionScope}:{}),input:{providerThread:thread,providerTurnId}};
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
  async readFiles(ownerId: string, projectId: string, target: CustomerExecutionBinding, input: CustomerFileInput, signal?: AbortSignal, authorize: () => void = () => {}): Promise<CustomerFileResult> {
    const check = () => { this.access.assertAccepting(); authorize(); this.access.customerRegistry.validateTarget(ownerId, projectId, target, { requireOnline: true }); };
    check();
    const connection = this.connections.get(target.deviceId);
    if (!connection?.hello) throw error('DEVICE_OFFLINE', '电脑已离线，请等待重新连接');
    if (!connection.workspaceFiles) throw error('CONNECTOR_UPDATE_REQUIRED', '请更新这台电脑的连接程序后引用文件');
    if ([...this.fileWaiters.values()].filter(item => item.connection === connection).length >= 4) throw error('FILES_BUSY', '文件读取正忙，请稍后重试');
    const requestId = randomUUID();
    return new Promise<CustomerFileResult>((resolve, reject) => {
      const cleanup = () => { this.fileWaiters.delete(requestId); clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const cancel = (cause: unknown) => { cleanup(); void connection.send({ type: 'filesCancel', requestId }).catch(() => {}); reject(cause); };
      const abort = () => cancel(error('FILES_CANCELLED', '已取消文件读取'));
      // 文件读取不进入执行日志，超时或取消只结束本次读取，不影响正在运行的 Agent。
      // @effect-diagnostics-next-line globalTimers:off
      const timer = setTimeout(() => cancel(error('FILES_TIMEOUT', '电脑文件读取超时，请重试')), CUSTOMER_FILE_LIMITS.timeoutMs);
      this.fileWaiters.set(requestId, { connection,
        resolve: value => { cleanup(); try { check(); resolve(value); } catch (cause) { reject(cause); } },
        reject: cause => { cleanup(); reject(cause); },
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      void connection.send({ type: 'files', requestId, target, input }).catch(() => {
        const pending = this.fileWaiters.get(requestId);
        pending?.reject(error('DEVICE_OFFLINE', '电脑已离线，请等待重新连接'));
      });
    });
  }
  identity(event:ProviderAdapterV2Event) {const delivery=this.metadata.get(event);return delivery?customerCommandId(delivery.sessionId,'event',[delivery.epoch,delivery.seq]):undefined;}
  private cancelAppliedTerminalRetries(matches:(retry:AppliedTerminalRetry)=>boolean) {
    for(const retry of this.appliedTerminalRetries.values())if(matches(retry))retry.reject(error('EVENT_RETRY_CANCELLED','原终态交付已断开，未确认原生处理完成'));
  }
  private retryAppliedTerminal(connection:Connection,delivery:Delivery,event:ProviderAdapterV2Event,body:string) {
    const key=customerCommandId(delivery.sessionId,'event',[delivery.epoch,delivery.seq]),prior=this.appliedTerminalRetries.get(key);
    if(prior) {
      if(prior.connection!==connection||prior.body!==body)throw error('EVENT_RETRY_CONFLICT','同一原事件的重传内容不能替换');
      return prior.completion;
    }
    if(this.appliedTerminalRetries.size>=16||[...this.appliedTerminalRetries.values()].some(retry=>retry.sessionId===delivery.sessionId&&retry.epoch===delivery.epoch))throw error('EVENT_RETRY_BUSY','原终态仍在等待原生确认，请稍后核对');
    let resolve!:()=>void,reject!:(cause:unknown)=>void;
    const completion=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
    // 已清除的历史正文不能在此重新比对；原设备与原轮次校验仍先于有界交付。
    // @effect-diagnostics-next-line globalTimers:off
    const timer=setTimeout(()=>retry.reject(error('EVENT_RETRY_TIMEOUT','原终态尚未得到原生确认，没有改写原收据游标')),20_000);
    const cleanup=()=>{clearTimeout(timer);if(this.appliedTerminalRetries.get(key)===retry)this.appliedTerminalRetries.delete(key);};
    const retry:AppliedTerminalRetry={...delivery,connection,event,body,delivered:false,completion,resolve:()=>{cleanup();resolve();},reject:cause=>{cleanup();reject(cause);}};
    this.appliedTerminalRetries.set(key,retry);this.retryMetadata.set(event,retry);this.metadata.set(event,delivery);this.signals.emit(delivery.sessionId);
    return completion;
  }
  async acknowledge(event:ProviderAdapterV2Event) {
    const delivery=this.metadata.get(event);if(!delivery)return;
    const retry=this.retryMetadata.get(event);
    if(retry) {
      const key=customerCommandId(delivery.sessionId,'event',[delivery.epoch,delivery.seq]);
      if(this.appliedTerminalRetries.get(key)!==retry||this.connections.get(retry.connection.principal.deviceId)!==retry.connection||this.session(delivery.sessionId)?.runtimeEpoch!==delivery.epoch)throw error('EVENT_RETRY_CANCELLED','原终态交付已失效，不能确认完成');
      // 重传只补原persistenceKey交付，不产生interrupt、租约释放或任何游标写入。
      retry.resolve();return;
    }
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
    const prior=this.connections.get(principal.deviceId);if(prior)this.cancelAppliedTerminalRetries(retry=>retry.connection===prior);prior?.close();
    const {connectionEpoch}=this.access.customerRegistry.markConnected(principal);
    const connection:Connection={principal,epoch:connectionEpoch,send,hello:false,sessions:new Map(),receiptQueries:new Map(),close:onClose};
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
          connection.workspaceFiles = frame.workspaceFiles === true;
          connection.assistantConfiguration = frame.assistantConfiguration === true;
          if(frame.platformToolsVersion===1)connection.platformToolsVersion=1;
          if(frame.sharedExecutionVersion===1)connection.sharedExecutionVersion = 1;
          const registered=this.access.customerRegistry.listWorkspaces(principal.ownerId);
          for(const workspace of frame.workspaces)if(!registered.some(item=>item.deviceId===principal.deviceId&&item.projectId===workspace.projectId&&item.registeredWorkspaceId===workspace.registeredWorkspaceId&&item.workspaceBindingRevision===workspace.workspaceBindingRevision&&item.runtimeId===workspace.runtimeId))throw error('WORKSPACE_SCOPE','客户设备声明了未登记的工作区');
          this.access.customerRegistry.markHeartbeat(principal,connectionEpoch,{connectorVersion:frame.connectorVersion});
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
              for(const command of this.journal.pendingCommands(session.sessionId)) {
                if(command.platformTools&&connection.platformToolsVersion!==1){await send({type:'error',code:'PLATFORM_TOOLS_PROTOCOL_REQUIRED',message:'原工具上下文需要支持受控桥的连接程序，原命令未重发'});continue;}
                if(command.executionScope && connection.sharedExecutionVersion!==1) {
                  await send({type:'error',code:'SHARED_PROTOCOL_REQUIRED',message:'共享执行恢复需要支持隔离的连接程序，原命令未重发'});continue;
                }
                if(command.executionScope && command.method!=='interruptTurn') {
                  try { this.access.requireSharedExecutionScope(command.executionScope,principal); }
                  catch { await send({type:'receiptQuery',commandId:command.commandId,sessionId:command.sessionId,grantId:command.executionScope.grantId});continue; }
                }
                await send(command as CustomerAgentServerFrame);
              }
              const unknown=this.journal.unknownCommands(session.sessionId);
              if(unknown.length&&!frame.receiptQueries)await send({type:'error',code:'RECEIPT_QUERY_UPDATE_REQUIRED',message:'请更新原连接程序以查询原未知收据；没有重发执行'});
              if(frame.receiptQueries&&reported.state==='idle')for(const command of unknown) {
                const epoch:string|undefined=command.runtimeEpoch??session.runtimeEpoch;
                if(!epoch||epoch!==session.runtimeEpoch)continue;
                const grantId=command.executionScope?.grantId;
                connection.receiptQueries.set(command.commandId,{sessionId:session.sessionId,runtimeEpoch:epoch,grantId});
                // 撤回只阻止新执行；已绑定设备可只读查原command/session/grant，不再校验新执行权限。
                await send({type:'receiptQuery',commandId:command.commandId,sessionId:session.sessionId,...(grantId?{grantId}:{})});
              }
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
        if (frame.type === 'filesResult') {
          const pending = this.fileWaiters.get(frame.requestId);
          if (!pending) return;
          if (pending.connection !== connection) throw error('FILES_SCOPE', '文件结果不属于此连接');
          if (Buffer.byteLength(JSON.stringify(frame)) > CUSTOMER_FILE_LIMITS.responseBytes) {
            pending.reject(error('FILES_LIMIT', '文件结果超过大小限制')); return;
          }
          if (frame.error) pending.reject(error('FILES_UNAVAILABLE', frame.error.message.slice(0, 200)));
          else if (frame.result) {
            try { pending.resolve(decodeCustomerFileResult(frame.result)); }
            catch { pending.reject(error('FILES_INVALID', '电脑返回的文件结果无效，请更新连接程序')); }
          }
          else pending.reject(error('FILES_UNAVAILABLE', '文件读取失败，请重试'));
          return;
        }
        const session=this.journal.session(frame.sessionId);
        if(!session || session.deviceId!==principal.deviceId || (session.providerId ?? session.ownerId)!==principal.ownerId)throw error('SESSION_SCOPE','客户会话不属于此设备');
        if(frame.type==='receipt') {
          const pending=this.journal.command(frame.commandId);
          if(!pending || pending.command.sessionId!==session.sessionId)throw error('COMMAND_SCOPE','客户回执不属于此会话');
          if(pending.command.executionScope?.grantId!==frame.grantId)throw error('RECEIPT_SCOPE_CHANGED','客户回执不属于原命令固定执行范围');
          if(pending.receipt?.state==='unknown'&&frame.state==='failed') {
            if(frame.result!==undefined||frame.error?.code!=='CUSTOMER_MANUALLY_RECONCILED'||typeof frame.error.message!=='string'||!frame.error.message.trim()||frame.error.message.length>2000)throw error('RECEIPT_RECONCILIATION_INVALID','仅原合法人工停止失败收据可收束未知结果');
            const query=connection.receiptQueries.get(frame.commandId),reported=connection.sessions.get(session.sessionId);
            if(!query||query.sessionId!==session.sessionId||query.grantId!==frame.grantId||reported?.state!=='idle')throw error('RECEIPT_QUERY_REQUIRED','此连接尚未查询原人工核实收据');
            if(query.runtimeEpoch!==frame.runtimeEpoch||reported.runtimeEpoch!==query.runtimeEpoch||session.runtimeEpoch!==query.runtimeEpoch)throw error('RUNTIME_EPOCH','原收据不属于此连接核对的运行代次');
            const reconciled=this.journal.reconcileStoppedReceipt(frame,query);
            connection.receiptQueries.delete(frame.commandId);
            for(const notify of this.waiters.get(frame.commandId)??[])notify(reconciled);
            this.signals.emit(session.sessionId);this.signals.emit('session-state',session.sessionId);return;
          }
          // A delayed replay of an already settled openSession must not roll a newer runtime back.
          if(pending.receipt&&['completed','failed','unknown'].includes(pending.receipt.state)) {
            for(const notify of this.waiters.get(frame.commandId)??[])notify(pending.receipt);
            this.signals.emit(session.sessionId);return;
          }
          if(frame.state==='completed'&&(!frame.runtimeEpoch||(pending.command.runtimeEpoch&&pending.command.runtimeEpoch!==frame.runtimeEpoch)))throw error('RUNTIME_EPOCH','客户完成回执缺少匹配的运行代次');
          if(pending.command.runtimeEpoch && frame.runtimeEpoch && pending.command.runtimeEpoch!==frame.runtimeEpoch)throw error('RUNTIME_EPOCH','客户回执运行代次不匹配');
          const admitted=frame.state==='completed'?{...frame,result:validateCustomerResult(session,pending.command.method,frame.result)}:frame;
          if(frame.runtimeEpoch && (!session.runtimeEpoch || pending.command.method==='openSession')) {
            if(session.runtimeEpoch!==frame.runtimeEpoch)this.cancelAppliedTerminalRetries(retry=>retry.sessionId===session.sessionId);
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
        const applied=this.journal.cursor(session.sessionId,frame.runtimeEpoch).applied;
        const terminalRetries:{seq:number;event:ProviderAdapterV2Event;body:string}[]=[];
        for(const item of frame.events) {
          const event=validateCustomerEvent(session,item.event);
          if(item.seq<=applied&&event.type==='provider_turn.updated'&&['completed','failed','interrupted','cancelled'].includes(event.providerTurn.status)) {
            const original=this.journal.session(session.sessionId);
            if(!event.providerTurn.completedAt||!original?.providerTurnBindings?.some(turn=>turn.id===event.providerTurn.id&&turn.attemptId===event.providerTurn.runAttemptId)||JSON.stringify(original)!==JSON.stringify(session))throw error('EVENT_RETRY_SCOPE','原终态必须属于已登记的同一轮次与运行尝试');
            terminalRetries.push({seq:item.seq,event,body:JSON.stringify(item.event)});
          }
        }
        if(terminalRetries.length>1)throw error('EVENT_RETRY_BUSY','一次只核对一个原终态事件');
        try {this.journal.receive(session.sessionId,frame.runtimeEpoch,frame.events);}
        catch(cause) {if(cause instanceof CustomerTransportError&&cause.code==='EVENT_GAP') {await send({type:'replay',sessionId:session.sessionId,runtimeEpoch:frame.runtimeEpoch,afterSeq:this.journal.cursor(session.sessionId,frame.runtimeEpoch).received});return;}throw cause;}
        if(frame.events.some(item=>(item.event as {type?:string}).type==='turn.terminal'))session.state='idle';
        this.journal.saveSession(session);
        this.signals.emit(session.sessionId);
        for(const retry of terminalRetries)await this.retryAppliedTerminal(connection,{sessionId:session.sessionId,epoch:frame.runtimeEpoch,seq:retry.seq},retry.event,retry.body);
        current();
        if(terminalRetries.length&&this.session(session.sessionId)?.runtimeEpoch!==frame.runtimeEpoch)throw error('EVENT_RETRY_CANCELLED','原终态交付代次已更换，不能确认完成');
        // Duplicate batches can arrive after a lost ACK; reply with applied, never received.
        await send({type:'ack',sessionId:session.sessionId,runtimeEpoch:frame.runtimeEpoch,seq:this.journal.cursor(session.sessionId,frame.runtimeEpoch).applied});
      },
      disconnect:()=>{if(this.connections.get(principal.deviceId)!==connection)return;this.cancelAppliedTerminalRetries(retry=>retry.connection===connection);this.connections.delete(principal.deviceId);for(const pending of this.fileWaiters.values())if(pending.connection===connection)pending.reject(error('DEVICE_OFFLINE','电脑已离线，请等待重新连接'));this.access.customerRegistry.markDisconnected(principal.deviceId,connectionEpoch);this.signals.emit('connection',principal.deviceId);},
    };
  }
  bind(binding:ThreadBinding,sessionId:string,modelSelection?:unknown) {
    if(binding.executionBinding.kind!=='customer')throw error('NOT_CUSTOMER','这不是客户工作区');
    const {deviceId,...rest}=binding.executionBinding;
    const target={registeredWorkspaceId:rest.registeredWorkspaceId,workspaceBindingRevision:rest.workspaceBindingRevision,runtimeId:rest.runtimeId};
    const old=this.journal.session(sessionId);
    const executionScope=old?.executionScope ?? this.access.issueCustomerSessionScope(binding.threadId,sessionId,modelSelection);
    this.journal.saveSession({...old,sessionId,deviceId,ownerId:binding.ownerId,projectId:binding.projectId,threadId:binding.threadId,target,...(executionScope?{providerId:executionScope.providerId,executionScope}:{})});
  }
  update(sessionId:string,update:Partial<TransportSession>) {const session=this.journal.session(sessionId);if(!session)throw error('SESSION_MISSING','客户会话尚未绑定');if(update.runtimeEpoch&&update.runtimeEpoch!==session.runtimeEpoch)this.cancelAppliedTerminalRetries(retry=>retry.sessionId===sessionId);this.journal.saveSession({...session,...update});if(update.pendingInterrupt)this.signals.emit('session-state',sessionId);}
  async readAttachment(principal:CustomerDevicePrincipal,commandId:string,attachmentId:string) {
    const saved=this.journal.command(commandId), session=saved && this.journal.session(saved.command.sessionId);
    if(!saved || !session || session.deviceId!==principal.deviceId || (session.providerId ?? session.ownerId)!==principal.ownerId || !this.attachments)throw error('ATTACHMENT_SCOPE','附件不属于此设备');
    if(saved.command.executionScope)this.access.requireSharedExecutionScope(saved.command.executionScope,principal);
    else this.access.customerRegistry.validateTarget(session.ownerId,session.projectId,{kind:'customer',deviceId:session.deviceId,...session.target});
    const binding=this.access.getThreadBinding(session.threadId);
    if(binding?.executionBinding.kind!=='customer' || binding.executionBinding.deviceId!==session.deviceId || binding.executionBinding.runtimeId!==session.target.runtimeId || customerWorkspaceKey(binding.executionBinding)!==customerWorkspaceKey({kind:'customer',deviceId:session.deviceId,...session.target}))throw error('ATTACHMENT_SCOPE','附件绑定已失效');
    const manifest=saved.command.attachments?.find(item=>item.id===attachmentId);
    const attachment=customerMessageAttachments(saved.command.input).find(item=>item.id===attachmentId);
    if(!manifest || !attachment)throw error('ATTACHMENT_SCOPE','原命令没有此附件');
    const delivered=await this.attachments.read(session,attachment,manifest);
    if(saved.command.executionScope)this.access.requireSharedExecutionScope(saved.command.executionScope,principal);
    return delivered.bytes;
  }
  authorizePlatformTool(principal:CustomerDevicePrincipal,request:CustomerPlatformToolRequest) {
    this.access.assertAccepting();
    const connection=this.connections.get(principal.deviceId),saved=this.journal.command(request.commandId),session=this.journal.session(request.sessionId);
    if(!connection?.hello||connection.platformToolsVersion!==1||connection.principal.tokenHash!==principal.tokenHash)throw error('PLATFORM_TOOLS_CONNECTION','原设备只读工具连接不可用');
    if(!saved||!session||saved.command.method!=='startTurn'||saved.command.sessionId!==session.sessionId||session.deviceId!==principal.deviceId||(session.providerId??session.ownerId)!==principal.ownerId)throw error('PLATFORM_TOOLS_COMMAND_SCOPE','平台工具不属于此设备原轮命令');
    if(saved.command.platformTools?.version!==request.reference.version||saved.command.platformTools.contextId!==request.reference.contextId)throw error('PLATFORM_TOOLS_CONTEXT_SCOPE','不能替换原命令的平台工具引用');
    if(session.runtimeEpoch!==request.runtimeEpoch||saved.command.runtimeEpoch!==request.runtimeEpoch||connection.sessions.get(session.sessionId)?.runtimeEpoch!==request.runtimeEpoch)throw error('PLATFORM_TOOLS_RUNTIME_EPOCH','平台工具不属于原运行代次');
    if(saved.receipt&&['failed','unknown'].includes(saved.receipt.state))throw error('PLATFORM_TOOLS_OUTCOME_UNKNOWN','原命令结果未知或失败，不能发起新工具调用');
    const authorized=this.access.requireCustomerToolRun(request.reference,principal),input=saved.command.input as {runId?:string;attemptId?:string};
    if(authorized.context.threadId!==session.threadId||authorized.context.runId!==input.runId||customerWorkspaceKey(authorized.binding.executionBinding as CustomerExecutionBinding)!==customerWorkspaceKey({kind:'customer',deviceId:session.deviceId,...session.target}))throw error('PLATFORM_TOOLS_RUN_SCOPE','平台工具不属于原线程任务与登记目录');
    if(saved.command.executionScope)this.access.requireSharedExecutionScope(saved.command.executionScope,principal);
    if((saved.command.executionScope?.grantId??null)!==authorized.context.scope.grantId)throw error('PLATFORM_TOOLS_GRANT_SCOPE','平台工具不属于原命令执行授权');
    return {authorized,session,command:saved.command,runId:authorized.context.runId,attemptId:input.attemptId};
  }
  async command(sessionId:string,method:CustomerAgentMethod,input:unknown,key:unknown,signal?:AbortSignal):Promise<unknown> {
    const session=this.journal.session(sessionId);if(!session)throw error('SESSION_MISSING','客户会话尚未绑定');
    const connection=this.connections.get(session.deviceId);
    const control=['interruptTurn','respondToRuntimeRequest'].includes(method);
    // 停止期间只允许已接受执行的控制及结果核对，不再下发新的执行命令。
    if (!control && method !== 'readThreadSnapshot') this.access.assertAccepting();
    if(!connection?.hello&&!control)throw error('DEVICE_OFFLINE','客户设备已离线，请等待重新连接');
    const target={kind:'customer' as const,deviceId:session.deviceId,...session.target};
    const commandId=customerCommandId(sessionId,method,key);
    const prior=this.journal.command(commandId);
    const platformTools=prior?.command.platformTools??(method==='startTurn'?this.access.customerToolReference(session.threadId,String((input as {runId:string}).runId)):undefined);
    if(platformTools&&connection?.platformToolsVersion!==1)throw Object.assign(error('CONNECTOR_UPDATE_REQUIRED','此连接程序未启用平台只读工具桥'),{outcome:'not_started'});
    const executionScope=prior?.command.executionScope ?? (method==='startTurn' && session.executionScope
      ? this.access.customerRunScope(session.threadId,String((input as {runId:string}).runId)) : session.executionScope);
    const authorize = () => {
      if(executionScope) {
        if(method!=='interruptTurn')this.access.requireSharedExecutionScope(executionScope);
        if(connection?.sharedExecutionVersion!==1)throw Object.assign(error('CONNECTOR_UPDATE_REQUIRED','此连接程序未支持已验证的共享隔离'),{outcome:'not_started'});
      } else if(method!=='readThreadSnapshot')this.access.customerRegistry.validateTarget(session.ownerId,session.projectId,target,{requireOnline:!control});
    };
    authorize();
    if(executionScope && method==='startTurn')this.update(sessionId,{executionScope});
    if (method === 'startTurn' && (input as {assistantConfiguration?:unknown})?.assistantConfiguration && !connection?.assistantConfiguration) throw Object.assign(error('CONNECTOR_UPDATE_REQUIRED', '请更新这台电脑的连接程序后使用助手预设'), {outcome:'not_started'});
    const requestedAttachments=['startTurn','steerTurn'].includes(method)?customerMessageAttachments(input):[];
    const fileMentions = ['startTurn', 'steerTurn'].includes(method) && collectComposerInlineTokens(String((input as { message?: { text?: string } })?.message?.text ?? '') + '\n').some(token => token.type === 'mention' && token.value.startsWith('autoops-customer/'));
    if (fileMentions && !connection?.workspaceFiles) throw Object.assign(error('CONNECTOR_UPDATE_REQUIRED', '请更新这台电脑的连接程序后引用文件'), { outcome: 'not_started' });
    if(requestedAttachments.length && (!this.attachments || !connection?.attachmentTransfers))throw Object.assign(error('CONNECTOR_UPDATE_REQUIRED','请更新这台电脑的连接程序后发送附件'),{outcome:'not_started'});
    const attachments=!prior && requestedAttachments.length?await this.attachments!.prepare(session,input):undefined;
    authorize();
    if(signal?.aborted)throw Object.assign(error('WAIT_CANCELLED','已取消发送附件'),{outcome:'not_started'});
    const names=['startTurn','steerTurn'].includes(method)?[...new Set([...(method === 'startTurn' ? (input as {assistantConfiguration?:{skillNames:readonly string[]}})?.assistantConfiguration?.skillNames ?? [] : []), ...[...String((input as {message?:{text?:string}})?.message?.text??'').matchAll(SKILL_MENTION_PATTERN)].map(match=>match[2]!)])]:[];
    const capabilities=names.length?this.access.customerRegistry.getCapabilities(executionScope?.providerId ?? session.ownerId,target):undefined;
    const catalog=executionScope?capabilities?.sharedProfile:capabilities;
    const skillBindings=names.map(name=>{const matches=catalog?.skills.filter(skill=>skill.name===name)??[];if(matches.length!==1)throw error('CUSTOMER_SKILL_UNAVAILABLE','所选本机技能已变更或有重名，请刷新后重选');return {id:matches[0]!.id,name};});
    const command=prior?.command??{type:'command' as const,commandId,sessionId,target:session.target,method,...(method!=='openSession'&&session.runtimeEpoch?{runtimeEpoch:session.runtimeEpoch}:{}),...(executionScope?{executionScope}:{}),...(platformTools?{platformTools}:{}),...(skillBindings.length?{skillBindings}:{}),...(attachments?.length?{attachments}:{}),input};
    this.journal.saveCommand(command);
    const settle=(receipt:TransportReceipt)=>{if(receipt.state==='completed'){authorize();return receipt.result;}if(receipt.state!=='accepted'){const failure=error(receipt.error?.code??'CUSTOMER_OUTCOME_UNKNOWN',receipt.error?.message??'客户执行结果尚未确认，请先检查本机任务');if(receipt.state==='failed'&&['startTurn','steerTurn'].includes(method))Object.assign(failure,{outcome:'not_started'});throw failure;}};
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
          if(epoch!==session.runtimeEpoch){epoch=session.runtimeEpoch;this.cancelAppliedTerminalRetries(retry=>retry.sessionId===sessionId&&retry.epoch!==epoch);delivered=this.journal.cursor(sessionId,epoch).applied;}
          const retry=[...this.appliedTerminalRetries.values()].find(value=>value.sessionId===sessionId&&value.epoch===epoch&&!value.delivered);
          if(retry){retry.delivered=true;yield retry.event;continue;}
          const entries=this.journal.events(sessionId,epoch,delivered);
          if(entries.length) {
            for(const entry of entries) {const event=validateCustomerEvent(session,entry.event);this.metadata.set(event,{sessionId,epoch,seq:entry.seq});delivered=entry.seq;yield event;}
            continue;
          }
        }
        if(deltas.length){for(const event of deltas.splice(0))yield event;continue;}
        await wait;
      } finally {this.signals.off(sessionId,wake);signal?.removeEventListener('abort',wake);}
    }}finally{this.cancelAppliedTerminalRetries(retry=>retry.sessionId===sessionId);this.signals.off(`delta:${sessionId}`,onDelta);}
  }
  close() {this.cancelAppliedTerminalRetries(()=>true);for(const pending of this.fileWaiters.values())pending.reject(error('FILES_UNAVAILABLE','服务正在重启，请稍后重试'));for(const connection of this.connections.values())connection.close();this.connections.clear();this.signals.removeAllListeners();}
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
