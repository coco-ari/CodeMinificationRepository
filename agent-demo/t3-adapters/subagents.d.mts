import type { AutoOpsAccess } from './access.mjs';
export function createNativeSubagentBindings(dataDirectory:string,access:AutoOpsAccess):{register(parentThreadId:string,childThreadId:string,nativeThreadId:string,parentRunId?:string):unknown;close():void};
export function registerNativeSubagent(parentThreadId:string,childThreadId:string,nativeThreadId:string,parentRunId?:string,providerTurnId?:string):unknown;
