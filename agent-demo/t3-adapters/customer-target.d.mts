import type { AutoOpsAccess, ThreadBinding } from './access.mjs';
import type { CustomerExecutionBinding, CustomerCapabilities } from './customer-registry.mjs';
export function customerProviderInstanceId(target: Pick<CustomerExecutionBinding, 'deviceId' | 'runtimeId'>): string;
export function isCustomerProviderInstanceId(value: unknown): boolean;
export function customerWorkspaceKey(target: CustomerExecutionBinding): string;
export function authorizeCustomerModel(access: AutoOpsAccess, binding: ThreadBinding, selection: {instanceId:string;model:string;options?:ReadonlyArray<{readonly id:string;readonly value:string|boolean}>}): CustomerCapabilities;
export function assertCustomerInput(input: unknown): void;
