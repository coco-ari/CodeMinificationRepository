import type { AutoOpsAccess, AutoOpsPrincipal } from './access.mjs';
export function authorizeProductRpc(method:string,payload?:unknown,env?:NodeJS.ProcessEnv):void;
export function authorizeAutoOpsRpc(access: AutoOpsAccess, principal: AutoOpsPrincipal, method: string, payload?: unknown): void;
export function prepareAutoOpsRpcPayload(access: AutoOpsAccess, principal: AutoOpsPrincipal, method: string, payload?: unknown): unknown;
export function filterAutoOpsShell<T>(access: AutoOpsAccess, principal: AutoOpsPrincipal, snapshot: T): T;
export function filterAutoOpsShellItem<T>(access: AutoOpsAccess, principal: AutoOpsPrincipal, item: T): T | null;
