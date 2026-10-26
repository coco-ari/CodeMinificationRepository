import type { AssistantSelection } from '../../autoops/contracts/assistants.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectCapabilities, ProjectMembership, RuntimeProject as AutoOpsProject, RuntimeAgent as AutoOpsAgent } from '../../autoops/contracts/runtime.ts';
export type { ProjectMembership, RuntimeProject as AutoOpsProject, RuntimeAgent as AutoOpsAgent } from '../../autoops/contracts/runtime.ts';
import type { ProjectAction, DeploymentAction } from '../../autoops/contracts/project-access.ts';
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
  readonly question?: AssistantSelection;
  readonly executionBinding: ExecutionBinding;
  readonly projectId: string;
  readonly environmentId: string | null;
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
export interface ToolScope { actorId: string; binding: ThreadBinding; project: AutoOpsProject; agent: AutoOpsAgent }
export interface ThreadInputBinding { readonly threadId: string; readonly runId: string; readonly inputId: string; readonly actorId: string; readonly inputOwnerId: string; readonly actorVerified: boolean; readonly createdAt: string }
export class AutoOpsAccessError extends Error { constructor(status:number,code:string,message:string);status: number; code: string }
export type ThreadBindingInput = Pick<ThreadBinding, 'threadId'|'projectId'|'environmentId'|'agentId'|'visibility'|'workspaceType'|'workspaceVersionId'> & {executionBinding?: ExecutionBinding;question?: AssistantSelection};
export interface ResourceThread { binding: ThreadBinding; attachments: Array<{id:string;name?:string;mimeType?:string;sizeBytes?:number}> }
export interface AutoOpsAccess {
  assertAccepting(): void;
  stopAccepting(): void;
  readonly customerRegistry: CustomerRegistry;
  questionInstructions(actorId:string, threadId:string, modelSelection?:unknown):string;
  requireQuestionForActor(actorId:string, threadId:string, modelSelection?: unknown): AssistantSelection | undefined;
  requireThreadExecution(principal: AutoOpsPrincipal, threadId: string, options?: {requireOnline?: boolean}): ThreadBinding;
  authenticateCookie(cookie?: string): AutoOpsPrincipal;
  refresh(principal: AutoOpsPrincipal): AutoOpsPrincipal;
  requireProject(principal: AutoOpsPrincipal, projectId: string): AutoOpsProject;
  requireMembership(principal: AutoOpsPrincipal, projectId: string): ProjectMembership;
  requireProjectAction(principal: AutoOpsPrincipal, projectId: string, action: ProjectAction): ProjectMembership;
  requireProjectActionForActor(userId: string, projectId: string, action: ProjectAction): ProjectMembership;
  requireEnvironmentQuery(principal: AutoOpsPrincipal, projectId: string, environmentId: string): ProjectMembership;
  requireEnvironment(principal: AutoOpsPrincipal, projectId: string, environmentId: string): ProjectMembership;
  requireWorkspace(principal: AutoOpsPrincipal, projectId: string, type: 'internal' | 'external', versionId?: string, environmentId?: string | null): ProjectMembership;
  requireWorkspaceManager(principal: AutoOpsPrincipal, projectId: string): ProjectMembership;
  requireWorkspaceActor(userId: string, projectId: string): ProjectMembership;
  requireWorkspaceReader(userId: string, projectId: string): ProjectMembership;
  requireWorkspaceInputReader(userId: string, projectId: string, workspaceType: 'internal'|'external'): ProjectMembership;
  requireCredentialActor(userId: string, projectId: string, action: 'credential.use' | 'credential.manage'): ProjectMembership;
  requireDeploymentActor(userId:string, projectId:string, environmentId:string): ProjectMembership;
  requireDeploymentNodeManagerForActor(userId: string): void;
  requireDeploymentNodeManager(principal: AutoOpsPrincipal): void;
  requireDeploymentActionForActor(userId:string, projectId:string, action:DeploymentAction, environmentId?:string): ProjectMembership;
  requireDeploymentAction(principal: AutoOpsPrincipal, projectId:string, action:DeploymentAction, environmentId?:string): ProjectMembership;
  projectCapabilities(principal:AutoOpsPrincipal, projectId:string): ProjectCapabilities;
  listResourceThreads(principal:AutoOpsPrincipal, projectId:string): ResourceThread[];
  listToolResourceThreads(threadId:string,actorId?:string): ResourceThread[];
  threadAudience(binding: ThreadBinding): string[];
  getThreadBinding(threadId: string): ThreadBinding | undefined;
  recordQueuedEditActor(principal: AutoOpsPrincipal, threadId: string, commandId: string, runId: string): void;
  getQueuedEditActor(threadId: string, commandId: string, runId: string): {actorId:string} | undefined;
  requireQueuedEditActor(threadId: string, commandId: string, runId: string): ToolScope;
  recordMessageActor(principal: AutoOpsPrincipal, threadId: string, commandId: string, messageId: string): void;
  requireMessageActor(threadId: string, messageId: string): ToolScope;
  getRunInput(threadId: string, runId: string): ThreadInputBinding | undefined;
  bindRunInput(threadId: string, runId: string, inputId: string, actorId?: string, inputOwnerId?: string): ThreadInputBinding;
  listThreadInputs(threadId: string): ThreadInputBinding[];
  workspaceVersionReferences(projectId: string): string[];
  retainInputReference(threadId: string, inputId: string, actorId: string, callerId?:string): void;
  inputReferences(threadId: string): Array<{inputId:string;actorId:string}>;
  requireRunInput(threadId: string, inputId: string, runId?: string): ThreadInputBinding;
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
  requireCustomerAttachment(ownerId:string, threadId:string, attachmentId:string): {id:string;name?:string;mimeType?:string;sizeBytes?:number};
  requireAttachment(principal: AutoOpsPrincipal, attachmentId: string, targetThreadId?: string): {id:string; ownerId:string; threadId:string|null;name?:string;mimeType?:string;sizeBytes?:number};
  recordPendingAttachment(principal: AutoOpsPrincipal, attachmentId: string, metadata?: {name:string;mimeType:string;sizeBytes:number}): void;
  recordClaimedAttachment(principal: AutoOpsPrincipal, sourceId: string, finalId: string, threadId: string): void;
  recordThreadAttachment(principal: AutoOpsPrincipal, attachmentId: string, threadId: string, metadata?: {name:string;mimeType:string;sizeBytes:number}): void;
  recordGeneratedAttachment(threadId: string, attachmentId: string, metadata: {name:string;mimeType:string;sizeBytes:number}): void;
  forkBinding(principal: AutoOpsPrincipal, sourceThreadId: string, targetThreadId: string): ThreadBinding;
  recordLegacyNativeFork(sourceThreadId: string, targetThreadId: string, sourceNativeId: string, targetNativeId: string): void;
  requireToolThread(threadId: string, actorId?: string): ToolScope;
  requireReference(principal: AutoOpsPrincipal, sourceThreadId: string, targetThreadId: string): ThreadBinding;
  requireCsrf(principal: AutoOpsPrincipal, presented: unknown): void;
  recordNativeSession(principal: AutoOpsPrincipal, nativeSessionId: string): void;
  principalForNativeSession(nativeSessionId: string): AutoOpsPrincipal;
  bootstrap(principal: AutoOpsPrincipal): {
    principal: {id: string; displayName: string; role:string}; csrfToken: string; gatewayBasePath: string;
    fixedModel: {instanceId: 'codex'; model: string}; runtimeMode: 'approval-required';
    canCreateProject:boolean;
    canManageDeploymentNodes:boolean;
    modelSelectionEnabled:boolean;
    customerAgentsEnabled:boolean;
    assistantDirectoryEnabled?:boolean;
    projects: (Pick<AutoOpsProject, 'id'|'name'|'environments'> & {agents: {id:string; name:string}[];membership:ProjectMembership;capabilities:ProjectCapabilities;assistants?: import('../../autoops/contracts/assistants.ts').AssistantDirectory})[];
    agents: AutoOpsAgent[];
    productProfile: {id: ProductProfile['id']};
    capabilities: ProductProfile['capabilities'];
    clientSettingsOverrides: ProductProfile['clientSettingsOverrides'];
  };
}
export function autoOpsAccessEnabled(): boolean;
export const isAutoOpsEnabled: typeof autoOpsAccessEnabled;
export function configuredAutoOpsProjects(): AutoOpsProject[];
export function configuredAutoOpsProjectDirectory(): import('./project-directory/index.ts').ProjectDirectory;
export function configuredAutoOpsAccess(): AutoOpsAccess | undefined;
export function getThreadBinding(threadId: string): ThreadBinding | undefined;
export function requireToolThread(threadId: string, actorId?: string): ToolScope;

export function initializeAutoOpsAccessSchema(db: DatabaseSync): void;
export function createAutoOpsAccess(options: {sessionDb: DatabaseSync; bindingDb: DatabaseSync; catalog?: {users: Array<{id:string;name:string;role:string;kind?:'internal'|'external';status?:string}>;projects:AutoOpsProject[];agents:AutoOpsAgent[]}; now?: () => number; workspaceStore?: WorkspaceStore; customerRegistry?: CustomerRegistry; deploymentEnabled?: () => boolean;questions?: () => import("./assistants/index.ts").AssistantDirectoryService}): AutoOpsAccess;

export function stopConfiguredAutoOpsAccess(): void;
export function closeConfiguredAutoOpsAccess(): void;

export function configuredAutoOpsAssistantDirectory(): ReturnType<typeof import("./assistants/index.ts").createAssistantDirectory>;
