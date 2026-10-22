import type { DatabaseSync } from 'node:sqlite';
export type CustomerExecutionBinding = { kind: 'customer'; deviceId: string; registeredWorkspaceId: string; workspaceBindingRevision: number; runtimeId: 'codex' };
export type ExecutionBinding = { kind: 'platform' } | CustomerExecutionBinding;
export interface CustomerDevice { id: string; ownerId: string; label: string; platform?: string; connectorVersion?: string; status: 'active' | 'disabled' | 'revoked'; online: boolean; connectionEpoch: number; lastSeenAt?: string; createdAt: string }
/** Internal only: never serialize a device principal or put it in logs. */
export interface CustomerDevicePrincipal { deviceId: string; ownerId: string; tokenHash: string }
export interface CustomerWorkspace { registeredWorkspaceId: string; deviceId: string; ownerId: string; projectId: string; label: string; workspaceBindingRevision: number; runtimeId: 'codex'; status: 'active' | 'revoked'; createdAt: string; updatedAt: string }
export interface CustomerModel { id: string; name?: string; supportedReasoningEfforts: string[] }
export interface CustomerSkill { id: string; name: string; description: string }
export interface CustomerCapabilityInput { registeredWorkspaceId: string; workspaceBindingRevision: number; runtimeId: 'codex'; revision: string; protocolVersion: 1; runtimeVersion?: string; configRevision?: string; models: CustomerModel[]; skills: CustomerSkill[]; permissions?: {approvalPolicy: string; sandboxMode: string} }
export interface CustomerCapabilities extends CustomerCapabilityInput { deviceId: string; updatedAt: string }
export interface CustomerRegistry {
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
