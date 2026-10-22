import type { Json } from '../runtime-policy.mjs';
export const BUSINESS_INSTRUCTIONS: string;
export const BUSINESS_TOOL_NAMES: readonly string[];
export const BUSINESS_APPROVAL_POLICY: { readonly granular: { readonly sandbox_approval:false; readonly rules:false; readonly skill_approval:false; readonly request_permissions:false; readonly mcp_elicitations:true } };
export function businessMcpApprovals(): Record<string, Json>;
export function effectiveBusinessInteractionMode<T extends string>(mode:T):T|'default';
export function businessThreadParameters(appThreadId: string): { cwd?:string; baseInstructions?: string; config?: Readonly<Record<string, Json>> };
export function prepareAutoOpsCodexRequest(method: string, payload: unknown): unknown;
