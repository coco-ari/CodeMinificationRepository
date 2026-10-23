import type { DatabaseSync } from 'node:sqlite';
import type { ProjectCapabilities } from '../../autoops/contracts/runtime.ts';
export type { ProjectCapabilities } from '../../autoops/contracts/runtime.ts';
import type { WorkspaceStore } from './workspaces.mjs';
import type { ProductProfile } from './product-profile.mjs';
import type { CustomerRegistry, ExecutionBinding } from './customer-registry.mjs';
export type { ExecutionBinding, CustomerExecutionBinding } from './customer-registry.mjs';
export interface AutoOpsPrincipal {
  readonly id: string;
  readonly displayName: string;
  readonly role: string;
  readonly sessionHash: string;
  readonly csrf: string;
  readonly expiresAt: number;
}
export interface ThreadBinding {
  readonly threadId: string;
  readonly executionBinding: ExecutionBinding;
  readonly projectId: string;
  readonly environmentId: string;
  readonly agentId: string;
  readonly ownerId: string;
  readonly visibility: 'private' | 'project';
  readonly createdAt: string;
  readonly scopeState: 'draft' | 'submitting' | 'locked';
  readonly scopeLocked: boolean;
  readonly workspaceType?: 'internal' | 'external';
  readonly workspaceVersionId?: string;
  readonly revokedAt?: string;
  readonly compatibilityReadOnly: boolean;
  readonly continuationVerified: boolean;
  readonly nativeThreadId?: string;
  readonly nativeParentThreadId?: string;
}
export interface ProjectMembership {
  userId: string;
  workspaceAccess: 'internal' | 'external';
  role: 'manager' | 'member';
  environmentIds: string[];
  status: 'active' | 'disabled';
}
export interface AutoOpsProject {
  id: string; name: string; memberIds: string[];
  memberships?: ProjectMembership[];
  environments: {id: string; name: string}[];
  documents: {id: string; name: string; mime: string; content: string; excerpt?: string}[];
  resources: {id: string; name: string; type: string; environmentId: string}[];
}
export interface AutoOpsAgent { id: string; name: string; description: string; projectIds: string[]; capabilities: string[] }
export interface ToolScope { binding: ThreadBinding; project: AutoOpsProject; agent: AutoOpsAgent }
export class AutoOpsAccessError extends Error { constructor(status:number,code:string,message:string);status: number; code: string }
export type ThreadBindingInput = Pick<ThreadBinding, 'threadId'|'projectId'|'environmentId'|'agentId'|'visibility'|'workspaceType'|'workspaceVersionId'> & {executionBinding?: ExecutionBinding};
export interface ResourceThread { binding: ThreadBinding; attachments: Array<{id:string;name?:string;mimeType?:string;sizeBytes?:number}> }
export interface AutoOpsAccess {
  readonly customerRegistry: CustomerRegistry;
  requireThreadExecution(principal: AutoOpsPrincipal, threadId: string, options?: {requireOnline?: boolean}): ThreadBinding;
  authenticateCookie(cookie?: string): AutoOpsPrincipal;
  refresh(principal: AutoOpsPrincipal): AutoOpsPrincipal;
  requireProject(principal: AutoOpsPrincipal, projectId: string): AutoOpsProject;
  requireMembership(principal: AutoOpsPrincipal, projectId: string): ProjectMembership;
  requireEnvironment(principal: AutoOpsPrincipal, projectId: string, environmentId: string): ProjectMembership;
  requireWorkspace(principal: AutoOpsPrincipal, projectId: string, type: 'internal' | 'external', versionId?: string, environmentId?: string): ProjectMembership;
  requireWorkspaceManager(principal: AutoOpsPrincipal, projectId: string): ProjectMembership;
  requireWorkspaceActor(userId: string, projectId: string): ProjectMembership;
  requireDeploymentActor(userId:string, projectId:string, environmentId:string): ProjectMembership;
  projectCapabilities(principal:AutoOpsPrincipal, projectId:string): ProjectCapabilities;
  listResourceThreads(principal:AutoOpsPrincipal, projectId:string): ResourceThread[];
  listToolResourceThreads(threadId:string): ResourceThread[];
  threadAudience(binding: ThreadBinding): string[];
  getThreadBinding(threadId: string): ThreadBinding | undefined;
  nativeSubagentParent(threadId: string): string | undefined;
  canSeeThread(principal: AutoOpsPrincipal, threadId: string, includeDeleted?: boolean): boolean;
  visibleThreadIds(principal: AutoOpsPrincipal): string[];
  requireThread(principal: AutoOpsPrincipal, threadId: string): ThreadBinding;
  markThreadDeleted(threadId: string): void;
  bindThread(principal: AutoOpsPrincipal, input: ThreadBindingInput): ThreadBinding;
  reserveThread(principal: AutoOpsPrincipal, input: ThreadBindingInput): ThreadBinding;
  beginThreadSubmission(principal: AutoOpsPrincipal, threadId: string, commandId: string): ThreadBinding;
  finishThreadSubmission(threadId: string, commandId: string, accepted: boolean): ThreadBinding | undefined;
  markThreadAccepted(threadId: string): ThreadBinding | undefined;
  /** Invoke only after native execution is known to have ended or been lost. */
  reconcileThreadSubmission(threadId: string, accepted: boolean): ThreadBinding | undefined;
  requireAttachment(principal: AutoOpsPrincipal, attachmentId: string, targetThreadId?: string): {id:string; ownerId:string; threadId:string|null;name?:string;mimeType?:string;sizeBytes?:number};
  recordPendingAttachment(principal: AutoOpsPrincipal, attachmentId: string, metadata?: {name:string;mimeType:string;sizeBytes:number}): void;
  recordClaimedAttachment(principal: AutoOpsPrincipal, sourceId: string, finalId: string, threadId: string): void;
  recordThreadAttachment(principal: AutoOpsPrincipal, attachmentId: string, threadId: string, metadata?: {name:string;mimeType:string;sizeBytes:number}): void;
  recordGeneratedAttachment(threadId: string, attachmentId: string, metadata: {name:string;mimeType:string;sizeBytes:number}): void;
  forkBinding(principal: AutoOpsPrincipal, sourceThreadId: string, targetThreadId: string): ThreadBinding;
  recordLegacyNativeFork(sourceThreadId: string, targetThreadId: string, sourceNativeId: string, targetNativeId: string): void;
  requireToolThread(threadId: string): ToolScope;
  requireReference(principal: AutoOpsPrincipal, sourceThreadId: string, targetThreadId: string): ThreadBinding;
  requireCsrf(principal: AutoOpsPrincipal, presented: unknown): void;
  recordNativeSession(principal: AutoOpsPrincipal, nativeSessionId: string): void;
  principalForNativeSession(nativeSessionId: string): AutoOpsPrincipal;
  bootstrap(principal: AutoOpsPrincipal): {
    principal: {id: string; displayName: string; role:string}; csrfToken: string; gatewayBasePath: string;
    fixedModel: {instanceId: 'codex'; model: string}; runtimeMode: 'approval-required';
    modelSelectionEnabled:boolean;
    customerAgentsEnabled:boolean;
    projects: (Pick<AutoOpsProject, 'id'|'name'|'environments'> & {agents: {id:string; name:string}[];membership:ProjectMembership;capabilities:ProjectCapabilities})[];
    agents: AutoOpsAgent[];
    productProfile: {id: ProductProfile['id']};
    capabilities: ProductProfile['capabilities'];
    clientSettingsOverrides: ProductProfile['clientSettingsOverrides'];
  };
}
export function autoOpsAccessEnabled(): boolean;
export const isAutoOpsEnabled: typeof autoOpsAccessEnabled;
export function configuredAutoOpsProjects(): AutoOpsProject[];
export function configuredAutoOpsAccess(): AutoOpsAccess | undefined;
export function getThreadBinding(threadId: string): ThreadBinding | undefined;
export function requireToolThread(threadId: string): ToolScope;

export function initializeAutoOpsAccessSchema(db: DatabaseSync): void;
export function createAutoOpsAccess(options: {sessionDb: DatabaseSync; bindingDb: DatabaseSync; catalog?: {users: Array<{id:string;name:string;role:string;status?:string}>;projects:AutoOpsProject[];agents:AutoOpsAgent[]}; now?: () => number; workspaceStore?: WorkspaceStore; customerRegistry?: CustomerRegistry; deploymentEnabled?: () => boolean}): AutoOpsAccess;
