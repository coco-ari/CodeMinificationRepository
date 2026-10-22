import type { AutoOpsAccess } from './access.mjs';
export function recordLegacyNativeFork(sourceThreadId:string|null,targetThreadId:string,sourceNativeId:string,targetNativeId:string,access?:AutoOpsAccess):void;
export const LEGACY_BUSINESS_TOOLS: readonly string[];
export function requireLegacyBusinessTool(appThreadId:string,nativeThreadId:string,tool:string,namespace:string|null|undefined,access?:AutoOpsAccess):{server:string;tool:string};
