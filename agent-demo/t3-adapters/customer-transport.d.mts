import type { DatabaseSync } from 'node:sqlite';
import type { CustomerExecutionBinding } from './customer-registry.mjs';
import type { SharedExecutionScope } from '../../autoops/contracts/shared-execution.ts';
import type { UnseenOpenCommandExport, UnseenOpenCommandIdentity, UnseenOpenCommandLocator } from '../../autoops/contracts/customer-command-reconciliation.ts';
export function exportUnseenOpenCommand(db:DatabaseSync,expected:UnseenOpenCommandIdentity):UnseenOpenCommandExport;
export function inspectUnseenOpenCommand(db:DatabaseSync,expected:UnseenOpenCommandLocator):UnseenOpenCommandIdentity;
export class CustomerTransportError extends Error {code:string;constructor(code:string,message:string)}
export function customerCommandId(sessionId:string,method:string,key:unknown):string;
export interface TransportSession {
 sessionId:string;deviceId:string;threadId:string;ownerId:string;projectId:string;target:Omit<CustomerExecutionBinding,'kind'|'deviceId'>;
 providerId?:string;executionScope?:SharedExecutionScope;
 runtimeEpoch?:string; providerSession?:unknown; providerThreadId?:string;
 runs?:Array<{runId:string;attemptId:string;rootNodeId:string;runOrdinal:number;providerTurnOrdinal:number}>;
 nodeIds?:string[];
 nodeBindings?:Array<{id:string;runId:string}>;
 entityBindings?:Array<{kind:"message"|"turn-item"|"runtime-request";id:string;runId:string}>;
 providerTurnBindings?:Array<{id:string;runId:string;attemptId:string;ordinal:number}>;
 pendingInterrupt?:{runId:string;attemptId:string;requestedAt:string};
 state?:'idle'|'active'|'unknown';
 resolution?:{runId:string;attemptId:string;resolvedAt:string;reason:'operator_confirmed_process_stopped'};
 appliedResolution?:TransportSession['resolution'];
}
export interface TransportCommand {type:'command';commandId:string;sessionId:string;target:TransportSession['target'];method:string;runtimeEpoch?:string;input:unknown;executionScope?:SharedExecutionScope;attachments?:ReadonlyArray<import('../../vendor/t3code/packages/contracts/src/customerAttachments.ts').CustomerAttachmentManifest>}
export interface TransportReceipt {type:'receipt';commandId:string;sessionId:string;state:'accepted'|'completed'|'failed'|'unknown';runtimeEpoch?:string|undefined;grantId?:string|undefined;result?:unknown;error?:{code:string;message:string}|undefined}
export interface CustomerTransportJournal {
 acquireWorkspace(workspaceKey:string,threadId:string,runId:string):boolean;
 releaseWorkspace(workspaceKey:string,runId:string):boolean;
 session(id:string):TransportSession|undefined;
 sessions(deviceId:string):TransportSession[];
 saveSession(value:TransportSession):void;
 command(id:string):{command:TransportCommand;receipt?:TransportReceipt}|undefined;
 saveCommand(value:TransportCommand):{command:TransportCommand;receipt?:TransportReceipt}|undefined;
 saveReceipt(value:TransportReceipt):TransportReceipt;
 reconcileStoppedReceipt(value:TransportReceipt,query:{sessionId:string;runtimeEpoch:string}):TransportReceipt;
 unknownCommands(sessionId:string):TransportCommand[];
 pendingCommands(sessionId:string):TransportCommand[];
 cursor(sessionId:string,epoch:string):{received:number;applied:number};
 receive(sessionId:string,epoch:string,events:ReadonlyArray<{seq:number;event:unknown}>):number;
 events(sessionId:string,epoch:string,afterSeq:number):Array<{seq:number;event:unknown}>;
 applied(sessionId:string,epoch:string,seq:number):number;
}
export function createCustomerTransportJournal(db:DatabaseSync):CustomerTransportJournal;
