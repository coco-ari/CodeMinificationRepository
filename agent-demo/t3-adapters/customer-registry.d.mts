import type { CustomerExecutionBinding, ExecutionBinding, CustomerDevice, CustomerWorkspace, CustomerModel, CustomerSkill, CustomerCapabilityInput, CustomerCapabilities } from '../../autoops/contracts/runtime.ts';
export type { CustomerExecutionBinding, ExecutionBinding, CustomerDevice, CustomerWorkspace, CustomerModel, CustomerSkill, CustomerCapabilityInput, CustomerCapabilities } from '../../autoops/contracts/runtime.ts';
import type { DatabaseSync } from 'node:sqlite';
/** Internal only: never serialize a device principal or put it in logs. */
export interface CustomerDevicePrincipal { deviceId: string; ownerId: string; tokenHash: string }
export interface CustomerRegistry {
  /** 可信组合端口；用户接口必须先裁决本人或有效共享。 */
  sourceOwner(target: CustomerExecutionBinding): {ownerId:string;projectId:string};
  describeSource(ownerId:string,target:CustomerExecutionBinding): import('../../autoops/contracts/assistants.ts').ProvidedAssistantSource;
  listSources(ownerId:string): import('../../autoops/contracts/assistants.ts').ProvidedAssistantSource[];
  deletionReferences(projectId: string, environmentId?: string): import('../../autoops/contracts/project-directory.ts').DeletionBlocker[];
  createPairing(ownerId: string, input?: {label?: string}): {pairingCode: string; expiresAt: string};
  consumePairing(pairingCode: string, input: {label: string; platform?: string; connectorVersion?: string}): {device: CustomerDevice; deviceToken: string};
  authenticateToken(token: string): CustomerDevicePrincipal;
  listDevices(ownerId: string): CustomerDevice[];
  listWorkspaces(ownerId: string, projectId?: string): CustomerWorkspace[];
  registerWorkspace(principal: CustomerDevicePrincipal, input: {registeredWorkspaceId: string; projectId: string; label: string; workspaceBindingRevision: number; runtimeId: 'codex'}): CustomerWorkspace;
  updateCapabilities(principal: CustomerDevicePrincipal, input: CustomerCapabilityInput): CustomerCapabilities;
  getCapabilities(ownerId: string, target: CustomerExecutionBinding): CustomerCapabilities | undefined;
  validateTarget(ownerId: string, projectId: string, target: CustomerExecutionBinding, options?: {requireOnline?: boolean}): {device: CustomerDevice; workspace: CustomerWorkspace};
  validateSelection(ownerId: string, projectId: string, target: CustomerExecutionBinding, input: {modelId: string; reasoningEffort?: string; skillIds?: string[]}): CustomerCapabilities;
  setDeviceStatus(ownerId: string, deviceId: string, status: 'active' | 'disabled'): CustomerDevice;
  revokeCredential(ownerId: string, deviceId: string): CustomerDevice;
  revokeWorkspace(principal: CustomerDevicePrincipal, workspaceId: string): CustomerWorkspace;
  markConnected(principal: CustomerDevicePrincipal, input?: {connectorVersion?: string}): {device: CustomerDevice; connectionEpoch: number};
  markHeartbeat(principal: CustomerDevicePrincipal, connectionEpoch: number): void;
  markDisconnected(deviceId: string, connectionEpoch: number): void;
  resetPresence(): void;
  listRegisteredDevices(): CustomerDevice[];
  subscribeChanges(listener:()=>void):()=>void;
}
export class CustomerRegistryError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) }
export function normalizeExecutionBinding(value?: unknown): ExecutionBinding;
export function initializeCustomerRegistrySchema(db: DatabaseSync): void;
export function createCustomerRegistry(options: {db: DatabaseSync; requireOwner: (ownerId: string) => unknown; requireProjectForUser: (ownerId: string, projectId: string) => unknown; now?: () => number; onlineTimeoutMs?: number; enabled?: () => boolean}): CustomerRegistry;

export function isCustomerAgentsEnabled(env?: Record<string,string | undefined>): boolean;
export function requireCustomerAgentsEnabled(): void;
