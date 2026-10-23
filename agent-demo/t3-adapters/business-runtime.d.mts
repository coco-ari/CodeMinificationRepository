import type { AutoOpsAccess } from './access.mjs';
export interface BusinessRuntime {
  initialize(): AutoOpsAccess | undefined;
  stopAccepting(): void;
  drain(): Promise<void>;
  close(): Promise<void>;
}
export function createBusinessRuntime(options?: {workspaceDrainTimeoutMs?: number}): BusinessRuntime;
