import type {AutoOpsPrincipal, AutoOpsProject, AutoOpsAccess} from './access.mjs';
import type {WorkspaceStore} from './workspaces.mjs';
import type { StaticDeploymentConfig, DeploymentRelease, DeploymentTarget, DeploymentTask, DeploymentLog, DeploymentTaskDetails, DeploymentOverview, DeploymentSubmission, DeploymentTargetSubmission, DeploymentServer, DeploymentSourceIdentity } from '../../autoops/contracts/deployments.ts'
export type { StaticDeploymentConfig, DeploymentRelease, DeploymentTarget, DeploymentTask, DeploymentLog, DeploymentTaskDetails, DeploymentOverview, DeploymentSubmission, DeploymentTargetSubmission, DeploymentServer, DeploymentSourceIdentity } from '../../autoops/contracts/deployments.ts'
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
export function createDeploymentStore(options:{dataDir:string;workspaceStore:WorkspaceStore;access:Pick<AutoOpsAccess,'requireDeploymentActor'>;agentPort?:number;publicOrigin?:string}):DeploymentStore;
export function configuredDeploymentStore():DeploymentStore|undefined;
