import type {AutoOpsAccess, AutoOpsPrincipal} from './access.mjs';
import type {createWorkspaceStore} from './workspaces.mjs';
export function handleWorkspaceRequest(input:{access:AutoOpsAccess;store:ReturnType<typeof createWorkspaceStore>|undefined;principal:AutoOpsPrincipal;url:URL;method:string;input?:unknown;maintainCurrent?:(projectId:string)=>{removed:string[];pending:string[]}}):Promise<{status:number;body?:unknown;file?:{name:string;mime:string;bytes:Uint8Array}}>;
