import type {AutoOpsPrincipal, AutoOpsProject, AutoOpsAccess} from './access.mjs';
import type { WorkspaceManagement } from './workspace-management.ts';
import type { DeploymentService, DeploymentServiceSource, DeploymentRepositoryRefs, DeploymentRepositoryHistory, DeploymentGlobalNodeCatalog, DeploymentServerRegistration } from '../../autoops/contracts/deployments.ts';
import type {WorkspaceStore} from './workspaces.mjs';
import type { StaticDeploymentConfig, DeploymentRelease, DeploymentTarget, DeploymentTask, DeploymentLog, DeploymentTaskDetails, DeploymentOverview, DeploymentSubmission, DeploymentTargetSubmission, DeploymentServer, DeploymentSourceIdentity } from '../../autoops/contracts/deployments.ts'
export type { StaticDeploymentConfig, DeploymentRelease, DeploymentTarget, DeploymentTask, DeploymentLog, DeploymentTaskDetails, DeploymentOverview, DeploymentSubmission, DeploymentTargetSubmission, DeploymentServer, DeploymentSourceIdentity } from '../../autoops/contracts/deployments.ts'
export interface DeploymentStore {
 initialize():Promise<DeploymentStore>;
 ensureProject(project:AutoOpsProject):Promise<void>;
 overview(project:AutoOpsProject,environmentIds:string[]):DeploymentOverview;
 createServer(projectId:string,input:Record<string,unknown>):Promise<{server:DeploymentServer;registrationToken:string|null;expiresAt:string|null;repeated?:boolean}>;
 availableServers(projectId:string):DeploymentServer[];
 globalNodeCatalog(principal:AutoOpsPrincipal):Omit<DeploymentGlobalNodeCatalog,'projects'>;
 createGlobalServer(input:Record<string,unknown>,principal:AutoOpsPrincipal):Promise<DeploymentServerRegistration>;
 mutateGlobalServer(id:string,operation:'revoke'|'delete'|'storage',input:Record<string,unknown>,principal:AutoOpsPrincipal):Promise<DeploymentServer|{ok:true}>;
 setServerAccess(projectId:string,input:Record<string,unknown>,principal:AutoOpsPrincipal):Promise<{projectId:string;serverId:string;allowed:boolean;revision:number}>;
 serverScope(projectId:string,id:string):string[];
 server(projectId:string,id:string):DeploymentServer;
 bindServer(projectId:string,input:Record<string,unknown>):Promise<{server:DeploymentServer}>;
 unbindServer(projectId:string,input:Record<string,unknown>):Promise<{ok:true}>;
 revokeServer(projectId:string,id:string,input:Record<string,unknown>):Promise<{ok:true}>;
 deleteServer(projectId:string,id:string,input:Record<string,unknown>):Promise<{ok:true}>;
 saveStoragePolicy(projectId:string,id:string,input:Record<string,unknown>):Promise<{server:DeploymentServer}>;
 createTarget(projectId:string,input:Record<string,unknown>):Promise<{target:DeploymentTarget}>;
 saveService(projectId:string,input:Record<string,unknown>):Promise<{service:DeploymentService}>;
 updateTarget(projectId:string,targetId:string,input:Record<string,unknown>):Promise<{target:DeploymentTarget}>;
 serviceSource(projectId:string,serviceId:string,environmentId:string):{source:DeploymentServiceSource|null};
 saveServiceSource(projectId:string,input:Record<string,unknown>,principal:AutoOpsPrincipal):Promise<{source:DeploymentServiceSource}>;
 repositoryRefs(projectId:string,sourceId:string,actorId:string):Promise<DeploymentRepositoryRefs>;
 repositoryHistory(projectId:string,sourceId:string,input:{refKind:string;ref:string},actorId:string):Promise<DeploymentRepositoryHistory>;
 targetScope(projectId:string,id:string):{environmentId:string};
 taskScope(projectId:string,id:string):{environmentId:string};
 createTask(projectId:string,input:Record<string,unknown>,principal:AutoOpsPrincipal):Promise<{task:DeploymentTask}>;
 taskDetails(projectId:string,id:string,after?:number):Promise<{task:DeploymentTask;logs:DeploymentLog[];nextSeq:number}>;
 releases(projectId:string,id:string,offset?:number,limit?:number):{releases:DeploymentRelease[]};
 release(projectId:string,targetId:string,releaseId:string):{release:DeploymentRelease};
 releaseSource(projectId:string,targetId:string,releaseId:string):Promise<{bytes:Uint8Array;name:string;mime:string}>;
 clearReleaseSource(projectId:string,targetId:string,releaseId:string,input:Record<string,unknown>):Promise<{ok:true}>;
 readonly agentAddress:import('node:net').AddressInfo|string|null|undefined;
 stopAccepting():void;
 close():Promise<void>;
}
export function createDeploymentStore(options:{dataDir:string;workspaceStore:WorkspaceStore;workspaceManagement?:WorkspaceManagement;access:Pick<AutoOpsAccess,'requireDeploymentActor'|'requireDeploymentActionForActor'|'requireDeploymentNodeManagerForActor'|'requireDeploymentNodeManager'>;agentPort?:number;installAssetsRoot?:string;publicOrigin?:string}):DeploymentStore;
export function configuredDeploymentStore():DeploymentStore|undefined;

export function stopConfiguredDeploymentStore():void;
export function closeConfiguredDeploymentStore():Promise<void>;
