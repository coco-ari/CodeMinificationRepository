import type {AutoOpsPrincipal, AutoOpsProject} from './access.mjs';
import type {WorkspaceStore} from './workspaces.mjs';
export interface DeploymentSourceIdentity {projectId:string;sourceVersionId:string;packageId:string;service:'frontend';contentHash:string;repositories:Array<{path:string;commit:string}>}
export interface DeploymentRelease {id:string;targetId?:string;kind?:'static';revision?:string;createdAt?:string;available?:boolean;current?:boolean;archiveStatus?:string;config?:Record<string,unknown>;sourceIdentity?:DeploymentSourceIdentity}
export interface DeploymentTask {id:string;targetId:string;serverId:string;environmentId:string;action:string;status:string;stage:string;createdAt:string;lastSeq:number;requestId?:string;error?:string;sourceIdentity?:DeploymentSourceIdentity;actor?:{id:string;displayName?:string};result?:{error?:string;cleanupError?:string;recoveryMethod?:string;release?:DeploymentRelease;rollback?:{status?:'succeeded'|'failed'|'unavailable';error?:string;release?:DeploymentRelease}}}
export interface DeploymentServer {id:string;name:string;environmentId:string;online?:boolean;revoked?:boolean;capabilities?:string[]}
export interface DeploymentTarget {id:string;name:string;environmentId:string;serverId:string;kind:'static';service:'frontend';config:Record<string,unknown>;configKey:string;currentRelease?:DeploymentRelease|null}
export interface DeploymentOverview {enabled:boolean;environments:Array<{id:string;name:string}>;servers:DeploymentServer[];targets:DeploymentTarget[];tasks:DeploymentTask[]}
export interface DeploymentLog {seq:number;stage:string;status:string;message:string;at:string;receivedAt?:string}
export interface DeploymentStore {
 initialize():Promise<DeploymentStore>;
 ensureProject(project:AutoOpsProject):Promise<void>;
 overview(project:AutoOpsProject,environmentIds:string[]):DeploymentOverview;
 createServer(projectId:string,input:Record<string,unknown>):Promise<{server:DeploymentServer;registrationToken:string|null;expiresAt:string|null;repeated?:boolean}>;
 createTarget(projectId:string,input:Record<string,unknown>):Promise<{target:DeploymentTarget}>;
 targetScope(projectId:string,id:string):{environmentId:string};
 taskScope(projectId:string,id:string):{environmentId:string};
 createTask(projectId:string,input:Record<string,unknown>,principal:AutoOpsPrincipal):Promise<{task:DeploymentTask}>;
 taskDetails(projectId:string,id:string,after?:number):Promise<{task:DeploymentTask;logs:DeploymentLog[];nextSeq:number}>;
 releases(projectId:string,id:string):{releases:DeploymentRelease[]};
 readonly agentAddress:import('node:net').AddressInfo|string|null|undefined;
 close():Promise<void>;
}
export function createDeploymentStore(options:{dataDir:string;workspaceStore:WorkspaceStore;access?:unknown;agentPort?:number;publicOrigin?:string}):DeploymentStore;
export function configuredDeploymentStore():DeploymentStore|undefined;
