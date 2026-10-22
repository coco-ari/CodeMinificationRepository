import type {AutoOpsAccess, AutoOpsPrincipal} from './access.mjs';
import type {DeploymentStore} from './deployments.mjs';
export function handleDeploymentRequest(input:{access:AutoOpsAccess;store:DeploymentStore|undefined;principal:AutoOpsPrincipal;url:URL;method:string;input?:unknown}):Promise<{status:number;body:unknown}>;
